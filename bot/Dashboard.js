/**
 * The dashboard: a web page (Apps Script "web app") showing what the bot did.
 * Set up once with Deploy > New deployment > Web app (see README).
 *
 * It reads the Control Panel tabs; it stores nothing new. A student's email
 * text is read live from Gmail only when someone opens that email, and is
 * never saved anywhere.
 *
 * Functions without a trailing underscore can be called from the page
 * (google.script.run). Every one of them checks who is asking first.
 */

const TOPIC_LABELS = {
  deadlines: 'Deadlines and timing',
  receipts: 'Receipts and post-travel form',
  eligibility: 'Who is eligible',
  amounts: 'How much is covered',
  status: 'Application status',
  other: 'Other',
};
const DAY_MS = 24 * 3600 * 1000;

// Column positions in the Control Panel tabs (see TAB_HEADERS).
const ACT = { time: 0, from: 2, subject: 3, decision: 4, category: 5, why: 6, reply: 7, cost: 12, link: 13, messageId: 14, name: 15, topic: 16 };
const ND = { time: 0, from: 1, subject: 2, why: 3, link: 4, done: 5 };

// ---------- pure helpers (unit-tested) ----------

function toMs_(v) {
  const t = v ? new Date(v).getTime() : 0;
  return isFinite(t) ? t : 0;
}

/** Turns a logged decision into one of: answered, person, ignored, left, error. */
function decisionKind(decision) {
  const d = String(decision || '').replace(/^\(shadow\)\s*/, '');
  if (d === 'answered') return 'answered';
  if (d === 'needs decision') return 'person';
  if (d === 'not stf' || d.indexOf('skipped') === 0) return 'ignored';
  if (d.indexOf('left for humans') === 0) return 'left';
  if (d.indexOf('error') === 0) return 'error';
  return 'other';
}

function threadIdFromLink(link) {
  const m = String(link || '').match(/#all\/([A-Za-z0-9]+)$/);
  return m ? m[1] : '';
}

/** Activity Log rows -> plain objects (only what the page needs). */
function parseActivity(rows) {
  return rows.filter(function (r) { return toMs_(r[ACT.time]); }).map(function (r) {
    return {
      t: toMs_(r[ACT.time]),
      from: String(r[ACT.from] || ''),
      name: String(r[ACT.name] || ''),
      subject: String(r[ACT.subject] || ''),
      kind: decisionKind(r[ACT.decision]),
      shadow: /^\(shadow\)/.test(String(r[ACT.decision] || '')),
      why: String(r[ACT.why] || ''),
      reply: String(r[ACT.reply] || ''),
      cost: Number(r[ACT.cost]) || 0,
      threadId: threadIdFromLink(r[ACT.link]),
      messageId: String(r[ACT.messageId] || ''),
      topic: String(r[ACT.topic] || ''),
    };
  });
}

/** The inbox view: open "needs a person" items, and recent emails the bot handled. */
function buildInbox(activityRows, needsRows, limit) {
  const items = parseActivity(activityRows).sort(function (a, b) { return b.t - a.t; });
  const queue = needsRows
    .filter(function (r) { return toMs_(r[ND.time]) && r[ND.done] !== true && String(r[ND.done]).toUpperCase() !== 'TRUE'; })
    .map(function (r) {
      const threadId = threadIdFromLink(r[ND.link]);
      const match = items.filter(function (i) { return i.threadId === threadId && i.kind === 'person'; })[0] || {};
      return {
        t: toMs_(r[ND.time]), from: String(r[ND.from] || ''), name: match.name || '', subject: String(r[ND.subject] || ''),
        why: friendlyWhy(r[ND.why]), threadId: threadId, messageId: match.messageId || '',
      };
    })
    .sort(function (a, b) { return b.t - a.t; });
  const handled = items.filter(function (i) { return i.kind !== 'person'; }).slice(0, limit || 60)
    .map(function (i) { return { t: i.t, from: i.from, name: i.name, subject: i.subject, kind: i.kind, messageId: i.messageId }; });
  return { queue: queue, handled: handled };
}

/** Turns a logged "why" into a short sentence for the dashboard. */
function friendlyWhy(why) {
  why = String(why || '');
  if (why === 'sender asked for a human') return 'Asked to talk to a person';
  if (why.indexOf('AI reply blocked by safety check') === 0) return "The bot's answer failed a safety check, so it wasn't sent";
  return why;
}

function reasonLabel_(item) {
  if (item.why === 'sender asked for a human') return 'Asked to talk to a person';
  if (item.why.indexOf('AI reply blocked') === 0) return 'Reply blocked by the safety check';
  return TOPIC_LABELS[item.topic] || 'Not covered by the FAQ';
}

/**
 * Analytics for [start, end). dayKey(ms) -> 'yyyy-MM-dd' and dayLabel(ms) -> 'Oct 3'
 * are passed in so the page uses TESC's time zone.
 */
function summarizeActivity(activityRows, evalRows, start, end, dayKey, dayLabel) {
  const all = parseActivity(activityRows);
  const inRange = all.filter(function (i) { return i.t >= start && i.t < end; });
  const prev = all.filter(function (i) { return i.t >= start - (end - start) && i.t < start; });
  const count = function (list, kind) { return list.filter(function (i) { return i.kind === kind; }).length; };

  const answered = count(inRange, 'answered');
  const person = count(inRange, 'person');
  const totals = {
    received: inRange.length,
    previous: prev.length,
    answered: answered,
    person: person,
    ignored: count(inRange, 'ignored') + count(inRange, 'left'),
    handledPct: answered + person ? Math.round((100 * answered) / (answered + person)) : null,
    cost: Math.round(inRange.reduce(function (s, i) { return s + i.cost; }, 0) * 10000) / 10000,
  };

  const days = [];
  const byKey = {};
  for (let t = start; t < end; t += DAY_MS) {
    const k = dayKey(t);
    if (byKey[k]) continue;
    byKey[k] = { key: k, label: dayLabel(t), answered: 0, person: 0, ignored: 0 };
    days.push(byKey[k]);
  }
  inRange.forEach(function (i) {
    const d = byKey[dayKey(i.t)];
    if (!d) return;
    if (i.kind === 'answered') d.answered++;
    else if (i.kind === 'person') d.person++;
    else if (i.kind === 'ignored' || i.kind === 'left') d.ignored++;
  });

  const tally = function (list, labelOf) {
    const m = {};
    list.forEach(function (i) { const l = labelOf(i); m[l] = (m[l] || 0) + 1; });
    return Object.keys(m).map(function (l) { return { label: l, count: m[l] }; }).sort(function (a, b) { return b.count - a.count; });
  };
  const stf = inRange.filter(function (i) { return (i.kind === 'answered' || i.kind === 'person') && i.topic; });
  const topics = tally(stf, function (i) { return TOPIC_LABELS[i.topic] || 'Other'; }).map(function (x) {
    return { label: x.label, count: x.count, pct: Math.round((100 * x.count) / stf.length) };
  });
  const reasons = tally(inRange.filter(function (i) { return i.kind === 'person'; }), reasonLabel_);

  return { totals: totals, days: days, topics: topics, reasons: reasons, quality: latestEval(evalRows) };
}

/** The most recent runEval() result from the Eval tab, or null. */
function latestEval(evalRows) {
  const rows = (evalRows || []).filter(function (r) { return toMs_(r[0]); });
  if (!rows.length) return null;
  const last = Math.max.apply(null, rows.map(function (r) { return toMs_(r[0]); }));
  const run = rows.filter(function (r) { return toMs_(r[0]) === last; });
  return { at: last, passed: run.filter(function (r) { return r[5] === 'PASS'; }).length, total: run.length };
}

// ---------- the page ----------

function doGet() {
  try {
    assertViewer_();
  } catch (e) {
    return HtmlService.createHtmlOutput('<p style="font-family:sans-serif">You don\'t have access to this dashboard.</p>');
  }
  return HtmlService.createHtmlOutputFromFile('Dashboard')
    .setTitle('STF Bot')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/** Throws unless the viewer is allowed (only matters when DASHBOARD_VIEWERS is set). */
/** Throws if the viewer isn't on DASHBOARD_VIEWERS. Returns the settings so callers don't read them twice. */
function assertViewer_() {
  const settings = getSettings();
  const allowed = settings.DASHBOARD_VIEWERS;
  if (!allowed.length) return settings;
  const email = String(Session.getActiveUser().getEmail() || '').toLowerCase();
  if (!email || allowed.indexOf(email) === -1) throw new Error('Not allowed');
  return settings;
}

function rowsOf_(tab) {
  const panel = getControlPanel_();
  const sheet = panel && panel.getSheetByName(tab);
  return sheet ? sheet.getDataRange().getValues().slice(1) : [];
}

function tz_() {
  return Session.getScriptTimeZone();
}

/** Local midnight (TESC's time zone) of the day containing ms. */
function startOfDay_(ms) {
  return new Date(Utilities.formatDate(new Date(ms), tz_(), "yyyy-MM-dd'T'00:00:00XXX")).getTime();
}

// ---------- called from the page ----------

function getInboxData() {
  const settings = assertViewer_();
  const activity = rowsOf_('Activity Log');
  const inbox = buildInbox(activity, rowsOf_('Needs Decision'), 60);
  const weekAgo = Date.now() - 7 * DAY_MS;
  const week = parseActivity(activity).filter(function (i) { return i.t >= weekAgo; });
  const panel = getControlPanel_();
  return {
    inbox: Session.getEffectiveUser().getEmail(),
    enabled: settings.BOT_ENABLED,
    mode: settings.MODE,
    lastRunOk: loadState_().lastRunOk || 0,
    queue: inbox.queue,
    handled: inbox.handled,
    weekHandled: week.filter(function (i) { return i.kind !== 'person'; }).length,
    links: {
      panel: panel ? panel.getUrl() : '',
      faq: settings.FAQ_DOC_ID ? 'https://docs.google.com/document/d/' + settings.FAQ_DOC_ID + '/edit' : '',
    },
  };
}

/** range = { days: 7 | 30 | 90 } or { start: 'yyyy-mm-dd', end: 'yyyy-mm-dd' } (end included). */
function getAnalytics(range) {
  assertViewer_();
  range = range || {};
  let start;
  let end;
  const isDate = function (s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')); };
  if (isDate(range.start) && isDate(range.end)) {
    start = startOfDay_(new Date(range.start + 'T12:00:00Z').getTime());
    end = startOfDay_(new Date(range.end + 'T12:00:00Z').getTime()) + DAY_MS;
    if (end <= start || end - start > 366 * DAY_MS) throw new Error('Pick a range of up to one year.');
  } else {
    const days = [7, 30, 90].indexOf(Number(range.days)) !== -1 ? Number(range.days) : 30;
    end = startOfDay_(Date.now()) + DAY_MS;
    start = end - days * DAY_MS;
  }
  const tz = tz_();
  const out = summarizeActivity(rowsOf_('Activity Log'), rowsOf_('Eval'), start, end,
    function (ms) { return Utilities.formatDate(new Date(ms), tz, 'yyyy-MM-dd'); },
    function (ms) { return Utilities.formatDate(new Date(ms), tz, 'MMM d'); });
  out.start = start;
  out.end = end - 1;
  out.open = buildInbox([], rowsOf_('Needs Decision')).queue.length;
  out.spendCap = 5;
  return out;
}

/** One email for the reading pane. Only emails the bot logged can be opened. */
function getEmailDetail(messageId) {
  const settings = assertViewer_();
  const d = emailDetails_([messageId], settings)[String(messageId || '')];
  if (!d) throw new Error('Unknown email.');
  return d;
}

/** Up to 10 emails in one call, so the page can load the likely next clicks in the background. */
function getEmailDetails(messageIds) {
  const settings = assertViewer_();
  return emailDetails_((messageIds || []).slice(0, 10), settings);
}

/** {messageId: detail}. IDs that aren't in the Activity Log are left out. */
function emailDetails_(messageIds, settings) {
  const ids = messageIds.map(String).filter(function (id) { return /^[A-Za-z0-9]{1,40}$/.test(id); });
  const out = {};
  if (!ids.length) return out;
  const items = parseActivity(rowsOf_('Activity Log'));
  let appValues = null;
  if (settings.APPLICATIONS_SHEET_ID) {
    try {
      appValues = SpreadsheetApp.openById(settings.APPLICATIONS_SHEET_ID).getSheets()[0].getDataRange().getValues();
    } catch (e) {
      appValues = null;
    }
  }
  ids.forEach(function (messageId) {
    const logged = items.filter(function (i) { return i.messageId === messageId; })
      .sort(function (a, b) { return b.t - a.t; })[0];
    if (!logged) return;

    let body = '';
    let date = logged.t;
    try {
      const msg = GmailApp.getMessageById(messageId);
      body = truncateText(stripQuoted(msg.getPlainBody()), 6000);
      date = msg.getDate().getTime();
    } catch (e) {
      body = '';
    }

    let applications = null;
    if (appValues && logged.from) {
      applications = (findApplications(appValues, logged.from, settings.APPLICATIONS_EMAIL_COLUMN, settings.APPLICATIONS_STATUS_COLUMN) || []).slice(0, 3);
    }
    const earlier = items.filter(function (i) { return i.from === logged.from && i.messageId !== messageId; })
      .sort(function (a, b) { return b.t - a.t; });

    out[messageId] = {
      messageId: messageId,
      threadId: logged.threadId,
      from: logged.from,
      name: logged.name,
      subject: logged.subject,
      date: date,
      body: body,
      kind: logged.kind,
      shadow: logged.shadow,
      why: friendlyWhy(logged.why),
      reply: logged.reply,
      repliedAt: logged.t,
      applications: applications,
      earlier: { count: earlier.length, last: earlier.length ? earlier[0].t : 0 },
    };
  });
  return out;
}

/** Ticks "Done?" in the Needs Decision tab for this thread. */
function markDone(threadId) {
  assertViewer_();
  threadId = String(threadId || '');
  if (!/^[A-Za-z0-9]{1,40}$/.test(threadId)) throw new Error('Unknown email.');
  const sheet = getControlPanel_().getSheetByName('Needs Decision');
  const values = sheet.getDataRange().getValues();
  let n = 0;
  for (let i = 1; i < values.length; i++) {
    if (threadIdFromLink(values[i][ND.link]) === threadId && values[i][ND.done] !== true) {
      sheet.getRange(i + 1, ND.done + 1).setValue(true);
      n++;
    }
  }
  return n;
}

function setBotEnabled(on) {
  assertViewer_();
  setSetting_('BOT_ENABLED', on ? 'TRUE' : 'FALSE');
  return getSettings().BOT_ENABLED;
}

function setBotMode(mode) {
  assertViewer_();
  if (mode !== 'live' && mode !== 'shadow') throw new Error('Mode must be live or shadow.');
  setSetting_('MODE', mode);
  return getSettings().MODE;
}

function runEvalFromDashboard() {
  assertViewer_();
  runEval();
  return latestEval(rowsOf_('Eval'));
}

// ---------- settings page ----------

/** Settings the dashboard can change, with the allowed range for numbers. Anything else stays sheet-only. */
const EDITABLE_SETTINGS = {
  PER_SENDER_DAILY_LIMIT: { type: 'number', min: 0, max: 50 },
  MAX_BOT_REPLIES_PER_THREAD: { type: 'number', min: 0, max: 20 },
  DAILY_AI_CALL_LIMIT: { type: 'number', min: 0, max: 1000 },
  ALERT_EMAILS: { type: 'emails' },
  BLOCKED_SENDERS: { type: 'emails' },
  DASHBOARD_VIEWERS: { type: 'emails' },
  APPLICATIONS_SHEET_ID: { type: 'sheet' },
  APPLICATIONS_EMAIL_COLUMN: { type: 'column' },
  APPLICATIONS_STATUS_COLUMN: { type: 'column' },
  OWN_ADDRESSES: { type: 'emails', required: true },
  ALLOWED_SENDER_DOMAIN: { type: 'domain' },
  ALLOWED_LINK_DOMAINS: { type: 'domains', required: true },
  LOOKBACK_DAYS: { type: 'number', min: 1, max: 14 },
  MAX_EMAIL_CHARS: { type: 'number', min: 500, max: 20000 },
  MAX_REPLY_CHARS: { type: 'number', min: 500, max: 10000 },
  CHECK_EVERY_MINUTES: { type: 'choice', values: CHECK_MINUTES_ALLOWED },
};

const EMAIL_RE_ = /^[^\s@,;<>"'=]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const DOMAIN_RE_ = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

/** Pulls a Google Sheet ID out of a link or a bare ID. Returns '' for empty, null if it isn't one. */
function sheetIdFrom(value) {
  const s = String(value || '').trim();
  if (!s) return '';
  const m = s.match(/\/spreadsheets\/d\/([A-Za-z0-9_-]{20,})/) || s.match(/^([A-Za-z0-9_-]{20,})$/);
  return m ? m[1] : null;
}

/**
 * Checks changes from the settings page. Pure function, unit-tested.
 * Returns { clean: {KEY: text to store}, errors: {KEY: message} }.
 */
function validateSettingChanges(changes, viewerEmail) {
  const clean = {};
  const errors = {};
  Object.keys(changes || {}).forEach(function (key) {
    const rule = EDITABLE_SETTINGS[key];
    if (!rule) { errors[key] = 'This setting can only be changed in the spreadsheet.'; return; }
    const raw = String(changes[key] == null ? '' : changes[key]).trim();
    if (raw.length > 2000) { errors[key] = 'Too long.'; return; }

    if (rule.type === 'number') {
      const n = Number(raw);
      if (raw === '' || !Number.isInteger(n) || n < rule.min || n > rule.max) {
        errors[key] = 'Enter a whole number from ' + rule.min + ' to ' + rule.max + '.';
      } else clean[key] = String(n);
      return;
    }
    if (rule.type === 'emails' || rule.type === 'domains') {
      const items = raw.split(/[,\s]+/).map(function (x) { return x.trim().toLowerCase(); }).filter(Boolean);
      const re = rule.type === 'emails' ? EMAIL_RE_ : DOMAIN_RE_;
      const bad = items.filter(function (x) { return !re.test(x); });
      if (bad.length) { errors[key] = 'Not valid: ' + bad.slice(0, 3).join(', '); return; }
      if (rule.required && !items.length) { errors[key] = 'This can\'t be empty.'; return; }
      if (key === 'DASHBOARD_VIEWERS' && items.length) {
        const me = String(viewerEmail || '').toLowerCase();
        if (!me) { errors[key] = 'Can\'t confirm who you are, so this can only be changed in the spreadsheet.'; return; }
        if (items.indexOf(me) === -1) { errors[key] = 'Add your own address (' + me + ') or you\'ll lock yourself out.'; return; }
      }
      clean[key] = items.join(', ');
      return;
    }
    if (rule.type === 'domain') {
      const d = raw.toLowerCase().replace(/^@/, '');
      if (!DOMAIN_RE_.test(d)) { errors[key] = 'Enter a domain like ucsd.edu.'; return; }
      clean[key] = d;
      return;
    }
    if (rule.type === 'sheet') {
      const id = sheetIdFrom(raw);
      if (id === null) { errors[key] = 'Paste the link to a Google Sheet.'; return; }
      clean[key] = id;
      return;
    }
    if (rule.type === 'choice') {
      if (rule.values.indexOf(Number(raw)) === -1) errors[key] = 'Choose ' + rule.values.join(', ') + '.';
      else clean[key] = String(Number(raw));
      return;
    }
    if (rule.type === 'column') {
      if (!raw || raw.length > 60 || /^[=+\-@]/.test(raw)) { errors[key] = 'Enter the column\'s header text.'; return; }
      clean[key] = raw;
    }
  });
  return { clean: clean, errors: errors };
}

/** Current values for the settings page, as text. */
function settingsPageValues_() {
  const raw = readSettingsTab_();
  const out = {};
  Object.keys(EDITABLE_SETTINGS).forEach(function (key) {
    const v = raw[key] !== undefined && String(raw[key]).trim() !== '' ? raw[key] : SETTING_DEFAULTS[key][0];
    out[key] = String(v).trim();
  });
  if (out.APPLICATIONS_SHEET_ID) out.APPLICATIONS_SHEET_ID = 'https://docs.google.com/spreadsheets/d/' + out.APPLICATIONS_SHEET_ID + '/edit';
  return out;
}

function getSettingsPage() {
  assertViewer_();
  const panel = getControlPanel_();
  return { values: settingsPageValues_(), panelUrl: panel ? panel.getUrl() : '' };
}

/** Saves changes from the settings page. Nothing is written if any value is invalid. */
function saveSettings(changes) {
  assertViewer_();
  const v = validateSettingChanges(changes, Session.getActiveUser().getEmail());
  if (Object.keys(v.errors).length) return { ok: false, errors: v.errors };
  const sheet = getControlPanel_().getSheetByName('Settings');
  const rows = sheet.getDataRange().getValues();
  Object.keys(v.clean).forEach(function (key) {
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] === key) { sheet.getRange(i + 1, 2).setValue(v.clean[key]); return; }
    }
    sheet.appendRow([key, v.clean[key], SETTING_DEFAULTS[key][1]]);
  });
  // A new check interval only takes effect once the timer is recreated.
  // Skip it if the bot's timers aren't installed (the bot is switched off).
  const running = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'processInbox'; });
  if (v.clean.CHECK_EVERY_MINUTES && running) scheduleInboxCheck_(Number(v.clean.CHECK_EVERY_MINUTES));
  return { ok: true, values: settingsPageValues_() };
}
