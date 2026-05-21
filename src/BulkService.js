// BulkService.gs
// Spreadsheet-backed bulk import service for the Bulk Entry module.

const BULK_MAX_ROWS = 500;

function getBulkConfig() {
  assertServerContext_();
  _ensureBulkSheets_();
  const rows = getAllRows(SHEET_NAMES.BULK_CONFIG);

  // Build CONFIG-type → values map for auto-detecting dropdowns
  const configTypeMap = {};
  getAllRows(SHEET_NAMES.CONFIG).filter(r => r['Status'] === 'Active').forEach(r => {
    const type = String(r['Config Type'] || '').trim();
    const val  = String(r['Value']       || '').trim();
    if (type && val) { if (!configTypeMap[type]) configTypeMap[type] = []; configTypeMap[type].push(val); }
  });
  const AUTO_DROPDOWN = {
    'category': 'Category', 'source': 'Lead Source', 'lead source': 'Lead Source',
    'state': 'State', 'priority': 'Priority', 'product interest': 'Product Interest',
    'lead status': 'Lead Status', 'status': 'Lead Status',
    'follow-up type': 'Follow-up Type', 'followup type': 'Follow-up Type',
  };

  return rows.map(r => {
    const cfg = _normalizeBulkConfigRow_(r);
    if (!cfg.fieldName || !cfg.targetColumn) return null;
    if (!cfg.allowedValues.length) {
      const key = cfg.fieldName.toLowerCase().trim();
      const targetKey = (cfg.targetColumn || cfg.fieldName).toLowerCase().trim();
      const configType = AUTO_DROPDOWN[key] || AUTO_DROPDOWN[targetKey];
      if (configType && configTypeMap[configType]) cfg.allowedValues = configTypeMap[configType];
    }
    return cfg;
  }).filter(Boolean);
}

function validateBulkRows(rows) {
  assertServerContext_();
  if ((Array.isArray(rows) ? rows.length : 0) > BULK_MAX_ROWS) {
    throw new Error('Bulk import supports up to ' + BULK_MAX_ROWS + ' rows at a time.');
  }
  const config = getBulkConfig();
  const existingMap = _bulkExistingMap_();
  const normalized = _bulkRows_(rows).map((row, i) => normalizeBulkRow(row, Number(row.__rowNumber) || i + 1, config));
  const batchMap = { phone: {}, email: {}, company: {} };
  const errorRows = [];
  const validRows = [];
  normalized.forEach(item => {
    const fieldErrors = _bulkRowErrors_(item, config, existingMap);
    const batchDuplicate = _bulkBatchDuplicate_(item.row, batchMap);
    if (batchDuplicate) fieldErrors.push({ fieldName: null, message: batchDuplicate });
    if (fieldErrors.length) errorRows.push({ rowNumber: item.rowNumber, errors: fieldErrors.map(e => e.message).join('; '), fieldErrors, ...item.input });
    else validRows.push(item.row);
  });
  return {
    summary: { total: normalized.length, valid: validRows.length, errors: errorRows.length, saved: 0 },
    validRows,
    errorRows
  };
}

function saveBulkRows(rows, userEmail) {
  assertServerContext_();
  const batchId = generateUUID();
  const sourceRows = _bulkRows_(rows);
  if (sourceRows.length > BULK_MAX_ROWS) throw new Error('Bulk import supports up to ' + BULK_MAX_ROWS + ' rows at a time.');
  const rowResults = [];
  let saved = 0;
  let errors = 0;
  sourceRows.forEach((row, i) => {
    const result = saveBulkRow(row, Number(row.__rowNumber) || i + 1, userEmail);
    rowResults.push(result);
    if (result.saved) saved++;
    else errors++;
    _bulkSetProgress_(batchId, {
      batchId,
      status: 'PROCESSING',
      percent: Math.round(((i + 1) / sourceRows.length) * 100),
      saved,
      errors,
      currentRow: result.rowNumber
    });
  });
  const summary = {
    batchId,
    total: sourceRows.length,
    valid: saved,
    errors,
    saved
  };
  _bulkSetProgress_(batchId, { batchId, status: 'DONE', percent: 100, saved, errors });
  logBulkImport(summary, userEmail);
  return {
    batchId,
    summary,
    rowResults,
    errorRows: rowResults.filter(r => !r.saved).map(r => ({
      rowNumber: r.rowNumber,
      errors: r.errors,
      fieldErrors: r.fieldErrors || []
    }))
  };
}

function saveBulkRow(row, rowNumber, userEmail) {
  assertServerContext_();
  const source = { ...(row || {}), __rowNumber: Number(rowNumber) || Number(row && row.__rowNumber) || 1 };
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const validation = validateBulkRows([source]);
    if (validation.errorRows.length) {
      const err = validation.errorRows[0];
      return {
        rowNumber: source.__rowNumber,
        saved: false,
        status: 'Error',
        errors: err.errors || 'Validation failed',
        fieldErrors: err.fieldErrors || []
      };
    }
    const payload = validation.validRows[0] || {};
    if (!payload['Stage ID']) payload['Stage ID'] = _bulkInitialStageId_();
    const response = withTrustedWriteUser_(userEmail, () => saveLead(payload, userEmail));
    if (!response || !response.success) {
      return {
        rowNumber: source.__rowNumber,
        saved: false,
        status: 'Error',
        errors: response && response.error ? response.error : 'Lead save failed',
        fieldErrors: []
      };
    }
    return {
      rowNumber: source.__rowNumber,
      saved: true,
      status: 'Saved',
      recordId: response.data || '',
      errors: ''
    };
  } catch (e) {
    return {
      rowNumber: source.__rowNumber,
      saved: false,
      status: 'Error',
      errors: e.message || String(e),
      fieldErrors: []
    };
  } finally {
    lock.releaseLock();
  }
}

function getBulkProgress(batchId) {
  assertServerContext_();
  const key = 'BULK_PROGRESS_' + String(batchId || '');
  try {
    const raw = PropertiesService.getScriptProperties().getProperty(key);
    return raw ? JSON.parse(raw) : { batchId, status: 'UNKNOWN', percent: 0 };
  } catch (e) {
    return { batchId, status: 'UNKNOWN', percent: 0 };
  }
}

function createErrorCsv(errorRows) {
  assertServerContext_();
  const rows = Array.isArray(errorRows) ? errorRows : [];
  if (!rows.length) return '';
  const headers = Object.keys(rows.reduce((m, r) => {
    Object.keys(r || {}).forEach(k => { m[k] = true; });
    return m;
  }, {}));
  const esc = v => '"' + String(v === undefined || v === null ? '' : v).replace(/"/g, '""') + '"';
  return [headers.join(',')]
    .concat(rows.map(r => headers.map(h => esc(r[h])).join(',')))
    .join('\n');
}

function normalizeBulkRow(row, rowNumber, config) {
  const input = Object.keys(row || {}).reduce((m, key) => {
    if (!String(key).startsWith('__')) m[key] = row[key];
    return m;
  }, {});
  const out = {};
  config.forEach(field => {
    const raw = input[field.fieldName];
    out[field.targetHeader] = _bulkNormalizeValue_(raw, field);
  });
  return { rowNumber, input, row: out };
}

function checkDuplicate(row, existingMap) {
  const phone = String(row['Phone'] || '').trim();
  const email = String(row['Email'] || '').trim().toLowerCase();
  const company = String(row['Company Name'] || '').trim().toLowerCase();
  if (phone && existingMap.phone[phone]) return 'Duplicate phone already exists.';
  if (email && existingMap.email[email]) return 'Duplicate email already exists.';
  if (company && existingMap.company[company]) return 'Duplicate company already exists.';
  return '';
}

function _bulkBatchDuplicate_(row, batchMap) {
  const phone = String(row['Phone'] || '').trim();
  const email = String(row['Email'] || '').trim().toLowerCase();
  const company = String(row['Company Name'] || '').trim().toLowerCase();
  if (phone && batchMap.phone[phone]) return 'Duplicate phone in pasted rows.';
  if (email && batchMap.email[email]) return 'Duplicate email in pasted rows.';
  if (company && batchMap.company[company]) return 'Duplicate company in pasted rows.';
  if (phone) batchMap.phone[phone] = true;
  if (email) batchMap.email[email] = true;
  if (company) batchMap.company[company] = true;
  return '';
}

function writeBulkRows(validRows, batchId) {
  throw new Error('Direct bulk sheet writes are disabled. Use saveBulkRow/saveBulkRows so lead creation rules run.');
}

function logBulkImport(summary, userEmail) {
  safeInitHeaders(SHEET_NAMES.BULK_AUDIT_LOG, [
    'Batch ID','Timestamp','Total Rows','Valid Rows','Saved Rows','Error Rows','Imported By'
  ]);
  const sheet = getSheet(SHEET_NAMES.BULK_AUDIT_LOG);
  const headers = getHeaders(SHEET_NAMES.BULK_AUDIT_LOG);
  const row = {
    'Batch ID': summary.batchId || '',
    'Timestamp': now(),
    'Total Rows': summary.total || 0,
    'Valid Rows': summary.valid || 0,
    'Saved Rows': summary.saved || 0,
    'Error Rows': summary.errors || 0,
    'Imported By': userEmail || TRUSTED_WRITE_EMAIL || ''
  };
  sheet.getRange(sheet.getLastRow() + 1, 1, 1, headers.length)
    .setValues([headers.map(h => row[h] !== undefined ? row[h] : '')]);
}

function _ensureBulkSheets_() {
  safeInitHeaders(SHEET_NAMES.BULK_CONFIG, [
    'Field Name','Required','Data Type','Target Column','Validation Rule','Allowed Values'
  ]);
  safeInitHeaders(SHEET_NAMES.BULK_AUDIT_LOG, [
    'Batch ID','Timestamp','Total Rows','Valid Rows','Saved Rows','Error Rows','Imported By'
  ]);
  const configSheet = getSheet(SHEET_NAMES.BULK_CONFIG);
  if (configSheet.getLastRow() < 2) {
    const defaults = [
      ['Company Name','Yes','Text','Company Name','notBlank'],
      ['Contact Person','Yes','Text','Contact Person','notBlank'],
      ['Phone','Yes','Text','Phone','phone'],
      ['Email','No','Text','Email','email'],
      ['Category','Yes','Text','Category','notBlank'],
      ['Source','Yes','Text','Source','notBlank'],
      ['State','Yes','Text','State','notBlank'],
      ['City','Yes','Text','City','notBlank'],
      ['Product Interest','No','Text','Product Interest','optional'],
      ['Remark','No','Text','Remark','optional']
    ];
    configSheet.getRange(2, 1, defaults.length, defaults[0].length).setValues(defaults);
  }
}

function _normalizeBulkConfigRow_(row) {
  const fieldName = String(row['Field Name'] || '').trim();
  const targetColumn = String(row['Target Column'] || fieldName).trim();
  const rawAllowed = String(row['Allowed Values'] || '').trim();
  const allowedValues = rawAllowed ? rawAllowed.split(',').map(s => s.trim()).filter(Boolean) : [];
  return {
    fieldName,
    required: String(row['Required'] || '').trim().toLowerCase() === 'yes' || row['Required'] === true,
    dataType: String(row['Data Type'] || 'Text').trim(),
    targetColumn,
    targetHeader: _bulkTargetHeader_(targetColumn) || fieldName,
    validationRule: String(row['Validation Rule'] || '').trim() || 'optional',
    allowedValues
  };
}

function _bulkRows_(rows) {
  return (Array.isArray(rows) ? rows : []).filter(row =>
    row && Object.keys(row).some(k => String(row[k] === undefined || row[k] === null ? '' : row[k]).trim() !== '')
  );
}

function _bulkTargetHeader_(targetColumn) {
  const target = String(targetColumn || '').trim();
  if (!/^[A-Z]+$/i.test(target)) return target;
  const headers = getHeaders(SHEET_NAMES.LEADS);
  const index = _columnLetterToIndex_(target) - 1;
  return headers[index] || target;
}

function _columnLetterToIndex_(letter) {
  return String(letter || '').toUpperCase().split('').reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
}

function _bulkNormalizeValue_(value, field) {
  const raw = value === undefined || value === null ? '' : value;
  if (field.dataType === 'Number') return raw === '' ? '' : Number(raw);
  if (field.dataType === 'Date') return raw ? formatDate(raw) : '';
  return String(raw).trim();
}

function _bulkRowErrors_(item, config, existingMap) {
  const errors = [];
  config.forEach(field => {
    const value = item.row[field.targetHeader];
    const empty = value === undefined || value === null || value === '';
    if (field.required && empty) { errors.push({ fieldName: field.fieldName, message: field.fieldName + ' is required' }); return; }
    if (empty) return;
    if (field.dataType === 'Number' && Number(value) !== value) errors.push({ fieldName: field.fieldName, message: field.fieldName + ' must be a number' });
    if (field.dataType === 'Date' && String(new Date(value)) === 'Invalid Date') errors.push({ fieldName: field.fieldName, message: field.fieldName + ' must be a valid date' });
    if (field.validationRule === 'greaterThanZero' && Number(value) <= 0) errors.push({ fieldName: field.fieldName, message: field.fieldName + ' must be greater than zero' });
    if (field.validationRule === 'validDate' && String(new Date(value)) === 'Invalid Date') errors.push({ fieldName: field.fieldName, message: field.fieldName + ' must be a valid date' });
    if (field.validationRule === 'email' && value && !isValidEmail(String(value))) errors.push({ fieldName: field.fieldName, message: field.fieldName + ' must be a valid email' });
    if (field.validationRule === 'phone' && value && !/^[0-9+\-\s()]{7,20}$/.test(String(value))) errors.push({ fieldName: field.fieldName, message: field.fieldName + ' must be a valid phone' });
    if (field.allowedValues && field.allowedValues.length && !field.allowedValues.map(v => v.toLowerCase()).includes(String(value).toLowerCase())) errors.push({ fieldName: field.fieldName, message: field.fieldName + ' must be one of: ' + field.allowedValues.join(', ') });
  });
  const duplicate = checkDuplicate(item.row, existingMap);
  if (duplicate) errors.push({ fieldName: null, message: duplicate });
  return errors;
}

function _bulkExistingMap_() {
  return getAllRows(SHEET_NAMES.LEADS).reduce((m, row) => {
    const phone = String(row['Phone'] || '').trim();
    const email = String(row['Email'] || '').trim().toLowerCase();
    const company = String(row['Company Name'] || '').trim().toLowerCase();
    if (phone) m.phone[phone] = true;
    if (email) m.email[email] = true;
    if (company) m.company[company] = true;
    return m;
  }, { phone: {}, email: {}, company: {} });
}

function _bulkInitialStageId_() {
  const stages = getAllRows(SHEET_NAMES.STAGES)
    .filter(s => s['Is Active'] !== false && s['Is Active'] !== 'FALSE')
    .sort((a, b) => Number(a['Stage Order'] || 0) - Number(b['Stage Order'] || 0));
  const initial = stages.find(s => s['Is Initial Stage'] === true || s['Is Initial Stage'] === 'TRUE') || stages[0];
  return initial ? initial['Stage ID'] || '' : '';
}

function _bulkSetProgress_(batchId, data) {
  if (!batchId) return;
  try {
    PropertiesService.getScriptProperties()
      .setProperty('BULK_PROGRESS_' + batchId, JSON.stringify(data || {}));
  } catch (e) {}
}
