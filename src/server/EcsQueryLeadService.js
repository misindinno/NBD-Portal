// Shared by all NBD/LQ deployments. Only signed server requests can call this receiver.
// Install beside Code.js. Uses the portal's existing FSR_WEBHOOK_SECRET unless overridden.
function _ecsQueryWebhook_(raw) {
  return withRequestContext_('ecsQueryLead', () => withServerContext_(() => {
    let result;
    try {
      const request = _ecsVerifyQueryRequest_(raw);
      if (request.action === 'options') result = { users: _ecsAssignableUsers_() };
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

function _ecsValidateLeadRequest_(request) {
  const bounds = { queryId: 36, reference: 100, companyName: 300, contact: 200, phone: 40, email: 254, city: 120, state: 120, address: 800, subject: 200, message: 5000, kind: 40, actor: 254, assignedTo: 254, followupDate: 10, remark: 2000 };
  Object.keys(bounds).forEach(key => {
    if (typeof request[key] !== 'string' || request[key].length > bounds[key]) throw _ecsQueryError_('INVALID_REQUEST');
  });
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(request.queryId) || !request.companyName.trim() || !request.assignedTo.trim() || !/^\d{4}-\d{2}-\d{2}$/.test(request.followupDate)) throw _ecsQueryError_('INVALID_REQUEST');
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
