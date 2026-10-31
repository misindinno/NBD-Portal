// Durable browser commands; Sheets is the only shared database.
const SYNC_ACTIONS_ = {
  apiSaveLead: ['leads','saveLead'], apiSaveFollowupDirect: ['followups','saveFollowup'],
  apiMarkFollowupDoneDirect: ['followups','markFollowupDone'],
  apiUpdateLeadStage: ['leads','updateLeadStage'], apiMoveLeadStageWithFields: ['leads','moveLeadStageWithFields'],
  apiArchiveLead: ['archive','archiveLead'], apiArchiveLeads: ['archive','archiveLead'], apiRestoreArchivedLead: ['archive','restoreArchivedLead'],
  apiSaveBulkRows: ['leads','saveBulkRows'], apiMapCallToClient: ['leads','saveLead']
};
function syncEnabled_() { return PropertiesService.getScriptProperties().getProperty('PORTAL_TWO_WAY_SYNC_ENABLED') === 'true'; }
function syncTargets_(action, args) {
  const p = args[0] || {}, targets = [];
  const lead = id => { if (id) targets.push({ type: 'lead', id: String(id) }); };
  if (action === 'apiMapCallToClient') return targets; // Existing expectedPhone/expectedAlternate guards apply.
  if (action === 'apiMarkFollowupDoneDirect') targets.push({ type: 'followup', id: String(args[0]) });
  else if (action === 'apiRestoreArchivedLead') lead(args[0]);
  else if (action === 'apiArchiveLeads') (p.leadIds || []).forEach(lead);
  else if (action === 'apiSaveBulkRows') {
    if ((args[1] || 'create') !== 'create') (args[0] || []).forEach(row => lead(row['Lead ID'] || row.leadId));
  } else lead(p['Lead ID'] || p.leadId || p.LeadID || p['Lead Id'] || p.ID);
  return targets;
}
function syncBaseRow_(type, id, archiveRestore) {
  const key = type === 'lead' ? 'Lead ID' : 'Follow-up ID';
  const table = type === 'lead' ? SHEET_NAMES.LEADS : SHEET_NAMES.FOLLOWUPS;
  const row = syncTxHandles_(table) ? syncTxRow_(table, key, id) : getAllRows(table).find(row => String(row[key]) === id);
  if (!row) return archiveRestore && type==='lead' && typeof arFindLead_==='function' ? arFindLead_(id) : null;
  return type === 'lead' ? getRowsWithCustomFieldValuesReadOnly_('Leads', [row])[0] : _normalizeFollowupRow(row);
}
function syncCheckBases_(user, command) {
  const targets = syncTargets_(command.action, command.args);
  for (const target of targets.slice()) {
    const row = syncBaseRow_(target.type, target.id, command.action==='apiRestoreArchivedLead');
    if (!row) throw new Error('SYNC_CONFLICT: Record was removed. Refresh and review your pending change.');
    if (target.type === 'followup' && row['Lead ID']) targets.push({ type: 'lead', id: String(row['Lead ID']) });
  }
  for (const target of targets) {
    const row = syncBaseRow_(target.type, target.id, command.action==='apiRestoreArchivedLead');
    if (target.type === 'lead' && !_canReadAssignedRow(row, user)) throw new Error('Permission denied. Record access changed.');
    const base = (command.bases || []).find(base => base.type === target.type && base.id === target.id);
    if (!base || !base.values || !Object.prototype.hasOwnProperty.call(base.values, 'Updated At')) throw new Error('SYNC_CONFLICT: Open the latest record before saving.');
    const required = target.type === 'lead' ? ['Stage ID','Assigned To'] : ['Status','Planned Date'];
    if (required.some(key => !Object.prototype.hasOwnProperty.call(base.values, key))) throw new Error('Invalid sync base.');
    // Compare the fields originally displayed, including custom values; computed
    // display-only fields are excluded by the browser and ignored here.
    const definitions = target.type === 'lead' ? getLeadCustomFieldsForStage(row['Stage ID']) : getFollowupCustomFields();
    const allowed = new Set((target.type === 'lead' ? LEAD_MASTER_FIELDS : FOLLOWUP_MASTER_FIELDS)
      .concat(definitions.filter(field => field['Field Type'] !== 'Formula').map(field => _customEffectiveColumnKey_(field, row['Stage ID']))));
    let keys = Object.keys(base.values).filter(key => allowed.has(key));
    if (command.action === 'apiMarkFollowupDoneDirect' && target.type === 'lead') {
      // A remark appends history using the current lead. Unrelated contact/FSR
      // metadata changes must not reject it, but stage, owner, lifecycle and
      // fields this submission can change still require an unchanged base.
      const relevant = new Set(['Stage ID','Assigned To','Lead Status','Is Archived','Archived At',
        ...Object.keys(command.args[1] || {})]);
      keys = keys.filter(key => relevant.has(key));
    }
    if (keys.some(key => String(row[key] == null ? '' : row[key]) !== String(base.values[key] == null ? '' : base.values[key]))) {
      throw new Error('SYNC_CONFLICT: This record changed in Sheets or another session. Review the latest record before resubmitting.');
    }
  }
}
function syncValidateCommand_(command) {
  if (!command || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(command.id || '') ||
      !Object.prototype.hasOwnProperty.call(SYNC_ACTIONS_, command.action) || !Array.isArray(command.args) || command.args.length > 3 ||
      !Array.isArray(command.bases) || command.bases.length > 50 || JSON.stringify(command).length > 250000) throw new Error('Invalid sync command.');
  if (command.action === 'apiSaveBulkRows' && (!Array.isArray(command.args[0]) || command.args[0].length > 20)) throw new Error('Invalid sync bulk size: use up to 20 rows per batch.');
  function check(value, depth) {
    if (depth > 8) throw new Error('Invalid sync payload depth.');
    if (!value || typeof value !== 'object') return;
    if (typeof value.data === 'string' && ('mimeType' in value || 'name' in value)) throw new Error('Invalid sync payload: upload files separately.');
    Object.keys(value).forEach(key => {
      if (/password|passwd|secret|token|credential|authorization|cookie|api[ _-]?key|^(session|__proto__|constructor|prototype|base64)$/i.test(key)) throw new Error('Invalid sync payload: credentials and file uploads cannot enter the sync queue.');
      check(value[key], depth + 1);
    });
  }
  check(command.args, 0); check(command.bases, 0);
}
function syncRunCommand_(user, command) {
  const p = command.args[0] || {};
  return withTrustedWriteUser_(user.email, () => {
    switch (command.action) {
      case 'apiMapCallToClient': return respond(_mapCallToClient_(user, p));
      case 'apiSaveLead': return saveLead(p, user.email);
      case 'apiSaveFollowupDirect': return saveFollowup(p, user.email);
      case 'apiMarkFollowupDoneDirect': return markFollowupDone(command.args[0], command.args[1] || {}, user.email);
      case 'apiUpdateLeadStage': return updateLeadStage(p.leadId, p.stageId, p.note || '', user.email, p.fromStageId || '');
      case 'apiMoveLeadStageWithFields': return moveLeadStageWithFields(p.leadId, p.stageId, p.fields || {}, p.note || '', user.email, p.fromStageId || '');
      case 'apiArchiveLead': return archiveLead(p.leadId || p['Lead ID'], p.reason || '', user.email);
      case 'apiArchiveLeads': {
        const archived = [], failed = [];
        (p.leadIds || []).forEach(id => {
          const point = syncTxSavepoint_();
          try {
            const result = archiveLead(id, p.reason || 'Bulk archived from lead master', user.email);
            if (!result.success) throw new Error(result.error);
            archived.push(id);
          } catch (error) { syncTxRestore_(point); failed.push({ id, error: error.message }); }
        });
        return respond({ archived, failed });
      }
      case 'apiRestoreArchivedLead': return restoreArchivedLead(command.args[0], user.email);
      case 'apiSaveBulkRows': return respond(saveBulkRows(command.args[0], user.email, command.id, command.args[1] || 'create'));
      default: throw new Error('Invalid sync action.');
    }
  });
}
function apiSyncPush(token, command) {
  _currentApiToken_ = token || '';
  return apiGuard_('apiSyncPush', () => {
    const user = _apiUser();
    if (!syncEnabled_()) return respond({ state: 'paused', message: 'Two-way sync is disabled. Your pending change has been retained.' });
    syncValidateCommand_(command);
    const identity = leadCacheIdentity_(user);
    if (command.portal !== identity.portal || command.user !== user.id || command.scope !== identity.scope) return respond({ state: 'blocked', message: 'Account or permissions changed. Sign in and review this change.' });
    _assertCanMutate_(user, ...SYNC_ACTIONS_[command.action]);
    try { return respond(syncAtomicWrite_(user, command, () => syncRunCommand_(user, command))); }
    catch (error) {
      if (/SYNC_CONFLICT/.test(error.message)) return respond({ state: 'conflict', message: error.message });
      if (/SYNC_SETUP_REQUIRED/.test(error.message)) return respond({ state: 'paused', message: 'An administrator must initialize two-way sync.' });
      if (/^Invalid sync batch size\./.test(error.message)) return respond({ state: 'paused', message: 'This save exceeds the sync batch limit. Your change is retained; retry after the portal is updated or use a smaller bulk batch.' });
      // Unknown commit outcomes MUST be retried with the same ID, never replayed
      // through the legacy endpoint. The atomic receipt/fence resolves ambiguity.
      throw error;
    }
  });
}

// Explicit administrator setup; does not change workbooks or enable itself on deployment.
function apiSyncInitialize(token) {
  _currentApiToken_ = token || '';
  return apiGuard_('apiSyncInitialize', () => {
    const user = _apiUser();
    if (user.role !== 'ADMIN') throw new Error('Permission denied.');
    const lock = LockService.getScriptLock(); lock.waitLock(10000);
    try {
      safeInitHeaders(SYNC_RECEIPTS_, SYNC_RECEIPT_HEADERS_);
      ensureFollowupSheets_(); ensureCustomFieldValueSheets_();
      _ensureBulkSheets_();
      safeInitHeaders(FSR_SYNC_QUEUE_SHEET_, FSR_SYNC_QUEUE_HEADERS_);
      _ensureFsrSyncWorker_();
      const props = PropertiesService.getScriptProperties();
      props.setProperty('LEAD_READ_CACHE_ENABLED', 'true');
      props.setProperty('PORTAL_READ_CACHE_ENABLED', 'true');
      props.setProperty('PORTAL_TWO_WAY_SYNC_ENABLED', 'true');
      return respond({ enabled: true });
    } finally { lock.releaseLock(); }
  });
}
