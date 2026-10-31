// Central Archive CRUD keeps children intact. Delete means recoverable Trash.
const AR_EDIT_FIELDS_ = ['Company Name','Contact Person','Phone','WhatsApp No','Alternate No','Email','City','State','Address','GST No','Remark','Client Description','Archive Reason'];
function arRevision_(lead) {
  return leadCacheDigest_(Object.keys(lead).sort().map(key=>[key,lead[key]]));
}
function arManageUser_() {
  const user=_requireModule('Archive');
  _assertCanMutate_(user,'archive','restoreArchivedLead');
  return user;
}
function arManageRecord_(id,user) {
  const table=arRead_('Master',true);
  const matches=table.rows.filter(r=>r.value['Central Key']===arKey_(id) && r.value['Origin Workbook']===SPREADSHEET_ID);
  if(matches.length!==1 || !['Transferred','Trashed'].includes(matches[0].value['Transfer State']) || !_canReadAssignedRow(matches[0].value,user))
    throw new Error('Archive record unavailable or permission denied.');
  if(getRowByIndexedId_(SHEET_NAMES.LEADS,'Lead ID',id))throw new Error('Cannot edit: archive transfer is not complete. Refresh before editing.');
  return {table,row:matches[0]};
}
function apiPrepareArchiveManagement(token,leadId) {
  _currentApiToken_=token||'';
  return apiGuard_('apiPrepareArchiveManagement',()=>{
    const user=arManageUser_(),local=getRowByIndexedId_(SHEET_NAMES.LEADS,'Lead ID',leadId);
    if(local) {
      if(!_isArchivedLead_(local)||!_canReadAssignedRow(local,user))throw new Error('Permission denied.');
      arInitialize_();
      if(!getSpreadsheet(SYNC_RECEIPTS_).getSheetByName(SYNC_RECEIPTS_))safeInitHeaders(SYNC_RECEIPTS_,SYNC_RECEIPT_HEADERS_);
      arRepairReceipts_();
      const moved=arTransferBatch_(leadId);
      if(moved.state!=='committed')throw new Error('Cannot edit yet: archive transfer pending. Retry shortly.');
    }
    const {row}=arManageRecord_(leadId,user);
    return respond({lead:row.value,revision:arRevision_(row.value),fields:AR_EDIT_FIELDS_});
  });
}
function arManagementReceipt_(table,key,user,hash) {
  const rows=table.rows.filter(r=>r.value['Central Key']===key);
  if(!rows.length)return null;
  if(rows.length!==1)throw new Error('Duplicate archive receipt. Contact an administrator.');
  const receipt=JSON.parse(rows[0].value['Record JSON']);
  if(receipt.user!==user.id || receipt.hash!==hash)throw new Error('Invalid archive operation ID reuse.');
  return receipt.result;
}
function arManage_(user,command) {
  if(!command || !/^[a-f0-9-]{36}$/i.test(command.id||'') || !command.leadId || !command.revision ||
      !['update','trash','recover'].includes(command.action) || JSON.stringify(command).length>30000)throw new Error('Invalid archive change.');
  const lock=LockService.getScriptLock();
  if(!lock.tryLock(1000))throw new Error('Cannot save: another save is running. Retry this change.');
  try {
    const hash=leadCacheDigest_(command),key=arKey_('operation|'+command.id),audit=arRead_('PORTAL_CONFIG',true);
    const repeated=arManagementReceipt_(audit,key,user,hash);
    if(repeated)return repeated;
    const {table,row}=arManageRecord_(command.leadId,user),lead=row.value;
    if(arRevision_(lead)!==command.revision)throw new Error('Cannot save: archive record changed. Close and reopen it before saving.');
    const previousTime=new Date(lead['Updated At']||0).getTime();
    const patch={'Updated At':new Date(Math.max(Date.now(),Number.isFinite(previousTime)?previousTime+1:0)).toISOString()};
    if(command.action==='update') {
      if(lead['Transfer State']!=='Transferred')throw new Error('Cannot edit: recover this record from Trash before editing.');
      const changes=command.changes||{};
      for(const field of Object.keys(changes)) {
        if(!AR_EDIT_FIELDS_.includes(field)||typeof changes[field]!=='string'||changes[field].length>5000)throw new Error('Invalid archive field: '+field);
        patch[field]=changes[field].trim();
      }
      if(!String(patch['Company Name']===undefined?lead['Company Name']:patch['Company Name']).trim())throw new Error('Company name is required.');
    } else {
      const expected=command.action==='trash'?'Transferred':'Trashed';
      if(lead['Transfer State']!==expected)throw new Error('Cannot save: archive state changed. Refresh the list.');
      patch['Transfer State']=command.action==='trash'?'Trashed':'Transferred';
    }
    const result={leadId:command.leadId,action:command.action,state:patch['Transfer State']||lead['Transfer State']};
    const receipt=arDecorate_({'Sheet Name':'ARCHIVE_OPERATION','Record JSON':JSON.stringify({user:user.id,hash,result,at:new Date().toISOString(),changes:patch})},'operation|'+command.id,'Audit');
    const metadata=Sheets.Spreadsheets.get(arBook_(),{fields:'sheets.properties'});
    const gid=name=>{const s=metadata.sheets.find(s=>s.properties.title===name);if(!s)throw new Error('Archive table missing: '+name);return s.properties.sheetId;};
    const masterId=gid('Master'),auditId=gid('PORTAL_CONFIG');
    // One central batch commits the edit, its idempotency receipt and a revision
    // fence. A delayed old request cannot overwrite a newer change after a timeout.
    const fence='ar_'+leadCacheDigest_([arKey_(command.leadId),command.revision]).replace(/[^a-zA-Z0-9]/g,'');
    const requests=[{addNamedRange:{namedRange:{namedRangeId:fence,name:fence,range:{sheetId:masterId,startRowIndex:0,endRowIndex:1,startColumnIndex:0,endColumnIndex:1}}}}];
    for(const [field,value] of Object.entries(patch)) {
      const columnIndex=table.headers.indexOf(field);if(columnIndex<0)throw new Error('Archive column missing: '+field);
      requests.push({updateCells:{start:{sheetId:masterId,rowIndex:row.row-1,columnIndex},rows:[{values:[{userEnteredValue:{stringValue:String(value)}}]}],fields:'userEnteredValue'}});
    }
    requests.push({appendCells:{sheetId:auditId,rows:[{values:audit.headers.map(h=>({userEnteredValue:{stringValue:arLiteral_(receipt[h])}}))}],fields:'userEnteredValue'}});
    try {Sheets.Spreadsheets.batchUpdate({requests},arBook_());}
    catch(error) {
      const saved=arManagementReceipt_(arRead_('PORTAL_CONFIG',true),key,user,hash);
      if(saved)return saved;
      throw new Error(/already exists/i.test(String(error.message||error))?'Cannot save: archive record changed. Close and reopen it before saving.':'Cannot confirm save yet. Retry the same change; its reference prevents duplicate writes.');
    }
    const saved=arManagementReceipt_(arRead_('PORTAL_CONFIG',true),key,user,hash);
    if(!saved)throw new Error('Cannot confirm save yet. Retry the same change.');
    return saved;
  } finally {lock.releaseLock();}
}
function apiManageArchivedLead(token,command) {
  _currentApiToken_=token||'';
  return apiGuard_('apiManageArchivedLead',()=>respond(arManage_(arManageUser_(),command)));
}
