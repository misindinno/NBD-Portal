const test=require('node:test'), assert=require('node:assert/strict'), vm=require('node:vm');
const {read,serverFixture,browserFactory,memoryStorage}=require('./helpers/lead-cache-fixture');
function setup(count=205,afterResponse=()=>{}) {
  const f=serverFixture(count);vm.runInContext(read('src/server/SyncDeltaService.js'),f.c);f.c.syncEnabled_=()=>true;
  const store=memoryStorage(), responses=[];let time=0;
  const client=browserFactory().createLeadReadCache({storage:store,now:()=>time,request:async q=>{const p=f.request(q);responses.push(p);afterResponse(p,f);return p;}});
  client.bind(f.identity());return {f,store,client,responses,tick:()=>time+=16000};
}
test('Sheet edit plus removal downloads only changed records and tombstones, with an atomic complete snapshot',async()=>{
  const {f,client,responses,tick,store}=setup();await client.load();const before=store.puts;
  f.state.rows[0]['Company Name']='Edited in Sheet';f.state.rows.splice(1,1);tick();responses.length=0;
  const rows=await client.load();assert.equal(rows.length,204);assert.equal(rows[0]['Company Name'],'Edited in Sheet');
  assert.equal(responses[0].delta,true);assert.equal(responses[0].changes.length,2);assert.equal(responses[0].changes.filter(c=>c.removed).length,1);
  assert.equal(store.puts,before+1);assert.equal(client.status().state,'verified-delta');
});
test('authorized warm navigation is local for 15 seconds; explicit refresh and expired lease verify online',async()=>{
  const {client,responses,tick}=setup();await client.load();responses.length=0;
  await client.load();assert.equal(responses.length,0);await client.load({force:true});assert.equal(responses.length,1);
  tick();await client.load();assert.equal(responses.length,2);
});
test('delta pagination preserves the complete 305-record snapshot',async()=>{
  const {f,client,responses,tick}=setup(305);await client.load();f.state.rows.forEach(row=>row.City='Changed');tick();responses.length=0;
  const result=await client.load();assert.equal(result.length,305);assert.equal(responses.filter(p=>p.delta).length,4);
  assert.ok(result.every(row=>row.City==='Changed'));
});

test('a Sheet edit during delta pagination discards partial changes and rebuilds a consistent snapshot',async()=>{
  let edit=true;
  const {f,client,tick,store}=setup(305,(page,f)=>{
    if(page.delta && edit){edit=false;f.state.rows[200].City='Edited during pagination';}
  });
  await client.load();const before=store.puts;
  f.state.rows.forEach(row=>row.City='Initial change');tick();
  const result=await client.load();
  assert.equal(result[200].City,'Edited during pagination');assert.equal(result[0].City,'Initial change');
  assert.equal(store.puts,before+1);assert.equal(client.status().state,'verified-network');
});

test('module deltas preserve array order, duplicate history, metadata totals and deleted entries',async()=>{
  const {moduleFixture,moduleClient}=require('./helpers/portal-cache-fixture');
  const f=moduleFixture();vm.runInContext(read('src/server/SyncDeltaService.js'),f.c);f.c.syncEnabled_=()=>true;
  const responses=[],request=f.request;f.request=query=>{const page=request(query);responses.push(page);return page;};
  const {client,storage}=moduleClient(f);await client.get('apiGetTodayActivitySnapshot',{});const before=storage.puts;
  f.tables.history[0].Remark='Sheet remark';f.tables.history.splice(2,1);
  f.tables.activity.push({'Activity ID':'a2','Lead ID':'00000','Created By':'u1'});
  client.verifyNext();const result=await client.get('apiGetTodayActivitySnapshot',{});
  vm.runInContext('PORTAL_CACHE_READ_ONLY_ = true;',f.c);
  const expected=f.c.withServerContext_(()=>f.c.portalCacheSource_('today',{}));
  // Directory/timing metadata is fresh and excluded from durable snapshots.
  for(const key of ['leads','followups','followupHistory','activityLogs']) {
    if(expected[key])assert.deepEqual(JSON.parse(JSON.stringify(result[key])),JSON.parse(JSON.stringify(expected[key])));
  }
  assert.equal(result.followupHistory.filter(row=>row['History ID']==='h1').length,2);
  assert.ok(responses.some(page=>page.delta));
  assert.equal(storage.puts,before+1);
});
test('assignment removal is a tombstone and cannot be recovered by supplying a foreign manifest',async()=>{
  const {f,client,tick}=setup(2);await client.load();f.state.rows[0]['Assigned To']='u2';tick();
  assert.equal((await client.load()).length,1);
  const id=f.identity(),response=f.request({portal:id.portal,user:id.user,scope:id.scope,delta:true,manifest:[['00000','0'.repeat(64)]]});
  assert.ok(response.changes.find(change=>change.key==='00000').removed);assert.equal(response.changes.filter(c=>c.value?.['Assigned To']==='u2').length,0);
});
test('malformed manifests, replayed cursors and mismatched manifest continuation are rejected',()=>{
  const {f}=setup(205),id=f.identity(),query={portal:id.portal,user:id.user,scope:id.scope,delta:true,manifest:[]};
  assert.throws(()=>f.request({...query,manifest:[['x','invalid']]}),/Invalid/);
  const first=f.request(query);assert.throws(()=>f.request({...query,revision:first.revision,cursor:first.nextCursor,manifest:[['new','0'.repeat(64)]]}),/REVISION_CHANGED/);
});
