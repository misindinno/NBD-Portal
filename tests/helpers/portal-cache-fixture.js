'use strict';
const vm = require('node:vm');
const {serverFixture, read, browserFactory, memoryStorage} = require('./lead-cache-fixture');
function moduleFixture() {
  const f = serverFixture(3), c = f.c;
  c.PropertiesService={getScriptProperties:()=>({getProperty:key=>['LEAD_READ_CACHE_ENABLED','PORTAL_READ_CACHE_ENABLED'].includes(key)&&!f.state.disabled?'true':null})};
  f.state.user.modules = ['Leads','Followups','Archive','Reports'];
  f.state.user.email = 'u1@example.test';
  f.state.rows[1]['Assigned To'] = 'u2';
  f.state.rows[2]['Is Archived'] = true;
  f.state.rows[2]['Archive Reason'] = 'Synthetic';
  const history = [
    {'History ID':'h1','Lead ID':'00000','Done By':'u1','Done Date':'2026-10-24','Contact Mode':'Call Connected'},
    {'History ID':'h1','Lead ID':'00000','Done By':'u1','Done Date':'2026-10-24','Contact Mode':'Call Connected'},
    {'History ID':'h2','Lead ID':'00000','Done By':'u1','Done Date':'2026-10-24','Contact Mode':'Not Picked'},
    {'History ID':'h3','Lead ID':'00000','Done By':'u1','Done Date':'2026-10-24','Contact Mode':'WhatsApp Chat'},
    {'History ID':'h4','Lead ID':'00001','Done By':'u1','Done Date':'2026-10-24','Contact Mode':'Not Picked'}
  ];
  const tables = {
    history, followups:[{'Follow-up ID':'f1','Lead ID':'00001','Created By':'u1','Follow-up Type':'Call','Next Follow-up Date':'2026-10-24'}],
    activity:[{'Activity ID':'a1','Lead ID':'00001','Created By':'u1'}], stages:[],
    users:[{ID:'u1',Name:'User One',Department:'Sales'},{ID:'u2',Name:'User Two',Department:'Other'}]
  };
  Object.assign(c.SHEET_NAMES,{FOLLOWUPS:'followups',FOLLOWUP_HISTORY:'history',LEAD_ACTIVITY_LOGS:'activity',STAGES:'stages',IDX_LEADS:'index'});
  const getAll = c.getAllRows;
  c.getAllRows = name => tables[name] ? structuredClone(tables[name]) : getAll(name);
  c.assertServerContext_ = () => {};
  c.now = () => '2026-10-24 12:00:00'; c.today = () => '2026-10-24';
  c.daysDiff = value => Math.floor((Date.parse('2026-10-24') - Date.parse(value)) / 86400000);
  c._isLeadPushedToNbd_ = row => !!(row['NBD Lead ID'] || row['Pushed To NBD At']);
  c.Utilities.formatDate = date => new Date(date.getTime() + 330*60000).toISOString().slice(0,10);
  for(const file of ['ArchitectureCore','SheetReadApiService','FollowupService','ArchiveService','ClientCallReportService','PortalReadCacheService']) vm.runInContext(read('src/server/'+file+'.js'),c);
  c.logServerError_ = () => {};
  c.safeClientErrorMessage_ = error => error.message;
  c.sheetApiBatchGetRows_ = specs => Object.fromEntries(specs.map(spec => [spec.sheetName,c.getAllRows(spec.sheetName)]));
  c.ensureArchiveSchema_ = () => {throw Error('No schema writes allowed in cache reads');};
  c.rebuildIndexForSheet_ = () => {throw Error('No index writes allowed in cache reads');};
  c.getSheet = () => {throw Error('No index repair lookup permitted');};
  c.leadArchiveState_ = row => !!row['Is Archived'];
  // Context setup above loads real request-context helpers; keep transport mocks.
  c.Utilities.getUuid = () => 'synthetic-request';
  function request(input) { const result = JSON.parse(JSON.stringify(c.apiGetPortalReadCachePage('synthetic-session',input))); if(!result.success)throw Object.assign(Error(result.error),{code:result.code});return result.data; }
  return {...f,tables,request};
}
function moduleClient(f, storage = memoryStorage()) {
  const c = browserFactory();
  vm.runInContext(read('src/PortalReadCache.html').replace(/^<script>\s*/,'').split('const PortalReadCache =')[0],c);
  let requests=0,locks=0;
  const client=c.createPortalReadCache({request:async query=>{requests++;return f.request(query);},storageFactory:()=>storage,onLock:()=>locks++});
  client.bind(f.identity());
  return {client,storage,get requests(){return requests;},get locks(){return locks;},c};
}
module.exports={moduleFixture,moduleClient};
