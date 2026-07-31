// ─── VisitService.js ─────────────────────────────────────────────────────────
// Client visit reports: each visit links to a lead and uses a fixed reporting schema.

const VISIT_MASTER_FIELDS = [
  'Visit ID','Lead ID','DATE','CITY','ACCOMODATION TOUR','ACCOMODATION STAY',
  'AMOUNT','LEADS','source','CONTACT NO.','FSR','SC','VISIT','designation',
  'CONVERSION','FEEDBACK','FEEDBACK ATTACHEMT',
  'Created By','Created At','Updated At'
];

const VISIT_NUMBER_FIELDS = [
  'ACCOMODATION TOUR','ACCOMODATION STAY','AMOUNT','LEADS','FSR','SC','VISIT','CONVERSION'
];

const VISIT_INTEGER_FIELDS = ['LEADS','FSR','SC','VISIT','CONVERSION'];

let _visitSheetsEnsured_ = false;
function ensureVisitSheets_() {
  if (_visitSheetsEnsured_) return;
  safeInitHeaders(SHEET_NAMES.VISITS, VISIT_MASTER_FIELDS);
  _visitSheetsEnsured_ = true;
}

function pickVisitMasterFields_(payload) {
  return _pickFields_(payload, VISIT_MASTER_FIELDS);
}

// All visits, newest first. Scoping happens in the API layer.
function getVisits() {
  ensureVisitSheets_();
  return getAllRows(SHEET_NAMES.VISITS)
    .sort((a, b) => new Date(b['DATE'] || b['Visit Date'] || b['Created At'] || 0) - new Date(a['DATE'] || a['Visit Date'] || a['Created At'] || 0));
}

// Saves a visit report from the Visits form; logs the visit on the lead and notifies WhatsApp.
function saveVisit(data, email) {
  ensureVisitSheets_();
  const user = _visitActor_(email);
  data = data || {};

  const leadId = String(data['Lead ID'] || '').trim();
  if (!leadId) return respond(null, 'No lead selected.');
  const lead = getRowByIndexedId_(SHEET_NAMES.LEADS, 'Lead ID', leadId);
  if (!lead) return respond(null, 'Lead not found.');
  if (!_canReadAssignedRow(lead, user)) return respond(null, 'Permission denied.');
  const validationError = validateVisitPayload_(data);
  if (validationError) return respond(null, validationError);

  const id = generateUUID();
  const ts = now();
  const visitRow = pickVisitMasterFields_({
    'Visit ID': id,
    'Lead ID': leadId,
    'DATE': data['DATE'] || today(),
    'CITY': data['CITY'] || lead['City'] || '',
    'ACCOMODATION TOUR': data['ACCOMODATION TOUR'] || '',
    'ACCOMODATION STAY': data['ACCOMODATION STAY'] || '',
    'AMOUNT': data['AMOUNT'] || '',
    'LEADS': data['LEADS'] || '',
    'source': data['source'] || lead['Source'] || '',
    'CONTACT NO.': data['CONTACT NO.'] || lead['Phone'] || '',
    'FSR': data['FSR'] || '',
    'SC': data['SC'] || '',
    'VISIT': data['VISIT'] || '',
    'designation': data['designation'] || '',
    'CONVERSION': data['CONVERSION'] || '',
    'FEEDBACK': data['FEEDBACK'] || '',
    'FEEDBACK ATTACHEMT': data['FEEDBACK ATTACHEMT'] || '',
    'Created By': user.id,
    'Created At': ts,
    'Updated At': ts
  });
  insertRow(SHEET_NAMES.VISITS, visitRow);
  insertLeadActivityLog_(leadId, 'Client Visit', '', 'Visit',
    visitRow['FEEDBACK'] || 'Visit report filed', user.id);
  // WhatsApp notification with the visit report (never fails the save).
  try { sendVisitWhatsApp_(lead, visitRow, data, [], user); }
  catch (waErr) { Logger.log('[Visits] WhatsApp notify failed: ' + waErr); }
  _bumpStamp('visits');
  _bumpStamp('activity_logs');
  return respond(id);
}

function updateVisit(data, email) {
  ensureVisitSheets_();
  const user = _visitActor_(email);
  data = data || {};
  const visitId = String(data['Visit ID'] || '').trim();
  if (!visitId) return respond(null, 'Visit ID is required.');
  const existing = getAllRows(SHEET_NAMES.VISITS).find(v => String(v['Visit ID']) === visitId);
  if (!existing) return respond(null, 'Visit not found.');
  const leadId = String(data['Lead ID'] || existing['Lead ID'] || '').trim();
  const lead = getRowByIndexedId_(SHEET_NAMES.LEADS, 'Lead ID', leadId);
  if (!lead) return respond(null, 'Lead not found.');
  if (!_canReadAssignedRow(lead, user)) return respond(null, 'Permission denied.');
  const validationError = validateVisitPayload_(data);
  if (validationError) return respond(null, validationError);
  const patch = pickVisitMasterFields_({
    ...existing,
    ...data,
    'Visit ID': visitId,
    'Lead ID': leadId,
    'DATE': data['DATE'] || existing['DATE'] || today(),
    'CITY': data['CITY'] || lead['City'] || '',
    'source': data['source'] || lead['Source'] || '',
    'CONTACT NO.': data['CONTACT NO.'] || lead['Phone'] || '',
    'Created By': existing['Created By'] || user.id,
    'Created At': existing['Created At'] || now(),
    'Updated At': now()
  });
  const updated = updateRow(SHEET_NAMES.VISITS, 'Visit ID', visitId, patch);
  if (!updated) return respond(null, 'Visit update failed. Visit ID was not found.');
  insertLeadActivityLog_(leadId, 'Client Visit Updated', '', 'Visit',
    patch['FEEDBACK'] || 'Visit report updated', user.id);
  _bumpStamp('visits');
  _bumpStamp('activity_logs');
  return respond(visitId);
}

function deleteVisit(visitId, email) {
  ensureVisitSheets_();
  const user = _visitActor_(email);
  visitId = String(visitId || '').trim();
  if (!visitId) return respond(null, 'Visit ID is required.');
  const existing = getAllRows(SHEET_NAMES.VISITS).find(v => String(v['Visit ID']) === visitId);
  if (!existing) return respond(null, 'Visit not found.');
  const lead = getRowByIndexedId_(SHEET_NAMES.LEADS, 'Lead ID', existing['Lead ID']);
  if (lead && !_canReadAssignedRow(lead, user)) return respond(null, 'Permission denied.');
  const deleted = deleteRow(SHEET_NAMES.VISITS, 'Visit ID', visitId);
  if (!deleted) return respond(null, 'Visit delete failed. Visit ID was not found.');
  if (lead) insertLeadActivityLog_(existing['Lead ID'], 'Client Visit Deleted', 'Visit', '',
    'Visit report deleted', user.id);
  _bumpStamp('visits');
  _bumpStamp('activity_logs');
  return respond(true);
}

function _visitActor_(email) {
  const actorEmail = String(email || TRUSTED_WRITE_EMAIL || '').trim().toLowerCase();
  if (!actorEmail) throw new Error('Direct write calls are disabled.');
  const result = getCurrentUserByEmail_(actorEmail);
  if (!result.success) throw new Error(result.error);
  return result.data;
}

function validateVisitPayload_(data) {
  const date = String(data['DATE'] || '').trim();
  if (date && String(new Date(date)) === 'Invalid Date') return 'DATE must be a valid date.';
  const phone = String(data['CONTACT NO.'] || '').trim();
  if (phone && !/^[0-9+\-\s()]{7,20}$/.test(phone)) return 'CONTACT NO. must be a valid phone number.';
  for (let i = 0; i < VISIT_NUMBER_FIELDS.length; i++) {
    const field = VISIT_NUMBER_FIELDS[i];
    const raw = data[field];
    if (raw === '' || raw === undefined || raw === null) continue;
    const num = Number(raw);
    if (!Number.isFinite(num)) return field + ' must be a valid number.';
    if (num < 0) return field + ' cannot be negative.';
    if (VISIT_INTEGER_FIELDS.indexOf(field) !== -1 && Math.floor(num) !== num) return field + ' must be a whole number.';
  }
  const attachment = String(data['FEEDBACK ATTACHEMT'] || '').trim();
  if (attachment && attachment.indexOf('http') !== 0) return 'FEEDBACK ATTACHEMT must be a valid uploaded file URL.';
  return '';
}
