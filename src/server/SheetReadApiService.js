// Fast read helpers backed by the Advanced Google Sheets service.
// Keep browser calls behind Api.js so auth and row scoping still apply.

// ─── Unified row reader ────────────────────────────────────────────────────────
// getAllRows() delegates here. By default it reads via SpreadsheetApp; it uses the
// Advanced Sheets service ONLY during the initial bootstrap (_bootstrapReadMode_) so the
// app stays well under the Sheets API quota. Either path yields the same row shape
// (UNFORMATTED/SERIAL is normalised to match getValues()+normalizeSheetValue(): dates as
// 'yyyy-MM-dd HH:mm:ss', numbers/booleans/strings preserved), so consumers don't care which ran.

function _sheetsServiceReady_() {
  return typeof Sheets !== 'undefined' && Sheets.Spreadsheets && Sheets.Spreadsheets.Values;
}

// ── Sheets API circuit breaker ─────────────────────────────────────────────────
// When the Advanced Sheets service hits its per-minute quota it throws on every call
// for the rest of that minute. Retrying just keeps burning the exhausted quota, so the
// first quota/rate error trips a short cooldown (CacheService, shared across executions);
// while it is active every read and write skips the Sheets API and uses SpreadsheetApp.
const _SHEETS_API_COOLDOWN_KEY_ = 'SHEETS_API_COOLDOWN';
let _sheetsApiCooldownChecked_ = false;
let _sheetsApiCooldownActive_ = false;

// Reads use the Advanced Sheets service ONLY during the initial bootstrap load (set by
// apiBootstrapData for the life of that one execution). Every other read — the 15s
// revalidation poll, per-page loads, scoping, on-demand — uses SpreadsheetApp, which keeps
// the app well under the Sheets API per-minute quota. Mutations still use the Sheets API.
let _bootstrapReadMode_ = false;

function _sheetsApiAvailable_() {
  if (!_sheetsServiceReady_()) return false;
  if (!_sheetsApiCooldownChecked_) {
    _sheetsApiCooldownChecked_ = true;
    try {
      _sheetsApiCooldownActive_ = CacheService.getScriptCache().get(_SHEETS_API_COOLDOWN_KEY_) === '1';
    } catch (e) {
      _sheetsApiCooldownActive_ = false;
    }
  }
  return !_sheetsApiCooldownActive_;
}

function _isQuotaError_(e) {
  const msg = String(e && e.message || e || '').toLowerCase();
  return /quota|rate.?limit|too many|429|user rate|limit exceeded|resource has been exhausted|exceeded/.test(msg);
}

// Trips the cooldown on quota/rate errors so the rest of this minute uses SpreadsheetApp.
function _noteSheetsApiError_(e) {
  if (!_isQuotaError_(e)) return;
  _sheetsApiCooldownActive_ = true;
  try { CacheService.getScriptCache().put(_SHEETS_API_COOLDOWN_KEY_, '1', 90); } catch (_) {}
}

// Routes user/auth sheets to the user-database spreadsheet, everything else to the
// portal spreadsheet. Returns '' when unconfigured so the caller skips the API path.
function _spreadsheetIdForSheet_(sheetName) {
  return isUserDatabaseSheet(sheetName)
    ? String(USER_DATABASE_SPREADSHEET_ID || '')
    : String(SPREADSHEET_ID || '');
}

// Columns that hold date/time values in the schema. The "… At"/"… Date" suffix rule
// auto-covers new timestamp columns; the exception set lists the few that don't follow it.
const _DATE_COLUMN_EXCEPTIONS_ = { 'Lease Until': true, 'Timestamp': true };
function _isDateColumnHeader_(header) {
  const h = String(header || '').trim();
  if (!h) return false;
  if (_DATE_COLUMN_EXCEPTIONS_[h]) return true;
  return /[\s_\-](At|Date)$/i.test(h);
}

// Google Sheets serial number → 'yyyy-MM-dd HH:mm:ss', preserving the cell's wall-clock
// (25569 = days between the 1899-12-30 serial epoch and the Unix epoch).
function _serialToDateTimeString_(serial) {
  const n = Number(serial);
  if (!isFinite(n)) return String(serial);
  const d = new Date(Math.round((n - 25569) * 86400000));
  if (isNaN(d.getTime())) return String(serial);
  const p = x => (x < 10 ? '0' : '') + x;
  return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) +
    ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ':' + p(d.getUTCSeconds());
}

function _sheetsApiCellValue_(value, isDateCol) {
  if (value === null || value === undefined) return '';
  if (isDateCol && typeof value === 'number') return _serialToDateTimeString_(value);
  return value;
}

// Turns a raw UNFORMATTED_VALUE/SERIAL_NUMBER value matrix into row objects matching
// rowObjectFromHeaders_(). opts.skipBlankRows mirrors the batch reader's blank filtering.
function _objectsFromSheetsApiValues_(values, opts) {
  const data = values || [];
  if (data.length < 2) return [];
  const headers = (data[0] || []).map(h => String(h || '').trim());
  const dateFlags = headers.map(_isDateColumnHeader_);
  const skipBlank = !!(opts && opts.skipBlankRows);
  const out = [];
  for (let r = 1; r < data.length; r++) {
    const row = data[r] || [];
    if (skipBlank && !row.some(v => String(v == null ? '' : v).trim() !== '')) continue;
    const obj = {};
    for (let c = 0; c < headers.length; c++) {
      if (!headers[c]) continue;
      obj[headers[c]] = _sheetsApiCellValue_(row[c], dateFlags[c]);
    }
    out.push(obj);
  }
  return out;
}

// ── Per-execution read cache ───────────────────────────────────────────────────
// Read-mostly sheets (config + users) are read several times per request while
// building lookup maps. Cache them for the life of this GAS execution and hand back
// shallow copies so callers can mutate freely. Any write helper calls
// _invalidateReadCache_() to drop the cache, keeping reads consistent with writes.
let _READ_CACHE_ = {};
// Built lazily on first use — must NOT reference SHEET_NAMES/normalizeSheetName at load
// time, since GAS evaluates files alphabetically and Utils.js (SHEET_NAMES) loads later.
let _CACHEABLE_READ_SHEETS_ = null;

function _isCacheableReadSheet_(sheetName) {
  if (!_CACHEABLE_READ_SHEETS_) {
    _CACHEABLE_READ_SHEETS_ = [
      SHEET_NAMES.CONFIG, SHEET_NAMES.STAGES, SHEET_NAMES.FIELD_CONFIG,
      SHEET_NAMES.USERS, SHEET_NAMES.USER_PORTAL_ACCESS
    ].reduce((m, name) => { m[normalizeSheetName(name)] = true; return m; }, {});
  }
  return !!_CACHEABLE_READ_SHEETS_[normalizeSheetName(sheetName)];
}
function _invalidateReadCache_() {
  _READ_CACHE_ = {};
}

function readAllRowsWithFallback_(sheetName) {
  assertServerContext_();
  const cacheable = _isCacheableReadSheet_(sheetName);
  if (cacheable) {
    const cached = _READ_CACHE_[normalizeSheetName(sheetName)];
    if (cached) return cached.map(r => ({ ...r }));
  }

  let rows = null;
  const ssId = _spreadsheetIdForSheet_(sheetName);
  if (ssId && _bootstrapReadMode_ && _sheetsApiAvailable_()) {
    try {
      const a1 = "'" + normalizeSheetName(sheetName).replace(/'/g, "''") + "'";
      const res = Sheets.Spreadsheets.Values.get(ssId, a1, {
        valueRenderOption: 'UNFORMATTED_VALUE',
        dateTimeRenderOption: 'SERIAL_NUMBER'
      });
      rows = _objectsFromSheetsApiValues_(res.values, { skipBlankRows: false });
    } catch (e) {
      _noteSheetsApiError_(e);
      Logger.log('[Read] Sheets API getAllRows fell back for ' + sheetName + ': ' + (e && e.message || e));
    }
  }
  if (rows === null) rows = _legacyGetAllRows_(sheetName);

  if (cacheable) {
    _READ_CACHE_[normalizeSheetName(sheetName)] = rows;
    return rows.map(r => ({ ...r }));
  }
  return rows;
}

function sheetApiBatchGetRows_(sheetNames) {
  assertServerContext_();
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

  if (_bootstrapReadMode_ && _sheetsApiAvailable_()) {
    try {
      const ranges = specs.map(spec => "'" + String(spec.sheetName).replace(/'/g, "''") + "'!" + spec.range);
      const result = Sheets.Spreadsheets.Values.batchGet(SPREADSHEET_ID, {
        ranges,
        valueRenderOption: 'UNFORMATTED_VALUE',
        dateTimeRenderOption: 'SERIAL_NUMBER'
      });
      const valueRanges = result.valueRanges || [];
      return specs.reduce((map, spec, i) => {
        map[spec.sheetName] = _objectsFromSheetsApiValues_(valueRanges[i] && valueRanges[i].values, { skipBlankRows: true });
        return map;
      }, {});
    } catch (e) {
      _noteSheetsApiError_(e);
      Logger.log('[Read] Sheets API batchGet fell back to SpreadsheetApp: ' + (e && e.message || e));
    }
  }
  // Default (everything except the initial bootstrap): read each sheet via SpreadsheetApp.
  return specs.reduce((map, spec) => {
    map[spec.sheetName] = getAllRows(spec.sheetName);
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
  // One-shot, per-navigation read: use the Sheets API batchGet path (a single call
  // for just these ranges) instead of full-sheet SpreadsheetApp reads. The circuit
  // breaker + SpreadsheetApp fallback still apply.
  _bootstrapReadMode_ = true;
  let rows;
  try {
    rows = sheetApiBatchGetRows_([
      { sheetName: SHEET_NAMES.LEADS, range: 'A:AC' },
      { sheetName: SHEET_NAMES.FOLLOWUPS, range: 'A:Q' },
      { sheetName: SHEET_NAMES.FOLLOWUP_HISTORY, range: 'A:O' },
      { sheetName: SHEET_NAMES.LEAD_ACTIVITY_LOGS, range: 'A:H' }
    ]);
  } finally { _bootstrapReadMode_ = false; }
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
  // One-shot, per-navigation read (not the 15s poll): use the Sheets API batchGet
  // path — a single call for just these ranges — instead of three full-sheet
  // SpreadsheetApp reads. The circuit breaker + SpreadsheetApp fallback still apply.
  _bootstrapReadMode_ = true;
  let rows;
  try { rows = sheetApiBatchGetRows_(specs); }
  finally { _bootstrapReadMode_ = false; }
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
