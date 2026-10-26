'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const crypto = require('node:crypto').webcrypto;
const {read, memoryStorage, browserFactory, serverFixture} = require('./helpers/lead-cache-fixture');
const {moduleFixture, moduleClient} = require('./helpers/portal-cache-fixture');
const source = read('src/PagePreview.html').replace(/^<script>\s*/,'').replace(/<\/script>\s*$/,'');
const identity = {schema:1,portal:'portal',user:'user',scope:'a'.repeat(64)};
function fixture(overrides = {}) {
  const storage = overrides.storage || memoryStorage();
  const c = vm.createContext({crypto,TextEncoder,structuredClone,Map,Set,...overrides.globals});
  vm.runInContext(source.split('const PagePreview =')[0],c);
  const cache = c.createPagePreviewCache({storage,now:()=>Date.parse('2026-10-26T10:00:00Z'),...overrides});
  cache.bind(identity); return {c,cache,storage};
}
test('UI data comes from a completed IndexedDB transaction and readback, not the network object', async () => {
  const storage=memoryStorage(); let release, started;
  const waiting=new Promise(resolve=>{started=resolve;}); const put=storage.put;
  storage.put=async data=>{started();await new Promise(resolve=>release=resolve);return put.call(storage,data);};
  const {cache}=fixture({storage}); const response=[{'Lead ID':'1','Company Name':'Saved'}];
  let completed=false;const pending=cache.capture('apiGetLeads',[],response).then(data=>{completed=true;return data;});
  await waiting;assert.equal(completed,false);release();
  const data=await pending; response[0]['Company Name']='Changed network object';
  assert.equal(data[0]['Company Name'],'Saved'); assert.equal(storage.puts,1);
});
test('storage quota failure never renders a fresh response or destroys the previous complete preview', async () => {
  const {cache,storage}=fixture();await cache.capture('apiGetLeads',[],[{id:'old'}]);
  storage.put=async()=>{throw Error('QuotaExceededError');};
  await assert.rejects(cache.capture('apiGetLeads',[],[{id:'new'}]),/Quota/);
  assert.equal((await cache.get('apiGetLeads',[])).data[0].id,'old');
});
test('a fresh browser instance restores the same user/query; mismatched identity or scope cannot preview', async () => {
  const first=fixture();await first.cache.capture('apiGetCallLogs',[{page:2}],{rows:[{id:'call'}]});
  const second=fixture({storage:first.storage});
  assert.equal((await second.cache.get('apiGetCallLogs',[{page:2}])).data.rows[0].id,'call');
  assert.equal(await second.cache.get('apiGetCallLogs',[{page:1}]),null);
  second.cache.bind({...identity,user:'other'});assert.equal(await second.cache.get('apiGetCallLogs',[{page:2}]),null);
  second.cache.bind({...identity,scope:'b'.repeat(64)});assert.equal(await second.cache.get('apiGetCallLogs',[{page:2}]),null);
});
test('corrupt, incomplete and expired snapshots are never previewed', async () => {
  for(const change of [s=>s.data[0].id='tampered',s=>s.complete=false,s=>s.verifiedAt='2020-01-01']) {
    const f=fixture();await f.cache.capture('apiGetLeads',[],[{id:'ok'}]);
    for(const value of f.storage.data.values())change(value);
    const next=fixture({storage:f.storage}); assert.equal(await next.cache.get('apiGetLeads',[]),null);
  }
});
test('legacy credentials and sensitive config values are removed; mutation and raw delivery payloads are not cached', async () => {
  const {cache,storage}=fixture();
  const users=await cache.capture('apiGetUsers',[],[{ID:'1',Name:'User',Password:'do-not-store','Password Hash':'hash'}]);
  assert.deepEqual(JSON.parse(JSON.stringify(users)),[{ID:'1',Name:'User'}]);
  await cache.capture('apiGetAllConfigs',[],[{'Config Type':'API Token',Value:'secret'},{'Config Type':'Priority',Value:'Top'}]);
  assert.doesNotMatch(JSON.stringify([...storage.data.values()]),/do-not-store|secret|Password Hash/);
  assert.equal(cache.handles('apiSaveLead'),false);assert.equal(cache.handles('apiGetCallWebhookDelivery'),false);
});
test('logout and mutation generations prevent late network responses from committing', async () => {
  const f=fixture(), generation=f.cache.generation();
  f.cache.reset();await assert.rejects(f.cache.capture('apiGetLeads',[],[],generation));
  assert.equal(f.storage.puts,0);
  f.cache.bind(identity);const next=f.cache.generation();await f.cache.invalidate();
  await assert.rejects(f.cache.capture('apiGetLeads',[],[],next));assert.equal(f.storage.puts,0);
});
test('concurrent filters each read back their own committed response', async () => {
  const f=fixture();const results=await Promise.all([
    f.cache.capture('apiGetCallLogs',[{page:1}],{rows:['one']}),
    f.cache.capture('apiGetCallLogs',[{page:2}],{rows:['two']})
  ]);
  assert.equal(results[0].rows[0],'one');assert.equal(results[1].rows[0],'two');
  assert.equal((await f.cache.get('apiGetCallLogs',[{page:1}])).data.rows[0],'one');
});
test('missing Web Crypto cannot claim a network response was saved', async () => {
  const f=fixture({globals:{crypto:{}}});
  await assert.rejects(f.cache.capture('apiGetLeads',[],[]),/integrity/);assert.equal(f.storage.puts,0);
});
test('existing verified Leads and module snapshots can preview without a server request', async () => {
  const server=serverFixture(3), storage=memoryStorage(), client=browserFactory().createLeadReadCache({storage,request:q=>server.request(q)});
  client.bind(server.identity());await client.load();
  const before=storage.puts;assert.equal((await client.preview()).data.length,3);assert.equal(storage.puts,before);
  client.bind({...server.identity(),scope:'f'.repeat(64)});assert.equal(await client.preview(),null);
  const modules=moduleClient(moduleFixture()); await modules.client.get('apiGetFollowupPageSnapshot',{includeHistory:true});const calls=modules.requests;
  assert.ok(await modules.client.preview('apiGetFollowupPageSnapshot',{includeHistory:true}));
  assert.equal(await modules.client.preview('apiGetFollowupPageSnapshot',{includeHistory:false}),null);assert.equal(modules.requests,calls);
});
function runtime() {
  const f=fixture(); const elements=new Map(),timers=[],requests=[],events={};
  const content={before:node=>elements.set(node.id,node)};elements.set('content',content);
  Object.assign(f.c,{PagePreview:f.cache,App:{currentPage:'today'},window:{},setTimeout:fn=>timers.push(fn),
    document:{getElementById:id=>elements.get(id),createElement:()=>({style:{},setAttribute(){},append(){},remove(){elements.delete(this.id);}}),addEventListener:(type,fn)=>events[type]=fn,querySelector:()=>null,activeElement:null},
    api:{_authedRead:()=>new Promise((resolve,reject)=>requests.push({resolve,reject}))}, lockPrivateReadCache:()=>{f.cache.reset();f.locked=true;}
  });
  vm.runInContext(source.slice(source.indexOf('let pagePreviewNavigation')),f.c);
  return {...f,elements,timers,requests,events};
}
test('warm page renders preview while RPC is pending, then applies a background DB update', async () => {
  const f=runtime();await f.cache.capture('apiGetTodayActivitySnapshot',[],{leads:['old']});let updated;
  const first=await f.c.pagePreviewRead('apiGetTodayActivitySnapshot',[],data=>updated=data);
  assert.equal(first.leads[0],'old');assert.equal(f.requests.length,1);assert.equal(updated,undefined);
  f.requests[0].resolve({leads:['new']});await new Promise(setImmediate);f.timers.splice(0).forEach(fn=>fn());
  assert.equal(updated.leads[0],'new');
});
test('late refresh cannot replace another route or overwrite typing', async () => {
  for (const action of ['navigate','input']) {
    const f=runtime();await f.cache.capture('apiGetTodayActivitySnapshot',[],{leads:['old']});let updated=false;
    await f.c.pagePreviewRead('apiGetTodayActivitySnapshot',[],()=>{updated=true;});
    if(action==='navigate'){f.c.beginPagePreview();f.c.App.currentPage='leads';} else f.events.input();
    f.requests[0].resolve({leads:['new']});await new Promise(setImmediate);f.timers.splice(0).forEach(fn=>fn());
    assert.equal(updated,false);
  }
});
test('offline background failure retains preview; access denial locks it', async () => {
  for(const message of ['Network offline','ACCESS_DENIED']) {
    const f=runtime();await f.cache.capture('apiGetTodayActivitySnapshot',[],{leads:['old']});
    await f.c.pagePreviewRead('apiGetTodayActivitySnapshot',[],()=>{});
    f.requests[0].reject(Error(message));await new Promise(setImmediate);
    assert.equal(f.cache.enabled(),message==='Network offline');
  }
});

test('synced views update automatically after typing or a dialog finishes', async () => {
  for (const block of ['typing', 'dialog']) {
    const f=runtime();await f.cache.capture('apiGetTodayActivitySnapshot',[],{leads:['old']});let updated;
    await f.c.pagePreviewRead('apiGetTodayActivitySnapshot',[],data=>updated=data);
    if(block==='typing') f.events.input();
    else f.c.document.querySelector=selector=>selector.includes('.modal-overlay') ? {} : null;
    f.requests[0].resolve({leads:['new']});await new Promise(setImmediate);
    f.timers.splice(0).forEach(fn=>fn());assert.equal(updated,undefined);
    vm.runInContext('pagePreviewLastInput = 0',f.c);f.c.document.querySelector=()=>null;
    f.timers.splice(0).forEach(fn=>fn());assert.equal(updated.leads[0],'new');
  }
});

test('post-commit refresh keeps the active query and updates through IndexedDB without another button', async () => {
  const f=runtime(), args=[{page:2,search:'current client'}], calls=[], reads=[];let updated;
  await f.cache.capture('apiGetCallLogs',args,{rows:['old']});
  f.c.api._authedRead=(fn,...params)=>{calls.push([fn,params]);const read=f.cache.capture(fn,params,{rows:[calls.length]});reads.push(read);return read;};
  await f.c.pagePreviewRead('apiGetCallLogs',args,data=>updated=data);
  await reads[0];await new Promise(setImmediate);f.timers.splice(0).forEach(fn=>fn());assert.equal(updated.rows[0],1);
  await f.cache.invalidate();await f.c.refreshActivePagePreviews();f.timers.splice(0).forEach(fn=>fn());
  assert.equal(updated.rows[0],2);assert.equal((await f.cache.get('apiGetCallLogs',args)).data.rows[0],2);
  assert.deepEqual(calls[1],['apiGetCallLogs',args]);
});

test('a closed dialog cannot apply an old route or superseded filter refresh', async () => {
  const f=runtime();let seen=[];f.c.document.querySelector=()=>({});
  await f.cache.capture('apiGetCallLogs',[{page:1}],{rows:['one']});
  await f.cache.capture('apiGetCallLogs',[{page:2}],{rows:['two']});
  await f.c.pagePreviewRead('apiGetCallLogs',[{page:1}],data=>seen.push(data));
  f.requests[0].resolve({rows:['stale']});await new Promise(setImmediate);f.timers.splice(0).forEach(fn=>fn());
  await f.c.pagePreviewRead('apiGetCallLogs',[{page:2}],data=>seen.push(data));
  f.requests[1].resolve({rows:['current']});await new Promise(setImmediate);
  f.c.document.querySelector=()=>null;f.timers.splice(0).forEach(fn=>fn());
  assert.deepEqual(seen.map(data=>data.rows[0]),['current']);
  await f.cache.invalidate();const pending=f.c.refreshActivePagePreviews();f.c.beginPagePreview();
  f.requests[2].resolve({rows:['old route']});await pending;f.timers.splice(0).forEach(fn=>fn());
  assert.equal(seen.length,1);
});

test('API sync writes do not invalidate the commit refresh a second time; direct writes refresh once', async () => {
  const core=read('src/AppCore.html');
  const method=core.slice(core.indexOf('  async _authedRead('),core.indexOf('  // ── Session auth'));
  for(const syncWrite of [true,false]) {
    let invalidations=0,refreshes=0;
    const context=vm.createContext({
      PagePreview:{handles:()=>false,invalidate:async()=>{invalidations++;}},
      PortalSync:{handles:()=>syncWrite,submit:async()=>{invalidations++;refreshes++;return {ok:true};}},
      refreshActivePagePreviews:()=>{refreshes++;}
    });
    vm.runInContext('var api = {_token:()=>"token",_read:async()=>({ok:true}),'+method+'};',context);
    assert.equal((await context.api._authedRead('apiSaveLead',{})).ok,true);
    assert.equal(invalidations,1);assert.equal(refreshes,1);
  }
});
test('public page loaders use cached reads and runtime loading overlays are disabled', () => {
  for(const file of ['Today','Leads','Followups','Calls','ClientCallReport','ClientFactoryVisits','VisitManagement','Archive','Pipeline','BulkView','Webhooks','ConfigStages','ConfigDropdowns','ConfigFields','ConfigUsers']) assert.match(read('src/'+file+'.html'),/pagePreviewRead/);
  assert.match(read('src/AppUtils.html'),/function beginTableLoading[^]*?if \(window\.__PAGE_PREVIEW_READY\) return \(\) => \{\}/);
  assert.match(read('src/AppAuth.html'),/await preparePagePreviews\(defaultPage\)/);
});
test('only the current page blocks startup; remaining pages wait for the background worker', async () => {
  const f=runtime(), calls=[];
  f.c.App.user={};f.c.canNavigate=page=>['today','leads','calls'].includes(page);
  f.c.escapeHtml=String;f.c.navigator={onLine:true};f.c.refreshSheetMirror=()=>{};
  f.c.api._authedRead=async(fn,...args)=>{calls.push(fn);return f.cache.capture(fn,args,{rows:[fn]});};
  await f.c.preparePagePreviews('today');
  assert.deepEqual(calls,['apiGetTodayActivitySnapshot']);assert.equal(f.c.window.__PAGE_PREVIEW_READY,true);
  f.c.startPagePreviewBackground();assert.equal(calls.length,1,'scheduling the worker must not block rendering');
  vm.runInContext('pagePreviewPending = 1',f.c);await f.timers.shift()();assert.equal(calls.length,1,'foreground loading has priority');
  vm.runInContext('pagePreviewPending = 0',f.c);await f.timers.shift()();assert.equal(calls[1],'apiGetLeads');
});
