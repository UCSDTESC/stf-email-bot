// Runs the test emails in eval/cases.json through a REAL AI model and scores the answers.
// Uses the exact same prompt and safety checks as the bot.
//
//   ANTHROPIC_API_KEY=sk-... npm run eval
//   PROVIDER=gemini MODEL=gemini-2.5-flash-lite GEMINI_API_KEY=... npm run eval
//   PROVIDER=openai MODEL=gpt-5-nano OPENAI_API_KEY=... npm run eval
//
// Costs about $0.01 per full run on the cheap models.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { makeEnv } from '../tests/harness.mjs';

const PROVIDER = (process.env.PROVIDER || 'anthropic').toLowerCase();
const MODEL = process.env.MODEL || { anthropic: 'claude-haiku-5-5', gemini: 'gemini-2.5-flash-lite', openai: 'gpt-5-nano' }[PROVIDER];
const KEY = process.env[{ anthropic: 'ANTHROPIC_API_KEY', gemini: 'GEMINI_API_KEY', openai: 'OPENAI_API_KEY' }[PROVIDER]];
if (!KEY) {
  console.error(`Missing API key for ${PROVIDER}. Example: ANTHROPIC_API_KEY=sk-... npm run eval`);
  process.exit(1);
}

const { bot } = makeEnv();
const settings = bot.normalizeSettings({});
const faq = readFileSync(new URL('../faq/STF_FAQ.md', import.meta.url), 'utf8');
const cases = JSON.parse(readFileSync(new URL('../eval/cases.json', import.meta.url), 'utf8'))
  .filter((c) => !process.env.ONLY || c.id === process.env.ONLY);
const system = bot.buildSystemPrompt(faq);

async function runCase(c) {
  const user = bot.buildUserMessage({ firstName: 'Alex', subject: c.subject, body: c.body },
    c.application || 'No application was found for this email address.');
  const req = bot.buildModelRequest(PROVIDER, MODEL, KEY, system, user);
  const res = await fetch(req.url, { method: 'POST', headers: { 'content-type': 'application/json', ...req.headers }, body: JSON.stringify(req.body) });
  const text = await res.text();
  if (!res.ok) return { id: c.id, pass: false, problems: [`HTTP ${res.status}: ${text.slice(0, 200)}`] };
  let parsed;
  try { parsed = bot.parseModelResponse(PROVIDER, JSON.parse(text)); } catch (e) { return { id: c.id, pass: false, problems: [e.message] }; }

  const { category, reply, reason } = parsed.result;
  const expected = [].concat(c.expect);
  const { pass, problems } = bot.scoreEvalCase(c, parsed.result, settings); // same grading as runEval() in Google
  return { id: c.id, expected, category, pass, problems, reason, reply, usage: parsed.usage, cost: bot.estimateCostUsd(MODEL, parsed.usage) };
}

// Run 4 at a time.
const results = [];
for (let i = 0; i < cases.length; i += 4) results.push(...(await Promise.all(cases.slice(i, i + 4).map(runCase))));

const pct = (arr) => (arr.length ? Math.round((100 * arr.filter((r) => r.pass).length) / arr.length) : 100);
const byGroup = (pred) => results.filter((r) => pred(cases.find((c) => c.id === r.id)));
console.log(`\n${PROVIDER} / ${MODEL}\n`);
for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.id.padEnd(22)} ${r.category || ''}${r.pass ? '' : '  <- ' + r.problems.join('; ')}`);
const cost = results.reduce((s, r) => s + (r.cost || 0), 0);
console.log(`
Overall:                          ${pct(results)}% (${results.filter((r) => r.pass).length}/${results.length})
Answers (faq/status):             ${pct(byGroup((c) => ['faq', 'status'].includes([].concat(c.expect)[0]) && !c.id.startsWith('inject')))}%
Escalations (needs_decision):     ${pct(byGroup((c) => c.expect === 'needs_decision'))}%   <- should be 100%
Prompt-injection attempts:        ${pct(byGroup((c) => c.id.startsWith('inject')))}%   <- should be 100%
Cost of this run:                 $${cost.toFixed(4)}  (~$${((cost / results.length) * 300).toFixed(2)} per 300 emails)
`);

mkdirSync(new URL('../eval/results/', import.meta.url), { recursive: true });
const file = new URL(`../eval/results/${PROVIDER}-${MODEL}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`, import.meta.url);
writeFileSync(file, JSON.stringify({ provider: PROVIDER, model: MODEL, results }, null, 2));
console.log('Full answers saved to', file.pathname);
