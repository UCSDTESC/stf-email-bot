/**
 * Weekly summary email (a trigger runs it every Monday morning).
 * Tells the team how many emails the bot handled, what it cost, and which
 * "needs decision" emails are still open.
 */

/** Pure function: builds the summary text from Control Panel rows. Unit-tested. */
function buildWeeklySummary(activityRows, needsDecisionRows, now) {
  const weekAgo = now.getTime() - 7 * 24 * 3600 * 1000;
  const recent = activityRows.filter(function (r) { return r[0] && new Date(r[0]).getTime() >= weekAgo; });
  const count = function (re) { return recent.filter(function (r) { return re.test(String(r[4])); }).length; };
  const answered = count(/answered$/);
  const decisions = count(/needs decision$/);
  const cost = recent.reduce(function (s, r) { return s + (Number(r[12]) || 0); }, 0);
  const open = needsDecisionRows.filter(function (r) { return r[0] && r[5] !== true; });
  const handled = answered + decisions ? Math.round((100 * answered) / (answered + decisions)) + '%' : 'n/a';
  const shadow = recent.some(function (r) { return /^\(shadow\)/.test(String(r[4])); });

  const lines = [
    'STF Bot: last 7 days' + (shadow ? ' (TEST MODE: nothing was really sent)' : ''),
    '',
    'Emails looked at: ' + recent.length,
    'Answered by the bot: ' + answered,
    'Sent to a person (needs decision): ' + decisions,
    'Not about STF (left in the inbox): ' + count(/^not stf$/),
    'Skipped / left for humans: ' + count(/^(skipped|left for humans)/),
    'Errors: ' + count(/^error/),
    'STF emails fully handled by the bot: ' + handled,
    'AI cost: $' + cost.toFixed(2),
    '',
    'Open "needs decision" emails: ' + open.length,
  ];
  open.slice(0, 20).forEach(function (r) { lines.push('- ' + r[1] + ': ' + r[2] + ' (' + r[4] + ')'); });
  if (open.length > 20) lines.push('- ...and ' + (open.length - 20) + ' more');
  lines.push('', 'Full details: the Control Panel (Activity Log and Needs Decision tabs).');
  return lines.join('\n');
}

function weeklySummary() {
  const settings = getSettings();
  const panel = getControlPanel_();
  if (!panel) return;
  const rowsOf = function (name) {
    const sheet = panel.getSheetByName(name);
    return sheet ? sheet.getDataRange().getValues().slice(1) : [];
  };
  const text = buildWeeklySummary(rowsOf('Activity Log'), rowsOf('Needs Decision'), new Date());
  MailApp.sendEmail(alertRecipients_(settings), '[STF Bot] Weekly summary', text + '\n' + panel.getUrl());
}
