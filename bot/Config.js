/**
 * Settings for the bot.
 *
 * Volunteers change these in the Control Panel spreadsheet ("Settings" tab).
 * The values below are only the defaults used when a setting is missing.
 * API keys are NOT settings: they live in Script Properties (see README).
 */
const SETTING_DEFAULTS = {
  BOT_ENABLED: ['TRUE', 'FALSE pauses the bot completely.'],
  MODE: ['shadow', 'shadow = only log what it would send. live = really send replies.'],
  PROVIDER: ['anthropic', 'Which AI company: anthropic, gemini or openai.'],
  MODEL: ['claude-haiku-5-5', 'Model name for that provider (e.g. claude-haiku-5-5, gemini-2.5-flash-lite, gpt-5-nano).'],
  OWN_ADDRESSES: ['contact@tescatucsd.org, board@tescatucsd.org', "TESC's own addresses. The bot never replies to these."],
  ALLOWED_SENDER_DOMAIN: ['ucsd.edu', 'Only answer senders whose address ends in exactly @<this>.'],
  BLOCKED_SENDERS: ['', 'Comma-separated addresses the bot must ignore.'],
  DAILY_AI_CALL_LIMIT: ['100', 'Max AI calls per day (protects credits).'],
  PER_SENDER_DAILY_LIMIT: ['3', 'Max bot replies to one person per day.'],
  MAX_BOT_REPLIES_PER_THREAD: ['3', 'After this many bot replies in one thread, leave it for humans.'],
  MAX_EMAIL_CHARS: ['3000', 'Longer emails are cut to this many characters before the AI sees them.'],
  MAX_REPLY_CHARS: ['2500', 'Replies longer than this are blocked.'],
  ALLOWED_LINK_DOMAINS: ['tescatucsd.org, ucsd.edu, forms.gle', 'Replies may only contain links to these sites (and their subdomains).'],
  ALERT_EMAILS: ['', 'Who gets "the bot is broken" emails. Empty = the bot account itself.'],
  FAQ_DOC_ID: ['', 'Google Doc the bot reads its STF facts from (filled in by setup()).'],
  APPLICATIONS_SHEET_ID: ['', "Optional: the STF application responses Sheet, for answering status questions."],
  APPLICATIONS_EMAIL_COLUMN: ['UCSD email', 'Column header holding the applicant email in that Sheet.'],
  APPLICATIONS_STATUS_COLUMN: ['Status', 'Column header reviewers keep updated (e.g. Under review / Approved / Denied).'],
  LOOKBACK_DAYS: ['2', 'How many days back the bot looks for new emails.'],
  DASHBOARD_VIEWERS: ['', 'Optional: only these Google accounts may open the dashboard (comma-separated). Empty = anyone the web app deployment allows.'],
};

const NUMBER_SETTINGS = [
  'DAILY_AI_CALL_LIMIT', 'PER_SENDER_DAILY_LIMIT', 'MAX_BOT_REPLIES_PER_THREAD',
  'MAX_EMAIL_CHARS', 'MAX_REPLY_CHARS', 'LOOKBACK_DAYS',
];
const LIST_SETTINGS = ['OWN_ADDRESSES', 'BLOCKED_SENDERS', 'ALLOWED_LINK_DOMAINS', 'ALERT_EMAILS', 'DASHBOARD_VIEWERS'];

/** Turns raw text values into the right types (numbers, true/false, lists). */
function normalizeSettings(raw) {
  const s = {};
  Object.keys(SETTING_DEFAULTS).forEach(function (key) {
    const v = raw[key] !== undefined && String(raw[key]).trim() !== '' ? raw[key] : SETTING_DEFAULTS[key][0];
    s[key] = String(v).trim();
  });
  NUMBER_SETTINGS.forEach(function (k) {
    const n = Number(s[k]);
    s[k] = isFinite(n) && n >= 0 ? n : Number(SETTING_DEFAULTS[k][0]);
  });
  LIST_SETTINGS.forEach(function (k) {
    s[k] = s[k].split(',').map(function (x) { return x.trim().toLowerCase(); }).filter(Boolean);
  });
  s.BOT_ENABLED = s.BOT_ENABLED.toUpperCase() === 'TRUE';
  s.MODE = s.MODE.toLowerCase() === 'live' ? 'live' : 'shadow';
  s.PROVIDER = s.PROVIDER.toLowerCase();
  s.ALLOWED_SENDER_DOMAIN = s.ALLOWED_SENDER_DOMAIN.toLowerCase();
  return s;
}

/** Reads settings from the Control Panel (if it exists) on top of the defaults. */
function getSettings() {
  return normalizeSettings(readSettingsTab_());
}

/** Reads a secret (like an API key) from Script Properties. */
function getSecret_(name) {
  const value = PropertiesService.getScriptProperties().getProperty(name);
  if (!value) throw new Error('Missing Script Property "' + name + '". See README > Setup.');
  return value;
}
