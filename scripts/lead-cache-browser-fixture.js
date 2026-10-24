// Local synthetic cache/integration fixture. No credentials, Google APIs or live data.
// Uses the actual cache, RPC adapter and Leads loader; a small native list replaces
// Tabulator so this fixture requires no third-party assets or network access.
'use strict';
const http = require('node:http');
const { serverFixture, read } = require('../tests/helpers/lead-cache-fixture');
const f = serverFixture(205), port = 8767;
let offline = false;
const shell = () => `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>NBD synthetic IndexedDB pilot</title><style>body{font:15px system-ui;background:#f5f7fb;color:#172033;margin:20px}button,input{font:inherit;padding:8px;border:1px solid #bbc4d5;border-radius:6px}nav{display:flex;gap:8px;flex-wrap:wrap}section{background:white;border:1px solid #dbe3ef;padding:12px;border-radius:10px;margin-top:16px}li{padding:5px}pre{white-space:pre-wrap;word-break:break-word}</style></head><body>
<h1 id="page-title">Synthetic Leads cache</h1><p>No live data. 205 synthetic leads. Actual cache/RPC/loader, lightweight list renderer.</p>
<nav><button id="signin">Sign in synthetic staff</button><button id="refresh">Refresh Leads</button><button id="logout">Log out all test tabs</button><button data-action="edit">Direct Sheet edit</button><button data-action="delete">Delete first lead</button><button data-action="revoke">Revoke access</button><button data-action="restore">Restore server access</button><button data-action="offline">Toggle network failure</button><button id="quota">Toggle storage failure</button><button id="storage-test">Run storage checks</button><button id="save">Confirmed server save</button></nav>
<p id="login" role="status"></p><pre id="metrics"></pre><pre id="checks"></pre><main id="content"></main><script>
const el=id=>document.getElementById(id);let state={user:null,currentPage:'leads',config:{}};
const Store={getState:()=>state,dispatch:(name,payload)=>{if(name==='RESET_PRIVATE')state={user:null,currentPage:'leads',config:{}};else if(name==='SET_USER')state.user=payload;}};
let rpcCount=0,rpcBytes=0;const google={script:{get run(){let success,failure;const chain=new Proxy({},{get:(_target,key)=>{
if(key==='withSuccessHandler')return fn=>{success=fn;return chain;};if(key==='withFailureHandler')return fn=>{failure=fn;return chain;};
return async(...args)=>{try{rpcCount++;const response=await fetch('/rpc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:key,args})});const text=await response.text();rpcBytes+=text.length;success(JSON.parse(text));}catch(error){failure(error);}};}});return chain;}}};
function showLoginOverlay(message){el('login').textContent=message||'Sign in to load private records';}
const escapeHtml=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const setContentLoading=()=>el('content').textContent='Verifying online and loading complete snapshot…';
const beginTableLoading=()=>()=>{};
</script>${read('src/Cache.html')}${read('src/AppCore.html')}${read('src/IndexedDbCache.html')}${read('src/Leads.html')}
<script>
_renderLeadsTable=rows=>{el('content').innerHTML='<section id="leads-page"><label>Search synthetic leads <input id="lead-search"></label><p id="lead-row-count"></p><ul id="lead-table"></ul></section>';el('lead-search').oninput=applyLeadFilters;leadTable={};};
applyLeadFilters=()=>{const search=(el('lead-search')?.value||'').toLowerCase(),rows=AppCache.getRows('leads').filter(row=>row['Company Name'].toLowerCase().includes(search));el('lead-row-count').textContent=rows.length+' matching of '+AppCache.getRows('leads').length;el('lead-table').innerHTML=rows.slice(0,10).map(row=>'<li>'+escapeHtml(row['Lead ID']+' · '+row['Company Name'])+'</li>').join('');};
async function refresh(){rpcCount=0;rpcBytes=0;const start=performance.now();await loadLeads(true);el('metrics').textContent=JSON.stringify({...LeadReadCache.status(),rpcCount,rpcBytes,elapsedMs:Math.round(performance.now()-start)},null,2);}
async function signIn(){AuthToken.set('synthetic-session');const response=await fetch('/identity');const result=await response.json();if(!result.authorized){showLoginOverlay('Server access revoked');return;}Store.dispatch('SET_USER',result.user);LeadReadCache.bind(result.identity);el('login').textContent='Authenticated synthetic staff';await refresh();}
el('signin').onclick=signIn;el('refresh').onclick=refresh;el('logout').onclick=()=>lockPrivateReadCache();
document.querySelectorAll('[data-action]').forEach(button=>button.onclick=async()=>{await fetch('/control',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:button.dataset.action})});el('checks').textContent='Synthetic control: '+button.dataset.action;if(button.dataset.action!=='restore')await refresh();});
const originalTransaction=IDBDatabase.prototype.transaction;let storageFail=false;
el('quota').onclick=async()=>{storageFail=!storageFail;IDBDatabase.prototype.transaction=storageFail?function(){throw Error('Synthetic quota failure');}:originalTransaction;el('checks').textContent='Storage failure: '+storageFail;await refresh();};
el('save').onclick=async()=>{await api._authedRead('apiSaveLead',{'Lead ID':'00000','Company Name':'Confirmed synthetic server save'});await refresh();};
el('storage-test').onclick=async()=>{try{const store=createLeadSnapshotStorage(indexedDB);await store.clear();await store.put({key:'synthetic-test',rows:[],cursor:null,complete:true});if(!(await store.get('synthetic-test')).complete)throw Error('Atomic read failed');const pending=store.put({key:'late-test'});store.cancel();let rejected=false;try{await pending;}catch(_){rejected=true;}if(!rejected||await store.get('late-test'))throw Error('Cancelled write survived');await store.clear();if(await store.get('synthetic-test'))throw Error('Clear failed');el('checks').textContent='PASS: real IndexedDB atomic snapshot, cancelled write, clear and recovery';}catch(error){el('checks').textContent='FAIL: '+error.message;}};
if(AuthToken.get())signIn();else showLoginOverlay();
</script></body></html>`;
http.createServer(async (req, res) => {
  res.setHeader('Cache-Control','no-store');
  if(req.method==='GET') {
    if(req.url==='/identity') {res.setHeader('Content-Type','application/json');return res.end(JSON.stringify({identity:f.identity(),user:f.state.user,authorized:f.state.authorized}));}
    if(req.url!=='/') {res.statusCode=404;return res.end('Not found');}
    res.setHeader('Content-Type','text/html;charset=utf-8');return res.end(shell());
  }
  if(req.headers.origin && req.headers.origin!==`http://127.0.0.1:${port}`) {res.statusCode=403;return res.end('Forbidden');}
  let body='';for await(const chunk of req){body+=chunk;if(body.length>20000){res.statusCode=413;return res.end('Too large');}}
  res.setHeader('Content-Type','application/json');
  try {
    const input=JSON.parse(body);
    if(req.url==='/control') {
      if(input.action==='edit') f.state.rows[0]['Company Name']='Direct synthetic Sheet edit';
      else if(input.action==='delete') f.state.rows.shift();
      else if(input.action==='revoke') f.state.authorized=false;
      else if(input.action==='restore') {f.state.authorized=true;offline=false;}
      else if(input.action==='offline') offline=!offline;
      else throw Error('Unknown synthetic control');
      return res.end(JSON.stringify({ok:true}));
    }
    if(req.url==='/rpc') {
      if(offline) throw Error('Synthetic offline failure');
      let result;
      if(input.name==='apiGetLeadCachePage') result=f.call(input.args[1],input.args[0]);
      else if(input.name==='apiSaveLead' && input.args[0]==='synthetic-session' && f.state.authorized) {
        const row=f.state.rows.find(row=>row['Lead ID']===input.args[1]['Lead ID']);if(!row)throw Error('Lead not found');
        row['Company Name']=input.args[1]['Company Name'];result={success:true,data:row['Lead ID']};
      } else throw Error('Unknown synthetic RPC');
      return res.end(JSON.stringify(result));
    }
    res.statusCode=404;res.end('{}');
  } catch(error) {res.end(JSON.stringify({success:false,error:error.message}));}
}).listen(port,'127.0.0.1',()=>console.log('Synthetic IndexedDB fixture: http://127.0.0.1:'+port));
