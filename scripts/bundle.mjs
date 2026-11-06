// Packs the .js files in bot/ into ONE file, dist/Code.gs, for the copy-paste install,
// and copies the dashboard page (Dashboard.html) and appsscript.json next to it.
//   npm run bundle                 -> writes dist/
//   npm run bundle -- --copy       -> also puts Code.gs on the clipboard (Mac)
//   npm run bundle -- --copy-html  -> puts Dashboard.html on the clipboard instead
//   npm run bundle -- --copy-chat  -> puts the chat project's Code.gs (dist/chat/) on the clipboard
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
const pages = readdirSync(bot).filter((f) => f.endsWith('.html'));
pages.forEach((f) => copyFileSync(new URL(f, bot), new URL(f, dist)));
console.log(`Wrote dist/Code.gs (${files.length} files, ${Math.round(code.length / 1024)} KB), ${pages.join(', ')} and appsscript.json`);
if (process.argv.includes('--copy')) {
  execFileSync('pbcopy', { input: code });
  console.log('Copied dist/Code.gs to the clipboard.');
}
if (process.argv.includes('--copy-html')) {
  execFileSync('pbcopy', { input: readFileSync(new URL('Dashboard.html', bot)) });
  console.log('Copied Dashboard.html to the clipboard.');
}

// The website chat is a separate Apps Script project: chat/ plus the few bot files it reuses.
const CHAT_SHARED = ['FaqSeed.js', 'Filters.js', 'Llm.js'];
const chatDir = new URL('../chat/', import.meta.url);
const chatDist = new URL('chat/', dist);
const chatFiles = readdirSync(chatDir).filter((f) => f.endsWith('.js')).sort();
const chatVersion = (readFileSync(new URL('Chat.js', chatDir), 'utf8').match(/CHAT_VERSION = '([^']+)'/) || [])[1];
const chatCode = [`// STF Chat ${chatVersion}: built ${new Date().toISOString()} from chat/ and bot/ (${CHAT_SHARED.join(', ')}).`,
  '// Do not edit here; edit the files and run `npm run bundle` again.', '']
  .concat(CHAT_SHARED.map((f) => `// ===== bot/${f} =====\n` + readFileSync(new URL(f, bot), 'utf8')))
  .concat(chatFiles.map((f) => `// ===== chat/${f} =====\n` + readFileSync(new URL(f, chatDir), 'utf8'))).join('\n');
mkdirSync(chatDist, { recursive: true });
writeFileSync(new URL('Code.gs', chatDist), chatCode);
copyFileSync(new URL('appsscript.json', chatDir), new URL('appsscript.json', chatDist));
console.log(`Wrote dist/chat/Code.gs (${Math.round(chatCode.length / 1024)} KB) and dist/chat/appsscript.json`);
if (process.argv.includes('--copy-chat')) {
  execFileSync('pbcopy', { input: chatCode });
  console.log('Copied dist/chat/Code.gs to the clipboard.');
}
