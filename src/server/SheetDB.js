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
  return normalizeSheetName(sheetName) === USER_DATABASE_SHEET_NAME;
}

function getHeaders(sheetName) {
  const sheet = getSheet(sheetName);
  const lastCol = sheet.getLastColumn();
  if (lastCol === 0) return [];
  return sheet.getRange(1, 1, 1, lastCol).getValues()[0];
}

function getAllRows(sheetName) {
  const sheet = getSheet(sheetName);
  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return [];
  const headers = data[0];
  return data.slice(1).map((row) =>
    headers.reduce((obj, h, i) => {
      obj[h] = normalizeSheetValue(row[i]);
      return obj;
    }, {}),
  );
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
  const sheet = getSheet(sheetName);
  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  const col = headers.indexOf(idColumn);
  if (col === -1) return -1;
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][col]) === String(idValue)) return i + 1; // 1-based row
  }
  return -1;
}

function insertRow(sheetName, rowObj) {
  const sheet = getSheet(sheetName);
  const headers = getHeaders(sheetName);
  const row = headers.map((h) => (rowObj[h] !== undefined ? rowObj[h] : ""));
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    sheet.appendRow(row);
  } finally {
    lock.releaseLock();
  }
}

function updateRow(sheetName, idColumn, idValue, updates) {
  const sheet = getSheet(sheetName);
  // Fix #10: acquire lock BEFORE reading row index to prevent race condition
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const data = sheet.getDataRange().getValues();
    const headers = data[0];
    const col = headers.indexOf(idColumn);
    if (col === -1) return false;
    let rowIndex = -1;
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][col]) === String(idValue)) { rowIndex = i; break; }
    }
    if (rowIndex === -1) return false;
    // Fix #9: build full updated row and write in a single setValues call
    const updatedRow = headers.map((h, i) =>
      updates[h] !== undefined ? updates[h] : data[rowIndex][i]
    );
    sheet.getRange(rowIndex + 1, 1, 1, headers.length).setValues([updatedRow]);
  } finally {
    lock.releaseLock();
  }
  return true;
}

function deleteRow(sheetName, idColumn, idValue) {
  const sheet = getSheet(sheetName);
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const data = sheet.getDataRange().getValues();
    const col = data[0].indexOf(idColumn);
    if (col === -1) return false;
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][col]) === String(idValue)) {
        sheet.deleteRow(i + 1);
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
  const sheet = getSheet(sheetName);
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const data = sheet.getDataRange().getValues();
    if (data.length < 2) return 0;
    const headers = data[0];
    let deleted = 0;
    for (let i = data.length - 1; i >= 1; i--) {
      const row = headers.reduce((obj, h, j) => { obj[h] = data[i][j]; return obj; }, {});
      if (filterFn(row)) { sheet.deleteRow(i + 1); deleted++; }
    }
    return deleted;
  } finally {
    lock.releaseLock();
  }
}

function queryRows(sheetName, filterFn) {
  return getAllRows(sheetName).filter(filterFn);
}

// Safe: creates sheet if missing, writes header row if empty,
// or appends only NEW columns to the right — never touches existing data.
function safeInitHeaders(sheetName, requiredHeaders) {
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
  sheet
    .getRange(1, startCol, 1, count)
    .setBackground("#1565C0")
    .setFontColor("#FFFFFF")
    .setFontWeight("bold");
}
