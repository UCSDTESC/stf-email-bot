// Copies faq/STF_FAQ.md into bot/FaqSeed.js so Apps Script can use it.
// Run: npm run build:faq   (also runs automatically before `npm run push`)
import { readFileSync, writeFileSync } from 'node:fs';

const faq = readFileSync(new URL('../faq/STF_FAQ.md', import.meta.url), 'utf8');
const out = `// GENERATED from faq/STF_FAQ.md by scripts/build-faq-seed.mjs. Do not edit by hand.
// This is the starting FAQ. After setup(), volunteers edit the FAQ Google Doc instead.
const FAQ_SEED = ${JSON.stringify(faq)};
`;
writeFileSync(new URL('../bot/FaqSeed.js', import.meta.url), out);
console.log('Wrote bot/FaqSeed.js');
