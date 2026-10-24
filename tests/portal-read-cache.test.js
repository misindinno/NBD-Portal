'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const {moduleFixture,moduleClient}=require('./helpers/portal-cache-fixture');
const {read}=require('./helpers/lead-cache-fixture');
const plain=value=>JSON.parse(JSON.stringify(value));

test('Follow-ups cache preserves assigned-or-actor linked leads and legitimate duplicate history rows',async()=>{
  const f=moduleFixture(),b=moduleClient(f);
  const expected=f.c.getFollowupPageSnapshotFast_(f.state.user,{includeHistory:true});
  const actual=await b.client.get('apiGetFollowupPageSnapshot',{includeHistory:true});
  assert.deepEqual(plain({...actual,fetchMs:0}),plain({...expected,fetchMs:0}));
  assert.equal(actual.leads.length,2);assert.equal(actual.followupHistory.length,5);
  const before=b.requests;await b.client.get('apiGetFollowupPageSnapshot',{includeHistory:true});assert.equal(b.requests-before,1);
});
test('Today keeps its own lead/activity/history scopes and performs no index repair',async()=>{
  const f=moduleFixture(),b=moduleClient(f),result=await b.client.get('apiGetTodayActivitySnapshot');
  assert.equal(result.leads.length,1);assert.equal(result.followups.length,1);assert.equal(result.activityLogs.length,1);
  assert.equal(result.followupHistory.length,5);assert.equal(f.state.writes,0);
});
test('all Archive tabs reuse existing derived values with schema initialization disabled',async()=>{
  const f=moduleFixture(),b=moduleClient(f);
  for(const [api,source] of [['apiGetArchiveData','getArchiveData'],['apiGetArchiveSuggestions','getArchiveSuggestionsFast_'],['apiGetLostArchiveLeads','getLostArchiveLeads_']]){
    const expected=f.c[source](f.state.user,true),actual=await b.client.get(api);
    assert.deepEqual(plain(actual),plain(expected));
  }
  assert.equal(f.state.writes,0);
});
test('call report cache preserves exact counts and zero results while users stay fresh and unpersisted',async()=>{
  const f=moduleFixture(),b=moduleClient(f);
  const result=await b.client.get('apiGetClientCallReport',{page:1});
  assert.deepEqual(plain(result.totals),{connected:1,notPicked:1,totalCalls:2,whatsapp:1});
  assert.equal(result.items.length,1);assert.equal(result.total,1);
  assert.ok(!JSON.stringify([...b.storage.data.values()]).includes('User One'));
  f.tables.users[0].Name='Fresh user name';
  const before=b.requests,warm=await b.client.get('apiGetClientCallReport',{page:1});
  assert.equal(b.requests-before,1);assert.equal(warm.users[0].name,'Fresh user name');
  const empty=await b.client.get('apiGetClientCallReport',{search:'no-match'});
  assert.equal(empty.total,0);assert.equal(empty.totals.totalCalls,0);
  assert.equal(b.storage.data.size,1,'one bounded durable response per module, not every filter combination');
});
test('each module requires its exact grant on every warm read, including archive-dependent report filters',async()=>{
  for(const [api,grant] of [['apiGetFollowupPageSnapshot','Followups'],['apiGetArchiveData','Archive'],['apiGetClientCallReport','Reports']]){
    const f=moduleFixture(),b=moduleClient(f);await b.client.get(api);f.state.user.modules=f.state.user.modules.filter(m=>m!==grant);
    await assert.rejects(b.client.get(api),/CACHE_SCOPE_CHANGED|Permission denied/);assert.equal(b.locks,1);
  }
  const f=moduleFixture(),b=moduleClient(f);f.state.user.modules=['Reports'];b.client.bind(f.identity());
  await assert.rejects(b.client.get('apiGetClientCallReport',{archive:'all'}),/Archive permission/);
});
test('history option and report filters are revision-bound and never reuse a different query response',async()=>{
  const f=moduleFixture(),b=moduleClient(f);
  assert.equal((await b.client.get('apiGetFollowupPageSnapshot',{includeHistory:true})).followupHistory.length,5);
  assert.equal((await b.client.get('apiGetFollowupPageSnapshot',{includeHistory:false})).followupHistory.length,0);
  const current=await b.client.get('apiGetFollowupPageSnapshot',{includeHistory:true});assert.equal(current.followupHistory.length,5);
  const removed=f.tables.history.pop();assert.equal((await b.client.get('apiGetFollowupPageSnapshot',{includeHistory:true})).followupHistory.length,4);
  assert.equal(removed['History ID'],'h4');
});
test('module packet validation rejects malformed/duplicate positions without deduplicating source IDs',()=>{
  const f=moduleFixture(),b=moduleClient(f);
  const packed=f.c.portalCachePack_('today',{}, {leads:[{'Lead ID':'same'},{'Lead ID':'same'}]});
  assert.equal(b.c.portalCacheValidRecords(packed.records,3),true);
  packed.records[2].index=0;assert.equal(b.c.portalCacheValidRecords(packed.records,3),false);
});
test('unsupported modules and non-scalar queries cannot dispatch arbitrary APIs',()=>{
  const f=moduleFixture();
  assert.throws(()=>f.request({...f.identity(),kind:'apiSaveLead'}),/Invalid cache module/);
  assert.throws(()=>f.request({...f.identity(),kind:'visits',query:{search:{secret:'x'}}}),/Invalid cache query/);
});
test('inbound visit register cache preserves owner/host scope, server totals and optimistic-edit permissions',async()=>{
  const {fixture,modules}=require('./helpers/cfv-fixture');const f=fixture();
  f.c.Utilities.Charset={UTF_8:'utf8'};f.c.PropertiesService={getScriptProperties:()=>({getProperty:key=>['LEAD_READ_CACHE_ENABLED','PORTAL_READ_CACHE_ENABLED'].includes(key)?'true':null})};
  for(const file of ['LeadCacheService','PortalReadCacheService'])vm.runInContext(read('src/server/'+file+'.js'),f.c);
  assert.equal(f.call('apiClientFactoryVisitSave',f.payload()).success,true);
  const outside=f.payload({'Host ID':'host2'});assert.equal(f.call('apiClientFactoryVisitSave',outside).success,true);
  f.state.user={id:'host2',role:'SALES',modules};
  const adapter={identity:()=>f.c.leadCacheIdentity_(f.state.user),request:query=>{const r=f.call('apiGetPortalReadCachePage',query);if(!r.success)throw Error(r.error);return r.data;}};
  const b=moduleClient(adapter),expected=f.call('apiClientFactoryVisitList',{}).data;
  const actual=await b.client.get('apiClientFactoryVisitList',{});assert.deepEqual(plain(actual),expected);assert.equal(actual.total,1);
  assert.equal(actual.rows[0]['Host ID'],'host2');
  assert.ok(!JSON.stringify([...b.storage.data.values()]).includes('host1@example.test'));
});
test('report pages retain server-wide totals and date filters without merging same-name customers',async()=>{
  const f=moduleFixture(),b=moduleClient(f);
  f.state.rows=Array.from({length:60},(_,i)=>({'Lead ID':String(i).padStart(5,'0'),'Company Name':'Same company','Assigned To':'u1','Lead Status':'Open'}));
  const first=await b.client.get('apiGetClientCallReport',{page:1});
  const second=await b.client.get('apiGetClientCallReport',{page:2});
  assert.equal(first.items.length,50);assert.equal(second.items.length,10);assert.equal(first.total,60);assert.equal(second.total,60);
  assert.deepEqual(plain(first.totals),plain(second.totals));assert.equal(second.totals.totalCalls,3);
  const dated=await b.client.get('apiGetClientCallReport',{from:'2026-10-25'});
  assert.equal(dated.total,60);assert.equal(dated.totals.totalCalls,0);
});
test('generic module invalidation does not reuse pre-mutation or pre-reassignment snapshots',async()=>{
  const f=moduleFixture(),b=moduleClient(f);await b.client.get('apiGetTodayActivitySnapshot');
  f.state.rows[0]['Assigned To']='u2';f.tables.history=[];f.tables.followups=[];f.tables.activity=[];
  await b.client.invalidate();const result=await b.client.get('apiGetTodayActivitySnapshot');
  assert.equal(result.leads.length,0);assert.equal(result.followupHistory.length,0);assert.equal(result.activityLogs.length,0);
});
test('generic source restores read-only execution state even when a source read fails',()=>{
  const f=moduleFixture();f.c.getTodayActivitySnapshotFast_=()=>{throw Error('Read failed');};
  assert.throws(()=>f.request({...f.identity(),kind:'today'}),/Read failed/);
  assert.equal(vm.runInContext('PORTAL_CACHE_READ_ONLY_',f.c),false);
});
test('expanded screens are separately opt-in and do not activate with the Leads flag alone',()=>{
  const f=moduleFixture();f.c.PropertiesService={getScriptProperties:()=>({getProperty:key=>key==='LEAD_READ_CACHE_ENABLED'?'true':null})};
  const b=moduleClient(f);assert.equal(b.client.handles('apiGetTodayActivitySnapshot'),false);
  assert.throws(()=>f.request({...f.identity(),kind:'today'}),/CACHE_DISABLED/);
});
