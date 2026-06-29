// Custom field values live outside master sheets.
// Reads merge values back into row objects so the existing UI can stay simple.

const LEAD_MASTER_FIELDS = [
  'Lead ID','Company Name','Contact Person','Phone','Alternate No','Email',
  'City','State','Address','GST No','Category','Client Description','Source','Product Interest',
  'Stage ID','Priority','Assigned To','Lead Status',
  'Stage Updated At','Last Follow-up Date','Next Follow-up Date',
  'Source Portal','Source Lead ID','NBD Lead ID','Pushed To NBD At',
  'Is Archived','Archived At','Archived By','Archive Reason',
  'Created At','Updated At'
];

const FOLLOWUP_MASTER_FIELDS = [
  'Follow-up ID','Lead ID','Planned Date','Follow-up Date','Follow-up Type',
  'Discussion','Outcome','Next Follow-up Date','Next Action','Status',
  'Done Date','Done By','Stage ID','Updated Stage ID','Created By','Created At','Updated At'
];

// Per-execution guard: GAS globals reset on every request, so this ensures the
// header check (which invalidates the read cache + does extra Sheets round-trips
// via safeInitHeaders) runs at most once per execution instead of on every
// custom-field read.
let _cfvSheetsEnsured_ = false;
function ensureCustomFieldValueSheets_() {
  if (_cfvSheetsEnsured_) return;
  safeInitHeaders(SHEET_NAMES.LEAD_FIELD_VALUES, [
    'Value ID','Lead ID','Field ID','Column Key','Field Value','File URL','Updated By','Updated At'
  ]);
  safeInitHeaders(SHEET_NAMES.FOLLOWUP_FIELD_VALUES, [
    'Value ID','Follow-up ID','Field ID','Column Key','Field Value','File URL','Updated By','Updated At'
  ]);
  _cfvSheetsEnsured_ = true;
}

function getRowsWithCustomFieldValues_(sheetName, rows) {
  const merged = mergeCustomFieldValues_(sheetName, rows || []);
  return applyCalculatedFields(sheetName, merged);
}

function mergeCustomFieldValues_(sheetName, rows) {
  ensureCustomFieldValueSheets_();
  if (!rows || !rows.length) return rows || [];
  const entityKey = _customEntityKey_(sheetName);
  const ids = rows.map(r => String(r[entityKey] || '')).filter(Boolean);
  if (!ids.length) return rows;
  const idSet = ids.reduce((m, id) => { m[id] = true; return m; }, {});
  const fieldById = _customFieldMapById_(sheetName);
  const values = getAllRows(_customValueSheetName_(sheetName))
    .filter(v => idSet[String(v[entityKey] || '')]);
  const byEntity = {};
  values.forEach(v => {
    const entityId = String(v[entityKey] || '');
    const field = fieldById[v['Field ID']] || {};
    const key = v['Column Key'] || field['Column Key'];
    if (!entityId || !key) return;
    if (!byEntity[entityId]) byEntity[entityId] = {};
    byEntity[entityId][key] = v['File URL'] || v['Field Value'] || '';
  });
  return rows.map(row => ({ ...row, ...(byEntity[String(row[entityKey] || '')] || {}) }));
}

function upsertCustomFieldValues_(sheetName, entityId, payload, userId, stageId) {
  ensureCustomFieldValueSheets_();
  if (!entityId || !payload) return;
  const fields = _customFieldsForWrite_(sheetName, stageId)
    .filter(f => f['Field Type'] !== 'Formula');
  fields.forEach(field => {
    const key = _customEffectiveColumnKey_(field, stageId);
    if (!key || !Object.prototype.hasOwnProperty.call(payload, key)) return;
    _upsertCustomValue_(sheetName, entityId, { ...field, 'Column Key': key }, payload[key], userId);
  });
}

function deleteCustomFieldValuesForEntity_(sheetName, entityId) {
  ensureCustomFieldValueSheets_();
  if (!entityId) return 0;
  const valueSheet = _customValueSheetName_(sheetName);
  const entityKey = _customEntityKey_(sheetName);
  return deleteAllRowsWhere(valueSheet, r => String(r[entityKey]) === String(entityId));
}

function migrateLegacyCustomFieldValues_() {
  ensureCustomFieldValueSheets_();
  const leadCount = _migrateCustomValuesForSheet_('Leads', SHEET_NAMES.LEADS);
  const followupCount = _migrateCustomValuesForSheet_('Followups', SHEET_NAMES.FOLLOWUPS);
  if (leadCount) _bumpStamp('leads');
  if (followupCount) _bumpStamp('followups');
  return { leadCount, followupCount };
}

function pickLeadMasterFields_(payload) {
  return _pickFields_(payload, LEAD_MASTER_FIELDS);
}

function pickFollowupMasterFields_(payload) {
  return _pickFields_(payload, FOLLOWUP_MASTER_FIELDS);
}

function _upsertCustomValue_(sheetName, entityId, field, value, userId) {
  const valueSheet = _customValueSheetName_(sheetName);
  const entityKey = _customEntityKey_(sheetName);
  const fieldId = field['Field ID'];
  const key = field['Column Key'];
  const existing = queryRows(valueSheet, r =>
    String(r[entityKey]) === String(entityId) &&
    String(r['Field ID']) === String(fieldId) &&
    String(r['Column Key'] || '') === String(key || '')
  )[0];
  const isFile = field['Field Type'] === 'File';
  const row = {
    [entityKey]: entityId,
    'Field ID': fieldId,
    'Column Key': key,
    'Field Value': isFile ? '' : _customStoredValue_(value),
    'File URL': isFile ? _customStoredValue_(value) : '',
    'Updated By': userId || '',
    'Updated At': now()
  };
  if (existing && existing['Value ID']) {
    updateRow(valueSheet, 'Value ID', existing['Value ID'], row);
  } else {
    insertRow(valueSheet, { ...row, 'Value ID': generateUUID() });
  }
}

function _migrateCustomValuesForSheet_(sheetName, masterSheetName) {
  const entityKey = _customEntityKey_(sheetName);
  const fields = _allCustomFieldDefs_(sheetName)
    .filter(f => f['Field Type'] !== 'Formula' && f['Column Key']);
  if (!fields.length) return 0;
  const valueSheet = _customValueSheetName_(sheetName);
  const existing = getAllRows(valueSheet).reduce((m, r) => {
    m[String(r[entityKey] || '') + '|' + String(r['Field ID'] || '')] = true;
    return m;
  }, {});
  let count = 0;
  getAllRows(masterSheetName).forEach(row => {
    const entityId = row[entityKey];
    if (!entityId) return;
    fields.forEach(field => {
      const key = field['Column Key'];
      const value = row[key];
      if (value === undefined || value === null || value === '') return;
      const dedupeKey = String(entityId) + '|' + String(field['Field ID']);
      if (existing[dedupeKey]) return;
      const isFile = field['Field Type'] === 'File';
      insertRow(valueSheet, {
        'Value ID': generateUUID(),
        [entityKey]: entityId,
        'Field ID': field['Field ID'],
        'Column Key': key,
        'Field Value': isFile ? '' : value,
        'File URL': isFile ? value : '',
        'Updated By': row['Updated By'] || row['Created By'] || '',
        'Updated At': row['Updated At'] || row['Created At'] || now()
      });
      existing[dedupeKey] = true;
      count++;
    });
  });
  return count;
}

function _customFieldsForWrite_(sheetName, stageId) {
  if (sheetName === 'Leads') return getLeadCustomFieldsForStage(stageId);
  if (sheetName === 'Followups') return getFollowupCustomFields();
  return [];
}

function _allCustomFieldDefs_(sheetName) {
  return queryRows(SHEET_NAMES.FIELD_CONFIG, f => (f['Sheet Name'] || 'Leads') === sheetName);
}

function _customFieldMapById_(sheetName) {
  return _allCustomFieldDefs_(sheetName).reduce((m, field) => {
    if (field['Field ID']) m[field['Field ID']] = field;
    return m;
  }, {});
}

function _customValueSheetName_(sheetName) {
  if (sheetName === 'Leads') return SHEET_NAMES.LEAD_FIELD_VALUES;
  if (sheetName === 'Followups') return SHEET_NAMES.FOLLOWUP_FIELD_VALUES;
  throw new Error('Unsupported custom value sheet: ' + sheetName);
}

function _customEntityKey_(sheetName) {
  if (sheetName === 'Leads') return 'Lead ID';
  if (sheetName === 'Followups') return 'Follow-up ID';
  throw new Error('Unsupported custom value sheet: ' + sheetName);
}

function _customStoredValue_(value) {
  if (value === undefined || value === null) return '';
  if (Array.isArray(value)) return value.join(', ');
  return value;
}

function _customEffectiveColumnKey_(field, stageId) {
  const baseKey = field && field['Column Key'];
  if (!baseKey) return '';
  const isPerStage = (field['Per Stage'] === true || field['Per Stage'] === 'TRUE') && !field['Stage ID'];
  return isPerStage && stageId ? baseKey + '__' + stageId : baseKey;
}

function _pickFields_(payload, allowed) {
  return allowed.reduce((out, key) => {
    if (Object.prototype.hasOwnProperty.call(payload, key)) out[key] = payload[key];
    return out;
  }, {});
}
