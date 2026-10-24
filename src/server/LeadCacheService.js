// Authorized read-cache protocol. No Sheet writes, timestamp cursors or change log.
// Each page rechecks live membership and content, including direct Sheet edits.
const LEAD_CACHE_SCHEMA_ = 1;
const LEAD_CACHE_PAGE_SIZE_ = 100;

// New clients opt in to fewer RPC round-trips for complete cold snapshots.
// Keep the legacy 100-row protocol for already-open/older portal versions.
function leadCacheSnapshotPage_(rows, query, meta) {
  const batched = query.snapshotBatch === true;
  let offset = 0;
  if (query.cursor != null) {
    if (typeof query.cursor !== 'string' || !/^\d+$/.test(query.cursor) || query.revision !== meta.revision) {
      throw new Error('CACHE_REVISION_CHANGED: Restart the snapshot.');
    }
    offset = Number(query.cursor);
    if (!Number.isSafeInteger(offset) || offset <= 0 || offset >= rows.length || !batched && offset % LEAD_CACHE_PAGE_SIZE_ !== 0) throw new Error('Invalid cache cursor.');
  }
  const limit = batched ? 2000 : LEAD_CACHE_PAGE_SIZE_;
  let end = Math.min(offset + limit, rows.length);
  if (batched) {
    let size = 2;
    for (let i = offset; i < end; i++) {
      const length = JSON.stringify(rows[i]).length + 1;
      // Always allow one whole row so a long remark cannot cause an empty-page
      // loop. Normal batches target at most one million serialized characters.
      if (i > offset && size + length > 1000000) { end = i; break; }
      size += length;
    }
  }
  return { ...meta, offset, items: rows.slice(offset, end), nextCursor: end < rows.length ? String(end) : null };
}

function leadCacheDigest_(value) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, JSON.stringify(value), Utilities.Charset.UTF_8)
    .map(byte => ('0' + ((byte + 256) % 256).toString(16)).slice(-2)).join('');
}

function leadCacheCanonicalValue_(value) {
  if (Array.isArray(value)) return value.map(leadCacheCanonicalValue_);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, leadCacheCanonicalValue_(value[key])]));
}
function leadCacheContentDigest_(scope, rows, canonical) {
  const value = { scope, rows };
  return leadCacheDigest_(canonical ? leadCacheCanonicalValue_(value) : value);
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
  const revision = leadCacheContentDigest_(identity.scope, rows, query.canonicalHashes === true);
  const meta = { identity, revision, total: rows.length, verifiedAt: new Date().toISOString() };
  if (query.canonicalHashes === true) meta.hashFormat = 'canonical-v1';
  if (query.cursor == null && query.revision === revision) return Object.assign(meta, { unchanged: true });
  const delta = typeof syncDeltaPage_ === 'function' ? syncDeltaPage_(query, rows, meta) : null;
  if (delta) return delta;
  return leadCacheSnapshotPage_(rows, query, meta);
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
