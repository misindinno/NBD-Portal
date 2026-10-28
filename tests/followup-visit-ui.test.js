const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
function fixture() {
  const node=(extra={})=>({dataset:{},hidden:false,disabled:false,setAttribute(k,v){this[k]=v;},focus(){},...extra});
  const done=node({insertAdjacentHTML(){}}),fields=node(),button=node(),message=node(),cancel=node();
  const elements={date:node({value:'2026-10-28'}),remark:node({value:'A visit remark'}),visitType:node({value:'Office'})};
  const visit=node({elements,reportValidity:()=>true,querySelector:s=>({'fieldset':fields,'[type=submit]':button,'[data-visit-message]':message,'[data-visit-cancel]':cancel}[s])});
  const tabs=['remark','visit'].map(name=>node({dataset:{fuTab:name}}));
  const overlay=node({isConnected:true,remove(){this.isConnected=false;},querySelector:s=>s==='#fu-done-form'?done:visit,querySelectorAll:()=>tabs});
  const requests=[],notices=[];let token='a',reply=null,optionsError=null;
  const c=vm.createContext({crypto:{randomUUID:()=> 'stable-request-id-000000'},AuthToken:{get:()=>token},escapeHtml:String,toast:(...args)=>notices.push(args),
    api:{_authedRead:async(name,arg)=>{requests.push({name,arg});if(name==='apiGetFollowupVisitOptions'){if(optionsError)throw optionsError;return {types:['Office','Factory'],today:'2026-10-28'};}return await new Promise((resolve,reject)=>{reply={resolve,reject};});}}});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../src/FollowupVisitRemark.html'),'utf8').replace(/<\/?script>/g,''),c);
  c._mountFollowupRemarkTabs(overlay,'fu-001');
  const tick=()=>new Promise(resolve=>setImmediate(resolve));
  return {done,visit,fields,button,message,cancel,tabs,overlay,requests,notices,elements,tick,
    select:async i=>{tabs[i].onclick();await tick();},submit:()=>visit.onsubmit({preventDefault(){}}),
    reply:()=>reply,logout:()=>{token='b';},deny:()=>{optionsError=Object.assign(Error('Permission denied'),{code:'FORBIDDEN'});}};
}
test('tab navigation preserves values, performs no write and ignores hidden-form submissions',async()=>{
  const f=fixture();await f.select(1);assert.equal(f.done.hidden,true);assert.equal(f.visit.hidden,false);
  f.elements.remark.value='Draft';await f.select(0);assert.equal(f.elements.remark.value,'Draft');await f.submit();
  assert.equal(f.requests.length,1);assert.equal(f.requests[0].name,'apiGetFollowupVisitOptions');
  f.done.dataset.submitting='1';await f.select(1);assert.equal(f.overlay.dataset.followupTab,'remark');
});
test('double submit and tab switching during save cannot duplicate or complete the follow-up',async()=>{
  const f=fixture();await f.select(1);const saving=f.submit();await f.submit();await f.select(0);
  assert.equal(f.requests.filter(r=>r.name==='apiSaveFollowupVisit').length,1);assert.equal(f.overlay.dataset.followupTab,'visit');
  assert.equal(f.fields.disabled,true);f.reply().resolve({id:'v1'});await saving;
  assert.equal(f.overlay.isConnected,false);assert.equal(f.notices.length,1);
});
test('uncertain save retries the frozen request; validation rejection permits correction',async()=>{
  const f=fixture();await f.select(1);let saving=f.submit();f.reply().reject(Error('VISIT_COMMIT_UNCONFIRMED'));await saving;
  await f.select(0);assert.equal(f.overlay.dataset.followupTab,'visit');assert.equal(f.fields.disabled,true);
  saving=f.submit();assert.equal(f.requests.at(-1).arg,f.requests.at(-2).arg);
  f.reply().reject(Object.assign(Error('Invalid date'),{code:'VALIDATION_ERROR'}));await saving;
  assert.equal(f.fields.disabled,false);await f.select(0);assert.equal(f.overlay.dataset.followupTab,'remark');
});
test('cancel never saves and late responses after cancel or logout do not affect another dialog',async()=>{
  const f=fixture();await f.select(1);f.cancel.onclick();assert.equal(f.requests.length,1);await f.submit();assert.equal(f.requests.length,1);
  for(const close of [f=>f.cancel.onclick(),f=>f.logout()]){const f=fixture();await f.select(1);const saving=f.submit();close(f);f.reply().resolve({id:'v1'});await saving;assert.equal(f.notices.length,0);}
});
test('permission failure disables visit inputs; whitespace-only remarks do not submit',async()=>{
  const denied=fixture();denied.deny();await denied.select(1);assert.match(denied.message.textContent,/Permission denied/);await denied.submit();assert.equal(denied.requests.length,1);
  const f=fixture();await f.select(1);f.elements.remark.value='   ';await f.submit();assert.equal(f.requests.length,1);assert.match(f.message.textContent,/Enter a visit remark/);
});
