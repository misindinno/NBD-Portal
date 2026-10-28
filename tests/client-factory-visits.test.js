'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {fixture,modules,root}=require('./helpers/cfv-fixture');

test('sheet date cells remain transport-safe in visit lists, date filters, history and edits',()=>{
  const f=fixture();
  const created=f.call('apiClientFactoryVisitSave',f.payload()).data;
  const visits=f.tables.get('CLIENT_FACTORY_VISITS'),events=f.tables.get('CLIENT_FACTORY_VISIT_EVENTS');
  const set=(table,key,value)=>table[1][table[0].indexOf(key)]=value;
  set(visits,'Planned Start',new Date('2026-01-01T04:30:00Z'));
  set(visits,'Planned End',new Date('2026-01-01T05:30:00Z'));
  set(visits,'Created At',new Date('2025-12-31T12:00:00Z'));
  set(events,'Created At',new Date('2025-12-31T12:00:00Z'));
  // Inspect raw endpoint output: JSON round-tripping in the fixture would hide
  // the Date objects that google.script.run rejects in production.
  const transportSafe=value=>{
    assert.ok(!(value instanceof Date),'Raw Date cannot cross google.script.run');
    if(value&&typeof value==='object')Object.values(value).forEach(transportSafe);
  };
  const result=f.c.apiClientFactoryVisitList('valid',{from:'2026-01-01',to:'2026-01-01'});
  assert.equal(result.success,true);assert.equal(result.data.total,1);transportSafe(result);
  const row=result.data.rows[0];
  assert.equal(row['Planned Start'],'2026-01-01T10:00');
  assert.equal(row['Planned End'],'2026-01-01T11:00');
  assert.equal(row['Created At'],'2025-12-31T12:00:00.000Z');
  const history=f.c.apiClientFactoryVisitHistory('valid',created.id);
  assert.equal(history.success,true);transportSafe(history);
  assert.equal(history.data[0].at,'2025-12-31T12:00:00.000Z');
  assert.equal(f.call('apiClientFactoryVisitSave',f.payload({...row,id:created.id,version:1})).success,true);
});
test('new permissions default denied and existing Visits grants do not authorize this module',()=>{
  const f=fixture();
  for(const role of ['MANAGER','SALES','USER','VIEWER'])assert.ok(!f.c.getRoleModules(role).includes('ClientFactoryVisits'));
  f.state.user={id:'host1',role:'MANAGER',modules:['VisitManagement','Visits','Leads']};
  for(const api of ['apiClientFactoryVisitList','apiClientFactoryVisitOptions','apiClientFactoryVisitInitialize','apiClientFactoryVisitSave','apiClientFactoryVisitHistory'])assert.equal(f.call(api,{}).success,false);
  assert.equal(f.writes.length,0);
  assert.equal(f.c.apiClientFactoryVisitList('',{}).success,false);
});
test('initializer is explicit, additive, admin-only and limited to two new tables',()=>{
  const f=fixture({initialized:false});
  assert.equal(f.call('apiClientFactoryVisitList',{}).data.initialized,false);assert.equal(f.writes.length,0);
  f.state.user={id:'host1',role:'MANAGER',modules};assert.equal(f.initialize().success,false);
  f.state.user={id:'host1',role:'ADMIN',modules:[]};assert.equal(f.initialize().success,true);
  const p=f.payload();assert.equal(f.call('apiClientFactoryVisitSave',p).success,true);
  const before=f.records();f.initialize();assert.deepEqual(f.records(),before);
  assert.deepEqual([...f.tables.keys()],['CLIENT_FACTORY_VISITS','CLIENT_FACTORY_VISIT_EVENTS']);
});
test('creation and audit event commit atomically; duplicate request is idempotent',()=>{
  const f=fixture(),p=f.payload();const first=f.call('apiClientFactoryVisitSave',p),again=f.call('apiClientFactoryVisitSave',p);
  assert.equal(first.success,true,first.error);assert.equal(again.data.repeated,true);assert.equal(f.records().length,1);assert.equal(f.tables.get('CLIENT_FACTORY_VISIT_EVENTS').length,2);
  assert.equal(f.call('apiClientFactoryVisitSave',{...p,Purpose:'Changed'}).success,false);
  assert.equal(f.writes.filter(w=>w.batch).length,1);
});
test('failures before/after atomic write safely retry without partial or duplicate records',()=>{
  for(const failure of ['failBefore','failAfter']){const f=fixture(),p=f.payload();f.state[failure]=true;assert.equal(f.call('apiClientFactoryVisitSave',p).success,false);assert.equal(f.call('apiClientFactoryVisitSave',p).success,true);assert.equal(f.records().length,1);assert.equal(f.tables.get('CLIENT_FACTORY_VISIT_EVENTS').length,2);}
});
test('lead links are read-only, permission checked and qualified by the actual portal',()=>{
  const f=fixture(),options=f.call('apiClientFactoryVisitOptions').data,lead=options.leads[0];
  assert.equal(lead.key,'synthetic-portal:001');
  assert.equal(f.call('apiClientFactoryVisitSave',f.payload({'Lead ID':'001','Lead Key':'other:001'})).success,false);
  const saved=f.call('apiClientFactoryVisitSave',f.payload({'Lead ID':lead.id,'Lead Key':lead.key,Company:'Forged'}));assert.equal(saved.success,true);
  assert.equal(f.records()[0].Company,'Synthetic Client');assert.equal(f.lead['Company Name'],'Synthetic Client');
  f.state.user={id:'host2',role:'SALES',modules};assert.equal(f.call('apiClientFactoryVisitSave',f.payload({'Lead ID':lead.id,'Lead Key':lead.key})).success,false);
});
test('hosts must be active authorized users; site is validated free text, destination inbound only',()=>{
  const f=fixture();f.users[1]['Is Active']=false;
  assert.deepEqual(f.call('apiClientFactoryVisitOptions').data.hosts.map(h=>h.id),['host1']);
  for(const change of [{'Host ID':'invented'},{'Host ID':'host2'},{'Host ID':'outside'},{Site:''},{Destination:'Client premises'},{'Visitor Count':0},{Phone:'bad'},{Email:'bad'}])assert.equal(f.call('apiClientFactoryVisitSave',f.payload(change)).success,false);
  assert.equal(f.records().length,0);
});
test('read/edit scopes enforce creator, host, scoped manager and viewer permissions',()=>{
  const f=fixture();const created=f.call('apiClientFactoryVisitSave',f.payload({'Host ID':'host2'})).data;
  f.state.user={id:'outside',role:'SALES',modules};assert.equal(f.call('apiClientFactoryVisitList',{}).data.total,0);assert.equal(f.call('apiClientFactoryVisitHistory',created.id).success,false);
  f.state.user={id:'host2',role:'USER',modules:['ClientFactoryVisits']};assert.equal(f.call('apiClientFactoryVisitList',{}).data.total,1);assert.equal(f.call('apiClientFactoryVisitSave',f.payload()).success,false);
  const row=f.records()[0];assert.equal(f.call('apiClientFactoryVisitSave',f.payload({...row,id:row['Visit ID'],version:1})).success,false);
  f.state.user={id:'host2',role:'VIEWER',modules};assert.equal(f.call('apiClientFactoryVisitSave',f.payload()).success,false);
  f.state.user={id:'manager',role:'MANAGER',modules};assert.equal(f.call('apiClientFactoryVisitList',{}).data.total,1);
});
test('stale edits and immutable lead links are rejected; fresh update increments version',()=>{
  const f=fixture();f.call('apiClientFactoryVisitSave',f.payload());const row=f.records()[0];
  const update=f.payload({...row,id:row['Visit ID'],version:1,Purpose:'Updated purpose'});
  assert.equal(f.call('apiClientFactoryVisitSave',update).success,true);assert.equal(f.records()[0].Version,'2');
  assert.equal(f.call('apiClientFactoryVisitSave',{...update,requestId:'different-request-1234567890'}).success,false);
  assert.equal(f.call('apiClientFactoryVisitSave',{...update,requestId:'another-request-1234567890',version:2,'Lead ID':'001','Lead Key':'synthetic-portal:001'}).success,false);
});
test('date validation and lifecycle transitions enforce complete outcomes',()=>{
  const f=fixture();
  for(const change of [{'Planned Start':'2026-02-30T10:00'},{'Planned Start':'2026-01-01T24:00'},{'Planned End':'2025-01-01T10:00'},{Status:'Completed'}])assert.equal(f.call('apiClientFactoryVisitSave',f.payload(change)).success,false);
  f.call('apiClientFactoryVisitSave',f.payload());const row=f.records()[0];
  const base={...row,id:row['Visit ID'],version:1,Status:'Completed'};
  assert.equal(f.call('apiClientFactoryVisitSave',f.payload(base)).success,false);
  assert.equal(f.call('apiClientFactoryVisitSave',f.payload({...base,'Actual Start':'2099-01-01T10:00','Actual End':'2099-01-01T11:00',Outcome:'Done'})).success,false);
  assert.equal(f.call('apiClientFactoryVisitSave',f.payload({...base,'Actual Start':'2026-01-01T10:00','Actual End':'2026-01-01T11:00',Outcome:'Samples discussed'})).success,true);
  assert.equal(f.call('apiClientFactoryVisitSave',f.payload({...f.records()[0],id:row['Visit ID'],version:2,Status:'Scheduled'})).success,false);
});
test('cancellation/no-show reasons and elapsed appointment are required',()=>{
  const f=fixture();f.call('apiClientFactoryVisitSave',f.payload({'Planned Start':'2099-01-01T10:00','Planned End':''}));const row=f.records()[0];
  assert.equal(f.call('apiClientFactoryVisitSave',f.payload({...row,id:row['Visit ID'],version:1,Status:'No-show','Cancel Reason':'Absent'})).success,false);
  assert.equal(f.call('apiClientFactoryVisitSave',f.payload({...row,id:row['Visit ID'],version:1,Status:'Cancelled'})).success,false);
  assert.equal(f.call('apiClientFactoryVisitSave',f.payload({...row,id:row['Visit ID'],version:1,Status:'Cancelled','Cancel Reason':'Customer requested'})).success,true);
});
test('register filters, pagination and dashboard use only permitted records',()=>{
  const f=fixture();f.call('apiClientFactoryVisitSave',f.payload());f.call('apiClientFactoryVisitSave',f.payload({Status:'New',Site:'Office Alpha',Destination:'Office','Planned Start':'2026-01-02T10:00','Planned End':''}));
  const result=f.call('apiClientFactoryVisitList',{status:'New',search:'Alpha',from:'2026-01-02',to:'2026-01-02',host:'host1'}).data;
  assert.equal(result.total,1);assert.equal(result.summary.total,1);assert.equal(result.summary.pendingOutcome,1);
  assert.equal(f.call('apiClientFactoryVisitList',{search:'missing'}).data.total,0);
  assert.equal(f.call('apiClientFactoryVisitList',{from:'2026-01-02',to:'2026-01-01'}).success,false);
});
test('user text is written literally, and foreign portal rows cannot be opened',()=>{
  const f=fixture();f.call('apiClientFactoryVisitSave',f.payload({Requirements:'=IMPORTXML("bad")'}));assert.equal(f.records()[0].Requirements,'=IMPORTXML("bad")');
  const values=f.tables.get('CLIENT_FACTORY_VISITS');values[1][values[0].indexOf('Portal ID')]='foreign';assert.equal(f.call('apiClientFactoryVisitList',{}).data.total,0);
});
test('new route is gated separately and existing routes remain intact',()=>{
  const c=vm.createContext({window:{},App:{user:{role:'SALES',modules:['VisitManagement']}}});vm.runInContext(fs.readFileSync(path.join(root,'src/AppUI.html'),'utf8').replace(/^<script>\s*/,'').replace(/<\/script>\s*$/,''),c);
  assert.equal(c.canNavigate('clientfactoryvisits'),false);assert.equal(c.canNavigate('visitmanagement'),true);c.App.user.modules=['ClientFactoryVisits'];assert.equal(c.canNavigate('clientfactoryvisits'),true);assert.equal(c.canNavigate('visitmanagement'),false);
});
test('visit access alone does not disclose the existing lead directory',()=>{
  const f=fixture();f.state.user={id:'host1',role:'SALES',modules};assert.equal(f.call('apiClientFactoryVisitOptions').data.leads.length,0);
  f.state.user.modules=[...modules,'Leads'];assert.equal(f.call('apiClientFactoryVisitOptions').data.leads.length,1);
  assert.equal(f.call('apiClientFactoryVisitSave',[]).success,false);
  assert.equal(f.call('apiClientFactoryVisitSave',f.payload({Requirements:'x'.repeat(17000)})).success,false);
});
