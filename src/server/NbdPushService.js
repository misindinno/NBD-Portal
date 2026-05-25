// Pushes qualified LQ leads into the NBD portal spreadsheet.

function pushLeadToNbd(leadId, email, nbdAssignedTo) {
  assertServerContext_();
  const user = requireRole(['ADMIN', 'MANAGER', 'SALES']);
  if (!_isLqPortalForNbdPush_()) return respond(null, 'Push to NBD is available only in the LQ portal.');
  const targetSpreadsheetId = String(CLIENT_CONFIG.NBD_TARGET_SPREADSHEET_ID || '').trim();
  if (!targetSpreadsheetId) return respond(null, 'NBD target spreadsheet is not configured for this portal.');
  const targetUser = _findNbdAssignableUser_(targetSpreadsheetId, nbdAssignedTo);
  if (!targetUser) return respond(null, 'Please select a valid NBD user to assign this lead.');

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
  const leadRemark = _nbdRemark_(lead, sourceStage, user, targetUser);
  const row = {
    ...pickLeadMasterFields_(lead),
    'Lead ID': nbdLeadId,
    'Stage ID': targetStageId || '',
    'Lead Status': 'Open',
    'Assigned To': targetUser.id,
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
  const nbdFollowupId = _createNbdInitialFollowup_(targetSpreadsheetId, nbdLeadId, lead, sourceStage, user, targetUser, followupDate, ts);

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

function getNbdAssignableUsers() {
  assertServerContext_();
  if (!_isLqPortalForNbdPush_()) return [];
  const targetSpreadsheetId = String(CLIENT_CONFIG.NBD_TARGET_SPREADSHEET_ID || '').trim();
  if (!targetSpreadsheetId) return [];
  return _nbdAssignableUsers_(targetSpreadsheetId);
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
  const name = String(stage['Stage Name'] || '').trim().toLowerCase();
  if (name === 'won' || name.includes('won')) return true;
  const isFinal = stage['Is Final Stage'] === true || stage['Is Final Stage'] === 'TRUE';
  const status = String(lead && lead['Lead Status'] || '').trim().toLowerCase();
  return isFinal && status === 'won' && !/lost|disqualified|reject|dead/.test(name);
}

function _nbdRemark_(lead, stage, user, targetUser) {
  const parts = [];
  const qualifiedRemark = _nbdQualifiedRemark_(lead);
  parts.push('Qualified/Won LQ lead pushed to NBD.');
  if (qualifiedRemark) parts.push('Qualified remark: ' + qualifiedRemark);
  if (lead['Client Description']) parts.push('LQ remark: ' + String(lead['Client Description']));
  if (stage && stage['Stage Name']) parts.push('Won stage: ' + String(stage['Stage Name']));
  parts.push('Source lead ID: ' + lead['Lead ID']);
  if (lead['Company Name']) parts.push('Company: ' + lead['Company Name']);
  if (lead['Contact Person']) parts.push('Contact: ' + lead['Contact Person']);
  if (lead['Phone']) parts.push('Phone: ' + lead['Phone']);
  if (targetUser && targetUser.name) parts.push('Assigned in NBD to: ' + targetUser.name);
  if (user && (user.name || user.email)) parts.push('Pushed by: ' + (user.name || user.email));
  return parts.join('\n');
}

function _nbdQualifiedRemark_(lead) {
  const keys = [
    'Qualified Remark',
    'Qualified Remarks',
    'Qualification Remark',
    'Qualification Remarks'
  ];
  for (let i = 0; i < keys.length; i++) {
    const value = String(lead[keys[i]] || '').trim();
    if (value) return value;
  }
  return '';
}

function _createNbdInitialFollowup_(spreadsheetId, nbdLeadId, sourceLead, sourceStage, user, targetUser, followupDate, ts) {
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
    'Discussion': _nbdFollowupRemark_(sourceLead, sourceStage, user, targetUser),
    'Outcome': 'Open',
    'Next Follow-up Date': followupDate,
    'Next Action': 'Review qualified LQ lead',
    'Status': 'Open',
    'Done Date': '',
    'Done By': '',
    'Updated Stage ID': '',
    'Created By': targetUser && targetUser.id || '',
    'Created At': ts,
    'Updated At': ts
  };
  _appendExternalRow_(followupSheet, headers, row);
  return followupId;
}

function _nbdFollowupRemark_(lead, stage, user, targetUser) {
  const lines = [
    'Initial NBD follow-up created from LQ won lead.',
    'Source Lead ID: ' + (lead['Lead ID'] || ''),
    'Won Stage: ' + (stage && stage['Stage Name'] || ''),
    'Company: ' + (lead['Company Name'] || ''),
    'Contact: ' + (lead['Contact Person'] || ''),
    'Phone: ' + (lead['Phone'] || ''),
    'Product Interest: ' + (lead['Product Interest'] || ''),
    'LQ Remark: ' + (lead['Client Description'] || ''),
    'Assigned In NBD To: ' + (targetUser && targetUser.name || ''),
    'Pushed By: ' + (user && (user.name || user.email) || '')
  ];
  return lines.filter(line => !/: $/.test(line)).join('\n');
}

function _findNbdAssignableUser_(spreadsheetId, userId) {
  const id = String(userId || '').trim();
  if (!id) return null;
  return _nbdAssignableUsers_(spreadsheetId).find(u => String(u.id) === id) || null;
}

function _nbdAssignableUsers_(spreadsheetId) {
  const ss = SpreadsheetApp.openById(spreadsheetId);
  const sheet = ss.getSheetByName(SHEET_NAMES.USERS);
  if (!sheet || sheet.getLastRow() < 2) return [];
  const data = sheet.getDataRange().getValues();
  const headers = data[0].map(String);
  return data.slice(1)
    .map(row => headers.reduce((obj, h, i) => { obj[h] = normalizeSheetValue(row[i]); return obj; }, {}))
    .filter(row => isActiveUserValue(row['Is Active']))
    .map(row => {
      const email = String(row['Email Address'] || '').trim().toLowerCase();
      const id = getStaffUserId(row, email);
      return {
        id,
        name: row['Name'] || email || id,
        email,
        department: row['Department'] || '',
        role: normalizeStaffPermission(row['Permission'] || row['Role'])
      };
    })
    .filter(user => user.id);
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
