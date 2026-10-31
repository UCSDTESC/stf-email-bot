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

/** Step 3: turns the bot on (checks the inbox every 5 minutes, plus a daily health check). */
function installTriggers() {
  uninstallTriggers();
  ScriptApp.newTrigger('processInbox').timeBased().everyMinutes(5).create();
  ScriptApp.newTrigger('dailyHealthCheck').timeBased().everyDays(1).atHour(9).create();
  console.log('Bot is running. It starts in shadow (test) mode; set MODE to "live" in the Control Panel to really send replies.');
}

/** Turns the bot off completely (removes its triggers). */
function uninstallTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
}

/** Forgets which emails were already handled (useful while testing). */
function resetBotMemory() {
  PropertiesService.getScriptProperties().deleteProperty(STATE_KEY);
}

function setSetting_(key, value) {
  const sheet = getControlPanel_().getSheetByName('Settings');
  const values = sheet.getDataRange().getValues();
  for (let i = 1; i < values.length; i++) {
    if (values[i][0] === key) { sheet.getRange(i + 1, 2).setValue(value); return; }
  }
  sheet.appendRow([key, value, '']);
}
