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
