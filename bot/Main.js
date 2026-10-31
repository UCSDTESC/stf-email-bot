/**
 * The main loop. A trigger runs processInbox() every 5 minutes.
 *
 * For each new email:
 *   1. free safety checks (robots, mailing lists, forged senders, limits)
 *   2. look up the sender's own application (if a Sheet is connected)
 *   3. ask the AI, which picks: faq / status / needs_decision / not_stf
 *   4. check the AI's reply, then send it (live mode) or just log it (shadow mode)
 *   5. log everything to the Control Panel
 */

const LABELS = {
  answered: 'STF Bot/Answered',
  needsDecision: 'STF Bot/Needs Decision',
  leftForHumans: 'STF Bot/Left for humans',
  skipped: 'STF Bot/Skipped',
  notStf: 'STF Bot/Not STF',
  shadow: 'STF Bot/Shadow (test mode)',
  error: 'STF Bot/Error',
};

const MAX_ATTEMPTS = 3;
const STATE_KEY = 'BOT_STATE';
const START_KEY = 'BOT_START_TIME';
const MAX_RUN_MS = 4.5 * 60 * 1000; // Google stops scripts at 6 min; stop early and continue next run
const BOT_VERSION = '1.0.0';

function processInbox() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return; // another run is still going
  try {
    runOnce_();
  } finally {
    lock.releaseLock();
  }
}

// ---------- state (remembered between runs, in Script Properties) ----------

function todayKey_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function loadState_() {
  let s = {};
  try { s = JSON.parse(PropertiesService.getScriptProperties().getProperty(STATE_KEY) || '{}'); } catch (e) { s = {}; }
  s.processed = s.processed || {};
  s.attempts = s.attempts || {};
  if (s.day !== todayKey_()) { s.day = todayKey_(); s.aiCalls = 0; s.perSender = {}; }
  s.aiCalls = s.aiCalls || 0;
  s.perSender = s.perSender || {};
  s.consecutiveErrors = s.consecutiveErrors || 0;
  return s;
}

function saveState_(s) {
  const cutoff = Date.now() - 10 * 24 * 3600 * 1000;
  Object.keys(s.processed).forEach(function (id) { if (s.processed[id] < cutoff) delete s.processed[id]; });
  PropertiesService.getScriptProperties().setProperty(STATE_KEY, JSON.stringify(s));
}

// ---------- main run ----------

/**
 * The bot only handles emails that arrive AFTER it was first turned on,
 * so installing it on a busy inbox never answers old emails.
 */
function getBotStartTime_() {
  const props = PropertiesService.getScriptProperties();
  let start = Number(props.getProperty(START_KEY));
  if (!start) {
    start = Date.now();
    props.setProperty(START_KEY, String(start));
  }
  return start;
}

function runOnce_() {
  const startedAt = Date.now();
  const settings = getSettings();
  if (!settings.BOT_ENABLED) return;
  const botStart = getBotStartTime_();

  const me = String(Session.getEffectiveUser().getEmail()).toLowerCase();
  const ctx = {
    settings: settings,
    me: me,
    own: settings.OWN_ADDRESSES.concat([me]),
    state: loadState_(),
    faq: null, // loaded only when needed
  };

  const threads = GmailApp.search('in:inbox newer_than:' + settings.LOOKBACK_DAYS + 'd', 0, 50);
  for (let t = 0; t < threads.length; t++) {
    const thread = threads[t];
    const messages = thread.getMessages();
    const last = messages[messages.length - 1];
    const id = last.getId();
    if (ctx.state.processed[id]) continue;
    if (Date.now() - startedAt > MAX_RUN_MS) break; // out of time; the next run continues
    if (last.getDate().getTime() < botStart) { // arrived before the bot was turned on
      ctx.state.processed[id] = Date.now();
      continue;
    }

    let stop = false;
    try {
      const outcome = handleMessage_(ctx, thread, messages, last);
      stop = outcome === 'stop';
      if (!stop) ctx.state.processed[id] = Date.now();
      ctx.state.consecutiveErrors = 0;
    } catch (err) {
      ctx.state.attempts[id] = (ctx.state.attempts[id] || 0) + 1;
      ctx.state.consecutiveErrors++;
      logError('processInbox', err, id);
      if (ctx.state.attempts[id] >= MAX_ATTEMPTS) {
        ctx.state.processed[id] = Date.now();
        addLabel_(thread, LABELS.error);
        logActivity(Object.assign(baseEntry_(ctx, thread, last, '', ''), { decision: 'error', why: String(err.message || err) }));
      }
      maybeAlert_(ctx, err);
    }
    saveState_(ctx.state); // save after every email so a crash never causes a double reply
    if (stop) break;
  }
  ctx.state.lastRunOk = Date.now();
  saveState_(ctx.state);
}

function getHeaders_(messageId) {
  const msg = Gmail.Users.Messages.get('me', messageId, {
    format: 'metadata',
    metadataHeaders: ['From', 'To', 'Cc', 'Subject', 'Message-ID', 'References', 'Auto-Submitted', 'Precedence', 'List-Id',
      'List-Unsubscribe', 'List-Post', 'Return-Path', 'Authentication-Results', 'X-Autoreply', 'X-Autorespond', 'X-STF-Bot'],
  });
  return headerMap((msg.payload || {}).headers);
}

function baseEntry_(ctx, thread, msg, from, subject) {
  return {
    inbox: ctx.me, from: from || msg.getFrom(), subject: subject || msg.getSubject(),
    threadId: thread.getId(), messageId: msg.getId(), mode: ctx.settings.MODE,
  };
}

/** Handles the newest email in one thread. Returns 'stop' to end this run early (daily limit). */
function handleMessage_(ctx, thread, messages, last) {
  const s = ctx.settings;
  const h = getHeaders_(last.getId());
  const fromHeader = firstHeader(h, 'from') || last.getFrom();
  const from = parseEmailAddress(fromHeader);
  const subject = firstHeader(h, 'subject') || last.getSubject();
  const entry = baseEntry_(ctx, thread, last, from, subject);
  const finish = function (decision, why, label, extra) {
    if (label) addLabel_(thread, label);
    logActivity(Object.assign(entry, { decision: decision, why: why }, extra || {}));
  };

  // We sent the newest message (a bot reply or a human from TESC): nothing to do.
  if (ctx.own.indexOf(from) !== -1) return;

  // A TESC person already replied by hand in this thread: humans own it now.
  const ourMessages = messages.filter(function (m) { return ctx.own.indexOf(parseEmailAddress(m.getFrom())) !== -1; });
  const botReplies = ourMessages.filter(function (m) { return firstHeader(getHeaders_(m.getId()), 'x-stf-bot') === 'yes'; }).length;
  if (ourMessages.length > botReplies) return finish('left for humans: a TESC member is handling this thread', '', LABELS.leftForHumans);

  // 1. Free safety checks.
  const robot = robotOrListReason(h, from, ctx.own);
  if (robot) return finish('skipped: ' + robot, '', LABELS.skipped);
  if (s.BLOCKED_SENDERS.indexOf(from) !== -1) return finish('skipped: blocked sender', '', LABELS.skipped);

  const otherInbox = otherInboxAnswers(h, s.OWN_ADDRESSES, ctx.me);
  if (otherInbox) return finish('skipped: also sent to ' + otherInbox + ', which answers it', '', LABELS.skipped);

  const verified = verifySender(h, from, s.ALLOWED_SENDER_DOMAIN);
  if (!verified.ok) return finish('left for humans: ' + verified.reason, '', LABELS.leftForHumans);

  if (botReplies >= s.MAX_BOT_REPLIES_PER_THREAD) return finish('left for humans: bot reply limit for this thread', '', LABELS.leftForHumans);
  if ((ctx.state.perSender[from] || 0) >= s.PER_SENDER_DAILY_LIMIT) return finish('left for humans: sender hit daily limit', '', LABELS.leftForHumans);
  if (ctx.state.aiCalls >= s.DAILY_AI_CALL_LIMIT) {
    logError('limits', 'Daily AI call limit (' + s.DAILY_AI_CALL_LIMIT + ') reached; remaining emails wait until tomorrow.', last.getId());
    return 'stop';
  }

  const firstName = parseFirstName(fromHeader);
  const body = truncateText(stripQuoted(last.getPlainBody()), s.MAX_EMAIL_CHARS);

  // "human" -> hand it to a person without asking the AI.
  if (wantsHuman(body)) {
    return sendAndLog_(ctx, thread, last, h, entry, humanAck(firstName), 'needs decision', 'sender asked for a human', null, firstName);
  }

  // 2. The sender's own application (code does this lookup, not the AI).
  const application = lookupApplication(s, from);

  // 3. Ask the AI.
  if (!ctx.faq) ctx.faq = loadFaqText_(s);
  ctx.state.aiCalls++;
  const ai = askModel(s, buildSystemPrompt(ctx.faq), buildUserMessage({ firstName: firstName, subject: subject, body: body }, application));
  const r = ai.result;

  if (r.category === 'not_stf') return finish('not stf', r.reason, LABELS.notStf, { ai: ai });

  if (r.category === 'needs_decision') {
    return sendAndLog_(ctx, thread, last, h, entry, needsDecisionAck(firstName), 'needs decision', r.reason, ai, firstName);
  }

  // 4. Check the AI's answer before it goes out.
  const check = checkReply(r.reply, s);
  if (!check.ok) {
    const why = 'AI reply blocked by safety check: ' + check.problems.join('; ');
    return sendAndLog_(ctx, thread, last, h, entry, needsDecisionAck(firstName), 'needs decision', why, ai, firstName);
  }
  return sendAndLog_(ctx, thread, last, h, entry, r.reply, 'answered', r.reason, ai, firstName);
}

/** Sends (live) or pretends to send (shadow), then labels and logs. */
function sendAndLog_(ctx, thread, last, h, entry, replyText, decision, why, ai, firstName) {
  const live = ctx.settings.MODE === 'live';
  if (live) {
    sendThreadReply({
      threadId: thread.getId(),
      from: ctx.me,
      to: entry.from,
      subject: entry.subject,
      inReplyTo: firstHeader(h, 'message-id'),
      references: firstHeader(h, 'references'),
      body: replyText,
    });
  }
  ctx.state.perSender[entry.from] = (ctx.state.perSender[entry.from] || 0) + 1;
  addLabel_(thread, live ? (decision === 'answered' ? LABELS.answered : LABELS.needsDecision) : LABELS.shadow);
  if (decision === 'needs decision') {
    addLabel_(thread, LABELS.needsDecision);
    logNeedsDecision({ from: entry.from, subject: entry.subject, why: why, threadId: entry.threadId });
  }
  logActivity(Object.assign(entry, {
    decision: (live ? '' : '(shadow) ') + decision, why: why, reply: replyText, ai: ai || undefined,
  }));
}

function addLabel_(thread, name) {
  const label = GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
  thread.addLabel(label);
}

function loadFaqText_(settings) {
  if (settings.FAQ_DOC_ID) {
    const text = DocumentApp.openById(settings.FAQ_DOC_ID).getBody().getText();
    if (text.trim()) return text.slice(0, 60000);
  }
  return FAQ_SEED;
}

// ---------- alerts ----------

function alertRecipients_(settings) {
  return settings.ALERT_EMAILS.length ? settings.ALERT_EMAILS.join(',') : Session.getEffectiveUser().getEmail();
}

function maybeAlert_(ctx, err) {
  if (ctx.state.consecutiveErrors < 3 || ctx.state.lastAlertDay === todayKey_()) return;
  ctx.state.lastAlertDay = todayKey_();
  MailApp.sendEmail(alertRecipients_(ctx.settings), '[STF Bot] The bot is failing',
    'The STF email bot has failed ' + ctx.state.consecutiveErrors + ' times in a row.\n\nLatest error: ' +
    String(err && err.message || err) + '\n\nSee the Errors tab in the Control Panel.');
}

/** Runs daily (trigger). Emails an alert if the bot hasn't finished a run in 2 hours. */
function dailyHealthCheck() {
  const settings = getSettings();
  if (!settings.BOT_ENABLED) return;
  const state = loadState_();
  const ageHours = state.lastRunOk ? (Date.now() - state.lastRunOk) / 3600000 : Infinity;
  if (ageHours > 2) {
    MailApp.sendEmail(alertRecipients_(settings), '[STF Bot] The bot has stopped running',
      'The STF email bot has not completed a run in ' + (isFinite(ageHours) ? Math.round(ageHours) + ' hours' : 'a long time') +
      '. Check the Errors tab and the Apps Script "Executions" page.');
  }
}
