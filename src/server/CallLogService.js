// Canonical call records. Private helpers are used only inside trusted server context.
const CALL_LOG_SHEET_ = 'CALL_LOGS';
const CALL_LOG_HEADERS_ = ['Call ID','Lead ID','User ID','User Name','Employee Name','Employee Number','Customer Name','Customer Number','Call Date','Call Time','Duration','Type','Method','Mode','Note','Outcome','Recording URL','Revision','Match Status','Match Source','Conflict','Stage ID','Legacy Remark','Created At','Updated At','Mapped By','Mapped At'];

function _callTable_(name) {
  assertServerContext_();
  const sheet = getSpreadsheet(name).getSheetByName(name);
  if (!sheet) return { sheet: null, headers: [], rows: [] };
  const data = sheet.getDataRange().getValues();
  const headers = (data[0] || []).map(String);
  return { sheet, headers, rows: data.slice(1).map((values, i) => ({ row: i + 2, record: rowObjectFromHeaders_(headers, values, true, name) })) };
}

function _writeCallRow_(table, record, row) {
  const target = row || table.sheet.getLastRow() + 1;
  table.sheet.getRange(target, 1, 1, table.headers.length).setNumberFormat('@').setValues([sanitizeSheetRowValues_(table.headers.map(h => record[h] === undefined ? '' : record[h]))]);
  return target;
}

function _ensureCallStorageLocked_() {
  safeInitHeaders(CALL_LOG_SHEET_, CALL_LOG_HEADERS_);
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('CALL_HISTORY_MIGRATED_V1') === 'true') return;
  const table = _callTable_(CALL_LOG_SHEET_);
  const ids = new Set(table.rows.map(r => String(r.record['Call ID'])));
  const history = _callTable_(SHEET_NAMES.FOLLOWUP_HISTORY).rows;
  const users = new Map(getUsersWithPortalAccess_('', true).map(u => [String(u.ID || u['User ID']), u.Name || u.Title || 'Anonymous user']));
  let moved = 0;
  for (const { record: old } of history) {
    const id = String(old['Call ID'] || '');
    if (!id || ids.has(id)) continue;
    if (moved >= 200) return; // Resume safely on the next read/worker run.
    const caller = String(old['Done By'] || '');
    _writeCallRow_(table, {
      'Call ID': id, 'Lead ID': old['Lead ID'] || '', 'User ID': users.has(caller) ? caller : '',
      'User Name': users.get(caller) || 'Anonymous user', 'Call Date': old['Call Date'] || old['Done Date'] || '',
      'Call Time': old['Call Time'] || '', Duration: old['Call Duration Seconds'] || 0,
      Type: old['Contact Mode'] || 'Call', 'Recording URL': old['Call Recording URL'] || '',
      Revision: old['Call Updated At'] || '', 'Match Status': old['Lead ID'] ? 'Matched' : 'Unmatched',
      'Match Source': 'Legacy', 'Legacy Remark': old.Remark || '', Outcome: old.Outcome || '',
      'Stage ID': old['Stage ID'] || '', 'Created At': old['Created At'] || now(), 'Updated At': now()
    });
    ids.add(id); moved++;
  }
  props.setProperty('CALL_HISTORY_MIGRATED_V1', 'true');
}

function _prepareCallStorage_() {
  const lock = LockService.getScriptLock(); lock.waitLock(10000);
  try { _ensureCallStorageLocked_(); } finally { lock.releaseLock(); }
}

function _resolveCallUser_(tags, users) {
  const lookup = new Map(users.map(u => [String(u.ID || u['User ID'] || '').toLowerCase(), u]));
  const ids = [...new Set((Array.isArray(tags) ? tags : []).map(t => _callText_(t, 250).replace(/^id\s*=\s*/i, '').toLowerCase()).filter(t => lookup.has(t)))];
  if (ids.length !== 1) return { id: '', name: 'Anonymous user' };
  const user = lookup.get(ids[0]);
  return { id: String(user.ID || user['User ID']), name: String(user.Name || user.Title || 'Portal user') };
}

function _callPhoneIndex_(leads) {
  const index = new Map();
  leads.filter(l => !safeBooleanValue_(l['Is Archived']) && String(l['Lead Status']).toLowerCase() !== 'archived').forEach(lead => {
    new Set([_callPhone_(lead.Phone), _callPhone_(lead['Alternate No'])].filter(Boolean)).forEach(phone => {
      if (!index.has(phone)) index.set(phone, []);
      index.get(phone).push(lead);
    });
  });
  return index;
}

function _mergeCallRecord_(call, caller, prior, byPhone) {
  const old = prior || {};
  const record = { ...old };
  const fresh = !prior || call.revision > String(old.Revision || '');
  const equal = call.revision === String(old.Revision || '');
  if (!prior) Object.assign(record, { 'Call ID': call.id, 'User ID': '', 'User Name': 'Anonymous user', 'Created At': now() });
  if (fresh || equal) {
    const changedNumber = old['Customer Number'] && old['Customer Number'] !== call.phone;
    if (changedNumber) record.Conflict = 'Customer number changed for an existing call. Review the original mapping.';
    else record['Customer Number'] = call.phone;
    if (fresh) Object.assign(record, { 'Call Date': call.date, 'Call Time': call.time, Duration: call.duration, Type: call.type, Revision: call.revision });
    const optional = { Note: call.note, Outcome: call.outcome, 'Recording URL': call.recording, Method: call.method, Mode: call.mode, 'Customer Name': call.customerName, 'Employee Name': call.employee, 'Employee Number': call.employeeNumber };
    Object.keys(optional).forEach(key => { if (optional[key] && (fresh || !record[key])) record[key] = optional[key]; });
  }
  if (caller.id && !record['User ID']) { record['User ID'] = caller.id; record['User Name'] = caller.name; }
  else if (caller.id && caller.id === record['User ID']) record['User Name'] = caller.name;
  else if (caller.id && record['User ID'] && (fresh || equal)) record.Conflict = 'A different employee tag was supplied for this call.';
  if (!record['Lead ID']) {
    const matches = byPhone.get(record['Customer Number']) || [];
    if (matches.length === 1) Object.assign(record, { 'Lead ID': matches[0]['Lead ID'], 'Stage ID': matches[0]['Stage ID'] || '', 'Match Source': 'Phone' });
    record['Match Status'] = matches.length > 1 ? 'Needs Review' : record['Lead ID'] ? 'Matched' : 'Unmatched';
  } else record['Match Status'] = 'Matched';
  if (record.Conflict) record['Match Status'] = 'Needs Review';
  const changed = JSON.stringify(record) !== JSON.stringify(old);
  if (changed) record['Updated At'] = now();
  return { record, changed };
}

function _callUpsertContext_() {
  _ensureCallStorageLocked_();
  const table = _callTable_(CALL_LOG_SHEET_);
  const existing = new Map(table.rows.map(r => [String(r.record['Call ID']), r]));
  const users = getUsersWithPortalAccess_('', false);
  const byPhone = _callPhoneIndex_(getAllRows(SHEET_NAMES.LEADS));
  return { table, existing, users, byPhone };
}

function _upsertCallsLocked_(items, context) {
  const { table, existing, users, byPhone } = context || _callUpsertContext_();
  const counts = { added: 0, updated: 0, duplicate: 0, anonymous: 0, unmatched: 0, ambiguous: 0 };
  items.forEach(call => {
    const caller = _resolveCallUser_(call.tags, users);
    const prior = existing.get(call.id);
    const { record, changed } = _mergeCallRecord_(call, caller, prior && prior.record, byPhone);
    if (!record['User ID']) counts.anonymous++;
    if (record['Match Status'] === 'Unmatched') counts.unmatched++;
    if (record['Match Status'] === 'Needs Review') counts.ambiguous++;
    if (!changed) { counts.duplicate++; return; }
    const row = _writeCallRow_(table, record, prior && prior.row);
    existing.set(call.id, { record, row });
    counts[prior ? 'updated' : 'added']++;
  });
  if (context) context.dirty = true;
  else { SpreadsheetApp.flush(); _invalidateReadCache_(); _bumpStamp('followup_history'); _bumpStamp('calls'); }
  return counts;
}

function _callHistoryProjection_(row) {
  return {
    'History ID': 'CALLYZER:' + row['Call ID'], 'Call ID': row['Call ID'], 'Lead ID': row['Lead ID'],
    'Done Date': row['Call Date'], 'Done By': row['User ID'] || 'Anonymous user',
    'Follow-up Type': 'Call', 'Contact Mode': row.Type,
    Remark: row.Note || row.Outcome ? [row.Note, row.Outcome ? 'Call result: ' + row.Outcome : ''].filter(Boolean).join('\n') : row['Legacy Remark'] || [row.Type, row.Method, row.Mode].filter(Boolean).join(' / '),
    'Stage ID': row['Stage ID'], 'Created At': row['Call Date'] + ' ' + row['Call Time'],
    'Call Date': row['Call Date'], 'Call Time': row['Call Time'], 'Call Duration Seconds': row.Duration,
    'Call Recording URL': row['Recording URL'], 'Call Updated At': row.Revision
  };
}

function _mergeCallHistory_(legacy) {
  const rows = _callTable_(CALL_LOG_SHEET_).rows.map(r => r.record);
  const ids = new Set(rows.map(r => String(r['Call ID'])));
  return legacy.filter(r => !r['Call ID'] || !ids.has(String(r['Call ID']))).concat(rows.filter(r => r['Lead ID']).map(_callHistoryProjection_));
}

function _canManageUnmatchedCalls_(user) {
  return user.role === 'ADMIN' || (user.role === 'MANAGER' && canEditConfigPermission(user));
}

function _canMapCalls_(user) {
  return ['ADMIN','MANAGER','SALES'].includes(user.role) && (user.role === 'ADMIN' || userHasModule(user, 'Leads'));
}

function _callVisible_(call, user, visibleLeadIds) {
  return call['Lead ID'] ? visibleLeadIds.has(String(call['Lead ID'])) : _canManageUnmatchedCalls_(user);
}

function _getCallLogs_(user, options) {
  _prepareCallStorage_();
  const q = options || {};
  const leads = getAllRows(SHEET_NAMES.LEADS);
  const visible = _scopeAssignedRows(leads, user);
  const ids = new Set(visible.map(l => String(l['Lead ID'])));
  if (q.leadId && !ids.has(String(q.leadId))) throw new Error('Lead not found.');
  const leadMap = new Map(visible.map(l => [String(l['Lead ID']), l]));
  let rows = _callTable_(CALL_LOG_SHEET_).rows.map(r => r.record).filter(r => _callVisible_(r, user, ids));
  if (q.leadId) rows = rows.filter(r => r['Lead ID'] === q.leadId);
  const counts = { all: rows.length, Matched: 0, Unmatched: 0, 'Needs Review': 0 };
  rows.forEach(r => counts[r['Match Status']] = (counts[r['Match Status']] || 0) + 1);
  const callers = [...new Map(rows.map(r => [r['User ID'] || '', { id: r['User ID'] || '', name: r['User Name'] || 'Anonymous user' }])).values()];
  if (q.status && q.status !== 'all') rows = rows.filter(r => r['Match Status'] === q.status);
  if (q.from) rows = rows.filter(r => r['Call Date'] >= q.from);
  if (q.to) rows = rows.filter(r => r['Call Date'].slice(0, 10) <= q.to);
  if (q.caller !== undefined && q.caller !== 'all') rows = rows.filter(r => String(r['User ID'] || '') === q.caller);
  if (q.type && q.type !== 'all') rows = rows.filter(r => r.Type === q.type);
  const search = String(q.search || '').toLowerCase().slice(0, 200);
  if (search) rows = rows.filter(r => [r['Customer Number'],r['Customer Name'],r['User Name'],leadMap.get(r['Lead ID'])?.['Company Name']].join(' ').toLowerCase().includes(search));
  rows.sort((a, b) => (b['Call Date'] + b['Call Time']).localeCompare(a['Call Date'] + a['Call Time']) || String(a['Call ID']).localeCompare(String(b['Call ID'])));
  const pageSize = 25, total = rows.length;
  const page = Math.max(1, Math.min(Math.ceil(total / pageSize) || 1, Math.floor(Number(q.page) || 1)));
  return { rows: rows.slice((page - 1) * pageSize, page * pageSize).map(r => ({ ...r, clientName: leadMap.get(r['Lead ID'])?.['Company Name'] || '', canMap: _canMapCalls_(user) && (!r['Lead ID'] ? _canManageUnmatchedCalls_(user) : false) })), counts, callers, total, page, pageSize, canManageUnmatched: _canManageUnmatchedCalls_(user) };
}

function _callMappingContext_(user, callId, query) {
  if (!_canMapCalls_(user) || !_canManageUnmatchedCalls_(user)) throw new Error('Permission denied.');
  const call = _callTable_(CALL_LOG_SHEET_).rows.find(r => r.record['Call ID'] === callId)?.record;
  if (!call || call['Lead ID']) throw new Error('Unmatched call not found.');
  const search = String(query || '').toLowerCase().slice(0, 150);
  const leads = _scopeAssignedRows(getAllRows(SHEET_NAMES.LEADS), user).filter(l => _canWriteLead(l, user) && !safeBooleanValue_(l['Is Archived']) && String(l['Lead Status']).toLowerCase() !== 'archived' && !_isLeadPushedToNbd_(l));
  const matches = leads.filter(l => !search || [l['Company Name'], l['Contact Person'], l.Phone, l['Alternate No']].join(' ').toLowerCase().includes(search));
  return { call, clients: matches.slice(0, 30).map(l => ({ id: l['Lead ID'], name: l['Company Name'], contact: l['Contact Person'], phone: l.Phone || '', alternate: l['Alternate No'] || '' })), total: matches.length, related: _callTable_(CALL_LOG_SHEET_).rows.filter(r => !r.record['Lead ID'] && r.record['Customer Number'] === call['Customer Number']).length };
}

function _mapCallToClient_(user, payload) {
  requireRole(['ADMIN','MANAGER','SALES']);
  if (!_canMapCalls_(user) || !_canManageUnmatchedCalls_(user)) throw new Error('Permission denied.');
  const p = payload || {}, lock = LockService.getScriptLock(); lock.waitLock(10000);
  let savedLead;
  try {
    _invalidateReadCache_();
    const calls = _callTable_(CALL_LOG_SHEET_);
    const target = calls.rows.find(r => r.record['Call ID'] === p.callId);
    const leads = _callTable_(SHEET_NAMES.LEADS);
    const entry = leads.rows.find(r => r.record['Lead ID'] === p.leadId);
    if (!target || !entry || target.record['Lead ID']) throw new Error('Unmatched call or client not found. Refresh and retry.');
    const lead = entry.record, phone = target.record['Customer Number'];
    if (!_canReadAssignedRow(lead, user) || !_canWriteLead(lead, user) || _isLeadPushedToNbd_(lead) || safeBooleanValue_(lead['Is Archived']) || String(lead['Lead Status']).toLowerCase() === 'archived') throw new Error('Permission denied.');
    if (!phone) throw new Error('Call number is required before mapping.');
    if (String(lead.Phone || '') !== String(p.expectedPhone || '') || String(lead['Alternate No'] || '') !== String(p.expectedAlternate || '')) throw new Error('Invalid mapping: client numbers changed. Refresh and review the mapping again.');
    const already = [lead.Phone, lead['Alternate No']].some(n => _callPhone_(n) === phone);
    let field = !lead.Phone ? 'Phone' : !lead['Alternate No'] ? 'Alternate No' : '';
    if (!already && !field) {
      if (!['Phone','Alternate No'].includes(p.replaceField)) throw new Error('Invalid mapping: choose which existing number to replace.');
      field = p.replaceField;
    }
    const duplicate = leads.rows.some(r => r.record['Lead ID'] !== lead['Lead ID'] && [r.record.Phone,r.record['Alternate No']].some(n => _callPhone_(n) === phone));
    if (duplicate && p.confirmSharedNumber !== true) throw new Error('Invalid mapping: this number belongs to another client. Confirm the shared number before mapping.');
    const affected = p.mapRelated === true ? calls.rows.filter(r => !r.record['Lead ID'] && r.record['Customer Number'] === phone) : [target];
    const nextLead = { ...lead, ...(already ? {} : { [field]: phone }), 'Updated At': now() };
    ensureFollowupSheets_();
    const audit = _callTable_(SHEET_NAMES.LEAD_ACTIVITY_LOGS);
    const auditRow = audit.sheet.getLastRow() + 1;
    let attempted = false;
    try {
      attempted = true;
      _writeCallRow_(leads, nextLead, entry.row);
      affected.forEach(r => _writeCallRow_(calls, { ...r.record, 'Lead ID': p.leadId, 'Stage ID': lead['Stage ID'] || '', 'Match Status': 'Matched', 'Match Source': 'Manual', Conflict: '', 'Mapped By': user.id, 'Mapped At': now(), 'Updated At': now() }, r.row));
      _writeCallRow_(audit, { 'Log ID': generateUUID(), 'Lead ID': p.leadId, 'Action Type': 'Call mapped', 'Old Value': already ? '' : String(lead[field] || ''), 'New Value': phone, Remark: affected.length + ' call(s) mapped; ' + (already ? 'existing contact number retained.' : field + ' updated.'), 'Created By': user.id, 'Created At': now() }, auditRow);
      syncIndexRow_(SHEET_NAMES.LEADS, nextLead, entry.row);
      SpreadsheetApp.flush();
      savedLead = p.leadId;
    } catch (error) {
      if (attempted) {
        _writeCallRow_(leads, lead, entry.row);
        affected.forEach(r => _writeCallRow_(calls, r.record, r.row));
        if (audit.sheet.getLastRow() >= auditRow) audit.sheet.deleteRows(auditRow, 1);
        syncIndexRow_(SHEET_NAMES.LEADS, lead, entry.row);
        SpreadsheetApp.flush();
      }
      throw error;
    }
    return { mapped: affected.length, leadId: p.leadId, contactField: already ? '' : field };
  } finally {
    _invalidateReadCache_(); _bumpStamp('leads'); _bumpStamp('calls'); _bumpStamp('followup_history'); _bumpStamp('activity_logs');
    lock.releaseLock();
    if (savedLead) pushFsrLeadById_(savedLead, 'client.updated');
  }
}
