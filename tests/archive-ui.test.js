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
