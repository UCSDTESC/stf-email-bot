// Tests for the dashboard web page's server side (bot/Dashboard.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, anthropicAnswer } from './harness.mjs';

const LIVE = { MODE: 'live' };
// Real Control Panel tabs have a header row; the fake ones don't. Add it before reading.
const addHeaders = (env) => ['Activity Log', 'Needs Decision', 'Eval'].forEach((t) => env.sheets.cp[t].unshift(['header']));
const DAY = 864e5;

test('decisionKind maps every logged decision', () => {
  const { bot } = makeEnv();
  assert.equal(bot.decisionKind('answered'), 'answered');
  assert.equal(bot.decisionKind('(shadow) answered'), 'answered');
  assert.equal(bot.decisionKind('(shadow) needs decision'), 'person');
  assert.equal(bot.decisionKind('not stf'), 'ignored');
  assert.equal(bot.decisionKind('skipped: mailing list'), 'ignored');
  assert.equal(bot.decisionKind('left for humans: sender is not @ucsd.edu'), 'left');
  assert.equal(bot.decisionKind('error'), 'error');
});

test('parseDisplayName handles plain, quoted and "Last, First" names', () => {
  const { bot } = makeEnv();
  assert.equal(bot.parseDisplayName('Jane Doe <jdoe@ucsd.edu>'), 'Jane Doe');
  assert.equal(bot.parseDisplayName('"Doe, Jane" <jdoe@ucsd.edu>'), 'Jane Doe');
  assert.equal(bot.parseDisplayName('jdoe@ucsd.edu'), '');
  assert.equal(bot.parseDisplayName('"jdoe@ucsd.edu" <jdoe@ucsd.edu>'), '');
});

test('the bot logs the sender name and the AI topic', () => {
  const env = makeEnv({ settings: LIVE, aiHandler: () => anthropicAnswer({ category: 'faq', topic: 'receipts', reply: 'Hi,\nSee https://tescatucsd.org/funding', reason: 'x' }) });
  env.addMessage({ from: 'Jane Doe <jdoe@ucsd.edu>' });
  env.run();
  const row = env.activity()[0];
  assert.equal(row[15], 'Jane Doe');
  assert.equal(row[16], 'receipts');
});

test('a missing or unknown topic from the AI becomes "other"', () => {
  const { bot } = makeEnv();
  assert.equal(bot.parseModelJson('{"category":"faq","reply":"x","reason":"y"}').topic, 'other');
  assert.equal(bot.parseModelJson('{"category":"faq","topic":"weird","reply":"x","reason":"y"}').topic, 'other');
});

function activityRow(t, from, name, decision, opts = {}) {
  return [new Date(t), 'contact@', from, opts.subject || 'Question', decision, '', opts.why || '', opts.reply || '', 'live', 'm', 0, 0,
    opts.cost || 0, 'https://mail.google.com/mail/u/0/#all/' + (opts.thread || 'thread' + t), opts.id || 'msg' + t, name, opts.topic || ''];
}

test('buildInbox: open queue items (joined to their email) and handled emails, newest first', () => {
  const { bot } = makeEnv();
  const now = Date.now();
  const act = [
    activityRow(now - 3000, 'a@ucsd.edu', 'Ann Lee', 'answered', { id: 'm1' }),
    activityRow(now - 2000, 'b@ucsd.edu', 'Bo Kim', 'needs decision', { id: 'm2', thread: 't2' }),
    activityRow(now - 1000, 'news@shop.com', '', 'skipped: mailing list', { id: 'm3' }),
    activityRow(now - 500, 'c@ucsd.edu', 'Cy Diaz', 'needs decision', { id: 'm4', thread: 't4' }),
  ];
  const needs = [
    [new Date(now - 2000), 'b@ucsd.edu', 'Late form', 'extension', 'https://mail.google.com/mail/u/0/#all/t2', false],
    [new Date(now - 500), 'c@ucsd.edu', 'Hi', 'human', 'https://mail.google.com/mail/u/0/#all/t4', true],
  ];
  const r = bot.buildInbox(act, needs, 60);
  assert.equal(r.queue.length, 1, 'done items are hidden');
  assert.equal(r.queue[0].messageId, 'm2');
  assert.equal(r.queue[0].name, 'Bo Kim');
  assert.deepEqual(r.handled.map((h) => h.messageId), ['m3', 'm1']);
  assert.deepEqual(r.handled.map((h) => h.kind), ['ignored', 'answered']);
});

test('summarizeActivity: totals, per-day bars, topics, reasons, comparison and eval score', () => {
  const { bot } = makeEnv();
  const start = Date.UTC(2026, 9, 1);
  const end = start + 3 * DAY;
  const at = (d, h = 12) => start + d * DAY + h * 3600e3;
  const act = [
    activityRow(at(0), 'a@ucsd.edu', 'A', 'answered', { topic: 'deadlines', cost: 0.001 }),
    activityRow(at(0), 'b@ucsd.edu', 'B', '(shadow) answered', { topic: 'deadlines', cost: 0.001 }),
    activityRow(at(1), 'c@ucsd.edu', 'C', 'needs decision', { topic: 'deadlines', why: 'asks for an extension' }),
    activityRow(at(1), 'd@ucsd.edu', 'D', 'needs decision', { why: 'sender asked for a human' }),
    activityRow(at(2), 'e@x.com', '', 'not stf'),
    activityRow(at(2), 'f@ucsd.edu', 'F', 'answered', { topic: 'receipts', cost: 0.002 }),
    activityRow(start - DAY, 'old@ucsd.edu', 'O', 'answered'),
    activityRow(end + DAY, 'future@ucsd.edu', 'X', 'answered'),
  ];
  const evalRows = [
    [new Date(start - 5 * DAY), 'm', 'a', 'faq', 'faq', 'FAIL'],
    [new Date(start - 1 * DAY), 'm', 'a', 'faq', 'faq', 'PASS'],
    [new Date(start - 1 * DAY), 'm', 'b', 'faq', 'faq', 'FAIL'],
  ];
  const key = (ms) => new Date(ms).toISOString().slice(0, 10);
  const a = bot.summarizeActivity(act, evalRows, start, end, key, key);
  assert.deepEqual({ ...a.totals }, { received: 6, previous: 1, answered: 3, person: 2, ignored: 1, handledPct: 60, cost: 0.004 });
  assert.deepEqual(JSON.parse(JSON.stringify(a.days.map((d) => [d.answered, d.person, d.ignored]))), [[2, 0, 0], [0, 2, 0], [1, 0, 1]]);
  assert.equal(a.topics[0].label, 'Deadlines and timing');
  assert.equal(a.topics[0].pct, 75);
  assert.deepEqual(JSON.parse(JSON.stringify(a.reasons.map((r) => r.label).sort())), ['Asked to talk to a person', 'Deadlines and timing']);
  assert.deepEqual({ ...a.quality, at: 0 }, { at: 0, passed: 1, total: 2 });
});

test('getEmailDetail only opens emails the bot logged, and reads the body live from Gmail', () => {
  const env = makeEnv({ settings: LIVE, aiHandler: () => anthropicAnswer({ category: 'needs_decision', topic: 'deadlines', reply: '', reason: 'extension' }) });
  const { id } = env.addMessage({ from: 'Jane Doe <jdoe@ucsd.edu>', subject: 'Late form', body: 'Can I get an extension?' });
  env.addMessage({ from: 'Secret <boss@gmail.com>', subject: 'Private', body: 'not for the dashboard', threadId: 'other' });
  env.run();
  addHeaders(env);
  const d = env.bot.getEmailDetail(id);
  assert.equal(d.body, 'Can I get an extension?');
  assert.equal(d.name, 'Jane Doe');
  assert.equal(d.kind, 'person');
  assert.match(d.reply, /forwarded/);
  assert.equal(d.applications, null, 'no applications sheet connected');
  assert.throws(() => env.bot.getEmailDetail('not-a-real-id'), /Unknown email/);
  const unlogged = [...env.threads.values()].flatMap((t) => t.messages).find((m) => m.from.startsWith('Secret'));
  const loggedIds = env.activity().map((r) => r[14]);
  if (!loggedIds.includes(unlogged.id)) assert.throws(() => env.bot.getEmailDetail(unlogged.id), /Unknown email/);
  assert.ok(!JSON.stringify(env.sheets).includes('Can I get an extension'), 'the email body is never saved');

  const many = JSON.parse(JSON.stringify(env.bot.getEmailDetails([id, 'not-a-real-id', '../bad', unlogged.id])));
  assert.equal(many[id].body, 'Can I get an extension?');
  assert.ok(!many['not-a-real-id'] && !many['../bad'], 'unknown or malformed IDs are left out');
  if (!loggedIds.includes(unlogged.id)) assert.ok(!many[unlogged.id], 'emails the bot never logged are left out');
});

test('markDone ticks the Needs Decision row and removes it from the queue', () => {
  const env = makeEnv({ settings: LIVE, aiHandler: () => anthropicAnswer({ category: 'needs_decision', topic: 'other', reply: '', reason: 'x' }) });
  const { threadId } = env.addMessage({ from: 'Jane <jdoe@ucsd.edu>' });
  env.run();
  addHeaders(env);
  assert.equal(env.bot.getInboxData().queue.length, 1);
  assert.equal(env.bot.markDone(threadId), 1);
  assert.equal(env.sheets.cp['Needs Decision'][1][5], true);
  assert.equal(env.bot.getInboxData().queue.length, 0);
  assert.throws(() => env.bot.markDone('bad id!'), /Unknown email/);
});

test('pause and mode switches write the Settings tab; bad values are refused', () => {
  const env = makeEnv();
  assert.equal(env.bot.setBotEnabled(false), false);
  assert.equal(env.bot.getSettings().BOT_ENABLED, false);
  assert.equal(env.bot.setBotMode('live'), 'live');
  assert.throws(() => env.bot.setBotMode('turbo'), /live or shadow/);
});

test('DASHBOARD_VIEWERS limits who can use the dashboard', () => {
  const blocked = makeEnv({ settings: { DASHBOARD_VIEWERS: 'tech@tescatucsd.org' }, viewer: 'random@gmail.com' });
  assert.throws(() => blocked.bot.getInboxData(), /Not allowed/);
  assert.throws(() => blocked.bot.setBotEnabled(false), /Not allowed/);
  const allowed = makeEnv({ settings: { DASHBOARD_VIEWERS: 'tech@tescatucsd.org' }, viewer: 'Tech@tescatucsd.org' });
  assert.ok(allowed.bot.getInboxData());
});

test('validateSettingChanges accepts good values and explains bad ones', () => {
  const { bot } = makeEnv();
  const ok = JSON.parse(JSON.stringify(bot.validateSettingChanges({
    PER_SENDER_DAILY_LIMIT: ' 10 ',
    ALERT_EMAILS: 'A@ucsd.edu,  b@tescatucsd.org',
    APPLICATIONS_SHEET_ID: 'https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/edit#gid=0',
    ALLOWED_SENDER_DOMAIN: '@UCSD.edu',
    BLOCKED_SENDERS: '',
  }, 'me@ucsd.edu')));
  assert.deepEqual(ok.errors, {});
  assert.deepEqual(ok.clean, {
    PER_SENDER_DAILY_LIMIT: '10',
    ALERT_EMAILS: 'a@ucsd.edu, b@tescatucsd.org',
    APPLICATIONS_SHEET_ID: '1AbCdEfGhIjKlMnOpQrStUvWxYz012345',
    ALLOWED_SENDER_DOMAIN: 'ucsd.edu',
    BLOCKED_SENDERS: '',
  });

  const bad = JSON.parse(JSON.stringify(bot.validateSettingChanges({
    PER_SENDER_DAILY_LIMIT: '500',
    LOOKBACK_DAYS: '1.5',
    ALERT_EMAILS: 'not-an-email',
    OWN_ADDRESSES: '',
    APPLICATIONS_SHEET_ID: 'https://example.com/x',
    APPLICATIONS_STATUS_COLUMN: '=IMPORTXML("http://evil")',
    MODE: 'live',
    ANTHROPIC_API_KEY: 'x',
  }, 'me@ucsd.edu')));
  assert.deepEqual(Object.keys(bad.clean), []);
  assert.deepEqual(Object.keys(bad.errors).sort(), ['ALERT_EMAILS', 'ANTHROPIC_API_KEY', 'APPLICATIONS_SHEET_ID', 'APPLICATIONS_STATUS_COLUMN',
    'LOOKBACK_DAYS', 'MODE', 'OWN_ADDRESSES', 'PER_SENDER_DAILY_LIMIT']);
  assert.match(bad.errors.PER_SENDER_DAILY_LIMIT, /0 to 50/);
});

test('DASHBOARD_VIEWERS can\'t be set in a way that locks you out', () => {
  const { bot } = makeEnv();
  assert.match(bot.validateSettingChanges({ DASHBOARD_VIEWERS: 'other@ucsd.edu' }, 'me@ucsd.edu').errors.DASHBOARD_VIEWERS, /lock yourself out/);
  assert.equal(bot.validateSettingChanges({ DASHBOARD_VIEWERS: 'other@ucsd.edu, ME@ucsd.edu' }, 'me@ucsd.edu').clean.DASHBOARD_VIEWERS, 'other@ucsd.edu, me@ucsd.edu');
  assert.ok(bot.validateSettingChanges({ DASHBOARD_VIEWERS: 'me@ucsd.edu' }, '').errors.DASHBOARD_VIEWERS);
  assert.equal(bot.validateSettingChanges({ DASHBOARD_VIEWERS: '' }, '').clean.DASHBOARD_VIEWERS, '');
});

test('saveSettings writes the Settings tab, or nothing at all if any value is bad', () => {
  const env = makeEnv({ viewer: 'me@ucsd.edu' });
  const page = env.bot.getSettingsPage();
  assert.equal(page.values.PER_SENDER_DAILY_LIMIT, '3');

  const r = JSON.parse(JSON.stringify(env.bot.saveSettings({ PER_SENDER_DAILY_LIMIT: '10', ALERT_EMAILS: 'tech@ucsd.edu' })));
  assert.equal(r.ok, true);
  assert.equal(r.values.PER_SENDER_DAILY_LIMIT, '10');
  assert.equal(env.bot.getSettings().PER_SENDER_DAILY_LIMIT, 10);
  assert.deepEqual([...env.bot.getSettings().ALERT_EMAILS], ['tech@ucsd.edu']);

  const bad = env.bot.saveSettings({ PER_SENDER_DAILY_LIMIT: '4', ALERT_EMAILS: 'nope' });
  assert.equal(bad.ok, false);
  assert.equal(env.bot.getSettings().PER_SENDER_DAILY_LIMIT, 10, 'the good value in a bad save is not written either');
});

test('changing "Check inbox every" reschedules the bot, only if it is running', () => {
  const env = makeEnv({ viewer: 'me@ucsd.edu' });
  env.bot.installTriggers();
  const every = () => env.triggers.filter((t) => t.fn === 'processInbox').map((t) => t.every);
  assert.deepEqual(every(), [5]);
  assert.equal(env.bot.saveSettings({ CHECK_EVERY_MINUTES: '1' }).ok, true);
  assert.deepEqual(every(), [1], 'one timer, now every minute');
  assert.equal(env.triggers.length, 3, 'the daily and weekly timers are untouched');
  assert.equal(env.bot.saveSettings({ CHECK_EVERY_MINUTES: '2' }).ok, false, 'Apps Script only allows 1, 5, 10, 15 or 30');

  env.bot.uninstallTriggers();
  env.bot.saveSettings({ CHECK_EVERY_MINUTES: '5' });
  assert.deepEqual(every(), [], 'a stopped bot is not restarted by a settings change');
  env.bot.installTriggers();
  assert.deepEqual(every(), [5]);
});

test('checkInboxNow runs the bot, then returns the new email in the inbox', () => {
  const env = makeEnv({ settings: LIVE, viewer: 'me@ucsd.edu', aiHandler: () => anthropicAnswer({ category: 'faq', topic: 'receipts', reply: 'Hi,\nSee https://tescatucsd.org/funding', reason: 'x' }) });
  addHeaders(env);
  env.addMessage({ from: 'Jane Doe <jdoe@ucsd.edu>', subject: 'Receipts', body: 'What receipts do I need?' });
  const d = JSON.parse(JSON.stringify(env.bot.checkInboxNow()));
  assert.equal(env.sent.length, 1, 'the reply was sent');
  assert.ok(d.handled.some((i) => i.subject === 'Receipts'));
  assert.throws(() => makeEnv({ settings: { DASHBOARD_VIEWERS: 'tech@ucsd.edu' }, viewer: 'x@gmail.com' }).bot.checkInboxNow(), /Not allowed/);
});
