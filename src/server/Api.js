// Api.js
// Public google.script.run entry points. Every endpoint must enter server context
// before touching sheets; raw sheet helpers reject direct browser-console calls.

// Holds the auth token for the current request. Safe because each google.script.run
// call is a fresh, isolated GAS execution — no cross-request leakage.
let _currentApiToken_ = '';

function apiGuard_(fn) {
  return withServerContext_(() => {
    try {
      return fn();
    } catch (e) {
      return respond(null, e.message);
    }
  });
}

// ── Custom login / session auth ───────────────────────────────────────────────
function apiLogin(email, password) {
  return apiGuard_(() => {
    if (!email || !password) return respond(null, 'Email and password are required.');
    const userRow = validateUserPassword_(email, password);
    if (!userRow) return respond(null, 'Invalid email or password.');
    const norm = String(email).trim().toLowerCase();
    const userResult = getCurrentUserByEmail_(norm);
    if (!userResult.success) return respond(null, userResult.error || 'Access denied.');
    const token = createAuthSession_(norm, userResult.data.id);
    return respond({ user: userResult.data, token });
  });
}

function apiBootstrapWithToken(token) {
  return apiGuard_(() => {
    const session = readAuthSession_(token);
    if (!session) return respond(null, 'SESSION_EXPIRED');
    const userResult = getCurrentUserByEmail_(session.email);
    if (!userResult.success) return respond(null, userResult.error || 'ACCESS_DENIED');
    refreshAuthSession_(token);
    const configResult = getAppConfig();
    if (!configResult.success) return configResult;
    return respond({ user: userResult.data, config: configResult.data });
  });
}

function apiLogout(token) {
  return apiGuard_(() => {
    destroyAuthSession_(token);
    return respond(true);
  });
}

function apiLoginWithGoogle(idToken) {
  return apiGuard_(() => {
    if (!idToken) return respond(null, 'Missing Google ID token.');
    const verified = _verifyGoogleIdToken_(idToken);
    if (!verified) return respond(null, 'Google token verification failed. Ensure GOOGLE_CLIENT_ID is set in Script Properties.');
    const norm = String(verified.email).trim().toLowerCase();
    const userResult = getCurrentUserByEmail_(norm);
    if (!userResult.success) return respond(null, userResult.error || 'Your Google account is not authorized for this portal.');
    const token = createAuthSession_(norm, userResult.data.id);
    return respond({ user: userResult.data, token });
  });
}

// ── Legacy bootstrap (GAS Session — only works on "Execute as: User" deployment) ──
function apiGetCurrentUser() {
  return apiGuard_(() => {
    const email = Session.getActiveUser().getEmail();
    if (!email) return respond(null, 'Session email is empty.');
    const result = getCurrentUser('', false);
    if (!result.success && result.error === 'ACCESS_DENIED') return respond(null, 'ACCESS_DENIED for ' + email);
    return result;
  });
}

function apiBootstrap() {
  return apiGuard_(() => {
    const email = Session.getActiveUser().getEmail();
    if (!email) return respond(null, 'Session email is empty.');
    const userResult = getCurrentUser('', false);
    if (!userResult.success && userResult.error === 'ACCESS_DENIED') return respond(null, 'ACCESS_DENIED for ' + email);
    if (!userResult.success) return userResult;
    const configResult = getAppConfig();
    if (!configResult.success) return configResult;
    return respond({ user: userResult.data, config: configResult.data });
  });
}

// ── Read endpoints ────────────────────────────────────────────────────────────
// All accept token as first arg; _currentApiToken_ is set so _apiUser() can
// resolve identity without needing Session.getActiveUser().

function apiGetDataStamps(token) {
  _currentApiToken_ = token || '';
  return apiGuard_(() => {
    _apiUser();
    const p = PropertiesService.getScriptProperties();
    return respond({
      leads:          p.getProperty('STAMP_LEADS')           || '0',
      followups:      p.getProperty('STAMP_FOLLOWUPS')       || '0',
      followupHistory:p.getProperty('STAMP_FOLLOWUP_HISTORY')|| '0',
      activityLogs:   p.getProperty('STAMP_ACTIVITY_LOGS')   || '0',
      stages:         p.getProperty('STAMP_STAGES')          || '0',
      fields:         p.getProperty('STAMP_FIELDS')          || '0',
      config:         p.getProperty('STAMP_CONFIG')          || '0',
      appVersion:     p.getProperty('APP_VERSION')           || '0',
    });
  });
}

function apiGetAppConfig(token) {
  _currentApiToken_ = token || '';
  return apiGuard_(() => {
    _apiUser();
    return getAppConfig();
  });
}

function apiGetAllStages(token) {
  _currentApiToken_ = token || '';
  return apiGuard_(() => {
    _requireConfigReader();
    return respond(getAllStages());
  });
}

function apiGetAllConfigs(token) {
  _currentApiToken_ = token || '';
  return apiGuard_(() => {
    _requireConfigReader();
    return respond(getAllRows(SHEET_NAMES.CONFIG));
  });
}

function apiGetFieldConfig(token, sheet) {
  _currentApiToken_ = token || '';
  return apiGuard_(() => {
    _requireConfigReader();
    return respond(getFieldConfig(sheet));
  });
}

function apiGetAllFieldConfigs(token, sheet) {
  _currentApiToken_ = token || '';
  return apiGuard_(() => {
    _requireConfigReader();
    return respond(getAllFieldConfigs(sheet));
  });
}

// Leads
function apiGetLeads(token) {
  _currentApiToken_ = token || '';
  return apiGuard_(() => {
    const user = _requireModule('Leads');
    return respond(_scopeAssignedRows(_leadRows(), user));
  });
}

function apiGetLead(token, id) {
  _currentApiToken_ = token || '';
  return apiGuard_(() => {
    const user = _requireAnyModule(['Leads', 'Followups']);
    const lead = _leadRows().filter(r => r['Lead ID'] === id)[0];
    const followups = _scopeFollowupRows(getFollowups({ leadId: id, includeClosed: true }), user);
    if (!lead || (!_canReadAssignedRow(lead, user) && !followups.length)) return respond(null, 'Lead not found.');
    const followupHistory = _scopeFollowupHistoryRows(getFollowupHistory({ leadId: id }), user);
    const activityLogs = _scopeActivityLogRows(getLeadActivityLogs({ leadId: id }), user);
    return respond({ lead, followups, followupHistory, activityLogs });
  });
}

// Follow-ups
function apiGetFollowups(token, filters) {
  _currentApiToken_ = token || '';
  return apiGuard_(() => {
    const user = _requireModule('Followups');
    const rows = _scopeFollowupRows(getFollowups(filters || {}), user);
    return respond(rows.sort((a, b) => new Date(b['Created At']) - new Date(a['Created At'])));
  });
}

function apiGetFollowupHistory(token, filters) {
  _currentApiToken_ = token || '';
  return apiGuard_(() => {
    const user = _requireModule('Followups');
    return respond(_scopeFollowupHistoryRows(getFollowupHistory(filters || {}), user));
  });
}

function apiGetLeadActivityLogs(token, filters) {
  _currentApiToken_ = token || '';
  return apiGuard_(() => {
    const user = _requireAnyModule(['Leads', 'Followups']);
    return respond(_scopeActivityLogRows(getLeadActivityLogs(filters || {}), user));
  });
}

function apiGetFollowupFormData(token) {
  _currentApiToken_ = token || '';
  return apiGuard_(() => {
    const user = _requireModule('Followups');
    const leads = _scopeAssignedRows(_leadRows(), user)
      .filter(l => l['Lead Status'] === 'Open');
    return respond({ leads });
  });
}

function apiGetFollowupLeads(token) {
  _currentApiToken_ = token || '';
  return apiGuard_(() => {
    const user = _requireModule('Followups');
    const visibleFollowups = _scopeFollowupRows(getFollowups({ includeClosed: true }), user);
    const linked = {};
    visibleFollowups.forEach(f => { if (f['Lead ID']) linked[f['Lead ID']] = true; });
    const leads = _leadRows().filter(l => _canReadAssignedRow(l, user) || linked[l['Lead ID']]);
    return respond(leads);
  });
}

// Users
function apiGetUsers(token) {
  _currentApiToken_ = token || '';
  return apiGuard_(() => {
    const user = _apiUser();
    if (!canManageUsersPermission(user)) throw new Error('Permission denied.');
    return respond(getAllRows(SHEET_NAMES.USERS));
  });
}

// Bulk Entry
function apiGetBulkConfig(token) {
  _currentApiToken_ = token || '';
  return apiGuard_(() => {
    _requireBulkEntry_();
    return respond(getBulkConfig());
  });
}

function apiValidateBulkRows(token, rows) {
  _currentApiToken_ = token || '';
  return apiGuard_(() => {
    _requireBulkEntry_();
    return respond(validateBulkRows(rows || []));
  });
}

function apiSaveBulkRows(token, rows) {
  _currentApiToken_ = token || '';
  return apiGuard_(() => {
    _requireBulkEntry_();
    return respond(saveBulkRows(rows || []));
  });
}

function apiGetBulkProgress(token, batchId) {
  _currentApiToken_ = token || '';
  return apiGuard_(() => {
    _requireBulkEntry_();
    return respond(getBulkProgress(batchId || ''));
  });
}

function apiCreateErrorCsv(token, errorRows) {
  _currentApiToken_ = token || '';
  return apiGuard_(() => {
    _requireBulkEntry_();
    return respond(createErrorCsv(errorRows || []));
  });
}

// ── Queue endpoints ───────────────────────────────────────────────────────────
// Fast enqueue — validates auth + writes ONE queue row. Returns in < 500ms.
function apiEnqueueJob(token, moduleName, actionType, payload, requestId) {
  _currentApiToken_ = token || '';
  return apiGuard_(() => {
    const user = _requireAuthToken_(token);
    const mod = String(moduleName || '');
    const action = String(actionType || '');

    const allowed = ['leads', 'followups', 'config', 'stages', 'fields'];
    if (!allowed.includes(mod)) throw new Error('Invalid module.');

    const allowedActions = [
      'saveLead', 'deleteLead', 'updateLeadStage', 'moveLeadStageWithFields',
      'pushLeadToNbd',
      'saveFollowup', 'markFollowupDone', 'deleteFollowup',
      'addConfig', 'updateConfigStatus', 'saveStage', 'reorderStages',
      'saveFieldConfig', 'savePortalSettings', 'saveUser',
    ];
    if (!allowedActions.includes(action)) throw new Error('Invalid action.');
    _assertCanEnqueueJob_(user, mod, action);

    const payloadStr = JSON.stringify(payload || {});
    if (payloadStr.length > 200000) throw new Error('Payload too large (max 200 KB).');

    const result = enqueueJob_(user.email, mod, action, payload || {}, requestId || '');
    return respond(result);
  });
}

// Poll status for up to 20 requestIds at once.
function apiGetJobStatuses(token, requestIds) {
  _currentApiToken_ = token || '';
  return apiGuard_(() => {
    _requireAuthToken_(token);
    if (!Array.isArray(requestIds)) throw new Error('requestIds must be an array.');
    if (requestIds.length > 20) throw new Error('Max 20 IDs per request.');
    return respond(getJobStatuses_(requestIds));
  });
}

// Incremental change log — returns only entries after lastSeq.
function apiGetChanges(token, lastSeq) {
  _currentApiToken_ = token || '';
  return apiGuard_(() => {
    _requireAuthToken_(token);
    return respond(getChangesAfter_(Number(lastSeq) || 0));
  });
}

// Queue history for the current user — newest first, max 100 rows.
function apiGetQueueHistory(token, limit) {
  _currentApiToken_ = token || '';
  return apiGuard_(() => {
    const user = _requireAuthToken_(token);
    return respond(getQueueHistory_(user.email, Number(limit) || 50));
  });
}

function apiGetQueueHealth(token) {
  _currentApiToken_ = token || '';
  return apiGuard_(() => {
    const user = _requireAuthToken_(token);
    return respond(getQueueHealth_(user.email, user));
  });
}

// Admin-only: returns queue history for all users (or a specific email filter).
function apiGetAllQueueHistory(token, filterEmail, limit) {
  _currentApiToken_ = token || '';
  return apiGuard_(() => {
    const user = _requireAuthToken_(token);
    if (!user || user.role !== 'ADMIN') return respond(null, 'Permission denied.');
    return respond(getAllQueueHistory_(filterEmail || '', Number(limit) || 100));
  });
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function _apiUser() {
  // Try token-based identity first (works with "Execute as: Me" deployment)
  if (_currentApiToken_) {
    const session = readAuthSession_(_currentApiToken_);
    if (session) {
      const result = getCurrentUserByEmail_(session.email);
      if (result.success) { refreshAuthSession_(_currentApiToken_); return result.data; }
    }
  }
  // Fallback: GAS session (only works on "Execute as: User accessing" deployment)
  const result = getCurrentUser('', false);
  if (!result.success) throw new Error(result.error);
  return result.data;
}

function _requireModule(moduleName) {
  const user = _apiUser();
  if (user.role === 'ADMIN' || userHasModule(user, moduleName)) return user;
  throw new Error('Permission denied.');
}

function _requireAnyModule(moduleNames) {
  const user = _apiUser();
  if (user.role === 'ADMIN' || moduleNames.some(name => userHasModule(user, name))) return user;
  throw new Error('Permission denied.');
}

function _requireConfigReader() {
  const user = _apiUser();
  if (!canEditConfigPermission(user)) throw new Error('Permission denied.');
  return user;
}

function _requireBulkEntry_() {
  const user = _apiUser();
  const isLqPortal = String(CLIENT_CONFIG.APP_TITLE || '').toLowerCase().includes('lq');
  if (!isLqPortal) throw new Error('Bulk Entry is available only in LQ Portal.');
  if (user.role === 'ADMIN' || userHasModule(user, 'BulkEntry')) return user;
  throw new Error('Permission denied.');
}

function _assertCanEnqueueJob_(user, moduleName, actionType) {
  const isAdmin = user.role === 'ADMIN';
  const has = name => isAdmin || userHasModule(user, name);
  const canWriteLead = ['ADMIN', 'MANAGER', 'SALES'].includes(user.role) && (has('Leads') || has('LeadForm'));
  const canWriteFollowup = ['ADMIN', 'MANAGER', 'SALES', 'USER'].includes(user.role) && has('Followups');
  const misDepartment = String(user.department || '').trim().toUpperCase() === 'MIS';

  if (actionType === 'deleteLead') {
    if (!misDepartment || !has('Leads')) throw new Error('Permission denied. Only MIS lead users can delete leads.');
    return;
  }
  if (['saveLead', 'updateLeadStage', 'moveLeadStageWithFields', 'pushLeadToNbd'].includes(actionType)) {
    if (!canWriteLead) throw new Error('Permission denied.');
    return;
  }
  if (['saveFollowup', 'markFollowupDone', 'deleteFollowup'].includes(actionType)) {
    if (!canWriteFollowup) throw new Error('Permission denied.');
    return;
  }
  if (actionType === 'saveUser') {
    if (!canManageUsersPermission(user)) throw new Error('Permission denied.');
    return;
  }
  if (['addConfig', 'updateConfigStatus', 'saveStage', 'reorderStages', 'saveFieldConfig', 'savePortalSettings'].includes(actionType)) {
    if (!canEditConfigPermission(user)) throw new Error('Permission denied.');
    return;
  }
  throw new Error('Invalid action.');
}

function _hasGlobalRead(user) {
  return ['ADMIN', 'MANAGER', 'VIEWER'].includes(user.role);
}

function _canReadAssignedRow(row, user) {
  if (!_hasGlobalRead(user)) return row['Assigned To'] === user.id;
  return _rowMatchesDepartmentScope_(row, _buildUserMapById_(), _portalDepartmentScopeSet_());
}

function _scopeAssignedRows(rows, user) {
  if (!_hasGlobalRead(user)) return rows.filter(r => r['Assigned To'] === user.id);
  const userMap = _buildUserMapById_();
  const scope = _portalDepartmentScopeSet_();
  return rows.filter(r => _rowMatchesDepartmentScope_(r, userMap, scope));
}

function _scopeFollowupRows(rows, user) {
  return _scopeLeadLinkedRows(rows, user, ['Created By', 'Done By']);
}

function _scopeFollowupHistoryRows(rows, user) {
  return _scopeLeadLinkedRows(rows, user, ['Done By']);
}

function _scopeActivityLogRows(rows, user) {
  return _scopeLeadLinkedRows(rows, user, ['Created By']);
}

function _scopeLeadLinkedRows(rows, user, actorFields) {
  if (_hasGlobalRead(user)) {
    const userMap = _buildUserMapById_();
    const leadMap = _buildLeadMapById_();
    const scope = _portalDepartmentScopeSet_();
    return rows.filter(r => _linkedRowMatchesDepartmentScope_(r, actorFields, userMap, leadMap, scope));
  }
  const leadIds = getAllRows(SHEET_NAMES.LEADS)
    .filter(l => l['Assigned To'] === user.id)
    .map(l => l['Lead ID']);
  const allowed = {};
  leadIds.forEach(id => allowed[id] = true);
  return rows.filter(r => allowed[r['Lead ID']] || actorFields.some(field => r[field] === user.id));
}

function _rowMatchesDepartmentScope_(row, userMap, scope) {
  if (!scope) return true;
  const department = _departmentForUserId_(row['Assigned To'], userMap);
  return !!scope[String(department || '').trim().toLowerCase()];
}

function _linkedRowMatchesDepartmentScope_(row, actorFields, userMap, leadMap, scope) {
  if (!scope) return true;
  const lead = row['Lead ID'] ? leadMap[row['Lead ID']] : null;
  if (lead) return _rowMatchesDepartmentScope_(lead, userMap, scope);
  return actorFields.some(field => {
    const department = _departmentForUserId_(row[field], userMap);
    return !!scope[String(department || '').trim().toLowerCase()];
  });
}

function _portalDepartmentScopeSet_() {
  const settings = getPortalSettings_();
  const departments = settings.visibleDepartments || [];
  if (!departments.length) return null;
  return departments.reduce((m, d) => {
    const key = String(d || '').trim().toLowerCase();
    if (key) m[key] = true;
    return m;
  }, {});
}

function _departmentForUserId_(userId, userMap) {
  if (!userId) return '';
  const user = userMap[userId];
  return user ? user['Department'] || '' : '';
}

function _buildUserMapById_() {
  return getAllRows(SHEET_NAMES.USERS).reduce((m, u) => {
    const email = String(u['Email Address'] || '').trim().toLowerCase();
    m[getStaffUserId(u, email)] = u;
    return m;
  }, {});
}

function _buildLeadMapById_() {
  return getAllRows(SHEET_NAMES.LEADS).reduce((m, l) => {
    if (l['Lead ID']) m[l['Lead ID']] = l;
    return m;
  }, {});
}

function _leadRows() {
  return getRowsWithCustomFieldValues_('Leads', getAllRows(SHEET_NAMES.LEADS));
}
