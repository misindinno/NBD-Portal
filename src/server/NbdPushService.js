// Pushes qualified LQ leads into the NBD portal spreadsheet.

function pushLeadToNbd(leadId, email) {
  assertServerContext_();
  const user = requireRole(['ADMIN', 'MANAGER', 'SALES']);
  if (!_isLqPortalForNbdPush_()) return respond(null, 'Push to NBD is available only in the LQ portal.');
  const targetSpreadsheetId = String(CLIENT_CONFIG.NBD_TARGET_SPREADSHEET_ID || '').trim();
  if (!targetSpreadsheetId) return respond(null, 'NBD target spreadsheet is not configured for this portal.');

  const lead = getLead(leadId)?.lead;
  if (!lead) return respond(null, 'Lead not found.');
  if (!_canWriteLead(lead, user)) return respond(null, 'Permission denied.');
  const sourceStage = _nbdSourceStage_(lead);
  if (!_isWonStageForNbd_(sourceStage, lead)) {
    return respond(null, 'Only LQ leads in a Won stage can be pushed to NBD.');
  }
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
  const followupDate = today();
  const leadRemark = _nbdRemark_(lead, sourceStage, user);
  const row = {
    ...pickLeadMasterFields_(lead),
    'Lead ID': nbdLeadId,
    'Stage ID': targetStageId || '',
    'Lead Status': 'Open',
    'Source Portal': CLIENT_CONFIG.APP_TITLE || 'LQ Portal',
    'Source Lead ID': leadId,
    'Client Description': leadRemark,
    'Stage Updated At': ts,
    'Last Follow-up Date': followupDate,
    'Next Follow-up Date': followupDate,
    'NBD Lead ID': '',
    'Pushed To NBD At': '',
    'Created At': ts,
    'Updated At': ts
  };
  _appendExternalRow_(targetSheet, targetHeaders, row);
  const nbdFollowupId = _createNbdInitialFollowup_(targetSpreadsheetId, nbdLeadId, lead, sourceStage, user, followupDate, ts);

  updateRow(SHEET_NAMES.LEADS, 'Lead ID', leadId, {
    'NBD Lead ID': nbdLeadId,
    'Pushed To NBD At': ts,
    'Updated At': ts
  });
  insertLeadActivityLog_(leadId, 'Push To NBD', '', nbdLeadId, 'Won lead pushed to NBD portal with follow-up ' + nbdFollowupId, user.id);
  _bumpStamp('leads');
  _bumpStamp('activity_logs');
  return respond({ leadId, nbdLeadId, nbdFollowupId, alreadyPushed: false });
}

function _isLeadQualifiedForNbd_(lead) {
  return _isWonStageForNbd_(_nbdSourceStage_(lead), lead);
}

function _isLqPortalForNbdPush_() {
  return String(CLIENT_CONFIG.APP_TITLE || '').trim().toLowerCase().indexOf('lq') !== -1;
}

function _nbdSourceStage_(lead) {
  const stageId = lead && lead['Stage ID'];
  if (!stageId) return null;
  return queryRows(SHEET_NAMES.STAGES, r => String(r['Stage ID']) === String(stageId))[0] || null;
}

function _isWonStageForNbd_(stage, lead) {
  if (!stage) return false;
  const outcome = String(stage['Stage Outcome'] || '').trim().toLowerCase();
  if (outcome === 'won') return true;
  const effectiveStatus = String(_leadStatusForStage(stage) || lead && lead['Lead Status'] || '').trim().toLowerCase();
  if (effectiveStatus !== 'won') return false;
  const name = String(stage['Stage Name'] || '').trim().toLowerCase();
  return !/lost|disqualified|reject|dead/.test(name);
}

function _nbdRemark_(lead, stage, user) {
  const parts = [];
  parts.push('Qualified/Won LQ lead pushed to NBD.');
  if (lead['Client Description']) parts.push('LQ remark: ' + String(lead['Client Description']));
  if (stage && stage['Stage Name']) parts.push('Won stage: ' + String(stage['Stage Name']));
  parts.push('Source lead ID: ' + lead['Lead ID']);
  if (lead['Company Name']) parts.push('Company: ' + lead['Company Name']);
  if (lead['Contact Person']) parts.push('Contact: ' + lead['Contact Person']);
  if (lead['Phone']) parts.push('Phone: ' + lead['Phone']);
  if (user && (user.name || user.email)) parts.push('Pushed by: ' + (user.name || user.email));
  return parts.join('\n');
}

function _createNbdInitialFollowup_(spreadsheetId, nbdLeadId, sourceLead, sourceStage, user, followupDate, ts) {
  const followupSheet = _nbdTargetSheet_(spreadsheetId, SHEET_NAMES.FOLLOWUPS);
  _ensureExternalHeaders_(followupSheet, FOLLOWUP_MASTER_FIELDS);
  const headers = followupSheet.getRange(1, 1, 1, followupSheet.getLastColumn()).getValues()[0].map(String);
  const followupId = generateUUID();
  const row = {
    'Follow-up ID': followupId,
    'Lead ID': nbdLeadId,
    'Planned Date': followupDate,
    'Follow-up Date': followupDate,
    'Follow-up Type': 'LQ Qualified Transfer',
    'Discussion': _nbdFollowupRemark_(sourceLead, sourceStage, user),
    'Outcome': 'Open',
    'Next Follow-up Date': followupDate,
    'Next Action': 'Review qualified LQ lead',
    'Status': 'Open',
    'Done Date': '',
    'Done By': '',
    'Updated Stage ID': '',
    'Created By': user && (user.id || user.email) || '',
    'Created At': ts,
    'Updated At': ts
  };
  _appendExternalRow_(followupSheet, headers, row);
  return followupId;
}

function _nbdFollowupRemark_(lead, stage, user) {
  const lines = [
    'Initial NBD follow-up created from LQ won lead.',
    'Source Lead ID: ' + (lead['Lead ID'] || ''),
    'Won Stage: ' + (stage && stage['Stage Name'] || ''),
    'Company: ' + (lead['Company Name'] || ''),
    'Contact: ' + (lead['Contact Person'] || ''),
    'Phone: ' + (lead['Phone'] || ''),
    'Product Interest: ' + (lead['Product Interest'] || ''),
    'LQ Remark: ' + (lead['Client Description'] || ''),
    'Pushed By: ' + (user && (user.name || user.email) || '')
  ];
  return lines.filter(line => !/: $/.test(line)).join('\n');
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
  sheet.getRange(sheet.getLastRow() + 1, 1, 1, row.length).setValues([row]);
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
  _ensureExternalHeaders_(stagesSheet, ['Stage ID','Stage Name','Stage Order','Color','Is Active','Is Final Stage','Is Initial Stage','TAT Days','Is Skippable','Stage Outcome','Created At']);
  if (stagesSheet.getLastRow() < 2) return '';
  const data = stagesSheet.getDataRange().getValues();
  const headers = data[0].map(String);
  const rows = data.slice(1).map(row => headers.reduce((obj, h, i) => { obj[h] = normalizeSheetValue(row[i]); return obj; }, {}));
  const activeRows = rows.filter(r => r['Is Active'] !== false && r['Is Active'] !== 'FALSE');
  const initial = activeRows.find(r => r['Is Initial Stage'] === true || r['Is Initial Stage'] === 'TRUE') || activeRows.sort((a, b) => Number(a['Stage Order'] || 0) - Number(b['Stage Order'] || 0))[0];
  return initial ? initial['Stage ID'] || '' : '';
}
