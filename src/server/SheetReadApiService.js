// Fast read helpers backed by the Advanced Google Sheets service.
// Keep browser calls behind Api.js so auth and row scoping still apply.

function sheetApiBatchGetRows_(sheetNames) {
  assertServerContext_();
  if (typeof Sheets === 'undefined' || !Sheets.Spreadsheets || !Sheets.Spreadsheets.Values) {
    throw new Error('Google Sheets advanced service is not enabled.');
  }
  const names = (sheetNames || []).map(normalizeSheetName).filter(Boolean);
  if (!names.length) return {};

  const ranges = names.map(name => "'" + String(name).replace(/'/g, "''") + "'!A:ZZ");
  const result = Sheets.Spreadsheets.Values.batchGet(SPREADSHEET_ID, {
    ranges,
    valueRenderOption: 'FORMATTED_VALUE',
    dateTimeRenderOption: 'FORMATTED_STRING'
  });
  const valueRanges = result.valueRanges || [];
  return names.reduce((map, sheetName, i) => {
    map[sheetName] = _sheetApiValuesToRows_(valueRanges[i] && valueRanges[i].values);
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
    SHEET_NAMES.LEADS,
    SHEET_NAMES.FOLLOWUPS,
    SHEET_NAMES.FOLLOWUP_HISTORY,
    SHEET_NAMES.LEAD_ACTIVITY_LOGS
  ]);
  const leads = getRowsWithCustomFieldValues_('Leads', rows[SHEET_NAMES.LEADS] || []);
  const followups = getRowsWithCustomFieldValues_('Followups', rows[SHEET_NAMES.FOLLOWUPS] || [])
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
