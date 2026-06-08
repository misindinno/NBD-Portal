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
  const leads = rows[SHEET_NAMES.LEADS] || [];
  const followups = (rows[SHEET_NAMES.FOLLOWUPS] || [])
    .filter(_isFollowupTaskRow)
    .map(_normalizeFollowupRow);
  const followupHistory = (rows[SHEET_NAMES.FOLLOWUP_HISTORY] || []).filter(_isFollowupHistoryRow);
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
