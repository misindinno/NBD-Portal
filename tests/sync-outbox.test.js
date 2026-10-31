const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),crypto=require('node:crypto');
const {read}=require('./helpers/lead-cache-fixture');
function storage() {
  const data=new Map();return {data,fail:false,
    async list(i){return [...data.values()].filter(r=>r.user===i.user&&r.portal===i.portal).map(r=>structuredClone(r));},
    async enqueue(row){if(this.fail)throw Error('Quota');const old=[...data.values()].find(r=>r.user===row.user&&r.portal===row.portal&&r.fingerprint===row.fingerprint&&r.state!=='dismissed');if(old)return structuredClone(old);data.set(row.key,structuredClone(row));return row;},
    async patch(key,patch,attempt){const row=data.get(key);if(!row)return null;if(attempt!==undefined&&row.attempts!==attempt)return row;data.set(key,{...row,...patch});return data.get(key);},
    async claim(key,time){const r=data.get(key);if(!r||!['queued','retry','sending'].includes(r.state)||r.nextAttempt>time||r.leaseUntil>time)return null;const next={...r,state:'sending',attempts:r.attempts+1,leaseUntil:time+120000};data.set(key,next);return structuredClone(next);}
  };
}
const identity={portal:'p1',user:'u1',scope:'a'.repeat(64),syncEnabled:true};
test('conflicted lead does not block an independent remark, but dependent work stays queued',async()=>{
  const store=storage(),sent=[];
  for(const [id,lead,state] of [['a','L1','conflict'],['b','L1','queued'],['c','L2','queued']])store.data.set(id,{...identity,key:id,id,state,createdAt:sent.length,bases:[{type:'lead',id:lead}],attempts:0,nextAttempt:0,leaseUntil:0});
  const c=client(store,async item=>{sent.push(item.id);return {state:'committed',result:{}};},{online:()=>true});
  await c.drain();assert.deepEqual(sent,['c']);assert.equal(store.data.get('a').state,'conflict');assert.equal(store.data.get('b').state,'queued');
});
test('background remark acknowledges durable storage without waiting for the server',async()=>{
  const store=storage();let release;
  const c=client(store,()=>new Promise(resolve=>release=resolve),{online:()=>true});
  c.observe([{'Lead ID':'L1','Updated At':'x','Stage ID':'s','Assigned To':'u1'}, {'Lead ID':'L1','Follow-up ID':'F1','Updated At':'x',Status:'Open','Planned Date':'2026-10-31'}]);
  await assert.rejects(c.submit('apiMarkFollowupDoneDirect',['F1',{Remark:'Keep me'}],{background:true}),e=>e.code==='SYNC_PENDING'&&e.background===true);
  assert.equal(store.data.size,1);assert.equal((await c.list())[0].args[1].Remark,'Keep me');
  while(!release)await new Promise(r=>setTimeout(r,0));
  release({state:'committed',result:{}});await c.drain();
  assert.equal((await c.list())[0].state,'committed');
});
function client(store,send,options={}) {
  const c=vm.createContext({crypto:crypto.webcrypto,TextEncoder,Uint8Array,structuredClone,setTimeout,clearTimeout,setInterval,clearInterval,...options.timers});
  vm.runInContext(read('src/PortalSync.html').replace(/^<script>\s*/,'').split('const PortalSync =')[0],c);
  const value=c.createPortalSync({storage:store,send,...options});value.bind(identity);return value;
}
test('offline save persists before sending; a new browser session replays the same operation ID',async()=>{
  const store=storage();let sent=[];const first=client(store,async i=>{sent.push(i.id);return {state:'committed',result:'L1'};},{online:()=>false});
  await assert.rejects(first.submit('apiSaveLead',[{'Company Name':'Synthetic'}]),e=>e.code==='SYNC_PENDING');
  assert.equal(sent.length,0);const row=(await first.list())[0];
  const restarted=client(store,async i=>{sent.push(i.id);return {state:'committed',result:'L1'};},{online:()=>true});
  await restarted.drain();assert.deepEqual(sent,[row.id]);assert.equal((await restarted.list())[0].state,'committed');
});

test('submit joins an older drain then sends the newly enqueued command without a false pending result',async()=>{
  const store=storage();let release,started;const ready=new Promise(r=>started=r);
  const list=store.list.bind(store);let hold=true;
  store.list=async i=>{const rows=await list(i);if(hold){hold=false;started();await new Promise(r=>release=r);}return rows;};
  let calls=0;const c=client(store,async()=>{calls++;return {state:'committed',result:'saved'};},{online:()=>true});
  const draining=c.drain();await ready;
  const pending=c.submit('apiSaveLead',[{Phone:'9000000000'}]);
  while(!store.data.size)await new Promise(r=>setTimeout(r,0));
  release();await draining;assert.equal(await pending,'saved');assert.equal(calls,1);
});

test('cache refresh failure after a confirmed commit never requeues the saved remark',async()=>{
  const store=storage();let sends=0;
  const c=client(store,async()=>{sends++;return {state:'committed',result:'saved'};},{online:()=>true,committed:async()=>{throw Error('Cache unavailable');}});
  assert.equal(await c.submit('apiSaveLead',[{Phone:'9000000000'}]),'saved');
  await c.drain();assert.equal(sends,1);assert.equal((await c.list())[0].state,'committed');
});

test('pending watchers reconcile an already completed receipt and stop across account changes',async()=>{
  const store=storage(),timers=new Map();let next=0;
  const c=client(store,async()=>({state:'committed',result:'saved'}),{online:()=>true,timers:{
    setInterval:fn=>{timers.set(++next,fn);return next;},clearInterval:id=>timers.delete(id)
  }});
  await c.submit('apiSaveLead',[{Phone:'9000000000'}]);const row=(await c.list())[0];
  const events=[];c.watch(row.id,r=>events.push(r.state));
  await new Promise(r=>setTimeout(r,0));assert.deepEqual(events,['committed']);assert.equal(timers.size,0);
  store.data.set(row.key,{...row,state:'retry'});c.watch(row.id,r=>events.push(r.state));
  await new Promise(r=>setTimeout(r,0));assert.deepEqual(events,['committed','retry']);
  const tick=[...timers.values()][0];c.bind({...identity,user:'other'});await tick();
  assert.equal(timers.size,0);assert.equal(events.length,2);
});

test('pending watcher sees another tab commit and unsubscribe prevents stale form updates',async()=>{
  const store=storage(),ticks=new Map();let n=0;
  const c=client(store,async()=>{}, {online:()=>false,timers:{setInterval:fn=>{ticks.set(++n,fn);return n;},clearInterval:id=>ticks.delete(id)}});
  await assert.rejects(c.submit('apiSaveLead',[{Phone:'9000000000'}]));const row=(await c.list())[0],events=[];
  const stop=c.watch(row.id,r=>events.push(r.state));await new Promise(r=>setTimeout(r,0));
  await store.patch(row.key,{state:'committed',result:'saved in another tab'});
  await [...ticks.values()][0]();assert.deepEqual(events,['queued','committed']);assert.equal(ticks.size,0);
  stop();
  // The second watcher is stopped before its asynchronous initial read returns.
  let notified=false;const stopSecond=c.watch(row.id,()=>{notified=true;});stopSecond();
  await new Promise(r=>setTimeout(r,0));assert.equal(notified,false);
});
test('response loss retains the ID, exponential backoff applies, and a retry reconciles the receipt',async()=>{
  const store=storage();let time=0,calls=0,ids=[];
  const c=client(store,async item=>{ids.push(item.id);if(++calls===1)throw Error('Network lost');return {state:'committed',result:'L1'};},{online:()=>true,now:()=>time});
  await assert.rejects(c.submit('apiSaveLead',[{Phone:'9000000000'}]),/waiting to sync/);await c.drain();assert.equal(calls,1);
  time=70000;await c.drain();assert.equal(ids[0],ids[1]);assert.equal((await c.list())[0].state,'committed');
});

test('a missing RPC callback does not stall the queue and a late response cannot overwrite the retry result',async()=>{
  const store=storage();let release,time=0,calls=0;
  const c=client(store,()=>++calls===1?new Promise(resolve=>release=resolve):Promise.resolve({state:'committed',result:'confirmed'}),
    {online:()=>true,now:()=>time,confirmationWaitMs:10});
  await assert.rejects(c.submit('apiSaveLead',[{Phone:'9000000000'}]),/waiting to sync/);
  time=70000;await c.drain();release({state:'invalid',message:'late result'});
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal((await c.list())[0].state,'committed');assert.equal((await c.list())[0].result,'confirmed');
});
test('two tabs sharing one IndexedDB queue claim a command only once while its lease is live',async()=>{
  const store=storage();let release,started;const ready=new Promise(r=>started=r);let calls=0;
  const a=client(store,()=>{calls++;started();return new Promise(r=>release=()=>r({state:'committed',result:'L1'}));},{online:()=>true});
  const b=client(store,async()=>{calls++;return {state:'committed'};},{online:()=>true});
  const submitting=a.submit('apiSaveLead',[{Phone:'9000000000'}]);await ready;await b.drain();assert.equal(calls,1);release();assert.equal(await submitting,'L1');
});
test('different accounts and portals cannot view or replay another account queue',async()=>{
  const store=storage(),a=client(store,async()=>{throw Error('must not send');},{online:()=>false});
  await assert.rejects(a.submit('apiSaveLead',[{Phone:'9000000000'}]));a.bind({...identity,user:'u2'});assert.equal((await a.list()).length,0);
  a.bind({...identity,portal:'p2'});assert.equal((await a.list()).length,0);
});
test('quota failure does not claim a local save or send it to Sheets',async()=>{
  const store=storage();store.fail=true;let sent=0;const c=client(store,async()=>sent++,{online:()=>true});
  await assert.rejects(c.submit('apiSaveLead',[{Phone:'9000000000'}]),/Quota/);assert.equal(sent,0);
});
test('conflicts retain the input for review and stop dependent commands; unconfirmed saves cannot be dismissed',async()=>{
  const store=storage(),c=client(store,async()=>({state:'conflict',message:'Record changed'}),{online:()=>true});
  await assert.rejects(c.submit('apiSaveLead',[{Phone:'9000000000'}]),/Record changed/);
  const row=(await c.list())[0];assert.equal(row.args[0].Phone,'9000000000');await c.dismiss(row.key);assert.equal((await c.list())[0].args.length,0);
  const offline=client(store,async()=>{}, {online:()=>false});await assert.rejects(offline.submit('apiSaveLead',[{Phone:'9000000001'}]));
  await assert.rejects(offline.dismiss((await offline.list()).find(r=>r.state==='queued').key),/unconfirmed/);
});
test('no credentials enter the queue and existing records require an observed base',async()=>{
  const store=storage(),c=client(store,async()=>({state:'committed'}),{online:()=>true});
  await assert.rejects(c.submit('apiSaveLead',[{password:'secret'}]),/cannot enter/);
  await assert.rejects(c.submit('apiSaveLead',[{details:{'API Key':'secret'}}]),/cannot enter/);
  await assert.rejects(c.submit('apiSaveLead',[{'Lead ID':'L1'}]),/latest record/);
  assert.equal(store.data.size,0);
});
test('logout while a send is in flight cannot notify or hydrate the next login',async()=>{
  const store=storage();let release,started,commits=0;const ready=new Promise(r=>started=r);
  const c=client(store,()=>{started();return new Promise(r=>release=()=>r({state:'committed',result:'L1'}));},{online:()=>true,committed:()=>commits++});
  const pending=c.submit('apiSaveLead',[{Phone:'9000000000'}]);await ready;c.bind({...identity,user:'u2'});release();
  await assert.rejects(pending,/Session changed/);assert.equal(commits,0);assert.equal((await c.list()).length,0);
});
module.exports={storage,client};

test('schema failures pause without losing input, and repair retries the same operation ID',async()=>{
  const store=storage();let repaired=false,ids=[];
  const c=client(store,async item=>{ids.push(item.id);if(!repaired)throw Object.assign(new Error('The portal data configuration is invalid. Contact an administrator.'),{code:'DATA_SCHEMA_INVALID'});return {state:'committed',result:'saved'};},{online:()=>true});
  await assert.rejects(c.submit('apiSaveLead',[{Remark:'Keep my remark'}]),e=>e.code==='SYNC_PENDING');
  const row=(await c.list())[0];assert.equal(row.state,'paused');assert.equal(row.args[0].Remark,'Keep my remark');
  await c.drain();assert.equal(ids.length,1);
  repaired=true;await c.retry(row.key);
  assert.deepEqual(ids,[row.id,row.id]);assert.equal((await c.list())[0].state,'committed');
  assert.equal((await c.list())[0].errorCode,'');
});

test('legacy schema-invalid commands become retryable without replaying ordinary invalid input',async()=>{
  const store=storage();let sends=0;
  const c=client(store,async()=>{sends++;return {state:'committed',result:'saved'};},{online:()=>true});
  const old={key:'old',id:'original-reference',portal:'p1',user:'u1',scope:'a'.repeat(64),state:'invalid',attempts:1,
    args:[{Remark:'Existing remark'}],message:'apiSyncPush: The portal data configuration is invalid. Contact an administrator.'};
  store.data.set(old.key,structuredClone(old));
  await c.drain();assert.equal(sends,0);assert.equal(store.data.get(old.key).state,'paused');
  await c.retry(old.key);assert.equal(sends,1);assert.equal(store.data.get(old.key).id,old.id);
  store.data.set('validation',{...old,key:'validation',message:'Remark is required.'});
  await c.retry('validation');assert.equal(sends,1);assert.equal(store.data.get('validation').state,'invalid');
});

test('a legacy batch-limit failure can retry the same stored command after the index fix',async()=>{
  const store=storage();let sent;
  const c=client(store,async row=>{sent=row;return {state:'committed'};},{online:()=>true});
  store.data.set('batch',{key:'batch',id:'same-reference',portal:'p1',user:'u1',scope:'a'.repeat(64),state:'invalid',attempts:1,args:[{Remark:'Keep it'}],
    message:'apiSyncPush: Invalid sync batch size. Use a smaller batch.'});
  await c.drain();assert.equal(store.data.get('batch').state,'paused');
  await c.retry('batch');assert.equal(sent.id,'same-reference');assert.equal(sent.args[0].Remark,'Keep it');
  assert.equal(store.data.get('batch').state,'committed');
});
