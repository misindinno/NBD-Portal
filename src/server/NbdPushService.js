// Pushes qualified LQ leads into the NBD portal spreadsheet.

function pushLeadToNbd(leadId, email) {
  assertServerContext_();
  const user = requireRole(['ADMIN', 'MANAGER', 'SALES']);
  const targetSpreadsheetId = String(CLIENT_CONFIG.NBD_TARGET_SPREADSHEET_ID || '').trim();
  if (!targetSpreadsheetId) return respond(null, 'NBD target spreadsheet is not configured for this portal.');

  const lead = getLead(leadId)?.lead;
  if (!lead) return respond(null, 'Lead not found.');
  if (!_canWriteLead(lead, user)) return respond(null, 'Permission denied.');
  safeInitHeaders(SHEET_NAMES.LEADS, LEAD_MASTER_FIELDS);

  const targetSheet = _nbdTargetSheet_(targetSpreadsheetId, SHEET_NAMES.LEADS);
  _ensureExternalHeaders_(targetSheet, LEAD_MASTER_FIELDS);
  const targetHeaders = targetSheet.getRange(1, 1, 1, targetSheet.getLastColumn()).getValues()[0].map(String);
  const existing = _findExternalLeadBySource_(targetSheet, targetHeaders, leadId);
  if (existing) {
    updateRow(SHEET_NAMES.LEADS, 'Lead ID', leadId, {
      'NBD Lead ID': existing['Lead ID'] || '',
      'Pushed To NBD At': lead['Pushed To NBD At'] || now(),
      'Updated At': now()
    });
    _bumpStamp('leads');
    return respond({ leadId, nbdLeadId: existing['Lead ID'] || '', alreadyPushed: true });
  }

  const nbdLeadId = generateUUID();
  const targetStageId = _nbdInitialStageId_(targetSpreadsheetId);
  const ts = now();
  const row = {
    ...pickLeadMasterFields_(lead),
    'Lead ID': nbdLeadId,
    'Stage ID': targetStageId || '',
    'Lead Status': 'Open',
    'Source Portal': CLIENT_CONFIG.APP_TITLE || 'LQ Portal',
    'Source Lead ID': leadId,
    'Remark': _nbdRemark_(lead),
    'Stage Updated At': ts,
    'Last Follow-up Date': '',
    'Next Follow-up Date': '',
    'NBD Lead ID': '',
    'Pushed To NBD At': '',
    'Created At': ts,
    'Updated At': ts
  };
  _appendExternalRow_(targetSheet, targetHeaders, row);

  updateRow(SHEET_NAMES.LEADS, 'Lead ID', leadId, {
    'NBD Lead ID': nbdLeadId,
    'Pushed To NBD At': ts,
    'Updated At': ts
  });
  insertLeadActivityLog_(leadId, 'Push To NBD', '', nbdLeadId, 'Lead pushed to NBD portal', user.id);
  _bumpStamp('leads');
  _bumpStamp('activity_logs');
  return respond({ leadId, nbdLeadId, alreadyPushed: false });
}

function _isLeadQualifiedForNbd_(lead) {
  const status = String(lead['Lead Status'] || '').trim().toLowerCase();
  if (['qualified', 'won'].includes(status)) return true;
  const stageId = lead['Stage ID'];
  const stage = queryRows(SHEET_NAMES.STAGES, r => r['Stage ID'] === stageId)[0];
  const stageName = String(stage && stage['Stage Name'] || '').trim().toLowerCase();
  return stageName.includes('qualified') || stageName.includes('won');
}

function _nbdRemark_(lead) {
  const parts = [];
  if (lead['Remark']) parts.push(String(lead['Remark']));
  parts.push('Pushed from ' + (CLIENT_CONFIG.APP_TITLE || 'LQ Portal') + ' lead ' + lead['Lead ID']);
  return parts.join('\n');
}

function _nbdTargetSheet_(spreadsheetId, sheetName) {
  const ss = SpreadsheetApp.openById(spreadsheetId);
  let sheet = ss.getSheetByName(sheetName);
  if (!sheet) sheet = ss.insertSheet(sheetName);
  return sheet;
}

function _ensureExternalHeaders_(sheet, requiredHeaders) {
  const lastCol = sheet.getLastColumn();
  if (lastCol === 0 || sheet.getRange(1, 1).getValue() === '') {
    sheet.getRange(1, 1, 1, requiredHeaders.length).setValues([requiredHeaders]);
    return;
  }
  const existing = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
  const missing = requiredHeaders.filter(h => !existing.includes(h));
  if (missing.length) sheet.getRange(1, lastCol + 1, 1, missing.length).setValues([missing]);
}

function _appendExternalRow_(sheet, headers, rowObj) {
  const row = headers.map(h => rowObj[h] !== undefined ? rowObj[h] : '');
  sheet.appendRow(row);
}

function _findExternalLeadBySource_(sheet, headers, sourceLeadId) {
  const sourceCol = headers.indexOf('Source Lead ID');
  if (sourceCol === -1 || sheet.getLastRow() < 2) return null;
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][sourceCol]) === String(sourceLeadId)) {
      return headers.reduce((obj, h, j) => { obj[h] = normalizeSheetValue(data[i][j]); return obj; }, {});
    }
  }
  return null;
}

function _nbdInitialStageId_(spreadsheetId) {
  const stagesSheet = _nbdTargetSheet_(spreadsheetId, SHEET_NAMES.STAGES);
  _ensureExternalHeaders_(stagesSheet, ['Stage ID','Stage Name','Stage Order','Color','Is Active','Is Final Stage','Is Initial Stage','TAT Days','Is Skippable','Created At']);
  if (stagesSheet.getLastRow() < 2) return '';
  const data = stagesSheet.getDataRange().getValues();
  const headers = data[0].map(String);
  const rows = data.slice(1).map(row => headers.reduce((obj, h, i) => { obj[h] = normalizeSheetValue(row[i]); return obj; }, {}));
  const activeRows = rows.filter(r => r['Is Active'] !== false && r['Is Active'] !== 'FALSE');
  const initial = activeRows.find(r => r['Is Initial Stage'] === true || r['Is Initial Stage'] === 'TRUE') || activeRows.sort((a, b) => Number(a['Stage Order'] || 0) - Number(b['Stage Order'] || 0))[0];
  return initial ? initial['Stage ID'] || '' : '';
}
