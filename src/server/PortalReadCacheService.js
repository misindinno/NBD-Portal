// Validated response snapshots with opt-in manifest deltas. Existing domain
// services remain responsible for scoping, categorization and all totals.
let PORTAL_CACHE_READ_ONLY_ = false;

function portalCacheQuery_(kind, input) {
  const fields = {
    followups: ['includeHistory'], today: [], archive: [], archiveSuggestions: [], archiveLost: [],
    visits: ['page','from','to','status','host','search'], calls: ['page','leadId','status','from','to','caller','type','search'],
    callReport: ['page','from','to','search','category','status','archive','doneBy']
  };
  if (!Object.prototype.hasOwnProperty.call(fields, kind)) throw new Error('Invalid cache module.');
  const query = {};
  fields[kind].slice().sort().forEach(key => {
    const value = input && input[key];
    if (value === undefined || value === null) return;
    if (!['string','number','boolean'].includes(typeof value) || String(value).length > 500) throw new Error('Invalid cache query.');
    query[key] = value;
  });
  return query;
}

function portalCacheSource_(kind, query) {
  switch (kind) {
    case 'calls': return _getCallLogs_(_requireAnyModule(['Leads','Followups','Archive']), query);
    case 'followups': return getFollowupPageSnapshotFast_(_requireModule('Followups'), query);
    case 'today': return getTodayActivitySnapshotFast_(_requireAnyModule(['Followups','Leads']));
    case 'archive': return getArchiveData(_requireModule('Archive'), true);
    case 'archiveSuggestions': return getArchiveSuggestionsFast_(_requireModule('Archive'), true);
    case 'archiveLost': return getLostArchiveLeads_(_requireModule('Archive'), true);
    case 'visits': return _cfvList_(_cfvUser_(false), query);
    case 'callReport': {
      const report = _clientCallReport_(_requireModule('Reports'), query);
      const total = report.items.length, page = Math.min(report.filters.page, Math.max(1, Math.ceil(total / 50)));
      return { ...report, items: report.items.slice((page - 1) * 50, page * 50), total, page, pageSize: 50 };
    }
    default: throw new Error('Invalid cache module.');
  }
}

function portalCacheSafeValue_(value) {
  if (value == null || ['string','boolean'].includes(typeof value)) return value == null ? null : value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map(portalCacheSafeValue_);
  const clean = {};
  Object.keys(value).sort().forEach(key => {
    if (/password|passwd|secret|token|credential|authorization|cookie|session|api[ _-]?key|__proto__|constructor|prototype|^(users|hosts|userNameMap|userDirectory|config)$/i.test(key)) return;
    if (value[key] !== undefined) clean[key] = portalCacheSafeValue_(value[key]);
  });
  return clean;
}

function portalCachePack_(kind, query, source) {
  const array = Array.isArray(source), value = array ? { items: source } : source;
  const volatile = {}, fields = {}, arrays = {}, records = [];
  Object.keys(value).sort().forEach(key => {
    if (['users','hosts','userNameMap','userDirectory','config','fetchMs','fetchedAt','source'].includes(key)) { volatile[key] = value[key]; return; }
    if (/password|passwd|secret|token|credential|authorization|cookie|session|api[ _-]?key|__proto__|constructor|prototype/i.test(key)) return;
    if (Array.isArray(value[key])) {
      arrays[key] = value[key].length;
      value[key].forEach((item, index) => records.push({ bucket: key, index, value: portalCacheSafeValue_(item) }));
    } else fields[key] = value[key];
  });
  return {
    records: [{ bucket: '_meta', index: 0, value: { kind, query, array, fields: portalCacheSafeValue_(fields), arrays } }, ...records],
    volatile
  };
}

function portalReadCachePage_(user, input) {
  const q = input || {}, kind = String(q.kind || ''), query = portalCacheQuery_(kind, q.query);
  const identity = leadCacheIdentity_(user);
  identity.enabled = identity.modulesEnabled;
  if (!identity.enabled) throw new Error('CACHE_DISABLED');
  if (q.portal !== identity.portal || q.user !== identity.user || q.scope !== identity.scope) throw new Error('CACHE_SCOPE_CHANGED');
  let source;
  const prior = PORTAL_CACHE_READ_ONLY_;
  PORTAL_CACHE_READ_ONLY_ = true;
  try { source = portalCacheSource_(kind, query); } finally { PORTAL_CACHE_READ_ONLY_ = prior; }
  const packed = portalCachePack_(kind, query, source), rows = packed.records;
  const revision = leadCacheDigest_({ scope: identity.scope, rows });
  const meta = { identity, revision, total: rows.length, verifiedAt: new Date().toISOString(), volatile: packed.volatile };
  if (q.cursor == null && q.revision === revision) return { ...meta, unchanged: true };
  const delta = typeof syncDeltaPage_ === 'function' ? syncDeltaPage_(q, rows, meta) : null;
  if (delta) return delta;
  return leadCacheSnapshotPage_(rows, q, meta);
}

function apiGetPortalReadCachePage(token, input) {
  _currentApiToken_ = token || '';
  return apiGuard_('apiGetPortalReadCachePage', () => {
    const user = _apiUser();
    try { return respond(portalReadCachePage_(user, input)); }
    catch (error) {
      const code = String(error.message || '').split(':')[0];
      if (['CACHE_SCOPE_CHANGED','CACHE_REVISION_CHANGED','CACHE_DISABLED'].includes(code)) return respond(null, code, code);
      throw error;
    }
  });
}
