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

  const fakeThread = (t) => ({
    getId: () => t.id,
    getMessages: () => t.messages.map((m) => ({
      getId: () => m.id,
      getFrom: () => m.from,
      getSubject: () => m.subject,
      getPlainBody: () => m.body,
      getDate: () => m.date,
    })),
    addLabel: (label) => t.labels.add(label.getName()),
  });

  const fakeSheet = (rows) => ({
    appendRow: (row) => rows.push(row),
    getLastRow: () => rows.length,
    setRowHeightsForced: () => {},
    getDataRange: () => ({ getValues: () => rows.map((r) => r.slice()) }),
    getRange: (r, c) => ({ setValue: (v) => { rows[r - 1][c - 1] = v; } }),
  });

  const context = {
    console: { log: () => {}, error: () => {} },
    Logger: { log: () => {} },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (k in props ? props[k] : null),
        setProperty: (k, v) => { props[k] = String(v); },
        deleteProperty: (k) => { delete props[k]; },
      }),
    },
    Session: {
      getEffectiveUser: () => ({ getEmail: () => me }),
      getScriptTimeZone: () => 'America/Los_Angeles',
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
      search: () => [...threads.values()].map(fakeThread),
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
    addMessage,
    setAiHandler: (fn) => { aiHandler = fn; },
    setNow: (fn) => context.__setNow(fn),
    labelsOf: (threadId) => [...threads.get(threadId).labels],
    activity: () => sheets.cp['Activity Log'],
    run: () => context.processInbox(),
  };
}
