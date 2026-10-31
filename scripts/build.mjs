// Copies files Apps Script can't read directly into bot/ as JavaScript:
//   faq/STF_FAQ.md     -> bot/FaqSeed.js   (the starting FAQ)
//   eval/cases.json    -> bot/EvalCases.js (test emails for runEval())
// Run: npm run build   (also runs automatically before `npm run bundle` and `npm run push`)
import { readFileSync, writeFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const write = (p, s) => { writeFileSync(new URL(p, import.meta.url), s); console.log('Wrote', p.replace('../', '')); };

write('../bot/FaqSeed.js', `// GENERATED from faq/STF_FAQ.md by scripts/build.mjs. Do not edit by hand.
// This is the starting FAQ. After setup(), volunteers edit the FAQ Google Doc instead.
const FAQ_SEED = ${JSON.stringify(read('../faq/STF_FAQ.md'))};
`);

write('../bot/EvalCases.js', `// GENERATED from eval/cases.json by scripts/build.mjs. Do not edit by hand.
// Sample emails that runEval() (Eval.js) sends to the AI to grade its answers.
const EVAL_CASES = ${JSON.stringify(JSON.parse(read('../eval/cases.json')), null, 1)};
`);
