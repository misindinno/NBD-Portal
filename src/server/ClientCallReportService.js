// Read-only, current-workbook report. Do not use merged Callyzer projections,
// custom/product row joins, or cross-portal source IDs as customer aliases.
function _clientCallReportDay_(value) {
  if (value instanceof Date) return isNaN(value.getTime()) ? '' : Utilities.formatDate(value, 'Asia/Kolkata', 'yyyy-MM-dd');
  const text = String(value == null ? '' : value).trim();
  const match = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?)?$/.exec(text);
  if (!match) return '';
  const day = new Date(match[1] + 'T00:00:00Z');
  if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== match[1]) return '';
  if (match[2] && (+match[2] > 23 || +match[3] > 59 || +(match[4] || 0) > 59)) return '';
  if (match[5]) {
    const instant = new Date(text.replace(' ', 'T'));
    return isNaN(instant.getTime()) ? '' : Utilities.formatDate(instant, 'Asia/Kolkata', 'yyyy-MM-dd');
  }
  // Sheet date-only and timezone-less completion values are already local IST.
  return match[1];
}

function _clientCallReportQuery_(input) {
  const q = input || {};
  const result = {};
  ['from', 'to'].forEach(key => {
    result[key] = String(q[key] || '');
    if (result[key] && (!/^\d{4}-\d{2}-\d{2}$/.test(result[key]) || !_clientCallReportDay_(result[key]))) throw new Error('Invalid date range. Enter dates as YYYY-MM-DD.');
  });
  if (result.from && result.to && result.from > result.to) throw new Error('From date must be on or before To date.');
  result.archive = String(q.archive || 'active');
  result.status = String(q.status || '');
  if (!['active', 'archived', 'all'].includes(result.archive) || !['', 'Open', 'Won', 'Lost', 'Disqualified'].includes(result.status)) throw new Error('Invalid report filter.');
  ['category', 'doneBy', 'search'].forEach(key => result[key] = String(q[key] || '').trim().slice(0, 200));
  result.page = Math.max(1, Math.floor(Number(q.page) || 1));
  if (!Number.isFinite(result.page)) result.page = 1;
  return result;
}

function _clientCallReport_(user, input) {
  assertServerContext_();
  const q = _clientCallReportQuery_(input);
  const canArchive = user.role === 'ADMIN' || userHasModule(user, 'Archive');
  if (q.archive !== 'active' && !canArchive) throw new Error('Permission denied. Archive permission is required.');
  // Read the three report tables together. Keep the full schema and the existing
  // quota-aware fallback; staff/permission data still uses its separate workbook.
  const previousReadMode = _bootstrapReadMode_;
  let tables;
  _bootstrapReadMode_ = true;
  try {
    tables = sheetApiBatchGetRows_([SHEET_NAMES.LEADS, SHEET_NAMES.FOLLOWUP_HISTORY, SHEET_NAMES.STAGES]);
  } finally { _bootstrapReadMode_ = previousReadMode; }
  const master = tables[SHEET_NAMES.LEADS];
  const history = tables[SHEET_NAMES.FOLLOWUP_HISTORY];
  const users = _buildUserMapById_();
  const departments = _portalDepartmentScopeSet_();
  const stages = new Map(tables[SHEET_NAMES.STAGES].map(row => [String(row['Stage ID']), row]));
  const id = value => String(value == null ? '' : value).trim();
  const leads = new Map(), ambiguous = new Set();
  // A duplicate expansion of the same master row is harmless. Conflicting IDs
  // are excluded rather than attributing a call to an arbitrary customer.
  master.forEach(lead => {
    const key = id(lead['Lead ID']);
    if (!key) return;
    const signature = JSON.stringify(['Company Name', 'Assigned To', 'Category', 'Stage ID', 'Lead Status', 'Pre-Archive Status', 'Is Archived', 'Archived At'].map(field => lead[field] || ''));
    if (leads.has(key) && leads.get(key).signature !== signature) ambiguous.add(key);
    else leads.set(key, { lead, signature });
  });
  ambiguous.forEach(key => leads.delete(key));
  const visible = new Map();
  leads.forEach(({ lead }, key) => {
    const allowed = user.role === 'ADMIN' || (_hasGlobalRead(user)
      ? _rowMatchesDepartmentScope_(lead, users, departments)
      : id(lead['Assigned To']) === id(user.id));
    if (allowed && (canArchive || !leadArchiveState_(lead))) visible.set(key, lead);
  });
  const categories = [...new Set([...visible.values()].map(lead => id(lead.Category)).filter(Boolean))].sort();
  const rows = new Map();
  visible.forEach((lead, leadId) => {
    const archived = leadArchiveState_(lead);
    const lifecycleLead = archived && lead['Pre-Archive Status'] ? { ...lead, 'Lead Status': lead['Pre-Archive Status'] } : lead;
    const status = leadLifecycleStatus_(lifecycleLead, stages.get(id(lead['Stage ID'])));
    if ((q.archive === 'active' && archived) || (q.archive === 'archived' && !archived)) return;
    if (q.category && id(lead.Category) !== q.category || q.status && status !== q.status) return;
    if (q.search && ![leadId, lead['Company Name']].join(' ').toLowerCase().includes(q.search.toLowerCase())) return;
    rows.set(leadId, { leadId, company: id(lead['Company Name']), category: id(lead.Category), status, archived, connected: 0, notPicked: 0, whatsapp: 0, totalCalls: 0 });
  });
  const modes = new Map([['Call Connected', 'connected'], ['Not Picked', 'notPicked'], ['WhatsApp Chat', 'whatsapp']]);
  const events = new Map(), conflicts = new Set(), selectedConflicts = new Set();
  let missingIds = 0, invalidDates = 0;
  history.forEach(event => {
    // Detect conflicting identities before filtering so changing a category,
    // date or user filter cannot turn an ambiguous ID into a counted call.
    const leadId = id(event['Lead ID']);
    const historyId = id(event['History ID']);
    if (!historyId) { if (rows.has(leadId)) missingIds++; return; }
    const signature = JSON.stringify([leadId, event['Contact Mode'], event['Done Date'], event['Done By']]);
    if (events.has(historyId) && events.get(historyId).signature !== signature) conflicts.add(historyId);
    else events.set(historyId, { event, signature });
  });
  history.forEach(event => {
    if (rows.has(id(event['Lead ID'])) && conflicts.has(id(event['History ID']))) selectedConflicts.add(id(event['History ID']));
  });
  const actors = new Set();
  events.forEach(({ event }, historyId) => {
    // Intersection with lead visibility prevents history actors/exports from
    // disclosing customers outside the user's current record scope.
    if (conflicts.has(historyId) || !rows.has(id(event['Lead ID']))) return;
    const mode = modes.get(event['Contact Mode']);
    if (!mode) return; // Exact stored contact mode, never infer from outcome/type.
    const day = _clientCallReportDay_(event['Done Date']);
    if (!day) { invalidDates++; return; }
    const actor = id(event['Done By']);
    if (actor) actors.add(actor);
    if (q.doneBy && actor !== q.doneBy || q.from && day < q.from || q.to && day > q.to) return;
    rows.get(id(event['Lead ID']))[mode]++;
  });
  const items = [...rows.values()].sort((a, b) => a.company.localeCompare(b.company) || a.leadId.localeCompare(b.leadId));
  const totals = { connected: 0, notPicked: 0, whatsapp: 0, totalCalls: 0 };
  items.forEach(row => {
    row.totalCalls = row.connected + row.notPicked;
    Object.keys(totals).forEach(key => totals[key] += row[key]);
  });
  return {
    items, totals, filters: q, canArchive, categories,
    users: [...actors].sort().map(actor => ({ id: actor, name: users[actor] && users[actor].Name || actor })),
    excluded: { missingIds, conflictingIds: selectedConflicts.size, invalidDates },
    timezone: 'Asia/Kolkata', dateBasis: 'Done Date'
  };
}

function _clientCallReportCsv_(report) {
  const escape = value => {
    let text = String(value == null ? '' : value);
    if (/^[\s\u0000-\u001f]*[=+@-]/.test(text)) text = "'" + text;
    return '"' + text.replace(/"/g, '""') + '"';
  };
  const columns = ['Lead ID', 'Company', 'Category', 'Current status', 'Archived', 'Call Connected', 'Not Picked', 'Total calls', 'WhatsApp Chat'];
  const rows = report.items.map(row => [row.leadId, row.company, row.category, row.status, row.archived ? 'Yes' : 'No', row.connected, row.notPicked, row.totalCalls, row.whatsapp]);
  rows.push(['TOTAL', '', '', '', '', report.totals.connected, report.totals.notPicked, report.totals.totalCalls, report.totals.whatsapp]);
  return [columns, ...rows].map(row => row.map(escape).join(',')).join('\r\n');
}
