'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const {read}=require('./helpers/lead-cache-fixture');
const lead={'Lead ID':'lead','Company Name':'Client'}, followup={'Follow-up ID':'fu','Lead ID':'lead'};

test('remark form reuses its displayed snapshot, then IndexedDB, before any server request',async()=>{
  const source=read('src/Followups.html');
  const helper=source.slice(source.indexOf('async function _getFollowupDialogSnapshot'),source.indexOf('async function _getFollowupPageSnapshot'));
  for(const location of ['memory','disk','server']) {
    const snapshot={leads:[lead],followups:[followup]};let calls=0,reads=0;
    const c=vm.createContext({_fuPageSnapshot:location==='memory'?snapshot:null,
      PagePreview:{enabled:()=>true,get:async()=>{reads++;return location==='disk'?{data:snapshot}:null;}},
      _getFollowupPageSnapshot:async()=>{calls++;return snapshot;}});
    vm.runInContext(helper,c);assert.equal((await c._getFollowupDialogSnapshot('fu')).followups[0],followup);
    assert.equal(calls,location==='server'?1:0);if(location==='memory')assert.equal(reads,0);
  }
});

function dialogFixture(history=true) {
  const calls=[],modals=[];
  const nodes={'#tab-history':{innerHTML:''},'#tab-log':{innerHTML:''}};
  const overlay={isConnected:true,querySelector:s=>nodes[s]||null,remove(){this.isConnected=false;}};
  let generation=1;
  const c=vm.createContext({
    _fuPageSnapshot:{leads:[lead],followups:[followup],includeHistory:history,followupHistory:[{'Lead ID':'lead',Discussion:'Saved remark'}]},
    AppCache:{getRows:()=>[],isLoaded:()=>false},App:{config:{stages:[]},user:{role:'ADMIN'}},
    PagePreview:{generation:()=>generation,get:async()=>null},PortalSync:{observe(){}},
    api:{getLeadFieldValues:()=>new Promise(()=>{}),getFollowupHistory:async filter=>{calls.push(['history',filter]);return [{Discussion:'Fresh remark'}];},
      getLeadActivityLogs:async filter=>{calls.push(['logs',filter]);return [{Remark:'log'}];}},
    showModal:html=>{modals.push(html);return overlay;},hasModule:()=>true,_configOptionsMap:()=>({}),_buildFollowupContext:()=>({}),
    safeColor:()=>'',escapeHtml:String,leadPriorityLabel:String,buildLeadCustomFieldSummary:()=>'',_canAddFollowup:()=>false,_isNBDPortal:()=>false,
    _isArchivedLeadForUI:()=>false,buildLeadFormHTML:()=>'',_mountFsrVisitHistory:()=>{},initLeadCustomFields:()=>{},_initStateCityDropdowns:()=>{},
    renderIcons:()=>{},icon:()=>'',_followupHistoryTable:rows=>'history:'+JSON.stringify(rows),_activityLogTable:rows=>'logs:'+JSON.stringify(rows)
  });
  vm.runInContext(read('src/LeadDetail.html').replace(/^<script>\s*/,'').replace(/<\/script>\s*$/,''),c);
  return {c,calls,modals,overlay,nodes,invalidate:()=>generation++};
}

test('lead history opens immediately from displayed rows, without waiting for activity logs',async()=>{
  const f=dialogFixture();const opened=f.c.openLeadDetail('lead');
  assert.equal(f.modals.length,1);assert.match(f.modals[0],/history:.*Saved remark/);
  await opened;assert.equal(f.calls.length,1);assert.equal(f.calls[0][0],'history');
  f.overlay._loadActivityLogs();await new Promise(setImmediate);
  assert.equal(f.calls.length,2);assert.equal(f.calls[1][0],'logs');assert.equal(f.calls[1][1].leadId,'lead');
  f.overlay._loadActivityLogs();assert.equal(f.calls.length,2);
});

test('cold detail dialogs show mirrored history and activity before pending network refreshes finish',async()=>{
  const f=dialogFixture(false);let releaseHistory,releaseLogs;
  f.c.SheetMirror={enabled:()=>true,previewLeadDetail:async()=>({data:{lead,
    followupHistory:[{'Lead ID':'lead',Remark:'IndexedDB history'}],activityLogs:[{'Lead ID':'lead',Remark:'IndexedDB activity'}]}})};
  f.c.api.getFollowupHistory=()=>new Promise(r=>releaseHistory=r);
  f.c.api.getLeadActivityLogs=()=>new Promise(r=>releaseLogs=r);
  await f.c.openLeadDetail('lead');
  assert.match(f.modals[0],/IndexedDB history/);assert.match(f.modals[0],/IndexedDB activity/);
  assert.doesNotMatch(f.modals[0],/>Loading…</);
  f.overlay._loadActivityLogs();await new Promise(setImmediate);
  releaseHistory([{Remark:'Updated history'}]);releaseLogs([{Remark:'Updated activity'}]);
  await new Promise(setImmediate);
  assert.match(f.nodes['#tab-history'].innerHTML,/Updated history/);assert.match(f.nodes['#tab-log'].innerHTML,/Updated activity/);
});

test('a session change during the IndexedDB join cannot open the previous user detail',async()=>{
  const f=dialogFixture(false);let release;
  f.c.SheetMirror={enabled:()=>true,previewLeadDetail:()=>new Promise(r=>release=r)};
  const opening=f.c.openLeadDetail('lead');f.invalidate();release({data:{lead,followupHistory:[],activityLogs:[]}});
  await opening;assert.equal(f.modals.length,0);assert.equal(f.calls.length,0);
});

test('uncached history loads only this client and does not wait for a hidden tab',async()=>{
  const f=dialogFixture(false);await f.c.openLeadDetail('lead');await new Promise(setImmediate);
  assert.equal(f.calls.length,1);assert.equal(f.calls[0][0],'history');assert.equal(f.calls[0][1].leadId,'lead');
  assert.match(f.nodes['#tab-history'].innerHTML,/Fresh remark/);
});

test('a snapshot of active leads does not hide an archived client history',async()=>{
  const f=dialogFixture(true);
  await f.c.openLeadDetail('archived',{'Lead ID':'archived','Company Name':'Archived client'});
  await new Promise(setImmediate);
  assert.equal(f.calls.length,1);assert.equal(f.calls[0][0],'history');assert.equal(f.calls[0][1].leadId,'archived');
  assert.match(f.nodes['#tab-history'].innerHTML,/Fresh remark/);
});

test('late history cannot update a dismissed dialog or changed session',async()=>{
  for(const reason of ['closed','session']) {
    const f=dialogFixture(false);let release;
    f.c.api.getFollowupHistory=()=>new Promise(resolve=>release=resolve);
    await f.c.openLeadDetail('lead');await new Promise(setImmediate);
    if(reason==='closed') f.overlay.remove();else f.invalidate();
    release([{Discussion:'Late data'}]);await new Promise(setImmediate);
    assert.equal(f.nodes['#tab-history'].innerHTML,'');
  }
});
