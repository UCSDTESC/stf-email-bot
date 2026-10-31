// Packs every file in bot/ into ONE file, dist/Code.gs, for the copy-paste install:
// open the Apps Script editor, select all in Code.gs, paste. (Also copies appsscript.json.)
//   npm run bundle            -> writes dist/Code.gs
//   npm run bundle -- --copy  -> also puts it on the clipboard (Mac)
import { readFileSync, writeFileSync, readdirSync, mkdirSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const bot = new URL('../bot/', import.meta.url);
const dist = new URL('../dist/', import.meta.url);
const files = readdirSync(bot).filter((f) => f.endsWith('.js')).sort();
const version = (readFileSync(new URL('Main.js', bot), 'utf8').match(/BOT_VERSION = '([^']+)'/) || [])[1];
const code = [`// STF Email Bot ${version}: built ${new Date().toISOString()} from bot/ (${files.join(', ')}).`,
  '// Do not edit here; edit the files in bot/ and run `npm run bundle` again.', '']
  .concat(files.map((f) => `// ===== ${f} =====\n` + readFileSync(new URL(f, bot), 'utf8'))).join('\n');

mkdirSync(dist, { recursive: true });
writeFileSync(new URL('Code.gs', dist), code);
copyFileSync(new URL('appsscript.json', bot), new URL('appsscript.json', dist));
console.log(`Wrote dist/Code.gs (${files.length} files, ${Math.round(code.length / 1024)} KB) and dist/appsscript.json`);
if (process.argv.includes('--copy')) {
  execFileSync('pbcopy', { input: code });
  console.log('Copied dist/Code.gs to the clipboard.');
}
