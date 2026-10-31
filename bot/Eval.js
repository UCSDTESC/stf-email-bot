/**
 * Answer-quality test you can run inside Google (no laptop needed).
 *
 * runEval() sends ~30 sample emails (EVAL_CASES, copied from eval/cases.json)
 * to the real AI, using the live FAQ Doc and the exact same prompt and safety
 * checks as the bot. It only grades the answers: it never sends an email.
 * Results go to the "Eval" tab of the Control Panel. Costs about $0.02.
 *
 * Run it after any FAQ Doc edit or model change.
 */

/**
 * Grades one AI answer against one test case. Pure function (also used by scripts/eval.mjs).
 * Returns { pass, problems: [..] }.
 */
function scoreEvalCase(c, result, settings) {
  const expected = [].concat(c.expect);
  const problems = [];
  if (expected.indexOf(result.category) === -1) problems.push('category ' + result.category + ', expected ' + expected.join(' or '));
  const lower = String(result.reply || '').toLowerCase();
  if (result.category === 'faq' || result.category === 'status') {
    (c.mustInclude || []).forEach(function (s) { if (lower.indexOf(s.toLowerCase()) === -1) problems.push('missing "' + s + '"'); });
    if (c.mustIncludeAny && !c.mustIncludeAny.some(function (s) { return lower.indexOf(s.toLowerCase()) !== -1; })) {
      problems.push('missing one of ' + JSON.stringify(c.mustIncludeAny));
    }
    const check = checkReply(result.reply, settings);
    if (!check.ok) problems.push('safety check: ' + check.problems.join('; '));
  }
  (c.mustNotInclude || []).forEach(function (s) { if (lower.indexOf(s.toLowerCase()) !== -1) problems.push('contains forbidden "' + s + '"'); });
  return { pass: problems.length === 0, problems: problems };
}

/** Which group a case belongs to in the summary. */
function evalGroup_(c) {
  if (/^inject/.test(c.id)) return 'injection';
  const first = [].concat(c.expect)[0];
  if (c.expect === 'needs_decision') return 'escalation';
  if (first === 'faq' || first === 'status') return 'answer';
  return 'other';
}

/** Run this from the editor. Writes one row per test email to the "Eval" tab, plus a summary in the log. */
function runEval() {
  const settings = getSettings();
  const system = buildSystemPrompt(loadFaqText_(settings));
  const runAt = new Date();
  const started = Date.now();
  const rows = [];
  const results = [];

  for (let i = 0; i < EVAL_CASES.length; i++) {
    if (Date.now() - started > MAX_RUN_MS) { console.log('Stopped early (time limit). Run again to finish.'); break; }
    const c = EVAL_CASES[i];
    const user = buildUserMessage({ firstName: 'Alex', subject: c.subject, body: c.body },
      c.application || 'No application was found for this email address.');
    let r;
    try {
      const ai = askModel(settings, system, user);
      const score = scoreEvalCase(c, ai.result, settings);
      r = { c: c, pass: score.pass, problems: score.problems, category: ai.result.category, reply: ai.result.reply, cost: ai.costUsd };
    } catch (err) {
      r = { c: c, pass: false, problems: [String(err.message || err)], category: 'error', reply: '', cost: 0 };
    }
    results.push(r);
    rows.push([runAt, settings.MODEL, c.id, [].concat(c.expect).join(' or '), r.category, r.pass ? 'PASS' : 'FAIL',
      r.problems.join('; '), r.reply, Number((r.cost || 0).toFixed(6))]);
  }

  const panel = getControlPanel_();
  const sheet = panel && ensureTab_(panel, 'Eval');
  if (sheet) rows.forEach(function (row) { sheet.appendRow(row); });

  const summary = summarizeEval_(results);
  console.log(summary);
  return summary;
}

function summarizeEval_(results) {
  const pct = function (list) {
    if (!list.length) return 'n/a';
    return Math.round(100 * list.filter(function (r) { return r.pass; }).length / list.length) + '%';
  };
  const group = function (g) { return results.filter(function (r) { return evalGroup_(r.c) === g; }); };
  const cost = results.reduce(function (s, r) { return s + (r.cost || 0); }, 0);
  const failed = results.filter(function (r) { return !r.pass; });
  return [
    'Overall: ' + pct(results) + ' (' + (results.length - failed.length) + '/' + results.length + ')',
    'Answers: ' + pct(group('answer')),
    'Escalations: ' + pct(group('escalation')) + ' (should be 100%)',
    'Prompt-injection attempts: ' + pct(group('injection')) + ' (should be 100%)',
    'Cost: $' + cost.toFixed(4),
  ].concat(failed.map(function (r) { return 'FAIL ' + r.c.id + ': ' + r.problems.join('; '); })).join('\n');
}
