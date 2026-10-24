const test = require('node:test'), assert = require('node:assert/strict');
const {syncFixture}=require('./helpers/sync-fixture');
const done = {'Done Date':'2026-10-24','Next Follow-up Date':'2026-10-27',Remark:'Synthetic follow-up','Was Productive':'Yes','Contact Mode':'Call Connected'};
function completion(f) { return f.command('apiMarkFollowupDoneDirect',['F1',done],[f.base('followup','F1'),f.base('lead','L1')]); }
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
