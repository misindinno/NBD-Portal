// Stateless, revision-bound deltas. Comparing with the authoritative source also
// catches manual deletes, imports, formulas and integrations that bypass triggers.
// Client manifests contain IDs and hashes, never trusted row data or permissions.
function syncRecordKey_(row) {
  return row.bucket !== undefined ? JSON.stringify([row.bucket, row.index]) : String(row['Lead ID']);
}
function syncDeltaPage_(query, rows, meta) {
  if (!meta.identity.syncEnabled || query.delta !== true) return null;
  const manifest = query.manifest;
  if (!Array.isArray(manifest) || manifest.length > 10000 || JSON.stringify(manifest).length > 1200000) throw new Error('Invalid sync manifest.');
  const known = new Map();
  manifest.forEach(pair => {
    if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string' || pair[0].length > 300 ||
        !/^[a-f0-9]{64}$/.test(pair[1]) || known.has(pair[0])) throw new Error('Invalid sync manifest entry.');
    known.set(pair[0], pair[1]);
  });
  const manifestRevision = leadCacheDigest_(manifest), changes = [], current = new Set();
  rows.forEach(row => {
    const key = syncRecordKey_(row);
    if (current.has(key)) throw new Error('Duplicate sync record key.');
    current.add(key);
    if (known.get(key) !== leadCacheDigest_({ scope: '', rows: [row] })) changes.push({ key, value: row });
  });
  known.forEach((_, key) => { if (!current.has(key)) changes.push({ key, removed: true }); });
  let offset = 0;
  if (query.cursor != null) {
    const cursor = String(query.cursor).split(':');
    if (cursor.length !== 3 || cursor[0] !== 'delta' || cursor[2] !== manifestRevision || query.revision !== meta.revision || !/^\d+$/.test(cursor[1])) throw new Error('CACHE_REVISION_CHANGED');
    offset = Number(cursor[1]);
    if (!Number.isSafeInteger(offset) || offset <= 0 || offset >= changes.length || offset % 100 !== 0) throw new Error('Invalid sync cursor.');
  }
  return { ...meta, delta: true, offset, changes: changes.slice(offset, offset + 100), changeTotal: changes.length,
    nextCursor: offset + 100 < changes.length ? 'delta:' + (offset + 100) + ':' + manifestRevision : null };
}
