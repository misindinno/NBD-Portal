// Synthetic-only, loopback integration check using the real IndexedDB adapter.
const http = require('node:http');
const { mirrorFixture } = require('../tests/helpers/sheet-mirror-fixture');
const { read } = require('../tests/helpers/lead-cache-fixture');
let f = mirrorFixture();
function reset() {
  f = mirrorFixture();
  f.add('FOLLOWUP_HISTORY',['History ID','Lead ID','Done By','Remark'],Array.from({length:2105},(_,i)=>({'History ID':'DUP','Lead ID':'L1','Done By':'u1',Remark:'row '+i})));
}
reset();
const core = read('src/IndexedDbCache.html').replace(/^<script>\s*/, '').split('const LeadReadCache =')[0];
const mirror = read('src/SheetMirror.html').replace(/^<script>\s*/, '').split('const SheetMirror =')[0];
const view = read('src/SheetMirrorView.html').replace(/^<script>\s*/, '').replace(/<\/script>\s*$/, '');
const page = `<!doctype html><meta charset="utf-8"><title>Whole-sheet IndexedDB verification</title>
<style>body{font:16px system-ui;max-width:1000px;margin:32px auto;color:#172033}button{padding:12px;margin:6px}pre{background:#f1f5f9;padding:24px;white-space:pre-wrap}</style>
<h1>Whole-sheet IndexedDB verification</h1><p>Synthetic records only. Real portal storage and sync code; simulated Sheets source.</p>
<button id="run">Run full mirror checks</button><button id="reload-test">Verify saved data after reload</button><button id="preview">Open Sheet Data preview</button><pre id="output">Ready</pre><div id="content"></div>
<script>${core}\n${mirror}
const output=document.getElementById('output');
const log=text=>output.textContent+='\\n'+text;
const assert=(condition,message)=>{if(!condition)throw Error(message);log('PASS: '+message);};
async function rpc(endpoint,query={}){const response=await fetch('/rpc',{method:'POST',body:JSON.stringify({endpoint,query})});const value=await response.json();if(value.error)throw Object.assign(Error(value.error),{code:value.code});return value;}
const manager=(changed=()=>{})=>createSheetMirror({request:rpc,storage:createSheetMirrorStorage(indexedDB),changed});
let SheetMirror; const App={currentPage:'fixture'}; const el=id=>document.getElementById(id);
const escapeHtml=value=>String(value==null?'':value).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
const refreshSheetMirror=()=>{if(SheetMirror)void SheetMirror.syncAll().catch(e=>log(e.message));};
${view}
document.getElementById('preview').onclick=async()=>{App.currentPage='sheetdata';SheetMirror=manager(renderSheetMirrorStatus);SheetMirror.bind(await rpc('identity'));loadSheetMirror();};
async function countStore(name){return new Promise((resolve,reject)=>{const req=indexedDB.open('nbd-sheet-mirror',1);req.onsuccess=()=>{const db=req.result,tx=db.transaction(name,'readonly'),r=tx.objectStore(name).count();r.onsuccess=()=>resolve(r.result);tx.oncomplete=()=>db.close();};req.onerror=()=>reject(req.error);});}
document.getElementById('run').onclick=async()=>{output.textContent='Running…';try{
await rpc('reset'); const id=await rpc('identity'); const first=manager();first.bind(id);await first.syncAll(true);
assert(first.status().sheets.filter(s=>s.state==='synced').length===14,'all 14 authorized business tables completed');
assert(await countStore('FOLLOWUP_HISTORY')===2105,'all 2,105 history rows are separate IndexedDB records');
let data=await first.readSheet('FOLLOWUP_HISTORY');assert(data.headers.join('|')==='History ID|Lead ID|Done By|Remark','actual header order retained');
assert(data.rows[0].cells[0]===data.rows[2104].cells[0]&&data.rows[2104].rowNumber===2106,'duplicate IDs retain distinct physical rows');
const restarted=manager();restarted.bind(id);data=await restarted.readSheet('FOLLOWUP_HISTORY');assert(data.rows.length===2105,'new browser client recovers persisted complete table');
await rpc('edit');await restarted.syncAll(true);data=await restarted.readSheet('FOLLOWUP_HISTORY');
assert(data.rows[0].cells[3]==='Edited in Sheet'&&data.headers.at(-1)==='Added column','Sheet edit and new column reach the local schema');
await rpc('delete');await restarted.syncAll(true);assert(await countStore('FOLLOWUP_HISTORY')===2104,'Sheet deletion removes the local row');
await rpc('otherUser');restarted.bind(await rpc('identity'));await restarted.syncAll(true);
assert((await restarted.readSheet('LEAD_MASTER')).rows.length===0,'different user cannot read previous user’s leads');
assert(await countStore('FOLLOWUP_HISTORY')===0,'account switch purges prior private rows');
await restarted.clear();assert(await countStore('LEAD_MASTER')===0,'logout clears the mirror without touching the command outbox');
await rpc('reset');const saved=manager();saved.bind(await rpc('identity'));await saved.syncAll(true);
log('ALL REAL INDEXEDDB CHECKS PASSED. Reload and click Verify saved data after reload.');
}catch(e){log('FAIL: '+e.stack);}};
document.getElementById('reload-test').onclick=async()=>{output.textContent='Checking reload…';try{
assert(await countStore('FOLLOWUP_HISTORY')===2105,'complete rows survived a real page reload');
const c=manager();c.bind(await rpc('identity'));assert((await c.readSheet('FOLLOWUP_HISTORY')).rows.length===2105,'persisted table reverified against current access');log('RELOAD CHECK PASSED');
}catch(e){log('FAIL: '+e.stack);}};
</script>`;
new (require('node:vm').Script)(page.split('<script>')[1].split('</script>')[0]);
http.createServer(async(req,res)=>{
  if(req.method==='GET'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end(page);return;}
  let body='';for await(const chunk of req){body+=chunk;if(body.length>2000000){res.writeHead(413);res.end();return;}}
  try {const {endpoint,query}=JSON.parse(body);let result;
    if(endpoint==='reset'){reset();result={ok:true};}
    else if(endpoint==='identity')result=f.identity();
    else if(endpoint==='edit'){const t=f.tables.get('FOLLOWUP_HISTORY');t.data[0].push('Added column');t.data[1][3]='Edited in Sheet';result={ok:true};}
    else if(endpoint==='delete'){f.tables.get('FOLLOWUP_HISTORY').data.splice(2,1);result={ok:true};}
    else if(endpoint==='otherUser'){f.state.user={...f.state.user,id:'u2',role:'SALES',modules:['Leads','Followups']};result={ok:true};}
    else result=f.request(endpoint,query);
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify(result));
  }catch(e){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({error:e.message,code:e.code}));}
}).listen(8771,'127.0.0.1',()=>console.log('Sheet mirror fixture: http://127.0.0.1:8771'));
