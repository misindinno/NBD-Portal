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
    CLIENT_CONFIG: { FSR_SOURCE_KEY: "nbd-portal" },
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
  assert.equal(h.calls[0].url, 'https://fsr.example.com/api/v1/clients/NBD-00123/visits?limit=20&offset=0&sourceKey=nbd-portal');
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
  h.status(404); assert.throws(() => h.read(), /endpoint was not found/);
  h.status(429); assert.throws(() => h.read(), /too many requests/);
  for (const status of [302, 500]) { h.status(status); assert.throws(() => h.read(), /temporarily unavailable/); }
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

function uiHarness() {
  const requests=[];
  function button() { return { handlers:{}, addEventListener(name,fn){this.handlers[name]=fn;}, click(){return this.handlers.click?.();} }; }
  const tab=button(), count={hidden:true,textContent:''};
  const panel={html:'',buttons:{},attributes:{},setAttribute(k,v){this.attributes[k]=v;},get innerHTML(){return this.html;},set innerHTML(value){this.html=value;this.buttons={'[data-fsr-refresh]':button(),...(value.includes('data-fsr-more')?{'[data-fsr-more]':button()}: {})};},querySelector(selector){return this.buttons[selector];}};
  const overlay={isConnected:true,querySelector(selector){return {'[data-fsr-history-tab]':tab,'[data-fsr-history-panel]':panel,'[data-fsr-history-count]':count}[selector];}};
  const context=vm.createContext({URL,escapeHtml:value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;'),api:{getFsrVisitHistory:(id,offset)=>new Promise((resolve,reject)=>requests.push({id,offset,resolve,reject}))}});
  vm.runInContext(fs.readFileSync(path.join(root,'src/FsrVisitHistory.html'),'utf8').match(/<script>([\s\S]*?)<\/script>/)[1],context);
  context._mountFsrVisitHistory(overlay,'000123');
  return {requests,tab,panel,count,overlay,context};
}
const settle=()=>new Promise(resolve=>setImmediate(resolve));
const page=(visits,total=visits.length,nextOffset=null)=>({configured:true,visits,total,nextOffset,fsrOrigin:'https://fsr.example.com'});
test('history starts on lead open, deduplicates in-flight reads and displays Category/order fields',async()=>{
 const h=uiHarness();assert.equal(h.requests.length,1);assert.equal(h.requests[0].id,'000123');assert.equal(h.panel.attributes['aria-busy'],'true');h.tab.click();assert.equal(h.requests.length,1);
 h.requests[0].resolve(page([{id:'v1',category:'GOLD',orderNumber:'ORD-001',orderReceived:false,remarks:'Saved visit'}]));await settle();
 assert.ok(h.panel.html.includes('GOLD'));assert.ok(h.panel.html.includes('ORD-001'));assert.ok(h.panel.html.includes('<dd>No</dd>'));assert.equal(h.count.textContent,'1');assert.equal(h.count.hidden,false);assert.equal(h.panel.attributes['aria-busy'],'false');
});
test('failed refresh preserves history; retry replaces it and load-more appends without duplicates',async()=>{
 const h=uiHarness();h.requests[0].resolve(page([{id:'v1',remarks:'Original'}],21,20));await settle();
 h.panel.querySelector('[data-fsr-refresh]').click();assert.ok(h.panel.html.includes('Original'));h.requests[1].reject(new Error('private upstream '+key));await settle();assert.ok(h.panel.html.includes('Original'));assert.ok(h.panel.html.includes('Previously loaded'));assert.ok(!h.panel.html.includes(key));
 h.panel.querySelector('[data-fsr-refresh]').click();h.requests[2].resolve(page([{id:'v2',remarks:'Replacement'}],21,20));await settle();assert.ok(!h.panel.html.includes('Original'));assert.ok(h.panel.html.includes('Replacement'));
 h.panel.querySelector('[data-fsr-more]').click();assert.equal(h.requests[3].offset,20);h.requests[3].resolve(page([{id:'v2',remarks:'Duplicate'},{id:'v3',remarks:'Older'}],21,null));await settle();assert.ok(h.panel.html.includes('Older'));assert.ok(!h.panel.html.includes('Duplicate'));assert.ok(!h.panel.html.includes('data-fsr-more'));
});
test('configuration and detached-dialog states do not display misleading empty history',async()=>{
 const h=uiHarness();h.requests[0].resolve({configured:false,total:0,visits:[],nextOffset:null,fsrOrigin:''});await settle();assert.ok(h.panel.html.includes('not configured'));assert.ok(!h.panel.html.includes('No FSR visits'));assert.equal(h.count.hidden,true);
 const closed=uiHarness(),before=closed.panel.html;closed.overlay.isConnected=false;closed.requests[0].resolve(page([{id:'late',remarks:'Late reply'}]));await settle();assert.equal(closed.panel.html,before);
});
test('all shared portal lead dialogs expose and mount the FSR history tab',()=>{
 const source=fs.readFileSync(path.join(root,'src/LeadDetail.html'),'utf8');
 const historyLines=source.split('\n').filter(line=>/data-fsr-history|_mountFsrVisitHistory/.test(line));assert.equal(historyLines.length,3);assert.ok(historyLines.every(line=>!line.includes('_isNBDPortal')));
 for(const client of ['nbd-client1','nbd-lamination','lq-portal','lq-lamination']) assert.ok(fs.existsSync(path.join(root,'clients',client,'ClientConfig.js')));
});

test('one key is reused across every configured portal and responses must match that portal', () => {
 for(const [client,source] of [['nbd-client1','nbd-portal'],['nbd-lamination','nbd-lamination-portal'],['lq-portal','lq-portal'],['lq-lamination','lq-lamination-portal']]) {
  const h=harness(); const config=vm.runInNewContext(fs.readFileSync(path.join(root,'clients',client,'ClientConfig.js'),'utf8')+';CLIENT_CONFIG');
  assert.equal(config.FSR_SOURCE_KEY,source); h.context.CLIENT_CONFIG=config;
  h.body.data.client.sourceKey=source; h.body.data.visits[0].sourceKey=source;
  assert.equal(h.read().configured,true); assert.equal(h.calls[0].options.headers.Authorization,'Bearer '+key);
  assert.ok(h.calls[0].url.endsWith('&sourceKey='+source));
  h.body.data.client.sourceKey='wrong-portal';h.body.data.visits[0].sourceKey='wrong-portal';
  assert.throws(()=>h.read(),/invalid history response/);
 }
 const h=harness();delete h.context.CLIENT_CONFIG.FSR_SOURCE_KEY;assert.throws(()=>h.read(),/source key in ClientConfig/);assert.equal(h.calls.length,0);
});
