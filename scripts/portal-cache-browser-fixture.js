// Loopback-only, synthetic module cache fixture. Real domain readers and cache/RPC
// adapters; actual Visit/Report views, compact data previews for legacy worklists.
'use strict';
const http=require('node:http');
const {moduleFixture}=require('../tests/helpers/portal-cache-fixture');
const {fixture:visitFixture}=require('../tests/helpers/cfv-fixture');
const {read}=require('../tests/helpers/lead-cache-fixture');
const f=moduleFixture(),v=visitFixture(),port=8768;
f.state.user={id:'host1',role:'ADMIN',modules:[]};v.c.ScriptApp.getScriptId=()=>f.state.portal;
v.call('apiClientFactoryVisitSave',v.payload());
f.c._cfvUser_=()=>f.c._requireModule('ClientFactoryVisits');f.c._cfvList_=(user,query)=>v.c._cfvList_(user,query);
let offline=false;
const shell=()=>`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>NBD module cache synthetic checks</title><style>body{font:15px system-ui;margin:20px;color:#172033;background:#f5f7fb}button,input,select{font:inherit;padding:8px;border:1px solid #bdc5d5;border-radius:6px}nav{display:flex;gap:8px;flex-wrap:wrap}table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:8px;border-bottom:1px solid #ddd}.card{background:white;border-radius:10px;margin-top:14px}pre{white-space:pre-wrap;overflow-wrap:anywhere}.table-wrap{overflow:auto}</style></head><body><h1>Module cache tests — synthetic data only</h1>
<nav><button id="login">Sign in</button><button data-kind="followups">Follow-ups</button><button data-kind="today">Today</button><button data-kind="archive">Archive</button><button data-kind="archiveSuggestions">Suggestions</button><button data-kind="archiveLost">Lost</button><button data-kind="visits">Visits</button><button data-kind="callReport">Call Report</button><button id="refresh">Refresh</button><button id="offline">Toggle network failure</button><button id="revoke">Revoke access</button><button id="restore">Restore server</button><button id="logout">Log out</button></nav>
<p id="notice" role="status"></p><pre id="metrics"></pre><main id="content"></main><script>
const el=id=>document.getElementById(id),escapeHtml=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let state={user:null,currentPage:'today',config:{}},calls=0,bytes=0,current='today';
const Store={getState:()=>state,dispatch:(name,value)=>{if(name==='RESET_PRIVATE')state={user:null,currentPage:'today',config:{}};if(name==='SET_USER')state.user=value;}};
const showLoginOverlay=message=>el('notice').textContent=message||'Sign in required';const skeletonPage=()=>'<p>Verifying online…</p>';const toast=message=>el('notice').textContent=message;
const google={script:{get run(){let success,failure;const chain=new Proxy({},{get:(_,key)=>{if(key==='withSuccessHandler')return fn=>{success=fn;return chain;};if(key==='withFailureHandler')return fn=>{failure=fn;return chain;};return async(...args)=>{try{calls++;const r=await fetch('/rpc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:key,args})});const text=await r.text();bytes+=text.length;success(JSON.parse(text));}catch(e){failure(e);}};}});return chain;}}};
</script>${read('src/Cache.html')}${read('src/AppCore.html')}${read('src/IndexedDbCache.html')}${read('src/PortalReadCache.html')}${read('src/ClientFactoryVisits.html')}${read('src/ClientCallReport.html')}
<script>
const endpoints={followups:'apiGetFollowupPageSnapshot',today:'apiGetTodayActivitySnapshot',archive:'apiGetArchiveData',archiveSuggestions:'apiGetArchiveSuggestions',archiveLost:'apiGetLostArchiveLeads'};
async function show(kind=current){current=kind;calls=0;bytes=0;const start=performance.now();state.currentPage=kind==='visits'?'clientfactoryvisits':kind==='callReport'?'callreport':kind.startsWith('archive')?'archive':kind;try{
if(kind==='visits')await loadClientFactoryVisits();else if(kind==='callReport')await loadClientCallReport();else {el('content').innerHTML=skeletonPage();const data=await api._authedRead(endpoints[kind],{includeHistory:true});el('content').innerHTML='<section class="card" style="padding:18px"><h2>'+escapeHtml(kind)+'</h2><pre>'+escapeHtml(JSON.stringify(data,null,2))+'</pre></section>';}
}catch(e){el('content').textContent='Could not verify: '+e.message;}el('metrics').textContent=JSON.stringify({kind,calls,bytes,elapsedMs:Math.round(performance.now()-start)});}
async function login(){const r=await(await fetch('/identity')).json();if(!r.authorized){showLoginOverlay('Access revoked');return;}AuthToken.set('synthetic-session');Store.dispatch('SET_USER',r.user);LeadReadCache.bind(r.identity);PortalReadCache.bind(r.identity);showLoginOverlay('Authenticated synthetic admin');await show();}
el('login').onclick=login;el('refresh').onclick=()=>show();el('logout').onclick=()=>lockPrivateReadCache();document.querySelectorAll('[data-kind]').forEach(button=>button.onclick=()=>show(button.dataset.kind));
for(const id of ['offline','revoke','restore'])el(id).onclick=async()=>{await fetch('/control',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:id})});if(id!=='restore')await show();else showLoginOverlay('Server restored; sign in again');};
if(AuthToken.get())login();else showLoginOverlay();
</script></body></html>`;
http.createServer(async(req,res)=>{
res.setHeader('Cache-Control','no-store');
if(req.method==='GET'){if(req.url==='/identity'){res.setHeader('Content-Type','application/json');return res.end(JSON.stringify({identity:f.identity(),user:f.state.user,authorized:f.state.authorized}));}if(req.url!=='/'){res.statusCode=404;return res.end('Not found');}res.setHeader('Content-Type','text/html;charset=utf-8');return res.end(shell());}
if(req.headers.origin&&req.headers.origin!==`http://127.0.0.1:${port}`){res.statusCode=403;return res.end('Forbidden');}
let body='';for await(const chunk of req){body+=chunk;if(body.length>20000){res.statusCode=413;return res.end('Too large');}}
res.setHeader('Content-Type','application/json');try{const input=JSON.parse(body);if(req.url==='/control'){if(input.action==='offline')offline=!offline;if(input.action==='revoke')f.state.authorized=false;if(input.action==='restore'){offline=false;f.state.authorized=true;}return res.end('{"ok":true}');}
if(req.url==='/rpc'){if(offline)throw Error('Synthetic network failure');if(input.args[0]!=='synthetic-session'||!f.state.authorized)throw Error('SESSION_EXPIRED');let data;
if(input.name==='apiGetPortalReadCachePage')data=f.request(input.args[1]);
else if(['apiClientFactoryVisitOptions','apiClientFactoryVisitHistory'].includes(input.name)){const result=v.call(input.name,input.args[1]);if(!result.success)throw Error(result.error);data=result.data;}
else if(input.name==='apiExportClientCallReport'){const result=f.c.apiExportClientCallReport('synthetic-session',input.args[1]);if(!result.success)throw Error(result.error);data=result.data;}
else throw Error('Synthetic fixture read-only RPC not supported');return res.end(JSON.stringify({success:true,data}));}
res.statusCode=404;res.end('{}');}catch(e){res.end(JSON.stringify({success:false,error:e.message,code:e.code}));}
}).listen(port,'127.0.0.1',()=>console.log('Synthetic module cache fixture: http://127.0.0.1:'+port));
