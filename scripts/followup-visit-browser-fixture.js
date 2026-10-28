// Loopback-only synthetic fixture; never calls Google Sheets or a deployed portal.
const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const {followupVisitFixture}=require('../tests/helpers/followup-visit-fixture');
const f=followupVisitFixture(),root=path.resolve(__dirname,'..'),port=8772;
let doneCalls=0,visitCalls=0;
const read=name=>fs.readFileSync(path.join(root,'src',name),'utf8');
const shell=()=>`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>NBD synthetic follow-up tabs</title>${read('CSS.html')}</head><body style="padding:18px"><h1>Synthetic follow-up test</h1><button id="open">Open Follow Up Done</button><button data-control="failAfter">Lose save response</button><button data-control="reader">Use viewer</button><button data-control="admin">Use admin</button><button id="counts">Check saved counts</button><pre id="result"></pre><div id="content"></div><script>
const App={currentPage:'followups',user:{id:'host1',role:'ADMIN'},config:{stages:[],allStages:[],_allConfigs:[],leadFields:[]}};
const AuthToken={get:()=> 'synthetic-session'},windowState={};
const el=id=>document.getElementById(id),icon=()=>'',renderIcons=()=>{};
const escapeHtml=value=>String(value==null?'':value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const remarkHtml=escapeHtml,formatDate=String,localDateInputValue=()=>new Date().toISOString().slice(0,10);
const toast=text=>el('result').textContent=typeof text==='string'?text:text.message;
const _fuPlannedDate=()=>localDateInputValue(),_buildFollowupContext=()=>({}),_decorateFollowup=r=>r,_fuIsFinalStage=()=>false;
const _getFollowupDialogSnapshot=async()=>({followups:[{'Follow-up ID':'fu-001','Lead ID':'001',Discussion:'Discuss samples',Status:'Open'}],leads:[{'Lead ID':'001','Company Name':'Synthetic Client','Contact Person':'Test customer'}],followupHistory:[]});
const _renderFUTab=async()=>{},Swal={fire:async info=>toast(info.text)};
let _fuPageSnapshot=null;
const setButtonLoading=(b,text)=>{b.dataset.label=b.textContent;b.textContent=text;b.disabled=true;},resetButtonLoading=b=>{b.textContent=b.dataset.label;b.disabled=false;};
const rpc=async(name,arg)=>{const r=await fetch('/rpc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,arg})});const v=await r.json();if(!v.success)throw Object.assign(Error(v.error),{code:v.code});return v.data;};
const api={_authedRead:rpc,markFollowupDoneDirect:(id,payload)=>rpc('syntheticDone',{id,payload})};
</script>${read('AppForms.html')}${read('LeadCustomFields.html')}${read('FollowupForms.html')}${read('FollowupVisitRemark.html')}<script>
el('open').onclick=()=>openMarkFollowupDoneForm('fu-001');
el('counts').onclick=async()=>el('result').textContent=JSON.stringify(await rpc('counts'));
document.querySelectorAll('[data-control]').forEach(b=>b.onclick=async()=>{await rpc('control',b.dataset.control);toast(b.textContent);});
</script></body></html>`;
http.createServer(async(req,res)=>{
  res.setHeader('Cache-Control','no-store');
  if(req.method==='GET'){
    res.setHeader('Content-Type','text/html;charset=utf-8');
    if(req.url==='/mobile')return res.end('<!doctype html><title>390px follow-up tabs</title><iframe title="Mobile dialog" src="/" width="390" height="950"></iframe>');
    if(req.url!=='/'){res.statusCode=404;return res.end('Not found');}return res.end(shell());
  }
  if(req.url!=='/rpc'||req.headers.origin!==`http://127.0.0.1:${port}`){res.statusCode=403;return res.end('Forbidden');}
  let body='';for await(const part of req){body+=part;if(body.length>20000){res.statusCode=413;return res.end();}}
  res.setHeader('Content-Type','application/json');
  try{
    const {name,arg}=JSON.parse(body);let result;
    if(['apiSaveFollowupVisit','apiGetFollowupVisitOptions'].includes(name)){if(name==='apiSaveFollowupVisit')visitCalls++;result=f.call(name,arg);}
    else if(name==='syntheticDone'){doneCalls++;result={success:true,data:{}};}
    else if(name==='counts')result={success:true,data:{doneCalls,visitCalls,visits:f.records()}};
    else if(name==='control'){
      if(arg==='failAfter')f.state.failAfter=true;
      else if(arg==='reader')f.state.user={id:'host1',role:'VIEWER',modules:f.grants};
      else if(arg==='admin')f.state.user={id:'host1',role:'ADMIN',modules:[]};
      else throw Error('Unknown control');result={success:true};
    }else throw Error('Unknown test RPC');
    res.end(JSON.stringify(result));
  }catch(error){res.statusCode=400;res.end(JSON.stringify({success:false,error:error.message}));}
}).listen(port,'127.0.0.1',()=>console.log('Synthetic follow-up tabs: http://127.0.0.1:'+port));
