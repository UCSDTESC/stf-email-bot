/**
 * The Control Panel: one Google Sheet where volunteers see and steer the bot.
 * Tabs: Settings, Activity Log, Needs Decision, Stats, Errors.
 */

const TAB_HEADERS = {
  'Activity Log': ['Time', 'Inbox', 'From', 'Subject', 'Decision', 'AI category', 'Why', 'Reply (sent or would send)',
    'Mode', 'Model', 'Input tokens', 'Output tokens', 'AI cost ($)', 'Open in Gmail', 'Message ID'],
  'Needs Decision': ['Time', 'From', 'Subject', 'Why', 'Open in Gmail', 'Done?'],
  'Errors': ['Time', 'Where', 'Error', 'Message ID'],
};

function getControlPanel_() {
  const id = PropertiesService.getScriptProperties().getProperty('CONTROL_PANEL_ID');
  return id ? SpreadsheetApp.openById(id) : null;
}

/** Reads the Settings tab into {KEY: value}. Returns {} if there's no Control Panel yet. */
function readSettingsTab_() {
  const ss = getControlPanel_();
  const sheet = ss && ss.getSheetByName('Settings');
  if (!sheet) return {};
  const out = {};
  sheet.getDataRange().getValues().slice(1).forEach(function (row) {
    if (row[0]) out[String(row[0]).trim()] = row[1];
  });
  return out;
}

function appendToTab_(tabName, row) {
  const ss = getControlPanel_();
  const sheet = ss && ss.getSheetByName(tabName);
  if (!sheet) {
    console.log(tabName + ': ' + JSON.stringify(row));
    return;
  }
  sheet.appendRow(row);
}

function gmailLink_(threadId) {
  return 'https://mail.google.com/mail/u/0/#all/' + threadId;
}

/** One row per email the bot looked at. */
function logActivity(entry) {
  const ai = entry.ai || {};
  const usage = ai.usage || {};
  appendToTab_('Activity Log', [
    new Date(), entry.inbox, entry.from, entry.subject, entry.decision,
    (ai.result || {}).category || '', entry.why || (ai.result || {}).reason || '',
    entry.reply || '', entry.mode, ai.model || '', usage.input || 0, usage.output || 0,
    Number((ai.costUsd || 0).toFixed(6)), gmailLink_(entry.threadId), entry.messageId,
  ]);
}

function logNeedsDecision(entry) {
  appendToTab_('Needs Decision', [new Date(), entry.from, entry.subject, entry.why, gmailLink_(entry.threadId), false]);
}

function logError(where, err, messageId) {
  appendToTab_('Errors', [new Date(), where, String(err && err.stack || err).slice(0, 2000), messageId || '']);
}

/** Creates the Control Panel spreadsheet. Called once by setup(). */
function createControlPanel_() {
  const ss = SpreadsheetApp.create('STF Bot Control Panel');

  const settings = ss.getSheets()[0].setName('Settings');
  const rows = [['Setting', 'Value', 'What it does']].concat(Object.keys(SETTING_DEFAULTS).map(function (k) {
    return [k, SETTING_DEFAULTS[k][0], SETTING_DEFAULTS[k][1]];
  }));
  settings.getRange(1, 1, rows.length, 3).setValues(rows);
  settings.getRange(1, 1, 1, 3).setFontWeight('bold');
  settings.setFrozenRows(1);
  settings.autoResizeColumns(1, 3);
  settings.protect().setWarningOnly(true).setDescription('Changing settings changes how the bot behaves.');

  Object.keys(TAB_HEADERS).forEach(function (name) {
    const sheet = ss.insertSheet(name);
    sheet.getRange(1, 1, 1, TAB_HEADERS[name].length).setValues([TAB_HEADERS[name]]).setFontWeight('bold');
    sheet.setFrozenRows(1);
  });
  ss.getSheetByName('Needs Decision').getRange('F2:F').insertCheckboxes();
  ss.getSheetByName('Activity Log').protect().setWarningOnly(true).setDescription('Written by the bot.');

  const log = "'Activity Log'!";
  const stats = ss.insertSheet('Stats', 1);
  stats.getRange(1, 1, 10, 2).setValues([
    ['Stat', 'Value'],
    ['Emails looked at (all time)', '=COUNTA(' + log + 'A2:A)'],
    ['Answered by the bot', '=COUNTIF(' + log + 'E2:E,"*answered")'],
    ['Sent to a person (needs decision)', '=COUNTIF(' + log + 'E2:E,"*needs decision")'],
    ['Not about STF (left in inbox)', '=COUNTIF(' + log + 'E2:E,"not stf")'],
    ['Skipped / left for humans (robots, lists, unverified senders, limits)', '=COUNTIF(' + log + 'E2:E,"skipped*")+COUNTIF(' + log + 'E2:E,"left for humans*")'],
    ['Errors', '=COUNTIF(' + log + 'E2:E,"error*")'],
    ['% of STF emails fully handled by the bot', '=IFERROR(B3/(B3+B4),0)'],
    ['AI cost this month ($)', '=SUMIFS(' + log + 'M2:M,' + log + 'A2:A,">="&EOMONTH(TODAY(),-1)+1)'],
    ['AI cost all time ($)', '=SUM(' + log + 'M2:M)'],
  ]);
  stats.getRange('A1:B1').setFontWeight('bold');
  stats.getRange('B8').setNumberFormat('0%');
  stats.autoResizeColumn(1);
  return ss;
}
