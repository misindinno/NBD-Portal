// Authorized read-cache protocol. No Sheet writes, timestamp cursors or change log.
// Each page rechecks live membership and content, including direct Sheet edits.
const LEAD_CACHE_SCHEMA_ = 1;
const LEAD_CACHE_PAGE_SIZE_ = 100;

function leadCacheDigest_(value) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, JSON.stringify(value), Utilities.Charset.UTF_8)
    .map(byte => ('0' + ((byte + 256) % 256).toString(16)).slice(-2)).join('');
}

function leadCacheIdentity_(user) {
  const scope = { id: user.id, role: user.role, modules: user.modules || [], department: user.department || '', departments: _portalDepartmentScopeSet_() };
  return {
    schema: LEAD_CACHE_SCHEMA_, portal: ScriptApp.getScriptId(), user: String(user.id),
    scope: leadCacheDigest_(scope),
    enabled: PropertiesService.getScriptProperties().getProperty('LEAD_READ_CACHE_ENABLED') === 'true',
    modulesEnabled: PropertiesService.getScriptProperties().getProperty('PORTAL_READ_CACHE_ENABLED') === 'true',
    syncEnabled: typeof syncEnabled_ === 'function' && syncEnabled_()
  };
}

function leadCacheRows_(user) {
  // Scope base rows BEFORE merging read-only custom values. Do not use _leadRows:
  // its compatibility custom-field reader can initialize tables on a read.
  const base = _scopeAssignedRows(getAllRows(SHEET_NAMES.LEADS).filter(row => !_isArchivedLead_(row)), user);
  const rows = getRowsWithCustomFieldValuesReadOnly_('Leads', base);
  const ids = new Set();
  return rows.map(row => {
    const id = String(row['Lead ID'] || '');
    if (!id || ids.has(id)) throw new Error('Invalid or duplicate Lead ID. Repair the source records before syncing.');
    ids.add(id);
    const clean = {};
    Object.keys(row).sort().forEach(key => {
      // Persist only scalar lead fields, never directory/config objects or credentials.
      if (/password|passwd|secret|token|credential|authorization|cookie|session|api[ _-]?key|__proto__|constructor|prototype/i.test(key)) return;
      const value = row[key];
      if (value === null || ['string','number','boolean'].includes(typeof value)) clean[key] = value;
    });
    clean['Lead ID'] = id;
    return clean;
  }).sort((a, b) => a['Lead ID'] < b['Lead ID'] ? -1 : a['Lead ID'] > b['Lead ID'] ? 1 : 0);
}

function leadCachePage_(user, input) {
  const query = input || {}, identity = leadCacheIdentity_(user);
  if (!identity.enabled) throw new Error('CACHE_DISABLED: Reload the portal.');
  if (query.scope !== identity.scope || query.portal !== identity.portal || query.user !== identity.user) {
    throw new Error('CACHE_SCOPE_CHANGED: Reload the portal to verify current access.');
  }
  const rows = leadCacheRows_(user);
  const revision = leadCacheDigest_({ scope: identity.scope, rows });
  const meta = { identity, revision, total: rows.length, verifiedAt: new Date().toISOString() };
  if (query.cursor == null && query.revision === revision) return Object.assign(meta, { unchanged: true });
  const delta = typeof syncDeltaPage_ === 'function' ? syncDeltaPage_(query, rows, meta) : null;
  if (delta) return delta;
  if (query.cursor != null) {
    if (typeof query.cursor !== 'string' || !/^\d+$/.test(query.cursor) || query.revision !== revision) {
      throw new Error('CACHE_REVISION_CHANGED: Restart the snapshot.');
    }
    const offset = Number(query.cursor);
    if (!Number.isSafeInteger(offset) || offset <= 0 || offset >= rows.length || offset % LEAD_CACHE_PAGE_SIZE_ !== 0) throw new Error('Invalid cache cursor.');
    const next = offset + LEAD_CACHE_PAGE_SIZE_;
    return Object.assign(meta, { offset, items: rows.slice(offset, next), nextCursor: next < rows.length ? String(next) : null });
  }
  if (query.revision === revision) return Object.assign(meta, { unchanged: true });
  return Object.assign(meta, { offset: 0, items: rows.slice(0, LEAD_CACHE_PAGE_SIZE_), nextCursor: rows.length > LEAD_CACHE_PAGE_SIZE_ ? String(LEAD_CACHE_PAGE_SIZE_) : null });
}

function apiGetLeadCachePage(token, query) {
  _currentApiToken_ = token || '';
  return apiGuard_('apiGetLeadCachePage', () => {
    const user = _requireModule('Leads');
    try { return respond(leadCachePage_(user, query)); }
    catch (error) {
      const code = String(error.message || '').split(':')[0];
      if (['CACHE_SCOPE_CHANGED','CACHE_REVISION_CHANGED','CACHE_DISABLED'].includes(code)) return respond(null, code, code);
      throw error;
    }
  });
}
