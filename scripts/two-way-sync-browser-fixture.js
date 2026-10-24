// Local synthetic browser integration test. No Google account, Sheet or customer data.
const http = require('node:http');
const { syncFixture } = require('../tests/helpers/sync-fixture');
const { read } = require('../tests/helpers/lead-cache-fixture');
let fixture = syncFixture();
function fresh() { fixture=syncFixture();const portal='synthetic-'+Date.now();fixture.c.ScriptApp.getScriptId=()=>portal; }
fresh();
const core = file => read(file).replace(/^<script>\s*/, '').split('const ' + (file.includes('PortalSync') ? 'PortalSync' : 'LeadReadCache') + ' =')[0];
const page = () => String.raw`<!doctype html><meta charset="utf-8"><title>Sheets ↔ IndexedDB verification</title>
<style>body{font:16px system-ui;max-width:900px;margin:40px auto;padding:20px;color:#172033}button{padding:12px;margin:5px}pre{white-space:pre-wrap;background:#f3f5fa;padding:22px;border-radius:12px}h1{font-size:26px}</style>
<h1>Sheets ↔ IndexedDB verification</h1><p>Synthetic data only. Real browser IndexedDB and production sync code; simulated Google Sheets batch API.</p>
<button id="run">Run sync checks</button><button id="queue">Queue offline change for reload test</button><button id="resume">Resume after reload</button><pre id="output">Ready</pre>
<script>${core('src/IndexedDbCache.html')}${core('src/PortalSync.html')}
const output=document.getElementById('output');
const log=text=>output.textContent+='\n'+text;
const assert=(condition,message)=>{if(!condition)throw Error(message);log('PASS: '+message);};
async function rpc(path,payload={}){const r=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});const v=await r.json();if(v.success===false)throw Object.assign(Error(v.error),{code:v.code});return v;}
async function identity(){return rpc('/identity');}
const send=command=>rpc('/push',command).then(r=>r.data);
function manager(id,online){const c=createPortalSync({storage:createPortalOutbox(indexedDB),send,online});c.bind(id);return c;}
document.getElementById('run').onclick=async()=>{output.textContent='Running…';try{
 await rpc('/reset');const id=await identity();id.user='u1';
 // Unique synthetic user/portal namespace per fixture run; no production origin touched.
 const store=createPortalOutbox(indexedDB),first=manager(id,()=>false);
 try{await first.submit('apiSaveLead',[{'Company Name':'Browser '+crypto.randomUUID(),Phone:'9000000099','Stage ID':'S1','Assigned To':'u1'}]);throw Error('Expected pending state');}catch(e){if(e.code!=='SYNC_PENDING')throw e;}
 const queued=(await first.list()).filter(r=>r.state==='queued');assert(queued.length===1,'offline command persisted before any server write');
 assert((await rpc('/rows')).leads.length===1,'offline command did not claim a Sheet commit');
 const restarted=manager(id,()=>true);await restarted.drain();
 assert((await restarted.list()).find(r=>r.id===queued[0].id).state==='committed','new sync instance recovered the durable queue');
 assert((await rpc('/rows')).leads.length===2,'queued lead and initial follow-up committed');
 const records=await rpc('/rows');restarted.observe(records);await rpc('/fail-after');
 try{await restarted.submit('apiMarkFollowupDoneDirect',['F1',{'Done Date':'2026-10-24','Next Follow-up Date':'2026-10-27',Remark:'Browser retry test','Was Productive':'Yes'}]);}catch(e){if(e.code!=='SYNC_PENDING')throw e;}
 assert((await rpc('/rows')).history.length===1,'response lost after atomic save left exactly one history');
 const retry=(await restarted.list()).find(r=>r.state==='retry');await restarted.retry(retry.key);
 assert((await rpc('/rows')).history.length===1,'same-ID replay recovered the receipt without duplicate history');
 const cache=createLeadReadCache({storage:createLeadSnapshotStorage(indexedDB),request:q=>rpc('/pull',q).then(r=>r.data)});cache.bind(id);await cache.load();await rpc('/edit');
 const changed=await cache.load({force:true});assert(changed.find(r=>r['Lead ID']==='L1')['Company Name']==='Edited in synthetic Sheet','Sheet edit reached IndexedDB through a verified delta');
 assert(cache.status().state==='verified-delta','only changed records were reconciled');
 const other=manager({...id,user:'different-user'},()=>true);assert((await other.list()).length===0,'another user cannot see the pending queue');
 // Atomic claim through two independently opened real IndexedDB connections.
 const item={key:'claim-'+crypto.randomUUID(),portal:id.portal,user:id.user,state:'queued',fingerprint:crypto.randomUUID(),attempts:0,nextAttempt:0,leaseUntil:0};await store.enqueue(item);
 const claims=await Promise.all([store.claim(item.key,Date.now()),createPortalOutbox(indexedDB).claim(item.key,Date.now())]);
 assert(claims.filter(Boolean).length===1,'two connections cannot concurrently claim the same queued save');await store.patch(item.key,{state:'dismissed'});
 log('ALL BROWSER CHECKS PASSED');
 }catch(e){log('FAIL: '+e.stack);}};
document.getElementById('queue').onclick=async()=>{output.textContent='Queueing reload test…';try{const id=await identity(),c=manager(id,()=>false);await c.submit('apiSaveLead',[{'Company Name':'Reload '+crypto.randomUUID(),Phone:'9000000088','Stage ID':'S1','Assigned To':'u1'}]);}catch(e){log(e.message);log('Reload this page, then click Resume after reload.');}};
document.getElementById('resume').onclick=async()=>{output.textContent='Resuming…';try{const c=manager(await identity(),()=>true);await c.drain();const rows=await c.list();assert(rows.some(r=>r.state==='committed'&&r.args[0]?.Phone==='9000000088'),'page reload preserved and synchronized the pending command');log('RELOAD RECOVERY PASSED');}catch(e){log('FAIL: '+e.stack);}};
</script>`;
new (require('node:vm').Script)(page().split('<script>')[1].split('</script>')[0]);
http.createServer(async(req,res)=>{
  if(req.method==='GET'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end(page());return;}
  let body='';for await(const chunk of req){body+=chunk;if(body.length>1500000){res.writeHead(413);res.end();return;}}
  try{const input=JSON.parse(body||'{}');let result;
    if(req.url==='/reset'){fresh();result={ok:true};}
    else if(req.url==='/identity')result=fixture.c.leadCacheIdentity_(fixture.state.user);
    else if(req.url==='/push')result=fixture.call(input);
    else if(req.url==='/rows')result={leads:fixture.rows('LEAD_MASTER'),followups:fixture.rows('FOLLOWUPS').map(fixture.c._normalizeFollowupRow),history:fixture.rows('FOLLOWUP_HISTORY')};
    else if(req.url==='/fail-after'){fixture.state.after=true;result={ok:true};}
    else if(req.url==='/edit'){const t=fixture.tables.get('LEAD_MASTER');t.data[1][t.data[0].indexOf('Company Name')]='Edited in synthetic Sheet';result={ok:true};}
    else if(req.url==='/pull')result=fixture.c.apiGetLeadCachePage('valid',input);
    else throw Error('Unknown fixture route');
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify(result));
  }catch(error){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({success:false,error:error.message}));}
}).listen(8769,'127.0.0.1',()=>console.log('Synthetic sync fixture: http://127.0.0.1:8769'));
