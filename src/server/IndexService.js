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
    ensureIndexSheets_();
    _indexDefinitions_().forEach(def => rebuildIndexForSheet_(def.sourceSheet));
    return 'Indexes rebuilt successfully.';
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
  _clearIndexBody_(indexSheet);
  if (sourceData.length < 2) return 0;

  const sourceHeaders = sourceData[0].map(String);
  const rows = sourceData.slice(1)
    .map((values, i) => _rowObjectFromValues_(sourceHeaders, values, i + 2))
    .filter(row => String(row[def.idColumn] || '').trim())
    .map(row => def.headers.map(h => {
      const built = def.build(row, row._rowNumber);
      return built[h] !== undefined ? built[h] : '';
    }));
  if (rows.length) indexSheet.getRange(2, 1, rows.length, def.headers.length).setValues(rows);
  return rows.length;
}

function findIndexedRowNumber_(sheetName, idColumn, idValue) {
  assertServerContext_();
  const def = _indexDefinitionForSheet_(sheetName);
  if (!def || String(idColumn) !== String(def.idColumn) || !idValue) return -1;
  const hit = _findIndexRecord_(def, def.idColumn, idValue);
  return hit ? Number(hit.row['Row Number'] || 0) : -1;
}

function getRowByIndexedId_(sheetName, idColumn, idValue) {
  assertServerContext_();
  const rowNumber = findIndexedRowNumber_(sheetName, idColumn, idValue);
  if (rowNumber > 1) {
    const row = _getRowObjectAt_(sheetName, rowNumber);
    if (row && String(row[idColumn]) === String(idValue)) return row;
  }
  const rows = getAllRows(sheetName);
  const found = rows.find(r => String(r[idColumn]) === String(idValue)) || null;
  if (found) syncIndexRow_(sheetName, found, findRowIndexWithoutIndex_(sheetName, idColumn, idValue));
  return found;
}

function getRowsByIndexedColumn_(sheetName, columnName, value) {
  assertServerContext_();
  const def = _indexDefinitionForSheet_(sheetName);
  if (!def || !columnName) return getAllRows(sheetName).filter(r => String(r[columnName]) === String(value));
  safeInitHeaders(def.indexSheet, def.headers);
  const indexSheet = getSheet(def.indexSheet);
  const data = indexSheet.getDataRange().getValues();
  if (data.length < 2) return [];
  const headers = data[0].map(String);
  const col = headers.indexOf(String(columnName));
  const rowNumberCol = headers.indexOf('Row Number');
  if (col === -1 || rowNumberCol === -1) return getAllRows(sheetName).filter(r => String(r[columnName]) === String(value));
  const target = String(value);
  const rows = [];
  data.slice(1).forEach(indexRow => {
    if (String(indexRow[col]) !== target) return;
    const rowNumber = Number(indexRow[rowNumberCol] || 0);
    const row = _getRowObjectAt_(sheetName, rowNumber);
    if (row && String(row[columnName]) === target) rows.push(row);
  });
  return rows;
}

function syncIndexRow_(sheetName, rowObj, rowNumber) {
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
  if (hit && Number(hit.rowNumber) >= 2) {
    indexSheet.getRange(hit.rowNumber, 1, 1, def.headers.length).setValues([values]);
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
  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return -1;
  const col = data[0].map(String).indexOf(String(idColumn));
  if (col === -1) return -1;
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][col]) === String(idValue)) return i + 1;
  }
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
  const sheet = getSheet(def.indexSheet);
  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return null;
  const headers = data[0].map(String);
  const col = headers.indexOf(String(columnName));
  if (col === -1) return null;
  const target = String(value);
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][col]) !== target) continue;
    return {
      rowNumber: i + 1,
      row: _rowObjectFromValues_(headers, data[i], i + 1)
    };
  }
  return null;
}

function _getRowObjectAt_(sheetName, rowNumber) {
  const sheet = getSheet(sheetName);
  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  if (rowNumber < 2 || rowNumber > lastRow || lastCol < 1) return null;
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
  const values = sheet.getRange(rowNumber, 1, 1, lastCol).getValues()[0];
  return _rowObjectFromValues_(headers, values, rowNumber);
}

function _rowObjectFromValues_(headers, values, rowNumber) {
  const obj = headers.reduce((m, h, i) => {
    m[h] = normalizeSheetValue(values[i]);
    return m;
  }, {});
  obj._rowNumber = rowNumber || '';
  return obj;
}

function _clearIndexBody_(sheet) {
  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  if (lastRow > 1 && lastCol > 0) sheet.getRange(2, 1, lastRow - 1, lastCol).clearContent();
}

function _idxLower_(value) {
  return String(value || '').trim().toLowerCase();
}

function _idxDigits_(value) {
  return String(value || '').replace(/\D/g, '');
}
