// Sheet-only transaction planner. Domain validation runs against staged rows;
// a single Sheets batch commits business changes AND the retry receipt.
// Never use the legacy SpreadsheetApp fallback for this commit.
let SYNC_TX_ = null;
const SYNC_RECEIPTS_ = '_SYNC_OPERATIONS';
const SYNC_RECEIPT_HEADERS_ = ['Operation ID','User ID','Request Hash','Result','Committed At'];

function syncTxHandles_(name) {
  return !!SYNC_TX_ && [SHEET_NAMES.LEADS, SHEET_NAMES.FOLLOWUPS,
    SHEET_NAMES.FOLLOWUP_HISTORY, SHEET_NAMES.LEAD_ACTIVITY_LOGS,
    SHEET_NAMES.LEAD_FIELD_VALUES, SHEET_NAMES.FOLLOWUP_FIELD_VALUES,
    SHEET_NAMES.IDX_LEADS, SHEET_NAMES.IDX_FOLLOWUPS, SHEET_NAMES.BULK_AUDIT_LOG,
    'FSR_SYNC_QUEUE', 'CALL_LOGS', SYNC_RECEIPTS_].includes(name);
}
function syncTxTable_(name) {
  if (!syncTxHandles_(name)) throw new Error('Unsupported sync table.');
  if (SYNC_TX_.tables[name]) return SYNC_TX_.tables[name];
  const sheet = getSpreadsheet(name).getSheetByName(name);
  const values = sheet ? sheet.getDataRange().getValues() : [];
  const headers = (values[0] || []).map(String);
  if (sheet && typeof validateSheetHeaders_ === 'function') validateSheetHeaders_(name, headers);
  const originals = values.slice(1).map(row => row.slice());
  const table = { name, sheet, headers, originalHeaders: headers.slice(), originals,
    rows: originals.map((values, index) => ({ source: index + 1, values: values.slice() })) };
  SYNC_TX_.tables[name] = table;
  return table;
}
function syncTxRows_(name) {
  const table = syncTxTable_(name);
  return table.rows.map(row => rowObjectFromHeaders_(table.headers, row.values, true, name));
}
function syncTxInit_(name, headers) {
  const table = syncTxTable_(name);
  headers.forEach(header => { if (!table.headers.includes(header)) table.headers.push(header); });
}
function syncTxInsert_(name, record) {
  const table = syncTxTable_(name);
  if (!table.headers.length) throw new Error('Missing sync table headers: ' + name);
  table.rows.push({ source: null, values: table.headers.map(key => record[key] === undefined ? '' : record[key]) });
}
function syncTxUpdate_(name, key, id, patch) {
  const table = syncTxTable_(name), col = table.headers.indexOf(key);
  const hits = table.rows.filter(row => String(row.values[col]) === String(id));
  if (hits.length > 1) throw new Error('Duplicate record IDs must be repaired before syncing.');
  if (!hits.length) return false;
  table.headers.forEach((header, i) => { if (patch[header] !== undefined) hits[0].values[i] = patch[header]; });
  return true;
}
function syncTxDelete_(name, filter) {
  const table = syncTxTable_(name), before = table.rows.length;
  table.rows = table.rows.filter(row => !filter(rowObjectFromHeaders_(table.headers, row.values, true, name)));
  return before - table.rows.length;
}
function syncTxSavepoint_() {
  const tables = {};
  Object.keys(SYNC_TX_.tables).forEach(name => {
    const table = SYNC_TX_.tables[name];
    tables[name] = { ...table, headers: table.headers.slice(), rows: table.rows.map(row => ({ ...row, values: row.values.slice() })) };
  });
  return { tables, stamps: { ...SYNC_TX_.stamps } };
}
function syncTxRestore_(point) { SYNC_TX_.tables = point.tables; SYNC_TX_.stamps = point.stamps; }
function syncTxIndexes_() {
  _indexDefinitions_().filter(def => SYNC_TX_.tables[def.sourceSheet] && !isUserDatabaseSheet(def.sourceSheet)).forEach(def => {
    syncTxInit_(def.indexSheet, def.headers);
    const table = syncTxTable_(def.indexSheet);
    const desired = syncTxRows_(def.sourceSheet).map((row, i) => def.build(row, i + 2)).filter(row => row[def.idColumn]);
    // Keep physical row identities so only differing cells are written.
    table.rows = desired.map((row, i) => ({ source: i < table.originals.length ? i + 1 : null,
      values: table.headers.map(key => row[key] === undefined ? '' : row[key]) }));
  });
}
function syncCell_(value) {
  if (value === undefined || value === null || value === '') return {};
  if (value instanceof Date) return { userEnteredValue: { numberValue: value.getTime() / 86400000 + 25569 } };
  if (typeof value === 'boolean') return { userEnteredValue: { boolValue: value } };
  if (typeof value === 'number' && Number.isFinite(value)) return { userEnteredValue: { numberValue: value } };
  // Text beginning with '=' stays text. Existing, untouched formulas are not rewritten.
  return { userEnteredValue: { stringValue: String(value) } };
}
function syncTxRequests_() {
  const requests = [], usedIds = new Set(getSpreadsheet(SYNC_RECEIPTS_).getSheets().map(sheet => sheet.getSheetId()));
  Object.values(SYNC_TX_.tables).forEach(table => {
    let sheetId = table.sheet && table.sheet.getSheetId();
    if (!table.headers.length) return;
    if (sheetId == null) {
      do { sheetId = Math.floor(Math.random() * 2000000000) + 1; } while (usedIds.has(sheetId));
      usedIds.add(sheetId);
      requests.push({ addSheet: { properties: { sheetId, title: table.name, gridProperties: { rowCount: Math.max(100, table.rows.length + 2), columnCount: Math.max(26, table.headers.length) } } } });
    } else {
      const needed = table.rows.filter(row => row.source === null).length + table.originals.length + 1;
      if (needed > table.sheet.getMaxRows()) requests.push({ appendDimension: { sheetId, dimension: 'ROWS', length: needed - table.sheet.getMaxRows() } });
      if (table.headers.length > table.sheet.getMaxColumns()) requests.push({ appendDimension: { sheetId, dimension: 'COLUMNS', length: table.headers.length - table.sheet.getMaxColumns() } });
    }
    const write = (rowIndex, columnIndex, values) => requests.push({ updateCells: {
      start: { sheetId, rowIndex, columnIndex }, rows: [{ values: values.map(syncCell_) }], fields: 'userEnteredValue'
    } });
    if (table.headers.length > table.originalHeaders.length) write(0, table.originalHeaders.length, table.headers.slice(table.originalHeaders.length));
    table.rows.filter(row => row.source !== null).forEach(row => {
      const old = table.originals[row.source - 1] || [];
      // Only changed cells: preserve formulas and formatting in all other columns.
      let start = -1;
      for (let i = 0; i <= table.headers.length; i++) {
        const changed = i < table.headers.length && String(old[i] == null ? '' : old[i]) !== String(row.values[i] == null ? '' : row.values[i]);
        if (changed && start < 0) start = i;
        if (!changed && start >= 0) { write(row.source, start, row.values.slice(start, i)); start = -1; }
      }
    });
    const retained = new Set(table.rows.map(row => row.source));
    for (let i = table.originals.length; i >= 1; i--) {
      if (!retained.has(i)) requests.push({ deleteDimension: { range: { sheetId, dimension: 'ROWS', startIndex: i, endIndex: i + 1 } } });
    }
    const added = table.rows.filter(row => row.source === null);
    if (added.length) requests.push({ appendCells: { sheetId, rows: added.map(row => ({ values: row.values.map(syncCell_) })), fields: 'userEnteredValue' } });
  });
  return requests;
}

function syncTxCheckReadSet_() {
  Object.values(SYNC_TX_.tables).forEach(table => {
    const current = getSpreadsheet(table.name).getSheetByName(table.name);
    if (!table.sheet && !current) return;
    if (!current || !table.sheet || current.getSheetId() !== table.sheet.getSheetId() ||
        JSON.stringify(current.getDataRange().getValues()) !== JSON.stringify([table.originalHeaders, ...table.originals])) {
      throw new Error('SYNC_CONFLICT: Sheet changed while preparing this save. Refresh and review.');
    }
  });
}

function syncAtomicWrite_(user, command, run) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return { state: 'retry', message: 'Another save is running.' };
  let stamps = {};
  try {
    const receiptSheet = getSpreadsheet(SYNC_RECEIPTS_).getSheetByName(SYNC_RECEIPTS_);
    if (!receiptSheet) throw new Error('SYNC_SETUP_REQUIRED');
    const hash = leadCacheDigest_({ user: user.id, action: command.action, args: command.args, bases: command.bases || [] });
    const existing = receiptSheet.getDataRange().getValues().slice(1).find(row => row[0] === command.id);
    if (existing) {
      if (existing[1] !== user.id || existing[2] !== hash) throw new Error('Invalid operation ID reuse.');
      const result = JSON.parse(existing[3]);
      const leadId = typeof result === 'string' && command.action === 'apiSaveLead' ? result : result && result.leadId;
      const lead = leadId ? getAllRows(SHEET_NAMES.LEADS).find(row => String(row['Lead ID']) === String(leadId)) : null;
      const visible = !leadId || lead && _canReadAssignedRow(lead, user);
      return { state: 'committed', result: visible ? result : null, repeated: true, receiptOnly: !visible };
    }
    SYNC_TX_ = { tables: {}, stamps: {} };
    syncCheckBases_(user, command);
    const result = run();
    if (!result || !result.success) return { state: 'invalid', message: result && result.error || 'Validation failed.', code: result && result.code };
    if (JSON.stringify(result.data).length > 40000) throw new Error('Invalid sync response size. Use a smaller batch.');
    syncTxIndexes_();
    syncTxInit_(SYNC_RECEIPTS_, SYNC_RECEIPT_HEADERS_);
    syncTxInsert_(SYNC_RECEIPTS_, { 'Operation ID': command.id, 'User ID': user.id, 'Request Hash': hash,
      Result: JSON.stringify(result.data), 'Committed At': new Date().toISOString() });
    const requests = syncTxRequests_();
    syncTxCheckReadSet_();
    // A caller-supplied namedRangeId must be unique (Sheets API contract). All
    // commands prepared against this receipt count compete for the same revision.
    // This also fences DIFFERENT delayed commands after a transport timeout.
    // Never remove receipt rows or these ranges: reuse of a revision fails closed.
    const revision = syncTxTable_(SYNC_RECEIPTS_).originals.length + 1;
    requests.push({ addNamedRange: { namedRange: { namedRangeId: 'nbd_sync_rev_' + revision, name: 'sync_' + command.id.replace(/-/g, ''),
      range: { sheetId: receiptSheet.getSheetId(), startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 1 } } } });
    if (requests.length > 2000 || JSON.stringify(requests).length > 1500000) throw new Error('Invalid sync batch size. Use a smaller batch.');
    stamps = SYNC_TX_.stamps;
    SYNC_TX_ = null;
    try { Sheets.Spreadsheets.batchUpdate({ requests }, SPREADSHEET_ID); }
    catch (error) {
      // Even a validation-shaped transport error may follow an earlier timed-out
      // commit. Preserve this command/ID until a fresh receipt resolves it.
      logServerError_(error, { api: 'apiSyncPush', operationId: command.id, step: 'atomic Sheets commit' });
      return { state: 'retry', message: 'Google Sheets has not confirmed this save. It will retry with the same reference.' };
    }
    _invalidateReadCache_();
    Object.keys(stamps).forEach(_bumpStamp);
    return { state: 'committed', result: result.data, repeated: false };
  } finally { SYNC_TX_ = null; lock.releaseLock(); }
}
