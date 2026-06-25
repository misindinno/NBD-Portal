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

function getSheet(name) {
  assertServerContext_();
  const sheetName = normalizeSheetName(name);
  const ss = getSpreadsheet(sheetName);
  let sheet = ss.getSheetByName(sheetName);
  if (!sheet) sheet = ss.insertSheet(sheetName);
  return sheet;
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
  const sheet = getSheet(sheetName);
  const lastCol = sheet.getLastColumn();
  if (lastCol === 0) return [];
  return sheet.getRange(1, 1, 1, lastCol).getValues()[0];
}

// Sheets-API-first read with SpreadsheetApp fallback (see readAllRowsWithFallback_).
function getAllRows(sheetName) {
  return readAllRowsWithFallback_(sheetName);
}

// Legacy SpreadsheetApp read — the fallback path used when the Sheets API is
// unavailable, errors, or the spreadsheet id is unconfigured.
function _legacyGetAllRows_(sheetName) {
  const sheet = getSheet(sheetName);
  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return [];
  const headers = data[0];
  return data.slice(1).map((row) => rowObjectFromHeaders_(headers, row));
}

function rowObjectFromHeaders_(headers, values, normalize) {
  const obj = {};
  (headers || []).forEach((header, i) => {
    const key = String(header || '').trim();
    if (!key) return;
    const value = values ? values[i] : '';
    obj[key] = normalize === false ? value : normalizeSheetValue(value);
  });
  return obj;
}

// ─── Cross-portal aggregation (dashboard-portal only) ──────────────────────
// When CLIENT_CONFIG.AGGREGATE_SOURCES is set, reads the same sheet from every
// listed spreadsheet and concatenates the rows, tagging each row with
// _source and _sourceName for downstream filtering.
function getAggregatedRows(sheetName) {
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
      Logger.log('[Aggregate] open failed for ' + (src.key || src.spreadsheetId) + ': ' + e.message);
      return;
    }
    const sheet = ss.getSheetByName(resolved);
    if (!sheet) return;
    const data = sheet.getDataRange().getValues();
    if (data.length < 2) return;
    const headers = data[0];
    data.slice(1).forEach(row => {
      const obj = rowObjectFromHeaders_(headers, row);
      obj._source = src.key || '';
      obj._sourceName = src.name || src.key || '';
      merged.push(obj);
    });
  });
  return merged;
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
}

// Inserts a row. The append goes through the Sheets API (SpreadsheetApp fallback) via
// _appendRowWithFallback_; LockService + index sync are unchanged.
function insertRow(sheetName, rowObj) {
  _invalidateReadCache_();
  const headers = getHeaders(sheetName);
  if (!headers.length) {
    throw new Error('Cannot insert row: sheet "' + sheetName + '" has no headers. Run setupSheets first.');
  }
  const row = headers.map((h) => (rowObj[h] !== undefined ? rowObj[h] : ""));
  const lock = LockService.getScriptLock();
  let rowNumber = 0;
  lock.waitLock(10000);
  try {
    rowNumber = _appendRowWithFallback_(sheetName, row, headers.length);
  } finally {
    lock.releaseLock();
  }
  if (typeof syncIndexRow_ === 'function') syncIndexRow_(sheetName, rowObj, rowNumber);
}

// Updates a row by id. Tries the Sheets API path (targeted read-modify-write under the
// script lock); any miss/uncertainty/error falls through to the authoritative
// SpreadsheetApp path so behaviour and return values match the legacy implementation.
function updateRow(sheetName, idColumn, idValue, updates) {
  _invalidateReadCache_();
  const headers = getHeaders(sheetName);
  if (headers && headers.length) {
    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    let res = _FALLBACK_;
    try {
      res = _sheetsApiUpdateRow_(sheetName, idColumn, idValue, updates, headers);
    } catch (e) {
      Logger.log('[Write] Sheets API updateRow fell back for ' + sheetName + ' ' + idColumn + '=' + idValue + ': ' + (e && e.message || e));
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
      Logger.log('[SheetDB] Refusing invalid update row for ' + sheetName + ' ' + idColumn + '=' + idValue + ' rowIndex=' + rowIndex);
      if (typeof rebuildIndexForSheet_ === 'function') rebuildIndexForSheet_(sheetName);
      return false;
    }
    // Fix #9: build full updated row and write in a single setValues call
    const updatedRow = headers.map((h, i) =>
      updates[h] !== undefined ? updates[h] : data[rowIndex][i]
    );
    const targetRowNumber = rowIndex + 1;
    if (targetRowNumber < 2) {
      Logger.log('[SheetDB] Refusing invalid target row for ' + sheetName + ' ' + idColumn + '=' + idValue + ' row=' + targetRowNumber);
      if (typeof rebuildIndexForSheet_ === 'function') rebuildIndexForSheet_(sheetName);
      return false;
    }
    sheet.getRange(targetRowNumber, 1, 1, headers.length).setValues([updatedRow]);
    syncedRow = rowObjectFromHeaders_(headers, updatedRow);
    syncedRowNumber = targetRowNumber;
  } finally {
    lock.releaseLock();
  }
  if (syncedRow && typeof syncIndexRow_ === 'function') syncIndexRow_(sheetName, syncedRow, syncedRowNumber);
  return true;
}

// Deletes a row by id. Sheets API (deleteDimension) first, SpreadsheetApp fallback.
function deleteRow(sheetName, idColumn, idValue) {
  _invalidateReadCache_();
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  let outcome = _FALLBACK_;
  try {
    outcome = _sheetsApiDeleteRow_(sheetName, idColumn, idValue);
  } catch (e) {
    Logger.log('[Write] Sheets API deleteRow fell back for ' + sheetName + ' ' + idColumn + '=' + idValue + ': ' + (e && e.message || e));
    outcome = _FALLBACK_;
  } finally {
    lock.releaseLock();
  }
  if (outcome === true) {
    if (typeof rebuildIndexAfterDelete_ === 'function') rebuildIndexAfterDelete_(sheetName);
    return true;
  }
  return _legacyDeleteRow_(sheetName, idColumn, idValue);
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
  _invalidateReadCache_();
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  let result = _FALLBACK_;
  try {
    result = _sheetsApiDeleteAllRowsWhere_(sheetName, filterFn);
  } catch (e) {
    Logger.log('[Write] Sheets API deleteAllRowsWhere fell back for ' + sheetName + ': ' + (e && e.message || e));
    result = _FALLBACK_;
  } finally {
    lock.releaseLock();
  }
  if (result !== _FALLBACK_) {
    if (result > 0 && typeof rebuildIndexAfterDelete_ === 'function') rebuildIndexAfterDelete_(sheetName);
    return result;
  }
  return _legacyDeleteAllRowsWhere_(sheetName, filterFn);
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
      const row = rowObjectFromHeaders_(headers, data[i], false);
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
  _invalidateReadCache_();
  requiredHeaders = Array.isArray(requiredHeaders) ? requiredHeaders.filter(Boolean) : [];
  if (!requiredHeaders.length) {
    Logger.log('[SheetDB] safeInitHeaders skipped empty header list for ' + sheetName);
    return;
  }
  const sheet = getSheet(sheetName);
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
}

function _styleHeaderRow(sheet, startCol, count) {
  startCol = Number(startCol || 0);
  count = Number(count || 0);
  if (startCol < 1 || count < 1) {
    Logger.log('[SheetDB] Header styling skipped for invalid range startCol=' + startCol + ' count=' + count);
    return;
  }
  sheet
    .getRange(1, startCol, 1, count)
    .setBackground("#1565C0")
    .setFontColor("#FFFFFF")
    .setFontWeight("bold");
}

function diagnoseSheetRanges_() {
  assertServerContext_();
  const names = [
    SHEET_NAMES.USERS,
    SHEET_NAMES.USER_PORTAL_ACCESS,
    SHEET_NAMES.LEADS,
    SHEET_NAMES.FOLLOWUPS,
    SHEET_NAMES.FOLLOWUP_HISTORY,
    SHEET_NAMES.LEAD_ACTIVITY_LOGS,
    SHEET_NAMES.STAGES,
    SHEET_NAMES.FIELD_CONFIG,
    SHEET_NAMES.CONFIG,
    SHEET_NAMES.LEAD_FIELD_VALUES,
    SHEET_NAMES.FOLLOWUP_FIELD_VALUES,
    SHEET_NAMES.IDX_LEADS,
    SHEET_NAMES.IDX_FOLLOWUPS,
    SHEET_NAMES.IDX_USERS
  ].filter(Boolean);
  const seen = {};
  return names.filter(name => {
    const normalized = normalizeSheetName(name);
    if (seen[normalized]) return false;
    seen[normalized] = true;
    return true;
  }).map(name => {
    const normalized = normalizeSheetName(name);
    const sheet = getSheet(normalized);
    const lastRow = sheet.getLastRow();
    const lastCol = sheet.getLastColumn();
    const headers = lastCol > 0 ? sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(String) : [];
    return {
      sheet: normalized,
      lastRow,
      lastCol,
      hasHeaders: headers.some(h => String(h || '').trim()),
      blankHeaders: headers.filter(h => !String(h || '').trim()).length,
      firstHeaders: headers.slice(0, 8)
    };
  });
}
