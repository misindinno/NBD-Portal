const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),crypto=require('node:crypto');
const {read}=require('./helpers/lead-cache-fixture');
function fixture(){
 const headers=['Lead ID','Company Name','Phone','Assigned To','Archive Reason','Remark','Is Archived','Updated At','Central Key','Origin Workbook','Origin Portal','Transfer State','Transferred At','Transfer Operation'];
 const auditHeaders=['Sheet Name','Record JSON','Central Key','Origin Workbook','Origin Portal','Transfer State','Transferred At','Transfer Operation'];
 const state={lead:{'Lead ID':'L1','Company Name':'Original','Phone':'00123','Assigned To':'u1','Is Archived':'true','Updated At':'2026-10-01','Central Key':'book|L1','Origin Workbook':'book','Transfer State':'Transferred','Transfer Operation':'original-transfer'},receipts:[],fences:new Set(),before:false,after:false,writes:0};
 const user={id:'u1',role:'ADMIN'};
 const c=vm.createContext({Date,console,SPREADSHEET_ID:'book',SHEET_NAMES:{LEADS:'leads'},
  leadCacheDigest_:v=>crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex'),arKey_:id=>'book|'+id,
  arBook_:()=> 'central',arLiteral_:v=>v==null?'':String(v),
  arDecorate_:(r,id,s)=>({...r,'Central Key':'book|'+id,'Origin Workbook':'book','Origin Portal':'Test','Transfer State':s,'Transferred At':'2026-10-31'}),
  arRead_:name=>name==='Master'?{headers,rows:[{row:2,value:structuredClone(state.lead)}]}:{headers:auditHeaders,rows:state.receipts.map((value,i)=>({row:i+2,value:structuredClone(value)}))},
  _canReadAssignedRow:(lead,u)=>u.role==='ADMIN'||lead['Assigned To']===u.id,getRowByIndexedId_:()=>null,
  LockService:{getScriptLock:()=>({tryLock:()=>true,releaseLock(){}})},
  Sheets:{Spreadsheets:{get:()=>({sheets:[{properties:{title:'Master',sheetId:1}},{properties:{title:'PORTAL_CONFIG',sheetId:2}}]}),batchUpdate:batch=>{
   if(state.before){state.before=false;throw Error('Unavailable');}
   const next=structuredClone(state.lead),receipts=structuredClone(state.receipts),fences=new Set(state.fences);
   for(const request of batch.requests){
    if(request.addNamedRange){const id=request.addNamedRange.namedRange.namedRangeId;if(fences.has(id))throw Error('Named range already exists');fences.add(id);}
    if(request.updateCells){const r=request.updateCells;assert.equal(r.start.sheetId,1);next[headers[r.start.columnIndex]]=r.rows[0].values[0].userEnteredValue.stringValue;}
    if(request.appendCells){assert.equal(request.appendCells.sheetId,2);receipts.push(Object.fromEntries(auditHeaders.map((h,i)=>[h,request.appendCells.rows[0].values[i].userEnteredValue.stringValue])));}
   }
   Object.assign(state,{lead:next,receipts,fences});state.writes++;
   if(state.after){state.after=false;throw Error('Lost acknowledgement');}
  }}}
 });
 vm.runInContext(read('src/server/ArchiveManagementService.js'),c);
 const command=(action,changes={})=>({id:crypto.randomUUID(),leadId:'L1',action,changes,revision:c.arRevision_(state.lead)});
 return {c,state,user,command,run:cmd=>c.arManage_(user,cmd)};
}
test('archive edit, trash and recover preserve record identity and transfer history link',()=>{
 const f=fixture();f.run(f.command('update',{'Company Name':'Edited',Phone:'00123',Remark:'=literal text'}));
 assert.equal(f.state.lead.Remark,'=literal text');assert.equal(f.state.lead.Phone,'00123');
 f.run(f.command('trash'));assert.equal(f.state.lead['Transfer State'],'Trashed');
 f.run(f.command('recover'));assert.equal(f.state.lead['Transfer State'],'Transferred');
 assert.equal(f.state.lead['Transfer Operation'],'original-transfer');assert.equal(f.state.receipts.length,3);
});
test('unknown acknowledgement and retry apply the same archive operation once',()=>{
 const f=fixture(),cmd=f.command('trash');f.state.after=true;
 assert.equal(f.run(cmd).state,'Trashed');assert.equal(f.run(cmd).state,'Trashed');assert.equal(f.state.writes,1);
});
test('write failure leaves the record intact; retry uses its original reference',()=>{
 const f=fixture(),cmd=f.command('trash');f.state.before=true;
 assert.throws(()=>f.run(cmd),/Cannot confirm/);assert.equal(f.state.lead['Transfer State'],'Transferred');assert.equal(f.state.receipts.length,0);
 assert.equal(f.run(cmd).state,'Trashed');
});
test('stale edits, unauthorized users, protected fields and request ID reuse are rejected',()=>{
 const f=fixture(),stale=f.command('update',{'Company Name':'Stale'}),fresh=f.command('update',{'Company Name':'New'});
 f.run(fresh);assert.throws(()=>f.run(stale),/record changed/);
 assert.throws(()=>f.run({...fresh,changes:{'Company Name':'Different'}}),/ID reuse/);
 assert.throws(()=>f.run(f.command('update',{'Assigned To':'another'})),/Invalid archive field/);
 assert.throws(()=>f.run(f.command('update',{'Company Name':''})),/required/);
 f.user.role='SALES';f.user.id='another';assert.throws(()=>f.run(f.command('trash')),/permission denied/);
 assert.equal(f.state.writes,1);
});
test('an archive row restored locally cannot be edited from a stale central view',()=>{
 const f=fixture();f.c.getRowByIndexedId_=()=>({'Lead ID':'L1'});
 assert.throws(()=>f.run(f.command('trash')),/transfer is not complete/);assert.equal(f.state.writes,0);
});
