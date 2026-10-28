const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const {syncFixture}=require('./helpers/sync-fixture');
const {read}=require('./helpers/lead-cache-fixture');
function fixture(){
 const f=syncFixture(),c=f.c,central=new Map();
 vm.runInContext(read('src/server/DisqualifiedService.js'),c);
 c.dqBook_=()=> 'central';c.dqEnabled_=()=>true;c._a1Sheet_=s=>"'"+s+"'";c._columnLetter_=n=>String.fromCharCode(64+n);
 c.getRowsWithCustomFieldValuesReadOnly_=(_name,rows)=>rows;
 c.dqCopyConfiguration_=()=>{};
 c.dqProgress_=()=>{};
 c.dqUpsert_=(name,records)=>{const data=central.get(name)||new Map();for(const row of records)data.set(row['Central Key'],{...(data.get(row['Central Key'])||{}),...JSON.parse(JSON.stringify(row))});central.set(name,data);};
 c.dqRead_=name=>({headers:[],rows:[...(central.get(name)||new Map()).values()].map((value,i)=>({row:i+2,value}))});
 f.add('PIPELINE_STAGES',['Stage ID','Stage Name'],[{'Stage ID':'S1','Stage Name':'Disqualified'},{'Stage ID':'S2','Stage Name':'Open'}]);
 f.add('FOLLOWUP_HISTORY',['History ID','Lead ID','Follow-up ID','Remark'],[{'History ID':'H1','Lead ID':'L1','Follow-up ID':'F1',Remark:'Original remark'}]);
 return {...f,central,run:()=>c.withServerContext_(()=>c.dqTransferBatch_())};
}
test('verified lead, followup and remark move together; source indexes/receipt commit atomically',()=>{
 const f=fixture();const result=f.run();assert.equal(result.state,'committed');assert.equal(result.result.moved,1);
 for(const name of ['LEAD_MASTER','FOLLOWUPS','FOLLOWUP_HISTORY'])assert.equal(f.rows(name).length,0,name);
 assert.equal([...f.central.get('FOLLOWUP_HISTORY').values()][0].Remark,'Original remark');
 assert.equal([...f.central.get('Master').values()][0]['Transfer State'],'Transferred');
 const receipts=f.rows('_SYNC_OPERATIONS').length;f.run();assert.equal(f.rows('_SYNC_OPERATIONS').length,receipts,'idle runs create no receipts');
});
test('central failure retains source lead, followup and history',()=>{
 const f=fixture();f.c.dqUpsert_=(name)=>{if(name==='FOLLOWUP_HISTORY')throw Error('Verification failed');};
 assert.throws(f.run,/Verification/);for(const name of ['LEAD_MASTER','FOLLOWUPS','FOLLOWUP_HISTORY'])assert.equal(f.rows(name).length,1);
});
test('unknown source commit is retried safely with central copy retained',()=>{
 const f=fixture();f.state.after=true;const r=f.run();assert.equal(r.state,'retry');
 assert.equal(f.rows('LEAD_MASTER').length,0);assert.equal([...f.central.get('Master').values()][0]['Transfer State'],'Copied');
 f.c.withServerContext_(()=>f.c.dqRepairReceipts_());assert.equal([...f.central.get('Master').values()][0]['Transfer State'],'Transferred');
});
test('source changes after copy prevent deletion',()=>{
 const f=fixture(),upsert=f.c.dqUpsert_;f.c.dqUpsert_=(name,records)=>{upsert(name,records);if(name==='FOLLOWUP_HISTORY'){const t=f.tables.get('LEAD_MASTER');t.data[1][t.data[0].indexOf('Company Name')]='Concurrent edit';}};
 assert.throws(f.run,/SYNC_CONFLICT/);assert.equal(f.rows('LEAD_MASTER').length,1);assert.equal(f.rows('FOLLOWUP_HISTORY').length,1);
});
test('planner uses stage, rejects duplicate IDs and limits complete lead bundles',()=>{
 const f=fixture(),c=f.c;const stages=[{'Stage ID':'D','Stage Name':'Disqualified'}];
 const rows=[{'Lead ID':'a','Stage ID':'D'},{'Lead ID':'b','Stage ID':'OPEN','Lead Status':'Disqualified'},{'Lead ID':'c','Stage ID':'D'}];
 const p=c.dqPlan_(rows,[],[],stages,1);assert.equal(p.leads.length,1);assert.equal(p.remaining,1);
 assert.throws(()=>c.dqPlan_([rows[0],rows[0]],[],[],stages,1),/Duplicate/);
});
test('central views scope by origin workbook and current assignment; detail rejects another user',()=>{
 const f=fixture(),c=f.c;f.run();const saved=[...f.central.get('Master').values()][0];
 f.central.get('Master').set('other',{...saved,'Central Key':'other','Origin Workbook':'other'});
 c._scopeAssignedRows=(rows,user)=>rows.filter(r=>r['Assigned To']===user.id);
 c._isArchivedLead_=r=>r['Is Archived']==='TRUE';
 assert.equal(c.dqVisibleLeads_({id:'u1',modules:['Leads']}).length,1);assert.equal(c.dqVisibleLeads_({id:'u2',modules:['Leads']}).length,0);
 saved['Is Archived']='TRUE';assert.equal(c.dqVisibleLeads_({id:'u1',modules:['Leads']}).length,0);
 assert.equal(c.dqVisibleLeads_({id:'u1',modules:['Leads','Archive']}).length,1);
 c._requireModule=()=>({id:'u2',modules:['Leads']});assert.equal(c.apiGetDisqualifiedDetail('valid','L1').success,false);
});
test('large source indexes remain inside the atomic batch limit during removal',()=>{
 const f=fixture(),leadHeaders=f.tables.get('LEAD_MASTER').data[0],fuHeaders=f.tables.get('FOLLOWUPS').data[0];
 const leads=Array.from({length:2000},(_,i)=>({'Lead ID':'lead-'+i,'Company Name':'Company '+i,'Assigned To':'u1','Stage ID':i%15===0?'S1':'S2',Phone:'9000000000','Updated At':'2026-10-26 12:00:00'}));
 const tasks=leads.map((l,i)=>({'Follow-up ID':'followup-'+i,'Lead ID':l['Lead ID'],Status:'Open','Created By':'u1','Updated At':'2026-10-26 12:00:00'}));
 f.add('LEAD_MASTER',leadHeaders,leads);f.add('FOLLOWUPS',fuHeaders,tasks);f.add('FOLLOWUP_HISTORY',['History ID','Lead ID','Follow-up ID','Remark'],[]);
 for(const def of f.c._indexDefinitions_().filter(d=>['LEAD_MASTER','FOLLOWUPS'].includes(d.sourceSheet)))f.add(def.indexSheet,def.headers,f.rows(def.sourceSheet).map((r,i)=>def.build(r,i+2)));
 // Old indexes can contain formatted/native dates that differ from rebuilt
 // values. A row shift must only change their pointer, not normalize every cell.
 for(const name of ['IDX_LEADS','IDX_FOLLOWUPS']){const t=f.tables.get(name),col=t.data[0].indexOf('Updated At');t.data.slice(1).forEach(row=>row[col]='Preserve existing index timestamp');}
 const r=f.run();assert.equal(r.state,'committed');assert.equal(r.result.moved,134);
 assert.equal(f.rows('LEAD_MASTER').length,1866);assert.equal(f.rows('IDX_LEADS').length,1866);
 assert.equal(f.rows('IDX_LEADS')[0]['Updated At'],'Preserve existing index timestamp');
});
test('upsert retries resolve an unknown append and preserve unrelated central records',()=>{
 const c=vm.createContext({CLIENT_CONFIG:{APP_TITLE:'Test'},SPREADSHEET_ID:'source',Date,Set,Map,Utilities:{},Session:{}});
 vm.runInContext(read('src/server/DisqualifiedService.js'),c);
 const headers=['Central Key','Origin Workbook','Origin Portal','Transfer State','Transferred At','Lead ID','Company Name'];
 let rows=[{'Central Key':'other|a','Origin Workbook':'other','Lead ID':'a','Company Name':'Other portal'}],lose=true;
 c.dqRead_=()=>({headers,rows:rows.map((value,i)=>({row:i+2,value}))});c.dqBook_=()=> 'central';c._a1Sheet_=s=>s;c._columnLetter_=()=> 'G';
 const object=values=>Object.fromEntries(headers.map((h,i)=>[h,values[i]||'']));
 c.Sheets={Spreadsheets:{Values:{append:body=>{rows.push(...body.values.map(object));if(lose){lose=false;throw Error('Lost append response');}},batchUpdate:body=>{body.data.forEach(d=>{const rn=Number(d.range.match(/!A(\d+)/)[1]);rows[rn-2]=object(d.values[0]);});}}}};
 const record={'Central Key':'source|a','Origin Workbook':'source','Lead ID':'a','Company Name':'=Literal company'};
 assert.throws(()=>c.dqUpsert_('Master',[record]),/Lost append/);c.dqUpsert_('Master',[record]);assert.equal(rows.length,2);assert.equal(rows[0]['Company Name'],'Other portal');assert.equal(rows[1]['Company Name'],'=Literal company');
});

test('verification bypasses stale SpreadsheetApp values after an API write',()=>{
 const c=vm.createContext({CLIENT_CONFIG:{},SPREADSHEET_ID:'source',Date,Set,Map});
 vm.runInContext(read('src/server/DisqualifiedService.js'),c);
 const headers=['Central Key','Origin Workbook','Origin Portal','Transfer State','Transferred At','Lead ID'];let server=[headers];let reads=0;
 c.dqBook_=()=> 'central';c._a1Sheet_=s=>s;c._columnLetter_=()=> 'F';
 c.SpreadsheetApp={openById:()=>{throw Error('Stale SpreadsheetApp cache must not be used');}};
 c.Sheets={Spreadsheets:{Values:{get:()=>{reads++;return {values:server.map(r=>r.slice())};},append:body=>server.push(...body.values)}}};
 c.dqUpsert_('Master',[{'Central Key':'source|a','Origin Workbook':'source','Lead ID':'a'}]);
 assert.equal(reads,2);assert.equal(server.length,2);
});

test('worker lease prevents overlap and releases on an error without hiding its status',()=>{
 const f=fixture(),c=f.c,props=new Map();c._bootstrapReadMode_=false;
 c.PropertiesService={getScriptProperties:()=>({getProperty:k=>props.get(k)||null,setProperty:(k,v)=>props.set(k,v),deleteProperty:k=>props.delete(k)})};
 props.set('DQ_WORKER_LEASE',JSON.stringify({id:'another',until:Date.now()+60000}));
 assert.equal(c.centralDisqualifiedWorker_().state,'retry');assert.equal(f.rows('LEAD_MASTER').length,1);
 props.clear();c.dqTransferBatch_=()=>{throw Error('Verified failure');};
 assert.throws(()=>c.centralDisqualifiedWorker_(),/Verified failure/);assert.equal(props.has('DQ_WORKER_LEASE'),false);
 assert.equal(JSON.parse(props.get('DQ_LAST_STATUS')).state,'error');assert.equal(c._bootstrapReadMode_,false);
});
