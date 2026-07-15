// ─── LeadService.js ──────────────────────────────────────────────────────────

let CUSTOM_FIELD_UPLOAD_FOLDER_CACHE = null;

function getLeads() {
  const rows = isAggregatePortal()
    ? getAggregatedRows(SHEET_NAMES.LEADS)
    : getRowsWithCustomFieldValues_('Leads', getAllRows(SHEET_NAMES.LEADS));
  return rows.filter(row => !_isArchivedLead_(row));
}

// Lightweight read for the Stage Fields form: the lead merged with its custom-field
// values only (no follow-ups / history / activity logs), so lead selection stays snappy.
function getLeadCustomValues(leadId) {
  const baseLead = getRowByIndexedId_(SHEET_NAMES.LEADS, 'Lead ID', leadId);
  return baseLead ? getRowsWithCustomFieldValues_('Leads', [baseLead])[0] : null;
}

function getLead(leadId) {
  // Defensive: any sub-call that throws "starting row of the range is too small"
  // (caused by a stale index pointing at a row that no longer exists, or a
  // freshly-created sheet) is recovered by rebuilding the leads index once and
  // retrying with a full-scan fallback.
  const _loadBase = () => {
    const baseLead = getRowByIndexedId_(SHEET_NAMES.LEADS, 'Lead ID', leadId);
    return baseLead ? getRowsWithCustomFieldValues_('Leads', [baseLead])[0] : null;
  };
  let lead = null;
  try {
    lead = _loadBase();
  } catch (e) {
    const msg = String(e && e.message || e);
    Logger.log('[getLead] base read failed for ' + leadId + ': ' + msg + (e && e.stack ? '\n' + e.stack : ''));
    if (/starting row|range/i.test(msg) && typeof rebuildIndexForSheet_ === 'function') {
      try { rebuildIndexForSheet_(SHEET_NAMES.LEADS); } catch (re) { Logger.log('[getLead] rebuild leads index failed: ' + re); }
      // Fallback to a direct full-scan if the indexed path is corrupt.
      const allLeads = getAllRows(SHEET_NAMES.LEADS);
      const baseLead = allLeads.find(r => String(r['Lead ID']) === String(leadId)) || null;
      lead = baseLead ? getRowsWithCustomFieldValues_('Leads', [baseLead])[0] : null;
    } else {
      throw e;
    }
  }
  if (!lead) return null;

  let followups = [];
  try {
    followups = getRowsWithCustomFieldValues_('Followups', getRowsByIndexedColumn_(SHEET_NAMES.FOLLOWUPS, 'Lead ID', leadId))
      .filter(_isFollowupTaskRow)
      .map(_normalizeFollowupRow)
      .sort((a, b) => new Date(b['Created At']) - new Date(a['Created At']));
  } catch (e) {
    Logger.log('[getLead] followups read failed for ' + leadId + ': ' + (e && e.message || e));
    if (typeof rebuildIndexForSheet_ === 'function') {
      try { rebuildIndexForSheet_(SHEET_NAMES.FOLLOWUPS); } catch (_) {}
    }
    followups = (getAllRows(SHEET_NAMES.FOLLOWUPS) || [])
      .filter(r => String(r['Lead ID']) === String(leadId))
      .filter(_isFollowupTaskRow)
      .map(_normalizeFollowupRow)
      .sort((a, b) => new Date(b['Created At']) - new Date(a['Created At']));
  }

  let followupHistory = [];
  let activityLogs = [];
  try { followupHistory = _followupHistoryRows().filter(r => r['Lead ID'] === leadId); }
  catch (e) { Logger.log('[getLead] history read failed: ' + (e && e.message || e)); }
  try { activityLogs = _leadActivityRows().filter(r => r['Lead ID'] === leadId); }
  catch (e) { Logger.log('[getLead] activity read failed: ' + (e && e.message || e)); }

  return { lead, followups, followupHistory, activityLogs };
}

function saveLead(data, email) {
  return _leadSaveStep_('saveLead', () => {
    const user = _leadSaveStep_('authorize user', () => requireRole(['ADMIN', 'MANAGER', 'SALES']));
    const leadId = _leadIdFromPayload(data);
    const skipped = data['__stage_skipped'] === 'true' || data['skipped'] === true;
    if (leadId) {
      data['Lead ID'] = leadId;
      const existing = _leadSaveStep_('load existing lead', () => getLead(leadId));
      if (!existing || !existing.lead) return respond(null, 'Lead not found.');
      if (!_canWriteLead(existing.lead, user)) return respond(null, 'Permission denied.');
      if (_isLeadPushedToNbd_(existing.lead)) return respond(null, 'Lead is already pushed to NBD and cannot be edited in LQ.');
      if (user.role === 'SALES') data['Assigned To'] = user.id;
      const updateDuplicate = _leadSaveStep_('check update duplicate', () => _leadDuplicateMessage_(data, leadId));
      if (updateDuplicate) return respond(null, updateDuplicate);
      const prepared = _leadSaveStep_('prepare update payload', () => _prepareLeadPayload(data, data['Stage ID'] || existing.lead['Stage ID'], existing.lead, skipped));
      _leadSaveStep_('apply update status', () => _applyLeadStatusFromStage(prepared, prepared['Stage ID'] || existing.lead['Stage ID']));
      const updatePayload = { ...prepared, 'Updated At': now() };
      const updated = _leadSaveStep_('update lead row', () => updateRow(SHEET_NAMES.LEADS, 'Lead ID', leadId, pickLeadMasterFields_(updatePayload)));
      if (!updated) return respond(null, 'Lead update failed. Lead ID was not found in the lead sheet.');
      _leadSaveStep_('upsert lead custom fields', () => upsertCustomFieldValues_('Leads', leadId, prepared, user.id, prepared['Stage ID'] || existing.lead['Stage ID']));
      _bumpStamp('leads');
      return respond(leadId);
    }
    const id = generateUUID();
    if (user.role === 'SALES') data['Assigned To'] = user.id;
    const duplicate = _leadSaveStep_('check create duplicate', () => _leadDuplicateMessage_(data, ''));
    if (duplicate) return respond(null, duplicate);
    const prepared = _leadSaveStep_('prepare create payload', () => _prepareLeadPayload(data, data['Stage ID'], {}, skipped));
    _leadSaveStep_('apply create status', () => _applyLeadStatusFromStage(prepared, prepared['Stage ID']));
    const followupDate = today();
    const leadRow = {
      ...prepared, 'Lead ID': id,
      'Assigned To': prepared['Assigned To'] || user.id,
      'Lead Status': prepared['Lead Status'] || 'Open',
      'Last Follow-up Date': prepared['Last Follow-up Date'] || followupDate,
      'Next Follow-up Date': prepared['Next Follow-up Date'] || followupDate,
      'Created At': now(), 'Updated At': now()
    };
    let leadInserted = false;
    try {
      const insertResult = _leadSaveStep_('insert lead master row', () => _insertLeadMasterRowBlockingDuplicates_(leadRow));
      if (!insertResult.success) return respond(null, insertResult.error);
      leadInserted = true;
      _leadSaveStep_('upsert create custom fields', () => upsertCustomFieldValues_('Leads', id, prepared, user.id, prepared['Stage ID']));
      const fuTypes = _leadSaveStep_('load followup type config', () => getConfigByType('Follow-up Type'));
      _leadSaveStep_('ensure followup sheets', () => ensureFollowupSheets_());
      _leadSaveStep_('insert initial followup', () => insertRow(SHEET_NAMES.FOLLOWUPS, {
        'Follow-up ID': generateUUID(),
        'Lead ID': id,
        'Planned Date': followupDate,
        'Follow-up Date': followupDate,
        'Follow-up Type': fuTypes[0] || 'Call',
        'Discussion': 'New lead created',
        'Next Follow-up Date': followupDate,
        'Status': 'Open',
        'Stage ID': prepared['Stage ID'] || '',
        'Created By': user.id,
        'Created At': now(),
        'Updated At': now()
      }));
      _bumpStamp('leads');
      _bumpStamp('followups');
      return respond(id);
    } catch (e) {
      if (leadInserted) _leadSaveStep_('rollback lead row', () => deleteRow(SHEET_NAMES.LEADS, 'Lead ID', id));
      _leadSaveStep_('rollback custom fields', () => deleteCustomFieldValuesForEntity_('Leads', id));
      _leadSaveStep_('rollback followups', () => deleteAllRowsWhere(SHEET_NAMES.FOLLOWUPS, r => r['Lead ID'] === id));
      throw e;
    }
  });
}

function _leadSaveStep_(label, fn) {
  try {
    return fn();
  } catch (e) {
    const message = e && e.message ? e.message : String(e);
    throw new Error('saveLead step "' + label + '" failed: ' + message);
  }
}

function _insertLeadMasterRowBlockingDuplicates_(leadRow) {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const duplicate = _leadDuplicateMessage_(leadRow, '');
    if (duplicate) return { success: false, error: duplicate };
    const rowObj = pickLeadMasterFields_(leadRow);
    const sheet = getSheet(SHEET_NAMES.LEADS);
    const headers = getHeaders(SHEET_NAMES.LEADS);
    const row = headers.map(h => rowObj[h] !== undefined ? rowObj[h] : '');
    sheet.appendRow(row);
    let rowNumber = Number(sheet.getLastRow() || 0);
    if (rowNumber < 2 && typeof findRowIndexWithoutIndex_ === 'function') {
      rowNumber = findRowIndexWithoutIndex_(SHEET_NAMES.LEADS, 'Lead ID', leadRow['Lead ID']);
    }
    if (rowNumber < 2) {
      Logger.log('[Leads] Inserted lead but could not resolve row number for Lead ID=' + leadRow['Lead ID']);
    } else if (typeof syncIndexRow_ === 'function') {
      syncIndexRow_(SHEET_NAMES.LEADS, rowObj, rowNumber);
    }
    return { success: true };
  } finally {
    lock.releaseLock();
  }
}

function checkLeadDuplicates(phone, email, excludeLeadId, companyName) {
  const normPhone = phone ? String(phone).replace(/\D/g, '') : '';
  const normEmail = email ? String(email).trim().toLowerCase() : '';
  const normCompany = _leadNormText_(companyName);
  if (!normPhone && !normEmail && !normCompany) return [];
  let indexRows = getAllRows(SHEET_NAMES.IDX_LEADS);
  if (!indexRows.length && getSheet(SHEET_NAMES.LEADS).getLastRow() > 1) {
    rebuildIndexForSheet_(SHEET_NAMES.LEADS);
    indexRows = getAllRows(SHEET_NAMES.IDX_LEADS);
  }
  return indexRows
    .filter(lead => {
      if (excludeLeadId && lead['Lead ID'] === excludeLeadId) return false;
      if (normPhone) {
        const lPhone = String(lead['Phone'] || '');
        const lAlt   = String(lead['Alternate No'] || '');
        if (lPhone && lPhone === normPhone) return true;
        if (lAlt   && lAlt   === normPhone) return true;
      }
      if (normEmail) {
        const lEmail = String(lead['Email'] || '').trim().toLowerCase();
        if (lEmail && lEmail === normEmail) return true;
      }
      if (normCompany) {
        const lCompany = _leadNormText_(lead['Company Name']);
        if (lCompany && lCompany === normCompany) return true;
      }
      return false;
    })
    .map(lead => ({
      'Lead ID':        lead['Lead ID'],
      'Company Name':   lead['Company Name'] || '',
      'Contact Person': lead['Contact Person'] || '',
      'Phone':          lead['Phone'] || '',
      'Email':          lead['Email'] || '',
      'Lead Status':    lead['Lead Status'] || '',
    }));
}

function _leadDuplicateMessage_(data, excludeLeadId) {
  const existingMap = _leadExistingDuplicateMap_();
  const phone = _leadNormPhone_(data['Phone']);
  const altPhone = _leadNormPhone_(data['Alternate No']);
  const email = _leadNormEmail_(data['Email']);
  const company = _leadNormText_(data['Company Name']);
  const exclude = String(excludeLeadId || '').trim();
  const phoneHit = phone ? existingMap.phone[phone] : '';
  const altHit = altPhone ? existingMap.phone[altPhone] : '';
  const emailHit = email ? existingMap.email[email] : '';
  const companyHit = company ? existingMap.company[company] : '';
  if (phoneHit && phoneHit !== exclude) return 'Duplicate lead blocked: phone already exists.';
  if (altHit && altHit !== exclude) return 'Duplicate lead blocked: alternate phone already exists.';
  if (emailHit && emailHit !== exclude) return 'Duplicate lead blocked: email already exists.';
  if (companyHit && companyHit !== exclude) return 'Duplicate lead blocked: company already exists.';
  return '';
}

function _leadExistingDuplicateMap_() {
  let rows = getAllRows(SHEET_NAMES.IDX_LEADS);
  if (!rows.length && getSheet(SHEET_NAMES.LEADS).getLastRow() > 1) {
    rebuildIndexForSheet_(SHEET_NAMES.LEADS);
    rows = getAllRows(SHEET_NAMES.IDX_LEADS);
  }
  return rows.reduce((m, row) => {
    const leadId = String(row['Lead ID'] || '').trim();
    const phone = _leadNormPhone_(row['Phone']);
    const altPhone = _leadNormPhone_(row['Alternate No']);
    const email = _leadNormEmail_(row['Email']);
    const company = _leadNormText_(row['Company Name']);
    if (phone) m.phone[phone] = leadId;
    if (altPhone) m.phone[altPhone] = leadId;
    if (email) m.email[email] = leadId;
    if (company) m.company[company] = leadId;
    return m;
  }, { phone: {}, email: {}, company: {} });
}

function _leadNormPhone_(value) {
  return String(value || '').replace(/\D/g, '');
}

function _leadNormEmail_(value) {
  return String(value || '').trim().toLowerCase();
}

function _leadNormText_(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function _leadIdFromPayload(data) {
  return String(data['Lead ID'] || data['LeadID'] || data['Lead Id'] || data['ID'] || '').trim();
}

function _prepareLeadPayload(data, stageId, existing, skipped) {
  const payload = { ...data };
  // Lead names are stored in Proper Case on every save path (Lead Form, detail edit,
  // bulk entry) so lists, dialogs and exports show one consistent casing.
  ['Company Name', 'Contact Person'].forEach(k => {
    if (Object.prototype.hasOwnProperty.call(payload, k) && payload[k]) payload[k] = toProperCase_(payload[k]);
  });
  const fields = getLeadCustomFieldsForStage(stageId);
  fields.forEach(field => {
    const isPerStage = (field['Per Stage'] === true || field['Per Stage'] === 'TRUE') && !field['Stage ID'];
    // Per-stage global fields store under {columnKey}__{stageId} so each stage has independent data
    const key = isPerStage ? field['Column Key'] + '__' + stageId : field['Column Key'];
    const hasValue = Object.prototype.hasOwnProperty.call(payload, key);
    let value = payload[key];
    if (field['Field Type'] === 'Formula') return;
    if (field['Field Type'] === 'Checkbox' && hasValue) value = value === true || value === 'TRUE' || value === 'on' ? 'TRUE' : '';
    if (field['Field Type'] === 'Multi Select' && Array.isArray(value)) value = value.join(', ');
    if (field['Field Type'] === 'File' && value && typeof value === 'object') value = _uploadCustomFieldFile(value, field);
    if (!hasValue && existing && existing[key] !== undefined) value = existing[key];
    const fieldBelongsToStage = !field['Stage ID'] || field['Stage ID'] === stageId;
    if (fieldBelongsToStage) {
      const skipVis = field['Skip Visibility'] === 'skip_only' ? 'skip_only' : 'normal';
      if (!skipped && skipVis === 'skip_only') {
        // Not skipping — skip_only fields are irrelevant, don't validate them at all
      } else if (skipped && skipVis === 'normal') {
        if (value !== undefined && value !== '') _validateCustomFieldValue({ ...field, 'Is Required': false }, value);
      } else {
        _validateCustomFieldValue(field, value);
      }
    }
    if (value !== undefined) payload[key] = value;
  });
  return payload;
}

function getLeadCustomFieldsForStage(stageId) {
  return queryRows(SHEET_NAMES.FIELD_CONFIG, r =>
      (r['Sheet Name'] || 'Leads') === 'Leads' &&
      (r['Is Visible'] !== false && r['Is Visible'] !== 'FALSE') &&
      (!r['Stage ID'] || r['Stage ID'] === stageId)
    )
    .sort((a, b) => Number(a['Display Order']) - Number(b['Display Order']));
}

function _validateCustomFieldValue(field, value) {
  const label = field['Field Name'];
  const type = field['Field Type'];
  const isEmpty = value === undefined || value === null || value === '';
  if ((field['Is Required'] === true || field['Is Required'] === 'TRUE') && isEmpty) {
    throw new Error(field['Validation Message'] || `${label} is required.`);
  }
  if (isEmpty) return;

  if (type === 'Number') {
    const n = Number(value);
    if (Number.isNaN(n)) throw new Error(field['Validation Message'] || `${label} must be a number.`);
    if (field['Validation Min'] !== '' && n < Number(field['Validation Min'])) throw new Error(field['Validation Message'] || `${label} is below minimum.`);
    if (field['Validation Max'] !== '' && n > Number(field['Validation Max'])) throw new Error(field['Validation Message'] || `${label} is above maximum.`);
  }
  if (['Text','Textarea'].includes(type)) {
    const len = String(value).length;
    if (field['Validation Min'] !== '' && len < Number(field['Validation Min'])) throw new Error(field['Validation Message'] || `${label} is too short.`);
    if (field['Validation Max'] !== '' && len > Number(field['Validation Max'])) throw new Error(field['Validation Message'] || `${label} is too long.`);
  }
  if (['Date','Date Time'].includes(type)) {
    const d = new Date(value);
    if (String(d) === 'Invalid Date') throw new Error(field['Validation Message'] || `${label} must be a valid date.`);
    if (field['Validation Min'] !== '' && d < new Date(field['Validation Min'])) throw new Error(field['Validation Message'] || `${label} is before the allowed date.`);
    if (field['Validation Max'] !== '' && d > new Date(field['Validation Max'])) throw new Error(field['Validation Message'] || `${label} is after the allowed date.`);
  }
  if (type === 'Time') {
    if (!/^\d{2}:\d{2}/.test(String(value))) throw new Error(field['Validation Message'] || `${label} must be a valid time.`);
    if (field['Validation Min'] !== '' && String(value) < String(field['Validation Min'])) throw new Error(field['Validation Message'] || `${label} is before the allowed time.`);
    if (field['Validation Max'] !== '' && String(value) > String(field['Validation Max'])) throw new Error(field['Validation Message'] || `${label} is after the allowed time.`);
  }
  if (type === 'Email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value))) {
    throw new Error(field['Validation Message'] || `${label} must be a valid email.`);
  }
  if (type === 'URL' && !/^https?:\/\/.+/i.test(String(value))) {
    throw new Error(field['Validation Message'] || `${label} must be a valid URL.`);
  }
  if (type === 'Phone' && !/^[0-9+\-\s()]{7,20}$/.test(String(value))) {
    throw new Error(field['Validation Message'] || `${label} must be a valid phone number.`);
  }
  if (field['Validation Regex']) {
    const re = new RegExp(field['Validation Regex']);
    if (!re.test(String(value))) throw new Error(field['Validation Message'] || `${label} is invalid.`);
  }
}

function _uploadCustomFieldFile(file, field) {
  assertServerContext_();
  if (!file || !file.data) return '';
  const name = String(file.name || field['Field Name'] || 'Upload').replace(/[\\/:*?"<>|]/g, '_');
  const mimeType = String(file.mimeType || 'application/octet-stream');
  _validateCustomFileType(mimeType, field);
  const raw = String(file.data);
  const commaIdx = raw.indexOf(',');
  const base64 = commaIdx !== -1 ? raw.slice(commaIdx + 1) : raw;
  // Validate it looks like base64 before decoding to give a clear error instead of a Utilities exception
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64.replace(/\s/g, ''))) {
    throw new Error(`${field['Field Name']}: file data is not valid base64.`);
  }
  const bytes = Utilities.base64Decode(base64);
  const maxMb = Number(field['Max File MB']) || 10;
  if (bytes.length > maxMb * 1024 * 1024) throw new Error(`${field['Field Name']} file must be ${maxMb} MB or less.`);
  const folder = _getUploadFolder();
  const created = folder.createFile(Utilities.newBlob(bytes, mimeType, name));
  try {
    created.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  } catch (_) {}
  return created.getUrl();
}

function _validateCustomFileType(mimeType, field) {
  const raw = String(field['File Types'] || '').trim();
  if (!raw) return;
  const allowed = raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const current = mimeType.toLowerCase();
  const ok = allowed.some(rule => {
    if (rule.endsWith('/*')) return current.startsWith(rule.slice(0, -1));
    if (rule.includes('/')) return current === rule;
    return current.endsWith('/' + rule.replace(/^\./, ''));
  });
  if (!ok) throw new Error(`${field['Field Name']} file type is not allowed.`);
}

function _getUploadFolder() {
  assertServerContext_();
  if (CUSTOM_FIELD_UPLOAD_FOLDER_CACHE !== null) {
    return CUSTOM_FIELD_UPLOAD_FOLDER_CACHE;
  }
  const props = PropertiesService.getScriptProperties();
  const existingId = props.getProperty('CUSTOM_FIELD_UPLOAD_FOLDER_ID');
  if (existingId) {
    try {
      CUSTOM_FIELD_UPLOAD_FOLDER_CACHE = DriveApp.getFolderById(existingId);
      return CUSTOM_FIELD_UPLOAD_FOLDER_CACHE;
    } catch (e) {}
  }
  const folder = DriveApp.createFolder(CLIENT_CONFIG.UPLOAD_FOLDER_NAME);
  props.setProperty('CUSTOM_FIELD_UPLOAD_FOLDER_ID', folder.getId());
  CUSTOM_FIELD_UPLOAD_FOLDER_CACHE = folder;
  return folder;
}

function updateLeadStage(leadId, newStageId, note, email, fromStageId) {
  const user = requireRole(['ADMIN', 'MANAGER', 'SALES']);
  const lead = getLead(leadId)?.lead;
  if (!lead) return respond(null, 'Lead not found.');
  if (!_canWriteLead(lead, user)) return respond(null, 'Permission denied.');
  if (_isLeadPushedToNbd_(lead)) return respond(null, 'Lead is already pushed to NBD and cannot be moved in LQ.');
  // Stale-job guard: if the lead has already been moved by a newer update, skip silently.
  if (fromStageId && lead['Stage ID'] !== fromStageId) {
    return respond({ leadId, stageId: lead['Stage ID'], skipped: true });
  }
  const stage = queryRows(SHEET_NAMES.STAGES, r => r['Stage ID'] === newStageId)[0];
  if (!stage) return respond(null, 'Stage not found.');
  const moveCheck = _validateLeadStageMove_(lead['Stage ID'], newStageId);
  if (!moveCheck.ok) return respond(null, moveCheck.message);
  const stageName = stage['Stage Name'] || 'selected stage';
  const missing = getLeadCustomFieldsForStage(newStageId)
    .filter(f => f['Is Required'] === true || f['Is Required'] === 'TRUE')
    .filter(f => f['Field Type'] !== 'Formula')
    .filter(f => !lead[_leadEffectiveFieldKey_(f, newStageId)])
    .map(f => f['Field Name']);
  if (missing.length) return respond(null, `Required fields missing for ${stageName}: ${missing.join(', ')}`);
  const leadPatch = { 'Stage ID': newStageId, 'Stage Updated At': now(), 'Updated At': now() };
  const nextStatus = _leadStatusForStage(stage);
  if (nextStatus) {
    leadPatch['Lead Status'] = nextStatus;
    leadPatch['Next Follow-up Date'] = '';
  }
  const updated = updateRow(SHEET_NAMES.LEADS, 'Lead ID', leadId, leadPatch);
  if (!updated) return respond(null, 'Lead update failed. Lead ID was not found in the lead sheet.');
  _bumpStamp('leads');
  insertLeadActivityLog_(
    leadId,
    'Stage Change',
    lead['Stage ID'] || '',
    newStageId,
    note || `Stage updated to ${stageName}`,
    user.id
  );
  return respond({ leadId, stageId: newStageId, leadStatus: leadPatch['Lead Status'] || lead['Lead Status'] || 'Open' });
}

function moveLeadStageWithFields(leadId, newStageId, fields, note, email, fromStageId) {
  const user = requireRole(['ADMIN', 'MANAGER', 'SALES']);
  const lead = getLead(leadId)?.lead;
  if (!lead) return respond(null, 'Lead not found.');
  if (!_canWriteLead(lead, user)) return respond(null, 'Permission denied.');
  if (_isLeadPushedToNbd_(lead)) return respond(null, 'Lead is already pushed to NBD and cannot be moved in LQ.');
  // Stale-job guard: if the lead has already been moved by a newer update, skip silently.
  if (fromStageId && lead['Stage ID'] !== fromStageId) {
    return respond({ leadId, stageId: lead['Stage ID'], skipped: true });
  }

  const stage = queryRows(SHEET_NAMES.STAGES, r => r['Stage ID'] === newStageId)[0];
  if (!stage) return respond(null, 'Stage not found.');
  const moveCheck = _validateLeadStageMove_(lead['Stage ID'], newStageId);
  if (!moveCheck.ok) return respond(null, moveCheck.message);
  const skipped = !!(fields && (fields['__stage_skipped'] === 'true' || fields['__stage_skipped'] === true));
  const stageFields = getLeadCustomFieldsForStage(newStageId)
    .filter(f => f['Field Type'] !== 'Formula');
  const allowed = stageFields.reduce((m, f) => {
    const key = _leadEffectiveFieldKey_(f, newStageId);
    if (key) m[key] = true;
    return m;
  }, {});
  const fieldPayload = {};
  Object.keys(fields || {}).forEach(key => {
    if (allowed[key]) fieldPayload[key] = fields[key];
  });

  const prepared = _prepareLeadPayload(
    { ...fieldPayload, 'Lead ID': leadId, 'Stage ID': newStageId },
    newStageId,
    lead,
    skipped
  );
  const leadPatch = { ...prepared, 'Stage ID': newStageId, 'Stage Updated At': now(), 'Updated At': now() };
  const nextStatus = _leadStatusForStage(stage);
  if (nextStatus) {
    leadPatch['Lead Status'] = nextStatus;
    leadPatch['Next Follow-up Date'] = '';
  }
  if (!leadPatch['Lead Status']) leadPatch['Lead Status'] = lead['Lead Status'] || 'Open';

  const updated = updateRow(SHEET_NAMES.LEADS, 'Lead ID', leadId, pickLeadMasterFields_(leadPatch));
  if (!updated) return respond(null, 'Lead update failed. Lead ID was not found in the lead sheet.');
  upsertCustomFieldValues_('Leads', leadId, prepared, user.id, newStageId);
  _bumpStamp('leads');

  const logNote = note || `Stage updated to ${stage['Stage Name']}${skipped ? ' (custom fields skipped)' : ''}`;
  insertLeadActivityLog_(leadId, 'Stage Change', lead['Stage ID'] || '', newStageId, logNote, user.id);
  return respond({ leadId, stageId: newStageId, leadStatus: leadPatch['Lead Status'], patch: leadPatch });
}

function deleteLead(leadId, email) {
  const trustedEmail = TRUSTED_WRITE_EMAIL;
  if (!trustedEmail) throw new Error('Direct write calls are disabled.');
  const result = getCurrentUserByEmail_(trustedEmail);
  if (!result.success) throw new Error(result.error);
  const user = result.data;
  if (String(user.department || '').trim().toUpperCase() !== 'MIS') throw new Error('Permission denied. Only MIS department users can delete leads.');
  const followupIds = getRowsByIndexedColumn_(SHEET_NAMES.FOLLOWUPS, 'Lead ID', leadId)
    .map(r => r['Follow-up ID'])
    .filter(Boolean);
  deleteRow(SHEET_NAMES.LEADS, 'Lead ID', leadId);
  // Cascade: remove all related master rows and custom-field values linked to this lead.
  deleteCustomFieldValuesForEntity_('Leads', leadId);
  followupIds.forEach(id => deleteCustomFieldValuesForEntity_('Followups', id));
  deleteAllRowsWhere(SHEET_NAMES.FOLLOWUPS,           r => r['Lead ID'] === leadId);
  deleteAllRowsWhere(SHEET_NAMES.FOLLOWUP_HISTORY,    r => r['Lead ID'] === leadId);
  deleteAllRowsWhere(SHEET_NAMES.LEAD_ACTIVITY_LOGS,  r => r['Lead ID'] === leadId);
  _bumpStamp('leads');
  _bumpStamp('followups');
  _bumpStamp('followup_history');
  _bumpStamp('activity_logs');
  return respond(true);
}

function _canWriteLead(lead, user) {
  return ['ADMIN', 'MANAGER'].includes(user.role) || lead['Assigned To'] === user.id;
}

// Updates a lead's custom-field values for one stage (from the Stage Fields form).
// Does NOT change the lead's current stage — fields only.
function saveLeadStageFields(leadId, stageId, fields, email) {
  const trustedEmail = TRUSTED_WRITE_EMAIL;
  if (!trustedEmail) throw new Error('Direct write calls are disabled.');
  const result = getCurrentUserByEmail_(trustedEmail);
  if (!result.success) throw new Error(result.error);
  const user = result.data;
  leadId = String(leadId || '').trim();
  stageId = String(stageId || '').trim();
  if (!leadId) return respond(null, 'No lead selected.');
  if (!stageId) return respond(null, 'No stage selected.');
  // Enforce the per-stage "Update Stage Form" opt-in: only stages explicitly enabled for
  // the form can be saved through it (blocks a hand-crafted request for a disabled stage).
  const allowedStages = getPortalSettings_().stageFieldFormStages || [];
  if (allowedStages.indexOf(stageId) === -1) {
    return respond(null, 'This stage is not enabled for the Stage Fields form.');
  }
  const lead = getRowByIndexedId_(SHEET_NAMES.LEADS, 'Lead ID', leadId);
  if (!lead) return respond(null, 'Lead not found.');
  if (!_canReadAssignedRow(lead, user)) return respond(null, 'Permission denied.');
  if (_isLeadPushedToNbd_(lead)) return respond(null, 'Lead is already pushed to NBD and is locked in LQ.');
  upsertCustomFieldValues_('Leads', leadId, fields || {}, user.id, stageId);
  updateRow(SHEET_NAMES.LEADS, 'Lead ID', leadId, pickLeadMasterFields_({ 'Updated At': now() }));
  const stageName = (getAllStages().find(s => String(s['Stage ID']) === stageId) || {})['Stage Name'] || stageId;
  insertLeadActivityLog_(leadId, 'Update Stage Fields', stageName, stageName, 'Stage fields updated via form', user.id);
  // WhatsApp notification with the saved stage fields (never fails the save).
  try { sendStageFieldsWhatsApp_(lead, stageId, stageName, fields || {}, user); }
  catch (waErr) { Logger.log('[StageFields] WhatsApp notify failed: ' + waErr); }
  _bumpStamp('leads');
  return respond(true);
}

function _isLeadPushedToNbd_(lead) {
  return !!(lead && (lead['NBD Lead ID'] || lead['Pushed To NBD At']));
}

function _isArchivedLead_(lead) {
  const archived = String(lead && lead['Is Archived'] || '').trim().toUpperCase();
  return archived === 'TRUE' || archived === 'YES' || archived === '1' || String(lead && lead['Lead Status'] || '').trim().toLowerCase() === 'archived';
}

function _validateLeadStageMove_(fromStageId, toStageId) {
  if (!fromStageId || !toStageId || String(fromStageId) === String(toStageId)) return { ok: true };

  const allStages    = getAllStages();
  const activeStages = getActiveStages();

  const fromAllIdx = allStages.findIndex(s => String(s['Stage ID']) === String(fromStageId));
  const toAllIdx   = allStages.findIndex(s => String(s['Stage ID']) === String(toStageId));
  if (fromAllIdx === -1 || toAllIdx === -1) return { ok: true };

  const targetStage    = allStages[toAllIdx];
  const fromActiveIdx  = activeStages.findIndex(s => String(s['Stage ID']) === String(fromStageId));
  const toActiveIdx    = activeStages.findIndex(s => String(s['Stage ID']) === String(toStageId));

  // Immediate next active stage is always allowed
  if (fromActiveIdx !== -1 && toActiveIdx === fromActiveIdx + 1) return { ok: true };

  // Lead currently on an inactive (legacy) stage — allow moving to the next active stage after it in order
  if (fromActiveIdx === -1 && toActiveIdx !== -1) {
    const nextActiveAfterFrom = allStages
      .slice(fromAllIdx + 1)
      .find(s => s['Is Active'] === true || s['Is Active'] === 'TRUE');
    if (nextActiveAfterFrom && String(nextActiveAfterFrom['Stage ID']) === String(toStageId)) return { ok: true };
  }

  // Non-final stages must be the immediate next active stage
  if (!_leadStageIsFinal_(targetStage)) {
    return { ok: false, message: 'Leads can only move to the next active stage.' };
  }

  // Final stages: Lost/Disqualified can be selected from any stage
  if (_leadStageIsLostOrDisqualified_(targetStage)) return { ok: true };

  // Qualified/Won requires completing all regular ACTIVE pipeline steps first
  const regularActive = activeStages.filter(s => !_leadStageIsFinal_(s));
  const lastRegular   = regularActive[regularActive.length - 1];
  if (lastRegular && String(lastRegular['Stage ID']) === String(fromStageId)) return { ok: true };
  return {
    ok: false,
    message: 'Qualified/Won stage requires completing all pipeline steps first. Lost or Disqualified can be selected from any stage.'
  };
}

function _leadStageIsFinal_(stage) {
  return stage && (stage['Is Final Stage'] === true || stage['Is Final Stage'] === 'TRUE');
}

// True when the lead currently sits in a stage flagged "Is Final Stage".
function _isLeadInFinalStage_(lead) {
  const stageId = String(lead && lead['Stage ID'] || '').trim();
  if (!stageId) return false;
  const stage = getAllStages().find(s => String(s['Stage ID'] || '').trim() === stageId);
  return !!_leadStageIsFinal_(stage);
}

function _leadStageIsLostOrDisqualified_(stage) {
  const outcome = String(stage && stage['Stage Outcome'] || '').trim().toLowerCase();
  const name = String(stage && stage['Stage Name'] || '').trim().toLowerCase();
  return outcome === 'lost' || outcome.includes('disqualif') || /lost|disqualif/.test(name);
}

function _leadStatusForStage(stage) {
  if (!stage) return '';
  const outcome = String(stage['Stage Outcome'] || '').trim();
  const outcomeLower = outcome.toLowerCase();
  const name = String(stage['Stage Name'] || '').trim().toLowerCase();
  if (outcomeLower.includes('disqualif') || name.includes('disqualif')) return 'Disqualified';
  if (outcome === 'Won' || outcome === 'Lost') return outcome;
  if (stage['Is Final Stage'] === true || stage['Is Final Stage'] === 'TRUE') {
    if (name.includes('lost')) return 'Lost';
    return 'Won';
  }
  return '';
}

function _leadEffectiveFieldKey_(field, stageId) {
  const baseKey = field && field['Column Key'];
  if (!baseKey) return '';
  const isPerStage = (field['Per Stage'] === true || field['Per Stage'] === 'TRUE') && !field['Stage ID'];
  return isPerStage && stageId ? baseKey + '__' + stageId : baseKey;
}

function _applyLeadStatusFromStage(payload, stageId) {
  const stage = queryRows(SHEET_NAMES.STAGES, r => r['Stage ID'] === stageId)[0];
  const status = _leadStatusForStage(stage);
  if (status) payload['Lead Status'] = status;
  if (!payload['Lead Status']) payload['Lead Status'] = 'Open';
}
