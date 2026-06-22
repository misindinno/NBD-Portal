// Fast read helpers backed by the Advanced Google Sheets service.
// Keep browser calls behind Api.js so auth and row scoping still apply.

function sheetApiBatchGetRows_(sheetNames) {
  assertServerContext_();
  if (typeof Sheets === 'undefined' || !Sheets.Spreadsheets || !Sheets.Spreadsheets.Values) {
    throw new Error('Google Sheets advanced service is not enabled.');
  }
  const specs = (sheetNames || [])
    .map(item => {
      if (typeof item === 'object') {
        return {
          sheetName: normalizeSheetName(item.sheetName || item.name || ''),
          range: String(item.range || 'A:ZZ')
        };
      }
      return { sheetName: normalizeSheetName(item), range: 'A:ZZ' };
    })
    .filter(spec => spec.sheetName);
  if (!specs.length) return {};

  const ranges = specs.map(spec => "'" + String(spec.sheetName).replace(/'/g, "''") + "'!" + spec.range);
  const result = Sheets.Spreadsheets.Values.batchGet(SPREADSHEET_ID, {
    ranges,
    valueRenderOption: 'FORMATTED_VALUE',
    dateTimeRenderOption: 'FORMATTED_STRING'
  });
  const valueRanges = result.valueRanges || [];
  return specs.reduce((map, spec, i) => {
    map[spec.sheetName] = _sheetApiValuesToRows_(valueRanges[i] && valueRanges[i].values);
    return map;
  }, {});
}

function _sheetApiValuesToRows_(values) {
  const data = values || [];
  if (data.length < 2) return [];
  const headers = (data[0] || []).map(String);
  return data.slice(1)
    .filter(row => (row || []).some(v => String(v || '').trim() !== ''))
    .map(row => headers.reduce((obj, header, i) => {
      if (header) obj[header] = row[i] !== undefined ? row[i] : '';
      return obj;
    }, {}));
}

function getTodayActivitySnapshotFast_(user) {
  const rows = sheetApiBatchGetRows_([
    { sheetName: SHEET_NAMES.LEADS, range: 'A:AC' },
    { sheetName: SHEET_NAMES.FOLLOWUPS, range: 'A:Q' },
    { sheetName: SHEET_NAMES.FOLLOWUP_HISTORY, range: 'A:O' },
    { sheetName: SHEET_NAMES.LEAD_ACTIVITY_LOGS, range: 'A:H' }
  ]);
  const leads = (rows[SHEET_NAMES.LEADS] || []).filter(lead => !_isArchivedLead_(lead));
  const followups = (rows[SHEET_NAMES.FOLLOWUPS] || [])
    .filter(_isFollowupTaskRow)
    .map(_normalizeFollowupRow);
  const followupHistory = _sheetApiFollowupHistoryRows_(rows[SHEET_NAMES.FOLLOWUP_HISTORY]);
  const activityLogs = rows[SHEET_NAMES.LEAD_ACTIVITY_LOGS] || [];

  return {
    leads: _scopeAssignedRows(leads, user),
    followups: _scopeFollowupRows(followups, user),
    followupHistory: _scopeFollowupHistoryRows(followupHistory, user),
    activityLogs: _scopeActivityLogRows(activityLogs, user),
    source: 'sheets-api',
    fetchedAt: now()
  };
}

function getFollowupPageSnapshotFast_(user, options) {
  const started = Date.now();
  const includeHistory = !!(options && options.includeHistory);
  const specs = [
    { sheetName: SHEET_NAMES.LEADS, range: 'A:AC' },
    { sheetName: SHEET_NAMES.FOLLOWUPS, range: 'A:Q' }
  ];
  if (includeHistory) specs.push({ sheetName: SHEET_NAMES.FOLLOWUP_HISTORY, range: 'A:O' });
  const rows = sheetApiBatchGetRows_(specs);
  const leads = (rows[SHEET_NAMES.LEADS] || []).filter(lead => !_isArchivedLead_(lead));
  const followups = (rows[SHEET_NAMES.FOLLOWUPS] || [])
    .filter(_isFollowupTaskRow)
    .map(_normalizeFollowupRow);
  const visibleLeads = _sheetApiScopeLeadRows_(leads, user);
  const visibleLeadMap = _rowsByKey_(visibleLeads, 'Lead ID');
  const scopedFollowups = _sheetApiScopeLinkedRows_(followups, user, visibleLeadMap, ['Created By', 'Done By']);
  const linkedLeadMap = scopedFollowups.reduce((map, row) => {
    if (row['Lead ID']) map[row['Lead ID']] = true;
    return map;
  }, {});

  return {
    leads: leads.filter(lead => visibleLeadMap[lead['Lead ID']] || linkedLeadMap[lead['Lead ID']]),
    followups: scopedFollowups,
    followupHistory: includeHistory
      ? _sheetApiScopeLinkedRows_(
          _sheetApiFollowupHistoryRows_(rows[SHEET_NAMES.FOLLOWUP_HISTORY]),
          user,
          visibleLeadMap,
          ['Done By']
        )
      : [],
    source: 'sheets-api',
    fetchMs: Date.now() - started,
    fetchedAt: now()
  };
}

function _sheetApiScopeLeadRows_(leads, user) {
  if (_hasAdminFullRead(user)) return leads || [];
  if (!_hasGlobalRead(user)) return (leads || []).filter(lead => _sheetApiUserValueMatches_(lead['Assigned To'], user));
  const scope = _portalDepartmentScopeSet_();
  if (!scope) return leads || [];
  const userMap = _buildUserMapById_();
  return (leads || []).filter(lead => _rowMatchesDepartmentScope_(lead, userMap, scope));
}

function _sheetApiScopeLinkedRows_(rows, user, leadMap, actorFields) {
  if (_hasAdminFullRead(user)) return rows || [];
  if (!_hasGlobalRead(user)) {
    return (rows || []).filter(row =>
      !!leadMap[row['Lead ID']] || actorFields.some(field => _sheetApiUserValueMatches_(row[field], user))
    );
  }
  const scope = _portalDepartmentScopeSet_();
  if (!scope) return rows || [];
  const userMap = _buildUserMapById_();
  return (rows || []).filter(row =>
    leadMap[row['Lead ID']]
      ? _rowMatchesDepartmentScope_(leadMap[row['Lead ID']], userMap, scope)
      : actorFields.some(field => {
          const department = _departmentForUserId_(row[field], userMap);
          return !!scope[String(department || '').trim().toLowerCase()];
        })
  );
}

function _sheetApiUserValueMatches_(value, user) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return false;
  return raw === String(user.id || '').trim().toLowerCase() ||
    raw === String(user.email || '').trim().toLowerCase();
}

function _rowsByKey_(rows, key) {
  return (rows || []).reduce((map, row) => {
    if (row && row[key]) map[row[key]] = row;
    return map;
  }, {});
}

function _sheetApiFollowupHistoryRows_(rows) {
  return (rows || []).filter(row =>
    String(row['History ID'] || row['Follow-up ID'] || row['Lead ID'] || '').trim()
  );
}

function runSheetsApiSampleWrite_(user, payload) {
  assertServerContext_();
  if (!canEditConfigPermission(user)) throw new Error('Permission denied.');
  if (typeof Sheets === 'undefined' || !Sheets.Spreadsheets || !Sheets.Spreadsheets.Values) {
    throw new Error('Google Sheets advanced service is not enabled.');
  }

  const totalStart = Date.now();
  const sheetName = 'SHEETS_API_WRITE_TEST';
  safeInitHeaders(sheetName, [
    'Test ID','Portal','Run By','Client Timestamp','Server Timestamp','Write Method','Note'
  ]);
  const note = String(payload && payload.note || 'Sample config-page Sheets API write test').slice(0, 300);
  const row = [
    generateUUID(),
    CLIENT_CONFIG.APP_TITLE || '',
    user.email || user.id || '',
    String(payload && payload.clientTimestamp || ''),
    now(),
    'Sheets API values.append',
    note
  ];

  const apiStart = Date.now();
  const response = Sheets.Spreadsheets.Values.append(
    { values: [row] },
    SPREADSHEET_ID,
    "'" + sheetName.replace(/'/g, "''") + "'!A:G",
    {
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS'
    }
  );

  return {
    sheetName,
    testId: row[0],
    updatedRange: response.updates && response.updates.updatedRange || '',
    updatedRows: response.updates && response.updates.updatedRows || 0,
    apiWriteMs: Date.now() - apiStart,
    totalMs: Date.now() - totalStart,
    serverTimestamp: row[4]
  };
}

function getQueueHistoryFast_(userEmail, limit) {
  const maxRows = Math.min(Number(limit) || 50, 100);
  const email = String(userEmail || '').trim().toLowerCase();
  return _queueRowsFromSheetsApi_()
    .filter(r => String(r['User Email'] || '').trim().toLowerCase() === email)
    .sort(_queueNewestFirst_)
    .slice(0, maxRows)
    .map(r => _queueHistoryDto_(r, true));
}

function getAllQueueHistoryFast_(filterEmail, limit) {
  const maxRows = Math.min(Number(limit) || 100, 500);
  const filter = filterEmail ? String(filterEmail).trim().toLowerCase() : '';
  return _queueRowsFromSheetsApi_()
    .filter(r => !filter || String(r['User Email'] || '').trim().toLowerCase() === filter)
    .sort(_queueNewestFirst_)
    .slice(0, maxRows)
    .map(r => _queueHistoryDto_(r, false));
}

function getQueueHealthFast_(userEmail, user, filterEmail) {
  const email = String(userEmail || '').trim().toLowerCase();
  const isAdmin = user && user.role === 'ADMIN';
  const filter = String(filterEmail || '').trim().toLowerCase();
  const rows = _queueRowsFromSheetsApi_()
    .filter(r => {
      const rowEmail = String(r['User Email'] || '').trim().toLowerCase();
      if (isAdmin && !filter) return true;
      if (isAdmin && filter) return rowEmail === filter;
      return rowEmail === email;
    });
  return _queueHealthFromRows_(rows, isAdmin, filter);
}

function _queueRowsFromSheetsApi_() {
  return sheetApiBatchGetRows_([{ sheetName: SHEET_NAMES.QUEUE, range: 'A:P' }])[SHEET_NAMES.QUEUE] || [];
}

function _queueNewestFirst_(a, b) {
  const ta = a['Created At'] ? new Date(String(a['Created At']).replace(' ', 'T')).getTime() : 0;
  const tb = b['Created At'] ? new Date(String(b['Created At']).replace(' ', 'T')).getTime() : 0;
  return tb - ta;
}

function _queueHistoryDto_(row, includePendingPayload) {
  const dto = {
    requestId:     String(row['Request ID']      || ''),
    status:        String(row['Status']           || ''),
    userEmail:     String(row['User Email']       || ''),
    createdAt:     String(row['Created At']       || ''),
    updatedAt:     String(row['Updated At']       || ''),
    moduleName:    String(row['Module Name']      || ''),
    actionType:    String(row['Action Type']      || ''),
    attemptCount:  Number(row['Attempt Count']    || 0),
    maxAttempts:   Number(row['Max Attempts']     || Q_MAX_ATTEMPTS),
    nextRetryAt:   String(row['Next Retry At']    || ''),
    lastError:     String(row['Last Error']       || ''),
    processedAt:   String(row['Processed At']     || ''),
    finalRecordId: String(row['Final Record ID']  || '')
  };
  if (includePendingPayload) dto.pendingPayload = _queuePendingPayload_(row);
  return dto;
}

function _queueHealthFromRows_(rows, isAdmin, filter) {
  const nowMs = Date.now();
  const stats = {
    scope: isAdmin ? (filter ? 'filtered' : 'admin') : 'user',
    total: rows.length,
    queued: 0,
    processing: 0,
    failed: 0,
    dead: 0,
    done: 0,
    staleProcessing: 0,
    oldestPendingAt: '',
    oldestPendingMinutes: null
  };
  let oldestPendingMs = 0;

  rows.forEach(r => {
    const status = String(r['Status'] || '');
    if (status === Q_STATUS.QUEUED) stats.queued++;
    else if (status === Q_STATUS.PROCESSING) stats.processing++;
    else if (status === Q_STATUS.FAILED) stats.failed++;
    else if (status === Q_STATUS.DEAD) stats.dead++;
    else if (status === Q_STATUS.DONE) stats.done++;

    const leaseUntil = _dateMs_(r['Lease Until']);
    if (status === Q_STATUS.PROCESSING && leaseUntil > 0 && leaseUntil < nowMs) stats.staleProcessing++;

    if (status === Q_STATUS.QUEUED || status === Q_STATUS.PROCESSING || status === Q_STATUS.FAILED) {
      const createdMs = _dateMs_(r['Created At']);
      if (createdMs && (!oldestPendingMs || createdMs < oldestPendingMs)) {
        oldestPendingMs = createdMs;
        stats.oldestPendingAt = String(r['Created At'] || '');
      }
    }
  });

  if (oldestPendingMs) {
    stats.oldestPendingMinutes = Math.max(0, Math.floor((nowMs - oldestPendingMs) / 60000));
  }

  const props = PropertiesService.getScriptProperties();
  const triggers = ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'processQueue');
  return {
    triggerActive: triggers.length > 0,
    triggerCount: triggers.length,
    triggerStatus: triggers.length > 0
      ? 'ACTIVE - ' + triggers.length + ' trigger(s) running'
      : 'NOT SET - run setupQueueTrigger() to enable background processing',
    lastStartedAt: props.getProperty('QUEUE_WORKER_LAST_STARTED_AT') || '',
    lastFinishedAt: props.getProperty('QUEUE_WORKER_LAST_FINISHED_AT') || '',
    lastStatus: props.getProperty('QUEUE_WORKER_LAST_STATUS') || '',
    lastClaimed: Number(props.getProperty('QUEUE_WORKER_LAST_CLAIMED') || 0),
    lastProcessed: Number(props.getProperty('QUEUE_WORKER_LAST_PROCESSED') || 0),
    lastError: props.getProperty('QUEUE_WORKER_LAST_ERROR') || '',
    stats
  };
}

function getAllConfigsFast_() {
  return _configRowsFromSheetsApi_();
}

function getAllStagesFast_() {
  return _stageRowsFromSheetsApi_().sort(_stageOrderSort_);
}

function getActiveStagesFast_() {
  return _stageRowsFromSheetsApi_()
    .filter(stage => stage['Is Active'] === true || stage['Is Active'] === 'TRUE' || String(stage['Is Active']).toLowerCase() === 'true')
    .sort(_stageOrderSort_);
}

function getConfigByTypeFast_(type) {
  return _configRowsFromSheetsApi_()
    .filter(row => row['Config Type'] === type && row['Status'] === 'Active')
    .map(row => row['Value']);
}

function getFieldConfigFast_(sheetName) {
  return _fieldConfigRowsFast_(sheetName, false);
}

function getAllFieldConfigsFast_(sheetName) {
  return _fieldConfigRowsFast_(sheetName, true);
}

function _fieldConfigRowsFast_(sheetName, includeHidden) {
  return _fieldRowsFromSheetsApi_()
    .filter(row =>
      (!sheetName || (row['Sheet Name'] || 'Leads') === sheetName) &&
      (includeHidden || (row['Is Visible'] !== false && row['Is Visible'] !== 'FALSE'))
    )
    .sort((a, b) => Number(a['Display Order'] || 0) - Number(b['Display Order'] || 0));
}

function _configRowsFromSheetsApi_() {
  return sheetApiBatchGetRows_([{ sheetName: SHEET_NAMES.CONFIG, range: 'A:D' }])[SHEET_NAMES.CONFIG] || [];
}

function _stageRowsFromSheetsApi_() {
  return sheetApiBatchGetRows_([{ sheetName: SHEET_NAMES.STAGES, range: 'A:K' }])[SHEET_NAMES.STAGES] || [];
}

function _fieldRowsFromSheetsApi_() {
  return sheetApiBatchGetRows_([{ sheetName: SHEET_NAMES.FIELD_CONFIG, range: 'A:U' }])[SHEET_NAMES.FIELD_CONFIG] || [];
}

function _stageOrderSort_(a, b) {
  return Number(a['Stage Order'] || 0) - Number(b['Stage Order'] || 0);
}

function getAppConfigFast_() {
  const rows = sheetApiBatchGetRows_([
    { sheetName: SHEET_NAMES.CONFIG, range: 'A:D' },
    { sheetName: SHEET_NAMES.STAGES, range: 'A:K' },
    { sheetName: SHEET_NAMES.FIELD_CONFIG, range: 'A:U' }
  ]);
  const configRows = rows[SHEET_NAMES.CONFIG] || [];
  const stageRows = rows[SHEET_NAMES.STAGES] || [];
  const fieldRows = rows[SHEET_NAMES.FIELD_CONFIG] || [];
  const byType = type => configRows
    .filter(row => row['Config Type'] === type && row['Status'] === 'Active')
    .map(row => row['Value']);
  const fieldsFor = (sheetName, includeHidden) => fieldRows
    .filter(row =>
      (!sheetName || (row['Sheet Name'] || 'Leads') === sheetName) &&
      (includeHidden || (row['Is Visible'] !== false && row['Is Visible'] !== 'FALSE'))
    )
    .sort((a, b) => Number(a['Display Order'] || 0) - Number(b['Display Order'] || 0));
  const outcomes = byType('Outcome');
  const settings = getPortalSettings_();
  const allStages = stageRows.sort(_stageOrderSort_);
  return {
    stages: allStages.filter(stage => stage['Is Active'] === true || stage['Is Active'] === 'TRUE' || String(stage['Is Active']).toLowerCase() === 'true'),
    sources: byType('Lead Source'),
    priorities: byType('Priority'),
    followupTypes: byType('Follow-up Type'),
    outcomes: outcomes.length ? outcomes : [
      'Interested',
      'Not Interested',
      'Call Again',
      'Order Received',
      'Payment Received',
      'No Response'
    ],
    productInterests: byType('Product Interest'),
    categories: byType('Category'),
    statuses: byType('Lead Status'),
    states: byType('State'),
    settings,
    leadFields: fieldsFor('Leads', false),
    followupFields: fieldsFor('Followups', false),
    _allConfigs: configRows,
    users: getUsersWithPortalAccess_()
      .filter(user => isActiveUserValue(user['Is Active']) && _userMatchesDepartmentSettings_(user, settings))
      .map(user => {
        const email = String(user['Email Address'] || '').trim().toLowerCase();
        const role = normalizeStaffPermission(user['Permission'] || user['Role']);
        return {
          id: getStaffUserId(user, email),
          name: user['Name'],
          title: user['Title'] || user['Name'],
          role,
          department: user['Department'] || ''
        };
      }),
    departments: _activeUserDepartments_(),
    allStages,
    userNameMap: getAllRows(SHEET_NAMES.USERS).reduce((map, user) => {
      const email = String(user['Email Address'] || '').trim().toLowerCase();
      const id = getStaffUserId(user, email);
      if (id) map[id] = user['Name'] || email;
      if (email && id !== email) map[email] = user['Name'] || email;
      return map;
    }, {})
  };
}
