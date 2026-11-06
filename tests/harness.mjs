// Test harness: loads the Apps Script files into Node with fake Google services
// (fake Gmail, Sheets, Properties, etc.), so the whole bot can be tested offline.
import { readFileSync, readdirSync } from 'node:fs';
import vm from 'node:vm';

const BOT_DIR = new URL('../bot/', import.meta.url);
const EXPORTED_CONSTS = ['SETTING_DEFAULTS', 'LABELS', 'FAQ_SEED', 'REPLY_SCHEMA', 'SIGNATURE', 'TAB_HEADERS', 'STATE_KEY', 'EVAL_CASES', 'BOT_VERSION'];

export const PASS_AUTH = 'mx.google.com; dkim=pass header.i=@ucsd.edu header.s=google; spf=pass (google.com: domain of x@ucsd.edu designates 1.2.3.4 as permitted sender) smtp.mailfrom=x@ucsd.edu; dmarc=pass (p=REJECT sp=NONE dis=NONE) header.from=ucsd.edu';
export const FAIL_AUTH = 'mx.google.com; dkim=none; spf=softfail smtp.mailfrom=x@ucsd.edu; dmarc=fail (p=REJECT sp=NONE dis=NONE) header.from=ucsd.edu';

function botSource() {
  const files = readdirSync(BOT_DIR).filter((f) => f.endsWith('.js')).sort();
  const code = files.map((f) => `// ---- ${f}\n` + readFileSync(new URL(f, BOT_DIR), 'utf8')).join('\n');
  return code + `\nglobalThis.__consts = { ${EXPORTED_CONSTS.join(', ')} };` +
    '\nglobalThis.__setNow = function (fn) { Date.now = fn; };'; // lets tests fake the clock
}

/** Builds an Anthropic-style API response containing the given JSON answer. */
export function anthropicAnswer(answer, usage = { input_tokens: 6000, output_tokens: 250 }) {
  return {
    code: 200,
    json: {
      content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: JSON.stringify(answer) }],
      stop_reason: 'end_turn',
      usage,
    },
  };
}

function decodeB64(s) {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

export function makeEnv(opts = {}) {
  const me = opts.me || 'contact@tescatucsd.org';
  // BOT_START_TIME = 1 (1970) means "handle every email" unless a test sets it.
  const triggers = [];
  const props = { CONTROL_PANEL_ID: 'cp', ANTHROPIC_API_KEY: 'test-key', BOT_START_TIME: '1', ...(opts.props || {}) };
  const settingsRows = [['Setting', 'Value', 'What it does'], ...Object.entries(opts.settings || {}).map(([k, v]) => [k, v, ''])];

  const sheets = {
    cp: {
      Settings: settingsRows,
      'Activity Log': [],
      'Needs Decision': [],
      Errors: [],
      Eval: [],
    },
    ...(opts.extraSheets || {}),
  };

  const threads = new Map(); // threadId -> { id, messages: [], labels: Set }
  const headersById = new Map();
  const sent = [];
  const alerts = [];
  const fetches = [];
  const createdLabels = new Set();
  let msgCounter = 0;
  const cache = {};
  const gmailCalls = { search: 0, getMessages: 0 };
  let aiHandler = opts.aiHandler || (() => anthropicAnswer({ category: 'faq', reply: 'Hi there,\nApply at https://forms.gle/g6GC2MjhuTgNiB9k7.', reason: 'covered by FAQ' }));

  function addMessage({ threadId, from, subject = 'Travel fund question', body = 'How do I apply?', auth = PASS_AUTH, headers = [], date }) {
    const id = 'm' + ++msgCounter;
    threadId = threadId || 't' + msgCounter;
    const all = [
      { name: 'From', value: from },
      { name: 'Subject', value: subject },
      { name: 'Message-ID', value: `<${id}@mail.example>` },
      ...(auth ? [{ name: 'Authentication-Results', value: auth }] : []),
      ...headers,
    ];
    headersById.set(id, all);
    if (!threads.has(threadId)) threads.set(threadId, { id: threadId, messages: [], labels: new Set() });
    threads.get(threadId).messages.push({ id, from, subject, body, date: date || new Date() });
    return { id, threadId };
  }

  const lastDate = (t) => t.messages[t.messages.length - 1].date;
  const fakeThread = (t) => ({
    getId: () => t.id,
    getLastMessageDate: () => lastDate(t),
    getMessageCount: () => t.messages.length,
    getMessages: () => (gmailCalls.getMessages++, t.messages.map((m) => ({
      getId: () => m.id,
      getFrom: () => m.from,
      getSubject: () => m.subject,
      getPlainBody: () => m.body,
      getDate: () => m.date,
    }))),
    addLabel: (label) => t.labels.add(label.getName()),
  });

  // Like Sheets: a leading ' keeps text as text and isn't part of the stored value.
  const cell = (v) => (typeof v === 'string' && v.startsWith("'") ? v.slice(1) : v);
  const fakeSheet = (rows) => ({
    appendRow: (row) => rows.push(row.map(cell)),
    getLastRow: () => rows.length,
    setRowHeightsForced: () => {},
    getDataRange: () => ({ getValues: () => rows.map((r) => r.slice()) }),
    getRange: (r, c, nr = 1, nc = 1) => ({
      setValue: (v) => { rows[r - 1][c - 1] = cell(v); },
      getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => (rows[r - 1 + i] || [])[c - 1 + j] ?? '')),
      setValues: (vals) => vals.forEach((vr, i) => {
        while (rows.length < r + i) rows.push([]);
        vr.forEach((v, j) => { rows[r - 1 + i][c - 1 + j] = cell(v); });
      }),
      insertCheckboxes: () => {},
    }),
  });

  const context = {
    console: { log: () => {}, error: () => {} },
    Logger: { log: () => {} },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (k in props ? props[k] : null),
        setProperty: (k, v) => { props[k] = String(v); },
        setProperties: (o) => { for (const [k, v] of Object.entries(o)) props[k] = String(v); },
        deleteProperty: (k) => { delete props[k]; },
      }),
    },
    Session: {
      getEffectiveUser: () => ({ getEmail: () => me }),
      getActiveUser: () => ({ getEmail: () => opts.viewer || '' }),
      getScriptTimeZone: () => 'America/Los_Angeles',
    },
    CacheService: {
      getScriptCache: () => ({
        get: (k) => (k in cache ? cache[k] : null),
        putAll: (o) => Object.assign(cache, o),
        put: (k, v) => { cache[k] = String(v); },
      }),
    },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    Utilities: {
      Charset: { UTF_8: 'UTF-8' },
      base64Encode: (s) => Buffer.from(String(s), 'utf8').toString('base64'),
      base64EncodeWebSafe: (s) => Buffer.from(String(s), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_'),
      formatDate: (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(d),
      sleep: () => {},
    },
    GmailApp: {
      // Newest first, like Gmail. `max` limits the results.
      search: (q, start = 0, max = 500) => (gmailCalls.search++, [...threads.values()]
        .sort((a, b) => lastDate(b) - lastDate(a)).slice(start, start + max).map(fakeThread)),
      getMessageById: (id) => {
        for (const t of threads.values()) {
          const m = t.messages.find((x) => x.id === id);
          if (m) return { getPlainBody: () => m.body, getDate: () => m.date, getFrom: () => m.from, getSubject: () => m.subject };
        }
        throw new Error('Invalid argument: id');
      },
      getUserLabelByName: (name) => (createdLabels.has(name) ? { getName: () => name } : null),
      createLabel: (name) => { createdLabels.add(name); return { getName: () => name }; },
    },
    Gmail: {
      Users: {
        Messages: {
          get: (user, id) => ({ id, payload: { headers: headersById.get(id) || [] } }),
          send: (resource) => {
            const raw = decodeB64(resource.raw);
            const [head, b64body] = raw.split('\r\n\r\n');
            const headers = Object.fromEntries(head.split('\r\n').map((l) => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 1).trim()]));
            const body = Buffer.from(b64body.replace(/\r\n/g, ''), 'base64').toString('utf8');
            sent.push({ threadId: resource.threadId, headers, body, raw });
            // The sent reply shows up in the thread, like in real Gmail.
            addMessage({ threadId: resource.threadId, from: me, subject: headers.Subject, body, auth: null, headers: [{ name: 'X-STF-Bot', value: 'yes' }] });
            return { id: 'sent' + sent.length };
          },
        },
      },
    },
    SpreadsheetApp: {
      openById: (id) => {
        const book = sheets[id];
        if (!book) throw new Error('No such spreadsheet ' + id);
        const names = Object.keys(book);
        return {
          getId: () => id,
          getUrl: () => 'https://docs.google.com/spreadsheets/d/' + id,
          getSheetByName: (n) => (book[n] ? fakeSheet(book[n]) : null),
          getSheets: () => names.map((n) => fakeSheet(book[n])),
        };
      },
    },
    DocumentApp: { openById: () => ({ getBody: () => ({ getText: () => opts.faqDocText || '' }) }) },
    UrlFetchApp: {
      fetch: (url, o) => {
        const body = JSON.parse(o.payload);
        fetches.push({ url, headers: o.headers, body });
        const r = aiHandler({ url, body, headers: o.headers });
        return { getResponseCode: () => r.code, getContentText: () => JSON.stringify(r.json) };
      },
    },
    MailApp: { sendEmail: (to, subject, body) => alerts.push({ to, subject, body }) },
    ScriptApp: {
      WeekDay: { MONDAY: 'MONDAY' },
      getProjectTriggers: () => triggers.slice(),
      deleteTrigger: (t) => { triggers.splice(triggers.indexOf(t), 1); },
      newTrigger: (fn) => {
        const t = { fn, every: null, getHandlerFunction: () => fn };
        const b = {
          timeBased: () => b, everyMinutes: (n) => { t.every = n; return b; }, everyDays: () => b,
          atHour: () => b, onWeekDay: () => b, create: () => { triggers.push(t); return t; },
        };
        return b;
      },
    },
  };
  vm.createContext(context);
  vm.runInContext(botSource(), context, { filename: 'bot.js' });

  return {
    bot: context,
    consts: context.__consts,
    props,
    sheets,
    threads,
    sent,
    alerts,
    fetches,
    triggers,
    addMessage,
    setAiHandler: (fn) => { aiHandler = fn; },
    setNow: (fn) => context.__setNow(fn),
    labelsOf: (threadId) => [...threads.get(threadId).labels],
    activity: () => sheets.cp['Activity Log'],
    cache,
    gmailCalls,
    run: () => context.processInbox(),
  };
}
