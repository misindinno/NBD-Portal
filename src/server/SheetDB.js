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

function assertSheetsApiAvailable_() {
  if (typeof Sheets === 'undefined' || !Sheets.Spreadsheets || !Sheets.Spreadsheets.Values) {
    throw new Error('Google Sheets advanced service is not enabled.');
  }
}

function sheetApiRange_(sheetName, range) {
  const escaped = String(normalizeSheetName(sheetName)).replace(/'/g, "''");
  return "'" + escaped + "'!" + (range || 'A:ZZ');
}

function sheetApiGetValues_(sheetName, range, spreadsheetId) {
  assertServerContext_();
  assertSheetsApiAvailable_();
  const id = spreadsheetId || spreadsheetIdForSheet_(sheetName);
  try {
    const res = Sheets.Spreadsheets.Values.get(id, sheetApiRange_(sheetName, range), {
      valueRenderOption: 'FORMATTED_VALUE',
      dateTimeRenderOption: 'FORMATTED_STRING'
    });
    return res.values || [];
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
function getAggregatedRows(sheetName) {
  assertServerContext_();
  const sources = (typeof CLIENT_CONFIG !== 'undefined' && CLIENT_CONFIG.AGGREGATE_SOURCES) || [];
  if (!Array.isArray(sources) || !sources.length) return getAllRows(sheetName);

  const resolved = normalizeSheetName(sheetName);
  const merged = [];
  sources.forEach(src => {
    if (!src || !src.spreadsheetId) return;
    const rows = sheetApiValuesToRows_(sheetApiGetValues_(resolved, 'A:ZZ', src.spreadsheetId));
    rows.forEach(row => {
      const obj = { ...row };
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
