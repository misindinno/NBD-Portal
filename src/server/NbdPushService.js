// Pushes qualified LQ leads into the NBD portal spreadsheet.

function pushLeadToNbd(leadId, email, nbdAssignedTo, mapToNbdLeadId, qualifiedRemark) {
  assertServerContext_();
  const user = requireRole(['ADMIN', 'MANAGER', 'SALES']);
  if (!_isLqPortalForNbdPush_()) return respond(null, 'Push to NBD is available only in the LQ portal.');
  const targetSpreadsheetId = String(CLIENT_CONFIG.NBD_TARGET_SPREADSHEET_ID || '').trim();
  if (!targetSpreadsheetId) return respond(null, 'NBD target spreadsheet is not configured for this portal.');

  const lead = getLead(leadId)?.lead;
  if (!lead) return respond(null, 'Lead not found.');
  if (!_canWriteLead(lead, user)) return respond(null, 'Permission denied.');

  // Map mode: link this LQ lead to an existing NBD lead instead of creating a new one.
  if (mapToNbdLeadId) {
    const ts = now();
    // Patch the LQ lead
    updateRow(SHEET_NAMES.LEADS, 'Lead ID', leadId, {
      'NBD Lead ID': mapToNbdLeadId,
      'Pushed To NBD At': ts,
      'Updated At': ts
    });
    _bumpStamp('leads');
    // Patch the NBD lead so it knows its LQ source
    try {
      const targetSheet  = _nbdTargetSheet_(targetSpreadsheetId, SHEET_NAMES.LEADS);
      const targetHeaders = _externalHeaders_(targetSpreadsheetId, SHEET_NAMES.LEADS);
      _updateExternalRow_(targetSheet, targetHeaders, 'Lead ID', mapToNbdLeadId, {
        'Source Lead ID': leadId,
        'Source Portal':  CLIENT_CONFIG.APP_TITLE || 'LQ Portal',
        'Updated At':     ts
      });
    } catch (e) {
      Logger.log('Map: could not patch NBD lead: ' + e.message);
    }
    insertLeadActivityLog_(leadId, 'Map To NBD', '', mapToNbdLeadId, 'LQ lead mapped to existing NBD lead ' + mapToNbdLeadId, user.id);
    return respond({ leadId, nbdLeadId: mapToNbdLeadId, mapped: true });
  }

  const targetUser = _findNbdAssignableUser_(targetSpreadsheetId, nbdAssignedTo);
  if (!targetUser) return respond(null, 'Please select a valid NBD user to assign this lead.');
  const sourceStage = _nbdSourceStage_(lead);
  if (!_isWonStageForNbd_(sourceStage, lead)) {
    return respond(null, 'Only LQ leads in a Won stage can be pushed to NBD.');
  }
  safeInitHeaders(SHEET_NAMES.LEADS, LEAD_MASTER_FIELDS);

  const targetSheet = _nbdTargetSheet_(targetSpreadsheetId, SHEET_NAMES.LEADS);
  _ensureExternalHeaders_(targetSheet, LEAD_MASTER_FIELDS);
  const targetHeaders = _externalHeaders_(targetSpreadsheetId, SHEET_NAMES.LEADS);
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
  const leadRemark = _nbdClientDescription_(lead, sourceStage);
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
  const nbdFollowupId = _createNbdInitialFollowup_(targetSpreadsheetId, nbdLeadId, lead, sourceStage, user, targetUser, followupDate, ts, qualifiedRemark);

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

function checkNbdDuplicates(leadId) {
  assertServerContext_();
  if (!_isLqPortalForNbdPush_()) return [];
  const targetSpreadsheetId = String(CLIENT_CONFIG.NBD_TARGET_SPREADSHEET_ID || '').trim();
  if (!targetSpreadsheetId) return [];
  const lead = getLead(leadId)?.lead;
  if (!lead) return [];

  const targetSheet = _nbdTargetSheet_(targetSpreadsheetId, SHEET_NAMES.LEADS);
  const data = _externalValues_(targetSpreadsheetId, SHEET_NAMES.LEADS, 'A:ZZ');
  if (data.length < 2) return [];
  const headers = data[0].map(String);

  const col = h => headers.indexOf(h);
  const phoneCol   = col('Phone');
  const altCol     = col('Alternate No');
  const emailCol   = col('Email');
  const companyCol = col('Company Name');
  const leadIdCol  = col('Lead ID');
  const contactCol = col('Contact Person');
  const stageIdCol = col('Stage ID');
  const srcLeadCol = col('Source Lead ID');

  const lqPhone   = _normalizePhone_(lead['Phone']);
  const lqAlt     = _normalizePhone_(lead['Alternate No']);
  const lqEmail   = String(lead['Email']        || '').trim().toLowerCase();
  const lqCompany = String(lead['Company Name'] || '').trim().toLowerCase();

  const matches = [];
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    // Skip if this NBD row is already the result of pushing this same LQ lead
    if (srcLeadCol !== -1 && String(row[srcLeadCol]) === String(leadId)) continue;

    const rPhone   = _normalizePhone_(String(row[phoneCol]   || ''));
    const rAlt     = _normalizePhone_(String(row[altCol]     || ''));
    const rEmail   = String(row[emailCol]   || '').trim().toLowerCase();
    const rCompany = String(row[companyCol] || '').trim().toLowerCase();

    const phoneMatch   = !!(lqPhone   && ((rPhone && lqPhone === rPhone) || (rAlt && lqPhone === rAlt)));
    const altMatch     = !!(lqAlt     && ((rPhone && lqAlt   === rPhone) || (rAlt && lqAlt   === rAlt)));
    const emailMatch   = !!(lqEmail   && rEmail   && lqEmail   === rEmail);
    const companyMatch = !!(lqCompany && rCompany && lqCompany === rCompany && lqCompany.length > 3);

    if (!phoneMatch && !altMatch && !emailMatch && !companyMatch) continue;

    const reasons = [
      (phoneMatch || altMatch) && 'Phone',
      emailMatch               && 'Email',
      companyMatch             && 'Company'
    ].filter(Boolean);

    // Look up stage name from NBD stages sheet
    const nbdStageId = stageIdCol !== -1 ? String(row[stageIdCol] || '') : '';
    matches.push({
      nbdLeadId: leadIdCol !== -1 ? String(row[leadIdCol] || '') : '',
      company:   companyCol !== -1 ? String(row[companyCol] || '') : '',
      contact:   contactCol !== -1 ? String(row[contactCol] || '') : '',
      phone:     phoneCol   !== -1 ? String(row[phoneCol]   || '') : '',
      email:     emailCol   !== -1 ? String(row[emailCol]   || '') : '',
      stageId:   nbdStageId,
      matchOn:   reasons.join(', ')
    });
  }
  return matches;
}

function _normalizePhone_(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : digits;
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

function _nbdClientDescription_(lead, stage) {
  return _nbdQualifiedRemark_(lead, stage) || String(lead['Client Description'] || '').trim();
}

function _nbdQualifiedRemark_(lead, stage) {
  const stageId = stage && stage['Stage ID'] || lead && lead['Stage ID'] || '';
  const fields = getLeadCustomFieldsForStage(stageId);
  const field = fields.find(f => _nbdFieldNameKey_(f['Field Name']) === 'qualifiedremarks');
  const keys = [];
  if (field && field['Column Key']) {
    keys.push(_leadEffectiveFieldKey_(field, stageId));
    keys.push(field['Column Key']);
  }
  keys.push(
    stageId ? 'CF_Qualified_Remarks__' + stageId : '',
    'CF_Qualified_Remarks',
    'Qualified Remarks',
    'Qualified Remark',
    'Qualification Remarks',
    'Qualification Remark',
    'Qualified_Remarks',
    'Qualified_Remark',
    'Qualification_Remarks',
    'Qualification_Remark'
  );
  for (let i = 0; i < keys.length; i++) {
    const value = String(lead[keys[i]] || '').trim();
    if (value) return value;
  }
  return '';
}

function _nbdFieldNameKey_(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function _createNbdInitialFollowup_(spreadsheetId, nbdLeadId, sourceLead, sourceStage, user, targetUser, followupDate, ts, qualifiedRemark) {
  const followupSheet = _nbdTargetSheet_(spreadsheetId, SHEET_NAMES.FOLLOWUPS);
  _ensureExternalHeaders_(followupSheet, FOLLOWUP_MASTER_FIELDS);
  const headers = _externalHeaders_(spreadsheetId, SHEET_NAMES.FOLLOWUPS);
  const followupId = generateUUID();
  const row = {
    'Follow-up ID': followupId,
    'Lead ID': nbdLeadId,
    'Planned Date': followupDate,
    'Follow-up Date': followupDate,
    'Follow-up Type': 'LQ Qualified Transfer',
    'Discussion': _nbdFollowupRemark_(sourceLead, sourceStage, user, targetUser, qualifiedRemark),
    'Outcome': 'Open',
    'Next Follow-up Date': followupDate,
    'Next Action': 'Review qualified LQ lead',
    'Status': 'Open',
    'Done Date': '',
    'Done By': '',
    'Stage ID': _nbdInitialStageId_(spreadsheetId) || '',
    'Updated Stage ID': '',
    'Created By': targetUser && targetUser.id || '',
    'Created At': ts,
    'Updated At': ts
  };
  _appendExternalRow_(followupSheet, headers, row);
  return followupId;
}

function _nbdFollowupRemark_(lead, stage, user, targetUser, qualifiedRemark) {
  return String(qualifiedRemark || '').trim()
    || _nbdQualifiedRemark_(lead, stage)
    || String(lead['Client Description'] || '').trim();
}

function _findNbdAssignableUser_(spreadsheetId, userId) {
  const id = String(userId || '').trim();
  if (!id) return null;
  return _nbdAssignableUsers_(spreadsheetId).find(u => String(u.id) === id) || null;
}

function _nbdAssignableUsers_(spreadsheetId) {
  return getUsersWithPortalAccess_('NBD')
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

function _externalValues_(spreadsheetId, sheetName, range) {
  return sheetApiGetValues_(sheetName, range || 'A:ZZ', spreadsheetId);
}

function _externalHeaders_(spreadsheetId, sheetName) {
  const values = _externalValues_(spreadsheetId, sheetName, '1:1');
  return values.length ? (values[0] || []).map(String).filter(Boolean) : [];
}

function _nbdTargetSheet_(spreadsheetId, sheetName) {
  const ss = SpreadsheetApp.openById(spreadsheetId);
  let sheet = ss.getSheetByName(sheetName);
  if (!sheet) sheet = ss.insertSheet(sheetName);
  return sheet;
}

function _ensureExternalHeaders_(sheet, requiredHeaders) {
  const spreadsheetId = sheet.getParent().getId();
  const sheetName = sheet.getName();
  const lastCol = sheet.getLastColumn();
  const existing = _externalHeaders_(spreadsheetId, sheetName);
  if (lastCol === 0 || !existing.length) {
    sheet.getRange(1, 1, 1, requiredHeaders.length).setValues([requiredHeaders]);
    return;
  }
  const missing = requiredHeaders.filter(h => !existing.includes(h));
  if (missing.length) {
    sheet.getRange(1, lastCol + 1, 1, missing.length).setValues([missing]);
  }
}

function _appendExternalRow_(sheet, headers, rowObj) {
  const row = headers.map(h => rowObj[h] !== undefined ? rowObj[h] : '');
  sheet.getRange(sheet.getLastRow() + 1, 1, 1, row.length).setValues([row]);
}

// Patches specific columns of a single row in an external sheet identified by keyCol=keyVal.
function _updateExternalRow_(sheet, headers, keyCol, keyVal, patch) {
  const keyIdx = headers.indexOf(keyCol);
  if (keyIdx === -1 || sheet.getLastRow() < 2) return false;
  const data = _externalValues_(sheet.getParent().getId(), sheet.getName(), 'A:ZZ');
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][keyIdx]) !== String(keyVal)) continue;
    const updatedRow = headers.map((h, colIdx) =>
      patch[h] !== undefined ? patch[h] : data[i][colIdx]
    );
    sheet.getRange(i + 1, 1, 1, headers.length).setValues([updatedRow]);
    return true;
  }
  return false;
}

function _findExternalLeadBySource_(sheet, headers, sourceLeadId) {
  const sourceCol = headers.indexOf('Source Lead ID');
  if (sourceCol === -1 || sheet.getLastRow() < 2) return null;
  const data = _externalValues_(sheet.getParent().getId(), sheet.getName(), 'A:ZZ');
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
  const data = _externalValues_(spreadsheetId, SHEET_NAMES.STAGES, 'A:ZZ');
  if (data.length < 2) return '';
  const headers = data[0].map(String);
  const rows = data.slice(1).map(row => headers.reduce((obj, h, i) => { obj[h] = normalizeSheetValue(row[i]); return obj; }, {}));
  const activeRows = rows.filter(r => r['Is Active'] !== false && r['Is Active'] !== 'FALSE');
  const initial = activeRows.find(r => r['Is Initial Stage'] === true || r['Is Initial Stage'] === 'TRUE') || activeRows.sort((a, b) => Number(a['Stage Order'] || 0) - Number(b['Stage Order'] || 0))[0];
  return initial ? initial['Stage ID'] || '' : '';
}
