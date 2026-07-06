// Write primitives backed by the Advanced Google Sheets service.
// SheetDB.js's insertRow/updateRow/deleteRow/deleteAllRowsWhere try these first and
// transparently fall back to SpreadsheetApp on any error (or when the service/spreadsheet
// id is unavailable). Reads use UNFORMATTED_VALUE/SERIAL_NUMBER and writes use the RAW
// input option, so round-tripping a row preserves every untouched cell's value and type
// (a date cell's serial written back RAW keeps its date number-format) — matching the
// legacy getValues()/setValues() behaviour exactly.

// Sentinel returned by the Sheets API helpers to mean "I did not handle this — use the
// authoritative SpreadsheetApp path." Distinct object so it can't collide with a real result.
const _FALLBACK_ = { __sheetsApiFallback__: true };

// Per-execution cache of sheet title → gid (needed for row-deletion batchUpdate requests).
let _SHEET_GID_CACHE_ = {};

// 1-based column number → A1 letters (1→A, 26→Z, 27→AA …).
function _columnLetter_(n) {
  let x = Number(n) || 0;
  let s = '';
  while (x > 0) {
    const m = (x - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    x = Math.floor((x - 1) / 26);
  }
  return s || 'A';
}

// Pulls the row number out of an append response's updatedRange, e.g. "'Leads'!A42:P42" → 42.
function _parseUpdatedRangeRow_(updatedRange) {
  if (!updatedRange) return 0;
  const cell = String(updatedRange).split('!').pop();
  const m = cell.match(/[A-Z]+(\d+)/i);
  return m ? Number(m[1]) : 0;
}

function _sheetGidForName_(ssId, sheetName) {
  const norm = normalizeSheetName(sheetName);
  const key = ssId + '|' + norm;
  if (Object.prototype.hasOwnProperty.call(_SHEET_GID_CACHE_, key)) return _SHEET_GID_CACHE_[key];
  try {
    const meta = Sheets.Spreadsheets.get(ssId, { fields: 'sheets.properties(sheetId,title)' });
    (meta.sheets || []).forEach(s => {
      const p = s.properties || {};
      _SHEET_GID_CACHE_[ssId + '|' + p.title] = p.sheetId;
    });
  } catch (e) {
    Logger.log('[Write] gid lookup failed for ' + sheetName + ': ' + (e && e.message || e));
  }
  return Object.prototype.hasOwnProperty.call(_SHEET_GID_CACHE_, key) ? _SHEET_GID_CACHE_[key] : null;
}

function _a1Sheet_(normName) {
  return "'" + String(normName).replace(/'/g, "''") + "'";
}

// Always route writes through SpreadsheetApp instead of a RAW Sheets API write.
// A RAW write stores every value as a literal string, so numeric- or date-looking
// values ("919876", "2026-06-30") land as TEXT and Google Sheets flags them with a
// leading apostrophe (e.g. '919876) — also breaking number/date sorting. SpreadsheetApp
// setValues()/appendRow() parse values as if typed, storing real numbers and dates with
// no apostrophe (the original portal behaviour). Writes are not the performance
// bottleneck, so this is the safe, correct default; the read fast-path is unaffected.
function _rawWriteSafe_(values) {
  return false;
}

// Reads a single 1-based row, padded to colCount, as raw UNFORMATTED/SERIAL values.
function _sheetsApiGetRowValues_(ssId, normName, rowNumber, colCount) {
  const a1 = _a1Sheet_(normName) + '!A' + rowNumber + ':' + _columnLetter_(colCount) + rowNumber;
  const res = Sheets.Spreadsheets.Values.get(ssId, a1, {
    valueRenderOption: 'UNFORMATTED_VALUE',
    dateTimeRenderOption: 'SERIAL_NUMBER'
  });
  const row = (res.values && res.values[0]) || [];
  const padded = [];
  for (let c = 0; c < colCount; c++) padded[c] = row[c] !== undefined ? row[c] : '';
  return padded;
}

// Finds a row by id value, returning { rowNumber, values } (raw, padded) or null if not found.
// Uses the lookup index as a hint, verifying the id before trusting it, and otherwise scans.
function _sheetsApiLocateRow_(ssId, normName, idColIndex, idValue, colCount, sheetName, idColumn) {
  const target = String(idValue);
  const hint = (typeof findIndexedRowNumber_ === 'function')
    ? findIndexedRowNumber_(sheetName, idColumn, idValue)
    : -1;
  if (hint > 1) {
    const values = _sheetsApiGetRowValues_(ssId, normName, hint, colCount);
    if (String(values[idColIndex] !== undefined ? values[idColIndex] : '') === target) {
      return { rowNumber: hint, values };
    }
  }
  const res = Sheets.Spreadsheets.Values.get(ssId, _a1Sheet_(normName), {
    valueRenderOption: 'UNFORMATTED_VALUE',
    dateTimeRenderOption: 'SERIAL_NUMBER'
  });
  const data = res.values || [];
  for (let i = 1; i < data.length; i++) {
    const raw = data[i] || [];
    if (String(raw[idColIndex] !== undefined ? raw[idColIndex] : '') === target) {
      const padded = [];
      for (let c = 0; c < colCount; c++) padded[c] = raw[c] !== undefined ? raw[c] : '';
      return { rowNumber: i + 1, values: padded };
    }
  }
  return null;
}

function _deleteSheetRowsByNumber_(ssId, gid, rowNumbers) {
  // Delete bottom-up so earlier deletions don't shift the row numbers still to be removed.
  const sorted = (rowNumbers || []).filter(n => n > 1).sort((a, b) => b - a);
  if (!sorted.length) return 0;
  const requests = sorted.map(n => ({
    deleteDimension: { range: { sheetId: gid, dimension: 'ROWS', startIndex: n - 1, endIndex: n } }
  }));
  Sheets.Spreadsheets.batchUpdate({ requests }, ssId);
  return sorted.length;
}

// ── Primitives consumed by SheetDB.js ──────────────────────────────────────────

// Appends a row, returning its 1-based row number. Sheets API first, SpreadsheetApp fallback.
function _appendRowWithFallback_(sheetName, row, colCount) {
  const ssId = _spreadsheetIdForSheet_(sheetName);
  if (ssId && _sheetsApiAvailable_() && _rawWriteSafe_(row)) {
    try {
      const norm = normalizeSheetName(sheetName);
      const res = Sheets.Spreadsheets.Values.append(
        { values: [row] },
        ssId,
        _a1Sheet_(norm) + '!A1',
        { valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS' }
      );
      const rn = _parseUpdatedRangeRow_(res && res.updates && res.updates.updatedRange);
      if (rn > 0) return rn;
      // Row landed but its number is unknown — never re-append; resolve via the live last row.
      return getSheet(sheetName).getLastRow();
    } catch (e) {
      _noteSheetsApiError_(e);
      Logger.log('[Write] Sheets API append fell back for ' + sheetName + ': ' + (e && e.message || e));
    }
  }
  const sheet = getSheet(sheetName);
  sheet.appendRow(row);
  return sheet.getLastRow();
}

// Updates the row identified by idColumn=idValue. Returns { ok:true, syncedRow, rowNumber }
// on success, or _FALLBACK_ for any case the caller should hand to _legacyUpdateRow_.
function _sheetsApiUpdateRow_(sheetName, idColumn, idValue, updates, headers) {
  const ssId = _spreadsheetIdForSheet_(sheetName);
  if (!ssId || !_sheetsApiAvailable_()) return _FALLBACK_;
  const col = headers.indexOf(idColumn);
  if (col === -1) return _FALLBACK_;
  if (!_rawWriteSafe_(headers.map(h => updates[h]))) return _FALLBACK_;

  const norm = normalizeSheetName(sheetName);
  const located = _sheetsApiLocateRow_(ssId, norm, col, idValue, headers.length, sheetName, idColumn);
  if (!located) return _FALLBACK_; // not found here → let the SpreadsheetApp path decide authoritatively

  const updatedRow = headers.map((h, i) =>
    updates[h] !== undefined ? updates[h] : (located.values[i] !== undefined ? located.values[i] : '')
  );
  const a1 = _a1Sheet_(norm) + '!A' + located.rowNumber + ':' + _columnLetter_(headers.length) + located.rowNumber;
  Sheets.Spreadsheets.Values.update({ values: [updatedRow] }, ssId, a1, { valueInputOption: 'RAW' });

  const syncedRow = _objectsFromSheetsApiValues_([headers, updatedRow], { skipBlankRows: false })[0] || {};
  return { ok: true, syncedRow, rowNumber: located.rowNumber };
}

// Deletes the row identified by idColumn=idValue. Returns true on delete, or _FALLBACK_.
function _sheetsApiDeleteRow_(sheetName, idColumn, idValue) {
  const ssId = _spreadsheetIdForSheet_(sheetName);
  if (!ssId || !_sheetsApiAvailable_()) return _FALLBACK_;
  const headers = getHeaders(sheetName);
  const col = headers.indexOf(idColumn);
  if (col === -1) return _FALLBACK_;
  const norm = normalizeSheetName(sheetName);
  const located = _sheetsApiLocateRow_(ssId, norm, col, idValue, headers.length, sheetName, idColumn);
  if (!located) return _FALLBACK_;
  const gid = _sheetGidForName_(ssId, norm);
  if (gid == null) return _FALLBACK_;
  _deleteSheetRowsByNumber_(ssId, gid, [located.rowNumber]);
  return true;
}

// Deletes every row matching filterFn. Returns the count deleted, or _FALLBACK_.
function _sheetsApiDeleteAllRowsWhere_(sheetName, filterFn) {
  const ssId = _spreadsheetIdForSheet_(sheetName);
  if (!ssId || !_sheetsApiAvailable_()) return _FALLBACK_;
  const norm = normalizeSheetName(sheetName);
  const res = Sheets.Spreadsheets.Values.get(ssId, _a1Sheet_(norm), {
    valueRenderOption: 'UNFORMATTED_VALUE',
    dateTimeRenderOption: 'SERIAL_NUMBER'
  });
  const data = res.values || [];
  if (data.length < 2 || !data[0] || !data[0].length) return 0;
  const headers = (data[0] || []).map(h => String(h || '').trim());
  const dateFlags = headers.map(_isDateColumnHeader_);
  const rowNumbers = [];
  for (let i = 1; i < data.length; i++) {
    const raw = data[i] || [];
    const obj = {};
    for (let c = 0; c < headers.length; c++) {
      if (headers[c]) obj[headers[c]] = _sheetsApiCellValue_(raw[c], dateFlags[c]);
    }
    if (filterFn(obj)) rowNumbers.push(i + 1);
  }
  if (!rowNumbers.length) return 0;
  const gid = _sheetGidForName_(ssId, norm);
  if (gid == null) return _FALLBACK_;
  return _deleteSheetRowsByNumber_(ssId, gid, rowNumbers);
}
