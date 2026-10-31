/**
 * Safety checks that run BEFORE any AI call (they're free).
 * All functions here are "pure": they only look at their inputs,
 * which makes them easy to test (see tests/filters.test.mjs).
 */

/** Turns Gmail's [{name, value}] header list into { lowercased name: [values in order] }. */
function headerMap(headers) {
  const map = {};
  (headers || []).forEach(function (h) {
    const key = String(h.name).toLowerCase();
    (map[key] = map[key] || []).push(String(h.value));
  });
  return map;
}

function firstHeader(map, name) {
  const v = map[name.toLowerCase()];
  return v && v.length ? v[0] : '';
}

/** "Jane Doe <JDoe@UCSD.edu>" -> "jdoe@ucsd.edu" */
function parseEmailAddress(fromValue) {
  const s = String(fromValue || '');
  const m = s.match(/<([^<>\s]+@[^<>\s]+)>/) || s.match(/([^\s"<>,;]+@[^\s"<>,;]+)/);
  return m ? m[1].trim().toLowerCase() : '';
}

/** "Jane Doe <jdoe@ucsd.edu>" -> "Jane" (or '' if there's no name). */
function parseFirstName(fromValue) {
  const m = String(fromValue || '').match(/^\s*"?([^"<@]+?)"?\s*</);
  if (!m) return '';
  const name = m[1].trim();
  const first = name.indexOf(',') > 0 ? name.split(',')[1].trim().split(/\s+/)[0] : name.split(/\s+/)[0];
  return /^[A-Za-z][A-Za-z'\-]{0,30}$/.test(first || '') ? first : '';
}

/**
 * Is this email from a robot, a mailing list, or ourselves?
 * Returns the reason as text, or '' if it looks like a real person.
 * Based on RFC 3834 (the standard for auto-replies).
 */
function robotOrListReason(map, fromAddress, ownAddresses) {
  const autoSubmitted = firstHeader(map, 'auto-submitted').trim().toLowerCase();
  if (autoSubmitted && autoSubmitted !== 'no') return 'automatic email (Auto-Submitted)';
  if (/^(bulk|list|junk)$/i.test(firstHeader(map, 'precedence').trim())) return 'bulk or list email (Precedence)';
  if (map['list-id'] || map['list-unsubscribe'] || map['list-post']) return 'mailing list';
  if (firstHeader(map, 'return-path').trim() === '<>') return 'bounce (empty sender)';
  if (map['x-autoreply'] || map['x-autorespond']) return 'auto-reply';
  const local = fromAddress.split('@')[0] || '';
  if (/^(no-?reply|do-?not-?reply|mailer-daemon|postmaster|bounces?)([+._-]|$)/i.test(local)) return 'robot sender (' + local + ')';
  if (!fromAddress) return 'no sender address';
  if (ownAddresses.indexOf(fromAddress) !== -1) return 'sent by TESC';
  return '';
}

/**
 * Is the sender really from @<domain> (e.g. ucsd.edu), not forged?
 * We trust only the newest Authentication-Results header added by Gmail
 * (mx.google.com). Senders can add fake ones lower down, so those are ignored.
 * Subdomains (x@eng.ucsd.edu) are rejected on purpose: UCSD's DMARC policy
 * doesn't protect subdomains (sp=none), so they can be faked.
 */
function verifySender(map, fromAddress, domain) {
  const escaped = domain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!new RegExp('^[^@\\s]+@' + escaped + '$', 'i').test(fromAddress)) {
    return { ok: false, reason: 'sender is not @' + domain };
  }
  const results = map['authentication-results'] || [];
  const fromGoogle = results.filter(function (v) { return /^\s*mx\.google\.com\s*;/i.test(v); })[0];
  if (!fromGoogle) return { ok: false, reason: 'no Gmail authentication result' };
  const dmarcPass = /\bdmarc=pass\b/i.test(fromGoogle);
  const fromMatches = new RegExp('header\\.from=' + escaped + '(?![\\w.-])', 'i').test(fromGoogle);
  if (!dmarcPass || !fromMatches) return { ok: false, reason: 'failed anti-forgery check (DMARC)' };
  return { ok: true, reason: '' };
}

/** Removes the quoted older emails at the bottom of a reply ("On Mon, X wrote: > ..."). */
function stripQuoted(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // "On Mon, Oct 5, 2026 at 3:00 PM Jane <j@x.com> wrote:" (sometimes split over 2 lines)
    if (/^On\s/.test(line) && (/wrote:\s*$/.test(line) || /wrote:\s*$/.test(lines[i + 1] || ''))) break;
    if (/^-{2,}\s*Original Message\s*-{2,}/i.test(line)) break;
    if (/^_{5,}\s*$/.test(line)) break; // Outlook separator line
    if (/^>/.test(line)) continue;
    out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function truncateText(text, maxChars) {
  const s = String(text || '');
  return s.length <= maxChars ? s : s.slice(0, maxChars) + '\n[...email cut off here...]';
}

/** True if a (short) reply asks for a person, e.g. "human" or "can I talk to a real person". */
function wantsHuman(text) {
  const s = String(text || '').trim();
  if (!s) return false;
  return s.length <= 300 && /\b(human|real person|a person|someone real)\b/i.test(s);
}

/**
 * Last check on the AI's reply before it's sent. Blocks:
 * empty or too-long replies, links to sites not on the allowlist,
 * and email addresses outside TESC/UCSD.
 */
function checkReply(reply, settings) {
  const problems = [];
  const text = String(reply || '');
  if (!text.trim()) problems.push('reply is empty');
  if (text.length > settings.MAX_REPLY_CHARS) problems.push('reply is too long');

  const allowed = settings.ALLOWED_LINK_DOMAINS;
  const hostOk = function (host) {
    host = host.toLowerCase().replace(/\.$/, '');
    return allowed.some(function (d) { return host === d || host.endsWith('.' + d); });
  };
  const urlRe = /\b(?:https?:\/\/|www\.)([^\s/?#<>"')]+)/gi;
  let m;
  while ((m = urlRe.exec(text))) {
    const host = m[1].replace(/^www\./i, '').split(':')[0].split('@').pop();
    if (!hostOk(host)) problems.push('link to a site not on the allowlist: ' + host);
  }
  const emailRe = /[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;
  while ((m = emailRe.exec(text))) {
    if (!hostOk(m[1])) problems.push('email address outside the allowlist: ' + m[0]);
  }
  return { ok: problems.length === 0, problems: problems };
}
