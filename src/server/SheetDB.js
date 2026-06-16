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

function spreadsheetIdForSheet_(sheetName) {
  return isUserDatabaseSheet(sheetName) ? USER_DATABASE_SPREADSHEET_ID : SPREADSHEET_ID;
}

function sheetApiRange_(sheetName, range) {
  const escaped = String(normalizeSheetName(sheetName)).replace(/'/g, "''");
  return "'" + escaped + "'!" + (range || 'A:ZZ');
}

function sheetApiGetValues_(sheetName, range, spreadsheetId) {
  assertServerContext_();
  const sheet = getSheetForSpreadsheet_(sheetName, spreadsheetId);
  try {
    return _getSpreadsheetValuesForRange_(sheet, range || 'A:ZZ');
  } catch (e) {
    const message = String(e && e.message || e);
    if (message.includes('Unable to parse range') || message.includes('not found')) return [];
    throw e;
  }
}

function sheetApiSetValues_(sheetName, range, values, spreadsheetId) {
  assertServerContext_();
  const sheet = getSheetForSpreadsheet_(sheetName, spreadsheetId);
  const data = values || [];
  if (!data.length) return;
  sheet.getRange(range).setValues(data);
}

function sheetApiClearValues_(sheetName, range, spreadsheetId) {
  assertServerContext_();
  getSheetForSpreadsheet_(sheetName, spreadsheetId).getRange(range).clearContent();
}

function sheetApiAppendValues_(sheetName, values, spreadsheetId) {
  assertServerContext_();
  const data = values || [];
  if (!data.length) return 0;
  const sheet = getSheetForSpreadsheet_(sheetName, spreadsheetId);
  const startRow = sheet.getLastRow() + 1;
  sheet.getRange(startRow, 1, data.length, data[0].length).setValues(data);
  return startRow;
}

function sheetApiDeleteRow_(sheetName, rowNumber, spreadsheetId) {
  assertServerContext_();
  getSheetForSpreadsheet_(sheetName, spreadsheetId).deleteRow(Number(rowNumber));
}

function _sheetApiStartRowFromRange_(range) {
  const match = String(range || '').match(/[A-Z]+(\d+)/i);
  return match ? Number(match[1]) : 0;
}

function _getSpreadsheetValuesForRange_(sheet, range) {
  const lastRow = Math.max(sheet.getLastRow(), 1);
  const lastCol = Math.max(sheet.getLastColumn(), 1);
  const raw = String(range || 'A:ZZ').trim();

  const rowOnly = raw.match(/^(\d+):(\d+)$/);
  if (rowOnly) {
    const startRow = Math.max(Number(rowOnly[1]), 1);
    const endRow = Math.max(Number(rowOnly[2]), startRow);
    return sheet.getRange(startRow, 1, endRow - startRow + 1, lastCol).getValues();
  }

  const colOnly = raw.match(/^([A-Z]+):([A-Z]+)$/i);
  if (colOnly) {
    const startCol = _columnNumberFromLetter_(colOnly[1]);
    const requestedEndCol = _columnNumberFromLetter_(colOnly[2]);
    const endCol = Math.min(Math.max(requestedEndCol, startCol), Math.max(lastCol, startCol));
    return sheet.getRange(1, startCol, lastRow, endCol - startCol + 1).getValues();
  }

  return sheet.getRange(raw).getValues();
}

function _columnNumberFromLetter_(letter) {
  return String(letter || '').toUpperCase().split('').reduce((n, ch) => {
    const code = ch.charCodeAt(0);
    if (code < 65 || code > 90) return n;
    return n * 26 + code - 64;
  }, 0) || 1;
}

function getSheetForSpreadsheet_(sheetName, spreadsheetId) {
  const normalized = normalizeSheetName(sheetName);
  if (!spreadsheetId) return getSheet(normalized);
  const ss = SpreadsheetApp.openById(spreadsheetId);
  let sheet = ss.getSheetByName(normalized);
  if (!sheet) sheet = ss.insertSheet(normalized);
  return sheet;
}

function sheetApiValuesToRows_(values) {
  const data = values || [];
  if (data.length < 2) return [];
  const headers = (data[0] || []).map(String);
  return data.slice(1)
    .filter(row => (row || []).some(v => String(v || '').trim() !== ''))
    .map(row => headers.reduce((obj, h, i) => {
      if (h) obj[h] = normalizeSheetValue(row[i] !== undefined ? row[i] : '');
      return obj;
    }, {}));
}

function getHeaders(sheetName) {
  const values = sheetApiGetValues_(sheetName, '1:1');
  return values.length ? (values[0] || []).map(String).filter(Boolean) : [];
}

function getAllRows(sheetName) {
  return sheetApiValuesToRows_(sheetApiGetValues_(sheetName, 'A:ZZ'));
}

function getHeadersSpreadsheet_(sheetName) {
  const sheet = getSheet(sheetName);
  const lastCol = sheet.getLastColumn();
  if (!lastCol) return [];
  return sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(String).filter(Boolean);
}

function getAllRowsSpreadsheet_(sheetName) {
  const sheet = getSheet(sheetName);
  const range = sheet.getDataRange();
  const values = range ? range.getValues() : [];
  return sheetApiValuesToRows_(values);
}

// ─── Cross-portal aggregation (dashboard-portal only) ──────────────────────
// When CLIENT_CONFIG.AGGREGATE_SOURCES is set, reads the same sheet from every
// listed spreadsheet and concatenates the rows, tagging each row with
// _source and _sourceName for downstream filtering.
//
// IMPORTANT: each source is a separate SpreadsheetApp.openById + getValues call,
// so a dashboard with 4 sources = 4 quota units per sheet. To stay under the
// per-account Spreadsheet read throttle (~200–300/min, shared across users when
// deployed "Execute as: Me"), we memoize each (sheet × source) for a short
// window via CacheService. Re-loads inside that window cost zero API calls.
const _AGGREGATE_CACHE_TTL_SECONDS = 60;

function _aggregateCacheGet_(key) {
  try {
    const cache = CacheService.getScriptCache();
    const raw = cache.get(key);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) { return null; }
}

function _aggregateCachePut_(key, value) {
  try {
    const json = JSON.stringify(value);
    // CacheService rejects >100 KB per key; skip cache for huge sheets rather than throw.
    if (json.length > 95000) return;
    CacheService.getScriptCache().put(key, json, _AGGREGATE_CACHE_TTL_SECONDS);
  } catch (e) {}
}

function invalidateAggregateCache(sheetName) {
  try {
    const sources = (typeof CLIENT_CONFIG !== 'undefined' && CLIENT_CONFIG.AGGREGATE_SOURCES) || [];
    const keys = sources.map(src => 'AGG::' + normalizeSheetName(sheetName) + '::' + (src && src.spreadsheetId || ''));
    CacheService.getScriptCache().removeAll(keys);
  } catch (e) {}
}

function getAggregatedRows(sheetName) {
  assertServerContext_();
  const sources = (typeof CLIENT_CONFIG !== 'undefined' && CLIENT_CONFIG.AGGREGATE_SOURCES) || [];
  if (!Array.isArray(sources) || !sources.length) return getAllRows(sheetName);

  const resolved = normalizeSheetName(sheetName);
  const merged = [];
  sources.forEach(src => {
    if (!src || !src.spreadsheetId) return;
    const cacheKey = 'AGG::' + resolved + '::' + src.spreadsheetId;
    let rows = _aggregateCacheGet_(cacheKey);
    if (!rows) {
      rows = sheetApiValuesToRows_(sheetApiGetValues_(resolved, 'A:ZZ', src.spreadsheetId));
      _aggregateCachePut_(cacheKey, rows);
    }
    rows.forEach(row => {
      const obj = Object.assign({}, row, {
        _source: src.key || '',
        _sourceName: src.name || src.key || ''
      });
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
  const data = sheetApiGetValues_(sheetName, 'A:ZZ');
  if (data.length < 2) return -1;
  const headers = data[0];
  const col = headers.indexOf(idColumn);
  if (col === -1) return -1;
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][col]) === String(idValue)) return i + 1; // 1-based row
  }
  return -1;
}

function insertRow(sheetName, rowObj) {
  const headers = getHeaders(sheetName);
  const row = headers.map((h) => (rowObj[h] !== undefined ? rowObj[h] : ""));
  const lock = LockService.getScriptLock();
  let rowNumber = 0;
  lock.waitLock(10000);
  try {
    const sheet = getSheet(sheetName);
    rowNumber = sheet.getLastRow() + 1;
    sheet.getRange(rowNumber, 1, 1, row.length).setValues([row]);
  } finally {
    lock.releaseLock();
  }
  if (typeof syncIndexRow_ === 'function') syncIndexRow_(sheetName, rowObj, rowNumber);
}

function updateRow(sheetName, idColumn, idValue, updates) {
  // Fix #10: acquire lock BEFORE reading row index to prevent race condition
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  let syncedRow = null;
  let syncedRowNumber = 0;
  try {
    const sheet = getSheet(sheetName);
    const values = sheet.getDataRange().getValues();
    if (values.length < 2) return false;
    const headers = values[0].map(String);
    const col = headers.indexOf(idColumn);
    if (col === -1) return false;
    let rowIndex = -1;
    const indexedRow = typeof findIndexedRowNumber_ === 'function'
      ? findIndexedRowNumber_(sheetName, idColumn, idValue)
      : -1;
    if (indexedRow > 1 && indexedRow <= values.length && String(values[indexedRow - 1][col]) === String(idValue)) {
      rowIndex = indexedRow - 1;
    } else {
      for (let i = 1; i < values.length; i++) {
        if (String(values[i][col]) === String(idValue)) { rowIndex = i; break; }
      }
    }
    if (rowIndex === -1) return false;
    // Fix #9: build full updated row and write in a single setValues call
    const updatedRow = headers.map((h, i) =>
      updates[h] !== undefined ? updates[h] : values[rowIndex][i]
    );
    sheet.getRange(rowIndex + 1, 1, 1, headers.length).setValues([updatedRow]);
    syncedRow = headers.reduce((obj, h, i) => {
      obj[h] = normalizeSheetValue(updatedRow[i]);
      return obj;
    }, {});
    syncedRowNumber = rowIndex + 1;
  } finally {
    lock.releaseLock();
  }
  if (syncedRow && typeof syncIndexRow_ === 'function') syncIndexRow_(sheetName, syncedRow, syncedRowNumber);
  return true;
}

function deleteRow(sheetName, idColumn, idValue) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheet = getSheet(sheetName);
    const data = sheet.getDataRange().getValues();
    if (data.length < 2) return false;
    const col = data[0].map(String).indexOf(idColumn);
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

// Deletes every row matching filterFn. Iterates bottom-up so row numbers stay valid.
function deleteAllRowsWhere(sheetName, filterFn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  let deleted = 0;
  try {
    const sheet = getSheet(sheetName);
    const data = sheet.getDataRange().getValues();
    if (data.length < 2) return 0;
    const headers = data[0].map(String);
    for (let i = data.length - 1; i >= 1; i--) {
      const row = headers.reduce((obj, h, j) => { obj[h] = data[i][j]; return obj; }, {});
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
  const sheet = getSheet(sheetName);
  const lastCol = sheet.getLastColumn();
  const existingHeaders = getHeaders(sheetName);

  // Sheet is brand new — write full header row
  if (lastCol === 0 || !existingHeaders.length) {
    sheet.getRange(1, 1, 1, requiredHeaders.length).setValues([requiredHeaders]);
    _styleHeaderRow(sheet, 1, requiredHeaders.length);
    return;
  }

  // Sheet already has headers — find and append only missing columns
  const missing = requiredHeaders.filter((h) => !existingHeaders.includes(h));
  if (missing.length === 0) return; // nothing to do

  const startCol = lastCol + 1;
  sheet.getRange(1, startCol, 1, missing.length).setValues([missing]);
  _styleHeaderRow(sheet, startCol, missing.length);
}

function _columnLetter_(columnNumber) {
  let n = Number(columnNumber) || 1;
  let letter = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    letter = String.fromCharCode(65 + rem) + letter;
    n = Math.floor((n - 1) / 26);
  }
  return letter || 'A';
}

function _styleHeaderRow(sheet, startCol, count) {
  sheet
    .getRange(1, startCol, 1, count)
    .setBackground("#1565C0")
    .setFontColor("#FFFFFF")
    .setFontWeight("bold");
}
