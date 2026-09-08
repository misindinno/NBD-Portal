const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const key = 'fsr_api_' + 'a'.repeat(32) + '.' + 'b'.repeat(43);
function harness() {
  const props = { FSR_API_BASE_URL: 'https://fsr.example.com/', FSR_API_KEY: key };
  const calls = [];
  const body = { data: { client: { id: 'NBD-00123', sourceKey: 'nbd-portal' }, visits: [{ id: 'v1', sourceKey: 'nbd-portal', sourceRecordId: 'NBD-00123', remarks: 'Current' }], pagination: { offset: 0, limit: 20, total: 1, nextOffset: null } } };
  let status = 200, unavailable = false;
  const context = vm.createContext({
    assertServerContext_() {}, PropertiesService: { getScriptProperties: () => ({ getProperty: name => props[name] }) },
    UrlFetchApp: { fetch(url, options) {
      calls.push({ url, options });
      if (unavailable) throw new Error('Sensitive upstream request: ' + key);
      return { getResponseCode: () => status, getContentText: () => JSON.stringify(body) };
    } }
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'src/server/FsrVisitHistoryService.js'),'utf8'), context);
  return { props, calls, body, context, status: value => { status = value; }, fail: () => { unavailable = true; }, read: (id = 'NBD-00123', page = 0) => context._fsrReadLeadVisits_(id, page) };
}
test('server reads live visits by exact lead ID without exposing the API key', () => {
  const h = harness();
  const result = h.read();
  assert.equal(result.visits[0].remarks, 'Current');
  assert.equal(result.configured, true);
  assert.equal(h.calls[0].url, 'https://fsr.example.com/api/v1/clients/NBD-00123/visits?limit=20&offset=0');
  assert.equal(h.calls[0].options.headers.Authorization, 'Bearer ' + key);
  assert.equal(h.calls[0].options.followRedirects, false);
  assert.ok(!JSON.stringify(result).includes(key));
  h.body.data.visits[0].remarks = 'Updated';
  assert.equal(h.read().visits[0].remarks, 'Updated');
  h.body.data.visits = []; h.body.data.pagination.total = 0;
  assert.equal(h.read().visits.length, 0);
  assert.equal(h.calls.length, 3);
  assert.equal(typeof h.context.doPost, 'undefined');
});
test('handles missing configuration and refuses invalid destinations or paging before fetching', () => {
  const h = harness();
  delete h.props.FSR_API_KEY;
  assert.equal(h.read().configured, false);
  h.props.FSR_API_KEY = key;
  for (const url of ['http://fsr.example.com', 'https://user:password@fsr.example.com', 'https://fsr.example.com/path', 'https://fsr.example.com?token=x']) {
    h.props.FSR_API_BASE_URL = url; assert.throws(() => h.read(), /Script Properties/);
  }
  h.props.FSR_API_BASE_URL = 'https://fsr.example.com';
  assert.throws(() => h.read('NBD-00123', -1), /Invalid history page/);
  assert.throws(() => h.read('NBD-00123', 1.5), /Invalid history page/);
  assert.throws(() => h.read(''), /Invalid client ID/);
  assert.equal(h.calls.length, 0);
});
test('encodes client IDs and uses the API next-page contract', () => {
  const h = harness();
  const id = '0001/part ?';
  h.body.data.client.id = id; h.body.data.visits[0].sourceRecordId = id;
  h.body.data.pagination = { offset: 20, limit: 20, total: 41, nextOffset: 40 };
  assert.equal(h.read(id, 20).nextOffset, 40);
  assert.ok(h.calls[0].url.includes('/0001%2Fpart%20%3F/visits?limit=20&offset=20'));
});
test('rejects cross-client responses, mismatched visit scopes and malformed pagination', () => {
  let h = harness(); h.body.data.client.id = 'another-lead'; assert.throws(() => h.read(), /invalid history response/);
  h = harness(); h.body.data.visits[0].sourceKey = 'lq-portal'; assert.throws(() => h.read(), /invalid history response/);
  h = harness(); h.body.data.visits[0].sourceRecordId = 'other'; assert.throws(() => h.read(), /invalid history response/);
  h = harness(); h.body.data.pagination.nextOffset = 0; assert.throws(() => h.read(), /invalid history response/);
});
test('upstream auth, redirect and network failures never expose credentials or response bodies', () => {
  const h = harness();
  h.status(401); assert.throws(() => h.read(), /API access was rejected/);
  for (const status of [302, 404, 429, 500]) { h.status(status); assert.throws(() => h.read(), /temporarily unavailable/); }
  h.fail();
  assert.throws(() => h.read(), error => !error.message.includes(key) && error.message.includes('temporarily unavailable'));
});
test('history API enforces lead visibility and scoped follow-up access', () => {
  let historyReads = 0;
  const context = vm.createContext({ SHEET_NAMES: { LEADS: 'LEAD_MASTER' }, getRowByIndexedId_: () => ({ 'Lead ID': 'L1' }), getFollowups: () => [], respond: (data, error) => ({ data, error }), _fsrReadLeadVisits_: () => { historyReads++; return { visits: [] }; } });
  vm.runInContext(fs.readFileSync(path.join(root, 'src/server/Api.js'), 'utf8'), context);
  context.apiGuard_ = (_, fn) => fn(); context._requireAnyModule = () => ({ id: 'sales' }); context._canReadAssignedRow = () => false; context._scopeFollowupRows = () => [];
  assert.equal(context.apiGetFsrVisitHistory('token', 'L1').error, 'Lead not found.');
  assert.equal(historyReads, 0);
  context._scopeFollowupRows = () => [{ 'Lead ID': 'L1' }];
  assert.ok(context.apiGetFsrVisitHistory('token', 'L1').data);
  assert.equal(historyReads, 1);
  context._requireAnyModule = () => { throw new Error('SESSION_EXPIRED'); };
  assert.throws(() => context.apiGetFsrVisitHistory('', 'L1'), /SESSION_EXPIRED/);
});

test('history UI escapes API content and rejects unsafe evidence URLs', () => {
  const html = fs.readFileSync(path.join(root, 'src/FsrVisitHistory.html'), 'utf8');
  const context = vm.createContext({ URL, escapeHtml: value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;') });
  vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], context);
  assert.equal(context._fsrHistoryEvidenceUrl('javascript:alert(1)', 'https://fsr.example.com'), '');
  assert.equal(context._fsrHistoryEvidenceUrl('https://evil.example/api/files/id', 'https://fsr.example.com'), '');
  assert.equal(context._fsrHistoryEvidenceUrl('/api/files/id', 'https://fsr.example.com'), 'https://fsr.example.com/api/files/id');
  const card = context._fsrHistoryCard({ id: 'id', remarks: '<img src=x onerror=alert(1)>', shopImageUrls: [] }, 'https://fsr.example.com');
  assert.ok(card.includes('&lt;img')); assert.ok(!card.includes('<img'));
});
