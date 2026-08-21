// ─── SheetDB.js ─────────────────────────────────────────────────────────────

const SPREADSHEET_ID               = CLIENT_CONFIG.SPREADSHEET_ID;
const USER_DATABASE_SPREADSHEET_ID = CLIENT_CONFIG.USER_DATABASE_SPREADSHEET_ID;
const USER_DATABASE_SHEET_NAME     = CLIENT_CONFIG.USER_DATABASE_SHEET_NAME;
let SERVER_CONTEXT_DEPTH = 0;

function withServerContext_(fn) {
  SERVER_CONTEXT_DEPTH++;
  try {
    return fn();
  } finally {
    SERVER_CONTEXT_DEPTH--;
  }
}

function assertServerContext_() {
  if (SERVER_CONTEXT_DEPTH <= 0) {
    throw new Error('Direct sheet access is not allowed. Use the authorized API functions.');
  }
}

function withSheetDbTiming_(operation, sheetName, mode, fn) {
  const attributes = {
    sheet: typeof diagnosticSheetLabel_ === 'function' ? diagnosticSheetLabel_(sheetName) : 'UNKNOWN',
    mode: mode === 'write' ? 'write' : 'read'
  };
  if (typeof withDiagnosticSpan_ === 'function') {
    return withDiagnosticSpan_('sheetdb.' + String(operation || 'operation'), attributes, fn);
  }
  return fn();
}

function getSpreadsheet(sheetName) {
  assertServerContext_();
  if (isUserDatabaseSheet(sheetName)) {
    return SpreadsheetApp.openById(USER_DATABASE_SPREADSHEET_ID);
  }
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    if (ss) return ss;
  } catch (e) {}
  return SpreadsheetApp.openById(SPREADSHEET_ID);
}

function getSheet(name, createIfMissing) {
  return withSheetDbTiming_('open_sheet', name, createIfMissing === true ? 'write' : 'read', () => {
    assertServerContext_();
    const sheetName = normalizeSheetName(name);
    const ss = getSpreadsheet(sheetName);
    let sheet = ss.getSheetByName(sheetName);
    if (!sheet && createIfMissing === true) sheet = ss.insertSheet(sheetName);
    if (!sheet) throw new Error('Required sheet not found: ' + sheetName + '. Run setupSheets as an administrator.');
    return sheet;
  });
}
function normalizeSheetName(name) {
  return name === 'USERS' ? USER_DATABASE_SHEET_NAME : name;
}

function isUserDatabaseSheet(sheetName) {
  const normalized = normalizeSheetName(sheetName);
  return normalized === USER_DATABASE_SHEET_NAME ||
    normalized === SHEET_NAMES.USER_PORTAL_ACCESS ||
    normalized === SHEET_NAMES.IDX_USERS;
}

function getHeaders(sheetName) {
  return withSheetDbTiming_('read_headers', sheetName, 'read', () => {
    const sheet = getSheet(sheetName);
    const lastCol = sheet.getLastColumn();
    if (lastCol === 0) return [];
    const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
    return typeof validateSheetHeaders_ === 'function'
      ? validateSheetHeaders_(sheetName, headers)
      : headers;
  });
}

// Sheets-API-first read with SpreadsheetApp fallback (see readAllRowsWithFallback_).
function getAllRows(sheetName) {
  return withSheetDbTiming_('read_all', sheetName, 'read', () => readAllRowsWithFallback_(sheetName));
}

// Legacy SpreadsheetApp read — the fallback path used when the Sheets API is
// unavailable, errors, or the spreadsheet id is unconfigured.
function _legacyGetAllRows_(sheetName) {
  const sheet = getSheet(sheetName);
  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return [];
  const headers = typeof validateSheetHeaders_ === 'function'
    ? validateSheetHeaders_(sheetName, data[0])
    : data[0];
  return data.slice(1).map((row) => rowObjectFromHeaders_(headers, row, true, sheetName));
}

function rowObjectFromHeaders_(headers, values, normalize, sheetName) {
  const obj = {};
  (headers || []).forEach((header, i) => {
    const key = String(header || '').trim();
    if (!key) return;
    const value = values ? values[i] : '';
    obj[key] = normalize === false
      ? value
      : (sheetName && typeof parseSheetCell_ === 'function'
        ? parseSheetCell_(sheetName, key, value)
        : normalizeSheetValue(value));
  });
  return obj;
}

// ─── Cross-portal aggregation (dashboard-portal only) ──────────────────────
// When CLIENT_CONFIG.AGGREGATE_SOURCES is set, reads the same sheet from every
// listed spreadsheet and concatenates the rows, tagging each row with
// _source and _sourceName for downstream filtering.
function getAggregatedRows(sheetName) {
  return withSheetDbTiming_('read_aggregated', sheetName, 'read', () => {
    assertServerContext_();
    const sources = (typeof CLIENT_CONFIG !== 'undefined' && CLIENT_CONFIG.AGGREGATE_SOURCES) || [];
    if (!Array.isArray(sources) || !sources.length) return getAllRows(sheetName);

    const resolved = normalizeSheetName(sheetName);
    const merged = [];
    sources.forEach(src => {
      if (!src || !src.spreadsheetId) return;
      let ss;
      try {
        ss = SpreadsheetApp.openById(src.spreadsheetId);
      } catch (e) {
        if (typeof diagnosticLog_ === 'function') {
          diagnosticLog_('WARN', 'DATA.AGGREGATE_SOURCE_UNAVAILABLE', 'aggregate_source_open_failed', {
            sheet: diagnosticSheetLabel_(sheetName)
          });
        }
        return;
      }
      const sheet = ss.getSheetByName(resolved);
      if (!sheet) return;
      const data = sheet.getDataRange().getValues();
      if (data.length < 2) return;
      const headers = data[0];
      data.slice(1).forEach(row => {
        const obj = rowObjectFromHeaders_(headers, row, true, resolved);
        obj._source = src.key || '';
        obj._sourceName = src.name || src.key || '';
        merged.push(obj);
      });
    });
    return merged;
  });
}
function isAggregatePortal() {
  const sources = (typeof CLIENT_CONFIG !== 'undefined' && CLIENT_CONFIG.AGGREGATE_SOURCES) || [];
  return Array.isArray(sources) && sources.length > 0;
}

function normalizeSheetValue(value) {
  if (value instanceof Date) {
    return Utilities.formatDate(
      value,
      Session.getScriptTimeZone(),
      'yyyy-MM-dd HH:mm:ss',
    );
  }
  return value;
}

function findRowIndex(sheetName, idColumn, idValue) {
  return withSheetDbTiming_('read_find_row', sheetName, 'read', () => {
    const indexedRow = typeof findIndexedRowNumber_ === 'function'
      ? findIndexedRowNumber_(sheetName, idColumn, idValue)
      : -1;
    if (indexedRow > 1) return indexedRow;
    const sheet = getSheet(sheetName);
    const data = sheet.getDataRange().getValues();
    if (!data.length || !data[0] || !data[0].length) return -1;
    const headers = data[0];
    const col = headers.indexOf(idColumn);
    if (col === -1) return -1;
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][col]) === String(idValue)) return i + 1; // 1-based row
    }
    return -1;
  });
}
// Inserts a row. The append goes through the Sheets API (SpreadsheetApp fallback) via
// _appendRowWithFallback_; LockService + index sync are unchanged.
function insertRow(sheetName, rowObj) {
  return withSheetDbTiming_('write_insert', sheetName, 'write', () => {
    _invalidateReadCache_();
    const headers = getHeaders(sheetName);
    if (!headers.length) {
      throw new Error('Cannot insert row: sheet "' + sheetName + '" has no headers. Run setupSheets first.');
    }
    const rawRow = headers.map((h) => (rowObj[h] !== undefined ? rowObj[h] : ""));
    const row = typeof sanitizeSheetRowValues_ === 'function' ? sanitizeSheetRowValues_(rawRow) : rawRow;
    const lock = LockService.getScriptLock();
    let rowNumber = 0;
    lock.waitLock(10000);
    try {
      rowNumber = _appendRowWithFallback_(sheetName, row, headers.length);
    } finally {
      lock.releaseLock();
    }
    if (typeof syncIndexRow_ === 'function') syncIndexRow_(sheetName, rowObj, rowNumber);
  });
}

// Updates a row by id. Tries the Sheets API path (targeted read-modify-write under the
// script lock); any miss/uncertainty/error falls through to the authoritative
// SpreadsheetApp path so behaviour and return values match the legacy implementation.
function updateRow(sheetName, idColumn, idValue, updates) {
  return withSheetDbTiming_('write_update', sheetName, 'write', () => {
    _invalidateReadCache_();
    const headers = getHeaders(sheetName);
    if (headers && headers.length) {
      const lock = LockService.getScriptLock();
      lock.waitLock(10000);
      let res = _FALLBACK_;
      try {
        res = _sheetsApiUpdateRow_(sheetName, idColumn, idValue, updates, headers);
      } catch (e) {
        _noteSheetsApiError_(e);
        if (typeof diagnosticLog_ === 'function') {
          diagnosticLog_('WARN', 'DATA.WRITE_FALLBACK', 'sheet_update_fallback', {
            sheet: diagnosticSheetLabel_(sheetName),
            idColumn: String(idColumn || '').slice(0, 80),
            errorCategory: diagnosticErrorCategory_(e)
          });
        }
        res = _FALLBACK_;
      } finally {
        lock.releaseLock();
      }
      if (res !== _FALLBACK_ && res && res.ok) {
        if (typeof syncIndexRow_ === 'function') syncIndexRow_(sheetName, res.syncedRow, res.rowNumber);
        return true;
      }
    }
    return _legacyUpdateRow_(sheetName, idColumn, idValue, updates);
  });
}
function _legacyUpdateRow_(sheetName, idColumn, idValue, updates) {
  const sheet = getSheet(sheetName);
  // Fix #10: acquire lock BEFORE reading row index to prevent race condition
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  let syncedRow = null;
  let syncedRowNumber = 0;
  try {
    const data = sheet.getDataRange().getValues();
    if (!data.length || !data[0] || !data[0].length) return false;
    const headers = data[0];
    const col = headers.indexOf(idColumn);
    if (col === -1) return false;
    let rowIndex = -1;
    const indexedRow = typeof findIndexedRowNumber_ === 'function'
      ? findIndexedRowNumber_(sheetName, idColumn, idValue)
      : -1;
    if (indexedRow > 1 && indexedRow <= data.length && String(data[indexedRow - 1][col]) === String(idValue)) {
      rowIndex = indexedRow - 1;
    } else {
      for (let i = 1; i < data.length; i++) {
        if (String(data[i][col]) === String(idValue)) { rowIndex = i; break; }
      }
    }
    if (rowIndex === -1) return false;
    if (rowIndex < 1) {
      if (typeof diagnosticLog_ === 'function') {
        diagnosticLog_('ERROR', 'DATA.INVALID_ROW_TARGET', 'sheet_update_invalid_row', {
          sheet: diagnosticSheetLabel_(sheetName),
          idColumn: String(idColumn || '').slice(0, 80),
          rowIndex
        });
      }
      if (typeof rebuildIndexForSheet_ === 'function') rebuildIndexForSheet_(sheetName);
      return false;
    }
    // Fix #9: build full updated row and write in a single setValues call
    const updatedRow = headers.map((h, i) =>
      updates[h] !== undefined ? updates[h] : data[rowIndex][i]
    );
    const safeUpdatedRow = typeof sanitizeSheetRowValues_ === 'function'
      ? sanitizeSheetRowValues_(updatedRow)
      : updatedRow;
    const targetRowNumber = rowIndex + 1;
    if (targetRowNumber < 2) {
      if (typeof diagnosticLog_ === 'function') {
        diagnosticLog_('ERROR', 'DATA.INVALID_ROW_TARGET', 'sheet_update_invalid_target', {
          sheet: diagnosticSheetLabel_(sheetName),
          idColumn: String(idColumn || '').slice(0, 80),
          rowNumber: targetRowNumber
        });
      }
      if (typeof rebuildIndexForSheet_ === 'function') rebuildIndexForSheet_(sheetName);
      return false;
    }
    sheet.getRange(targetRowNumber, 1, 1, headers.length).setValues([safeUpdatedRow]);
    syncedRow = rowObjectFromHeaders_(headers, safeUpdatedRow, true, sheetName);
    syncedRowNumber = targetRowNumber;
  } finally {
    lock.releaseLock();
  }
  if (syncedRow && typeof syncIndexRow_ === 'function') syncIndexRow_(sheetName, syncedRow, syncedRowNumber);
  return true;
}

// Deletes a row by id. Sheets API (deleteDimension) first, SpreadsheetApp fallback.
function deleteRow(sheetName, idColumn, idValue) {
  return withSheetDbTiming_('write_delete', sheetName, 'write', () => {
    _invalidateReadCache_();
    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    let outcome = _FALLBACK_;
    try {
      outcome = _sheetsApiDeleteRow_(sheetName, idColumn, idValue);
    } catch (e) {
      _noteSheetsApiError_(e);
      if (typeof diagnosticLog_ === 'function') {
        diagnosticLog_('WARN', 'DATA.WRITE_FALLBACK', 'sheet_delete_fallback', {
          sheet: diagnosticSheetLabel_(sheetName),
          idColumn: String(idColumn || '').slice(0, 80),
          errorCategory: diagnosticErrorCategory_(e)
        });
      }
      outcome = _FALLBACK_;
    } finally {
      lock.releaseLock();
    }
    if (outcome === true) {
      if (typeof rebuildIndexAfterDelete_ === 'function') rebuildIndexAfterDelete_(sheetName);
      return true;
    }
    return _legacyDeleteRow_(sheetName, idColumn, idValue);
  });
}
function _legacyDeleteRow_(sheetName, idColumn, idValue) {
  const sheet = getSheet(sheetName);
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const data = sheet.getDataRange().getValues();
    if (!data.length || !data[0] || !data[0].length) return false;
    const col = data[0].indexOf(idColumn);
    if (col === -1) return false;
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][col]) === String(idValue)) {
        sheet.deleteRow(i + 1);
        if (typeof rebuildIndexAfterDelete_ === 'function') rebuildIndexAfterDelete_(sheetName);
        return true;
      }
    }
    return false;
  } finally {
    lock.releaseLock();
  }
}

// Deletes every row matching filterFn. Sheets API (batched deleteDimension) first,
// SpreadsheetApp fallback. Index rebuild runs once after the deletions.
function deleteAllRowsWhere(sheetName, filterFn) {
  return withSheetDbTiming_('write_delete_many', sheetName, 'write', () => {
    _invalidateReadCache_();
    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    let result = _FALLBACK_;
    try {
      result = _sheetsApiDeleteAllRowsWhere_(sheetName, filterFn);
    } catch (e) {
      _noteSheetsApiError_(e);
      if (typeof diagnosticLog_ === 'function') {
        diagnosticLog_('WARN', 'DATA.WRITE_FALLBACK', 'sheet_bulk_delete_fallback', {
          sheet: diagnosticSheetLabel_(sheetName),
          errorCategory: diagnosticErrorCategory_(e)
        });
      }
      result = _FALLBACK_;
    } finally {
      lock.releaseLock();
    }
    if (result !== _FALLBACK_) {
      if (result > 0 && typeof rebuildIndexAfterDelete_ === 'function') rebuildIndexAfterDelete_(sheetName);
      return result;
    }
    return _legacyDeleteAllRowsWhere_(sheetName, filterFn);
  });
}
function _legacyDeleteAllRowsWhere_(sheetName, filterFn) {
  const sheet = getSheet(sheetName);
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  let deleted = 0;
  try {
    const data = sheet.getDataRange().getValues();
    if (data.length < 2 || !data[0] || !data[0].length) return 0;
    const headers = data[0];
    for (let i = data.length - 1; i >= 1; i--) {
      const row = rowObjectFromHeaders_(headers, data[i], false, sheetName);
      if (filterFn(row)) { sheet.deleteRow(i + 1); deleted++; }
    }
  } finally {
    lock.releaseLock();
  }
  if (deleted && typeof rebuildIndexAfterDelete_ === 'function') rebuildIndexAfterDelete_(sheetName);
  return deleted;
}

function queryRows(sheetName, filterFn) {
  return getAllRows(sheetName).filter(filterFn);
}

// Safe: creates sheet if missing, writes header row if empty,
// or appends only NEW columns to the right — never touches existing data.
function safeInitHeaders(sheetName, requiredHeaders) {
  return withSheetDbTiming_('write_init_headers', sheetName, 'write', () => {
    _invalidateReadCache_();
    requiredHeaders = Array.isArray(requiredHeaders) ? requiredHeaders.filter(Boolean) : [];
    if (!requiredHeaders.length) {
      if (typeof diagnosticLog_ === 'function') {
        diagnosticLog_('WARN', 'VALIDATION.INVALID_INPUT', 'sheet_headers_empty', {
          sheet: diagnosticSheetLabel_(sheetName)
        });
      }
      return;
    }
    const sheet = getSheet(sheetName, true);
    const lastCol = sheet.getLastColumn();

    // Sheet is brand new — write full header row
    if (lastCol === 0 || sheet.getRange(1, 1).getValue() === "") {
      sheet
        .getRange(1, 1, 1, requiredHeaders.length)
        .setValues([requiredHeaders]);
      _styleHeaderRow(sheet, 1, requiredHeaders.length);
      return;
    }

    // Sheet already has headers — find and append only missing columns
    const existingHeaders = sheet
      .getRange(1, 1, 1, lastCol)
      .getValues()[0]
      .map(String);
    const missing = requiredHeaders.filter((h) => !existingHeaders.includes(h));
    if (missing.length === 0) return; // nothing to do

    const startCol = lastCol + 1;
    sheet.getRange(1, startCol, 1, missing.length).setValues([missing]);
    _styleHeaderRow(sheet, startCol, missing.length);
  });
}
function _styleHeaderRow(sheet, startCol, count) {
  startCol = Number(startCol || 0);
  count = Number(count || 0);
  if (startCol < 1 || count < 1) {
    if (typeof diagnosticLog_ === 'function') {
      diagnosticLog_('WARN', 'DATA.INVALID_RANGE', 'sheet_header_style_skipped', {
        sheet: typeof sheet.getName === 'function' ? diagnosticSheetLabel_(sheet.getName()) : 'UNKNOWN',
        startColumn: startCol,
        columnCount: count
      });
    }
    return;
  }
  sheet
    .getRange(1, startCol, 1, count)
    .setBackground("#1565C0")
    .setFontColor("#FFFFFF")
    .setFontWeight("bold");
}
