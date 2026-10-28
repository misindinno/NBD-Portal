// Central, append-only destination. A verified copy precedes the atomic source
// removal; the source receipt/fence makes retries safe after a lost response.
const DQ_META_ = ['Central Key','Origin Workbook','Origin Portal','Transfer State','Transferred At'];
const DQ_TABLES_ = { DQ_MASTER:'Master', DQ_FOLLOWUPS:'FOLLOWUPS', DQ_FOLLOWUP_HISTORY:'FOLLOWUP_HISTORY', DQ_CONFIG:'PORTAL_CONFIG' };
function dqEnabled_() { return !!CLIENT_CONFIG.DISQUALIFIED_SPREADSHEET_ID; }
function dqBook_() {
  assertServerContext_();
  if (!dqEnabled_() || CLIENT_CONFIG.DISQUALIFIED_SPREADSHEET_ID === SPREADSHEET_ID) throw new Error('Invalid central Disqualified configuration.');
  return CLIENT_CONFIG.DISQUALIFIED_SPREADSHEET_ID;
}
function dqKey_(id) { return SPREADSHEET_ID + '|' + String(id || '').trim(); }
function dqRead_(name, fresh) {
  let values;
  if(fresh) {
    // SpreadsheetApp can reuse a read made before an Advanced Sheets write.
    // Verification must use a fresh server read from the same API as the write.
    values=(Sheets.Spreadsheets.Values.get(dqBook_(),_a1Sheet_(name),{valueRenderOption:'UNFORMATTED_VALUE'}).values||[]).map(row=>row.map(dqLiteral_));
  } else {
    const sheet=SpreadsheetApp.openById(dqBook_()).getSheetByName(name);
    if(!sheet)throw new Error('Central sheet not initialized: '+name);
    values=sheet.getDataRange().getDisplayValues();
  }
  const headers = values[0] || [];
  if (new Set(headers).size !== headers.length || !DQ_META_.every(key => headers.includes(key))) throw new Error('Invalid central sheet headers: ' + name);
  return {name, headers, rows:values.slice(1).map((values,index) => ({row:index+2, value:Object.fromEntries(headers.map((h,i) => [h, values[i] == null ? '' : values[i]]))}))};
}
function dqDecorate_(row, id, state) {
  return {...row, 'Central Key':dqKey_(id), 'Origin Workbook':SPREADSHEET_ID,
    'Origin Portal':CLIENT_CONFIG.APP_TITLE, 'Transfer State':state || 'Copied', 'Transferred At':new Date().toISOString()};
}
function dqLiteral_(v) { return v == null ? '' : v instanceof Date ? Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss') : String(v); }
function dqProgress_(step) {
  console.log('Central Disqualified: '+step);
  PropertiesService.getScriptProperties().setProperty('DQ_LAST_STATUS',JSON.stringify({at:new Date().toISOString(),state:'running',message:step}));
}
function dqUpsert_(name, records) {
  if (!records.length) return;
  if(new Set(records.map(r=>r['Central Key'])).size!==records.length)throw new Error('Duplicate incoming central key. Source retained.');
  const table=dqRead_(name,true), index=new Map();
  table.rows.forEach(row => {
    const key=row.value['Central Key']; if (!key) return;
    if (index.has(key)) throw new Error('Duplicate central record key in ' + name);
    index.set(key,row);
  });
  const changes=[], added=[];
  records.forEach(record => {
    if (record['Origin Workbook'] !== SPREADSHEET_ID || !record['Central Key']) throw new Error('Invalid central origin.');
    const unknown=Object.keys(record).filter(key => key && record[key] !== '' && !table.headers.includes(key));
    if (unknown.length) throw new Error('Central schema needs columns: ' + unknown.join(', '));
    const existing=index.get(record['Central Key']);
    const merged={...(existing ? existing.value : {}),...record};
    const values=table.headers.map(h => dqLiteral_(merged[h]));
    if (values.some(v => v.length > 49000)) throw new Error('Central cell exceeds the supported size. Source retained.');
    if (existing) changes.push({range:_a1Sheet_(name)+'!A'+existing.row+':'+_columnLetter_(table.headers.length)+existing.row, values:[values]});
    else added.push(values);
  });
  if (changes.length) Sheets.Spreadsheets.Values.batchUpdate({valueInputOption:'RAW',data:changes},dqBook_());
  // Sheets append allocates rows atomically across the six independent scripts.
  if (added.length) Sheets.Spreadsheets.Values.append({values:added},dqBook_(),_a1Sheet_(name)+'!A:'+_columnLetter_(table.headers.length),{valueInputOption:'RAW',insertDataOption:'INSERT_ROWS'});
  const verified=dqRead_(name,true).rows;
  records.forEach(record => {
    const hits=verified.filter(row => row.value['Central Key']===record['Central Key']);
    const mismatch=hits.length===1?Object.keys(record).filter(key=>dqLiteral_(record[key])!==dqLiteral_(hits[0].value[key])):['Central Key'];
    if(mismatch.length)throw new Error('Central verification failed in '+name+' ('+mismatch.join(', ')+'). Source retained.');
  });
}
function dqStageIds_(stages) { return new Set(stages.filter(s => /disqualif/i.test(String(s['Stage Name']||''))).map(s=>String(s['Stage ID']))); }
function dqPlan_(leads, followups, history, stages, limit) {
  const stageIds=dqStageIds_(stages), seen=new Set();
  const candidates=leads.filter(row=>row['Lead ID'] && stageIds.has(String(row['Stage ID'])));
  candidates.forEach(row=>{const id=String(row['Lead ID']);if(seen.has(id))throw new Error('Duplicate source Lead ID. Source retained.');seen.add(id);});
  const selected=[]; let size=0;
  for(const row of candidates) {
    const id=String(row['Lead ID']), cost=1+followups.filter(f=>String(f['Lead ID'])===id).length+history.filter(h=>String(h['Lead ID'])===id).length;
    if(selected.length && (selected.length>=limit || size+cost>600)) break;
    if(cost>1200) throw new Error('Lead history is too large for one safe transfer. Source retained.');
    selected.push(row);size+=cost;
  }
  const ids=new Set(selected.map(row=>String(row['Lead ID'])));
  return {leads:selected,followups:followups.filter(r=>ids.has(String(r['Lead ID']))),history:history.filter(r=>ids.has(String(r['Lead ID']))),remaining:candidates.length-selected.length};
}
function dqCopyConfiguration_() {
  const records=[];
  ['PIPELINE_STAGES','FIELD_CONFIG'].forEach(name=>{
    const rows=getAllRows(name);
    rows.filter(row=>Object.values(row).some(value=>value!=='' && value!=null)).forEach((row,index)=>records.push(dqDecorate_({'Sheet Name':name,'Record JSON':JSON.stringify(row)},'config|'+name+'|'+(name==='PIPELINE_STAGES'?row['Stage ID']||index:row['Field ID']||index),'Configuration')));
  });
  const props=PropertiesService.getScriptProperties(),hash=leadCacheDigest_(records.map(row=>[row['Central Key'],row['Record JSON']]));
  if(props.getProperty('DQ_CONFIG_HASH')===hash)return;
  dqUpsert_('PORTAL_CONFIG',records);
  props.setProperty('DQ_CONFIG_HASH',hash);
}
function dqTransferBatch_() {
  const stages=dqStageIds_(getAllRows(SHEET_NAMES.STAGES));
  if(!getAllRows(SHEET_NAMES.LEADS).some(row=>stages.has(String(row['Stage ID'])))) return {state:'committed',result:{moved:0,remaining:0}};
  const command={id:Utilities.getUuid(),action:'centralDisqualifiedTransfer',args:[],bases:[]};
  const user={id:'central-transfer',role:'ADMIN'};
  let moved=[];
  const result=syncAtomicWrite_(user,command,()=>{
    dqProgress_('Reading source lead, follow-up and history tables');
    const leads=syncTxRows_(SHEET_NAMES.LEADS), followups=syncTxRows_(SHEET_NAMES.FOLLOWUPS), history=syncTxRows_(SHEET_NAMES.FOLLOWUP_HISTORY);
    const plan=dqPlan_(leads,followups,history,getAllRows(SHEET_NAMES.STAGES),150);
    if(!plan.leads.length) return respond({moved:0,remaining:0});
    for(const [rows,key] of [[plan.followups,'Follow-up ID'],[plan.history,'History ID']]) {
      const ids=rows.map(r=>String(r[key]||''));
      if(ids.some(id=>!id)||new Set(ids).size!==ids.length)throw new Error('Invalid child IDs. Source retained.');
    }
    dqProgress_('Copying stage and field configuration');
    dqCopyConfiguration_();
    // Keep custom values with their parent without moving other portal modules.
    dqProgress_('Reading custom values');
    const leadRows=getRowsWithCustomFieldValuesReadOnly_('Leads',plan.leads);
    const followupRows=getRowsWithCustomFieldValuesReadOnly_('Followups',plan.followups);
    const flatten=(base,merged)=>base.map((row,i)=>({...row,'Custom Fields JSON':JSON.stringify(Object.fromEntries(Object.entries(merged[i]||{}).filter(([k])=>!(k in row))))}));
    const baseLead=flatten(plan.leads,leadRows);
    const baseFollowup=flatten(plan.followups,followupRows);
    dqProgress_('Copying and verifying '+plan.leads.length+' leads and their history');
    dqUpsert_('Master',baseLead.map(row=>dqDecorate_(row,row['Lead ID'])));
    dqUpsert_('FOLLOWUPS',baseFollowup.map(row=>dqDecorate_(row,row['Follow-up ID'])));
    dqUpsert_('FOLLOWUP_HISTORY',plan.history.map(row=>dqDecorate_(row,row['History ID'])));
    dqProgress_('Committing verified source removal');
    moved=plan.leads.map(row=>String(row['Lead ID']));const ids=new Set(moved);
    syncTxDelete_(SHEET_NAMES.FOLLOWUPS,row=>ids.has(String(row['Lead ID'])));
    syncTxDelete_(SHEET_NAMES.FOLLOWUP_HISTORY,row=>ids.has(String(row['Lead ID'])));
    syncTxDelete_(SHEET_NAMES.LEADS,row=>ids.has(String(row['Lead ID'])));
    _bumpStamp('leads');_bumpStamp('followups');_bumpStamp('followup_history');
    return respond({moved:moved.length,remaining:plan.remaining,leadIds:moved});
  });
  if(result.state==='committed' && moved.length) dqUpsert_('Master',moved.map(id=>dqDecorate_({},id,'Transferred')));
  return result;
}
function dqRepairReceipts_() {
  const source=new Map(getAllRows(SHEET_NAMES.LEADS).map(r=>[String(r['Lead ID']),r])),stages=dqStageIds_(getAllRows(SHEET_NAMES.STAGES));
  const pending=dqRead_('Master').rows.filter(r=>r.value['Origin Workbook']===SPREADSHEET_ID && ['Pending','Copied'].includes(r.value['Transfer State']));
  const receipts=getSpreadsheet(SYNC_RECEIPTS_).getSheetByName(SYNC_RECEIPTS_).getDataRange().getValues();
  const committed=new Set();
  receipts.slice(1).filter(row=>row[1]==='central-transfer').forEach(row=>{const result=JSON.parse(row[3]);(result.leadIds||[]).forEach(id=>committed.add(String(id)));});
  const changes=[];
  pending.forEach(({value})=>{
    const id=String(value['Lead ID']),lead=source.get(id);
    if(lead && !stages.has(String(lead['Stage ID'])))changes.push(dqDecorate_({},id,'Cancelled'));
    else if(!lead && value['Transfer State']==='Copied') {
      if(!committed.has(id))throw new Error('Source lead missing without a confirmed transfer receipt. Review central copies before continuing.');
      changes.push(dqDecorate_({},id,'Transferred'));
    }
  });
  if(changes.length)dqUpsert_('Master',changes);
}
function centralDisqualifiedWorker_() {
  if(!dqEnabled_())return;
  return withServerContext_(()=>{
    const props=PropertiesService.getScriptProperties(),started=Date.now();
    const lease=Utilities.getUuid(),leaseLock=LockService.getScriptLock();
    if(!leaseLock.tryLock(1000))return {state:'retry'};
    try {
      const active=JSON.parse(props.getProperty('DQ_WORKER_LEASE')||'null');
      if(active && active.until>Date.now())return {state:'retry'};
      props.setProperty('DQ_WORKER_LEASE',JSON.stringify({id:lease,until:Date.now()+600000}));
    } finally {leaseLock.releaseLock();}
    const previousReadMode=_bootstrapReadMode_;_bootstrapReadMode_=true;
    try {
      dqProgress_('Checking pending source records');
      dqCopyConfiguration_();
      if(!getSpreadsheet(SYNC_RECEIPTS_).getSheetByName(SYNC_RECEIPTS_)) {
        const setupLock=LockService.getScriptLock();if(!setupLock.tryLock(1000))return {state:'retry'};
        try{safeInitHeaders(SYNC_RECEIPTS_,SYNC_RECEIPT_HEADERS_);}finally{setupLock.releaseLock();}
      }
      dqRepairReceipts_();
      let result;
      do { result=dqTransferBatch_(); if(result.state!=='committed')break; }
      while(result.result && result.result.remaining>0 && Date.now()-started<180000);
      if(result.state!=='retry')props.setProperty('DQ_LAST_STATUS',JSON.stringify({at:new Date().toISOString(),state:result.state,message:result.message||'',...result.result}));
      return result;
    } catch(error) {
      props.setProperty('DQ_LAST_STATUS',JSON.stringify({at:new Date().toISOString(),state:'error',message:String(error.message||error)}));
      logServerError_(error,{api:'centralDisqualifiedWorker'});throw error;
    } finally {
      _bootstrapReadMode_=previousReadMode;
      const active=JSON.parse(props.getProperty('DQ_WORKER_LEASE')||'null');
      if(active && active.id===lease)props.deleteProperty('DQ_WORKER_LEASE');
    }
  });
}
function dqEnsureWorker_() {
  if(!dqEnabled_())return;
  const props=PropertiesService.getScriptProperties();if(props.getProperty('DQ_WORKER_VERSION')==='1')return;
  if(!ScriptApp.getProjectTriggers().some(t=>t.getHandlerFunction()==='centralDisqualifiedWorker_')) ScriptApp.newTrigger('centralDisqualifiedWorker_').timeBased().everyMinutes(1).create();
  props.setProperty('DQ_WORKER_VERSION','1');
}
function dqVisibleLeads_(user) {
  const rows=dqRead_('Master').rows.map(r=>r.value).filter(r=>r['Origin Workbook']===SPREADSHEET_ID && r['Transfer State']==='Transferred');
  const canArchive=user.role==='ADMIN'||userHasModule(user,'Archive');
  return _scopeAssignedRows(rows,user).filter(row=>canArchive || !_isArchivedLead_(row));
}
function dqMirrorTable_(logical,user) {
  const name=DQ_TABLES_[logical];if(!name)throw new Error('Invalid central table.');
  const table=dqRead_(name),leads=dqVisibleLeads_(user),ids=new Set(leads.map(r=>String(r['Lead ID'])));
  const allowed=table.rows.filter(r=>r.value['Origin Workbook']===SPREADSHEET_ID && (logical==='DQ_CONFIG' || ids.has(String(r.value['Lead ID']))));
  return {name:logical,exists:true,sheetId:null,headers:table.headers,rows:allowed.map(r=>({rowNumber:r.row,cells:table.headers.map(h=>r.value[h]),object:r.value}))};
}
function apiGetDisqualified(token) {
  _currentApiToken_=token||'';
  return apiGuard_('apiGetDisqualified',()=>{
    const user=_requireModule('Leads');
    return respond({leads:dqVisibleLeads_(user),status:user.role==='ADMIN'?PropertiesService.getScriptProperties().getProperty('DQ_LAST_STATUS')||'':null});
  });
}
function apiGetDisqualifiedDetail(token,leadId) {
  _currentApiToken_=token||'';
  return apiGuard_('apiGetDisqualifiedDetail',()=>{
    const user=_requireModule('Leads'),lead=dqVisibleLeads_(user).find(r=>String(r['Lead ID'])===String(leadId));
    if(!lead)throw new Error('Permission denied.');
    const linked=name=>dqRead_(name).rows.map(r=>r.value).filter(r=>r['Origin Workbook']===SPREADSHEET_ID && String(r['Lead ID'])===String(leadId));
    return respond({lead,followups:linked('FOLLOWUPS'),history:linked('FOLLOWUP_HISTORY')});
  });
}
function apiRunDisqualifiedTransfer(token) {
  _currentApiToken_=token||'';
  return apiGuard_('apiRunDisqualifiedTransfer',()=>{
    if(_apiUser().role!=='ADMIN')throw new Error('Permission denied.');
    dqEnsureWorker_();return respond(centralDisqualifiedWorker_());
  });
}
