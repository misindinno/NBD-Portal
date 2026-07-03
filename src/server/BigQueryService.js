// ── BigQueryService.js ──────────────────────────────────────────────────────
// Benchmark-phase BigQuery integration. Only works on the portal whose Apps Script
// is linked to the standard GCP project 'nbd-portal' (BigQuery API enabled). Uses
// native tables + batch loads (no streaming) so it runs on the BigQuery Sandbox.
//
// Flow: bqSeedOnce() loads the current sheet data into native tables once, then
// bqBenchmark() times each page's current Sheets read vs the equivalent BigQuery
// query so we can compare per-page load time before committing to BigQuery.

function _bqCfg_() {
  var c = (typeof CLIENT_CONFIG !== 'undefined' && CLIENT_CONFIG) || {};
  var portal = c.BQ_PORTAL || String(c.APP_TITLE || 'portal').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return {
    projectId: c.BQ_PROJECT_ID || 'nbd-portal',
    dataset:   c.BQ_DATASET    || 'nbd_portal',
    location:  c.BQ_LOCATION   || 'asia-south1',
    portal:    portal || 'portal'
  };
}

function _bqReady_() {
  try { return typeof BigQuery !== 'undefined' && !!BigQuery && !!BigQuery.Jobs; } catch (e) { return false; }
}

function _bqTableRef_(tableId) {
  var cfg = _bqCfg_();
  return '`' + cfg.projectId + '.' + cfg.dataset + '.' + tableId + '`';
}

// BigQuery column names allow only letters/digits/underscore and must start with a
// letter or underscore. Sheet headers ("Lead ID") are sanitised ("Lead_ID").
function _bqSafeCol_(h) {
  var s = String(h || '').replace(/[^A-Za-z0-9_]/g, '_');
  if (!/^[A-Za-z_]/.test(s)) s = '_' + s;
  return s || '_col';
}

function bqEnsureDataset_() {
  var cfg = _bqCfg_();
  try {
    BigQuery.Datasets.insert(
      { datasetReference: { projectId: cfg.projectId, datasetId: cfg.dataset }, location: cfg.location },
      cfg.projectId
    );
  } catch (e) {
    if (!/already exists|duplicate|Already Exists|409/i.test(String(e && e.message || e))) throw e;
  }
}

// Loads all rows of a sheet into a native BQ table (WRITE_TRUNCATE). Every column is
// STRING for the benchmark; adds portal + _synced_at. Returns a small summary.
function _bqLoadTable_(tableId, sheetName) {
  var cfg = _bqCfg_();
  var t0 = Date.now();
  var rows = getAllRows(sheetName) || [];

  var colSet = {};
  rows.forEach(function (r) {
    Object.keys(r).forEach(function (k) { if (k && k.charAt(0) !== '_') colSet[k] = true; });
  });
  var headers = Object.keys(colSet);
  var seen = {}, headerMap = {};
  headers.forEach(function (h) { var s = _bqSafeCol_(h); while (seen[s]) s += '_'; seen[s] = 1; headerMap[h] = s; });

  var schema = { fields: [{ name: 'portal', type: 'STRING' }, { name: '_synced_at', type: 'STRING' }]
    .concat(headers.map(function (h) { return { name: headerMap[h], type: 'STRING' }; })) };
  var dest = { projectId: cfg.projectId, datasetId: cfg.dataset, tableId: tableId };

  if (!rows.length) {
    try { BigQuery.Tables.insert({ tableReference: dest, schema: schema }, cfg.projectId, cfg.dataset); }
    catch (e) { if (!/already exists/i.test(String(e && e.message || e))) throw e; }
    return { table: tableId, rows: 0, cols: headers.length, ms: Date.now() - t0 };
  }

  var syncedAt = now();
  var ndjson = rows.map(function (r) {
    var o = { portal: cfg.portal, _synced_at: syncedAt };
    headers.forEach(function (h) { var v = r[h]; o[headerMap[h]] = (v === undefined || v === null) ? '' : String(v); });
    return JSON.stringify(o);
  }).join('\n');

  var job = {
    configuration: {
      load: {
        destinationTable: dest,
        schema: schema,
        sourceFormat: 'NEWLINE_DELIMITED_JSON',
        writeDisposition: 'WRITE_TRUNCATE',
        createDisposition: 'CREATE_IF_NEEDED',
        ignoreUnknownValues: true
      }
    }
  };
  var res = BigQuery.Jobs.insert(job, cfg.projectId, Utilities.newBlob(ndjson, 'application/octet-stream'));
  var jobId = res.jobReference.jobId;
  var status = res.status, guard = 0;
  while ((!status || status.state !== 'DONE') && guard < 120) {
    Utilities.sleep(1000);
    res = BigQuery.Jobs.get(cfg.projectId, jobId, { location: cfg.location });
    status = res.status; guard++;
  }
  if (status && status.errorResult) throw new Error('BQ load failed for ' + tableId + ': ' + status.errorResult.message);
  return { table: tableId, rows: rows.length, cols: headers.length, ms: Date.now() - t0 };
}

// One-time seed of the analytical tables into BigQuery.
function bqSeedOnce() {
  if (!_bqReady_()) throw new Error('BigQuery advanced service not enabled. Add it in appsscript.json and enable the BigQuery API.');
  bqEnsureDataset_();
  return withServerContext_(function () {
    return [
      _bqLoadTable_('leads',            SHEET_NAMES.LEADS),
      _bqLoadTable_('followups',        SHEET_NAMES.FOLLOWUPS),
      _bqLoadTable_('followup_history', SHEET_NAMES.FOLLOWUP_HISTORY),
      _bqLoadTable_('activity_logs',    SHEET_NAMES.LEAD_ACTIVITY_LOGS)
    ];
  });
}

function _bqRowsToObjects_(fields, rows) {
  fields = fields || [];
  return (rows || []).map(function (r) {
    var obj = {};
    (r.f || []).forEach(function (cell, i) { obj[fields[i] ? fields[i].name : ('c' + i)] = cell ? cell.v : null; });
    return obj;
  });
}

// Runs a standard-SQL query; returns { rows, ms, totalRows }.
function bqQuery(sql) {
  var cfg = _bqCfg_();
  var t0 = Date.now();
  var res = BigQuery.Jobs.query({ query: sql, useLegacySql: false, location: cfg.location, timeoutMs: 30000 }, cfg.projectId);
  var jobId = res.jobReference && res.jobReference.jobId;
  var fields = (res.schema && res.schema.fields) || [];
  var rows = res.rows || [];
  var guard = 0;
  while (!res.jobComplete && guard < 30) {
    Utilities.sleep(1000);
    res = BigQuery.Jobs.getQueryResults(cfg.projectId, jobId, { location: cfg.location });
    if (res.schema) fields = res.schema.fields;
    rows = res.rows || rows;
    guard++;
  }
  var pt = res.pageToken;
  while (pt) {
    res = BigQuery.Jobs.getQueryResults(cfg.projectId, jobId, { location: cfg.location, pageToken: pt });
    rows = rows.concat(res.rows || []);
    pt = res.pageToken;
  }
  return { rows: _bqRowsToObjects_(fields, rows), ms: Date.now() - t0, totalRows: Number(res.totalRows || 0) };
}

// Times the current Sheets path vs the BigQuery query for each page.
function _bqBench_(label, sheetFn, bqFn) {
  var r = { page: label };
  try { var s = sheetFn(); r.sheetMs = s.ms; r.sheetRows = s.rows; } catch (e) { r.sheetErr = String(e && e.message || e); }
  try { var b = bqFn(); r.bqMs = b.ms; r.bqRows = b.rows; } catch (e) { r.bqErr = String(e && e.message || e); }
  return r;
}

function bqBenchmark() {
  if (!_bqReady_()) throw new Error('BigQuery advanced service not enabled for this deployment.');
  return withServerContext_(_bqBenchmarkInner_);
}

function _bqBenchmarkInner_() {
  var cfg = _bqCfg_();
  var where = ' WHERE portal = "' + cfg.portal + '"';
  var out = [];

  out.push(_bqBench_('Leads',
    function () { var t = Date.now(); var n = getLeads().length; return { ms: Date.now() - t, rows: n }; },
    function () { var q = bqQuery('SELECT * FROM ' + _bqTableRef_('leads') + where); return { ms: q.ms, rows: q.rows.length }; }
  ));

  out.push(_bqBench_('Follow-ups',
    function () { var t = Date.now(); var n = getFollowups({}).length; return { ms: Date.now() - t, rows: n }; },
    function () { var q = bqQuery('SELECT * FROM ' + _bqTableRef_('followups') + where); return { ms: q.ms, rows: q.rows.length }; }
  ));

  out.push(_bqBench_('Follow-up history',
    function () { var t = Date.now(); var n = (_followupHistoryRows() || []).length; return { ms: Date.now() - t, rows: n }; },
    function () { var q = bqQuery('SELECT * FROM ' + _bqTableRef_('followup_history') + where); return { ms: q.ms, rows: q.rows.length }; }
  ));

  out.push(_bqBench_('Archive suggestions (aggregation)',
    function () {
      var t = Date.now();
      var rows = _followupHistoryRows() || [];
      var m = {};
      rows.forEach(function (r) { if (String(r['Contact Mode'] || '') === 'Call Connected') { var id = r['Lead ID']; m[id] = (m[id] || 0) + 1; } });
      var n = Object.keys(m).filter(function (k) { return m[k] >= 7; }).length;
      return { ms: Date.now() - t, rows: n };
    },
    function () {
      var q = bqQuery(
        'SELECT Lead_ID, COUNT(1) c FROM ' + _bqTableRef_('followup_history') +
        where + ' AND Contact_Mode = "Call Connected" GROUP BY Lead_ID HAVING c >= 7'
      );
      return { ms: q.ms, rows: q.rows.length };
    }
  ));

  return out;
}

// ── Menu wrappers (run from the spreadsheet menu) ────────────────────────────────
function bqSeedFromMenu() {
  var ui = SpreadsheetApp.getUi();
  try {
    var s = bqSeedOnce();
    ui.alert('BigQuery seed complete',
      s.map(function (r) { return r.table + ': ' + r.rows + ' rows, ' + r.cols + ' cols (' + r.ms + ' ms)'; }).join('\n'),
      ui.ButtonSet.OK);
  } catch (e) { ui.alert('BigQuery seed failed', String(e && e.message || e), ui.ButtonSet.OK); }
}

function bqBenchmarkFromMenu() {
  var ui = SpreadsheetApp.getUi();
  try {
    var b = bqBenchmark();
    var lines = b.map(function (r) {
      var sheet = (r.sheetErr ? 'ERR ' + r.sheetErr : (r.sheetMs + ' ms / ' + r.sheetRows + ' rows'));
      var bq = (r.bqErr ? 'ERR ' + r.bqErr : (r.bqMs + ' ms / ' + r.bqRows + ' rows'));
      return r.page + '\n   Sheets:   ' + sheet + '\n   BigQuery: ' + bq;
    });
    ui.alert('Per-page speed: Sheets vs BigQuery', lines.join('\n\n'), ui.ButtonSet.OK);
  } catch (e) { ui.alert('Benchmark failed', String(e && e.message || e), ui.ButtonSet.OK); }
}
