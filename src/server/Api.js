// Api.js
// Public google.script.run entry points. Every endpoint must enter server context
// before touching sheets; raw sheet helpers reject direct browser-console calls.

// Holds the auth token for the current request. Safe because each google.script.run
// call is a fresh, isolated GAS execution — no cross-request leakage.
let _currentApiToken_ = '';

function apiGuard_(operation, fn) {
  const caller = String(operation || 'api');
  return withRequestContext_(caller, () => withServerContext_(() => {
    try {
      return fn();
    } catch (e) {
      logServerError_(e, { api: caller });
      const safeError = typeof safeClientErrorMessage_ === 'function'
        ? safeClientErrorMessage_(e)
        : 'Request failed.';
      return respond(null, safeError, errorCodeFrom_(e));
    }
  }));
}

// Public liveness check. Its payload contains no deployment, datastore, user,
// or integration identifiers; only the standard envelope carries a request ID.
function apiDiagnosticPing() {
  return apiGuard_('apiDiagnosticPing', () => respond(publicDiagnosticPing_()));
}

// Detailed checks require a valid portal session and the explicit ADMIN role.
function apiGetDiagnosticSnapshot(token) {
  _currentApiToken_ = token || '';
  return apiGuard_('apiGetDiagnosticSnapshot', () => {
    const user = requireDiagnosticAdmin_(_apiUser());
    return respond(adminDiagnosticSnapshot_(user));
  });
}

// ── Custom login / session auth ───────────────────────────────────────────────
function apiLogin(email, password) {
  return apiGuard_('apiLogin', () => {
    if (!email || !password) return respond(null, 'Email and password are required.');
    assertLoginAllowed_(email);
    const userRow = validateUserPassword_(email, password);
    if (!userRow) {
      recordLoginFailure_(email);
      return respond(null, 'Invalid email or password.');
    }
    clearLoginFailures_(email);
    const norm = String(email).trim().toLowerCase();
    const userResult = getCurrentUserByEmail_(norm);
    if (!userResult.success) return respond(null, userResult.error || 'Access denied.');
    const token = createAuthSession_(norm, userResult.data.id);
    return respond({ user: userResult.data, token });
  });
}

function apiBootstrapWithToken(token) {
  return apiGuard_('apiBootstrapWithToken', () => {
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
  return apiGuard_('apiLogout', () => {
    destroyAuthSession_(token);
    return respond(true);
  });
}

// Compact bootstrap: returns identity, configuration, navigation counts, and data stamps.
// Worklists are fetched page-by-page after first paint, keeping startup payload bounded.
function apiBootstrapData(token) {
  _currentApiToken_ = token || '';
  return apiGuard_('apiBootstrapData', () => {
    const session = readAuthSession_(token);
    if (!session) return respond(null, 'SESSION_EXPIRED');
    const userResult = getCurrentUserByEmail_(session.email);
    if (!userResult.success) return respond(null, userResult.error || 'ACCESS_DENIED');
    refreshAuthSession_(token);
    const user = userResult.data;

    // Initial load is the one place reads use the Sheets API (fast batch); the flag is
    // reset in finally so nothing else in or after this execution touches the API.
    _bootstrapReadMode_ = true;
    try {
      let config;
      try {
        config = getAppConfigFast_();
      } catch (e) {
        diagnosticLog_('WARN', 'DATA.READ_FALLBACK', 'bootstrap_config_fallback', {
          errorCategory: diagnosticErrorCategory_(e)
        });
        const c = getAppConfig();
        if (!c.success) return c;
        config = c.data;
      }

      const navigationSummary = getNavigationSummary_(user);
      return respond({ user, config, navigationSummary, stamps: _bootstrapStamps_() });
    } finally {
      _bootstrapReadMode_ = false;
    }
  });
}

function _bootstrapStamps_() {
  const p = PropertiesService.getScriptProperties();
  return {
    leads:           p.getProperty('STAMP_LEADS')            || '0',
    followups:       p.getProperty('STAMP_FOLLOWUPS')        || '0',
    followupHistory: p.getProperty('STAMP_FOLLOWUP_HISTORY') || '0',
    activityLogs:    p.getProperty('STAMP_ACTIVITY_LOGS')    || '0',
    stages:          p.getProperty('STAMP_STAGES')           || '0',
    fields:          p.getProperty('STAMP_FIELDS')           || '0',
    config:          p.getProperty('STAMP_CONFIG')           || '0',
    appVersion:      p.getProperty('APP_VERSION')            || '0'
  };
}

function apiLoginWithGoogle(idToken) {
  return apiGuard_('apiLoginWithGoogle', () => {
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
  return apiGuard_('apiGetCurrentUser', () => {
    const email = Session.getActiveUser().getEmail();
    if (!email) return respond(null, 'Session email is empty.');
    const result = getCurrentUser('', false);
    if (!result.success && result.error === 'ACCESS_DENIED') return respond(null, 'ACCESS_DENIED for ' + email);
    return result;
  });
}

// ── Permission probe (admin only) ─────────────────────────────────────────────
function apiUpdatePermissions(token) {
  return apiGuard_('apiUpdatePermissions', () => {
    _currentApiToken_ = token;
    requireAdmin();
    const results = [];
    const errors  = [];

    function probe(label, fn) {
      try { fn(); results.push({ label, ok: true }); }
      catch (e) { results.push({ label, ok: false, error: e.message }); errors.push(label); }
    }

    probe('Spreadsheets', () => SpreadsheetApp.getActiveSpreadsheet().getId());
    probe('Drive', () => {
      const Drive = this['DriveApp'];
      if (!Drive) throw new Error('DriveApp not available in web app context — run "Update Permissions" from the sheet menu');
      Drive.getRootFolder().getId();
    });
    probe('External Requests', () => {
      const resp = UrlFetchApp.fetch('https://www.google.com', { muteHttpExceptions: true });
      if (resp.getResponseCode() < 200) throw new Error('HTTP ' + resp.getResponseCode());
    });
    probe('User Info', () => {
      const email = Session.getEffectiveUser().getEmail();
      if (!email) throw new Error('No email returned');
    });
    probe('Script App', () => ScriptApp.getService().getUrl());

    return respond({ results, failedScopes: errors, allGranted: errors.length === 0 });
  });
}

// ── Read endpoints ────────────────────────────────────────────────────────────
// All accept token as first arg; _currentApiToken_ is set so _apiUser() can
// resolve identity without needing Session.getActiveUser().

function apiGetDataStamps(token) {
  _currentApiToken_ = token || '';
  return apiGuard_('apiGetDataStamps', () => {
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
  return apiGuard_('apiGetAppConfig', () => {
    _apiUser();
    try {
      return respond(getAppConfigFast_());
    } catch (e) {
      diagnosticLog_('WARN', 'DATA.READ_FALLBACK', 'app_config_fallback', {
        errorCategory: diagnosticErrorCategory_(e)
      });
      return getAppConfig();
    }
  });
}

function apiGetAllStages(token) {
  _currentApiToken_ = token || '';
  return apiGuard_('apiGetAllStages', () => {
    _requireConfigReader();
    try {
      return respond(getAllStagesFast_());
    } catch (e) {
      diagnosticLog_('WARN', 'DATA.READ_FALLBACK', 'stages_fallback', {
        errorCategory: diagnosticErrorCategory_(e)
      });
      return respond(getAllStages());
    }
  });
}

function apiGetAllConfigs(token) {
  _currentApiToken_ = token || '';
  return apiGuard_('apiGetAllConfigs', () => {
    _requireConfigReader();
    try {
      return respond(getAllConfigsFast_());
    } catch (e) {
      diagnosticLog_('WARN', 'DATA.READ_FALLBACK', 'configs_fallback', {
        errorCategory: diagnosticErrorCategory_(e)
      });
      return respond(getAllRows(SHEET_NAMES.CONFIG));
    }
  });
}

function apiGetAllFieldConfigs(token, sheet) {
  _currentApiToken_ = token || '';
  return apiGuard_('apiGetAllFieldConfigs', () => {
    _requireConfigReader();
    try {
      return respond(getAllFieldConfigsFast_(sheet));
    } catch (e) {
      diagnosticLog_('WARN', 'DATA.READ_FALLBACK', 'field_config_fallback', {
        errorCategory: diagnosticErrorCategory_(e)
      });
      return respond(getAllFieldConfigs(sheet));
    }
  });
}

// Leads
function apiGetLeads(token) {
  _currentApiToken_ = token || '';
  return apiGuard_('apiGetLeads', () => {
    const user = _requireModule('Leads');
    return respond(_scopeAssignedRows(_leadRows(), user));
  });
}

function apiGetLeadsPage(token, query) {
  _currentApiToken_ = token || '';
  return apiGuard_('apiGetLeadsPage', () => {
    const user = _requireModule('Leads');
    return respond(getLeadsPage_(user, query || {}));
  });
}

function apiGetNavigationSummary(token) {
  _currentApiToken_ = token || '';
  return apiGuard_('apiGetNavigationSummary', () => respond(getNavigationSummary_(_apiUser())));
}

function apiGlobalSearch(token, query) {
  _currentApiToken_ = token || '';
  return apiGuard_('apiGlobalSearch', () => {
    const user = _requireAnyModule(['Leads', 'Followups']);
    const isAdmin = user.role === 'ADMIN';
    return respond(getGlobalSearch_(user, query || '', {
      leads: isAdmin || userHasModule(user, 'Leads') || userHasModule(user, 'Pipeline'),
      followups: isAdmin || userHasModule(user, 'Followups')
    }));
  });
}
function apiUploadFile(token, filePayload, fieldKey) {
  _currentApiToken_ = token || '';
  return apiGuard_('apiUploadFile', () => {
    _requireAnyModule(['Leads', 'LeadForm', 'Pipeline', 'BulkEntry']);
    if (!filePayload || !filePayload.data) return respond(null, 'No file data provided.');
    const field = fieldKey
      ? (queryRows(SHEET_NAMES.FIELD_CONFIG, r => r['Column Key'] === fieldKey)[0] ||
          (fieldKey === 'FEEDBACK ATTACHEMT' ? {
            'Field Name': 'FEEDBACK ATTACHEMT',
            'Column Key': 'FEEDBACK ATTACHEMT',
            'Field Type': 'File',
            'File Types': 'image/*,application/pdf',
            'Max File MB': 10
          } : {}))
      : {};
    try {
      const url = _uploadCustomFieldFile(filePayload, field);
      return respond(url);
    } catch (e) {
      const msg = e.message || String(e);
      if (msg.includes('DriveApp') || msg.includes('permissions') || msg.includes('drive')) {
        return respond(null, 'File upload failed: the script owner must run "Update Permissions" from the Google Sheets menu to authorize Drive access.');
      }
      return respond(null, 'File upload failed: ' + msg);
    }
  });
}

function apiCheckLeadDuplicates(token, phone, email, excludeLeadId, companyName) {
  _currentApiToken_ = token || '';
  return apiGuard_('apiCheckLeadDuplicates', () => {
    _requireAnyModule(['Leads', 'LeadForm', 'BulkEntry']);
    return respond(checkLeadDuplicates(phone, email, excludeLeadId, companyName || ''));
  });
}

function apiSaveLead(token, payload) {
  _currentApiToken_ = token || '';
  return apiGuard_('apiSaveLead', () => {
    const user = _apiUser();
    _assertCanMutate_(user, 'leads', 'saveLead');
    try {
      return withTrustedWriteUser_(user.email, () => saveLead(payload || {}, user.email));
    } catch (e) {
      diagnosticLog_('ERROR', diagnosticErrorCategory_(e), 'lead_save_failed', {
        fingerprint: diagnosticErrorFingerprint_(e)
      });
      throw new Error('Save lead failed: ' + safeClientErrorMessage_(e));
    }
  });
}

function apiDeleteLead(token, leadId) {
  _currentApiToken_ = token || '';
  return apiGuard_('apiDeleteLead', () => {
    const user = _apiUser();
    _assertCanMutate_(user, 'leads', 'deleteLead');
    return withTrustedWriteUser_(user.email, () => deleteLead(leadId || '', user.email));
  });
}

function apiGetArchiveData(token) {
  _currentApiToken_ = token || '';
  return apiGuard_('apiGetArchiveData', () => {
    const user = _requireModule('Archive');
    return respond(getArchiveData(user));
  });
}

function apiGetArchivePage(token, query) {
  _currentApiToken_ = token || '';
  return apiGuard_('apiGetArchivePage', () => {
    const user = _requireModule('Archive');
    return respond(getArchivePage_(user, query || {}));
  });
}

function apiGetArchiveSuggestions(token) {
  _currentApiToken_ = token || '';
  return apiGuard_('apiGetArchiveSuggestions', () => {
    const user = _requireModule('Archive');
    return respond(getArchiveSuggestionsFast_(user));
  });
}

function apiGetLostArchiveLeads(token) {
  _currentApiToken_ = token || '';
  return apiGuard_('apiGetLostArchiveLeads', () => {
    const user = _requireModule('Archive');
    return respond(getLostArchiveLeads_(user));
  });
}

function apiArchiveLead(token, payload) {
  _currentApiToken_ = token || '';
  return apiGuard_('apiArchiveLead', () => {
    const user = _apiUser();
    _assertCanMutate_(user, 'archive', 'archiveLead');
    const data = payload || {};
    return withTrustedWriteUser_(user.email, () => archiveLead(data.leadId || '', data.reason || '', user.email));
  });
}

// Bulk archive — archives many leads in one round-trip; reports per-lead success/failure.
function apiArchiveLeads(token, payload) {
  _currentApiToken_ = token || '';
  return apiGuard_('apiArchiveLeads', () => {
    const user = _apiUser();
    _assertCanMutate_(user, 'archive', 'archiveLead');
    const data = payload || {};
    const ids = (Array.isArray(data.leadIds) ? data.leadIds : []).map(String).filter(Boolean);
    const reason = data.reason || 'Bulk archived from lead master';
    if (!ids.length) return respond({ archived: [], failed: [] });
    return withTrustedWriteUser_(user.email, () => {
      const archived = [], failed = [];
      ids.forEach(id => {
        try {
          const r = archiveLead(id, reason, user.email, { skipStamps: true });
          if (r && r.success) archived.push(id);
          else failed.push({ id: id, error: (r && r.error) || 'Archive failed' });
        } catch (e) {
          failed.push({ id: id, error: (e && e.message) || String(e) });
        }
      });
      if (archived.length) _bumpArchiveStamps_();
      return respond({ archived: archived, failed: failed });
    });
  });
}

function apiRestoreArchivedLead(token, leadId) {
  _currentApiToken_ = token || '';
  return apiGuard_('apiRestoreArchivedLead', () => {
    const user = _apiUser();
    _assertCanMutate_(user, 'archive', 'restoreArchivedLead');
    return withTrustedWriteUser_(user.email, () => restoreArchivedLead(leadId || '', user.email));
  });
}

function apiUpdateLeadStage(token, payload) {
  _currentApiToken_ = token || '';
  return apiGuard_('apiUpdateLeadStage', () => {
    const user = _apiUser();
    _assertCanMutate_(user, 'leads', 'updateLeadStage');
    const data = payload || {};
    return withTrustedWriteUser_(user.email, () => updateLeadStage(data.leadId || '', data.stageId || '', data.note || '', user.email, data.fromStageId || ''));
  });
}

function apiMoveLeadStageWithFields(token, payload) {
  _currentApiToken_ = token || '';
  return apiGuard_('apiMoveLeadStageWithFields', () => {
    const user = _apiUser();
    _assertCanMutate_(user, 'leads', 'moveLeadStageWithFields');
    const data = payload || {};
    return withTrustedWriteUser_(user.email, () => moveLeadStageWithFields(data.leadId || '', data.stageId || '', data.fields || {}, data.note || '', user.email, data.fromStageId || ''));
  });
}

function apiGetLead(token, id) {
  _currentApiToken_ = token || '';
  return apiGuard_('apiGetLead', () => {
    const user = _requireAnyModule(['Leads', 'Followups', 'Archive']);
    const baseLead = getRowByIndexedId_(SHEET_NAMES.LEADS, 'Lead ID', id);
    const lead = baseLead ? getRowsWithCustomFieldValues_('Leads', [baseLead])[0] : null;
    const followups = _scopeFollowupRows(getFollowups({ leadId: id, includeClosed: true }), user);
    if (!lead || (!_canReadAssignedRow(lead, user) && !followups.length)) return respond(null, 'Lead not found.');
    const followupHistory = _scopeFollowupHistoryRows(getFollowupHistory({ leadId: id }), user);
    const activityLogs = _scopeActivityLogRows(getLeadActivityLogs({ leadId: id }), user);
    return respond({ lead, followups, followupHistory, activityLogs });
  });
}

// FSR is read-only and uses the same row/follow-up visibility as lead details.
function apiGetFsrVisitHistory(token, id, page) {
  _currentApiToken_ = token || '';
  return apiGuard_('apiGetFsrVisitHistory', () => {
    const user = _requireAnyModule(['Leads', 'Followups', 'Archive']);
    const lead = getRowByIndexedId_(SHEET_NAMES.LEADS, 'Lead ID', id);
    if (!lead) return respond(null, 'Lead not found.');
    if (!_canReadAssignedRow(lead, user)) {
      const followups = _scopeFollowupRows(getFollowups({ leadId: id, includeClosed: true }), user);
      if (!followups.length) return respond(null, 'Lead not found.');
    }
    return respond(_fsrReadLeadVisits_(String(lead['Lead ID']), page));
  });
}

function apiGetLeadFieldValues(token, id) {
  _currentApiToken_ = token || '';
  return apiGuard_('apiGetLeadFieldValues', () => {
    const user = _requireAnyModule(['Leads', 'Followups', 'Archive']);
    const lead = getLeadCustomValues(id);
    if (!lead || !_canReadAssignedRow(lead, user)) return respond(null, 'Lead not found.');
    return respond({ lead });
  });
}

// Follow-ups
function apiGetFollowups(token, filters) {
  _currentApiToken_ = token || '';
  return apiGuard_('apiGetFollowups', () => {
    const user = _requireModule('Followups');
    const rows = _scopeFollowupRows(getFollowups(filters || {}), user);
    return respond(rows.sort((a, b) => new Date(b['Created At']) - new Date(a['Created At'])));
  });
}

function apiGetFollowupHistory(token, filters) {
  _currentApiToken_ = token || '';
  return apiGuard_('apiGetFollowupHistory', () => {
    const user = _requireModule('Followups');
    return respond(_scopeFollowupHistoryRows(getFollowupHistory(filters || {}), user));
  });
}

function apiGetLeadActivityLogs(token, filters) {
  _currentApiToken_ = token || '';
  return apiGuard_('apiGetLeadActivityLogs', () => {
    const user = _requireAnyModule(['Leads', 'Followups']);
    return respond(_scopeActivityLogRows(getLeadActivityLogs(filters || {}), user));
  });
}

function apiGetTodayActivitySnapshot(token) {
  _currentApiToken_ = token || '';
  return apiGuard_('apiGetTodayActivitySnapshot', () => {
    const user = _requireAnyModule(['Followups', 'Leads']);
    return respond(getTodayActivitySnapshotFast_(user));
  });
}

function apiGetFollowupPageSnapshot(token, options) {
  _currentApiToken_ = token || '';
  return apiGuard_('apiGetFollowupPageSnapshot', () => {
    const user = _requireModule('Followups');
    return respond(getFollowupPageSnapshotFast_(user, options || {}));
  });
}

function apiGetFollowupsPage(token, query) {
  _currentApiToken_ = token || '';
  return apiGuard_('apiGetFollowupsPage', () => {
    const user = _requireModule('Followups');
    return respond(getFollowupsPage_(user, query || {}));
  });
}

function apiRunSheetsApiSampleWrite(token, payload) {
  _currentApiToken_ = token || '';
  return apiGuard_('apiRunSheetsApiSampleWrite', () => {
    const user = _requireConfigReader();
    return respond(runSheetsApiSampleWrite_(user, payload || {}));
  });
}

function apiGetCallLogs(token, options) {
  _currentApiToken_ = token || '';
  return apiGuard_('apiGetCallLogs', () => respond(_getCallLogs_(_requireAnyModule(['Leads','Followups','Archive']), options || {})));
}

function apiGetCallMappingContext(token, callId, search) {
  _currentApiToken_ = token || '';
  return apiGuard_('apiGetCallMappingContext', () => respond(_callMappingContext_(_requireModule('Leads'), callId, search)));
}

function apiMapCallToClient(token, payload) {
  _currentApiToken_ = token || '';
  return apiGuard_('apiMapCallToClient', () => {
    const user = _requireModule('Leads');
    return withTrustedWriteUser_(user.email, () => respond(_mapCallToClient_(user, payload)));
  });
}

function apiRetryCallDelivery(token, deliveryId) {
  _currentApiToken_ = token || '';
  return apiGuard_('apiRetryCallDelivery', () => {
    const user = _requireConfigReader();
    return withTrustedWriteUser_(user.email, () => respond(_retryCallDelivery_(deliveryId)));
  });
}

function apiGetCallWebhook(token) {
  _currentApiToken_ = token || '';
  return apiGuard_('apiGetCallWebhook', () => {
    _requireConfigReader();
    return respond(_callWebhookPage_());
  });
}

function apiGetCallWebhookDelivery(token, deliveryId) {
  _currentApiToken_ = token || '';
  return apiGuard_('apiGetCallWebhookDelivery', () => {
    _requireConfigReader();
    return respond(_callWebhookDelivery_(deliveryId));
  });
}

function apiSaveCallWebhook(token, payload) {
  _currentApiToken_ = token || '';
  return apiGuard_('apiSaveCallWebhook', () => {
    const user = _requireConfigReader();
    return withTrustedWriteUser_(user.email, () => respond(_saveCallWebhook_(payload)));
  });
}

function apiSavePortalSettings(token, payload) {
  _currentApiToken_ = token || '';
  return apiGuard_('apiSavePortalSettings', () => {
    const user = _apiUser();
    _assertCanMutate_(user, 'config', 'savePortalSettings');
    return withTrustedWriteUser_(user.email, () => savePortalSettings(payload || {}, user.email));
  });
}

function apiAddConfig(token, payload) {
  _currentApiToken_ = token || '';
  return apiGuard_('apiAddConfig', () => {
    const user = _apiUser();
    _assertCanMutate_(user, 'config', 'addConfig');
    const data = payload || {};
    return withTrustedWriteUser_(user.email, () => addConfig(data.type || data['Config Type'] || '', data.value || data.Value || '', user.email));
  });
}

function apiUpdateConfigStatus(token, payload) {
  _currentApiToken_ = token || '';
  return apiGuard_('apiUpdateConfigStatus', () => {
    const user = _apiUser();
    _assertCanMutate_(user, 'config', 'updateConfigStatus');
    const data = payload || {};
    return withTrustedWriteUser_(user.email, () => updateConfigStatus(data.id || data['Config ID'] || '', data.status || data.Status || '', user.email));
  });
}

function apiSaveStage(token, payload) {
  _currentApiToken_ = token || '';
  return apiGuard_('apiSaveStage', () => {
    const user = _apiUser();
    _assertCanMutate_(user, 'stages', 'saveStage');
    return withTrustedWriteUser_(user.email, () => saveStage(payload || {}, user.email));
  });
}

function apiReorderStages(token, ids) {
  _currentApiToken_ = token || '';
  return apiGuard_('apiReorderStages', () => {
    const user = _apiUser();
    _assertCanMutate_(user, 'stages', 'reorderStages');
    return withTrustedWriteUser_(user.email, () => reorderStages(Array.isArray(ids) ? ids : [], user.email));
  });
}

function apiSaveFieldConfig(token, payload) {
  _currentApiToken_ = token || '';
  return apiGuard_('apiSaveFieldConfig', () => {
    const user = _apiUser();
    _assertCanMutate_(user, 'fields', 'saveFieldConfig');
    return withTrustedWriteUser_(user.email, () => saveFieldConfig(payload || {}, user.email));
  });
}

function apiSaveUser(token, payload) {
  _currentApiToken_ = token || '';
  return apiGuard_('apiSaveUser', () => {
    const user = _apiUser();
    _assertCanMutate_(user, 'config', 'saveUser');
    return withTrustedWriteUser_(user.email, () => _saveUser(payload || {}, user.email));
  });
}

function apiGetFollowupFormData(token) {
  _currentApiToken_ = token || '';
  return apiGuard_('apiGetFollowupFormData', () => {
    const user = _requireModule('Followups');
    const leads = _scopeAssignedRows(_leadRows(), user)
      .filter(l => l['Lead Status'] === 'Open');
    return respond({ leads });
  });
}

function apiGetFollowupLeads(token) {
  _currentApiToken_ = token || '';
  return apiGuard_('apiGetFollowupLeads', () => {
    const user = _requireModule('Followups');
    const visibleFollowups = _scopeFollowupRows(getFollowups({ includeClosed: true }), user);
    const linked = {};
    visibleFollowups.forEach(f => { if (f['Lead ID']) linked[f['Lead ID']] = true; });
    const leads = _leadRows().filter(l => _canReadAssignedRow(l, user) || linked[l['Lead ID']]);
    return respond(leads);
  });
}

function apiSaveFollowupDirect(token, payload) {
  _currentApiToken_ = token || '';
  return apiGuard_('apiSaveFollowupDirect', () => {
    const user = _apiUser();
    _assertCanEnqueueJob_(user, 'followups', 'saveFollowup');
    return withTrustedWriteUser_(user.email, () => saveFollowup(payload || {}, user.email));
  });
}

function apiMarkFollowupDoneDirect(token, followupId, payload) {
  _currentApiToken_ = token || '';
  return apiGuard_('apiMarkFollowupDoneDirect', () => {
    const user = _apiUser();
    _assertCanEnqueueJob_(user, 'followups', 'markFollowupDone');
    try {
      return withTrustedWriteUser_(user.email, () => markFollowupDone(followupId || '', payload || {}, user.email));
    } catch (error) {
      const step = (error.followupDoneStep || 'validating follow-up completion') + (error.sheetUpdateStep ? ' / ' + error.sheetUpdateStep : '');
      logServerError_(error, { api: 'apiMarkFollowupDoneDirect', step });
      return respond(null, error, errorCodeFrom_(error), { step });
    }
  });
}

// Users
function apiGetUsers(token) {
  _currentApiToken_ = token || '';
  return apiGuard_('apiGetUsers', () => {
    const user = _apiUser();
    if (!canManageUsersPermission(user)) throw new Error('Permission denied.');
    return respond(getUsersWithPortalAccess_(currentPortalKey_(), true));
  });
}

function apiGetNbdAssignableUsers(token) {
  _currentApiToken_ = token || '';
  return apiGuard_('apiGetNbdAssignableUsers', () => {
    const user = _apiUser();
    const hasLeadAccess = user.role === 'ADMIN' || userHasModule(user, 'Leads') || userHasModule(user, 'LeadForm');
    if (!['ADMIN', 'MANAGER', 'SALES'].includes(user.role) || !hasLeadAccess) throw new Error('Permission denied.');
    return respond(getNbdAssignableUsers());
  });
}

function apiCheckNbdDuplicate(token, leadId) {
  _currentApiToken_ = token || '';
  return apiGuard_('apiCheckNbdDuplicate', () => {
    const user = _apiUser();
    const hasLeadAccess = user.role === 'ADMIN' || userHasModule(user, 'Leads') || userHasModule(user, 'LeadForm');
    if (!['ADMIN', 'MANAGER', 'SALES'].includes(user.role) || !hasLeadAccess) throw new Error('Permission denied.');
    return respond(checkNbdDuplicates(leadId));
  });
}

function apiGetNbdPushContext(token, leadId) {
  _currentApiToken_ = token || '';
  return apiGuard_('apiGetNbdPushContext', () => {
    const user = _apiUser();
    const hasLeadAccess = user.role === 'ADMIN' || userHasModule(user, 'Leads') || userHasModule(user, 'LeadForm');
    if (!['ADMIN', 'MANAGER', 'SALES'].includes(user.role) || !hasLeadAccess) throw new Error('Permission denied.');
    return respond(getNbdPushContext(leadId));
  });
}

function apiPushLeadToNbd(token, payload) {
  _currentApiToken_ = token || '';
  return apiGuard_('apiPushLeadToNbd', () => {
    const user = _apiUser();
    _assertCanMutate_(user, 'leads', 'pushLeadToNbd');
    const data = payload || {};
    return withTrustedWriteUser_(user.email, () => pushLeadToNbd(
      data.leadId || data['Lead ID'] || '',
      user.email,
      data.nbdAssignedTo || '',
      data.mapToNbdLeadId || '',
      data.qualifiedRemark || ''
    ));
  });
}
// Bulk Entry
function apiGetBulkConfig(token) {
  _currentApiToken_ = token || '';
  return apiGuard_('apiGetBulkConfig', () => {
    _requireBulkEntry_();
    return respond(getBulkConfig());
  });
}

function apiValidateBulkRows(token, rows, mode) {
  _currentApiToken_ = token || '';
  return apiGuard_('apiValidateBulkRows', () => {
    _requireBulkEntry_();
    return respond(validateBulkRows(rows || [], mode || 'create'));
  });
}

function apiSaveBulkRows(token, rows, mode) {
  _currentApiToken_ = token || '';
  return apiGuard_('apiSaveBulkRows', () => {
    const user = _requireBulkEntry_();
    try {
      return withTrustedWriteUser_(user.email, () =>
        respond(saveBulkRows(rows || [], user.email, '', mode || 'create')));
    } catch (error) {
      logServerError_(error, { api: 'apiSaveBulkRows', step: error.bulkSaveStep || 'validating and preparing bulk rows' });
      return respond(null, error, errorCodeFrom_(error), { step: error.bulkSaveStep || 'validating and preparing bulk rows' });
    }
  });
}

function apiCreateBulkFollowupOnlyRow(token, row, rowNumber) {
  _currentApiToken_ = token || '';
  return apiGuard_('apiCreateBulkFollowupOnlyRow', () => {
    const user = _requireBulkEntry_();
    return withTrustedWriteUser_(user.email, () =>
      respond(createBulkFollowupOnlyRow(row || {}, Number(rowNumber) || 1, user.email)));
  });
}

function apiCreateErrorCsv(token, errorRows) {
  _currentApiToken_ = token || '';
  return apiGuard_('apiCreateErrorCsv', () => {
    _requireBulkEntry_();
    return respond(createErrorCsv(errorRows || []));
  });
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function _apiUser() {
  if (_currentApiToken_) {
    const session = readAuthSession_(_currentApiToken_);
    // Token present but not in cache = session expired; tell the client to re-login.
    if (!session) throw new Error('SESSION_EXPIRED');
    const result = getCurrentUserByEmail_(session.email);
    if (!result.success) throw new Error(result.error || 'ACCESS_DENIED');
    refreshAuthSession_(_currentApiToken_);
    return result.data;
  }
  // No token — only works on "Execute as: User accessing" deployments.
  // This portal uses "Execute as: USER_DEPLOYING" + anonymous access, so
  // Session.getActiveUser() always returns empty string here.
  throw new Error('SESSION_EXPIRED');
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
    if ((!misDepartment && user.role !== 'ADMIN') || !has('Leads')) throw new Error('Permission denied. Only MIS or Admin users can delete leads.');
    return;
  }
  if (['archiveLead', 'restoreArchivedLead'].includes(actionType)) {
    if (!(isAdmin || has('Archive'))) throw new Error('Permission denied.');
    return;
  }
  if (actionType === 'saveBulkRows') {
    _requireBulkEntry_();
    return;
  }
  if (['saveLead', 'updateLeadStage', 'moveLeadStageWithFields', 'pushLeadToNbd'].includes(actionType)) {
    if (!canWriteLead) throw new Error('Permission denied.');
    return;
  }
  if (['saveFollowup', 'markFollowupDone'].includes(actionType)) {
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

function _assertCanMutate_(user, moduleName, actionType) {
  return _assertCanEnqueueJob_(user, moduleName, actionType);
}

function _hasGlobalRead(user) {
  return ['ADMIN', 'MANAGER', 'VIEWER'].includes(user.role);
}

function _hasAdminFullRead(user) {
  return user && user.role === 'ADMIN';
}

function _canReadAssignedRow(row, user) {
  if (_hasAdminFullRead(user)) return true;
  if (!_hasGlobalRead(user)) return row['Assigned To'] === user.id;
  return _rowMatchesDepartmentScope_(row, _buildUserMapById_(), _portalDepartmentScopeSet_());
}

function _scopeAssignedRows(rows, user) {
  if (_hasAdminFullRead(user)) return rows || [];
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
  if (_hasAdminFullRead(user)) return rows || [];
  if (_hasGlobalRead(user)) {
    const userMap = _buildUserMapById_();
    const leadMap = _buildLeadMapById_();
    const scope = _portalDepartmentScopeSet_();
    return rows.filter(r => _linkedRowMatchesDepartmentScope_(r, actorFields, userMap, leadMap, scope));
  }
  const leadIds = _leadIndexRowsForScope_()
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
  return _leadIndexRowsForScope_().reduce((m, l) => {
    if (l['Lead ID']) m[l['Lead ID']] = l;
    return m;
  }, {});
}

function _leadRows() {
  return getRowsWithCustomFieldValues_('Leads', getAllRows(SHEET_NAMES.LEADS))
    .filter(row => !_isArchivedLead_(row));
}

function _leadIndexRowsForScope_() {
  let rows = getAllRows(SHEET_NAMES.IDX_LEADS);
  if (!rows.length && getSheet(SHEET_NAMES.LEADS).getLastRow() > 1) {
    rebuildIndexForSheet_(SHEET_NAMES.LEADS);
    rows = getAllRows(SHEET_NAMES.IDX_LEADS);
  }
  return rows;
}
