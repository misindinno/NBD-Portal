// Complete, authorized business tables. No arbitrary sheet-name or range access.
// Arrays preserve column positions, empty/duplicate headers and duplicate rows.
function sheetMirrorDefinitions_() {
  return [
    ...((typeof arEnabled_ === 'function' && arEnabled_()) ? Object.keys(AR_TABLES_).map(name=>[name,['Archive'],'archive']) : []),
    ...((typeof dqEnabled_ === 'function' && dqEnabled_()) ? Object.keys(DQ_TABLES_).map(name=>[name,['Leads'],'disqualified']) : []),
    ['LEAD_MASTER', ['Leads','Followups','Pipeline','Archive'], 'leads'],
    ['FOLLOWUPS', ['Followups'], 'followups'],
    ['FOLLOWUP_HISTORY', ['Followups','Archive'], 'history'],
    ['LEAD_ACTIVITY_LOGS', ['Followups','Leads'], 'activity'],
    ['LEAD_FIELD_VALUES', ['Leads','Pipeline','Archive'], 'leadFields'],
    ['FOLLOWUP_FIELD_VALUES', ['Followups'], 'followupFields'],
    ['PIPELINE_STAGES', [], 'reference'],
    ['FIELD_CONFIG', [], 'reference'],
    ['CONFIG', [], 'reference'],
    ['Bulk_Config', ['BulkEntry'], 'reference'],
    ['CALL_LOGS', ['Leads','Followups'], 'calls'],
    ['VISIT_SUBMISSIONS', ['VisitManagement'], 'reference'],
    ['CLIENT_FACTORY_VISITS', ['ClientFactoryVisits'], 'visits'],
    ['CLIENT_FACTORY_VISIT_EVENTS', ['ClientFactoryVisits'], 'visitEvents']
  ].map(([name, modules, kind]) => ({ name, modules, kind }));
}
function sheetMirrorAllowed_(user, definition) {
  return user.role === 'ADMIN' || !definition.modules.length || definition.modules.some(module => userHasModule(user, module));
}
function sheetMirrorIdentity_(user) {
  const base = leadCacheIdentity_(user), workbook = String(SPREADSHEET_ID);
  return { ...base, workbook, timeZone: Session.getScriptTimeZone(), leadListAllowed: user.role === 'ADMIN' || userHasModule(user, 'Leads'),
    syncEnabled: true, enabled: base.modulesEnabled && PropertiesService.getScriptProperties().getProperty('PORTAL_SHEET_MIRROR_ENABLED') !== 'false',
    scope: leadCacheDigest_({ scope: base.scope, workbook, mirrorSchema: 2 }) };
}
function sheetMirrorContext_(user, query) {
  const identity = sheetMirrorIdentity_(user);
  if (!identity.enabled) throw new Error('CACHE_DISABLED');
  if (!query || query.portal !== identity.portal || query.workbook !== identity.workbook || query.user !== identity.user || query.scope !== identity.scope) throw new Error('CACHE_SCOPE_CHANGED');
  return identity;
}
function sheetMirrorManifest_(user, query) {
  const identity = sheetMirrorContext_(user, query);
  const existing = getSpreadsheet(SHEET_NAMES.LEADS).getSheets().map(sheet => sheet.getName());
  const definitions = sheetMirrorDefinitions_().filter(def => sheetMirrorAllowed_(user, def));
  return { identity, sheets: definitions.map(def => ({ name: def.name, exists: ['disqualified','archive'].includes(def.kind) || existing.includes(def.name) })),
    // Names only, and only for administrators. Never read unknown/internal tables.
    excluded: user.role === 'ADMIN' ? existing.filter(name => !definitions.some(def => def.name === name)) : [] };
}
function sheetMirrorReadTable_(name) {
  assertServerContext_();
  const sheet = getSpreadsheet(name).getSheetByName(name);
  if (!sheet) return { name, exists: false, sheetId: null, headers: [], rows: [] };
  const values = sheet.getLastRow() ? sheet.getDataRange().getValues() : [];
  const headers = (values[0] || []).map(value => String(value == null ? '' : value));
  return { name, exists: true, sheetId: sheet.getSheetId(), headers,
    rows: values.slice(1).map((cells, index) => ({ rowNumber: index + 2,
      cells: headers.map((_, col) => cells[col] == null ? '' : cells[col]) })) };
}
function sheetMirrorObject_(table, row) {
  // Business scope keys must be unambiguous; unknown duplicate columns remain
  // in the cell arrays, not silently collapsed into the stored schema.
  const record = Object.create(null);
  table.headers.forEach((key, i) => { if (key) record[key] = row.cells[i]; });
  return record;
}
function sheetMirrorRequireColumns_(table, names) {
  if (!table.exists || !table.rows.length) return;
  names.forEach(name => {
    if (table.headers.filter(header => header === name).length !== 1) throw new Error('Invalid sheet schema: ' + table.name + ' requires one ' + name + ' column.');
  });
}
function sheetMirrorScopedRows_(user, definition, table) {
  const admin = user.role === 'ADMIN';
  const rows = table.rows.map(row => ({ ...row, object: sheetMirrorObject_(table, row) }));
  const canArchive = admin || userHasModule(user, 'Archive');
  const tables = new Map([[table.name, table]]);
  const read = name => { if (!tables.has(name)) tables.set(name, sheetMirrorReadTable_(name)); return tables.get(name); };
  const objects = name => { const t = read(name); return t.rows.map(row => sheetMirrorObject_(t, row)); };
  const leads = () => {
    const t = read(SHEET_NAMES.LEADS); sheetMirrorRequireColumns_(t, ['Lead ID','Assigned To']);
    return objects(SHEET_NAMES.LEADS);
  };
  let allLeads, allowedLeads, leadIds;
  const leadScope = () => {
    if (!leadIds) {
      allLeads = leads();
      if (!admin) sheetMirrorUniqueIds_(allLeads, 'Lead ID');
      allowedLeads = _scopeAssignedRows(allLeads, user).filter(row => canArchive || !leadArchiveState_(row));
      leadIds = new Set(allowedLeads.map(row => String(row['Lead ID'] || '')).filter(Boolean));
    }
    return leadIds;
  };
  const linked = (items, actors) => {
    leadScope();
    const userMap = _hasGlobalRead(user) && !admin ? _buildUserMapById_() : {};
    const departments = _portalDepartmentScopeSet_();
    const leadMap = Object.fromEntries(allLeads.map(row => [row['Lead ID'], row]));
    return items.filter(row => {
      const lead = leadMap[row['Lead ID']];
      if (lead && !canArchive && leadArchiveState_(lead)) return false;
      if (admin) return true;
      return _hasGlobalRead(user) ? _linkedRowMatchesDepartmentScope_(row, actors, userMap, leadMap, departments)
        : leadIds.has(String(row['Lead ID'])) || actors.some(key => String(row[key] || '') === String(user.id));
    });
  };
  let allowed;
  switch (definition.kind) {
    case 'leads':
      sheetMirrorRequireColumns_(table, ['Lead ID','Assigned To']);
      allowed = new Set(_scopeAssignedRows(rows.map(row => row.object), user).filter(row => canArchive || !leadArchiveState_(row)));
      break;
    case 'followups': case 'history': case 'activity': {
      sheetMirrorRequireColumns_(table, ['Lead ID']);
      const actors = definition.kind === 'history' ? ['Done By'] : definition.kind === 'activity' ? ['Created By'] : ['Created By','Done By'];
      allowed = new Set(linked(rows.map(row => row.object), actors)); break;
    }
    case 'leadFields':
      sheetMirrorRequireColumns_(table, ['Lead ID']);
      allowed = new Set(rows.filter(row => admin || leadScope().has(String(row.object['Lead ID']))).map(row => row.object)); break;
    case 'followupFields': {
      sheetMirrorRequireColumns_(table, ['Follow-up ID']);
      const followups = read(SHEET_NAMES.FOLLOWUPS); sheetMirrorRequireColumns_(followups, ['Follow-up ID','Lead ID']);
      if (!admin) sheetMirrorUniqueIds_(objects(SHEET_NAMES.FOLLOWUPS), 'Follow-up ID');
      const ids = new Set(linked(objects(SHEET_NAMES.FOLLOWUPS), ['Created By','Done By']).map(row => String(row['Follow-up ID'])));
      allowed = new Set(rows.filter(row => admin || ids.has(String(row.object['Follow-up ID']))).map(row => row.object)); break;
    }
    case 'calls':
      sheetMirrorRequireColumns_(table, ['Call ID','Lead ID']);
      allowed = new Set(rows.filter(row => _callVisible_(row.object, user, leadScope())).map(row => row.object)); break;
    case 'visits': case 'visitEvents': {
      const visits = read('CLIENT_FACTORY_VISITS'); sheetMirrorRequireColumns_(visits, ['Visit ID','Portal ID','Host ID','Created By']);
      if (!admin) sheetMirrorUniqueIds_(objects('CLIENT_FACTORY_VISITS'), 'Visit ID');
      const directory = admin ? [] : _cfvDirectory_();
      if (definition.kind === 'visits') allowed = new Set(rows.filter(row => _cfvCanRead_(row.object, user, directory)).map(row => row.object));
      else {
        sheetMirrorRequireColumns_(table, ['Visit ID']);
        const ids = new Set(objects('CLIENT_FACTORY_VISITS').filter(row => _cfvCanRead_(row, user, directory)).map(row => String(row['Visit ID'])));
        allowed = new Set(rows.filter(row => ids.has(String(row.object['Visit ID']))).map(row => row.object));
      }
      break;
    }
    default: allowed = new Set(rows.map(row => row.object));
  }
  return rows.filter(row => allowed.has(row.object));
}
function sheetMirrorUniqueIds_(rows, key) {
  const ids = new Set();
  rows.forEach(row => {
    const id = String(row[key] || '');
    if (id && ids.has(id)) throw new Error('Ambiguous ' + key + '. Repair duplicate source IDs before syncing linked records.');
    if (id) ids.add(id);
  });
}
function sheetMirrorRecords_(user, definition) {
  const table = definition.kind === 'archive' ? arMirrorTable_(definition.name,user) : definition.kind === 'disqualified' ? dqMirrorTable_(definition.name,user) : sheetMirrorReadTable_(definition.name);
  const sensitive = /password|passwd|secret|token|credential|authorization|cookie|session|api[ _-]?key|__proto__|constructor|prototype/i;
  const redactedColumns = table.headers.map((name, index) => sensitive.test(name) ? index : -1).filter(index => index >= 0);
  const rows = (['disqualified','archive'].includes(definition.kind) ? table.rows : sheetMirrorScopedRows_(user, definition, table)).filter(row => {
    if (['leadFields','followupFields'].includes(definition.kind) && sensitive.test(String(row.object['Column Key'] || ''))) return false;
    // CONFIG is key/value-shaped: sensitive config types must not export values.
    return definition.name !== 'CONFIG' || !sensitive.test(String(row.object['Config Type'] || ''));
  }).map(row => {
    const dates = [];
    const cells = row.cells.map((value, index) => {
      if (redactedColumns.includes(index)) return null;
      if (value instanceof Date) { dates.push(index); return value.toISOString(); }
      if (!['string','number','boolean'].includes(typeof value) || typeof value === 'number' && !Number.isFinite(value)) throw new Error('Unsupported cell value in ' + table.name);
      return value;
    });
    return { bucket: 'rows', index: row.rowNumber, value: { cells, dates } };
  });
  return [{ bucket: '_meta', index: 0, value: { name: table.name, exists: table.exists, sheetId: table.sheetId,
    headers: table.headers, redactedColumns, rowCount: rows.length, dateEncoding: 'iso8601', schemaVersion: 1 } }, ...rows];
}
function sheetMirrorPage_(user, query) {
  const identity = sheetMirrorContext_(user, query);
  const definition = sheetMirrorDefinitions_().find(def => def.name === query.sheet);
  if (!definition || !sheetMirrorAllowed_(user, definition)) throw new Error('Permission denied. This sheet is not available for your account.');
  const rows = sheetMirrorRecords_(user, definition);
  const meta = { identity, total: rows.length, revision: leadCacheContentDigest_(identity.scope, rows, true), hashFormat: 'canonical-v1', verifiedAt: new Date().toISOString() };
  if (query.cursor == null && query.revision === meta.revision) return { ...meta, unchanged: true };
  const delta = syncDeltaPage_({ ...query, canonicalHashes: true }, rows, meta);
  return delta || leadCacheSnapshotPage_(rows, { ...query, snapshotBatch: true }, meta);
}
function apiGetSheetMirrorManifest(token, query) {
  _currentApiToken_ = token || '';
  return apiGuard_('apiGetSheetMirrorManifest', () => {
    try { return respond(sheetMirrorManifest_(_apiUser(), query)); }
    catch (error) {
      const code = String(error.message || '').split(':')[0];
      if (['CACHE_SCOPE_CHANGED','CACHE_DISABLED'].includes(code)) return respond(null, code, code);
      throw error;
    }
  });
}
function apiGetSheetMirrorPage(token, query) {
  _currentApiToken_ = token || '';
  return apiGuard_('apiGetSheetMirrorPage', () => {
    try {
      const page = sheetMirrorPage_(_apiUser(), query);
      // Preserve the exact hashed JSON through google.script.run, including
      // nested arrays, null metadata and literal cell text. Older tabs retain
      // their object response until they reload.
      return respond(query && query.wireFormat === 'json-v1' ? JSON.stringify(page) : page);
    }
    catch (error) {
      const code = String(error.message || '').split(':')[0];
      if (['CACHE_SCOPE_CHANGED','CACHE_REVISION_CHANGED','CACHE_DISABLED'].includes(code)) return respond(null, code, code);
      throw error;
    }
  });
}
