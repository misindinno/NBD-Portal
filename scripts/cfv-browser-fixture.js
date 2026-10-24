// Local-only synthetic browser harness. Never loads credentials or live Sheets.
'use strict';
const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const {fixture,modules,root}=require('../tests/helpers/cfv-fixture');
const f=fixture();
const allowed=new Set(['apiClientFactoryVisitOptions','apiClientFactoryVisitList','apiClientFactoryVisitSave','apiClientFactoryVisitHistory','apiClientFactoryVisitInitialize']);
const port=Number(process.env.CFV_TEST_PORT || 8766);
const shell=()=>`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic inbound visits test</title><style>body{font:15px system-ui;background:#f5f7fb;color:#172033;margin:0;padding:16px}*{box-sizing:border-box}.card{background:white;border:1px solid #dbe3ef;border-radius:12px}.btn{padding:10px 14px;border-radius:7px;border:1px solid #cbd5e1;background:white;cursor:pointer}.btn-primary{background:#4338ca;color:white}.form-control{font:inherit;padding:10px;border:1px solid #cbd5e1;border-radius:6px}.toolbar{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:16px}#toast{color:#166534}</style></head><body><h1>Synthetic test — no live data</h1><div class="toolbar"><button data-control="failBefore">Fail next save before commit</button><button data-control="failAfter">Lose next save response</button><button data-control="admin">Use admin</button><button data-control="reader">Use read-only</button></div><p id="toast" role="status"></p><main id="content"></main><script>
const App={currentPage:'clientfactoryvisits'};const el=id=>document.getElementById(id);const skeletonPage=()=>'<p>Loading...</p>';const escapeHtml=value=>String(value==null?'':value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));const toast=value=>el('toast').textContent=value;
const api={_authedRead:async(name,arg)=>{const response=await fetch('/rpc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,arg})});const result=await response.json();if(!result.success){const e=Error(result.error);e.code=result.code;throw e;}return result.data;}};
document.querySelectorAll('[data-control]').forEach(button=>button.onclick=async()=>{await fetch('/control',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:button.dataset.control})});toast('Synthetic control: '+button.dataset.control);if(['reader','admin'].includes(button.dataset.control))await loadClientFactoryVisits();});
</script>${fs.readFileSync(path.join(root,'src/ClientFactoryVisits.html'),'utf8')}<script>loadClientFactoryVisits();</script></body></html>`;
http.createServer(async(req,res)=>{
  res.setHeader('Cache-Control','no-store');
  if(req.method==='GET'){
    res.setHeader('Content-Type','text/html;charset=utf-8');
    if(req.url==='/mobile')return res.end('<!doctype html><title>390px synthetic mobile visit test</title><h1>390px mobile layout — synthetic data</h1><iframe title="Mobile visits" src="/app" width="390" height="1000" style="border:1px solid #999"></iframe>');
    if(!['/','/app'].includes(req.url)){res.statusCode=404;return res.end('Not found');}return res.end(shell());
  }
  if(req.headers.origin && req.headers.origin!==`http://127.0.0.1:${port}`){res.statusCode=403;return res.end('Forbidden');}
  let body='';for await(const chunk of req){body+=chunk;if(body.length>20000){res.statusCode=413;return res.end('Too large');}}
  res.setHeader('Content-Type','application/json');
  try{const input=JSON.parse(body);if(req.url==='/rpc' && allowed.has(input.name))return res.end(JSON.stringify(f.call(input.name,input.arg)));
    if(req.url==='/control'){
      if(input.action==='failBefore')f.state.failBefore=true;
      else if(input.action==='failAfter')f.state.failAfter=true;
      else if(input.action==='admin')f.state.user={id:'host1',role:'ADMIN',modules:[]};
      else if(input.action==='reader')f.state.user={id:'host1',role:'VIEWER',modules};
      else throw Error('Invalid control');return res.end(JSON.stringify({ok:true}));}
    res.statusCode=404;res.end('{}');
  }catch(error){res.statusCode=400;res.end(JSON.stringify({success:false,error:error.message}));}
}).listen(port,'127.0.0.1',()=>console.log(`Synthetic visit browser fixture: http://127.0.0.1:${port}`));
