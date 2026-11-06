/**
 * One-time setup and on/off switches. Run these from the Apps Script editor
 * (pick the function in the dropdown at the top, then click "Run").
 */

/** Step 1: creates the Control Panel Sheet, the FAQ Doc and the Gmail labels. Safe to run again. */
function setup() {
  const props = PropertiesService.getScriptProperties();
  let ss = getControlPanel_();
  if (!ss) {
    ss = createControlPanel_();
    props.setProperty('CONTROL_PANEL_ID', ss.getId());
  }
  formatControlPanel_(ss); // also upgrades Control Panels made by older versions
  const settings = getSettings();
  if (!settings.FAQ_DOC_ID) {
    const doc = DocumentApp.create('STF Bot FAQ (the bot only knows what is in here)');
    doc.getBody().setText(FAQ_SEED);
    doc.saveAndClose();
    setSetting_('FAQ_DOC_ID', doc.getId());
  }
  Object.keys(LABELS).forEach(function (k) {
    if (!GmailApp.getUserLabelByName(LABELS[k])) GmailApp.createLabel(LABELS[k]);
  });
  console.log('Control Panel: ' + ss.getUrl());
  console.log('FAQ Doc: https://docs.google.com/document/d/' + getSettings().FAQ_DOC_ID + '/edit');
  console.log('Next: add your API key in Project Settings > Script Properties, run testModel(), then installTriggers().');
}

/** Step 2: checks the AI connection with a sample question. Costs a fraction of a cent. */
function testModel() {
  const s = getSettings();
  const ai = askModel(s, buildSystemPrompt(loadFaqText_(s)), buildUserMessage({
    firstName: 'Test', subject: 'Travel fund question',
    body: 'Hi, how far in advance do I need to apply for the travel fund, and how much does it usually cover?',
  }, 'No application was found for this email address.'));
  console.log(JSON.stringify(ai, null, 2));
}

/**
 * Step 3: turns the bot on: checks the inbox every CHECK_EVERY_MINUTES (default 5), a daily health
 * check, and a weekly summary email (Mondays). The bot only handles emails
 * that arrive after the first time this runs; older emails are never touched.
 */
function installTriggers() {
  uninstallTriggers();
  const start = getBotStartTime_();
  scheduleInboxCheck_(getSettings().CHECK_EVERY_MINUTES);
  ScriptApp.newTrigger('dailyHealthCheck').timeBased().everyDays(1).atHour(9).create();
  ScriptApp.newTrigger('weeklySummary').timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(9).create();
  console.log('Bot is running (version ' + BOT_VERSION + '). It handles emails that arrived after ' + new Date(start) + '.');
  console.log('Mode is ' + getSettings().MODE + '. In shadow mode it only logs; set MODE to "live" in the Control Panel to really send replies.');
}

/** (Re)creates the timer that runs processInbox every `minutes` minutes. */
function scheduleInboxCheck_(minutes) {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'processInbox') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('processInbox').timeBased().everyMinutes(minutes).create();
}

/** Turns the bot off completely (removes its triggers). */
function uninstallTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
}

/**
 * Testing only: forgets which emails were already handled AND moves the start
 * time back by `days` (default 1), so recent test emails get handled again.
 * Never run this on the real inbox in live mode: it would re-answer old emails.
 */
function resetBotMemory(days) {
  const props = PropertiesService.getScriptProperties();
  props.deleteProperty(STATE_KEY);
  const pieces = Number(props.getProperty(SEEN_KEY + '_COUNT')) || 0;
  for (let i = 0; i < pieces; i++) props.deleteProperty(SEEN_KEY + '_' + i);
  props.deleteProperty(SEEN_KEY + '_COUNT');
  props.setProperty(START_KEY, String(Date.now() - (Number(days) || 1) * 24 * 3600 * 1000));
}

function setSetting_(key, value) {
  const sheet = getControlPanel_().getSheetByName('Settings');
  const values = sheet.getDataRange().getValues();
  for (let i = 1; i < values.length; i++) {
    if (values[i][0] === key) { sheet.getRange(i + 1, 2).setValue(value); return; }
  }
  sheet.appendRow([key, value, '']);
}
