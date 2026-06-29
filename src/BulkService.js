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
    if (String(cfg.targetHeader || cfg.targetColumn || '').trim().toLowerCase() === 'assigned to') {
      cfg.allowedValues = getAllRows(SHEET_NAMES.USERS)
        .filter(u => u['Status'] === 'Active')
        .map(u => String(getStaffUserId(u, String(u['Email Address'] || '').trim().toLowerCase()) || '').trim())
        .filter(Boolean);
    }
    return cfg;
  }).filter(Boolean);
}

function validateBulkRows(rows, mode) {
  assertServerContext_();
  mode = _bulkMode_(mode);
  if ((Array.isArray(rows) ? rows.length : 0) > BULK_MAX_ROWS) {
    throw new Error('Bulk import supports up to ' + BULK_MAX_ROWS + ' rows at a time.');
  }
  return _validateBulkRowsWithContext_(rows, mode, _bulkValidationContext_());
}

function _bulkValidationContext_() {
  const config = getBulkConfig();
  const leads = _bulkLeadIndexRows_();
  return {
    config,
    leads,
    existingMap: _bulkExistingMap_(leads)
  };
}

function _validateBulkRowsWithContext_(rows, mode, ctx) {
  mode = _bulkMode_(mode);
  const config = ctx && ctx.config || getBulkConfig();
  const leads = ctx && ctx.leads || _bulkLeadIndexRows_();
  const existingMap = ctx && ctx.existingMap || _bulkExistingMap_(leads);
  const normalized = _bulkRows_(rows).map((row, i) => normalizeBulkRow(row, Number(row.__rowNumber) || i + 1, config));
  const batchMap = { phone: {}, email: {}, company: {} };
  const updateLeadMap = {};
  const errorRows = [];
  const validRows = [];
  const validItems = [];
  normalized.forEach(item => {
    const lead = mode === 'update' ? _bulkFindLeadForRow_(item.row, leads) : null;
    const fieldErrors = _bulkRowErrors_(item, config, existingMap, mode, lead ? lead['Lead ID'] : '');
    if (mode === 'create' && String(item.row['Lead ID'] || '').trim()) {
      fieldErrors.push({ fieldName: 'Lead ID', message: 'Lead ID is only allowed in Update mode.' });
    }
    if (mode === 'update' && !lead) {
      fieldErrors.push({ fieldName: null, message: 'Existing lead not found for update. Provide Lead ID, Phone, Email, or Company Name.' });
    }
    if (mode === 'update' && lead && updateLeadMap[lead['Lead ID']]) {
      fieldErrors.push({ fieldName: null, message: 'Duplicate update target in pasted rows: ' + lead['Lead ID'] });
    }
    const batchDuplicate = _bulkBatchDuplicate_(item.row, batchMap, mode);
    if (mode === 'create' && batchDuplicate) fieldErrors.push({ fieldName: null, message: batchDuplicate });
    if (fieldErrors.length) errorRows.push({ rowNumber: item.rowNumber, errors: fieldErrors.map(e => e.message).join('; '), fieldErrors, ...item.input });
    else {
      if (mode === 'update' && lead) updateLeadMap[lead['Lead ID']] = true;
      const payload = mode === 'update' ? _bulkUpdatePayload_(item.row, lead['Lead ID']) : item.row;
      validRows.push(payload);
      validItems.push({ rowNumber: item.rowNumber, payload });
    }
  });
  return {
    summary: { total: normalized.length, valid: validRows.length, errors: errorRows.length, saved: 0 },
    validRows,
    validItems,
    errorRows
  };
}

function saveBulkRows(rows, userEmail, requestedBatchId, mode) {
  assertServerContext_();
  mode = _bulkMode_(mode);
  const batchId = String(requestedBatchId || '').trim() || generateUUID();
  const sourceRows = _bulkRows_(rows);
  if (sourceRows.length > BULK_MAX_ROWS) throw new Error('Bulk import supports up to ' + BULK_MAX_ROWS + ' rows at a time.');
  const validation = _validateBulkRowsWithContext_(sourceRows, mode, _bulkValidationContext_());
  const validByRow = (validation.validItems || []).reduce((m, item) => {
    m[item.rowNumber] = item.payload;
    return m;
  }, {});
  const errorByRow = (validation.errorRows || []).reduce((m, row) => {
    m[row.rowNumber] = row;
    return m;
  }, {});
  const initialStageId = mode === 'create' ? _bulkInitialStageId_() : '';
  const rowResults = [];
  let saved = 0;
  let errors = 0;
  const fastCreate = mode === 'create'
    ? _trySaveBulkCreateFast_(sourceRows, validByRow, errorByRow, userEmail, initialStageId, batchId)
    : null;
  if (fastCreate) {
    logBulkImport(fastCreate.summary, userEmail);
    return fastCreate;
  }
  sourceRows.forEach((row, i) => {
    const rowNumber = Number(row.__rowNumber) || i + 1;
    const preError = errorByRow[rowNumber];
    const result = preError
      ? {
          rowNumber,
          saved: false,
          status: 'Error',
          errors: preError.errors || 'Validation failed',
          fieldErrors: preError.fieldErrors || []
        }
      : _saveBulkRowUnlocked_(row, rowNumber, userEmail, mode, validByRow[rowNumber], initialStageId);
    rowResults.push(result);
    if (result.saved) saved++;
    else errors++;
  });
  const summary = {
    batchId,
    mode,
    total: sourceRows.length,
    valid: saved,
    errors,
    saved
  };
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

function _saveBulkRowUnlocked_(row, rowNumber, userEmail, mode) {
  const preparedPayload = arguments.length >= 5 ? arguments[4] : null;
  const initialStageId = arguments.length >= 6 ? arguments[5] : '';
  mode = _bulkMode_(mode);
  const source = { ...(row || {}), __rowNumber: Number(rowNumber) || Number(row && row.__rowNumber) || 1 };
  try {
    let payload = preparedPayload;
    if (!payload) {
      const validation = validateBulkRows([source], mode);
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
      payload = validation.validRows[0] || {};
    }
    if (mode === 'create' && !payload['Stage ID']) payload['Stage ID'] = initialStageId || _bulkInitialStageId_();
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
  }
}

function _trySaveBulkCreateFast_(sourceRows, validByRow, errorByRow, userEmail, initialStageId, batchId) {
  const validItems = [];
  const rowResults = [];
  sourceRows.forEach((row, i) => {
    const rowNumber = Number(row.__rowNumber) || i + 1;
    const preError = errorByRow[rowNumber];
    if (preError) {
      rowResults.push({
        rowNumber,
        saved: false,
        status: 'Error',
        errors: preError.errors || 'Validation failed',
        fieldErrors: preError.fieldErrors || []
      });
      return;
    }
    const payload = validByRow[rowNumber];
    if (!payload || _bulkPayloadHasComplexValue_(payload)) return;
    validItems.push({ rowNumber, payload });
  });
  if (!validItems.length) return null;
  if (validItems.length !== sourceRows.length - rowResults.length) return null;

  try {
    return withTrustedWriteUser_(userEmail, () =>
      _saveBulkCreateFast_(sourceRows, validItems, rowResults, userEmail, initialStageId, batchId)
    );
  } catch (e) {
    _logBulkFastFallback_(batchId, e);
    return null;
  }
}

function _saveBulkCreateFast_(sourceRows, validItems, preResults, userEmail, initialStageId, batchId) {
  const user = requireRole(['ADMIN', 'MANAGER', 'SALES']);
  const ts = now();
  const followupDate = today();
  const fuTypes = getConfigByType('Follow-up Type');
  const defaultFollowupType = fuTypes[0] || 'Call';
  const leadRows = [];
  const followupRows = [];
  const customRows = [];
  const leadIds = [];
  const followupIds = [];
  const rowResultsByNumber = {};
  const fieldCache = {};
  let saved = 0;
  let errors = preResults.length;

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const latestMap = _bulkExistingMap_(_bulkLeadIndexRows_());
    validItems.forEach(item => {
      const payload = { ...(item.payload || {}) };
      const duplicate = checkDuplicate(payload, latestMap, '');
      if (duplicate) {
        rowResultsByNumber[item.rowNumber] = {
          rowNumber: item.rowNumber,
          saved: false,
          status: 'Error',
          errors: duplicate,
          fieldErrors: []
        };
        errors++;
        return;
      }

      const id = generateUUID();
      const followupId = generateUUID();
      if (!payload['Stage ID']) payload['Stage ID'] = initialStageId || _bulkInitialStageId_();
      if (user.role === 'SALES') payload['Assigned To'] = user.id;
      const skipped = payload['__stage_skipped'] === 'true' || payload['skipped'] === true;
      const prepared = _prepareLeadPayload(payload, payload['Stage ID'], {}, skipped);
      _applyLeadStatusFromStage(prepared, prepared['Stage ID']);
      const leadRow = {
        ...prepared,
        'Lead ID': id,
        'Assigned To': prepared['Assigned To'] || user.id,
        'Lead Status': prepared['Lead Status'] || 'Open',
        'Last Follow-up Date': prepared['Last Follow-up Date'] || followupDate,
        'Next Follow-up Date': prepared['Next Follow-up Date'] || followupDate,
        'Created At': ts,
        'Updated At': ts
      };
      leadRows.push(pickLeadMasterFields_(leadRow));
      leadIds.push(id);
      followupRows.push(pickFollowupMasterFields_({
        'Follow-up ID': followupId,
        'Lead ID': id,
        'Planned Date': followupDate,
        'Follow-up Date': followupDate,
        'Follow-up Type': defaultFollowupType,
        'Discussion': 'New lead created',
        'Next Follow-up Date': followupDate,
        'Status': 'Open',
        'Stage ID': prepared['Stage ID'] || '',
        'Created By': user.id,
        'Created At': ts,
        'Updated At': ts
      }));
      followupIds.push(followupId);
      _bulkCustomValueRowsForLead_(id, prepared, user.id, prepared['Stage ID'], ts, fieldCache)
        .forEach(r => customRows.push(r));
      _bulkMarkDuplicateKeys_(latestMap, leadRow, id);
      rowResultsByNumber[item.rowNumber] = {
        rowNumber: item.rowNumber,
        saved: true,
        status: 'Saved',
        recordId: id,
        errors: ''
      };
      saved++;
    });

    try {
      _bulkAppendRows_(SHEET_NAMES.LEADS, leadRows);
      _bulkAppendRows_(SHEET_NAMES.FOLLOWUPS, followupRows);
      _bulkAppendRows_(SHEET_NAMES.LEAD_FIELD_VALUES, customRows);
    } catch (e) {
      _bulkRollbackFastCreate_(leadIds, followupIds);
      throw e;
    }
  } finally {
    lock.releaseLock();
  }

  const rowResults = sourceRows.map((row, i) => {
    const rowNumber = Number(row.__rowNumber) || i + 1;
    return rowResultsByNumber[rowNumber] || preResults.find(r => Number(r.rowNumber) === rowNumber) || {
      rowNumber,
      saved: false,
      status: 'Error',
      errors: 'Row was not processed.',
      fieldErrors: []
    };
  });
  const summary = { batchId, mode: 'create', total: sourceRows.length, valid: saved, errors, saved };
  if (saved) {
    _bumpStamp('leads');
    _bumpStamp('followups');
  }
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

function _logBulkFastFallback_(batchId, error) {
  const message = error && error.message ? error.message : String(error || 'Unknown fast bulk fallback');
  try {
    Logger.log('[BulkService] Fast bulk create fallback for batch ' + (batchId || '-') + ': ' + message);
  } catch (_) {}
}

function _bulkPayloadHasComplexValue_(payload) {
  return Object.keys(payload || {}).some(key => {
    const value = payload[key];
    return value && typeof value === 'object';
  });
}

function _bulkAppendRows_(sheetName, rowObjects) {
  if (!rowObjects || !rowObjects.length) return;
  if (sheetName === SHEET_NAMES.LEAD_FIELD_VALUES) ensureCustomFieldValueSheets_();
  if (sheetName === SHEET_NAMES.FOLLOWUPS) ensureFollowupSheets_();
  const sheet = getSheet(sheetName);
  const headers = getHeaders(sheetName);
  const values = rowObjects.map(row => headers.map(h => row[h] !== undefined ? row[h] : ''));
  const startRow = sheet.getLastRow() + 1;
  sheet.getRange(startRow, 1, values.length, headers.length).setValues(values);
  if (typeof syncIndexRow_ === 'function') {
    rowObjects.forEach((row, i) => syncIndexRow_(sheetName, row, startRow + i));
  }
}

function _bulkRollbackFastCreate_(leadIds, followupIds) {
  const leadSet = (leadIds || []).reduce((m, id) => { if (id) m[String(id)] = true; return m; }, {});
  const followupSet = (followupIds || []).reduce((m, id) => { if (id) m[String(id)] = true; return m; }, {});
  _bulkDeleteRowsNoLock_(SHEET_NAMES.LEAD_FIELD_VALUES, row => leadSet[String(row['Lead ID'] || '')]);
  _bulkDeleteRowsNoLock_(SHEET_NAMES.FOLLOWUPS, row =>
    followupSet[String(row['Follow-up ID'] || '')] || leadSet[String(row['Lead ID'] || '')]
  );
  _bulkDeleteRowsNoLock_(SHEET_NAMES.LEADS, row => leadSet[String(row['Lead ID'] || '')]);
  if (typeof rebuildIndexAfterDelete_ === 'function') {
    rebuildIndexAfterDelete_(SHEET_NAMES.FOLLOWUPS);
    rebuildIndexAfterDelete_(SHEET_NAMES.LEADS);
  }
}

function _bulkDeleteRowsNoLock_(sheetName, predicate) {
  const sheet = getSheet(sheetName);
  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return 0;
  const headers = data[0];
  let deleted = 0;
  for (let i = data.length - 1; i >= 1; i--) {
    const row = headers.reduce((m, h, j) => { m[h] = data[i][j]; return m; }, {});
    if (predicate(row)) {
      sheet.deleteRow(i + 1);
      deleted++;
    }
  }
  if (deleted && typeof rebuildIndexAfterDelete_ === 'function') rebuildIndexAfterDelete_(sheetName);
  return deleted;
}

function _bulkCustomValueRowsForLead_(leadId, payload, userId, stageId, ts, fieldCache) {
  ensureCustomFieldValueSheets_();
  const cacheKey = String(stageId || '');
  const fields = fieldCache && fieldCache[cacheKey]
    ? fieldCache[cacheKey]
    : _bulkCustomFieldsForLeadWrite_(stageId);
  if (fieldCache) fieldCache[cacheKey] = fields;
  return fields
    .filter(field => field['Field Type'] !== 'Formula')
    .map(field => {
      const key = _customEffectiveColumnKey_(field, stageId);
      if (!key || !Object.prototype.hasOwnProperty.call(payload, key)) return null;
      const value = payload[key];
      if (value === undefined || value === null || value === '') return null;
      const isFile = field['Field Type'] === 'File';
      return {
        'Value ID': generateUUID(),
        'Lead ID': leadId,
        'Field ID': field['Field ID'],
        'Column Key': key,
        'Field Value': isFile ? '' : _customStoredValue_(value),
        'File URL': isFile ? _customStoredValue_(value) : '',
        'Updated By': userId || '',
        'Updated At': ts || now()
      };
    })
    .filter(Boolean);
}

function _bulkCustomFieldsForLeadWrite_(stageId) {
  return queryRows(SHEET_NAMES.FIELD_CONFIG, r =>
      (r['Sheet Name'] || 'Leads') === 'Leads' &&
      (r['Is Visible'] !== false && r['Is Visible'] !== 'FALSE') &&
      (!r['Stage ID'] || r['Stage ID'] === stageId)
    );
}

function _bulkMarkDuplicateKeys_(map, row, leadId) {
  const phone = _bulkNormPhone_(row['Phone']);
  const altPhone = _bulkNormPhone_(row['Alternate No']);
  const email = _bulkNormEmail_(row['Email']);
  const company = _bulkNormText_(row['Company Name']);
  if (phone) map.phone[phone] = leadId;
  if (altPhone) map.phone[altPhone] = leadId;
  if (email) map.email[email] = leadId;
  if (company) map.company[company] = leadId;
}

function createBulkFollowupOnlyRow(row, rowNumber, userEmail) {
  assertServerContext_();
  const source = { ...(row || {}), __rowNumber: Number(rowNumber) || Number(row && row.__rowNumber) || 1 };
  try {
    const config = getBulkConfig();
    const normalized = normalizeBulkRow(source, source.__rowNumber, config);
    const lead = _bulkFindLeadForRow_(normalized.row);
    if (!lead) {
      return {
        rowNumber: source.__rowNumber,
        saved: false,
        status: 'Error',
        errors: 'Create lead first.',
        fieldErrors: []
      };
    }
    const result = withTrustedWriteUser_(userEmail, () => {
      const user = requireRole(['ADMIN', 'MANAGER', 'SALES']);
      if (!_canWriteLead(lead, user)) throw new Error('Permission denied for this lead.');
      if (_bulkLeadHasAnyFollowup_(lead['Lead ID'])) {
        throw new Error('Follow-up already exists for this lead.');
      }
      _bulkCreateInitialFollowupForLead_(lead, user);
      return { status: 'Follow-up Created', recordId: lead['Lead ID'], message: '' };
    });
    return {
      rowNumber: source.__rowNumber,
      saved: result.status === 'Follow-up Created',
      skipped: false,
      status: result.status,
      recordId: result.recordId || lead['Lead ID'] || '',
      errors: result.message || ''
    };
  } catch (e) {
    return {
      rowNumber: source.__rowNumber,
      saved: false,
      status: 'Error',
      errors: e.message || String(e),
      fieldErrors: []
    };
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
    const raw = Object.prototype.hasOwnProperty.call(input, field.fieldName)
      ? input[field.fieldName]
      : input[field.targetHeader];
    out[field.targetHeader] = _bulkNormalizeValue_(raw, field);
  });
  return { rowNumber, input, row: out };
}

function _bulkNormPhone_(value) {
  return String(value || '').replace(/\D/g, '');
}

function _bulkNormEmail_(value) {
  return String(value || '').trim().toLowerCase();
}

function _bulkNormText_(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function _bulkMode_(mode) {
  return String(mode || '').trim().toLowerCase() === 'update' ? 'update' : 'create';
}

function _bulkUpdatePayload_(row, leadId) {
  const payload = { 'Lead ID': leadId };
  Object.keys(row || {}).forEach(key => {
    const value = row[key];
    if (key === 'Lead ID' || key === 'Lead Id' || key === 'ID') return;
    if (value === undefined || value === null || value === '') return;
    payload[key] = value;
  });
  return payload;
}

function checkDuplicate(row, existingMap, excludeLeadId) {
  excludeLeadId = String(excludeLeadId || '').trim();
  const phone = _bulkNormPhone_(row['Phone']);
  const email = _bulkNormEmail_(row['Email']);
  const company = _bulkNormText_(row['Company Name']);
  const phoneHit = phone ? existingMap.phone[phone] : '';
  const emailHit = email ? existingMap.email[email] : '';
  const companyHit = company ? existingMap.company[company] : '';
  if (phoneHit && phoneHit !== excludeLeadId) return 'Duplicate phone already exists.';
  if (emailHit && emailHit !== excludeLeadId) return 'Duplicate email already exists.';
  if (companyHit && companyHit !== excludeLeadId) return 'Duplicate company already exists.';
  return '';
}

function _bulkBatchDuplicate_(row, batchMap, mode) {
  if (_bulkMode_(mode) === 'update') return '';
  const phone = _bulkNormPhone_(row['Phone']);
  const email = _bulkNormEmail_(row['Email']);
  const company = _bulkNormText_(row['Company Name']);
  if (phone && batchMap.phone[phone]) return 'Duplicate phone in pasted rows.';
  if (email && batchMap.email[email]) return 'Duplicate email in pasted rows.';
  if (company && batchMap.company[company]) return 'Duplicate company in pasted rows.';
  if (phone) batchMap.phone[phone] = true;
  if (email) batchMap.email[email] = true;
  if (company) batchMap.company[company] = true;
  return '';
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
      ['Lead ID','No','Text','Lead ID','optional'],
      ['Company Name','Yes','Text','Company Name','notBlank'],
      ['Contact Person','Yes','Text','Contact Person','notBlank'],
      ['Phone','Yes','Text','Phone','phone'],
      ['Email','No','Text','Email','email'],
      ['Category','Yes','Text','Category','notBlank'],
      ['Source','Yes','Text','Source','notBlank'],
      ['Assigned To','No','Text','Assigned To','optional'],
      ['State','Yes','Text','State','notBlank'],
      ['City','Yes','Text','City','notBlank'],
      ['Product Interest','No','Text','Product Interest','optional'],
      ['Remark','No','Text','Remark','optional']
    ];
    configSheet.getRange(2, 1, defaults.length, defaults[0].length).setValues(defaults);
  } else {
    const hasLeadId = getAllRows(SHEET_NAMES.BULK_CONFIG).some(r =>
      String(r['Field Name'] || '').trim().toLowerCase() === 'lead id' ||
      String(r['Target Column'] || '').trim().toLowerCase() === 'lead id'
    );
    if (!hasLeadId) {
      const headers = getHeaders(SHEET_NAMES.BULK_CONFIG);
      const row = {
        'Field Name': 'Lead ID',
        'Required': 'No',
        'Data Type': 'Text',
        'Target Column': 'Lead ID',
        'Validation Rule': 'optional',
        'Allowed Values': ''
      };
      configSheet.getRange(configSheet.getLastRow() + 1, 1, 1, headers.length)
        .setValues([headers.map(h => row[h] !== undefined ? row[h] : '')]);
    }
    const hasAssignedTo = getAllRows(SHEET_NAMES.BULK_CONFIG).some(r =>
      String(r['Field Name'] || '').trim().toLowerCase() === 'assigned to' ||
      String(r['Target Column'] || '').trim().toLowerCase() === 'assigned to'
    );
    if (!hasAssignedTo) {
      const headers = getHeaders(SHEET_NAMES.BULK_CONFIG);
      const row = {
        'Field Name': 'Assigned To',
        'Required': 'No',
        'Data Type': 'Text',
        'Target Column': 'Assigned To',
        'Validation Rule': 'optional',
        'Allowed Values': ''
      };
      configSheet.getRange(configSheet.getLastRow() + 1, 1, 1, headers.length)
        .setValues([headers.map(h => row[h] !== undefined ? row[h] : '')]);
    }
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

function _bulkRowErrors_(item, config, existingMap, mode, excludeLeadId) {
  const errors = [];
  mode = _bulkMode_(mode);
  config.forEach(field => {
    const value = item.row[field.targetHeader];
    const empty = value === undefined || value === null || value === '';
    if (field.required && empty) {
      if (mode === 'update') return;
      errors.push({ fieldName: field.fieldName, message: field.fieldName + ' is required' });
      return;
    }
    if (empty) return;
    if (field.dataType === 'Number' && Number(value) !== value) errors.push({ fieldName: field.fieldName, message: field.fieldName + ' must be a number' });
    if (field.dataType === 'Date' && String(new Date(value)) === 'Invalid Date') errors.push({ fieldName: field.fieldName, message: field.fieldName + ' must be a valid date' });
    if (field.validationRule === 'greaterThanZero' && Number(value) <= 0) errors.push({ fieldName: field.fieldName, message: field.fieldName + ' must be greater than zero' });
    if (field.validationRule === 'validDate' && String(new Date(value)) === 'Invalid Date') errors.push({ fieldName: field.fieldName, message: field.fieldName + ' must be a valid date' });
    if (field.validationRule === 'email' && value && !isValidEmail(String(value))) errors.push({ fieldName: field.fieldName, message: field.fieldName + ' must be a valid email' });
    if (field.validationRule === 'phone' && value && !/^[0-9+\-\s()]{7,20}$/.test(String(value))) errors.push({ fieldName: field.fieldName, message: field.fieldName + ' must be a valid phone' });
    if (field.allowedValues && field.allowedValues.length && !field.allowedValues.map(v => v.toLowerCase()).includes(String(value).toLowerCase())) errors.push({ fieldName: field.fieldName, message: field.fieldName + ' must be one of: ' + field.allowedValues.join(', ') });
  });
  const duplicate = checkDuplicate(item.row, existingMap, mode === 'update' ? excludeLeadId : '');
  if (mode === 'create' && duplicate) errors.push({ fieldName: null, message: duplicate });
  if (mode === 'update' && duplicate) errors.push({ fieldName: null, message: duplicate });
  return errors;
}

function _bulkExistingMap_(leads) {
  return (Array.isArray(leads) ? leads : getAllRows(SHEET_NAMES.LEADS)).reduce((m, row) => {
    const phone = _bulkNormPhone_(row['Phone']);
    const altPhone = _bulkNormPhone_(row['Alternate No']);
    const email = _bulkNormEmail_(row['Email']);
    const company = _bulkNormText_(row['Company Name']);
    const leadId = String(row['Lead ID'] || '').trim();
    if (phone) m.phone[phone] = leadId;
    if (altPhone) m.phone[altPhone] = leadId;
    if (email) m.email[email] = leadId;
    if (company) m.company[company] = leadId;
    return m;
  }, { phone: {}, email: {}, company: {} });
}

function _bulkLeadIndexRows_() {
  let rows = getAllRows(SHEET_NAMES.IDX_LEADS);
  if (!rows.length && getSheet(SHEET_NAMES.LEADS).getLastRow() > 1) {
    rebuildIndexForSheet_(SHEET_NAMES.LEADS);
    rows = getAllRows(SHEET_NAMES.IDX_LEADS);
  }
  return rows;
}

function _bulkFindLeadForRow_(row, leads) {
  const leadId = String(row['Lead ID'] || row['Lead Id'] || row['ID'] || '').trim();
  const phone = _bulkNormPhone_(row['Phone']);
  const email = _bulkNormEmail_(row['Email']);
  const company = _bulkNormText_(row['Company Name']);
  return (Array.isArray(leads) ? leads : getAllRows(SHEET_NAMES.LEADS)).find(lead => {
    if (leadId && String(lead['Lead ID'] || '').trim() === leadId) return true;
    if (phone && (_bulkNormPhone_(lead['Phone']) === phone || _bulkNormPhone_(lead['Alternate No']) === phone)) return true;
    if (email && _bulkNormEmail_(lead['Email']) === email) return true;
    if (company && _bulkNormText_(lead['Company Name']) === company) return true;
    return false;
  }) || null;
}

function _bulkLeadHasAnyFollowup_(leadId) {
  return getRowsByIndexedColumn_(SHEET_NAMES.FOLLOWUPS, 'Lead ID', leadId).some(row =>
    row['Lead ID'] === leadId
  );
}

function _bulkCreateInitialFollowupForLead_(lead, user) {
  ensureFollowupSheets_();
  const followupDate = lead['Next Follow-up Date'] || today();
  const fuTypes = getConfigByType('Follow-up Type');
  insertRow(SHEET_NAMES.FOLLOWUPS, pickFollowupMasterFields_({
    'Follow-up ID': generateUUID(),
    'Lead ID': lead['Lead ID'],
    'Planned Date': followupDate,
    'Follow-up Date': followupDate,
    'Follow-up Type': fuTypes[0] || 'Call',
    'Discussion': 'New lead created',
    'Next Follow-up Date': followupDate,
    'Status': 'Open',
    'Created By': user.id,
    'Created At': now(),
    'Updated At': now()
  }));
  const patch = { 'Next Follow-up Date': followupDate, 'Updated At': now() };
  if (!lead['Last Follow-up Date']) patch['Last Follow-up Date'] = followupDate;
  updateRow(SHEET_NAMES.LEADS, 'Lead ID', lead['Lead ID'], patch);
  _bumpStamp('leads');
  _bumpStamp('followups');
}

function _bulkInitialStageId_() {
  const stages = getAllRows(SHEET_NAMES.STAGES)
    .filter(s => s['Is Active'] !== false && s['Is Active'] !== 'FALSE')
    .sort((a, b) => Number(a['Stage Order'] || 0) - Number(b['Stage Order'] || 0));
  const initial = stages.find(s => s['Is Initial Stage'] === true || s['Is Initial Stage'] === 'TRUE') || stages[0];
  return initial ? initial['Stage ID'] || '' : '';
}

