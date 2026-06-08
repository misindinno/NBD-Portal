// Fast read helpers backed by the Advanced Google Sheets service.
// Keep browser calls behind Api.js so auth and row scoping still apply.

function sheetApiBatchGetRows_(sheetNames) {
  assertServerContext_();
  if (typeof Sheets === 'undefined' || !Sheets.Spreadsheets || !Sheets.Spreadsheets.Values) {
    throw new Error('Google Sheets advanced service is not enabled.');
  }
  const specs = (sheetNames || [])
    .map(item => {
      if (typeof item === 'object') {
        return {
          sheetName: normalizeSheetName(item.sheetName || item.name || ''),
          range: String(item.range || 'A:ZZ')
        };
      }
      return { sheetName: normalizeSheetName(item), range: 'A:ZZ' };
    })
    .filter(spec => spec.sheetName);
  if (!specs.length) return {};

  const ranges = specs.map(spec => "'" + String(spec.sheetName).replace(/'/g, "''") + "'!" + spec.range);
  const result = Sheets.Spreadsheets.Values.batchGet(SPREADSHEET_ID, {
    ranges,
    valueRenderOption: 'FORMATTED_VALUE',
    dateTimeRenderOption: 'FORMATTED_STRING'
  });
  const valueRanges = result.valueRanges || [];
  return specs.reduce((map, spec, i) => {
    map[spec.sheetName] = _sheetApiValuesToRows_(valueRanges[i] && valueRanges[i].values);
    return map;
  }, {});
}

function _sheetApiValuesToRows_(values) {
  const data = values || [];
  if (data.length < 2) return [];
  const headers = (data[0] || []).map(String);
  return data.slice(1)
    .filter(row => (row || []).some(v => String(v || '').trim() !== ''))
    .map(row => headers.reduce((obj, header, i) => {
      if (header) obj[header] = row[i] !== undefined ? row[i] : '';
      return obj;
    }, {}));
}

function getTodayActivitySnapshotFast_(user) {
  const rows = sheetApiBatchGetRows_([
    { sheetName: SHEET_NAMES.LEADS, range: 'A:AC' },
    { sheetName: SHEET_NAMES.FOLLOWUPS, range: 'A:Q' },
    { sheetName: SHEET_NAMES.FOLLOWUP_HISTORY, range: 'A:O' },
    { sheetName: SHEET_NAMES.LEAD_ACTIVITY_LOGS, range: 'A:H' }
  ]);
  const leads = rows[SHEET_NAMES.LEADS] || [];
  const followups = (rows[SHEET_NAMES.FOLLOWUPS] || [])
    .filter(_isFollowupTaskRow)
    .map(_normalizeFollowupRow);
  const followupHistory = (rows[SHEET_NAMES.FOLLOWUP_HISTORY] || []).filter(_isFollowupHistoryRow);
  const activityLogs = rows[SHEET_NAMES.LEAD_ACTIVITY_LOGS] || [];

  return {
    leads: _scopeAssignedRows(leads, user),
    followups: _scopeFollowupRows(followups, user),
    followupHistory: _scopeFollowupHistoryRows(followupHistory, user),
    activityLogs: _scopeActivityLogRows(activityLogs, user),
    source: 'sheets-api',
    fetchedAt: now()
  };
}
