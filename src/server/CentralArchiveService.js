// Central, append-only destination. A verified copy precedes the atomic source
// removal; the source receipt/fence makes retries safe after a lost response.
const AR_META_ = ['Central Key','Origin Workbook','Origin Portal','Transfer State','Transferred At','Transfer Operation'];
const AR_TABLES_ = { AR_MASTER:'Master', AR_FOLLOWUPS:'FOLLOWUPS', AR_FOLLOWUP_HISTORY:'FOLLOWUP_HISTORY', AR_CONFIG:'PORTAL_CONFIG' };
function arEnabled_() { return !!CLIENT_CONFIG.ARCHIVE_SPREADSHEET_ID; }
function arInitialize_() {
  // Add only dedicated central tables; preserve the user's legacy archive tab.
  const book=arBook_();
  const properties=PropertiesService.getScriptProperties();
  if(properties.getProperty('AR_SCHEMA_BOOK')===book)return;
  const definitions={Master:[...LEAD_MASTER_FIELDS,'Custom Fields JSON'],
    FOLLOWUPS:[...FOLLOWUP_MASTER_FIELDS,'Custom Fields JSON'],
    FOLLOWUP_HISTORY:getSheet(SHEET_NAMES.FOLLOWUP_HISTORY).getRange(1,1,1,getSheet(SHEET_NAMES.FOLLOWUP_HISTORY).getLastColumn()).getValues()[0],
    PORTAL_CONFIG:['Sheet Name','Record JSON']};
  let metadata=Sheets.Spreadsheets.get(book,{fields:'sheets.properties'});
  const missing=Object.keys(definitions).filter(name=>!metadata.sheets.some(s=>s.properties.title===name));
  if(missing.length) {
    try { Sheets.Spreadsheets.batchUpdate({requests:missing.map(title=>({addSheet:{properties:{title,gridProperties:{rowCount:1000,columnCount:100,frozenRowCount:1}}}}))},book); }
    catch(error) {
      metadata=Sheets.Spreadsheets.get(book,{fields:'sheets.properties'});
      if(missing.some(name=>!metadata.sheets.some(s=>s.properties.title===name)))throw error;
    }
  }
  Object.entries(definitions).forEach(([name,fields])=>{
    const current=(Sheets.Spreadsheets.Values.get(book,_a1Sheet_(name)+'!1:1').values||[[]])[0];
    const required=[...new Set([...fields,...AR_META_].filter(Boolean))];
    if(!current.length) Sheets.Spreadsheets.Values.update({values:[required]},book,_a1Sheet_(name)+'!A1',{valueInputOption:'RAW'});
    else if(required.some(h=>!current.includes(h)))throw new Error('Central Archive schema needs columns in '+name+'. Existing data retained.');
  });
  properties.setProperty('AR_SCHEMA_BOOK',book);
}
function arBook_() {
  assertServerContext_();
  if (!arEnabled_() || CLIENT_CONFIG.ARCHIVE_SPREADSHEET_ID === SPREADSHEET_ID) throw new Error('Invalid central Archive configuration.');
  return CLIENT_CONFIG.ARCHIVE_SPREADSHEET_ID;
}
function arKey_(id) { return SPREADSHEET_ID + '|' + String(id || '').trim(); }
function arRead_(name, fresh) {
  const table=centralRead_(arBook_(), name, fresh);
  if(!AR_META_.every(h=>table.headers.includes(h)))throw new Error('Invalid central Archive headers: '+name);
  return table;
}
function arDecorate_(row, id, state) {
  return {...row, 'Central Key':arKey_(id), 'Origin Workbook':SPREADSHEET_ID,
    'Origin Portal':CLIENT_CONFIG.APP_TITLE, 'Transfer State':state || 'Copied', 'Transferred At':new Date().toISOString()};
}
function arLiteral_(v) { return v == null ? '' : v instanceof Date ? Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss') : String(v); }
function arProgress_(step) {
  console.log('Central Archive: '+step);
  PropertiesService.getScriptProperties().setProperty('AR_LAST_STATUS',JSON.stringify({at:new Date().toISOString(),state:'running',message:step}));
}
function arUpsert_(name, records) { return centralUpsert_(arBook_(), name, records, arRead_); }
function arPlan_(leads, followups, history, stages, limit) {
  const seen=new Set();
  const candidates=leads.filter(row=>row['Lead ID'] && _isArchivedLead_(row));
  candidates.forEach(row=>{const id=String(row['Lead ID']);if(seen.has(id))throw new Error('Duplicate source Lead ID. Source retained.');seen.add(id);});
  if(leads.filter(row=>seen.has(String(row['Lead ID']))).length!==candidates.length)throw new Error('Duplicate source Lead ID. Source retained.');
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
function arCopyConfiguration_() {
  const records=[];
  ['PIPELINE_STAGES','FIELD_CONFIG'].forEach(name=>{
    const rows=getAllRows(name);
    rows.filter(row=>Object.values(row).some(value=>value!=='' && value!=null)).forEach((row,index)=>records.push(arDecorate_({'Sheet Name':name,'Record JSON':JSON.stringify(row)},'config|'+name+'|'+(name==='PIPELINE_STAGES'?row['Stage ID']||index:row['Field ID']||index),'Configuration')));
  });
  const props=PropertiesService.getScriptProperties(),hash=leadCacheDigest_(records.map(row=>[row['Central Key'],row['Record JSON']]));
  if(props.getProperty('AR_CONFIG_HASH')===hash)return;
  arUpsert_('PORTAL_CONFIG',records);
  props.setProperty('AR_CONFIG_HASH',hash);
}
function arTransferBatch_() {
  if(!getAllRows(SHEET_NAMES.LEADS).some(_isArchivedLead_)) return {state:'committed',result:{moved:0,remaining:0}};
  const command={id:Utilities.getUuid(),action:'centralArchiveTransfer',args:[],bases:[]};
  const user={id:'archive-transfer',role:'ADMIN'};
  let moved=[];
  const result=syncAtomicWrite_(user,command,()=>{
    arProgress_('Reading source lead, follow-up and history tables');
    const leads=syncTxRows_(SHEET_NAMES.LEADS), followups=syncTxRows_(SHEET_NAMES.FOLLOWUPS), history=syncTxRows_(SHEET_NAMES.FOLLOWUP_HISTORY);
    const plan=arPlan_(leads,followups,history,getAllRows(SHEET_NAMES.STAGES),150);
    if(!plan.leads.length) return respond({moved:0,remaining:0});
    for(const [rows,key] of [[plan.followups,'Follow-up ID'],[plan.history,'History ID']]) {
      const ids=rows.map(r=>String(r[key]||''));
      if(ids.some(id=>!id)||new Set(ids).size!==ids.length)throw new Error('Invalid child IDs. Source retained.');
    }
    arProgress_('Copying stage and field configuration');
    arCopyConfiguration_();
    // Keep custom values with their parent without moving other portal modules.
    arProgress_('Reading custom values');
    const leadRows=getRowsWithCustomFieldValuesReadOnly_('Leads',plan.leads);
    const followupRows=getRowsWithCustomFieldValuesReadOnly_('Followups',plan.followups);
    const flatten=(base,merged)=>base.map((row,i)=>({...row,'Custom Fields JSON':JSON.stringify(Object.fromEntries(Object.entries(merged[i]||{}).filter(([k])=>!(k in row))))}));
    const baseLead=flatten(plan.leads,leadRows);
    const baseFollowup=flatten(plan.followups,followupRows);
    arProgress_('Copying and verifying '+plan.leads.length+' leads and their history');
    arUpsert_('Master',baseLead.map(row=>({...arDecorate_(row,row['Lead ID']),'Transfer Operation':command.id})));
    arUpsert_('FOLLOWUPS',baseFollowup.map(row=>arDecorate_(row,row['Follow-up ID'])));
    arUpsert_('FOLLOWUP_HISTORY',plan.history.map(row=>arDecorate_(row,row['History ID'])));
    arProgress_('Committing verified source removal');
    moved=plan.leads.map(row=>String(row['Lead ID']));const ids=new Set(moved);
    syncTxDelete_(SHEET_NAMES.FOLLOWUPS,row=>ids.has(String(row['Lead ID'])));
    syncTxDelete_(SHEET_NAMES.FOLLOWUP_HISTORY,row=>ids.has(String(row['Lead ID'])));
    syncTxDelete_(SHEET_NAMES.LEADS,row=>ids.has(String(row['Lead ID'])));
    _bumpStamp('leads');_bumpStamp('followups');_bumpStamp('followup_history');
    return respond({moved:moved.length,remaining:plan.remaining,leadIds:moved});
  });
  if(result.state==='committed' && moved.length) arUpsert_('Master',moved.map(id=>arDecorate_({},id,'Transferred')));
  return result;
}
function arRepairReceipts_() {
  const source=new Map(getAllRows(SHEET_NAMES.LEADS).map(r=>[String(r['Lead ID']),r]));
  const pending=arRead_('Master').rows.filter(r=>r.value['Origin Workbook']===SPREADSHEET_ID && ['Pending','Copied'].includes(r.value['Transfer State']));
  const receipts=getSpreadsheet(SYNC_RECEIPTS_).getSheetByName(SYNC_RECEIPTS_).getDataRange().getValues();
  const committed=new Map();
  receipts.slice(1).filter(row=>row[1]==='archive-transfer').forEach(row=>{const result=JSON.parse(row[3]);committed.set(row[0],new Set((result.leadIds||[]).map(String)));});
  const changes=[];
  pending.forEach(({value})=>{
    if(String(value['Transfer Operation']||'').startsWith('disqualified|'))return;
    const id=String(value['Lead ID']),lead=source.get(id);
    if(lead && !_isArchivedLead_(lead))changes.push(arDecorate_({},id,'Cancelled'));
    else if(!lead && value['Transfer State']==='Copied') {
      if(!committed.get(value['Transfer Operation'])?.has(id))throw new Error('Source lead missing without a confirmed transfer receipt. Review central copies before continuing.');
      changes.push(arDecorate_({},id,'Transferred'));
    }
  });
  if(changes.length)arUpsert_('Master',changes);
}
function centralArchiveWorker_() {
  if(!arEnabled_())return;
  return withServerContext_(()=>{
    const props=PropertiesService.getScriptProperties(),started=Date.now();
    if(Number(props.getProperty('AR_NEXT_RUN_AT')||0)>started)return {state:'retry'};
    const lease=Utilities.getUuid(),leaseLock=LockService.getScriptLock();
    if(!leaseLock.tryLock(1000))return {state:'retry'};
    try {
      const active=JSON.parse(props.getProperty('AR_WORKER_LEASE')||'null');
      if(active && active.until>Date.now())return {state:'retry'};
      props.setProperty('AR_WORKER_LEASE',JSON.stringify({id:lease,until:Date.now()+600000}));
    } finally {leaseLock.releaseLock();}
    const previousReadMode=_bootstrapReadMode_;_bootstrapReadMode_=true;
    try {
      arProgress_('Checking pending source records');
      arInitialize_();
      arCopyConfiguration_();
      arRepairRestores_();
      if(!getSpreadsheet(SYNC_RECEIPTS_).getSheetByName(SYNC_RECEIPTS_)) {
        const setupLock=LockService.getScriptLock();if(!setupLock.tryLock(1000))return {state:'retry'};
        try{safeInitHeaders(SYNC_RECEIPTS_,SYNC_RECEIPT_HEADERS_);}finally{setupLock.releaseLock();}
      }
      arRepairReceipts_();
      arTransferDisqualified_();
      // One bundle batch per trigger keeps bulk migration below Sheets' shared
      // per-minute read budget and leaves capacity for interactive portal saves.
      const result=arTransferBatch_();
      if(result.state!=='retry')props.setProperty('AR_LAST_STATUS',JSON.stringify({at:new Date().toISOString(),state:result.state,message:result.message||'',...result.result}));
      return result;
    } catch(error) {
      if(/quota|rate.?limit|too many|429/i.test(String(error.message||error)))props.setProperty('AR_NEXT_RUN_AT',String(Date.now()+120000));
      props.setProperty('AR_LAST_STATUS',JSON.stringify({at:new Date().toISOString(),state:'error',message:String(error.message||error)}));
      logServerError_(error,{api:'centralArchiveWorker'});throw error;
    } finally {
      _bootstrapReadMode_=previousReadMode;
      const active=JSON.parse(props.getProperty('AR_WORKER_LEASE')||'null');
      if(active && active.id===lease)props.deleteProperty('AR_WORKER_LEASE');
    }
  });
}
function arTransferDisqualified_() {
  if(typeof dqEnabled_!=='function'||!dqEnabled_())return;
  // Older rollouts put archived Disqualified leads in DQ Master. Move their
  // verified bundle, retaining the old copy as an audit record (not visible).
  const lock=LockService.getScriptLock();if(!lock.tryLock(1000))return;
  try {
    const local=new Set(getAllRows(SHEET_NAMES.LEADS).map(r=>String(r['Lead ID'])));
    const destination=new Map(arRead_('Master',true).rows.map(r=>[r.value['Central Key'],r.value]));
    const candidates=dqRead_('Master',true).rows.map(r=>r.value).filter(r=>r['Origin Workbook']===SPREADSHEET_ID && _isArchivedLead_(r) &&
      !local.has(String(r['Lead ID'])) && (r['Transfer State']==='Transferred'||r['Transfer State']==='Archived'&&destination.get(r['Central Key'])?.['Transfer State']==='Copied')).slice(0,20);
    if(!candidates.length)return;
    const ids=new Set(candidates.map(r=>String(r['Lead ID'])));
    const children=name=>dqRead_(name,true).rows.map(r=>r.value).filter(r=>r['Origin Workbook']===SPREADSHEET_ID&&ids.has(String(r['Lead ID'])));
    arUpsert_('Master',candidates.map(r=>({...arDecorate_(r,r['Lead ID']),'Transfer Operation':'disqualified|'+r['Central Key']})));
    arUpsert_('FOLLOWUPS',children('FOLLOWUPS').map(r=>arDecorate_(r,r['Follow-up ID'])));
    arUpsert_('FOLLOWUP_HISTORY',children('FOLLOWUP_HISTORY').map(r=>arDecorate_(r,r['History ID'])));
    const fresh=dqRead_('Master',true).rows.map(r=>r.value);
    if(candidates.some(r=>JSON.stringify(fresh.find(x=>x['Central Key']===r['Central Key']))!==JSON.stringify(r)))
      throw new Error('Disqualified archive source changed. Copies retained for retry.');
    dqUpsert_('Master',candidates.map(r=>dqDecorate_({},r['Lead ID'],'Archived')));
    arUpsert_('Master',candidates.map(r=>arDecorate_({},r['Lead ID'],'Transferred')));
  } finally {lock.releaseLock();}
}
function arEnsureWorker_() {
  if(!arEnabled_())return;
  const props=PropertiesService.getScriptProperties();if(props.getProperty('AR_WORKER_VERSION')==='1')return;
  if(!ScriptApp.getProjectTriggers().some(t=>t.getHandlerFunction()==='centralArchiveWorker_')) ScriptApp.newTrigger('centralArchiveWorker_').timeBased().everyMinutes(1).create();
  props.setProperty('AR_WORKER_VERSION','1');
}
function arVisibleLeads_(user) {
  const rows=arRead_('Master').rows.map(r=>r.value).filter(r=>r['Origin Workbook']===SPREADSHEET_ID && r['Transfer State']==='Transferred');
  const local=new Set(getAllRows(SHEET_NAMES.LEADS).map(r=>String(r['Lead ID'])));
  return _scopeAssignedRows(rows,user).filter(row=>!local.has(String(row['Lead ID'])));
}
function arMirrorTable_(logical,user) {
  const name=AR_TABLES_[logical];if(!name)throw new Error('Invalid central table.');
  const table=arRead_(name),leads=arVisibleLeads_(user),ids=new Set(leads.map(r=>String(r['Lead ID'])));
  const allowed=table.rows.filter(r=>r.value['Origin Workbook']===SPREADSHEET_ID && (logical==='AR_CONFIG' || ids.has(String(r.value['Lead ID']))));
  return {name:logical,exists:true,sheetId:null,headers:table.headers,rows:allowed.map(r=>({rowNumber:r.row,cells:table.headers.map(h=>r.value[h]),object:r.value}))};
}
function apiGetCentralArchive(token) {
  _currentApiToken_=token||'';
  return apiGuard_('apiGetCentralArchive',()=>{
    const user=_requireModule('Archive');
    return respond({leads:arVisibleLeads_(user),status:user.role==='ADMIN'?PropertiesService.getScriptProperties().getProperty('AR_LAST_STATUS')||'':null});
  });
}
function apiGetCentralArchiveDetail(token,leadId) {
  _currentApiToken_=token||'';
  return apiGuard_('apiGetCentralArchiveDetail',()=>{
    const user=_requireModule('Archive'),lead=arVisibleLeads_(user).find(r=>String(r['Lead ID'])===String(leadId));
    if(!lead)throw new Error('Permission denied.');
    const linked=name=>arRead_(name).rows.map(r=>r.value).filter(r=>r['Origin Workbook']===SPREADSHEET_ID && String(r['Lead ID'])===String(leadId));
    return respond({lead,followups:linked('FOLLOWUPS'),history:linked('FOLLOWUP_HISTORY')});
  });
}

function arFindLead_(id) {
  if(!arEnabled_())return null;
  const matches=arRead_('Master',true).rows.map(r=>r.value).filter(r=>r['Origin Workbook']===SPREADSHEET_ID &&
    r['Transfer State']==='Transferred' && String(r['Lead ID'])===String(id));
  if(matches.length>1)throw new Error('Duplicate central archive lead.');
  return matches[0]||null;
}
function arPrepareRestore_(id,user) {
  if(!arEnabled_() || getRowByIndexedId_(SHEET_NAMES.LEADS,'Lead ID',id))return null;
  if(!SYNC_TX_)throw new Error('Central archive restore requires the atomic sync path.');
  const lead=arFindLead_(id);
  if(!lead || !_canReadAssignedRow(lead,user))throw new Error('Permission denied. Archive lead unavailable.');
  const linked=name=>arRead_(name,true).rows.map(r=>r.value).filter(r=>r['Origin Workbook']===SPREADSHEET_ID && String(r['Lead ID'])===String(id));
  for(const [name,key,rows] of [[SHEET_NAMES.LEADS,'Lead ID',[lead]],[SHEET_NAMES.FOLLOWUPS,'Follow-up ID',linked('FOLLOWUPS')],
    [SHEET_NAMES.FOLLOWUP_HISTORY,'History ID',linked('FOLLOWUP_HISTORY')]]) {
    const ids=new Set(),headers=syncTxTable_(name).headers;
    rows.forEach(row=>{
      if(!row[key] || ids.has(String(row[key])) || syncTxRow_(name,key,row[key]))throw new Error('SYNC_CONFLICT: Archive restore ID already exists.');
      ids.add(String(row[key]));
      const unknown=Object.keys(row).filter(h=>!AR_META_.includes(h)&&h!=='Custom Fields JSON'&&!headers.includes(h)&&row[h]!=='');
      if(unknown.length)throw new Error('Archive restore needs source columns: '+unknown.join(', '));
      syncTxInsert_(name,row);
      if(name!==SHEET_NAMES.FOLLOWUP_HISTORY && row['Custom Fields JSON']) {
        const values=JSON.parse(row['Custom Fields JSON']);
        upsertCustomFieldValues_(name===SHEET_NAMES.LEADS?'Leads':'Followups',row[key],values,user.id,row['Stage ID']);
      }
    });
  }
  return lead['Transfer Operation'];
}
function arRepairRestores_() {
  const sheet=getSpreadsheet(SYNC_RECEIPTS_).getSheetByName(SYNC_RECEIPTS_);if(!sheet)return;
  const receipts=sheet.getDataRange().getValues().slice(1).map(r=>JSON.parse(r[3]));
  const restored=new Map(receipts.filter(r=>r&&r.centralArchiveRestored).map(r=>[String(r.leadId),r.centralArchiveRestored]));
  const changes=arRead_('Master',true).rows.map(r=>r.value).filter(r=>r['Origin Workbook']===SPREADSHEET_ID &&
    r['Transfer State']==='Transferred' && restored.get(String(r['Lead ID']))===r['Transfer Operation']);
  if(changes.length)arUpsert_('Master',changes.map(r=>arDecorate_({},r['Lead ID'],'Restored')));
}
function apiRunArchiveTransfer(token) {
  _currentApiToken_=token||'';
  return apiGuard_('apiRunArchiveTransfer',()=>{
    if(_apiUser().role!=='ADMIN')throw new Error('Permission denied.');
    arEnsureWorker_();return respond(centralArchiveWorker_());
  });
}
