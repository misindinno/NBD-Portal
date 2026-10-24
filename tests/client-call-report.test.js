'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const lead = (id = '001', extra = {}) => ({ 'Lead ID': id, 'Company Name': 'Same company', 'Assigned To': 'sales1', Category: 'Dealer', 'Lead Status': 'Open', ...extra });
const event = (id = 'h1', extra = {}) => ({ 'History ID': id, 'Lead ID': '001', 'Done Date': '2026-10-24', 'Done By': 'sales1', 'Contact Mode': 'Call Connected', ...extra });
const admin = { id: 'admin', role: 'ADMIN', modules: [] };

function setup(options = {}) {
  const rows = {
    LEADS: options.leads || [lead()], HISTORY: options.history || [event()],
    USERS: [{ ID: 'sales1', Name: 'Sales One', Department: 'Sales' }, { ID: 'sales2', Name: 'Sales Two', Department: 'Other' }],
    STAGES: [{ 'Stage ID': 'won', 'Stage Outcome': 'Won' }]
  };
  Object.values(rows).forEach(list => { list.forEach(Object.freeze); Object.freeze(list); });
  const reads = [];
  let serverDepth = 0;
  const context = vm.createContext({
    Date, console, TEST_USER: options.user || admin,
    SHEET_NAMES: { LEADS: 'LEADS', FOLLOWUP_HISTORY: 'HISTORY', USERS: 'USERS', STAGES: 'STAGES' },
    Utilities: { getUuid: () => 'request-id', formatDate(date, zone) {
      assert.equal(zone, 'Asia/Kolkata');
      return new Date(date.getTime() + 330 * 60000).toISOString().slice(0, 10);
    } },
    withServerContext_(fn) { serverDepth++; try { return fn(); } finally { serverDepth--; } },
    assertServerContext_() { assert.ok(serverDepth > 0, 'Server context required'); },
    getAllRows(name) { assert.ok(serverDepth > 0); assert.ok(rows[name], 'Unexpected storage access: ' + name); reads.push(name); return rows[name]; },
    getPortalSettings_: () => ({ visibleDepartments: options.departments || [] }),
    getStaffUserId: row => row.ID,
    userHasModule: (user, name) => (user.modules || []).includes(name),
    respond: (data, error) => ({ success: !error, data, error }),
    safeClientErrorMessage_: error => error.message,
    logServerError_() {},
    // Reporting must never trigger setup, index repair, external calls or mutations.
    safeInitHeaders() { assert.fail('Unexpected setup write'); },
    rebuildIndexForSheet_() { assert.fail('Unexpected index repair'); },
    _mergeCallHistory_() { assert.fail('Unexpected call-log projection'); }
  });
  ['src/server/ArchitectureCore.js', 'src/server/Api.js', 'src/server/ClientCallReportService.js'].forEach(file => vm.runInContext(read(file), context, { filename: file }));
  context.logServerError_ = () => {}; // Expected authorization/validation failures.
  vm.runInContext(`_apiUser = function () { if (_currentApiToken_ !== 'valid') throw new Error('SESSION_EXPIRED'); return TEST_USER; };`, context);
  const report = query => {
    const result = context.apiGetClientCallReport('valid', query || {});
    assert.equal(result.success, true, result.error);
    return plain(result.data);
  };
  return { context, rows, reads, report };
}

test('exact modes: duplicate history rows count once; repeated calls and WhatsApp remain distinct', () => {
  const { report } = setup({ leads: [lead(), lead()], history: [event(), event(), event('h2'), event('h3', { 'Contact Mode': 'Not Picked' }), event('h4', { 'Contact Mode': 'WhatsApp Chat' }), event('h5', { 'Contact Mode': 'call connected' }), event('h6', { 'Contact Mode': 'Call Connected ' }), event('h7', { 'Contact Mode': 'toString' }), event('h8', { 'Contact Mode': '', Outcome: 'Connected', 'Follow-up Type': 'Call' })] });
  const result = report();
  assert.equal(result.total, 1);
  assert.deepEqual(result.totals, { connected: 2, notPicked: 1, whatsapp: 1, totalCalls: 3 });
});

test('stable IDs preserve leading zeroes and never merge company names or source/client aliases', () => {
  const { report } = setup({ leads: [lead('001', { 'Source Lead ID': 'old', 'Client ID': 'shared' }), lead('1', { 'Client ID': 'shared' })], history: [event(), event('h2', { 'Lead ID': '1', 'Contact Mode': 'Not Picked' }), event('h3', { 'Lead ID': 'old' }), event('h4', { 'Lead ID': 'shared' }), event('h5', { 'Lead ID': '', 'Client ID': '001' })] });
  const result = report();
  assert.deepEqual(result.items.map(row => [row.leadId, row.connected, row.notPicked]), [['001', 1, 0], ['1', 0, 1]]);
});

test('conflicting duplicate IDs are excluded even when another customer is filtered out', () => {
  const { report } = setup({ leads: [lead(), lead('other', { Category: 'Distributor' })], history: [event(), event('h1', { 'Lead ID': 'other', 'Contact Mode': 'Not Picked' })] });
  const result = report({ category: 'Dealer' });
  assert.equal(result.totals.totalCalls, 0);
  assert.equal(result.excluded.conflictingIds, 1);
});

test('conflicting master IDs are never attributed arbitrarily', () => {
  const { report } = setup({ leads: [lead(), lead('001', { 'Company Name': 'Different customer' })] });
  assert.equal(report().total, 0);
});

test('zero-history customers and empty filter results have explicit zero totals', () => {
  const { report } = setup({ history: [] });
  assert.equal(report().items[0].totalCalls, 0);
  const empty = report({ search: 'does not exist' });
  assert.equal(empty.total, 0);
  assert.deepEqual(empty.totals, { connected: 0, notPicked: 0, whatsapp: 0, totalCalls: 0 });
  assert.equal(empty.page, 1);
});

test('completion-day filters are inclusive in IST, not creation/planned dates', () => {
  const { report } = setup({ history: [
    event('before', { 'Done Date': '2026-10-23T18:29:59Z' }),
    event('start', { 'Done Date': '2026-10-23T18:30:00Z' }),
    event('end', { 'Done Date': '2026-10-24T18:29:59Z' }),
    event('after', { 'Done Date': '2026-10-24T18:30:00Z' }),
    event('local', { 'Done Date': '2026-10-24 23:59:59' }),
    event('date', { 'Done Date': new Date('2026-10-23T18:30:00Z') }),
    event('offset', { 'Done Date': '2026-10-24T00:00:00+05:30' }),
    event('old', { 'Done Date': '2026-10-22', 'Created At': '2026-10-24', 'Planned Date': '2026-10-24' }),
    event('missing', { 'Done Date': '', 'Created At': '2026-10-24' }),
    event('invalid', { 'Done Date': '2026-02-30' })
  ] });
  const result = report({ from: '2026-10-24', to: '2026-10-24' });
  assert.equal(result.totals.connected, 5);
  assert.equal(result.excluded.invalidDates, 2);
  assert.equal(report({ from: '2026-10-25' }).totals.connected, 1);
  assert.equal(report({ to: '2026-10-22' }).totals.connected, 1);
});

test('invalid dates, reversed ranges and unsupported filters fail without reading Sheets', () => {
  const { context, reads } = setup();
  for (const query of [{ from: '2026-02-30' }, { from: '2026-10-25', to: '2026-10-24' }, { from: '24/10/2026' }, { archive: 'deleted' }, { status: 'anything' }]) {
    assert.equal(context.apiGetClientCallReport('valid', query).success, false);
  }
  assert.equal(reads.length, 0);
  for (const value of ['2026-10-24 24:00', '2026-10-24 12:60', '2026-10-24 12:30:60', 'nonsense']) assert.equal(context._clientCallReportDay_(value), '');
});

test('category, current lifecycle, archive and completion-user filters compose', () => {
  const { report } = setup({ leads: [lead(), lead('won', { Category: 'Distributor', 'Stage ID': 'won' }), lead('archived', { 'Lead Status': 'Archived', 'Pre-Archive Status': 'Lost', 'Is Archived': true })], history: [event(), event('h2', { 'Lead ID': 'won', 'Done By': 'sales2' }), event('h3', { 'Lead ID': 'archived' }), event('h4', { 'Done By': 'sales2', 'Contact Mode': 'Not Picked' })] });
  assert.equal(report().total, 2);
  assert.equal(report({ category: 'Distributor', status: 'Won', doneBy: 'sales2' }).totals.connected, 1);
  assert.equal(report({ category: 'Dealer', doneBy: 'sales2' }).totals.notPicked, 1);
  assert.equal(report({ archive: 'archived', status: 'Lost' }).totals.connected, 1);
  assert.equal(report({ archive: 'all', doneBy: 'unknown' }).totals.totalCalls, 0);
});

test('report and export require a current authenticated Reports grant before any reads', () => {
  const { context, reads } = setup({ user: { id: 'sales1', role: 'SALES', modules: ['Leads', 'Followups'] } });
  for (const name of ['apiGetClientCallReport', 'apiExportClientCallReport']) {
    assert.equal(context[name]('', {}).success, false);
    assert.equal(context[name]('valid', {}).success, false);
  }
  assert.equal(reads.length, 0);
  context.TEST_USER = { id: 'sales1', role: 'SALES', modules: ['Reports'] };
  assert.equal(context.apiGetClientCallReport('valid', {}).success, true);
  context.TEST_USER = { id: 'sales1', role: 'SALES', modules: [] };
  assert.equal(context.apiExportClientCallReport('valid', {}).success, false);
});

test('sales scopes cannot be widened by history actor, spoofed filters or CSV export', () => {
  const { report, context } = setup({ user: { id: 'sales1', role: 'SALES', modules: ['Reports'] }, leads: [lead(), lead('private', { 'Company Name': 'Secret company', 'Assigned To': 'sales2', Category: 'Private' }), lead('archived', { 'Is Archived': true })], history: [event(), event('h2', { 'Lead ID': 'private' }), event('h3', { 'Lead ID': 'archived' })] });
  const result = report({ role: 'ADMIN', userId: 'sales2', doneBy: 'sales1' });
  assert.equal(result.total, 1);
  assert.equal(result.totals.connected, 1);
  assert.deepEqual(result.categories, ['Dealer']);
  assert.equal(context.apiGetClientCallReport('valid', { archive: 'all' }).success, false);
  const exported = context.apiExportClientCallReport('valid', {}).data.csv;
  assert.doesNotMatch(exported, /Secret company|private|archived/);
});

test('manager/viewer department scope is identical for report and export', () => {
  for (const role of ['MANAGER', 'VIEWER']) {
    const { context, report } = setup({ user: { id: 'viewer', role, modules: ['Reports', 'Archive'] }, departments: ['Sales'], leads: [lead(), lead('other', { 'Assigned To': 'sales2', 'Company Name': 'Hidden company' })], history: [event(), event('h2', { 'Lead ID': 'other' })] });
    assert.equal(report({ archive: 'all' }).totals.connected, 1);
    assert.doesNotMatch(context.apiExportClientCallReport('valid', { archive: 'all' }).data.csv, /Hidden company/);
  }
});

test('blank IDs and orphan history are excluded without company-name fallback', () => {
  const { report } = setup({ history: [event('', {}), event('orphan', { 'Lead ID': 'missing', 'Company Name': 'Same company' }), event()] });
  const result = report();
  assert.equal(result.totals.connected, 1);
  assert.equal(result.excluded.missingIds, 1);
});

test('paging keeps overall totals, while CSV exports every filtered row', () => {
  const leads = Array.from({ length: 52 }, (_, i) => lead(String(i).padStart(3, '0')));
  const history = leads.map(row => event('h' + row['Lead ID'], { 'Lead ID': row['Lead ID'] }));
  const { context, report } = setup({ leads, history });
  const result = report({ page: 2 });
  assert.equal(result.items.length, 2);
  assert.equal(result.total, 52);
  assert.equal(result.totals.connected, 52);
  assert.equal(report({ page: 999 }).page, 2);
  assert.equal(context.apiExportClientCallReport('valid', { page: 2 }).data.csv.split('\r\n').length, 54);
});

test('CSV escapes formulas, quotes and commas, retaining exact lead IDs', () => {
  const { context } = setup({ leads: [lead('001', { 'Company Name': '  =HYPERLINK("x"),name' })] });
  const csv = context.apiExportClientCallReport('valid', {}).data.csv;
  assert.match(csv, /"001","'=HYPERLINK\(""x""\),name"/);
  assert.match(csv, /"TOTAL","","","","","1","0","1","0"$/);
});

test('CSV export refuses oversized results instead of silently truncating', () => {
  const { context } = setup({ leads: Array.from({ length: 10001 }, (_, i) => lead(String(i))), history: [] });
  const result = context.apiExportClientCallReport('valid', {});
  assert.equal(result.success, false);
  assert.match(result.error, /maximum/);
});

test('report UI route uses Reports permission and displays escaped, separate totals', async () => {
  const app = vm.createContext({ window: {}, App: { user: { role: 'SALES', modules: [] } } });
  vm.runInContext(read('src/AppUI.html').replace(/^<script>\s*/, '').replace(/<\/script>\s*$/, ''), app);
  assert.equal(app.canNavigate('callreport'), false);
  app.App.user.modules = ['Reports'];
  assert.equal(app.canNavigate('callreport'), true);
  app.App.user = { role: 'ADMIN', modules: [] };
  assert.equal(app.canNavigate('callreport'), true);
  const { report } = setup({ leads: [lead('001', { 'Company Name': '<img src=x onerror=bad()>' })] });
  const elements = new Map();
  const ui = vm.createContext({ App: { currentPage: 'callreport' }, el: id => { if (!elements.has(id)) elements.set(id, {}); return elements.get(id); }, skeletonPage: () => 'loading', escapeHtml: text => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'), api: { _authedRead: async () => report() } });
  vm.runInContext(read('src/ClientCallReport.html').replace(/^<script>\s*/, '').replace(/<\/script>\s*$/, ''), ui);
  await ui.loadClientCallReport();
  const html = elements.get('content').innerHTML;
  assert.match(html, /&lt;img/);
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /WhatsApp Chat is separate/);
  assert.match(html, /Asia\/Kolkata/);
  assert.match(html, /Total calls: 1/);
});

test('late report responses cannot overwrite a newer request or another route', async () => {
  const pending = [], box = {};
  const { report } = setup();
  const ui = vm.createContext({ App: { currentPage: 'callreport' }, el: () => box, skeletonPage: () => 'loading', escapeHtml: String, api: { _authedRead: () => new Promise(resolve => pending.push(resolve)) } });
  vm.runInContext(read('src/ClientCallReport.html').replace(/^<script>\s*/, '').replace(/<\/script>\s*$/, ''), ui);
  const first = ui.loadClientCallReport(), second = ui.loadClientCallReport();
  pending[1](report()); await second;
  const rendered = box.innerHTML;
  pending[0]({}); await first;
  assert.equal(box.innerHTML, rendered);
  const third = ui.loadClientCallReport();
  ui.App.currentPage = 'leads'; box.innerHTML = 'Lead screen';
  pending[2]({}); await third;
  assert.equal(box.innerHTML, 'Lead screen');
});
