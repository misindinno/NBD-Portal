// Lightweight lookup indexes for high-traffic master sheets.
// The index stores the current row number plus common lookup/filter fields.

function _indexDefinitions_() {
  return [
    {
      sourceSheet: SHEET_NAMES.LEADS,
      indexSheet: SHEET_NAMES.IDX_LEADS,
      idColumn: 'Lead ID',
      headers: [
        'Lead ID','Assigned To','Stage ID','Lead Status','Next Follow-up Date','Updated At','Row Number'
      ],
      build(row, rowNumber) {
        return {
          'Lead ID': row['Lead ID'] || '',
          'Assigned To': row['Assigned To'] || '',
          'Stage ID': row['Stage ID'] || '',
          'Lead Status': row['Lead Status'] || '',
          'Next Follow-up Date': row['Next Follow-up Date'] || '',
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
        'Created By','Done By','Updated At','Row Number'
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
  const indexSheet = getSheet(def.indexSheet);
  _resetIndexSheet_(indexSheet, def.headers);
  const sourceData = sheetApiGetValues_(sheetName, 'A:ZZ');
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
  const data = sheetApiGetValues_(def.indexSheet, 'A:ZZ');
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

function queryLeadsPage_(query, user) {
  assertServerContext_();
  const q = _normalizePageQuery_(query);
  const def = _indexDefinitionForSheet_(SHEET_NAMES.LEADS);
  const indexRows = _dbIndexRows_(def);
  const filters = q.filters || {};
  let rows = indexRows.filter(r => {
    if (filters.assignedTo && String(r['Assigned To'] || '') !== String(filters.assignedTo)) return false;
    if (filters.stageId && String(r['Stage ID'] || '') !== String(filters.stageId)) return false;
    if (filters.status && String(r['Lead Status'] || '') !== String(filters.status)) return false;
    if (filters.dueBefore && _idxDateValue_(r['Next Follow-up Date']) > _idxDateValue_(filters.dueBefore)) return false;
    if (filters.dueOn && String(r['Next Follow-up Date'] || '').slice(0, 10) !== String(filters.dueOn).slice(0, 10)) return false;
    if (!_dbIndexRowReadable_(r, user)) return false;
    return true;
  });
  rows = _sortIndexRows_(rows, q.sortBy || 'Updated At', q.sortDir || 'desc');
  const total = rows.length;
  const pageRefs = rows.slice(q.offset, q.offset + q.pageSize);
  let hydrated = _hydrateIndexedRows_(SHEET_NAMES.LEADS, pageRefs);
  hydrated = getRowsWithCustomFieldValues_('Leads', hydrated);
  return _pageResponse_(hydrated, total, q);
}

function queryFollowupsPage_(query, user) {
  assertServerContext_();
  const q = _normalizePageQuery_(query);
  const def = _indexDefinitionForSheet_(SHEET_NAMES.FOLLOWUPS);
  const indexRows = _dbIndexRows_(def);
  const filters = q.filters || {};
  const canReadIndexRow = _dbFollowupIndexReadableChecker_(user);
  let rows = indexRows.filter(r => {
    if (filters.leadId && String(r['Lead ID'] || '') !== String(filters.leadId)) return false;
    if (filters.status && String(r['Status'] || '') !== String(filters.status)) return false;
    if (filters.createdBy && String(r['Created By'] || '') !== String(filters.createdBy)) return false;
    if (filters.doneBy && String(r['Done By'] || '') !== String(filters.doneBy)) return false;
    if (filters.nextOn && String(r['Next Follow-up Date'] || '').slice(0, 10) !== String(filters.nextOn).slice(0, 10)) return false;
    if (filters.nextBefore && _idxDateValue_(r['Next Follow-up Date']) > _idxDateValue_(filters.nextBefore)) return false;
    if (!canReadIndexRow(r)) return false;
    return true;
  });
  rows = _sortIndexRows_(rows, q.sortBy || 'Updated At', q.sortDir || 'desc');
  const total = rows.length;
  const pageRefs = rows.slice(q.offset, q.offset + q.pageSize);
  const hydrated = _hydrateIndexedRows_(SHEET_NAMES.FOLLOWUPS, pageRefs);
  return _pageResponse_(hydrated, total, q);
}

function _normalizePageQuery_(query) {
  const q = query && typeof query === 'object' ? query : {};
  const pageSize = Math.max(1, Math.min(Number(q.pageSize) || 50, 200));
  const page = Math.max(1, Number(q.page) || 1);
  return {
    page,
    pageSize,
    offset: (page - 1) * pageSize,
    sortBy: q.sortBy || '',
    sortDir: String(q.sortDir || 'desc').toLowerCase() === 'asc' ? 'asc' : 'desc',
    filters: q.filters && typeof q.filters === 'object' ? q.filters : {}
  };
}

function _dbIndexRows_(def) {
  safeInitHeaders(def.indexSheet, def.headers);
  let rows = getAllRows(def.indexSheet);
  if (!rows.length && getSheet(def.sourceSheet).getLastRow() > 1) {
    rebuildIndexForSheet_(def.sourceSheet);
    rows = getAllRows(def.indexSheet);
  }
  return rows;
}

function _dbIndexRowReadable_(row, user) {
  if (!user || user.role === 'ADMIN') return true;
  if (!_hasGlobalRead(user)) return String(row['Assigned To'] || '') === String(user.id || '');
  return true;
}

function _dbFollowupIndexReadableChecker_(user) {
  if (!user || user.role === 'ADMIN') return () => true;
  const leadDef = _indexDefinitionForSheet_(SHEET_NAMES.LEADS);
  const leadIndexRows = _dbIndexRows_(leadDef);
  const leadById = leadIndexRows.reduce((map, row) => {
    map[String(row['Lead ID'] || '')] = row;
    return map;
  }, {});

  if (!_hasGlobalRead(user)) {
    const allowedLeadIds = {};
    leadIndexRows.forEach(row => {
      if (String(row['Assigned To'] || '') === String(user.id || '')) {
        allowedLeadIds[String(row['Lead ID'] || '')] = true;
      }
    });
    return row => {
      const leadId = String(row['Lead ID'] || '');
      return !!allowedLeadIds[leadId]
        || String(row['Created By'] || '') === String(user.id || '')
        || String(row['Done By'] || '') === String(user.id || '');
    };
  }

  const userMap = _buildUserMapById_();
  const scope = _portalDepartmentScopeSet_();
  if (!scope) return () => true;
  return row => {
    const lead = leadById[String(row['Lead ID'] || '')];
    if (lead) {
      const department = _departmentForUserId_(lead['Assigned To'], userMap);
      return !!scope[String(department || '').trim().toLowerCase()];
    }
    return ['Created By', 'Done By'].some(field => {
      const department = _departmentForUserId_(row[field], userMap);
      return !!scope[String(department || '').trim().toLowerCase()];
    });
  };
}

function _sortIndexRows_(rows, sortBy, sortDir) {
  const key = sortBy || 'Updated At';
  const dir = sortDir === 'asc' ? 1 : -1;
  return rows.slice().sort((a, b) => {
    const av = key.toLowerCase().includes('date') || key.toLowerCase().includes('at') ? _idxDateValue_(a[key]) : String(a[key] || '');
    const bv = key.toLowerCase().includes('date') || key.toLowerCase().includes('at') ? _idxDateValue_(b[key]) : String(b[key] || '');
    if (av < bv) return -1 * dir;
    if (av > bv) return 1 * dir;
    return 0;
  });
}

function _hydrateIndexedRows_(sheetName, indexRows) {
  return (indexRows || []).map(r => _getRowObjectAt_(sheetName, Number(r['Row Number'] || 0))).filter(Boolean);
}

function _pageResponse_(rows, total, q) {
  return {
    rows,
    total,
    page: q.page,
    pageSize: q.pageSize,
    hasMore: q.offset + rows.length < total
  };
}

function _idxDateValue_(value) {
  if (!value) return 0;
  const ms = new Date(String(value).replace(' ', 'T')).getTime();
  return Number.isNaN(ms) ? 0 : ms;
}

function syncIndexRow_(sheetName, rowObj, rowNumber) {
  assertServerContext_();
  const def = _indexDefinitionForSheet_(sheetName);
  if (!def || _isIndexSheet_(sheetName)) return;
  const id = String(rowObj && rowObj[def.idColumn] || '').trim();
  if (!id) return;
  safeInitHeaders(def.indexSheet, def.headers);
  const indexSheet = getSheet(def.indexSheet);
  const built = def.build(rowObj, rowNumber);
  const values = def.headers.map(h => built[h] !== undefined ? built[h] : '');
  const hit = _findIndexRecord_(def, def.idColumn, id);
  if (hit) {
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
  const data = sheetApiGetValues_(sheetName, 'A:ZZ');
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
  const data = sheetApiGetValues_(def.indexSheet, 'A:ZZ');
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
  if (rowNumber < 2 || rowNumber > lastRow) return null;
  const headers = getHeaders(sheetName);
  if (!headers.length) return null;
  const values = (sheetApiGetValues_(sheetName, rowNumber + ':' + rowNumber)[0] || []);
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

function _resetIndexSheet_(sheet, headers) {
  const maxRows = sheet.getMaxRows();
  const maxCols = sheet.getMaxColumns();
  if (maxRows > 0 && maxCols > 0) sheet.getRange(1, 1, maxRows, maxCols).clearContent();
  if (sheet.getMaxColumns() < headers.length) sheet.insertColumnsAfter(sheet.getMaxColumns(), headers.length - sheet.getMaxColumns());
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  _styleHeaderRow(sheet, 1, headers.length);
}

function _idxLower_(value) {
  return String(value || '').trim().toLowerCase();
}

function _idxDigits_(value) {
  return String(value || '').replace(/\D/g, '');
}
