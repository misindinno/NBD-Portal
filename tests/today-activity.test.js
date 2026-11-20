'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), vm = require('node:vm'), fs = require('node:fs'), path = require('node:path');
const { todayData, todayConfig, escapeHtml } = require('./helpers/today-fixture');
const source = fs.readFileSync(path.join(__dirname, '../src/Today.html'), 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
const plain = value => JSON.parse(JSON.stringify(value));
function fixture() {
  const data = todayData(), nodes = {};
  for (const id of ['today-page', 'today-wrap', 'content', 'td-from', 'td-to', 'td-user', 'td-type', 'td-group', 'td-tbody', 'td-cards', 'td-row-count', 'td-group-summary', 'td-card-filter-chip', 'td-range-tabs']) nodes[id] = { value: '', innerHTML: '', textContent: '', scrollIntoView() {} };
  const c = vm.createContext({ console, Intl, Date, Option: function(text, value) { return { text, value }; }, window: {}, document: { querySelector: () => null }, el: id => nodes[id] || null,
    App: { currentPage: 'today', user: { role: 'ADMIN', id: 'u1' }, config: todayConfig() }, AppCache: { getRows: k => data[k] || [], setRows: (k, v) => { data[k] = v; }, clear: () => { for (const k in data) data[k] = []; } }, AppLookup: { stageName: v => v },
    AuthToken: { get: () => 'synthetic' }, escapeHtml, remarkHtml: escapeHtml, icon: () => '', renderIcons() {}, _fmtDate: v => String(v || '').slice(0, 10), localDateInputValue: d => d ? d.toISOString().slice(0, 10) : '2026-11-20', formatDate: escapeHtml, formatDateTime: escapeHtml
  });
  vm.runInContext(source, c);
  c._todayChartType = c._todayChartTrend = c._todayChartContactMode = () => {};
  return { c, data, nodes, run: code => vm.runInContext(code, c) };
}
function card(f, key) {
  const start = f.nodes['td-cards'].innerHTML.indexOf(`_todayCardClick('${key}')`);
  assert.ok(start >= 0, 'card exists: ' + key);
  return Number(f.nodes['td-cards'].innerHTML.slice(start).match(/fu-kpi-value">(\d+)/)[1]);
}
test('only the nine main cards remain; Won is date-scoped unique leads and matches its drilldown', () => {
  const f = fixture(); f.c._todayApply();
  assert.equal((f.nodes['td-cards'].innerHTML.match(/<button /g) || []).length, 9);
  assert.equal(card(f, 'won'), 3); assert.equal(card(f, 'connected'), 4);
  f.c._todayCardClick('won'); assert.equal(f.nodes['td-row-count'].textContent, 3);
  assert.doesNotMatch(f.nodes['td-tbody'].innerHTML, /Example old/);
  f.nodes['td-user'].value = 'u1'; f.c._todayApply(); assert.equal(card(f, 'won'), 2); assert.equal(f.nodes['td-row-count'].textContent, 2);
  f.nodes['td-from'].value = f.nodes['td-to'].value = '2026-11-18'; f.c._todaySetRange('custom');
  assert.equal(card(f, 'won'), 1); assert.equal(f.run('_todayCardFilter'), 'won'); assert.match(f.nodes['td-tbody'].innerHTML, /Example old/);
});
test('Won excludes unrelated edits, no-op Won changes and old current status; resolves configured stages', () => {
  const f = fixture(), base = { 'Lead ID': '1', 'Action Type': 'Stage Change', 'Old Value': 'Open', 'New Value': 'won-stage', 'Created At': '2026-11-20 09:00:00' };
  const logs = [base, base, { ...base, 'Lead ID': '001' }, { ...base, 'Lead ID': 'x', 'Action Type': 'Edit', 'Field Name': 'Remark' }, { ...base, 'Lead ID': 'y', 'Old Value': 'won-stage' }, { ...base, 'Lead ID': 'z', 'New Value': 'Disqualified' }];
  assert.deepEqual(plain(f.c._todayWonRows(logs)).map(r => r['Lead ID']), ['1', '001']);
});
test('activity dates respect India midnight for ISO instants and preserve Sheet-local dates', () => {
  const { c } = fixture();
  assert.equal(c._todayActivityDay('2026-11-19T18:29:59Z'), '2026-11-19');
  assert.equal(c._todayActivityDay('2026-11-19T18:30:00Z'), '2026-11-20');
  assert.equal(c._todayActivityDay('2026-11-20T00:00:00+05:30'), '2026-11-20');
  assert.equal(c._todayActivityDay('2026-11-20 00:00:00'), '2026-11-20');
  assert.equal(c._todayActivityDay('invalidTtimeZ'), '');
});
test('grouping counts every filtered record and distinct stable lead IDs without merging names', () => {
  const f = fixture(); f.nodes['td-group'].value = 'lead:City'; f.c._todayCardClick('connected');
  assert.equal(f.nodes['td-group-summary'].textContent, '3 groups · 4 records · 3 unique leads');
  assert.match(f.nodes['td-tbody'].innerHTML, /Delhi<span>2 records · 1 unique leads/);
  assert.match(f.nodes['td-tbody'].innerHTML, /\(Not set\)/);
  f.nodes['td-user'].value = 'u1'; f.nodes['td-type'].value = 'Call'; f.c._todayApply();
  assert.equal(f.nodes['td-group-summary'].textContent, '1 groups · 2 records · 1 unique leads');
  f.c._todayCardClick('productive'); assert.equal(f.nodes['td-user'].value, 'u1'); assert.equal(f.nodes['td-type'].value, 'Call'); assert.equal(f.nodes['td-group'].value, 'lead:City');
  assert.equal(f.nodes['td-row-count'].textContent, 2);
  f.c._todayCardClick('productive'); assert.equal(f.run('_todayCardFilter'), ''); assert.equal(f.nodes['td-user'].value, 'u1');
});
test('group fields include available custom values and omit hidden/internal/secrets; hostile labels remain text', () => {
  const f = fixture(); Object.assign(f.data.leads[0], { 'Custom region': '<img src=x onerror=alert(1)>', Hidden: 'private', Token: 'sensitive', _metadata: 'internal' });
  f.c.App.config.leadFields = [{ 'Column Key': 'Hidden', 'Is Visible': false }];
  const keys = f.c._todayGroupFields().map(r => r.key);
  assert.ok(keys.includes('lead:Custom region')); assert.ok(!keys.includes('lead:Hidden')); assert.ok(!keys.includes('lead:Token')); assert.ok(!keys.includes('lead:_metadata'));
  f.nodes['td-group'].value = 'lead:Custom region'; f.c._todayCardClick('calls');
  assert.match(f.nodes['td-tbody'].innerHTML, /&lt;img/); assert.doesNotMatch(f.nodes['td-tbody'].innerHTML, /<img/);
});
test('group by raw activity fields keeps log metadata; zero results and explicit Clear work', () => {
  const f = fixture(); f.nodes['td-group'].value = 'activity:Log ID'; f.c._todayCardClick('won');
  assert.match(f.nodes['td-tbody'].innerHTML, /l2<span>/);
  f.nodes['td-from'].value = f.nodes['td-to'].value = '2025-01-01'; f.c._todaySetRange('custom');
  assert.equal(f.nodes['td-group-summary'].textContent, '0 groups · 0 records · 0 unique leads'); assert.match(f.nodes['td-tbody'].innerHTML, /No activity/);
  f.c._todayClearFilters(); assert.equal(f.run('_todayCardFilter'), ''); assert.equal(f.nodes['td-group'].value, ''); assert.equal(f.c.window._todayRange, 'today');
});
test('grouping by actor resolves IDs and emails; missing lead data stays unlinked', () => {
  const f = fixture(), groups = f.c._todayGroupRows([{ 'Created By': 'u1' }, { 'Done By': 'one@example.test' }], 'agent', {}, { u1: 'Agent One', 'one@example.test': 'Agent One' });
  assert.equal(groups.length, 1); assert.equal(groups[0].rows.length, 2);
  const missing = f.c._todayGroupRows([{ 'Lead ID': 'unavailable' }], 'lead:City', {}, {}); assert.equal(missing[0].label, '(Not set)');
});
test('out-of-order snapshot responses and navigation away cannot repaint or replace scoped data', async () => {
  const f = fixture(), pending = []; let renders = 0;
  f.c._renderToday = () => { renders++; }; f.c.pagePreviewRead = () => new Promise(resolve => pending.push(resolve));
  const first = f.c.loadToday(), second = f.c.loadToday();
  pending[1]({ leads: [{ 'Lead ID': 'newer' }] }); await second;
  pending[0]({ leads: [{ 'Lead ID': 'older' }] }); await first;
  assert.equal(f.data.leads[0]['Lead ID'], 'newer'); assert.equal(renders, 1);
  const third = f.c.loadToday(); f.c.App.currentPage = 'leads'; pending[2]({ leads: [] }); await third;
  assert.equal(f.data.leads[0]['Lead ID'], 'newer'); assert.equal(renders, 1);
});
