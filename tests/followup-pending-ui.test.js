const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const {read}=require('./helpers/lead-cache-fixture');

function fixture() {
  let callback,mutation,stopped=0,disconnected=0,renders=0;
  const notices=[],applied=[],controls=[{disabled:false},{disabled:false}],button={disabled:false},nodes=[];
  const overlay={isConnected:true,remove(){this.isConnected=false;}};
  const form={querySelectorAll:()=>controls,append:(...items)=>nodes.push(...items)};
  const context=vm.createContext({Promise,
    document:{body:{},createElement:()=>({setAttribute(){}})},
    MutationObserver:class {constructor(fn){mutation=fn;}observe(){}disconnect(){disconnected++;}},
    PortalSync:{watch(id,fn){assert.equal(id,'op-1');callback=fn;return ()=>stopped++;}},
    showPortalSyncQueue(){},toast:(...args)=>notices.push(args),App:{currentPage:'followups'},window:{},
    _applyFollowupDoneResult:result=>applied.push(result),_renderFUTab:()=>{renders++;return Promise.resolve();}
  });
  const source=read('src/FollowupForms.html');
  vm.runInContext(source.slice(source.indexOf('function _finishFollowupDoneSave('),source.indexOf('function _applyFollowupSaveResult(')),context);
  context._watchPendingFollowupSave(overlay,form,button,{operationId:'op-1',syncState:'retry',message:'Waiting for confirmation'});
  return {context,overlay,form,button,nodes,notices,applied,controls,update:row=>callback(row),detach:()=>mutation(),stops:()=>stopped,disconnects:()=>disconnected,renders:()=>renders};
}
test('queued remark stays disabled and automatically closes with confirmed history after a late commit',()=>{
  const f=fixture();assert.ok(f.controls.every(c=>c.disabled));assert.equal(f.button.disabled,true);
  assert.match(f.nodes[0].textContent,/op-1/);
  f.update({state:'sending'});assert.match(f.nodes[0].textContent,/Syncing/);
  const result={history:{'History ID':'H1',Remark:'Existing submission'}};
  f.update({state:'committed',result});assert.equal(f.overlay.isConnected,false);
  assert.deepEqual(f.applied,[result]);assert.equal(f.renders(),1);assert.ok(f.stops());assert.ok(f.disconnects());
  assert.match(f.notices[0][0],/saved in Google Sheets/);
});
test('rejected or paused commands remain reviewable without enabling duplicate submission',()=>{
  const f=fixture();f.update({state:'conflict',message:'Record changed'});
  assert.equal(f.button.disabled,true);assert.equal(f.overlay.isConnected,true);assert.match(f.nodes[0].textContent,/Record changed/);
  f.update({state:'dismissed'});assert.equal(f.overlay.isConnected,false);assert.equal(f.applied.length,0);
});
test('closing a queued form unsubscribes and a late receipt does not update a different screen',()=>{
  const f=fixture();f.overlay.remove();f.detach();f.update({state:'committed',result:{history:{}}});
  assert.ok(f.stops());assert.equal(f.applied.length,0);assert.equal(f.notices.length,0);
});
test('render failure after a successful save is reported as a display issue, never a failed write',()=>{
  const f=fixture();f.context._renderFUTab=()=>{throw Error('Display unavailable');};
  f.update({state:'committed',result:{history:{}}});
  assert.equal(f.overlay.isConnected,false);assert.match(f.notices.at(-1)[0],/Remark saved. Refresh/);
});
