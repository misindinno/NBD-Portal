// Pushes qualified LQ leads into the NBD portal spreadsheet.

function pushLeadToNbd(leadId, email, nbdAssignedTo, mapToNbdLeadId, qualifiedRemark) {
  assertServerContext_();
  const user = requireRoleForEmail_(['ADMIN', 'MANAGER', 'SALES']);
  if (!_isLqPortalForNbdPush_()) return respond(null, 'Push to NBD is available only in the LQ portal.');
  const targetSpreadsheetId = String(CLIENT_CONFIG.NBD_TARGET_SPREADSHEET_ID || '').trim();
  if (!targetSpreadsheetId) return respond(null, 'NBD target spreadsheet is not configured for this portal.');

  leadId = String(leadId || '').trim();
  mapToNbdLeadId = String(mapToNbdLeadId || '').trim();
  if (!leadId) return respond(null, 'Lead ID is required.');

  const lead = getLead(leadId)?.lead;
  if (!lead) return respond(null, 'Lead not found.');
  if (!_canWriteLead(lead, user)) return respond(null, 'Permission denied.');
  const sourceStage = _nbdSourceStage_(lead);
  if (!_isWonStageForNbd_(sourceStage, lead)) {
    return respond(null, 'Only LQ leads in a Won stage can be pushed to NBD.');
  }
  const linkedNbdLeadId = String(lead['NBD Lead ID'] || '').trim();
  if (linkedNbdLeadId && !mapToNbdLeadId) {
    return respond({ leadId, nbdLeadId: linkedNbdLeadId, alreadyPushed: true });
  }
  if (linkedNbdLeadId && mapToNbdLeadId && linkedNbdLeadId !== mapToNbdLeadId) {
    return respond(null, 'This LQ lead is already linked to NBD lead ' + linkedNbdLeadId + '.');
  }

  // Prepare target structure and validate dependencies before writing business rows.
  const targetSheet = _nbdTargetSheet_(targetSpreadsheetId, SHEET_NAMES.LEADS);
  _ensureExternalHeaders_(targetSheet, LEAD_MASTER_FIELDS);
  const targetHeaders = targetSheet.getRange(1, 1, 1, targetSheet.getLastColumn()).getValues()[0].map(String);
  if (!targetHeaders.includes('Lead ID') || !targetHeaders.includes('Source Lead ID')) {
    return respond(null, 'NBD lead sheet is missing required identity columns.');
  }

  let targetUser = null;
  let targetStageId = '';
  let followupSheet = null;
  let followupHeaders = null;
  if (!mapToNbdLeadId) {
    targetUser = _findNbdAssignableUser_(targetSpreadsheetId, nbdAssignedTo);
    if (!targetUser) return respond(null, 'Please select a valid NBD user to assign this lead.');
    targetStageId = _nbdInitialStageId_(targetSpreadsheetId);
    followupSheet = _nbdTargetSheet_(targetSpreadsheetId, SHEET_NAMES.FOLLOWUPS);
    _ensureExternalHeaders_(followupSheet, FOLLOWUP_MASTER_FIELDS);
    followupHeaders = followupSheet.getRange(1, 1, 1, followupSheet.getLastColumn()).getValues()[0].map(String);
    if (!followupHeaders.includes('Follow-up ID') || !followupHeaders.includes('Lead ID')) {
      return respond(null, 'NBD follow-up sheet is missing required identity columns.');
    }
  }

  const lock = LockService.getScriptLock();
  let locked = false;
  let operation = null;
  try {
    locked = lock.tryLock(10000);
    if (!locked) return respond(null, 'Another NBD push is in progress. Please retry in a few seconds.');

    // Re-read under the lock so stale or concurrent requests cannot create twice.
    if (typeof _invalidateReadCache_ === 'function') _invalidateReadCache_();
    const currentLead = getLead(leadId)?.lead;
    if (!currentLead) return respond(null, 'Lead not found.');
    if (!_canWriteLead(currentLead, user)) return respond(null, 'Permission denied.');
    const currentStage = _nbdSourceStage_(currentLead);
    if (!_isWonStageForNbd_(currentStage, currentLead)) {
      return respond(null, 'Only LQ leads in a Won stage can be pushed to NBD.');
    }

    const currentLink = String(currentLead['NBD Lead ID'] || '').trim();
    if (currentLink && !mapToNbdLeadId) {
      return respond({ leadId, nbdLeadId: currentLink, alreadyPushed: true });
    }
    if (currentLink && mapToNbdLeadId && currentLink !== mapToNbdLeadId) {
      return respond(null, 'This LQ lead is already linked to NBD lead ' + currentLink + '.');
    }

    // This lookup and any target insert are one atomic critical section.
    const existing = _findExternalLeadBySource_(targetSheet, targetHeaders, leadId);
    if (existing && existing['Lead ID']) {
      const existingId = String(existing['Lead ID']);
      if (!_updateNbdSourceLeadUnderLock_(leadId, existingId, currentLead['Pushed To NBD At'] || now())) {
        throw _nbdPushFailure_('The NBD record exists, but the source link could not be repaired. Please retry.', true);
      }
      operation = { kind: 'existing', nbdLeadId: existingId };
    } else if (mapToNbdLeadId) {
      operation = _mapLeadToNbdUnderLock_(
        targetSpreadsheetId,
        targetSheet,
        targetHeaders,
        leadId,
        mapToNbdLeadId
      );
    } else {
      const duplicates = _findNbdDuplicateLeads_(targetSpreadsheetId, currentLead, { skipSourceLeadId: leadId });
      if (duplicates.length) {
        return respond(null, 'Existing NBD lead found. Please use Map to this instead of creating a duplicate. Matched on: ' + duplicates.map(d => d.matchOn).join('; '));
      }
      operation = _createNbdLeadUnderLock_({
        targetSpreadsheetId,
        targetSheet,
        targetHeaders,
        followupSheet,
        followupHeaders,
        leadId,
        lead: currentLead,
        sourceStage: currentStage,
        user,
        targetUser,
        targetStageId,
        qualifiedRemark
      });
    }
  } catch (e) {
    Logger.log('[NBD Push] Transaction failed for source ' + leadId + ': ' + (e && e.message || e));
    return respond(null, e && e.nbdPublicMessage || 'NBD push could not be completed safely. Any partial target write was rolled back; please retry.');
  } finally {
    if (locked) lock.releaseLock();
  }

  // Audit logging and cache stamps are non-critical and use their own lock paths.
  try {
    if (operation.kind === 'mapped') {
      insertLeadActivityLog_(leadId, 'Map To NBD', '', operation.nbdLeadId, 'LQ lead mapped to existing NBD lead ' + operation.nbdLeadId, user.id);
    } else if (operation.kind === 'created') {
      insertLeadActivityLog_(leadId, 'Push To NBD', '', operation.nbdLeadId, 'Won lead pushed to NBD portal with follow-up ' + operation.nbdFollowupId, user.id);
    }
    _bumpStamp('leads');
    if (operation.kind !== 'existing') _bumpStamp('activity_logs');
  } catch (e) {
    Logger.log('[NBD Push] Non-critical audit/cache update failed for ' + leadId + ': ' + (e && e.message || e));
  }

  if (operation.kind === 'mapped') {
    return respond({ leadId, nbdLeadId: operation.nbdLeadId, mapped: true });
  }
  if (operation.kind === 'existing') {
    return respond({ leadId, nbdLeadId: operation.nbdLeadId, alreadyPushed: true });
  }
  return respond({
    leadId,
    nbdLeadId: operation.nbdLeadId,
    nbdFollowupId: operation.nbdFollowupId,
    alreadyPushed: false
  });
}

function _mapLeadToNbdUnderLock_(spreadsheetId, targetSheet, targetHeaders, leadId, mapToNbdLeadId) {
  const mapTarget = _findExternalLeadInSheet_(targetSheet, targetHeaders, 'Lead ID', mapToNbdLeadId);
  if (!mapTarget) throw _nbdPushFailure_('Selected NBD lead was not found. Refresh and try again.');
  const mappedSourceId = String(mapTarget['Source Lead ID'] || '').trim();
  if (mappedSourceId && mappedSourceId !== leadId) {
    throw _nbdPushFailure_('Selected NBD lead is already mapped to source lead ' + mappedSourceId + '.');
  }

  const previous = {
    'Source Lead ID': mapTarget['Source Lead ID'] || '',
    'Source Portal': mapTarget['Source Portal'] || '',
    'Updated At': mapTarget['Updated At'] || ''
  };
  const ts = now();
  try {
    const updated = _updateExternalRow_(targetSheet, targetHeaders, 'Lead ID', mapToNbdLeadId, {
      'Source Lead ID': leadId,
      'Source Portal': CLIENT_CONFIG.APP_TITLE || 'LQ Portal',
      'Updated At': ts
    });
    if (!updated) throw new Error('Target row update returned false.');
    if (!_updateNbdSourceLeadUnderLock_(leadId, mapToNbdLeadId, ts)) {
      throw new Error('Source row update returned false.');
    }
  } catch (e) {
    try {
      const restored = _updateExternalRow_(targetSheet, targetHeaders, 'Lead ID', mapToNbdLeadId, previous);
      const restoredRow = _findExternalLeadInSheet_(targetSheet, targetHeaders, 'Lead ID', mapToNbdLeadId);
      const rollbackVerified = restored && restoredRow
        && String(restoredRow['Source Lead ID'] || '') === String(previous['Source Lead ID'] || '')
        && String(restoredRow['Source Portal'] || '') === String(previous['Source Portal'] || '');
      if (!rollbackVerified) throw new Error('Target map rollback could not be verified.');
      _rebuildExternalLeadIndex_(spreadsheetId);
    } catch (rollbackError) {
      Logger.log('[NBD Push] Map rollback needs manual repair for ' + mapToNbdLeadId + ': ' + (rollbackError && rollbackError.message || rollbackError));
      throw _nbdPushFailure_('Mapping could not be completed and automatic rollback was uncertain. Retry to repair the source/target link.', true);
    }
    throw _nbdPushFailure_('Mapping could not be completed safely. Changes were rolled back; please retry.', true);
  }

  try {
    _rebuildExternalLeadIndex_(spreadsheetId);
  } catch (e) {
    Logger.log('[NBD Push] Deferred index rebuild for mapped lead ' + mapToNbdLeadId + ': ' + (e && e.message || e));
  }
  return { kind: 'mapped', nbdLeadId: mapToNbdLeadId };
}

function _createNbdLeadUnderLock_(ctx) {
  const nbdLeadId = generateUUID();
  const nbdFollowupId = generateUUID();
  const ts = now();
  const followupDate = today();
  const row = {
    ...pickLeadMasterFields_(ctx.lead),
    'Lead ID': nbdLeadId,
    'Stage ID': ctx.targetStageId || '',
    'Lead Status': 'Open',
    'Assigned To': ctx.targetUser.id,
    'Source Portal': CLIENT_CONFIG.APP_TITLE || 'LQ Portal',
    'Source Lead ID': ctx.leadId,
    'Client Description': _nbdClientDescription_(ctx.lead, ctx.sourceStage),
    'Stage Updated At': ts,
    'Last Follow-up Date': followupDate,
    'Next Follow-up Date': followupDate,
    'NBD Lead ID': '',
    'Pushed To NBD At': '',
    'Created At': ts,
    'Updated At': ts
  };
  const followup = {
    'Follow-up ID': nbdFollowupId,
    'Lead ID': nbdLeadId,
    'Planned Date': followupDate,
    'Follow-up Date': followupDate,
    'Follow-up Type': 'LQ Qualified Transfer',
    'Discussion': _nbdFollowupRemark_(ctx.lead, ctx.sourceStage, ctx.user, ctx.targetUser, ctx.qualifiedRemark),
    'Outcome': 'Open',
    'Next Follow-up Date': followupDate,
    'Next Action': 'Review qualified LQ lead',
    'Status': 'Open',
    'Done Date': '',
    'Done By': '',
    'Stage ID': ctx.targetStageId || '',
    'Updated Stage ID': '',
    'Created By': ctx.targetUser.id,
    'Created At': ts,
    'Updated At': ts
  };

  try {
    const targetRowNumber = _appendExternalRow_(ctx.targetSheet, ctx.targetHeaders, row);
    _upsertExternalLeadIndex_(ctx.targetSpreadsheetId, row, targetRowNumber);
    _appendExternalRow_(ctx.followupSheet, ctx.followupHeaders, followup);
    if (!_updateNbdSourceLeadUnderLock_(ctx.leadId, nbdLeadId, ts)) {
      throw new Error('Source row update returned false.');
    }
  } catch (e) {
    const followupClean = _deleteExternalRowByKey_(ctx.followupSheet, ctx.followupHeaders, 'Follow-up ID', nbdFollowupId);
    const targetClean = _deleteExternalRowByKey_(ctx.targetSheet, ctx.targetHeaders, 'Lead ID', nbdLeadId);
    let indexClean = true;
    try {
      _rebuildExternalLeadIndex_(ctx.targetSpreadsheetId);
    } catch (indexError) {
      indexClean = false;
      Logger.log('[NBD Push] Index rebuild after create rollback failed: ' + (indexError && indexError.message || indexError));
    }
    if (!followupClean || !targetClean || !indexClean) {
      throw _nbdPushFailure_('NBD push failed and automatic rollback was uncertain. Retry first; if it still fails, an administrator must reconcile the source and target records.', true);
    }
    throw _nbdPushFailure_('NBD push could not be completed. Partial target records were rolled back; please retry.', true);
  }
  return { kind: 'created', nbdLeadId, nbdFollowupId };
}

function _updateNbdSourceLeadUnderLock_(leadId, nbdLeadId, ts) {
  const sheet = getSheet(SHEET_NAMES.LEADS);
  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return false;
  const headers = data[0].map(String);
  const idCol = headers.indexOf('Lead ID');
  const nbdCol = headers.indexOf('NBD Lead ID');
  const pushedCol = headers.indexOf('Pushed To NBD At');
  const updatedCol = headers.indexOf('Updated At');
  if (idCol === -1 || nbdCol === -1 || pushedCol === -1 || updatedCol === -1) return false;

  for (let i = 1; i < data.length; i++) {
    if (String(data[i][idCol]) !== String(leadId)) continue;
    const row = data[i].slice();
    row[nbdCol] = nbdLeadId;
    row[pushedCol] = ts;
    row[updatedCol] = ts;
    try {
      sheet.getRange(i + 1, 1, 1, row.length).setValues([row]);
    } catch (e) {
      const committedId = String(sheet.getRange(i + 1, nbdCol + 1).getValue() || '');
      if (committedId !== String(nbdLeadId)) throw e;
    }
    if (typeof _invalidateReadCache_ === 'function') _invalidateReadCache_();
    try {
      const synced = headers.reduce((obj, h, col) => {
        obj[h] = normalizeSheetValue(row[col]);
        return obj;
      }, {});
      if (typeof syncIndexRow_ === 'function') syncIndexRow_(SHEET_NAMES.LEADS, synced, i + 1);
    } catch (e) {
      Logger.log('[NBD Push] Source index sync deferred for ' + leadId + ': ' + (e && e.message || e));
    }
    return true;
  }
  return false;
}

function _findExternalLeadInSheet_(sheet, headers, keyCol, keyVal) {
  const keyIdx = headers.indexOf(keyCol);
  if (keyIdx === -1 || sheet.getLastRow() < 2) return null;
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][keyIdx]) !== String(keyVal)) continue;
    return headers.reduce((obj, h, col) => {
      obj[h] = normalizeSheetValue(data[i][col]);
      return obj;
    }, {});
  }
  return null;
}

function _deleteExternalRowByKey_(sheet, headers, keyCol, keyVal) {
  try {
    const keyIdx = headers.indexOf(keyCol);
    if (keyIdx === -1) return false;
    if (sheet.getLastRow() < 2) return true;
    const values = sheet.getRange(2, keyIdx + 1, sheet.getLastRow() - 1, 1).getValues();
    for (let i = 0; i < values.length; i++) {
      if (String(values[i][0]) !== String(keyVal)) continue;
      sheet.deleteRow(i + 2);
      return true;
    }
    return true;
  } catch (e) {
    Logger.log('[NBD Push] Compensating delete failed for ' + keyCol + '=' + keyVal + ': ' + (e && e.message || e));
    return false;
  }
}

function _nbdPushFailure_(message, recoverable) {
  const error = new Error(message);
  error.nbdPublicMessage = message;
  error.recoverable = recoverable === true;
  return error;
}

function checkNbdDuplicates(leadId) {
  assertServerContext_();
  if (!_isLqPortalForNbdPush_()) return [];
  const targetSpreadsheetId = String(CLIENT_CONFIG.NBD_TARGET_SPREADSHEET_ID || '').trim();
  if (!targetSpreadsheetId) return [];
  const lead = getLead(leadId)?.lead;
  if (!lead) return [];

  return _findNbdDuplicateLeads_(targetSpreadsheetId, lead, { skipSourceLeadId: leadId });
}

function _findNbdDuplicateLeads_(targetSpreadsheetId, lead, options) {
  const indexRows = _nbdLeadIndexRows_(targetSpreadsheetId);
  const lqPhone   = _normalizePhone_(lead['Phone']);
  const lqAlt     = _normalizePhone_(lead['Alternate No']);
  const lqEmail   = String(lead['Email']        || '').trim().toLowerCase();
  const lqCompany = String(lead['Company Name'] || '').trim().toLowerCase();
  const skipSourceLeadId = String(options && options.skipSourceLeadId || '').trim();

  const matches = [];
  for (let i = 0; i < indexRows.length; i++) {
    const row = indexRows[i] || {};
    if (skipSourceLeadId && String(row['Source Lead ID'] || '') === skipSourceLeadId) continue;

    const rPhone   = _normalizePhone_(row['Phone']);
    const rAlt     = _normalizePhone_(row['Alternate No']);
    const rEmail   = String(row['Email'] || '').trim().toLowerCase();
    const rCompany = String(row['Company Name'] || '').trim().toLowerCase();

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

    matches.push({
      nbdLeadId: String(row['Lead ID'] || ''),
      company:   String(row['Company Name'] || ''),
      contact:   String(row['Contact Person'] || ''),
      phone:     String(row['Phone'] || ''),
      email:     String(row['Email'] || ''),
      stageId:   String(row['Stage ID'] || ''),
      matchOn:   reasons.join(', ')
    });
  }
  return matches;
}

function _findExternalLeadById_(spreadsheetId, leadId) {
  const id = String(leadId || '').trim();
  if (!id) return null;
  const indexed = _nbdLeadIndexRows_(spreadsheetId).find(row => String(row['Lead ID'] || '') === id);
  if (indexed) return indexed;
  const targetSheet = _nbdTargetSheet_(spreadsheetId, SHEET_NAMES.LEADS);
  if (targetSheet.getLastRow() < 2) return null;
  const data = targetSheet.getDataRange().getValues();
  const headers = data[0].map(String);
  const leadIdCol = headers.indexOf('Lead ID');
  if (leadIdCol === -1) return null;
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][leadIdCol] || '') !== id) continue;
    return headers.reduce((obj, h, j) => {
      obj[h] = normalizeSheetValue(data[i][j]);
      return obj;
    }, {});
  }
  return null;
}

function _nbdLeadIndexHeaders_() {
  return [
    'Lead ID','Phone','Alternate No','Email','Assigned To','Stage ID','Lead Status',
    'Next Follow-up Date','Company Name','Contact Person','City','State',
    'Source Portal','Source Lead ID','Updated At','Row Number'
  ];
}

function _nbdLeadIndexRows_(spreadsheetId) {
  const indexSheet = _nbdTargetSheet_(spreadsheetId, SHEET_NAMES.IDX_LEADS);
  const requiredHeaders = _nbdLeadIndexHeaders_();
  const existingHeaders = indexSheet.getLastColumn()
    ? indexSheet.getRange(1, 1, 1, indexSheet.getLastColumn()).getValues()[0].map(String)
    : [];
  const needsRebuild = requiredHeaders.some(h => !existingHeaders.includes(h));
  _ensureExternalHeaders_(indexSheet, requiredHeaders);
  if (indexSheet.getLastRow() < 2 || needsRebuild) _rebuildExternalLeadIndex_(spreadsheetId);
  const data = indexSheet.getDataRange().getValues();
  if (data.length < 2) return _externalLeadRowsForIndex_(spreadsheetId);
  const headers = data[0].map(String);
  return data.slice(1)
    .filter(row => row.some(v => String(v || '').trim()))
    .map(row => headers.reduce((obj, h, i) => {
      obj[h] = normalizeSheetValue(row[i]);
      return obj;
    }, {}));
}

function _rebuildExternalLeadIndex_(spreadsheetId) {
  const indexSheet = _nbdTargetSheet_(spreadsheetId, SHEET_NAMES.IDX_LEADS);
  const headers = _nbdLeadIndexHeaders_();
  indexSheet.clearContents();
  indexSheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  const rows = _externalLeadRowsForIndex_(spreadsheetId).map(row => headers.map(h => row[h] !== undefined ? row[h] : ''));
  if (rows.length) indexSheet.getRange(2, 1, rows.length, headers.length).setValues(rows);
  return rows.length;
}

function _externalLeadRowsForIndex_(spreadsheetId) {
  const leadSheet = _nbdTargetSheet_(spreadsheetId, SHEET_NAMES.LEADS);
  if (leadSheet.getLastRow() < 2) return [];
  const data = leadSheet.getDataRange().getValues();
  const headers = data[0].map(String);
  return data.slice(1)
    .filter(row => row.some(v => String(v || '').trim()))
    .map((values, i) => {
      const row = headers.reduce((obj, h, j) => {
        obj[h] = normalizeSheetValue(values[j]);
        return obj;
      }, {});
      return _externalLeadIndexRow_(row, i + 2);
    });
}

function _externalLeadIndexRow_(row, rowNumber) {
  return {
    'Lead ID': row['Lead ID'] || '',
    'Phone': _normalizePhone_(row['Phone']),
    'Alternate No': _normalizePhone_(row['Alternate No']),
    'Email': String(row['Email'] || '').trim().toLowerCase(),
    'Assigned To': row['Assigned To'] || '',
    'Stage ID': row['Stage ID'] || '',
    'Lead Status': row['Lead Status'] || '',
    'Next Follow-up Date': row['Next Follow-up Date'] || '',
    'Company Name': toProperCase_(row['Company Name'] || ''),
    'Contact Person': toProperCase_(row['Contact Person'] || ''),
    'City': row['City'] || '',
    'State': row['State'] || '',
    'Source Portal': row['Source Portal'] || '',
    'Source Lead ID': row['Source Lead ID'] || '',
    'Updated At': row['Updated At'] || '',
    'Row Number': rowNumber || ''
  };
}

function _upsertExternalLeadIndex_(spreadsheetId, leadRow, rowNumber) {
  const indexSheet = _nbdTargetSheet_(spreadsheetId, SHEET_NAMES.IDX_LEADS);
  const headers = _nbdLeadIndexHeaders_();
  _ensureExternalHeaders_(indexSheet, headers);
  const indexRow = _externalLeadIndexRow_(leadRow, rowNumber);
  const leadId = String(indexRow['Lead ID'] || '');
  if (!leadId) return;
  const data = indexSheet.getDataRange().getValues();
  const currentHeaders = data.length ? data[0].map(String) : headers;
  const idCol = currentHeaders.indexOf('Lead ID');
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][idCol] || '') !== leadId) continue;
    currentHeaders.forEach((h, col) => {
      if (indexRow[h] !== undefined) indexSheet.getRange(i + 1, col + 1).setValue(indexRow[h]);
    });
    return;
  }
  indexSheet.getRange(indexSheet.getLastRow() + 1, 1, 1, currentHeaders.length)
    .setValues([currentHeaders.map(h => indexRow[h] !== undefined ? indexRow[h] : '')]);
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

function getNbdPushContext(leadId) {
  assertServerContext_();
  if (!_isLqPortalForNbdPush_()) return { duplicates: [], users: [] };
  const targetSpreadsheetId = String(CLIENT_CONFIG.NBD_TARGET_SPREADSHEET_ID || '').trim();
  if (!targetSpreadsheetId) return { duplicates: [], users: [] };
  const lead = getLead(leadId)?.lead;
  if (!lead) throw new Error('Lead not found.');
  return {
    duplicates: _findNbdDuplicateLeads_(targetSpreadsheetId, lead, { skipSourceLeadId: leadId }),
    users: _nbdAssignableUsers_(targetSpreadsheetId)
  };
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
  const headers = followupSheet.getRange(1, 1, 1, followupSheet.getLastColumn()).getValues()[0].map(String);
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

function _nbdTargetSheet_(spreadsheetId, sheetName) {
  const ss = SpreadsheetApp.openById(spreadsheetId);
  let sheet = ss.getSheetByName(sheetName);
  if (!sheet) sheet = ss.insertSheet(sheetName);
  return sheet;
}

function _ensureExternalHeaders_(sheet, requiredHeaders) {
  requiredHeaders = Array.isArray(requiredHeaders) ? requiredHeaders.filter(Boolean) : [];
  if (!requiredHeaders.length) {
    Logger.log('[NBD] External header init skipped empty header list for ' + sheet.getName());
    return;
  }
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
  headers = Array.isArray(headers) ? headers.filter(Boolean) : [];
  if (!headers.length) throw new Error('Cannot append external row: sheet "' + sheet.getName() + '" has no headers.');
  const row = sanitizeSheetRowValues_(headers.map(h => rowObj[h] !== undefined ? rowObj[h] : ''));
  const rowNumber = sheet.getLastRow() + 1;
  if (rowNumber < 2) throw new Error('Cannot append external row: invalid row number ' + rowNumber + ' for ' + sheet.getName());
  sheet.getRange(rowNumber, 1, 1, row.length).setValues([row]);
  return rowNumber;
}

// Patches specific columns of a single row in an external sheet identified by keyCol=keyVal.
function _updateExternalRow_(sheet, headers, keyCol, keyVal, patch) {
  const keyIdx = headers.indexOf(keyCol);
  if (keyIdx === -1 || sheet.getLastRow() < 2) return false;
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][keyIdx]) !== String(keyVal)) continue;
    Object.keys(patch).forEach(h => {
      const colIdx = headers.indexOf(h);
      if (colIdx !== -1) sheet.getRange(i + 1, colIdx + 1).setValue(neutralizeSheetFormula_(patch[h]));
    });
    return true;
  }
  return false;
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
