// Callyzer's unsigned call webhook. Only doPost enters this path; management
// remains behind the portal's configuration permission.
const CALLYZER_ENABLED_KEY_ = 'CALLYZER_WEBHOOK_ENABLED';
const CALL_WEBHOOK_DELIVERIES_ = 'CALL_WEBHOOK_DELIVERIES';
const CALL_HISTORY_HEADERS_ = ['Call ID','Call Date','Call Time','Call Duration Seconds','Call Recording URL','Call Updated At'];

function _callWebhookSettings_() {
  assertServerContext_();
  const url = ScriptApp.getService().getUrl() || '';
  return {
    enabled: PropertiesService.getScriptProperties().getProperty(CALLYZER_ENABLED_KEY_) === 'true',
    url: url ? url.split('?')[0] + '?webhook=callyzer' : '',
    timeZone: Session.getScriptTimeZone()
  };
}

function _callWebhookPage_() {
  const settings = _callWebhookSettings_();
  const sheet = getSpreadsheet(CALL_WEBHOOK_DELIVERIES_).getSheetByName(CALL_WEBHOOK_DELIVERIES_);
  const deliveries = sheet && sheet.getLastRow() > 1
    ? sheet.getRange(Math.max(2, sheet.getLastRow() - 29), 1, Math.min(30, sheet.getLastRow() - 1), 2).getValues()
      .reverse().map(row => { try { return JSON.parse(row[1]); } catch (_) { return null; } }).filter(Boolean)
    : [];
  const users = getUsersWithPortalAccess_('', false).map(u => ({ id: String(u['ID'] || u['User ID'] || ''), name: String(u['Name'] || u['Title'] || '') })).filter(u => u.id);
  return { ...settings, deliveries, users };
}

function _saveCallWebhook_(payload) {
  requireConfigEditor();
  if (!payload || typeof payload.enabled !== 'boolean') throw new Error('Enabled must be a boolean.');
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    if (payload.enabled) _ensureCallWebhookSheets_();
    PropertiesService.getScriptProperties().setProperty(CALLYZER_ENABLED_KEY_, String(payload.enabled));
    return _callWebhookSettings_();
  } finally { lock.releaseLock(); }
}

function _ensureCallWebhookSheets_() {
  ensureFollowupSheets_();
  safeInitHeaders(SHEET_NAMES.FOLLOWUP_HISTORY, CALL_HISTORY_HEADERS_);
  safeInitHeaders(CALL_WEBHOOK_DELIVERIES_, ['Received At','Result']);
}

function _callWebhookLog_(result) {
  const sheet = getSheet(CALL_WEBHOOK_DELIVERIES_);
  sheet.getRange(sheet.getLastRow() + 1, 1, 1, 2).setValues([[result.receivedAt, JSON.stringify(result)]]);
  if (sheet.getLastRow() > 101) sheet.deleteRows(2, sheet.getLastRow() - 101);
}

function _callPhone_(value, countryCode) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw || !/^[+\d\s().-]+$/.test(raw)) return '';
  let digits = raw.replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  const country = String(countryCode || '').replace(/\D/g, '') || '91';
  if (digits.length === 11 && digits[0] === '0') digits = digits.slice(1);
  if (digits.length === 10) digits = country + digits;
  return digits.length >= 11 && digits.length <= 15 ? digits : '';
}

function _callText_(value, limit) {
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim().slice(0, limit) : '';
}

function _callRecordingUrl_(value) {
  const url = _callText_(value, 2049);
  return url.length <= 2048 && /^https:\/\/[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::\d{1,5})?(?:[/?#][^\s<>"'\\]*)?$/i.test(url) ? url : '';
}

function _callDateTime_(date, time) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(time)) return '';
  const parsed = new Date(date + 'T00:00:00Z');
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date ? date + ' ' + time : '';
}

function _normalizeCall_(employee, call) {
  if (!call || typeof call !== 'object' || Array.isArray(call)) return null;
  const id = _callText_(call.id, 201);
  const phone = _callPhone_(call.client_number, call.client_country_code);
  const date = _callText_(call.call_date, 11), time = _callText_(call.call_time, 9);
  const duration = String(call.duration == null ? '' : call.duration);
  const type = _callText_(call.call_type, 40);
  if (!id || id.length > 200 || !phone || !_callDateTime_(date, time) || !/^\d+$/.test(duration) || Number(duration) > 604800 || !type) return null;
  const modified = _callText_(call.modified_at || call.synced_at, 20);
  const revision = modified && _callDateTime_(modified.slice(0, 10), modified.slice(11));
  if (modified && !revision) return null;
  return {
    id, phone, date, time, duration: Number(duration), type,
    note: _callText_(call.note, 10000), outcome: _callText_(call.crm_status, 200),
    employee: _callText_(employee.emp_name, 150) || _callText_(employee.emp_code, 100) || 'Callyzer',
    method: _callText_(call.call_method, 40), mode: _callText_(call.call_mode, 40),
    recording: _callRecordingUrl_(call.call_recording_url),
    revision: revision || date + ' ' + time
  };
}

function _callHistoryRecord_(call, lead, existing) {
  const summary = [call.type, call.method, call.mode].filter(Boolean).join(' / ');
  return {
    ...(existing || {}),
    'History ID': 'CALLYZER:' + call.id,
    'Lead ID': lead['Lead ID'],
    'Done Date': call.date,
    'Done By': call.userId,
    'Follow-up Type': 'Call',
    'Contact Mode': call.type,
    'Remark': [call.note, call.outcome ? 'Call result: ' + call.outcome : '', summary].filter(Boolean).join('\n'),
    'Outcome': call.outcome,
    'Stage ID': existing ? existing['Stage ID'] : lead['Stage ID'] || '',
    'Created At': existing ? existing['Created At'] : now(),
    'Call ID': call.id,
    'Call Date': call.date,
    'Call Time': call.time,
    'Call Duration Seconds': call.duration,
    'Call Recording URL': call.recording,
    'Call Updated At': call.revision
  };
}

function _receiveCallyzer_(raw) {
  assertServerContext_();
  if (typeof raw !== 'string' || raw.length > 1000000) return { success: false, code: 'PAYLOAD_TOO_LARGE' };
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return { success: false, code: 'BUSY', retry: true };
  let touched = false;
  let result;
  try {
    if (!_callWebhookSettings_().enabled) return { success: false, code: 'WEBHOOK_DISABLED' };
    _ensureCallWebhookSheets_();
    result = { receivedAt: now(), success: true, total: 0, added: 0, updated: 0, duplicate: 0, unmatched: 0, ambiguous: 0, invalid: 0, invalidUser: 0, issues: [] };
    let employees;
    try { employees = JSON.parse(raw); } catch (_) { employees = null; }
    if (!Array.isArray(employees) || !employees.length || employees.length > 100 || employees.some(e => !e || !Array.isArray(e.call_logs))) {
      Object.assign(result, { success: false, code: 'INVALID_PAYLOAD' });
      _callWebhookLog_(result);
      return result;
    }
    result.total = employees.reduce((sum, e) => sum + e.call_logs.length, 0);
    if (!result.total || result.total > 200) {
      Object.assign(result, { success: false, code: 'BATCH_LIMIT', maximumCalls: 200 });
      _callWebhookLog_(result);
      return result;
    }
    const users = new Map(getUsersWithPortalAccess_('', false).map(u => [String(u['ID'] || u['User ID'] || '').trim().toLowerCase(), String(u['ID'] || u['User ID'] || '')]));
    const leads = getAllRows(SHEET_NAMES.LEADS).filter(l => !safeBooleanValue_(l['Is Archived']) && String(l['Lead Status'] || '').toLowerCase() !== 'archived');
    const byPhone = new Map();
    leads.forEach(lead => {
      new Set([_callPhone_(lead.Phone), _callPhone_(lead['Alternate No'])].filter(Boolean)).forEach(phone => {
        if (!byPhone.has(phone)) byPhone.set(phone, []);
        byPhone.get(phone).push(lead);
      });
    });
    const sheet = getSheet(SHEET_NAMES.FOLLOWUP_HISTORY);
    const headers = getHeaders(SHEET_NAMES.FOLLOWUP_HISTORY);
    const values = sheet.getDataRange().getValues();
    const existing = new Map();
    values.slice(1).forEach((row, i) => {
      const record = rowObjectFromHeaders_(headers, row, true, SHEET_NAMES.FOLLOWUP_HISTORY);
      if (record['Call ID']) existing.set(String(record['Call ID']), { record, row: i + 2 });
    });
    const issue = (status, input) => {
      result[status]++;
      if (result.issues.length < 20) result.issues.push({ status, callId: _callText_(input && input.id, 200) });
    };
    employees.forEach(employee => employee.call_logs.forEach(input => {
      const tags = Array.isArray(employee.emp_tags) ? employee.emp_tags : [];
      const ids = [...new Set(tags.map(tag => _callText_(tag, 250).replace(/^id\s*=\s*/i, '').toLowerCase()).filter(tag => users.has(tag)))];
      if (ids.length !== 1) { issue('invalidUser', input); return; }
      const call = _normalizeCall_(employee, input);
      if (!call) { issue('invalid', input); return; }
      call.userId = users.get(ids[0]);
      const matches = byPhone.get(call.phone) || [];
      if (matches.length !== 1) { issue(matches.length ? 'ambiguous' : 'unmatched', input); return; }
      const prior = existing.get(call.id);
      if (prior && (prior.record['Lead ID'] !== matches[0]['Lead ID'] || prior.record['Done By'] !== call.userId)) { issue('ambiguous', input); return; }
      if (prior && String(prior.record['Call Updated At']) >= call.revision) { result.duplicate++; return; }
      const record = _callHistoryRecord_(call, matches[0], prior && prior.record);
      const row = prior ? prior.row : sheet.getLastRow() + 1;
      // Keep the idempotency read and write under one lock. insertRow/updateRow
      // acquire and release that same lock, so use the sheet directly here.
      touched = true;
      sheet.getRange(row, 1, 1, headers.length).setNumberFormat('@').setValues([sanitizeSheetRowValues_(headers.map(h => record[h] === undefined ? '' : record[h]))]);
      existing.set(call.id, { record, row });
      result[prior ? 'updated' : 'added']++;
    }));
    _callWebhookLog_(result);
    // Counts acknowledge delivery without disclosing lead identities or call content.
    const { issues, ...receipt } = result;
    return receipt;
  } catch (error) {
    if (result) {
      try { _callWebhookLog_({ ...result, success: false, code: 'PROCESSING_FAILED', retry: true }); } catch (_) {}
    }
    throw error;
  } finally {
    try {
      if (touched) { SpreadsheetApp.flush(); _invalidateReadCache_(); _bumpStamp('followup_history'); }
    } finally { lock.releaseLock(); }
  }
}
