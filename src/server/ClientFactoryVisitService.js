// Independent inbound office/factory visits. No existing workflow writes.
const CFV_TABLE_ = 'CLIENT_FACTORY_VISITS';
const CFV_EVENTS_ = 'CLIENT_FACTORY_VISIT_EVENTS';
const CFV_HEADERS_ = ['Visit ID','Portal ID','Lead ID','Lead Key','Company','Visitor Name','Phone','Email','Visitor Count','Destination','Site','Host ID','Planned Start','Planned End','Purpose','Requirements','Status','Actual Start','Actual End','Outcome','Next Action','Cancel Reason','Created By','Created At','Updated By','Updated At','Version'];
const CFV_EVENT_HEADERS_ = ['Event ID','Visit ID','Request ID','Request Hash','Actor ID','Event Type','From Status','To Status','Version','Created At'];
const CFV_STATUSES_ = ['New','Scheduled','Completed','Cancelled','No-show'];

function _cfvUser_(write) {
  const user = _requireModule('ClientFactoryVisits');
  if (write && user.role === 'VIEWER') throw new Error('Permission denied. Viewers cannot change visits.');
  return user;
}
function _cfvGrant_(user, module) { return user.role === 'ADMIN' || userHasModule(user, module); }
function _cfvPortal_() { return ScriptApp.getScriptId(); }
function _cfvLeadKey_(id) { return _cfvPortal_() + ':' + encodeURIComponent(id); }
function _cfvText_(value, max, required) {
  const text = String(value == null ? '' : value).trim();
  if (text.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text) || required && !text) throw new Error('Invalid or missing visit field.');
  return text;
}
function _cfvTime_(value, required) {
  const text = _cfvText_(value, 16, required);
  if (!text) return '';
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(text)) throw new Error('Invalid visit date/time.');
  const date = new Date(text + ':00+05:30');
  if (!Number.isFinite(date.getTime()) || Utilities.formatDate(date, 'Asia/Kolkata', "yyyy-MM-dd'T'HH:mm") !== text) throw new Error('Invalid visit date/time.');
  return text;
}
function _cfvTable_(name, required) {
  const sheet = getSpreadsheet(name).getSheetByName(name);
  if (!sheet) return null;
  const values = sheet.getDataRange().getValues();
  const headers = (values[0] || []).map(String);
  if (required.some(h => !headers.includes(h)) || new Set(headers).size !== headers.length) throw new Error('Invalid visit sheet headers. Ask an administrator to initialize the module.');
  // Sheets can coerce date cells even when the original visit was saved as text.
  // google.script.run cannot transport Date objects; normalize before filtering
  // as well so date ranges and edit forms keep the visit's local calendar time.
  const localTimes = ['Planned Start', 'Planned End', 'Actual Start', 'Actual End'];
  const cellValue = (header, value) => {
    if (value == null) return '';
    if (value instanceof Date) {
      if (!Number.isFinite(value.getTime())) return '';
      return localTimes.includes(header)
        ? Utilities.formatDate(value, 'Asia/Kolkata', "yyyy-MM-dd'T'HH:mm")
        : value.toISOString();
    }
    return value;
  };
  const rows = values.slice(1).map((cells, i) => ({ ...Object.fromEntries(headers.map((h, n) => [h, cellValue(h, cells[n])])), _row: i + 2 }));
  return { sheet, headers, rows };
}
function _cfvTables_() {
  assertServerContext_();
  return { visits: _cfvTable_(CFV_TABLE_, CFV_HEADERS_), events: _cfvTable_(CFV_EVENTS_, CFV_EVENT_HEADERS_) };
}
function _cfvInitialize_(user) {
  if (user.role !== 'ADMIN') throw new Error('Permission denied. Only an administrator can initialize visits.');
  const lock = LockService.getScriptLock(); lock.waitLock(10000);
  try {
    safeInitHeaders(CFV_TABLE_, CFV_HEADERS_);
    safeInitHeaders(CFV_EVENTS_, CFV_EVENT_HEADERS_);
    _cfvTables_();
    return { initialized: true };
  } finally { lock.releaseLock(); }
}
function _cfvDirectory_() {
  // Read portal overrides directly; getUsersWithPortalAccess_ initializes its
  // sheet, which this independent module must never do.
  const accessSheet = getSpreadsheet(SHEET_NAMES.USER_PORTAL_ACCESS).getSheetByName(SHEET_NAMES.USER_PORTAL_ACCESS);
  const values = accessSheet ? accessSheet.getDataRange().getValues() : [];
  const headers = values[0] || [];
  const access = values.slice(1).map(cells => Object.fromEntries(headers.map((h, i) => [h, cells[i]])));
  const key = currentPortalKey_();
  const settings = getPortalSettings_();
  return getAllRows(SHEET_NAMES.USERS).map(row => {
    const email = String(row['Email Address'] || '').trim().toLowerCase();
    const id = getStaffUserId(row, email);
    const override = access.find(a => String(a['Portal Key']).toUpperCase() === key && (String(a['User ID']) === id || String(a['Email Address'] || '').toLowerCase() === email));
    return mergeUserPortalAccess_(row, override || null);
  }).filter(row => isActiveUserValue(row['Is Active']) && _userMatchesDepartmentSettings_(row, settings) &&
    getEffectiveUserModules(row, normalizeStaffPermission(row.Permission || row.Role)).length)
    .map(row => ({ id: getStaffUserId(row, String(row['Email Address'] || '').toLowerCase()), name: String(row.Name || ''), department: String(row.Department || '') }));
}
function _cfvCanRead_(row, user, directory) {
  if (String(row['Portal ID']) !== _cfvPortal_()) return false;
  if (user.role === 'ADMIN') return true;
  if (String(row['Created By']) === user.id || String(row['Host ID']) === user.id) return true;
  if (user.role !== 'MANAGER' || !_cfvGrant_(user, 'ClientFactoryVisitsManage')) return false;
  // Directory already applies the portal's department scope.
  return directory.some(host => host.id === String(row['Host ID']));
}
function _cfvCanEdit_(row, user, directory) {
  if (['Completed','Cancelled','No-show'].includes(row.Status) && !_cfvGrant_(user, 'ClientFactoryVisitsManage')) return false;
  return user.role !== 'VIEWER' && _cfvCanRead_(row, user, directory) &&
    (_cfvGrant_(user, 'ClientFactoryVisitsManage') || _cfvGrant_(user, 'ClientFactoryVisitsCreate') && String(row['Created By']) === user.id);
}
function _cfvOptions_(user) {
  const mayReadLeads = user.role === 'ADMIN' || userHasModule(user, 'Leads');
  const leads = mayReadLeads ? _scopeAssignedRows(getAllRows(SHEET_NAMES.LEADS), user).filter(row => !leadArchiveState_(row) && row['Company Name']) : [];
  const seen = new Set(), duplicate = new Set();
  leads.forEach(row => { const id = String(row['Lead ID']); if (seen.has(id)) duplicate.add(id); seen.add(id); });
  return {
    hosts: _cfvDirectory_(),
    leads: leads.filter(row => row['Lead ID'] && !duplicate.has(String(row['Lead ID']))).map(row => ({ id: String(row['Lead ID']), key: _cfvLeadKey_(String(row['Lead ID'])), name: String(row['Company Name'] || '') })),
    canCreate: user.role !== 'VIEWER' && _cfvGrant_(user, 'ClientFactoryVisitsCreate'),
    canInitialize: user.role === 'ADMIN', timezone: 'Asia/Kolkata'
  };
}
function _cfvList_(user, query) {
  const q = query || {}, tables = _cfvTables_(), directory = _cfvDirectory_();
  const from = _cfvText_(q.from, 10), to = _cfvText_(q.to, 10);
  if (from) _cfvTime_(from + 'T00:00', true);
  if (to) _cfvTime_(to + 'T00:00', true);
  if (from && to && from > to) throw new Error('Invalid date range.');
  const status = _cfvText_(q.status, 20), host = _cfvText_(q.host, 200), search = _cfvText_(q.search, 200).toLowerCase();
  if (status && !CFV_STATUSES_.includes(status)) throw new Error('Invalid visit status.');
  const today = Utilities.formatDate(new Date(), 'Asia/Kolkata', 'yyyy-MM-dd');
  const rows = (tables.visits ? tables.visits.rows : []).filter(row => row['Visit ID'] && _cfvCanRead_(row, user, directory))
    .filter(row => (!status || row.Status === status) && (!host || row['Host ID'] === host) && (!from || String(row['Planned Start']).slice(0, 10) >= from) && (!to || String(row['Planned Start']).slice(0, 10) <= to) &&
      (!search || [row.Company, row['Visitor Name'], row.Site, row.Purpose, row['Visit ID']].join(' ').toLowerCase().includes(search)))
    .sort((a, b) => String(b['Planned Start']).localeCompare(String(a['Planned Start'])));
  const summary = { total: rows.length, today: 0, upcoming: 0, pendingOutcome: 0, completed: 0 };
  rows.forEach(row => {
    const day = String(row['Planned Start']).slice(0, 10), open = ['New', 'Scheduled'].includes(row.Status);
    if (day === today) summary.today++;
    if (open && day >= today) summary.upcoming++;
    if (open && day < today) summary.pendingOutcome++;
    if (row.Status === 'Completed') summary.completed++;
  });
  const page = Math.min(Math.max(1, Math.floor(Number(q.page) || 1)), Math.max(1, Math.ceil(rows.length / 50)));
  return { initialized: !!(tables.visits && tables.events), summary, total: rows.length, page, pageSize: 50,
    rows: rows.slice((page - 1) * 50, page * 50).map(row => { const { _row, ...record } = row; return { ...record, canEdit: _cfvCanEdit_(row, user, directory) }; }) };
}
function _cfvPayload_(payload, old, user, options) {
  const p = payload || {}, row = {};
  const fields = { Company: 200, 'Visitor Name': 150, Phone: 40, Email: 200, Site: 200, Purpose: 1000, Requirements: 2000, Outcome: 2000, 'Next Action': 1000, 'Cancel Reason': 1000 };
  Object.keys(fields).forEach(key => row[key] = _cfvText_(p[key], fields[key], ['Company','Visitor Name','Phone','Site','Purpose'].includes(key)));
  if (!/^[+\d][\d ().-]{4,39}$/.test(row.Phone) || row.Email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.Email)) throw new Error('Invalid visitor phone or email.');
  row['Visitor Count'] = Number(p['Visitor Count']);
  if (!Number.isInteger(row['Visitor Count']) || row['Visitor Count'] < 1 || row['Visitor Count'] > 100) throw new Error('Visitor count must be between 1 and 100.');
  row.Destination = _cfvText_(p.Destination, 20, true);
  if (!['Office', 'Factory'].includes(row.Destination)) throw new Error('Invalid destination. Only inbound office/factory visits are supported.');
  row['Host ID'] = _cfvText_(p['Host ID'], 200, true);
  if (!options.hosts.some(host => host.id === row['Host ID'])) throw new Error('Invalid host. Select an active authorized portal user.');
  row['Lead ID'] = _cfvText_(p['Lead ID'], 200);
  row['Lead Key'] = _cfvText_(p['Lead Key'], 500);
  if (old && (row['Lead ID'] !== old['Lead ID'] || row['Lead Key'] !== old['Lead Key'])) throw new Error('Cannot change an existing visit lead link.');
  if (row['Lead ID']) {
    if (row['Lead Key'] !== _cfvLeadKey_(row['Lead ID'])) throw new Error('Invalid portal-qualified lead link.');
    if (!old) {
      const lead = options.leads.find(lead => lead.id === row['Lead ID'] && lead.key === row['Lead Key']);
      if (!lead) throw new Error('Permission denied. Lead is unavailable.');
      row.Company = lead.name;
    } else row.Company = old.Company; // Preserve snapshot; never edit master data.
  } else if (row['Lead Key']) throw new Error('Invalid lead link.');
  ['Planned Start','Planned End','Actual Start','Actual End'].forEach(key => row[key] = _cfvTime_(p[key], key === 'Planned Start'));
  if (row['Planned End'] && row['Planned End'] < row['Planned Start']) throw new Error('Planned end must be after start.');
  if (row['Actual End'] && (!row['Actual Start'] || row['Actual End'] < row['Actual Start'])) throw new Error('Actual end must be after start.');
  row.Status = _cfvText_(p.Status, 20, true);
  const allowed = old ? { New: ['New','Scheduled','Cancelled'], Scheduled: ['Scheduled','Completed','Cancelled','No-show'], Completed: ['Completed'], Cancelled: ['Cancelled'], 'No-show': ['No-show'] }[old.Status] : ['New','Scheduled'];
  if (!allowed || !allowed.includes(row.Status)) throw new Error('Invalid visit status transition.');
  if (old && ['Completed','Cancelled','No-show'].includes(old.Status) && !_cfvGrant_(user, 'ClientFactoryVisitsManage')) throw new Error('Permission denied. Outcome corrections require visit management access.');
  if (row.Status === 'Completed' && (!row['Actual Start'] || !row['Actual End'] || !row.Outcome)) throw new Error('Actual start, end and outcome are required to complete a visit.');
  const nowLocal = Utilities.formatDate(new Date(), 'Asia/Kolkata', "yyyy-MM-dd'T'HH:mm");
  if (row['Actual Start'] > nowLocal || row['Actual End'] > nowLocal) throw new Error('Actual visit times cannot be in the future.');
  if (row.Status === 'No-show' && row['Planned Start'] > nowLocal) throw new Error('Cannot mark a future appointment as No-show.');
  if (['Cancelled','No-show'].includes(row.Status) && !row['Cancel Reason']) throw new Error('A cancellation or no-show reason is required.');
  return row;
}
function _cfvSave_(user, payload, followupRequest) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || JSON.stringify(payload).length > 16000) throw new Error('Invalid or oversized visit request.');
  const p = payload || {}, request = _cfvText_(p.requestId, 80, true), visitId = _cfvText_(p.id, 100);
  if (!/^[A-Za-z0-9_-]{20,80}$/.test(request)) throw new Error('Invalid request reference.');
  if (!visitId && !_cfvGrant_(user, 'ClientFactoryVisitsCreate')) throw new Error('Permission denied. Visit creation access is required.');
  const normalized = Object.keys(p).filter(key => key !== 'requestId').sort().map(key => [key, p[key]]);
  const hash = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, JSON.stringify([user.id, normalized, ...(followupRequest ? ['followup-visit'] : [])])).map(value => ('0' + ((value + 256) % 256).toString(16)).slice(-2)).join('');
  const lock = LockService.getScriptLock(); lock.waitLock(10000);
  try {
    const tables = _cfvTables_();
    if (!tables.visits || !tables.events) throw new Error('Module setup is required. Ask an administrator to initialize it.');
    const directory = _cfvDirectory_();
    const repeated = tables.events.rows.find(row => row['Request ID'] === request);
    if (repeated) {
      if (repeated['Actor ID'] !== user.id || repeated['Request Hash'] !== hash) throw new Error('Invalid request reuse. Start a new action.');
      const saved = tables.visits.rows.find(row => row['Visit ID'] === repeated['Visit ID']);
      if (!saved || !_cfvCanRead_(saved, user, directory)) throw new Error('Permission denied.');
      return { id: saved['Visit ID'], version: Number(saved.Version), repeated: true };
    }
    const old = visitId ? tables.visits.rows.find(row => row['Visit ID'] === visitId) : null;
    if (visitId && (!old || !_cfvCanEdit_(old, user, directory))) throw new Error('Permission denied. Visit is unavailable.');
    if (old && Number(p.version) !== Number(old.Version)) throw new Error('Cannot save a stale visit. Reload the latest version.');
    const options = _cfvOptions_(user), fields = followupRequest
      ? _cfvFollowupRequestFields_(user, p, options) : _cfvPayload_(p, old, user, options);
    const time = new Date().toISOString(), id = old ? old['Visit ID'] : generateUUID();
    const record = { ...(old || {}), ...fields, 'Visit ID': id, 'Portal ID': _cfvPortal_(), 'Created By': old ? old['Created By'] : user.id, 'Created At': old ? old['Created At'] : time, 'Updated By': user.id, 'Updated At': time, Version: old ? Number(old.Version) + 1 : 1 };
    const event = { 'Event ID': generateUUID(), 'Visit ID': id, 'Request ID': request, 'Request Hash': hash, 'Actor ID': user.id, 'Event Type': followupRequest ? 'Follow-up visit request: ' + p.followupId : old ? 'Updated' : 'Created', 'From Status': old ? old.Status : '', 'To Status': record.Status, Version: record.Version, 'Created At': time };
    const cells = (headers, data) => ({ values: headers.map(header => ({ userEnteredValue: { stringValue: String(data[header] == null ? '' : data[header]) } })) });
    // One atomic Sheets batch commits the record and idempotency/audit event.
    // Strings are written as literal stringValue, never parsed as formulas.
    const visitWrite = old
      ? { updateCells: { start: { sheetId: tables.visits.sheet.getSheetId(), rowIndex: old._row - 1, columnIndex: 0 }, rows: [cells(tables.visits.headers, record)], fields: 'userEnteredValue' } }
      : { appendCells: { sheetId: tables.visits.sheet.getSheetId(), rows: [cells(tables.visits.headers, record)], fields: 'userEnteredValue' } };
    // A unique event revision fences a batch still in flight after a timeout.
    // Keep event rows and fences intact so an old revision cannot be reused.
    const revision = tables.events.rows.length + 1;
    const fence = { addNamedRange: { namedRange: { namedRangeId: 'nbd_cfv_rev_' + revision, name: 'nbd_cfv_save_' + revision,
      range: { sheetId: tables.events.sheet.getSheetId(), startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 1 } } } };
    try {
      Sheets.Spreadsheets.batchUpdate({ requests: [visitWrite, { appendCells: { sheetId: tables.events.sheet.getSheetId(), rows: [cells(tables.events.headers, event)], fields: 'userEnteredValue' } }, fence] }, getSpreadsheet(CFV_TABLE_).getId());
    } catch (error) {
      logServerError_(error, { api: 'apiClientFactoryVisitSave', operationId: request, step: 'atomic visit commit' });
      throw new Error('VISIT_COMMIT_UNCONFIRMED: Google Sheets has not confirmed this save. Retry the same request reference.');
    }
    return { id, version: record.Version, repeated: false };
  } finally { lock.releaseLock(); }
}
function _cfvHistory_(user, id) {
  const tables = _cfvTables_(), directory = _cfvDirectory_();
  const row = tables.visits && tables.visits.rows.find(row => row['Visit ID'] === String(id));
  if (!row || !_cfvCanRead_(row, user, directory)) throw new Error('Permission denied.');
  if (!tables.events) throw new Error('Module setup is required.');
  return tables.events.rows.filter(event => event['Visit ID'] === id).map(event => ({ actor: event['Actor ID'], type: event['Event Type'], from: event['From Status'], to: event['To Status'], version: event.Version, at: event['Created At'] })).reverse().slice(0, 100);
}
