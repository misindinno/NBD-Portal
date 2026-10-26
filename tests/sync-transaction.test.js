const test = require('node:test'), assert = require('node:assert/strict');
const {syncFixture}=require('./helpers/sync-fixture');
const done = {'Done Date':'2026-10-24','Next Follow-up Date':'2026-10-27',Remark:'Synthetic follow-up','Was Productive':'Yes','Contact Mode':'Call Connected'};
function completion(f) { return f.command('apiMarkFollowupDoneDirect',['F1',done],[f.base('followup','F1'),f.base('lead','L1')]); }

test('whitespace headers are normalized without appending duplicates or rewriting original headers',()=>{
  const f=syncFixture();
  f.add('LEAD_FIELD_VALUES',[' Value ID ','Lead ID','Field ID','Column Key','Field Value','File URL','Updated By','Updated At']);
  const original=f.tables.get('LEAD_FIELD_VALUES').data[0].slice();
  const cmd=completion(f),result=f.call(cmd);
  assert.equal(result.data?.state,'committed',JSON.stringify(result));
  assert.deepEqual(f.tables.get('LEAD_FIELD_VALUES').data[0],original);
  assert.equal(f.rows('FOLLOWUP_HISTORY').length,1);
});

test('duplicate value ID headers block atomically; a data-preserving repair permits the same command',()=>{
  const f=syncFixture(),cmd=completion(f);
  const headers=['Value ID','Lead ID','Field ID','Column Key','Field Value','File URL','Updated By','Updated At','Value ID'];
  f.add('LEAD_FIELD_VALUES',headers);
  const table=f.tables.get('LEAD_FIELD_VALUES');
  table.data.push(['old-id','L1','field1','Extra','old value','','','','']);
  table.data.push(['','L1','field2','Other','new value','','','','new-id']);
  const failed=f.call(cmd);
  assert.equal(failed.success,false);assert.match(failed.error,/Duplicate header/);
  assert.equal(f.requests.length,0);assert.equal(f.rows('_SYNC_OPERATIONS').length,0);
  table.data[2][0]=table.data[2][8];table.data[0][8]='Legacy Value ID';
  const result=f.call(cmd);
  assert.equal(result.data?.state,'committed',JSON.stringify(result));
  assert.deepEqual(f.tables.get('LEAD_FIELD_VALUES').data.slice(1),table.data.slice(1));
  assert.equal(f.call(cmd).data.repeated,true);assert.equal(f.rows('FOLLOWUP_HISTORY').length,1);
});
test('follow-up, history, lead dates, indexes and receipt commit together; retry adds no duplicate',()=>{
  const f=syncFixture(),cmd=completion(f),result=f.call(cmd);
  assert.equal(result.success,true,JSON.stringify(result)); assert.equal(result.data.state,'committed',JSON.stringify(result));
  assert.equal(f.rows('FOLLOWUP_HISTORY').length,1); assert.equal(f.rows('FOLLOWUPS')[0]['Planned Date'],'2026-10-27');
  assert.equal(f.rows('LEAD_MASTER')[0]['Next Follow-up Date'],'2026-10-27');assert.equal(f.rows('_SYNC_OPERATIONS').length,1);
  assert.equal(f.requests.length,1);assert.equal(f.call(cmd).data.repeated,true);assert.equal(f.requests.length,1);
});
test('lost response after commit resolves through the same receipt',()=>{
  const f=syncFixture(),cmd=completion(f);f.state.after=true;
  assert.equal(f.call(cmd).data.state,'retry');assert.equal(f.rows('FOLLOWUP_HISTORY').length,1);
  assert.equal(f.call(cmd).data.state,'committed');assert.equal(f.rows('FOLLOWUP_HISTORY').length,1);
});
test('failed atomic request changes neither the task nor history; retry can commit',()=>{
  const f=syncFixture(),cmd=completion(f);f.state.before=true;
  assert.equal(f.call(cmd).data.state,'retry');assert.equal(f.rows('FOLLOWUP_HISTORY').length,0);
  assert.equal(f.rows('FOLLOWUPS')[0]['Planned Date'],'2026-10-24');assert.equal(f.rows('_SYNC_OPERATIONS').length,0);
  assert.equal(f.call(cmd).data.state,'committed');
});
test('late first batch cannot create duplicate history after a retry committed',()=>{
  const f=syncFixture(),cmd=completion(f);f.state.delay=true;
  assert.equal(f.call(cmd).data.state,'retry');assert.equal(f.call(cmd).data.state,'committed');
  assert.throws(()=>f.apply(f.state.pending),/already exists/);assert.equal(f.rows('FOLLOWUP_HISTORY').length,1);
});

test('a different delayed command cannot overwrite a newer sync commit at the same workbook revision',()=>{
  const f=syncFixture();
  const edit=address=>f.command('apiSaveLead',[{'Lead ID':'L1',Address:address,'__edit_scope':'core'}],[f.base('lead','L1')]);
  const first=edit('Delayed value');f.state.delay=true;
  assert.equal(f.call(first).data.state,'retry');
  assert.equal(f.call(edit('Newer value')).data.state,'committed');
  assert.throws(()=>f.apply(f.state.pending),/already exists/);
  assert.equal(f.rows('LEAD_MASTER')[0].Address,'Newer value');
  assert.equal(f.call(first).data.state,'conflict');
});
test('changed Sheet record conflicts and no partial write is applied',()=>{
  const f=syncFixture(),cmd=completion(f),table=f.tables.get('FOLLOWUPS');
  table.data[1][table.data[0].indexOf('Status')]='Closed';
  assert.equal(f.call(cmd).data.state,'conflict');assert.equal(f.requests.length,0);
});
test('required business validation is retained and an invalid completion creates no history',()=>{
  const f=syncFixture(),cmd=completion(f);cmd.args[1].Remark='';
  assert.equal(f.call(cmd).data.state,'invalid');assert.equal(f.requests.length,0);
});
test('permissions, account, portal, action allowlist and operation hash cannot be bypassed',()=>{
  const f=syncFixture(),cmd=completion(f);
  assert.equal(f.call({...cmd,user:'other'}).data.state,'blocked');
  assert.equal(f.call({...cmd,portal:'other'}).data.state,'blocked');
  assert.equal(f.call({...cmd,action:'apiSaveUser'}).success,false);
  assert.equal(f.call(cmd).data.state,'committed');cmd.args[1].Remark='Different';assert.equal(f.call(cmd).success,false);
  f.state.permission=false;assert.equal(f.call(cmd).success,false);
});
test('lead creation uses the same atomic path and repeated request does not make a second lead',()=>{
  const f=syncFixture(),cmd=f.command('apiSaveLead',[{'Company Name':'New Client',Phone:'9000000001','Stage ID':'S1','Assigned To':'u1'}]);
  const result=f.call(cmd);assert.equal(result.data?.state,'committed',JSON.stringify(result));
  assert.equal(f.rows('LEAD_MASTER').length,2);assert.equal(f.rows('FOLLOWUPS').length,2);
  assert.equal(f.call(cmd).data.repeated,true);assert.equal(f.rows('LEAD_MASTER').length,2);
});
test('duplicate lead rules and formula-like literal text survive the sync path',()=>{
  const f=syncFixture();
  const cmd=f.command('apiSaveLead',[{'Company Name':'New Client',Phone:'9000000000','Stage ID':'S1'}]);
  assert.equal(f.call(cmd).data?.state,'invalid');assert.equal(f.requests.length,0);
  const edit=f.command('apiSaveLead',[{'Lead ID':'L1','Address':'=HYPERLINK("https://example.test")','__edit_scope':'core'}],[f.base('lead','L1')]);
  const result=f.call(edit);assert.equal(result.data?.state,'committed',JSON.stringify(result));
  assert.equal(f.rows('LEAD_MASTER')[0].Address,'=HYPERLINK("https://example.test")');
});
test('disabled feature pauses retained commands without falling back to unsafe writes',()=>{
  const f=syncFixture(),cmd=completion(f);f.state.enabled=false;
  assert.equal(f.call(cmd).data.state,'paused');assert.equal(f.requests.length,0);
});
test('archive and restore atomically update all linked follow-ups and activity',()=>{
  const f=syncFixture();let cmd=f.command('apiArchiveLead',[{leadId:'L1',reason:'Synthetic archive'}],[f.base('lead','L1')]);
  let result=f.call(cmd);assert.equal(result.data?.state,'committed',JSON.stringify(result));
  assert.equal(f.rows('LEAD_MASTER')[0]['Is Archived'],true);assert.equal(f.rows('FOLLOWUPS')[0].Status,'Closed');
  cmd=f.command('apiRestoreArchivedLead',['L1'],[f.base('lead','L1')]);result=f.call(cmd);
  assert.equal(result.data?.state,'committed',JSON.stringify(result));assert.equal(f.rows('FOLLOWUPS')[0].Status,'Open');
  assert.equal(f.rows('LEAD_ACTIVITY_LOGS').length,2);
});
test('bulk valid rows, per-row errors and receipt are committed as one request',()=>{
  const f=syncFixture();f.c._bulkInitialStageId_=()=> 'S1';
  const cmd=f.command('apiSaveBulkRows',[[{'Company Name':'Bulk One',Phone:'9000000001'},{'Company Name':'Duplicate',Phone:'9000000000'}],'create']);
  const result=f.call(cmd);assert.equal(result.data?.state,'committed',JSON.stringify(result));
  assert.equal(result.data.result.summary.saved,1);assert.equal(result.data.result.summary.errors,1);
  assert.equal(f.rows('LEAD_MASTER').length,2);assert.equal(f.rows('FOLLOWUPS').length,2);assert.equal(f.requests.length,1);
  assert.equal(f.call(cmd).data.repeated,true);
});
test('manual call mapping and client number change are part of the atomic receipt batch',()=>{
  const f=syncFixture();f.add('CALL_LOGS',Array.from(require('node:vm').runInContext('CALL_LOG_HEADERS_',f.c)),[
    {'Call ID':'C1','Customer Number':'9000000001','Match Status':'Unmatched'}
  ]);
  const cmd=f.command('apiMapCallToClient',[{callId:'C1',leadId:'L1',expectedPhone:'9000000000',expectedAlternate:''}]);
  const result=f.call(cmd);assert.equal(result.data?.state,'committed',JSON.stringify(result));
  assert.equal(f.rows('LEAD_MASTER')[0]['Alternate No'],'9000000001');assert.equal(f.rows('CALL_LOGS')[0]['Lead ID'],'L1');
  assert.equal(f.rows('LEAD_ACTIVITY_LOGS').length,1);assert.equal(f.call(cmd).data.repeated,true);
});
test('outbound FSR delivery is durably queued in the same business commit',()=>{
  const f=syncFixture();f.c._fsrWebhookConfig_=()=>({url:'https://example.test',secret:'synthetic-test-only'});
  const result=f.call(completion(f));assert.equal(result.data?.state,'committed',JSON.stringify(result));
  assert.equal(f.rows('FSR_SYNC_QUEUE').length,1);assert.equal(f.rows('FSR_SYNC_QUEUE')[0].Status,'Pending');
});

test('one remark in a large workbook updates only its two index entries even when indexes have a different order',()=>{
  const f=syncFixture(),vm=require('node:vm');
  const lead=f.rows('LEAD_MASTER')[0],followup=f.rows('FOLLOWUPS')[0];
  f.add('LEAD_MASTER',f.tables.get('LEAD_MASTER').data[0],[lead,...Array.from({length:3000},(_,i)=>({...lead,'Lead ID':'L'+(i+2),'Company Name':'Client '+i}))]);
  f.add('FOLLOWUPS',f.tables.get('FOLLOWUPS').data[0],[followup,...Array.from({length:3000},(_,i)=>({...followup,'Follow-up ID':'F'+(i+2),'Lead ID':'L'+(i+2)}))]);
  const defs=vm.runInContext('_indexDefinitions_()',f.c).slice(0,2);
  defs.forEach(def=>f.add(def.indexSheet,Array.from(def.headers),f.rows(def.sourceSheet).map((row,i)=>def.build(row,i+2)).reverse()));
  const snapshots=defs.map(def=>structuredClone(f.tables.get(def.indexSheet).data));
  const result=f.call(completion(f));
  assert.equal(result.data?.state,'committed',JSON.stringify(result));
  assert.ok(f.requests[0].requests.length<30,'small save must not emit thousands of index writes');
  defs.forEach((def,i)=>{
    const after=f.tables.get(def.indexSheet).data;
    assert.deepEqual(after.slice(0,-1),snapshots[i].slice(0,-1),'all unrelated index rows retained');
    assert.equal(f.rows(def.indexSheet).at(-1)['Next Follow-up Date'],'2026-10-27');
  });
  assert.equal(f.rows('FOLLOWUP_HISTORY').length,1);
});

test('index planning fixes row pointers after deletion and appends new source IDs',()=>{
  const f=syncFixture(),vm=require('node:vm'),lead=f.rows('LEAD_MASTER')[0];
  f.add('LEAD_MASTER',f.tables.get('LEAD_MASTER').data[0],[lead,{...lead,'Lead ID':'L2'},{...lead,'Lead ID':'L3'}]);
  const def=vm.runInContext('_indexDefinitions_()[0]',f.c);
  f.add(def.indexSheet,Array.from(def.headers),f.rows('LEAD_MASTER').map((r,i)=>def.build(r,i+2)).reverse());
  f.c.withServerContext_(()=>{
    vm.runInContext('SYNC_TX_ = {tables:{},stamps:{}}',f.c);
    try {
      f.c.syncTxDelete_('LEAD_MASTER',r=>r['Lead ID']==='L2');
      f.c.syncTxInsert_('LEAD_MASTER',{...lead,'Lead ID':'L4'});
      f.c.syncTxIndexes_();f.apply({requests:f.c.syncTxRequests_()});
    } finally {vm.runInContext('SYNC_TX_ = null',f.c);}
  });
  assert.deepEqual(f.rows('IDX_LEADS').map(r=>[r['Lead ID'],r['Row Number']]),[['L3',3],['L1',2],['L4',4]]);
});
