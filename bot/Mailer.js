/**
 * Sending replies.
 *
 * We build the email by hand (raw MIME) and send it through the Gmail
 * advanced service, because the simple GmailApp.reply() can't add the
 * "Auto-Submitted: auto-replied" header that stops other robots from
 * replying back (RFC 3834), or our own "X-STF-Bot" marker.
 */

const SIGNATURE = [
  '',
  'Best,',
  'TESC Student Travel Fund Assistant',
  '',
  '--',
  "This answer was written by TESC's automated assistant using our Student Travel Fund FAQ (https://tescatucsd.org/funding).",
  'Reply with the word "human" to reach a TESC board member.',
].join('\n');

/** Fixed (not AI-written) reply for questions that need a person to decide. */
function needsDecisionAck(firstName) {
  return [
    'Hi ' + (firstName || 'there') + ',',
    '',
    'Thanks for reaching out about the Student Travel Fund. Your question needs a decision from a TESC board member, so it has been forwarded to them. You should hear back within a few business days.',
    '',
    'In the meantime, general STF info is at https://tescatucsd.org/funding.',
  ].join('\n');
}

/** Fixed reply when someone asks for a human. */
function humanAck(firstName) {
  return [
    'Hi ' + (firstName || 'there') + ',',
    '',
    "No problem. We've flagged your email for a TESC board member, and they'll reply to this thread directly. You should hear back within a few business days.",
  ].join('\n');
}

/** Encodes a header value if it has non-English characters (RFC 2047). */
function encodeHeaderValue(value) {
  const s = String(value || '').replace(/[\r\n]+/g, ' ');
  if (/^[\x20-\x7e]*$/.test(s)) return s;
  return '=?UTF-8?B?' + Utilities.base64Encode(s, Utilities.Charset.UTF_8) + '?=';
}

function replySubject(subject) {
  const s = String(subject || '').trim() || 'Student Travel Fund';
  return /^re:/i.test(s) ? s : 'Re: ' + s;
}

/** Builds the raw email text. Pure function, so it's unit-tested. */
function buildReplyMime(opts) {
  const bodyB64 = Utilities.base64Encode(opts.body + '\n' + SIGNATURE, Utilities.Charset.UTF_8)
    .replace(/(.{76})/g, '$1\r\n');
  const refs = [opts.references, opts.inReplyTo].filter(Boolean).join(' ').trim();
  const headers = [
    'From: ' + opts.from,
    'To: ' + opts.to,
    'Subject: ' + encodeHeaderValue(replySubject(opts.subject)),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    'Auto-Submitted: auto-replied',
    'X-STF-Bot: yes',
  ];
  if (opts.inReplyTo) headers.push('In-Reply-To: ' + opts.inReplyTo);
  if (refs) headers.push('References: ' + refs);
  return headers.join('\r\n') + '\r\n\r\n' + bodyB64;
}

/**
 * Sends a reply in the same Gmail thread, ONLY to the verified sender.
 * (We ignore any Reply-To header so nobody can redirect replies elsewhere.)
 */
function sendThreadReply(opts) {
  const raw = buildReplyMime(opts);
  return Gmail.Users.Messages.send({ raw: Utilities.base64EncodeWebSafe(raw), threadId: opts.threadId }, 'me');
}
