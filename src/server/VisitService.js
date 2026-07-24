// ─── VisitService.js ─────────────────────────────────────────────────────────
// Client visit reports: each visit links to a lead and carries a few master fields
// plus any admin-configured custom fields (FIELD_CONFIG rows with Sheet Name = 'Visits',
// values stored in VISIT_FIELD_VALUES — same engine as lead/follow-up custom fields).

const VISIT_MASTER_FIELDS = [
  'Visit ID','Lead ID','Visit Date','Visit Type','Remarks','Next Visit Date',
  'Created By','Created At','Updated At'
];

let _visitSheetsEnsured_ = false;
function ensureVisitSheets_() {
  if (_visitSheetsEnsured_) return;
  safeInitHeaders(SHEET_NAMES.VISITS, VISIT_MASTER_FIELDS);
  ensureCustomFieldValueSheets_();
  _seedDefaultVisitFields_();
  _cleanupVisitLeadDetailFields_();
  _visitSheetsEnsured_ = true;
}

// One-time cleanup: the first seed included lead-detail fields (City, Contact No.,
// Source) that duplicate the linked lead — remove them (and any stored values) from
// portals where that seed already ran, so the visit form drops them automatically.
function _cleanupVisitLeadDetailFields_() {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('VISIT_FIELDS_CLEANUP_V2') === '1') return;
  const names = { 'city': true, 'contact no.': true, 'source': true };
  const doomed = getAllRows(SHEET_NAMES.FIELD_CONFIG).filter(f =>
    (f['Sheet Name'] || 'Leads') === 'Visits' &&
    names[String(f['Field Name'] || '').trim().toLowerCase()]);
  if (doomed.length) {
    const keys = {};
    doomed.forEach(f => { if (f['Column Key']) keys[f['Column Key']] = true; });
    deleteAllRowsWhere(SHEET_NAMES.FIELD_CONFIG, r =>
      (r['Sheet Name'] || 'Leads') === 'Visits' && names[String(r['Field Name'] || '').trim().toLowerCase()]);
    try { deleteAllRowsWhere(SHEET_NAMES.VISIT_FIELD_VALUES, r => keys[r['Column Key']]); } catch (e) {}
    invalidateAppConfigCache();
    _bumpStamp('fields');
    Logger.log('[Visits] removed ' + doomed.length + ' lead-detail visit field(s)');
  }
  props.setProperty('VISIT_FIELDS_CLEANUP_V2', '1');
}

// One-time seed of the standard visit-report fields (tour expense sheet columns).
// Runs on first Visits use per portal; admins can rename/re-order/remove them later in
// Config → Fields — the property guard means they are never re-added.
// (DATE and FEEDBACK are not seeded: the form's master Visit Date and Remarks/Feedback
// inputs already cover them.)
function _seedDefaultVisitFields_() {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('VISIT_FIELDS_SEEDED') === '1') return;
  const existing = getAllRows(SHEET_NAMES.FIELD_CONFIG)
    .filter(f => (f['Sheet Name'] || 'Leads') === 'Visits')
    .reduce((m, f) => { m[String(f['Field Name'] || '').trim().toLowerCase()] = true; return m; }, {});
  // Lead-detail columns (City, Contact No., Source) are NOT seeded — the visit links to
  // a lead, so those values come from the lead itself (and already go into the WhatsApp
  // message from the lead row).
  const specs = [
    { name: 'Accommodation - Tour', type: 'Number' },
    { name: 'Accommodation - Stay', type: 'Number' },
    { name: 'Amount',              type: 'Number' },
    { name: 'Leads',               type: 'Number' },
    { name: 'FSR',                 type: 'Number' },
    { name: 'SC',                  type: 'Number' },
    { name: 'Visit',               type: 'Number' },
    { name: 'Designation',         type: 'Text' },
    { name: 'Conversion',          type: 'Number' }
  ];
  let order = 10, added = 0;
  specs.forEach(spec => {
    if (existing[spec.name.toLowerCase()]) { order += 10; return; }
    insertRow(SHEET_NAMES.FIELD_CONFIG, _normalizeFieldConfig({
      'Field ID': generateUUID(),
      'Sheet Name': 'Visits',
      'Field Name': spec.name,
      'Column Key': FieldValidation.columnKeyFromName(spec.name),
      'Field Type': spec.type,
      'Dropdown Source': spec.source || '',
      'Display Order': order,
      'Is Required': false,
      'Is Visible': true,
      'File Types': spec.fileTypes || '',
      'Max File MB': spec.maxMb || '',
      'Allow Multiple': spec.multiple === true,
      'Created At': now()
    }));
    order += 10;
    added++;
  });
  props.setProperty('VISIT_FIELDS_SEEDED', '1');
  if (added) {
    invalidateAppConfigCache();
    _bumpStamp('fields');
    Logger.log('[Visits] seeded ' + added + ' default visit fields');
  }
}

function pickVisitMasterFields_(payload) {
  return _pickFields_(payload, VISIT_MASTER_FIELDS);
}

// All visits (custom fields merged), newest first. Scoping happens in the API layer.
function getVisits() {
  ensureVisitSheets_();
  return getRowsWithCustomFieldValues_('Visits', getAllRows(SHEET_NAMES.VISITS))
    .sort((a, b) => new Date(b['Visit Date'] || b['Created At'] || 0) - new Date(a['Visit Date'] || a['Created At'] || 0));
}

// Saves a visit report from the Visits form. Always creates a new visit (reports are
// append-only); logs the visit on the lead and notifies WhatsApp.
function saveVisit(data, email) {
  ensureVisitSheets_();
  const trustedEmail = TRUSTED_WRITE_EMAIL;
  if (!trustedEmail) throw new Error('Direct write calls are disabled.');
  const result = getCurrentUserByEmail_(trustedEmail);
  if (!result.success) throw new Error(result.error);
  const user = result.data;
  data = data || {};

  const leadId = String(data['Lead ID'] || '').trim();
  if (!leadId) return respond(null, 'No lead selected.');
  const lead = getRowByIndexedId_(SHEET_NAMES.LEADS, 'Lead ID', leadId);
  if (!lead) return respond(null, 'Lead not found.');
  if (!_canReadAssignedRow(lead, user)) return respond(null, 'Permission denied.');

  // Normalize custom-field values the same way lead saves do (checkbox flags,
  // multiselect arrays, file uploads to Drive).
  const fields = getFieldConfig('Visits');
  fields.forEach(field => {
    const key = field['Column Key'];
    if (!key || !Object.prototype.hasOwnProperty.call(data, key)) return;
    let value = data[key];
    if (field['Field Type'] === 'Formula') return;
    if (field['Field Type'] === 'Checkbox') value = value === true || value === 'TRUE' || value === 'on' ? 'TRUE' : '';
    if (field['Field Type'] === 'Multi Select' && Array.isArray(value)) value = value.join(', ');
    if (field['Field Type'] === 'File' && value && typeof value === 'object') value = _uploadCustomFieldFile(value, field);
    if (value !== undefined && value !== '') _validateCustomFieldValue(field, value);
    data[key] = value;
  });

  const id = generateUUID();
  const ts = now();
  const visitRow = pickVisitMasterFields_({
    'Visit ID': id,
    'Lead ID': leadId,
    'Visit Date': data['Visit Date'] || today(),
    'Visit Type': data['Visit Type'] || '',
    'Remarks': data['Remarks'] || '',
    'Next Visit Date': data['Next Visit Date'] || '',
    'Created By': user.id,
    'Created At': ts,
    'Updated At': ts
  });
  insertRow(SHEET_NAMES.VISITS, visitRow);
  upsertCustomFieldValues_('Visits', id, data, user.id, '');
  insertLeadActivityLog_(leadId, 'Client Visit', '', visitRow['Visit Type'] || 'Visit',
    visitRow['Remarks'] || 'Visit report filed', user.id);
  // WhatsApp notification with the visit report (never fails the save).
  try { sendVisitWhatsApp_(lead, visitRow, data, fields, user); }
  catch (waErr) { Logger.log('[Visits] WhatsApp notify failed: ' + waErr); }
  _bumpStamp('visits');
  _bumpStamp('activity_logs');
  return respond(id);
}
