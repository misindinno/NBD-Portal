// ─── VisitService.js ─────────────────────────────────────────────────────────
// Client visit reports: each visit links to a lead and uses a fixed reporting schema.

const VISIT_MASTER_FIELDS = [
  'Visit ID','Lead ID','DATE','CITY','ACCOMODATION TOUR','ACCOMODATION STAY',
  'AMOUNT','LEADS','source','CONTACT NO.','FSR','SC','VISIT','designation',
  'CONVERSION','FEEDBACK','FEEDBACK ATTACHEMT',
  'Created By','Created At','Updated At'
];

let _visitSheetsEnsured_ = false;
function ensureVisitSheets_() {
  if (_visitSheetsEnsured_) return;
  safeInitHeaders(SHEET_NAMES.VISITS, VISIT_MASTER_FIELDS);
  _visitSheetsEnsured_ = true;
}

function pickVisitMasterFields_(payload) {
  return _pickFields_(payload, VISIT_MASTER_FIELDS);
}

// All visits (custom fields merged), newest first. Scoping happens in the API layer.
function getVisits() {
  ensureVisitSheets_();
  return getAllRows(SHEET_NAMES.VISITS)
    .sort((a, b) => new Date(b['DATE'] || b['Visit Date'] || b['Created At'] || 0) - new Date(a['DATE'] || a['Visit Date'] || a['Created At'] || 0));
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
