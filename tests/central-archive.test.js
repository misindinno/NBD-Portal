const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const {syncFixture}=require('./helpers/sync-fixture');
const {read}=require('./helpers/lead-cache-fixture');
function fixture(){
 const f=syncFixture(),c=f.c,central=new Map();
 vm.runInContext(read('src/server/CentralStore.js')+read('src/server/CentralArchiveService.js'),c);
 vm.runInContext(read('src/server/ArchitectureCore.js').match(/function leadArchiveState_\(lead\) \{[\s\S]*?\n\}/)[0],c);
 c.arBook_=()=> 'archive';c.arEnabled_=()=>true;c.arCopyConfiguration_=()=>{};c.arProgress_=()=>{};
 c.getRowsWithCustomFieldValuesReadOnly_=(_name,rows)=>rows;
 c.arUpsert_=(name,records)=>{const data=central.get(name)||new Map();for(const r of records)data.set(r['Central Key'],{...(data.get(r['Central Key'])||{}),...JSON.parse(JSON.stringify(r))});central.set(name,data);};
 c.arRead_=name=>({headers:[],rows:[...(central.get(name)||new Map()).values()].map((value,i)=>({row:i+2,value}))});
 const t=f.tables.get('LEAD_MASTER');t.data[1][t.data[0].indexOf('Is Archived')]=true;
 f.add('FOLLOWUP_HISTORY',['History ID','Lead ID','Follow-up ID','Remark'],[{'History ID':'H1','Lead ID':'L1','Follow-up ID':'F1',Remark:'Original remark'}]);
 return {...f,central,run:()=>c.withServerContext_(()=>c.arTransferBatch_())};
}
test('archive transfers complete bundles and indexes only after verified central copies',()=>{
 const f=fixture(),r=f.run();assert.equal(r.state,'committed');assert.equal(r.result.moved,1);
 for(const table of ['LEAD_MASTER','FOLLOWUPS','FOLLOWUP_HISTORY'])assert.equal(f.rows(table).length,0);
 const lead=[...f.central.get('Master').values()][0];assert.equal(lead['Transfer State'],'Transferred');assert.ok(lead['Transfer Operation']);
 assert.equal([...f.central.get('FOLLOWUP_HISTORY').values()][0].Remark,'Original remark');
 assert.equal(f.run().result.moved,0);
});
test('archive copy failure preserves every source row',()=>{
 const f=fixture(),up=f.c.arUpsert_;f.c.arUpsert_=(name,rows)=>{if(name==='FOLLOWUP_HISTORY')throw Error('Copy unavailable');up(name,rows);};
 assert.throws(f.run,/Copy unavailable/);for(const table of ['LEAD_MASTER','FOLLOWUPS','FOLLOWUP_HISTORY'])assert.equal(f.rows(table).length,1);
});
test('lost transfer response recovers only its exact committed operation',()=>{
 const f=fixture();f.state.after=true;assert.equal(f.run().state,'retry');
 const lead=[...f.central.get('Master').values()][0];assert.equal(lead['Transfer State'],'Copied');
 const operation=lead['Transfer Operation'];lead['Transfer Operation']='unrelated';
 assert.throws(()=>f.c.withServerContext_(()=>f.c.arRepairReceipts_()),/without a confirmed/);
 lead['Transfer Operation']=operation;f.c.withServerContext_(()=>f.c.arRepairReceipts_());
 assert.equal([...f.central.get('Master').values()][0]['Transfer State'],'Transferred');
});
test('archive planner ignores active and final-stage-only records',()=>{
 const f=fixture(),p=f.c.arPlan_([{'Lead ID':'active','Stage ID':'Disqualified'},{'Lead ID':'archived','Is Archived':'TRUE'}],[],[],[],10);
 assert.deepEqual(Array.from(p.leads,r=>r['Lead ID']),['archived']);
 assert.throws(()=>f.c.arPlan_([{'Lead ID':'same','Is Archived':true},{'Lead ID':'same'}],[],[],[],10),/Duplicate source/);
});
test('central archive records remain portal and assignment scoped',()=>{
 const f=fixture();f.run();const saved=[...f.central.get('Master').values()][0];
 f.central.get('Master').set('foreign',{...saved,'Central Key':'foreign','Origin Workbook':'other'});
 f.c._scopeAssignedRows=(rows,user)=>rows.filter(r=>r['Assigned To']===user.id);
 assert.equal(f.c.withServerContext_(()=>f.c.arVisibleLeads_({id:'u1'})).length,1);assert.equal(f.c.withServerContext_(()=>f.c.arVisibleLeads_({id:'u2'})).length,0);
 f.c._requireModule=()=>({id:'u2'});assert.equal(f.c.apiGetCentralArchiveDetail('valid','L1').success,false);
});
test('restore imports history atomically, preserves IDs and repairs central state by receipt',()=>{
 const f=fixture();f.run();
 const command=f.command('apiRestoreArchivedLead',['L1'],[{type:'lead',id:'L1',values:[...f.central.get('Master').values()][0]}]);
 const response=f.call(command),result=response.data;assert.equal(result?.state,'committed',JSON.stringify(response));
 assert.equal(f.rows('LEAD_MASTER').length,1);assert.equal(f.rows('FOLLOWUPS').length,1);assert.equal(f.rows('FOLLOWUP_HISTORY')[0].Remark,'Original remark');
 assert.equal(f.rows('LEAD_MASTER')[0]['Is Archived'],'');
 f.c.withServerContext_(()=>f.c.arRepairRestores_());
 assert.equal([...f.central.get('Master').values()][0]['Transfer State'],'Restored');
});
test('restore failure commits no partial local bundle and leaves central copy available',()=>{
 const f=fixture();f.run();f.state.before=true;
 const command=f.command('apiRestoreArchivedLead',['L1'],[{type:'lead',id:'L1',values:[...f.central.get('Master').values()][0]}]);
 const response=f.call(command),result=response.data;assert.equal(result?.state,'retry',JSON.stringify(response));
 assert.equal(f.rows('LEAD_MASTER').length,0);assert.equal(f.rows('FOLLOWUP_HISTORY').length,0);
 assert.equal([...f.central.get('Master').values()][0]['Transfer State'],'Transferred');
});

test('restore response loss retries the same receipt without duplicate leads or history',()=>{
 const f=fixture();f.run();const command=f.command('apiRestoreArchivedLead',['L1'],[{type:'lead',id:'L1',values:[...f.central.get('Master').values()][0]}]);
 f.state.after=true;assert.equal(f.call(command).data.state,'retry');
 assert.equal(f.call(command).data.state,'committed');assert.equal(f.rows('LEAD_MASTER').length,1);assert.equal(f.rows('FOLLOWUP_HISTORY').length,1);
 f.c.withServerContext_(()=>f.c.arRepairRestores_());assert.equal([...f.central.get('Master').values()][0]['Transfer State'],'Restored');
 // A later archive cycle must not be cleared by the older restore receipt.
 const t=f.tables.get('LEAD_MASTER');t.data[1][t.data[0].indexOf('Is Archived')]=true;
 assert.equal(f.run().state,'committed');f.c.withServerContext_(()=>f.c.arRepairRestores_());
 assert.equal([...f.central.get('Master').values()][0]['Transfer State'],'Transferred');
});

test('already archived disqualified records move with their history and retain source audit copies',()=>{
 const f=fixture();f.tables.get('LEAD_MASTER').data.splice(1);
 const dq={Master:[{'Central Key':'book|D','Origin Workbook':'book','Lead ID':'D','Assigned To':'u1','Is Archived':'TRUE','Transfer State':'Transferred'}],
 FOLLOWUPS:[{'Central Key':'book|F','Origin Workbook':'book','Lead ID':'D','Follow-up ID':'F'}],
 FOLLOWUP_HISTORY:[{'Central Key':'book|H','Origin Workbook':'book','Lead ID':'D','History ID':'H',Remark:'Older remark'}]};
 f.c.dqEnabled_=()=>true;f.c.dqRead_=name=>({rows:dq[name].map(value=>({value}))});
 f.c.dqDecorate_=(r,id,state)=>({...r,'Central Key':'book|'+id,'Transfer State':state});
 f.c.dqUpsert_=(name,records)=>records.forEach(r=>Object.assign(dq[name].find(x=>x['Central Key']===r['Central Key']),r));
 f.c.withServerContext_(()=>f.c.arTransferDisqualified_());
 assert.equal(dq.Master[0]['Transfer State'],'Archived');assert.equal(dq.FOLLOWUP_HISTORY.length,1);
 assert.equal([...f.central.get('Master').values()][0]['Transfer State'],'Transferred');
 assert.equal([...f.central.get('FOLLOWUP_HISTORY').values()][0].Remark,'Older remark');
});

test('archive worker runs one bounded batch and pauses subsequent triggers after quota errors',()=>{
 const f=fixture(),c=f.c,properties=new Map();let runs=0;
 c._bootstrapReadMode_=false;
 c.PropertiesService={getScriptProperties:()=>({getProperty:k=>properties.get(k)||null,setProperty:(k,v)=>properties.set(k,v),deleteProperty:k=>properties.delete(k)})};
 for(const name of ['arInitialize_','arRepairRestores_','arRepairReceipts_','arTransferDisqualified_'])c[name]=()=>{};
 c.arTransferBatch_=()=>{runs++;return {state:'committed',result:{moved:50,remaining:200}};};
 c.centralArchiveWorker_();assert.equal(runs,1,'remaining records wait for a later trigger');
 c.arTransferBatch_=()=>{runs++;throw Error('Quota exceeded for Read requests');};
 assert.throws(()=>c.centralArchiveWorker_(),/Quota exceeded/);
 assert.ok(Number(properties.get('AR_NEXT_RUN_AT'))>Date.now());
 assert.equal(c.centralArchiveWorker_().state,'retry');assert.equal(runs,2);
 assert.equal(properties.has('AR_WORKER_LEASE'),false);
});
