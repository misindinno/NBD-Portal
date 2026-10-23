// Shared by all NBD/LQ deployments. Only signed server requests can call this receiver.
// Install beside Code.js. Uses the portal's existing FSR_WEBHOOK_SECRET unless overridden.
function _ecsQueryWebhook_(raw) {
  return withRequestContext_('ecsQueryLead', () => withServerContext_(() => {
    let result;
    try {
      const request = _ecsVerifyQueryRequest_(raw);
      if (request.action === 'options') result = { users: _ecsAssignableUsers_() };
      else if (request.action === 'check') result = _ecsCheckQueryLead_(request);
      else if (request.action === 'continue') result = _ecsContinueQueryLead_(request);
      else if (request.action === 'push') result = _ecsCreateQueryLead_(request);
      else throw _ecsQueryError_('INVALID_REQUEST');
      return ContentService.createTextOutput(JSON.stringify({ success: true, data: result })).setMimeType(ContentService.MimeType.JSON);
    } catch (error) {
      // Never log the signed request, secret, or query contents.
      return ContentService.createTextOutput(JSON.stringify({ success: false, code: error.ecsCode || 'PROCESSING_FAILED' })).setMimeType(ContentService.MimeType.JSON);
    }
  }));
}

function _ecsQueryError_(code) {
  const error = new Error(code); error.ecsCode = code; return error;
}

function _ecsVerifyQueryRequest_(raw) {
  if (typeof raw !== 'string' || raw.length > 64000) throw _ecsQueryError_('INVALID_REQUEST');
  const properties = PropertiesService.getScriptProperties();
  const secret = properties.getProperty('ECS_QUERY_PUSH_SECRET') || properties.getProperty('FSR_WEBHOOK_SECRET') || '';
  const envelope = JSON.parse(raw);
  if (secret.length < 32 || !Number.isInteger(envelope.timestamp) || Math.abs(Math.floor(Date.now() / 1000) - envelope.timestamp) > 300 || typeof envelope.payload !== 'string' || !/^[a-f0-9]{64}$/.test(envelope.signature || '')) throw _ecsQueryError_('AUTH_FAILED');
  const bytes = Utilities.computeHmacSha256Signature('ecs-query.v1.' + envelope.timestamp + '.' + envelope.payload, secret, Utilities.Charset.UTF_8);
  const expected = bytes.map(value => ('0' + ((value + 256) % 256).toString(16)).slice(-2)).join('');
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ envelope.signature.charCodeAt(i);
  if (diff) throw _ecsQueryError_('AUTH_FAILED');
  const request = JSON.parse(envelope.payload);
  if (!CLIENT_CONFIG.FSR_SOURCE_KEY || request.portalKey !== CLIENT_CONFIG.FSR_SOURCE_KEY) throw _ecsQueryError_('AUTH_FAILED');
  return request;
}

function _ecsAssignableUsers_() {
  const settings = getPortalSettings_();
  return getUsersWithPortalAccess_(CLIENT_CONFIG.PORTAL_KEY)
    .filter(row => isActiveUserValue(row['Is Active']) && _userMatchesDepartmentSettings_(row, settings))
    .map(row => {
      const email = String(row['Email Address'] || '').trim().toLowerCase();
      return { id: getStaffUserId(row, email), email, name: String(row.Name || email) };
    }).filter(user => user.id);
}

function _ecsValidateLeadRequest_(request, existing) {
  const bounds = { queryId: 36, reference: 100, companyName: 300, contact: 200, phone: 40, email: 254, city: 120, state: 120, address: 800, subject: 200, message: 5000, kind: 40, actor: 254, assignedTo: 254, followupDate: 10, remark: 2000 };
  Object.keys(bounds).forEach(key => {
    if (typeof request[key] !== 'string' || request[key].length > bounds[key]) throw _ecsQueryError_('INVALID_REQUEST');
  });
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(request.queryId) || !request.companyName.trim() || (!existing && !request.assignedTo.trim())) throw _ecsQueryError_('INVALID_REQUEST');
  if (existing && !request.followupDate) return;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(request.followupDate)) throw _ecsQueryError_('INVALID_REQUEST');
  const date = new Date(request.followupDate);
  if (!Number.isFinite(+date) || date.toISOString().slice(0, 10) !== request.followupDate) throw _ecsQueryError_('INVALID_REQUEST');
}

function _ecsQuerySheet_(name, required) {
  const sheet = getSheet(name);
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(String);
  if (required.some(header => !headers.includes(header))) throw _ecsQueryError_('SCHEMA_INVALID');
  return { sheet, headers };
}

function _ecsAppendCells_(target, row) {
  return { appendCells: { sheetId: target.sheet.getSheetId(), fields: 'userEnteredValue', rows: [{
    // Explicit strings preserve phone numbers and prevent formula interpretation.
    values: target.headers.map(header => ({ userEnteredValue: { stringValue: String(row[header] == null ? '' : row[header]) } }))
  }] } };
}

function _ecsLeadSummary_(row) {
  return { leadId: String(row['Lead ID']), name: String(row['Company Name'] || ''), city: String(row.City || ''), state: String(row.State || '') };
}
function _ecsCheckQueryLead_(request) {
  assertServerContext_();
  if (typeof request.companyName !== 'string' || request.companyName.length > 300 || typeof request.phone !== 'string' || request.phone.length > 40 || typeof request.email !== 'string' || request.email.length > 254) throw _ecsQueryError_('INVALID_REQUEST');
  const company = _leadNormText_(request.companyName), phone = _leadNormPhone_(request.phone), email = _leadNormEmail_(request.email);
  const verifyLeadIds = request.verifyLeadIds || [];
  if (!Array.isArray(verifyLeadIds) || verifyLeadIds.length > 52 || verifyLeadIds.some(id => typeof id !== 'string' || !id || id.length > 160)) throw _ecsQueryError_('INVALID_REQUEST');
  const rows = _leadMasterLookupRows_(['Lead ID', 'Company Name', 'Phone', 'Alternate No', 'Email', 'City', 'State', 'Source Lead ID']);
  const matches = rows.filter(row => !(request.excludeQueryLead === true && String(row['Source Lead ID'] || '') === request.queryId) && (
    (company && _leadNormText_(row['Company Name']) === company) ||
    (phone && (_leadNormPhone_(row.Phone) === phone || _leadNormPhone_(row['Alternate No']) === phone)) ||
    (email && _leadNormEmail_(row.Email) === email)
  ));
  // Verify exact IDs against the master, including renamed leads and manual deletions.
  // An empty name-match result alone cannot prove that a selected lead was deleted.
  const verifiedLeads = rows.filter(row => verifyLeadIds.includes(String(row['Lead ID']))).map(_ecsLeadSummary_);
  return { matches: matches.slice(0, 50).map(_ecsLeadSummary_), total: matches.length,
    verifiedLeads, missingLeadIds: verifyLeadIds.filter(id => !verifiedLeads.some(lead => lead.leadId === id)) };
}
function _ecsRows_(target) {
  const count = target.sheet.getLastRow();
  if (count < 2) return [];
  return target.sheet.getRange(2, 1, count - 1, target.headers.length).getValues().map((values, index) => ({
    rowNumber: index + 2, data: target.headers.reduce((row, key, i) => { row[key] = normalizeSheetValue(values[i]); return row; }, {})
  }));
}
function _ecsUpdateCell_(target, rowNumber, field, value) {
  const column = target.headers.indexOf(field);
  if (column < 0) throw _ecsQueryError_('SCHEMA_INVALID');
  return { updateCells: { range: { sheetId: target.sheet.getSheetId(), startRowIndex: rowNumber - 1, endRowIndex: rowNumber, startColumnIndex: column, endColumnIndex: column + 1 }, fields: 'userEnteredValue', rows: [{ values: [{ userEnteredValue: { stringValue: String(value) } }] }] } };
}
function _ecsContinueQueryLead_(request) {
  assertServerContext_(); _ecsValidateLeadRequest_(request, true);
  if (typeof request.leadId !== 'string' || !request.leadId.trim() || request.leadId.length > 160) throw _ecsQueryError_('INVALID_REQUEST');
  const leads = _ecsQuerySheet_(SHEET_NAMES.LEADS, ['Lead ID', 'Company Name']);
  const followups = _ecsQuerySheet_(SHEET_NAMES.FOLLOWUPS, ['Follow-up ID', 'Lead ID', 'Planned Date', 'Follow-up Date', 'Follow-up Type', 'Next Follow-up Date', 'Created By', 'Discussion', 'Status', 'Stage ID', 'Created At', 'Updated At']);
  const lock = LockService.getScriptLock(); lock.waitLock(10000);
  let lead, followup, reused = false;
  try {
    _invalidateReadCache_();
    lead = _findExternalLeadInSheet_(leads.sheet, leads.headers, 'Lead ID', request.leadId);
    if (!lead) throw _ecsQueryError_('LEAD_NOT_FOUND');
    const marker = '[ECS query ' + request.queryId.toLowerCase() + ']';
    const rows = _ecsRows_(followups);
    const previous = rows.find(row => String(row.data.Discussion || '').includes(marker) || row.data['Follow-up ID'] === 'ECS-FU-' + request.queryId.toLowerCase());
    if (previous && String(previous.data['Lead ID']) !== request.leadId) throw _ecsQueryError_('INCOMPLETE_PUSH');
    const candidates = rows.filter(row => String(row.data['Lead ID']) === request.leadId && row.data['Follow-up ID']).reverse();
    const selected = previous || candidates.find(row => !/^(closed|completed|done|cancelled|canceled)$/i.test(String(row.data.Status || '').trim())) || candidates[0];
    const note = [marker, 'Pushed from ECS query', 'Reference: ' + request.reference, 'Subject: ' + request.subject, request.message, request.remark ? 'Remark: ' + request.remark : '', 'Linked by: ' + request.actor].filter(Boolean).join('\n\n');
    const timestamp = now();
    if (selected) {
      reused = true; followup = selected.data;
      const discussion = String(followup.Discussion || '');
      if (!discussion.includes(marker)) {
        followup.Discussion = discussion ? discussion + '\n\n' + note : note;
        followup['Updated At'] = timestamp;
        Sheets.Spreadsheets.batchUpdate({ requests: [_ecsUpdateCell_(followups, selected.rowNumber, 'Discussion', followup.Discussion), _ecsUpdateCell_(followups, selected.rowNumber, 'Updated At', timestamp)] }, CLIENT_CONFIG.SPREADSHEET_ID);
      }
    } else {
      if (!request.assignedTo || !request.followupDate) throw _ecsQueryError_('FOLLOWUP_DETAILS_REQUIRED');
      const user = _ecsAssignableUsers_().find(user => user.id === request.assignedTo);
      if (!user) throw _ecsQueryError_('INVALID_ASSIGNEE');
      followup = { 'Follow-up ID': 'ECS-FU-' + request.queryId.toLowerCase(), 'Lead ID': request.leadId,
        'Planned Date': request.followupDate, 'Follow-up Date': request.followupDate,
        'Follow-up Type': getConfigByType('Follow-up Type')[0] || 'Call', 'Discussion': note,
        'Next Follow-up Date': request.followupDate, 'Status': 'Open', 'Stage ID': String(lead['Stage ID'] || ''),
        'Created By': user.id, 'Created At': timestamp, 'Updated At': timestamp };
      // Guard deterministic IDs even if another lead was selected on a retry.
      if (_findExternalLeadInSheet_(followups.sheet, followups.headers, 'Follow-up ID', followup['Follow-up ID'])) throw _ecsQueryError_('INCOMPLETE_PUSH');
      const leadRow = findRowIndexWithoutIndex_(SHEET_NAMES.LEADS, 'Lead ID', request.leadId);
      if (leadRow < 2) throw _ecsQueryError_('LEAD_NOT_FOUND');
      lead['Next Follow-up Date'] = request.followupDate; lead['Updated At'] = timestamp;
      Sheets.Spreadsheets.batchUpdate({ requests: [_ecsAppendCells_(followups, followup), _ecsUpdateCell_(leads, leadRow, 'Next Follow-up Date', request.followupDate), _ecsUpdateCell_(leads, leadRow, 'Updated At', timestamp)] }, CLIENT_CONFIG.SPREADSHEET_ID);
    }
  } finally { lock.releaseLock(); }
  _invalidateReadCache_();
  const rowNumber = findRowIndexWithoutIndex_(SHEET_NAMES.FOLLOWUPS, 'Follow-up ID', followup['Follow-up ID']);
  if (rowNumber < 2) throw _ecsQueryError_('INCOMPLETE_PUSH');
  const safe = Object.keys(followup).reduce((row, key) => { row[key] = neutralizeSheetFormula_(followup[key]); return row; }, {});
  syncIndexRow_(SHEET_NAMES.FOLLOWUPS, safe, rowNumber); _bumpStamp('followups');
  const leadRow = findRowIndexWithoutIndex_(SHEET_NAMES.LEADS, 'Lead ID', request.leadId);
  syncIndexRow_(SHEET_NAMES.LEADS, Object.keys(lead).reduce((row, key) => { row[key] = neutralizeSheetFormula_(lead[key]); return row; }, {}), leadRow); _bumpStamp('leads');
  return { queryId: request.queryId, portalKey: request.portalKey, leadId: request.leadId, followupId: String(followup['Follow-up ID']), alreadyPushed: reused, reusedFollowup: reused, lead: _ecsLeadSummary_(lead) };
}

function _ecsCreateQueryLead_(request) {
  assertServerContext_();
  _ecsValidateLeadRequest_(request);
  const leadId = 'ECS-' + request.queryId.toLowerCase(), followupId = 'ECS-FU-' + request.queryId.toLowerCase();
  const leads = _ecsQuerySheet_(SHEET_NAMES.LEADS, ['Lead ID', 'Company Name', 'Contact Person', 'Phone', 'Email', 'City', 'State', 'Address', 'Stage ID', 'Lead Status', 'Assigned To', 'Source Portal', 'Source Lead ID', 'Client Description', 'Next Follow-up Date', 'Created At', 'Updated At']);
  const followups = _ecsQuerySheet_(SHEET_NAMES.FOLLOWUPS, ['Follow-up ID', 'Lead ID', 'Planned Date', 'Follow-up Date', 'Follow-up Type', 'Discussion', 'Next Follow-up Date', 'Status', 'Stage ID', 'Created By', 'Created At', 'Updated At']);
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  let alreadyPushed = false, lead, followup;
  try {
    _invalidateReadCache_();
    lead = _findExternalLeadInSheet_(leads.sheet, leads.headers, 'Lead ID', leadId);
    followup = _findExternalLeadInSheet_(followups.sheet, followups.headers, 'Follow-up ID', followupId);
    if (lead || followup) {
      if (!lead || !followup || String(followup['Lead ID']) !== leadId || String(lead['Source Lead ID']) !== request.queryId) throw _ecsQueryError_('INCOMPLETE_PUSH');
      alreadyPushed = true;
    } else {
      const user = _ecsAssignableUsers_().find(user => user.id === request.assignedTo);
      if (!user) throw _ecsQueryError_('INVALID_ASSIGNEE');
      const stages = getActiveStages().filter(stage => stage['Is Final Stage'] !== true && stage['Is Final Stage'] !== 'TRUE');
      const stage = stages.find(stage => stage['Is Initial Stage'] === true || stage['Is Initial Stage'] === 'TRUE') || stages[0];
      if (!stage || !stage['Stage ID']) throw _ecsQueryError_('INVALID_STAGE');
      const timestamp = now();
      const description = ['Pushed from ECS query', 'Reference: ' + request.reference, 'Query type: ' + request.kind, 'Subject: ' + request.subject, request.message, request.remark ? 'Remark: ' + request.remark : '', 'Pushed by: ' + request.actor].filter(Boolean).join('\n\n');
      lead = {
        'Lead ID': leadId, 'Company Name': toProperCase_(request.companyName), 'Contact Person': toProperCase_(request.contact),
        'Phone': request.phone, 'Email': request.email, 'City': request.city, 'State': request.state, 'Address': request.address,
        'Stage ID': stage['Stage ID'], 'Lead Status': 'Open', 'Assigned To': user.id,
        'Source': 'ECS query', 'Source Portal': 'ECS query', 'Source Lead ID': request.queryId,
        'Client Description': description, 'Next Follow-up Date': request.followupDate,
        'Last Follow-up Date': request.followupDate, 'Stage Updated At': timestamp, 'Created At': timestamp, 'Updated At': timestamp,
      };
      try { lead = _prepareLeadPayload(lead, stage['Stage ID'], {}, false, { allowEmptyGlobalOnCreate: true }); }
      catch (_) { throw _ecsQueryError_('INVALID_LEAD_FIELDS'); }
      if (_leadDuplicateMessage_(lead, '')) throw _ecsQueryError_('DUPLICATE_LEAD');
      followup = {
        'Follow-up ID': followupId, 'Lead ID': leadId, 'Planned Date': request.followupDate,
        'Follow-up Date': request.followupDate, 'Follow-up Type': getConfigByType('Follow-up Type')[0] || 'Call',
        'Discussion': description, 'Outcome': 'Open', 'Next Follow-up Date': request.followupDate,
        'Next Action': 'Respond to ECS query', 'Status': 'Open', 'Stage ID': stage['Stage ID'],
        'Created By': user.id, 'Created At': timestamp, 'Updated At': timestamp,
      };
      // One atomic Sheets request: neither business row is saved on validation failure.
      Sheets.Spreadsheets.batchUpdate({ requests: [_ecsAppendCells_(leads, lead), _ecsAppendCells_(followups, followup)] }, CLIENT_CONFIG.SPREADSHEET_ID);
    }
  } finally { lock.releaseLock(); }
  // These are retried even for an existing transfer, repairing an interrupted acknowledgement.
  _invalidateReadCache_();
  const leadRow = findRowIndexWithoutIndex_(SHEET_NAMES.LEADS, 'Lead ID', leadId);
  const followupRow = findRowIndexWithoutIndex_(SHEET_NAMES.FOLLOWUPS, 'Follow-up ID', followupId);
  if (leadRow < 2 || followupRow < 2) throw _ecsQueryError_('INCOMPLETE_PUSH');
  const safeIndexRow = row => Object.keys(row).reduce((safe, key) => { safe[key] = neutralizeSheetFormula_(row[key]); return safe; }, {});
  syncIndexRow_(SHEET_NAMES.LEADS, safeIndexRow(lead), leadRow);
  syncIndexRow_(SHEET_NAMES.FOLLOWUPS, safeIndexRow(followup), followupRow);
  _bumpStamp('leads'); _bumpStamp('followups');
  return { queryId: request.queryId, portalKey: request.portalKey, leadId, followupId, alreadyPushed };
}
