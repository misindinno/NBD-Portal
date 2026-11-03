const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const {read}=require('./helpers/lead-cache-fixture');
function fixture(){
 let session='original',watch,removed=0;const notices=[];
 const c=vm.createContext({window:{},document:{querySelectorAll:()=>[{remove(){removed++;}}]},Set,clearTimeout,setTimeout,
  AuthToken:{get:()=>session},PortalSync:{watch:(_id,cb)=>{watch=cb;}},toast:(...args)=>notices.push(args),
  App:{config:{userNameMap:{}}}});
 vm.runInContext(read('src/Archive.html').match(/<script>([\s\S]*?)<\/script>/)[1],c);
 return {c,notices,emit:r=>watch(r),login:v=>session=v,removed:()=>removed};
}
test('archive pending save updates UI once after a confirmed commit and never for another login',()=>{
 const f=fixture();let applied=0;
 assert.equal(f.c._archWatchPending({code:'SYNC_PENDING',operationId:'one',syncState:'retry'},()=>applied++),true);
 f.emit({state:'retry'});assert.equal(applied,0);
 f.emit({state:'committed'});f.emit({state:'committed'});assert.equal(applied,1);
 f.c._archWatchPending({code:'SYNC_PENDING',operationId:'two'},()=>applied++);
 f.login('different');f.emit({state:'committed'});assert.equal(applied,1);
 assert.equal(f.c._archWatchPending({code:'SYNC_PENDING',operationId:'three',syncState:'conflict'},()=>{}),false);
});
test('account reset removes archived and trash memory, selection and editor state',()=>{
 const f=fixture();vm.runInContext("_archTabs.archived.rows=[{'Lead ID':'private'}];_archTabs.trash.rows=[{'Lead ID':'trashed'}];_archTabs.archived.selected.add('private');_archBulkState={cancelled:false};",f.c);
 f.c.resetArchiveState();
 assert.equal(vm.runInContext('_archTabs.archived.rows',f.c),null);
 assert.equal(vm.runInContext('_archTabs.trash.rows',f.c),null);
 assert.equal(vm.runInContext('_archTabs.archived.selected.size',f.c),0);
 assert.equal(vm.runInContext('_archBulkState.cancelled',f.c),true);assert.equal(f.removed(),1);
});

test('background archive refresh preserves selection and prunes only removed leads',async()=>{
 const f=fixture(),c=f.c;
 c.window.__PAGE_PREVIEW_READY=true;
 Object.assign(c,{el:()=>({}),PortalReadCache:{enabled:()=>false}});
 c.document.querySelectorAll=()=>[];
 vm.runInContext("_archTabs.archived.selected=new Set(['keep','gone']);_archRenderTools=()=>{};_archRenderKpis=()=>{};_archRenderCard=()=>{};_archRenderLive=()=>{};",c);
 await c._archActivateTab('archived',true,{archived:[{'Lead ID':'keep'},{'Lead ID':'new'}]});
 assert.deepEqual([...vm.runInContext('_archTabs.archived.selected',c)],['keep']);
});

test('archive uses updated sheet mirror rather than a stale page snapshot',async()=>{
 const f=fixture(),c=f.c;c.window.__PAGE_PREVIEW_READY=true;c.document.querySelectorAll=()=>[];
 Object.assign(c,{el:()=>({}),PortalReadCache:{enabled:()=>true},pagePreviewRead:async()=>({archived:[]}),
 SheetMirror:{enabled:()=>true,previewArchiveData:async()=>({data:{archived:[{'Lead ID':'newly-archived'}]}})}});
 vm.runInContext('_archRenderTools=()=>{};_archRenderKpis=()=>{};_archRenderCard=()=>{};',c);
 await c._archActivateTab('archived',true);
 assert.equal(vm.runInContext('_archTabs.archived.rows[0]["Lead ID"]',c),'newly-archived');
});

test('restore queues against the displayed archived version, not the old active record',async()=>{
 const f=fixture();let observed,called=false;
 Object.assign(f.c,{Swal:{fire:async()=>({isConfirmed:true})},api:{restoreArchivedLead:async()=>{
   assert.equal(observed['Is Archived'],true);called=true;
 }}});
 f.c.PortalSync.observe=(row,replace)=>{assert.equal(replace,true);observed=row;};
 vm.runInContext("_archTabs.archived.rows=[{'Lead ID':'one','Is Archived':true,'Updated At':'new'}];_archApplyRestored=()=>{};",f.c);
 await f.c._restoreArchivedLead('one');assert.equal(called,true);
});

test('archive mutation closes after durable enqueue but applies only confirmed commit',async()=>{
 const f=fixture();let closed=0,applied=0;
 await f.c._archRunMutation(async()=>{throw {code:'SYNC_PENDING',operationId:'one',syncState:'queued'};},()=>applied++,()=>closed++);
 assert.equal(closed,1);assert.equal(applied,0);
 f.emit({state:'conflict',error:'changed'});assert.equal(applied,0);
 assert.match(f.notices.at(-1)[0],/needs review/);
 f.emit({state:'committed'});f.emit({state:'committed'});assert.equal(applied,1);
});

test('failed archive keeps record and dialog recoverable; account switch ignores late result',async()=>{
 const f=fixture();let applied=0,closed=0;
 await f.c._archRunMutation(async()=>{throw Error('denied');},()=>applied++,()=>closed++);
 assert.equal(applied,0);assert.equal(closed,0);assert.equal(f.notices.at(-1)[0],'denied');
 await f.c._archRunMutation(async()=>{f.login('other');return {};},()=>applied++,()=>closed++);
 assert.equal(applied,0);assert.equal(closed,0);
});

test('bulk archive accounts for pending and failures without a blocking backdrop',async()=>{
 const f=fixture();Object.assign(f.c,{escapeHtml:s=>s,icon:()=>'',setTimeout:()=>{}});
 vm.runInContext('_archProgressOpen=()=>{};_archProgressRender=()=>{};',f.c);
 let applied;
 await f.c._archBulkRun(['a','b','c'],{verb:'Archiving',doneVerb:'archived',chunk:3,exec:async()=>({done:['a'],pending:1,failed:1,errors:['denied']}),after:ids=>applied=ids});
 assert.deepEqual(Array.from(applied),['a']);
 const html=f.c._archProgressCardHTML();
 assert.match(html,/<strong>3<\/strong> of 3/);assert.match(html,/1 waiting for sync/);assert.match(html,/denied/);
 const css=read('src/Archive.html').match(/\.arch-prog-overlay \{([^}]+)\}/)[1];
 assert.match(css,/background: transparent/);assert.doesNotMatch(css,/inset: 0/);
});

test('opening progress keeps batch state and renders content instead of an empty layer',()=>{
 const f=fixture();let attached,removed=0;
 f.c.document.getElementById=()=>attached||{remove(){removed++;}};
 f.c.document.createElement=()=>({innerHTML:'',remove(){}});
 f.c.document.body={appendChild:n=>{attached=n;}};
 Object.assign(f.c,{icon:()=>'',renderIcons:()=>{}});
 vm.runInContext("_archBulkState={total:2,done:0,failed:0,pending:0,errors:[],minimized:true,verb:'Archiving'}",f.c);
 f.c._archProgressOpen();
 assert.equal(removed,1);assert.equal(vm.runInContext('_archBulkState.total',f.c),2);
 assert.match(attached.innerHTML,/Archiving 0\/2/);
 assert.match(attached.className,/min/);
});
