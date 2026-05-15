// ─── LeadService.js ──────────────────────────────────────────────────────────

let CUSTOM_FIELD_UPLOAD_FOLDER_CACHE = null;

function getLeads() {
  return getRowsWithCustomFieldValues_('Leads', getAllRows(SHEET_NAMES.LEADS));
}

function getLead(leadId) {
  const lead = getLeads().filter(r => r['Lead ID'] === leadId)[0];
  if (!lead) return null;
  const followups = _followupRows().filter(r => r['Lead ID'] === leadId)
    .sort((a, b) => new Date(b['Created At']) - new Date(a['Created At']));
  const followupHistory = _followupHistoryRows().filter(r => r['Lead ID'] === leadId);
  const activityLogs = _leadActivityRows().filter(r => r['Lead ID'] === leadId);
  return { lead, followups, followupHistory, activityLogs };
}

function saveLead(data, email) {
  const user = requireRole(['ADMIN', 'MANAGER', 'SALES']);
  const leadId = _leadIdFromPayload(data);
  const skipped = data['__stage_skipped'] === 'true' || data['skipped'] === true;
  if (leadId) {
    data['Lead ID'] = leadId;
    const existing = getLead(leadId);
    if (!existing || !existing.lead) return respond(null, 'Lead not found.');
    if (!_canWriteLead(existing.lead, user)) return respond(null, 'Permission denied.');
    if (user.role === 'SALES') data['Assigned To'] = user.id;
    const prepared = _prepareLeadPayload(data, data['Stage ID'] || existing.lead['Stage ID'], existing.lead, skipped);
    _applyLeadStatusFromStage(prepared, prepared['Stage ID'] || existing.lead['Stage ID']);
    const updatePayload = { ...prepared, 'Updated At': now() };
    const updated = updateRow(SHEET_NAMES.LEADS, 'Lead ID', leadId, pickLeadMasterFields_(updatePayload));
    if (!updated) return respond(null, 'Lead update failed. Lead ID was not found in the lead sheet.');
    upsertCustomFieldValues_('Leads', leadId, prepared, user.id, prepared['Stage ID'] || existing.lead['Stage ID']);
    _bumpStamp('leads');
    return respond(leadId);
  }
  const id = generateUUID();
  if (user.role === 'SALES') data['Assigned To'] = user.id;
  const prepared = _prepareLeadPayload(data, data['Stage ID'], {}, skipped);
  _applyLeadStatusFromStage(prepared, prepared['Stage ID']);
  const followupDate = today();
  const leadRow = {
    ...prepared, 'Lead ID': id,
    'Assigned To': prepared['Assigned To'] || user.id,
    'Lead Status': prepared['Lead Status'] || 'Open',
    'Last Follow-up Date': prepared['Last Follow-up Date'] || followupDate,
    'Next Follow-up Date': prepared['Next Follow-up Date'] || followupDate,
    'Created At': now(), 'Updated At': now()
  };
  insertRow(SHEET_NAMES.LEADS, pickLeadMasterFields_(leadRow));
  upsertCustomFieldValues_('Leads', id, prepared, user.id, prepared['Stage ID']);
  const fuTypes = getConfigByType('Follow-up Type');
  ensureFollowupSheets_();
  insertRow(SHEET_NAMES.FOLLOWUPS, {
    'Follow-up ID': generateUUID(),
    'Lead ID': id,
    'Planned Date': followupDate,
    'Follow-up Date': followupDate,
    'Follow-up Type': fuTypes[0] || 'Call',
    'Discussion': 'New lead created',
    'Next Follow-up Date': followupDate,
    'Status': 'Open',
    'Created By': user.id,
    'Created At': now(),
    'Updated At': now()
  });
  _bumpStamp('leads');
  _bumpStamp('followups');
  return respond(id);
}

function _leadIdFromPayload(data) {
  return String(data['Lead ID'] || data['LeadID'] || data['Lead Id'] || data['ID'] || '').trim();
}

function _prepareLeadPayload(data, stageId, existing, skipped) {
  const payload = { ...data };
  const fields = getLeadCustomFieldsForStage(stageId);
  fields.forEach(field => {
    const key = field['Column Key'];
    let value = payload[key];
    if (field['Field Type'] === 'Formula') return;
    if (field['Field Type'] === 'Checkbox') value = value === true || value === 'TRUE' || value === 'on' ? 'TRUE' : '';
    if (field['Field Type'] === 'Multi Select' && Array.isArray(value)) value = value.join(', ');
    if (field['Field Type'] === 'File' && value && typeof value === 'object') value = _uploadCustomFieldFile(value, field);
    if ((value === undefined || value === '') && existing && existing[key]) value = existing[key];
    // Fix #5: only validate required if this field actually belongs to the current stage (or is global)
    const fieldBelongsToStage = !field['Stage ID'] || field['Stage ID'] === stageId;
    if (fieldBelongsToStage) {
      // When skipped: bypass required validation for normal fields; still validate skip_only required fields
      const skipVis = field['Skip Visibility'] === 'skip_only' ? 'skip_only' : 'normal';
      if (skipped && skipVis === 'normal') {
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
  return folder.createFile(Utilities.newBlob(bytes, mimeType, name)).getUrl();
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
  // Use indirect reference to prevent Apps Script scope auto-detection.
  // DriveApp is only needed on the owner deployment (Deployment 2) for file uploads.
  const Drive = this['DriveApp'];
  if (!Drive) throw new Error('DriveApp is not available in this deployment context.');
  if (existingId) {
    try {
      CUSTOM_FIELD_UPLOAD_FOLDER_CACHE = Drive.getFolderById(existingId);
      return CUSTOM_FIELD_UPLOAD_FOLDER_CACHE;
    } catch (e) {}
  }
  const folder = Drive.createFolder(CLIENT_CONFIG.UPLOAD_FOLDER_NAME);
  props.setProperty('CUSTOM_FIELD_UPLOAD_FOLDER_ID', folder.getId());
  CUSTOM_FIELD_UPLOAD_FOLDER_CACHE = folder;
  return folder;
}

function updateLeadStage(leadId, newStageId, note, email) {
  const user = requireRole(['ADMIN', 'MANAGER', 'SALES']);
  const lead = getLead(leadId)?.lead;
  if (!lead) return respond(null, 'Lead not found.');
  if (!_canWriteLead(lead, user)) return respond(null, 'Permission denied.');
  const stage = queryRows(SHEET_NAMES.STAGES, r => r['Stage ID'] === newStageId)[0];
  const stageName = stage ? stage['Stage Name'] : 'selected stage';
  const missing = getLeadCustomFieldsForStage(newStageId)
    .filter(f => f['Is Required'] === true || f['Is Required'] === 'TRUE')
    .filter(f => f['Field Type'] !== 'Formula')
    .filter(f => !lead[f['Column Key']])
    .map(f => f['Field Name']);
  if (missing.length) return respond(null, `Required fields missing for ${stageName}: ${missing.join(', ')}`);
  const leadPatch = { 'Stage ID': newStageId, 'Stage Updated At': now(), 'Updated At': now() };
  const nextStatus = _leadStatusForStage(stage);
  if (nextStatus) leadPatch['Lead Status'] = nextStatus;
  updateRow(SHEET_NAMES.LEADS, 'Lead ID', leadId, leadPatch);
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

function moveLeadStageWithFields(leadId, newStageId, fields, note, email) {
  const user = requireRole(['ADMIN', 'MANAGER', 'SALES']);
  const lead = getLead(leadId)?.lead;
  if (!lead) return respond(null, 'Lead not found.');
  if (!_canWriteLead(lead, user)) return respond(null, 'Permission denied.');

  const stage = queryRows(SHEET_NAMES.STAGES, r => r['Stage ID'] === newStageId)[0];
  if (!stage) return respond(null, 'Stage not found.');
  const skipped = !!(fields && (fields['__stage_skipped'] === 'true' || fields['__stage_skipped'] === true));
  const stageFields = getLeadCustomFieldsForStage(newStageId)
    .filter(f => f['Field Type'] !== 'Formula');
  const allowed = stageFields.reduce((m, f) => {
    if (f['Column Key']) m[f['Column Key']] = true;
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
  if (nextStatus) leadPatch['Lead Status'] = nextStatus;
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
  requireRole(['ADMIN']);
  deleteRow(SHEET_NAMES.LEADS, 'Lead ID', leadId);
  // Cascade: remove all follow-up, history, and activity data linked to this lead
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

function _leadStatusForStage(stage) {
  if (!stage || !(stage['Is Final Stage'] === true || stage['Is Final Stage'] === 'TRUE')) return '';
  const name = String(stage['Stage Name'] || '').trim().toLowerCase();
  if (name.includes('lost')) return 'Lost';
  return 'Won';
}

function _applyLeadStatusFromStage(payload, stageId) {
  const stage = queryRows(SHEET_NAMES.STAGES, r => r['Stage ID'] === stageId)[0];
  const status = _leadStatusForStage(stage);
  if (status) payload['Lead Status'] = status;
  if (!payload['Lead Status']) payload['Lead Status'] = 'Open';
}
