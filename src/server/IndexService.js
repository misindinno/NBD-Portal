// Lightweight lookup indexes for high-traffic master sheets.
// The index stores the current row number plus common lookup/filter fields.

function _indexDefinitions_() {
  return [
    {
      sourceSheet: SHEET_NAMES.LEADS,
      indexSheet: SHEET_NAMES.IDX_LEADS,
      idColumn: 'Lead ID',
      headers: [
        'Lead ID','Phone','Alternate No','Email','Assigned To','Stage ID','Lead Status',
        'Next Follow-up Date','Company Name','Contact Person','City','State',
        'Source Portal','Source Lead ID','Updated At','Row Number'
      ],
      build(row, rowNumber) {
        return {
          'Lead ID': row['Lead ID'] || '',
          'Phone': _idxDigits_(row['Phone']),
          'Alternate No': _idxDigits_(row['Alternate No']),
          'Email': _idxLower_(row['Email']),
          'Assigned To': row['Assigned To'] || '',
          'Stage ID': row['Stage ID'] || '',
          'Lead Status': row['Lead Status'] || '',
          'Next Follow-up Date': row['Next Follow-up Date'] || '',
          'Company Name': row['Company Name'] || '',
          'Contact Person': row['Contact Person'] || '',
          'City': row['City'] || '',
          'State': row['State'] || '',
          'Source Portal': row['Source Portal'] || '',
          'Source Lead ID': row['Source Lead ID'] || '',
          'Updated At': row['Updated At'] || '',
          'Row Number': rowNumber || ''
        };
      }
    },
    {
      sourceSheet: SHEET_NAMES.FOLLOWUPS,
      indexSheet: SHEET_NAMES.IDX_FOLLOWUPS,
      idColumn: 'Follow-up ID',
      headers: [
        'Follow-up ID','Lead ID','Status','Next Follow-up Date','Planned Date',
        'Created By','Done By','Stage ID','Updated Stage ID','Updated At','Row Number'
      ],
      build(row, rowNumber) {
        return {
          'Follow-up ID': row['Follow-up ID'] || '',
          'Lead ID': row['Lead ID'] || '',
          'Status': row['Status'] || '',
          'Next Follow-up Date': row['Next Follow-up Date'] || '',
          'Planned Date': row['Planned Date'] || row['Follow-up Date'] || '',
          'Created By': row['Created By'] || '',
          'Done By': row['Done By'] || '',
          'Stage ID': row['Stage ID'] || '',
          'Updated Stage ID': row['Updated Stage ID'] || '',
          'Updated At': row['Updated At'] || '',
          'Row Number': rowNumber || ''
        };
      }
    },
    {
      sourceSheet: SHEET_NAMES.USERS,
      indexSheet: SHEET_NAMES.IDX_USERS,
      idColumn: 'ID',
      headers: [
        'ID','Email Address','Permission','Department','Is Active','Allowed Modules','Name','Row Number'
      ],
      build(row, rowNumber) {
        return {
          'ID': row['ID'] || row['User ID'] || '',
          'Email Address': _idxLower_(row['Email Address']),
          'Permission': row['Permission'] || row['Role'] || '',
          'Department': row['Department'] || '',
          'Is Active': row['Is Active'] || '',
          'Allowed Modules': row['Allowed Modules'] || '',
          'Name': row['Name'] || row['Title'] || '',
          'Row Number': rowNumber || ''
        };
      }
    }
  ];
}

function ensureIndexSheets_() {
  _indexDefinitions_().forEach(def => safeInitHeaders(def.indexSheet, def.headers));
}

function rebuildAllIndexes() {
  return withServerContext_(() => {
    requireContainerAdmin_(false);
    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      ensureIndexSheets_();
      _indexDefinitions_().forEach(def => rebuildIndexForSheet_(def.sourceSheet));
      return 'Indexes rebuilt successfully.';
    } finally { lock.releaseLock(); }
  });
}

function rebuildIndexForSheet_(sheetName) {
  assertServerContext_();
  const def = _indexDefinitionForSheet_(sheetName);
  if (!def) return 0;
  safeInitHeaders(def.indexSheet, def.headers);

  const sourceSheet = getSheet(sheetName);
  const sourceData = sourceSheet.getDataRange().getValues();
  const indexSheet = getSheet(def.indexSheet);
  if (!sourceData[0] || !sourceData[0].length) throw new Error('Missing source headers.');

  const sourceHeaders = sourceData[0].map(String);
  const rows = sourceData.slice(1)
    .map((values, i) => _rowObjectFromValues_(sourceHeaders, values, i + 2))
    .filter(row => String(row[def.idColumn] || '').trim())
    .map(row => {
      const built = def.build(row, row._rowNumber);
      return def.headers.map(h => built[h] !== undefined ? built[h] : '');
    });
  const count = rows.length;
  // Replace in one write, including the stale tail; never clear first.
  const height = Math.max(count, indexSheet.getLastRow() - 1);
  while (rows.length < height) rows.push(def.headers.map(() => ''));
  if (height + 1 > indexSheet.getMaxRows()) indexSheet.insertRowsAfter(indexSheet.getMaxRows(), height + 1 - indexSheet.getMaxRows());
  if (height) indexSheet.getRange(2, 1, height, def.headers.length).setValues(rows);
  return count;
}

function findIndexedRowNumber_(sheetName, idColumn, idValue) {
  assertServerContext_();
  const def = _indexDefinitionForSheet_(sheetName);
  if (!def || String(idColumn) !== String(def.idColumn) || !idValue) return -1;
  const hit = _findIndexRecord_(def, def.idColumn, idValue);
  return hit ? Number(hit.row['Row Number'] || 0) : -1;
}

function getRowByIndexedId_(sheetName, idColumn, idValue) {
  if (typeof syncTxHandles_ === 'function' && syncTxHandles_(sheetName)) return syncTxRows_(sheetName).find(row => String(row[idColumn]) === String(idValue)) || null;
  assertServerContext_();
  const rowNumber = findIndexedRowNumber_(sheetName, idColumn, idValue);
  if (rowNumber > 1) {
    const row = _getRowObjectAt_(sheetName, rowNumber);
    if (row && String(row[idColumn]) === String(idValue)) return row;
  }
  // Manual sorts/deletes can invalidate a pointer. Search only the ID column.
  const actualRow = findRowIndexWithoutIndex_(sheetName, idColumn, idValue);
  return actualRow > 1 ? _getRowObjectAt_(sheetName, actualRow) : null;
}

function getRowsByIndexedColumn_(sheetName, columnName, value) {
  assertServerContext_();
  const def = _indexDefinitionForSheet_(sheetName);
  if (!def || !columnName) return getAllRows(sheetName).filter(r => String(r[columnName]) === String(value));
  // One authoritative read avoids missing records after manual sorts/deletes
  // and eliminates a remote row read for every matching follow-up.
  return getAllRows(sheetName).filter(row => String(row[columnName]) === String(value));
}

// Only for newly generated IDs appended while the caller holds the script lock.
// Append the index as one range instead of scanning it again for every new row.
function appendNewIndexRows_(sheetName, rowObjects, startRow) {
  assertServerContext_();
  const def = _indexDefinitionForSheet_(sheetName);
  if (!def || !rowObjects || !rowObjects.length) return;
  if (startRow < 2) throw new Error('Invalid index source row.');
  safeInitHeaders(def.indexSheet, def.headers);
  const indexSheet = getSheet(def.indexSheet);
  const values = rowObjects.map((row, i) => {
    if (!row[def.idColumn]) throw new Error('Missing index record ID.');
    const built = def.build(row, startRow + i);
    return def.headers.map(header => built[header] !== undefined ? built[header] : '');
  });
  indexSheet.getRange(indexSheet.getLastRow() + 1, 1, values.length, def.headers.length).setValues(values);
}

function syncIndexRow_(sheetName, rowObj, rowNumber) {
  if (typeof syncTxHandles_ === 'function' && syncTxHandles_(sheetName)) return; // Rebuilt in the atomic batch.
  assertServerContext_();
  const def = _indexDefinitionForSheet_(sheetName);
  if (!def || _isIndexSheet_(sheetName)) return;
  const id = String(rowObj && rowObj[def.idColumn] || '').trim();
  if (!id) return;
  safeInitHeaders(def.indexSheet, def.headers);
  const indexSheet = getSheet(def.indexSheet);
  let sourceRowNumber = Number(rowNumber || rowObj._rowNumber || 0);
  if (sourceRowNumber < 2) {
    sourceRowNumber = findRowIndexWithoutIndex_(sheetName, def.idColumn, id);
  }
  if (sourceRowNumber < 2) {
    rebuildIndexForSheet_(sheetName);
    return;
  }
  const built = def.build(rowObj, sourceRowNumber);
  const values = def.headers.map(h => built[h] !== undefined ? built[h] : '');
  const hit = _findIndexRecord_(def, def.idColumn, id);
  const indexRowNumber = Number(hit && hit.rowNumber || 0);
  if (indexRowNumber >= 2) {
    indexSheet.getRange(indexRowNumber, 1, 1, def.headers.length).setValues([values]);
  } else {
    indexSheet.getRange(indexSheet.getLastRow() + 1, 1, 1, def.headers.length).setValues([values]);
  }
}

function rebuildIndexAfterDelete_(sheetName) {
  assertServerContext_();
  if (_indexDefinitionForSheet_(sheetName)) rebuildIndexForSheet_(sheetName);
}

function findRowIndexWithoutIndex_(sheetName, idColumn, idValue) {
  const sheet = getSheet(sheetName);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return -1;
  const col = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(String).indexOf(String(idColumn));
  if (col === -1) return -1;
  const hit = sheet.getRange(2, col + 1, lastRow - 1, 1)
    .createTextFinder(String(idValue)).matchEntireCell(true).matchCase(true)
    .useRegularExpression(false).findNext();
  if (hit) return hit.getRow();
  return -1;
}

function _indexDefinitionForSheet_(sheetName) {
  const normalized = normalizeSheetName(sheetName);
  return _indexDefinitions_().find(def => normalizeSheetName(def.sourceSheet) === normalized) || null;
}

function _isIndexSheet_(sheetName) {
  const normalized = normalizeSheetName(sheetName);
  return _indexDefinitions_().some(def => normalizeSheetName(def.indexSheet) === normalized);
}

function _findIndexRecord_(def, columnName, value) {
  try {
    const sheet = getSheet(def.indexSheet);
    safeInitHeaders(def.indexSheet, def.headers);
    const lastRow = sheet.getLastRow();
    const lastColumn = sheet.getLastColumn();
    if (lastRow < 2 || !lastColumn) return null;
    const headers = sheet.getRange(1, 1, 1, lastColumn).getValues()[0].map(String);
    const col = headers.indexOf(String(columnName));
    if (col === -1) return null;
    const hit = sheet.getRange(2, col + 1, lastRow - 1, 1)
      .createTextFinder(String(value)).matchEntireCell(true).matchCase(true)
      .useRegularExpression(false).findNext();
    if (!hit) return null;
    const rowNumber = hit.getRow();
    const values = sheet.getRange(rowNumber, 1, 1, headers.length).getValues()[0];
    if (String(values[col]) !== String(value)) return null;
    return { rowNumber, row: _rowObjectFromValues_(headers, values, rowNumber) };
  } catch (e) {
    Logger.log('[IndexService] _findIndexRecord_ failed for ' + (def && def.indexSheet) + ' column=' + columnName + ': ' + (e && e.message || e));
    return null;
  }
}

function _getRowObjectAt_(sheetName, rowNumber) {
  const sheet = getSheet(sheetName);
  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  if (rowNumber < 2 || rowNumber > lastRow || lastCol < 1) return null;
  try {
    const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
    const values  = sheet.getRange(rowNumber, 1, 1, lastCol).getValues()[0];
    return _rowObjectFromValues_(headers, values, rowNumber);
  } catch (e) {
    Logger.log('[IndexService] _getRowObjectAt_ failed for ' + sheetName + ' row=' + rowNumber + ' lastRow=' + lastRow + ' lastCol=' + lastCol + ': ' + (e && e.message || e));
    return null;
  }
}

function _rowObjectFromValues_(headers, values, rowNumber) {
  const obj = typeof rowObjectFromHeaders_ === 'function'
    ? rowObjectFromHeaders_(headers, values)
    : headers.reduce((m, h, i) => {
        const key = String(h || '').trim();
        if (key) m[key] = normalizeSheetValue(values[i]);
        return m;
      }, {});
  obj._rowNumber = rowNumber || '';
  return obj;
}

function _clearIndexBody_(sheet) {
  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  if (lastRow > 1 && lastCol > 0) {
    const count = lastRow - 1;
    if (count > 0) sheet.getRange(2, 1, count, lastCol).clearContent();
  }
}

function _idxLower_(value) {
  return String(value || '').trim().toLowerCase();
}

function _idxDigits_(value) {
  return String(value || '').replace(/\D/g, '');
}
