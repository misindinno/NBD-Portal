const test = require('node:test'), assert = require('node:assert/strict');
const { mirrorFixture, mirrorClient } = require('./helpers/sheet-mirror-fixture');
const vm = require('node:vm');
const { read } = require('./helpers/lead-cache-fixture');
const plain = value => JSON.parse(JSON.stringify(value));

test('history and activity previews join persisted sheets locally without any server request', async () => {
  const f=mirrorFixture();
  f.add('FOLLOWUP_HISTORY',['History ID','Lead ID','Done Date','Remark'],[
    {'History ID':'H1','Lead ID':'L1','Done Date':new Date('2026-10-26T04:30:00Z'),Remark:'Saved remark'},
    {'History ID':'H2','Lead ID':'L2',Remark:'Another lead'}]);
  f.add('LEAD_ACTIVITY_LOGS',['Log ID','Lead ID','Created At','Action'],[
    {'Log ID':'A1','Lead ID':'L1','Created At':new Date('2026-10-26T04:30:00Z'),Action:'Stage Change'}]);
  const b=mirrorClient(f);await b.client.syncAll(true);const before=b.requests;
  const saved=await b.client.previewLeadDetail('L1');
  assert.equal(b.requests,before);assert.equal(saved.partial,true);
  assert.equal(saved.data.followupHistory.length,1);assert.equal(saved.data.followupHistory[0].Remark,'Saved remark');
  assert.equal(saved.data.activityLogs[0].Action,'Stage Change');
  assert.equal(saved.data.activityLogs[0]['Created At'],'2026-10-26 10:00:00');
  assert.equal(await b.client.previewLeadDetail('unknown'),null);
  b.client.bind({...f.identity(),user:'different-user'});
  assert.equal(await b.client.previewLeadDetail('L1'),null);
});

test('mirror distinguishes a verified empty history from a missing history snapshot', async () => {
  const f=mirrorFixture();f.add('FOLLOWUP_HISTORY',['History ID','Lead ID','Remark']);
  const b=mirrorClient(f);await b.client.syncAll(true);
  const saved=await b.client.previewLeadDetail('L1');
  assert.deepEqual(plain(saved.data.followupHistory),[]);
  assert.equal(saved.data.activityLogs,undefined);
  await b.client.clear();assert.equal(await b.client.previewLeadDetail('L1'),null);
});

test('central mirror JSON transport preserves hashed literal cells and scoped parent/history stores', async () => {
  const f=mirrorFixture(),c=f.c;
  vm.runInContext(read('src/server/DisqualifiedService.js'),c);
  c.dqEnabled_=()=>true;
  const workbook=vm.runInContext('SPREADSHEET_ID',c);
  const text='Literal =value, "quoted"\nनमस्ते café \\ path';
  c.dqRead_=name=>{
    const headers=['Central Key','Origin Workbook','Origin Portal','Transfer State','Transferred At','Lead ID','Assigned To','Company Name','Remark','Custom Fields JSON'];
    const records=[{ 'Central Key':workbook+'|L1','Origin Workbook':workbook,'Transfer State':'Transferred','Lead ID':'L1','Assigned To':'u1','Company Name':'Central client',Remark:text,'Custom Fields JSON':JSON.stringify({value:text}) },
      {'Central Key':'foreign|L2','Origin Workbook':'foreign','Transfer State':'Transferred','Lead ID':'L2','Assigned To':'u1','Company Name':'Other portal'}];
    return {name,headers,rows:records.map((r,i)=>({row:i+2,value:Object.fromEntries(headers.map(h=>[h,r[h]||'']))}))};
  };
  let wirePages=0;
  const b=mirrorClient(f,{request:(fn,q)=>{
    const result=f.request(fn,q);
    if(fn==='apiGetSheetMirrorPage') {assert.equal(q.wireFormat,'json-v1');assert.equal(typeof result,'string');wirePages++;}
    return result;
  }});
  await b.client.syncAll(true);
  for(const name of ['DQ_MASTER','DQ_FOLLOWUPS','DQ_FOLLOWUP_HISTORY','DQ_CONFIG']) {
    const data=await b.client.readSheet(name);
    assert.equal(data.sheetId,null);assert.equal(data.rows.length,1);
    assert.equal(data.rows[0].cells[data.headers.indexOf('Remark')],text);
    assert.ok(b.stores.get(name).puts>0);
  }
  const requests=b.requests,detail=await b.client.previewLeadDetail('L1',true);
  assert.equal(b.requests,requests);assert.equal(detail.data.lead['Company Name'],'Central client');
  assert.equal(detail.data.followupHistory[0].Remark,text);assert.equal(detail.data.followups.length,1);
  assert.equal(await b.client.previewLeadDetail('L2',true),null);
  assert.ok(wirePages>0);
  const legacy=f.request('apiGetSheetMirrorPage',{...f.identity(),sheet:'DQ_MASTER'});
  assert.equal(typeof legacy,'object','existing tabs keep their response format');
});

test('corrupt mirror JSON payload cannot commit a snapshot', async () => {
  const f=mirrorFixture();
  const b=mirrorClient(f,{request:(fn,q)=>{
    const result=f.request(fn,q);
    if(fn==='apiGetSheetMirrorPage' && q.sheet==='LEAD_MASTER') {
      const page=JSON.parse(result);
      if(page.items?.[1])page.items[1].value.cells[0]='Corrupted';
      return JSON.stringify(page);
    }
    return result;
  }});
  await b.client.syncAll(true);
  assert.match(b.client.status().sheets.find(s=>s.name==='LEAD_MASTER').error,/integrity/);
  assert.equal(b.stores.get('LEAD_MASTER').data.size,0);
});

test('lead list uses verified local mirror without network and normalizes dates in the portal timezone', async () => {
  const f=mirrorFixture(), t=f.tables.get('LEAD_MASTER');
  t.data[1][t.data[0].indexOf('Updated At')]=new Date('2026-10-26T04:30:00Z');
  const archived=t.data[1].slice();archived[t.data[0].indexOf('Lead ID')]='archived';archived[t.data[0].indexOf('Is Archived')]=true;t.data.push(archived);
  const b=mirrorClient(f);await b.client.syncAll(true);const requests=b.requests;
  const saved=await b.client.previewLeads();
  assert.equal(b.requests,requests);assert.equal(saved.partial,true);assert.equal(saved.data.length,1);
  assert.equal(saved.data[0]['Updated At'],'2026-10-26 10:00:00');assert.equal(saved.data[0]['Lead ID'],'L1');
});

test('lead mirror preview rejects duplicate IDs and cannot cross account, scope or module access', async () => {
  for(const reason of ['duplicate','user','scope','module']) {
    const f=mirrorFixture(), b=mirrorClient(f);await b.client.syncAll(true);
    if(reason==='duplicate') {const t=f.tables.get('LEAD_MASTER');t.data.push(t.data[1].slice());await b.client.syncAll(true);}
    else b.client.bind({...f.identity(),...(reason==='user'?{user:'other'}:reason==='scope'?{scope:'f'.repeat(64)}:{leadListAllowed:false})});
    assert.equal(await b.client.previewLeads(),null,reason);
  }
});

test('full sheet mirrors preserve actual header order, duplicate headers/rows, blanks and scalar/date types', async () => {
  const f = mirrorFixture(), t = f.tables.get('LEAD_MASTER');
  t.data = [['Assigned To','Lead ID','Company Name','','Extra','Extra','When','Password'],
    ['u1','0001','Acme','',0,false,new Date('2026-10-26T04:30:00Z'),'NEVER_EXPORT'],
    ['u1','0001','Acme','',0,false,new Date('2026-10-26T04:30:00Z'),'NEVER_EXPORT'],
    ['','','','','','','','']];
  const b = mirrorClient(f); await b.client.syncAll(true);
  const data = plain(await b.client.readSheet('LEAD_MASTER'));
  assert.deepEqual(data.headers, t.data[0]); assert.equal(data.rows.length, 3);
  assert.deepEqual(data.rows.map(row => row.rowNumber), [2,3,4]);
  assert.deepEqual(data.rows[0].cells.slice(0,7), ['u1','0001','Acme','',0,false,'2026-10-26T04:30:00.000Z']);
  assert.deepEqual(data.rows[0].dates,[6]); assert.deepEqual(data.redactedColumns,[7]);
  assert.equal(data.rows[0].cells[7],null);
  assert.ok(!JSON.stringify([...b.stores.values()].flatMap(s => [...s.data.values()])).includes('NEVER_EXPORT'));
  assert.equal(f.requests.length,0,'read mirror must not write to Sheets');
});

test('catalog never exports credentials, receipts, indexes or arbitrary sheets, even to admin', async () => {
  const f = mirrorFixture(); f.add('UNREVIEWED', ['Payload'], [{ Payload:'secret' }]);
  const b = mirrorClient(f); await b.client.syncAll(true);
  assert.equal(b.client.status().sheets.length,14);
  for (const sheet of ['Staff List','_SYNC_OPERATIONS','UNREVIEWED','IDX_LEADS']) {
    assert.throws(() => f.request('apiGetSheetMirrorPage',{...f.identity(),sheet}), /Permission denied/);
    assert.equal(b.stores.has(sheet),false);
  }
});

test('complete history across multiple pages retains legitimate duplicate IDs, no UI page limit', async () => {
  const f = mirrorFixture();
  f.add('FOLLOWUP_HISTORY',['History ID','Lead ID','Done By','Remark'],Array.from({length:2105},(_,i)=>({'History ID':'duplicate','Lead ID':'L1','Done By':'u1',Remark:'row '+i})));
  const b = mirrorClient(f); await b.client.syncAll(true);
  const data = await b.client.readSheet('FOLLOWUP_HISTORY');
  assert.equal(data.rows.length,2105); assert.equal(data.rows[2104].cells[3],'row 2104');
});

test('Sheet edits/deletes/schema changes and removed tables atomically replace the local mirror', async () => {
  const f = mirrorFixture(), b = mirrorClient(f); await b.client.syncAll(true);
  const t = f.tables.get('LEAD_MASTER');
  t.data[0].push('New Column'); t.data[1].push('new'); t.data[1][t.data[0].indexOf('Company Name')] = 'Edited in Sheets';
  await b.client.syncAll(true);
  let data = await b.client.readSheet('LEAD_MASTER');
  assert.equal(data.headers.at(-1),'New Column'); assert.equal(data.rows[0].cells.at(-1),'new');
  assert.ok(data.rows[0].cells.includes('Edited in Sheets'));
  t.data.splice(1); await b.client.syncAll(true); data = await b.client.readSheet('LEAD_MASTER'); assert.equal(data.rows.length,0);
  f.tables.delete('LEAD_MASTER'); await b.client.syncAll(true); data = await b.client.readSheet('LEAD_MASTER');
  assert.equal(data.exists,false); assert.equal(data.headers.length,0);
});

test('sales users only mirror their authorized leads/linked records and permitted modules', async () => {
  const f = mirrorFixture(); f.state.user = {...f.state.user,role:'SALES',modules:['Leads','Followups']};
  const t = f.tables.get('LEAD_MASTER'); t.data.push(t.data[1].map((v,i)=>t.data[0][i]==='Lead ID'?'L2':t.data[0][i]==='Assigned To'?'u2':v));
  f.add('FOLLOWUP_HISTORY',['History ID','Lead ID','Done By','Remark'],[
    {'History ID':'H1','Lead ID':'L1','Done By':'u2',Remark:'visible'},
    {'History ID':'H2','Lead ID':'L2','Done By':'u2',Remark:'private'},
    {'History ID':'H3','Lead ID':'L2','Done By':'u1',Remark:'actor-visible'}]);
  const b = mirrorClient(f); await b.client.syncAll(true);
  assert.equal((await b.client.readSheet('LEAD_MASTER')).rows.length,1);
  assert.deepEqual(plain((await b.client.readSheet('FOLLOWUP_HISTORY')).rows.map(row=>row.cells[0])),['H1','H3']);
  assert.equal(b.client.status().sheets.some(sheet=>sheet.name==='CLIENT_FACTORY_VISITS'),false);
  f.state.user.modules=['Reports'];
  const result=f.request('apiGetSheetMirrorManifest',f.identity());
  assert.equal(result.sheets.some(sheet=>sheet.name==='FOLLOWUP_HISTORY'),false,'Reports alone does not grant raw remarks');
});

test('reassignment produces removal tombstones; permission revocation clears durable data', async () => {
  const f = mirrorFixture(); f.state.user.role='SALES';
  const b = mirrorClient(f); await b.client.syncAll(true);
  const t=f.tables.get('LEAD_MASTER'); t.data[1][t.data[0].indexOf('Assigned To')]='u2';
  await b.client.syncAll(true); assert.equal((await b.client.readSheet('LEAD_MASTER')).rows.length,0);
  f.state.permission=false; await assert.rejects(b.client.syncAll(true),/Permission denied/);
  assert.ok([...b.stores.values()].every(s=>s.data.size===0)); assert.ok(b.locks>0);
});

test('interrupted replacements retain only the previous complete generation and report failure', async () => {
  const f = mirrorFixture(); let interrupt=false;
  const b = mirrorClient(f,{request:(fn,q)=>{
    if(interrupt && q.sheet==='FOLLOWUP_HISTORY' && q.cursor)throw Error('Disconnected');
    return f.request(fn,q);
  }});
  f.add('FOLLOWUP_HISTORY',['History ID','Lead ID'],[{'History ID':'old','Lead ID':'L1'}]); await b.client.syncAll(true);
  const stored=b.stores.get('FOLLOWUP_HISTORY'), old=JSON.stringify([...stored.data.values()]);
  f.add('FOLLOWUP_HISTORY',['History ID','Lead ID'],Array.from({length:2105},(_,i)=>({'History ID':'h'+i,'Lead ID':'L1'})));
  interrupt=true; await b.client.syncAll(true);
  assert.equal(JSON.stringify([...stored.data.values()]),old);
  assert.equal(b.client.status().sheets.find(s=>s.name==='FOLLOWUP_HISTORY').state,'error');
  await assert.rejects(b.client.readSheet('FOLLOWUP_HISTORY'),/Disconnected/);
});

test('quota failure is visible and never labels an unsaved sheet as synced', async () => {
  const f=mirrorFixture(), b=mirrorClient(f);
  b.storage.table('LEAD_MASTER').fail=true; await b.client.syncAll(true);
  const status=b.client.status().sheets.find(s=>s.name==='LEAD_MASTER');
  assert.equal(status.state,'error'); assert.match(status.error,/IndexedDB/);
  await assert.rejects(b.client.readSheet('LEAD_MASTER'),/IndexedDB/);
});

test('missing content-hash support cannot claim a durable mirror commit', async () => {
  const f=mirrorFixture(), b=mirrorClient(f); b.c.crypto=undefined;
  await b.client.syncAll(true);
  assert.equal(b.client.status().sheets.find(s=>s.name==='LEAD_MASTER').state,'error');
  assert.equal(b.stores.get('LEAD_MASTER').data.size,0);
});

test('workbook scope, user changes, malformed schemas and missing IDs cannot reuse foreign data', async () => {
  const f=mirrorFixture(), b=mirrorClient(f); await b.client.syncAll(true);
  assert.throws(()=>f.request('apiGetSheetMirrorPage',{...f.identity(),workbook:'another-book',sheet:'LEAD_MASTER'}),/CACHE_SCOPE_CHANGED/);
  f.state.user.id='u2'; b.client.bind(f.identity()); await b.client.syncAll(true);
  const keys=[...b.stores.get('LEAD_MASTER').data.keys()]; assert.ok(keys.every(key=>key.includes('u2')));
  f.tables.get('LEAD_MASTER').data[0].push('Assigned To');
  await b.client.syncAll(true); assert.equal(b.client.status().sheets.find(s=>s.name==='LEAD_MASTER').state,'error');
});

test('inbound visits/events retain current portal and host/creator access rules', async () => {
  const f=mirrorFixture(); f.state.user.role='SALES'; f.state.user.modules=['ClientFactoryVisits'];
  f.add('CLIENT_FACTORY_VISITS',['Visit ID','Portal ID','Host ID','Created By'],[
    {'Visit ID':'V1','Portal ID':'portal','Host ID':'u1','Created By':'u2'},
    {'Visit ID':'V2','Portal ID':'portal','Host ID':'u2','Created By':'u2'},
    {'Visit ID':'V3','Portal ID':'other','Host ID':'u1','Created By':'u1'}]);
  f.add('CLIENT_FACTORY_VISIT_EVENTS',['Event ID','Visit ID'],[{'Event ID':'E1','Visit ID':'V1'},{'Event ID':'E2','Visit ID':'V2'}]);
  const b=mirrorClient(f); await b.client.syncAll(true);
  assert.deepEqual(plain((await b.client.readSheet('CLIENT_FACTORY_VISITS')).rows.map(r=>r.cells[0])),['V1']);
  assert.deepEqual(plain((await b.client.readSheet('CLIENT_FACTORY_VISIT_EVENTS')).rows.map(r=>r.cells[0])),['E1']);
});

test('department and archive access restrict raw rows; duplicate parent IDs fail closed', async () => {
  const f=mirrorFixture(); f.state.user.role='MANAGER'; f.state.user.modules=['Leads','Followups'];
  f.c._portalDepartmentScopeSet_=()=>({sales:true});
  const t=f.tables.get('LEAD_MASTER'), copy=t.data[1].slice();
  copy[t.data[0].indexOf('Lead ID')]='L2';copy[t.data[0].indexOf('Assigned To')]='u2';t.data.push(copy);
  const archived=t.data[1].slice();archived[t.data[0].indexOf('Lead ID')]='L3';archived[t.data[0].indexOf('Is Archived')]=true;t.data.push(archived);
  f.add('FOLLOWUP_HISTORY',['History ID','Lead ID','Done By'],['L1','L2','L3'].map(id=>({'History ID':id,'Lead ID':id,'Done By':'u1'})));
  const b=mirrorClient(f); await b.client.syncAll(true);
  assert.equal((await b.client.readSheet('LEAD_MASTER')).rows.length,1);
  assert.equal((await b.client.readSheet('FOLLOWUP_HISTORY')).rows.length,1);
  t.data.push(t.data[1].slice());await b.client.syncAll(true);
  assert.equal(b.client.status().sheets.find(s=>s.name==='FOLLOWUP_HISTORY').state,'error');
});

test('sensitive custom-field/config values do not bypass header redaction', async () => {
  const f=mirrorFixture();
  f.add('CONFIG',['Config Type','Value'],[{'Config Type':'API Token',Value:'NEVER_EXPORT'},{'Config Type':'Category',Value:'Normal'}]);
  f.add('LEAD_FIELD_VALUES',['Lead ID','Column Key','Field Value'],[{'Lead ID':'L1','Column Key':'Password','Field Value':'NEVER_EXPORT'}]);
  const b=mirrorClient(f);await b.client.syncAll(true);
  assert.equal((await b.client.readSheet('CONFIG')).rows.length,1);
  assert.equal((await b.client.readSheet('LEAD_FIELD_VALUES')).rows.length,0);
  assert.ok(!JSON.stringify([...b.stores.values()].flatMap(s=>[...s.data.values()])).includes('NEVER_EXPORT'));
});

test('background schema changes update the local table and visible column/row counts', () => {
  const nodes = new Map();
  const c=vm.createContext({ App:{currentPage:'sheetdata'},
    el:id=>{if(!nodes.has(id))nodes.set(id,{});return nodes.get(id);}, escapeHtml:String,
    SheetMirror:{status:()=>({enabled:true,sheets:[],excluded:[]})} });
  vm.runInContext(read('src/SheetMirrorView.html').replace(/^<script>\s*/,'').replace(/<\/script>\s*$/,''),c);
  vm.runInContext("sheetMirrorView.name='CONFIG';sheetMirrorView.data={headers:['Value'],rowCount:1,redactedColumns:[],rows:[{rowNumber:2,cells:['Old']} ]};renderMirrorRows();",c);
  assert.match(nodes.get('mirror-schema-note').textContent,/1 columns · 1 authorized rows/);
  c.renderSheetMirrorStatus({name:'CONFIG',records:[{value:{headers:['Value','Added'],rowCount:0,redactedColumns:[]}}]});
  assert.match(nodes.get('mirror-schema-note').textContent,/2 columns · 0 authorized rows/);
  assert.match(nodes.get('mirror-rows').innerHTML,/>Added<\/th>/);
});
