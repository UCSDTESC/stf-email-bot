/**
 * "What's my application status?" lookups.
 *
 * The CODE (not the AI) finds the sender's own rows in the STF application
 * responses Sheet and passes ONLY those rows' basic fields to the AI.
 * The AI never sees anyone else's data, so a tricky email can't leak it.
 */

/** Finds the column number whose header matches `wanted` (or contains `fallbackWord`). */
function findColumn_(headerRow, wanted, fallbackWord) {
  const lower = headerRow.map(function (h) { return String(h).trim().toLowerCase(); });
  let i = lower.indexOf(String(wanted).trim().toLowerCase());
  if (i === -1 && fallbackWord) i = lower.findIndex(function (h) { return h.indexOf(fallbackWord) !== -1; });
  return i;
}

/**
 * Pure function: the sender's applications, newest first, as
 * [{ submitted (ms or 0), event, status }]. Returns null if the email column is missing.
 */
function findApplications(values, email, emailColumnName, statusColumnName) {
  if (!values || values.length < 2) return [];
  const header = values[0];
  const emailCol = findColumn_(header, emailColumnName, 'email');
  const statusCol = findColumn_(header, statusColumnName, 'status');
  const timeCol = findColumn_(header, 'Timestamp', 'timestamp');
  const eventCol = findColumn_(header, 'Name of conference or competition', 'conference');
  if (emailCol === -1) return null;

  const target = String(email).trim().toLowerCase();
  return values.slice(1)
    .filter(function (r) { return String(r[emailCol]).trim().toLowerCase() === target; })
    .map(function (r) {
      const t = timeCol !== -1 && r[timeCol] ? new Date(r[timeCol]).getTime() : 0;
      return {
        submitted: isFinite(t) ? t : 0,
        event: eventCol !== -1 && r[eventCol] ? String(r[eventCol]).slice(0, 120) : 'not listed',
        status: statusCol !== -1 && String(r[statusCol]).trim() ? String(r[statusCol]).trim().slice(0, 60) : 'Under review (no decision recorded yet)',
      };
    })
    .sort(function (a, b) { return b.submitted - a.submitted; });
}

/**
 * Pure function: given all Sheet values (first row = headers), returns a short
 * text summary of `email`'s applications, newest first. Unit-tested.
 */
function summarizeApplications(values, email, emailColumnName, statusColumnName) {
  const apps = findApplications(values, email, emailColumnName, statusColumnName);
  if (apps === null) return 'Status lookup is not available right now (email column not found). Treat as needs_decision.';
  if (!apps.length) return 'No application was found for this email address.';
  const lines = apps.slice(0, 3).map(function (a, n) {
    const submitted = a.submitted ? new Date(a.submitted).toDateString() : 'unknown date';
    return (n + 1) + '. Submitted ' + submitted + '. Event: ' + a.event + '. Status: ' + a.status + '.';
  });
  return 'Applications found for the sender (newest first):\n' + lines.join('\n');
}

/** Looks up the sender in the applications Sheet (if one is connected in Settings). */
function lookupApplication(settings, email) {
  if (!settings.APPLICATIONS_SHEET_ID) {
    return 'Status lookup is not connected yet. If the sender asks about their application status, use needs_decision.';
  }
  const values = SpreadsheetApp.openById(settings.APPLICATIONS_SHEET_ID).getSheets()[0].getDataRange().getValues();
  return summarizeApplications(values, email, settings.APPLICATIONS_EMAIL_COLUMN, settings.APPLICATIONS_STATUS_COLUMN);
}
