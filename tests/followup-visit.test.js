const test=require('node:test'),assert=require('node:assert/strict');
const {followupVisitFixture}=require('./helpers/followup-visit-fixture');
test('visit remark creates a date-only inbound request and audit without changing follow-up or lead',()=>{
  const f=followupVisitFixture(),before=JSON.stringify([f.followup,f.lead]);
  const result=f.call('apiSaveFollowupVisit',f.quick());assert.equal(result.success,true,result.error);
  const row=f.records()[0];
  assert.equal(row.Status,'New');assert.equal(row['Planned Start'],'2026-10-28');assert.equal(row.Destination,'Factory');
  assert.equal(row.Purpose,'Discuss product samples');assert.equal(row['Lead Key'],'synthetic-portal:001');
  for(const key of ['Host ID','Site','Visitor Name','Visitor Count','Actual Start'])assert.equal(row[key],'');
  assert.equal(JSON.stringify([f.followup,f.lead]),before);
  assert.match(f.call('apiClientFactoryVisitHistory',result.data.id).data[0].type,/fu-001/);
  assert.equal(f.call('apiClientFactoryVisitList',{from:'2026-10-28',to:'2026-10-28'}).data.total,1);
});
test('dates, remarks, type and unexpected fields are validated without writes',()=>{
  for(const change of [{date:'2026-02-30'},{date:''},{date:'2026-10-28T10:00'},{remark:'  '},{remark:'x'.repeat(1001)},{visitType:'Client premises'},{id:'forged'},{Status:'Completed'},{followupId:'missing'}]){
    const f=followupVisitFixture();assert.equal(f.call('apiSaveFollowupVisit',f.quick(change)).success,false,JSON.stringify(change));assert.equal(f.writes.length,0);
  }
});
test('repeat and lost-response retries commit only once; changed payload cannot reuse a request',()=>{
  for(const failure of ['failBefore','failAfter',null]){
    const f=followupVisitFixture(),p=f.quick();if(failure)f.state[failure]=true;
    f.call('apiSaveFollowupVisit',p);
    assert.equal(f.call('apiSaveFollowupVisit',p).success,true);assert.equal(f.records().length,1);
    assert.equal(f.call('apiSaveFollowupVisit',{...p,remark:'Changed'}).success,false);
    assert.equal(f.tables.get('CLIENT_FACTORY_VISIT_EVENTS').length,2);
  }
});
test('fresh session, follow-up and visit grants and exact lead scope required on read, save and replay',()=>{
  const f=followupVisitFixture();assert.equal(f.c.apiSaveFollowupVisit('',f.quick()).success,false);
  for(const role of ['VIEWER','SALES'])for(const missing of ['Followups','Leads','ClientFactoryVisits','ClientFactoryVisitsCreate']){
    f.state.user={id:'host1',role,modules:f.grants.filter(name=>name!==missing)};
    assert.equal(f.call('apiGetFollowupVisitOptions','fu-001').success,false);
    assert.equal(f.call('apiSaveFollowupVisit',f.quick()).success,false);
  }
  f.state.user={id:'host1',role:'SALES',modules:f.grants};
  assert.equal(f.call('apiSaveFollowupVisit',f.quick()).success,true);
  f.lead['Assigned To']='host2';
  assert.equal(f.call('apiSaveFollowupVisit',f.quick()).success,false);
  assert.equal(f.records().length,1);
});
test('standalone, archived and ambiguous lead links cannot create requests; no implicit initialization',()=>{
  const f=followupVisitFixture({initialized:false});assert.equal(f.call('apiSaveFollowupVisit',f.quick()).success,false);assert.equal(f.writes.length,0);
  for(const change of [f=>f.followup['Lead ID']='',f=>f.lead['Is Archived']=true,f=>{const read=f.c.getAllRows;f.c.getAllRows=name=>name==='LEADS'?[f.lead,f.lead]:read(name);}]){
    const f=followupVisitFixture();change(f);assert.equal(f.call('apiSaveFollowupVisit',f.quick()).success,false);assert.equal(f.writes.length,0);
  }
});
test('date-only request is upgraded through existing validated booking without weakening requirements',()=>{
  const f=followupVisitFixture(),saved=f.call('apiSaveFollowupVisit',f.quick()).data,row=f.records()[0];
  assert.equal(f.call('apiClientFactoryVisitSave',{...row,id:saved.id,version:1,requestId:'request-upgrade-000000000'}).success,false);
  const update=f.payload({'Lead ID':row['Lead ID'],'Lead Key':row['Lead Key'],id:saved.id,version:1,Status:'Scheduled'});
  assert.equal(f.call('apiClientFactoryVisitSave',update).success,true);assert.equal(f.records().length,1);assert.equal(f.records()[0].Version,'2');
});
