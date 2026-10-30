const vm = require('node:vm'), crypto = require('node:crypto'), assert = require('node:assert/strict');
const { read } = require('./lead-cache-fixture');
function syncFixture() {
  const tables = new Map(), named = new Set(), requests = [], apiReads = [];
  let nextSheet = 1, held = false;
  const state = { user: { id: 'u1', email: 'u1@example.test', role: 'ADMIN', modules: ['Leads','Followups','Archive','BulkEntry'] },
    before: false, after: false, enabled: true, permission: true, pending: null };
  function add(name, headers, rows = []) { tables.set(name, { id: nextSheet++, data: [headers, ...rows.map(row => headers.map(h => row[h] ?? ''))] }); }
  function sheet(name) {
    if (!tables.has(name)) return null;
    return { getSheetId: () => tables.get(name).id, getName: () => name,
      getLastRow: () => tables.get(name).data.length, getLastColumn: () => tables.get(name).data[0].length,
      getMaxRows: () => 10000, getMaxColumns: () => 100,
      getDataRange: () => ({ getValues: () => structuredClone(tables.get(name).data) }),
      getRange(row, col, count = 1, width = 1) { return {
        getValues: () => Array.from({ length: count }, (_, i) => Array.from({ length: width }, (_, j) => tables.get(name).data[row-1+i]?.[col-1+j] ?? '')),
        setValues() { throw Error('Unexpected non-atomic domain write'); }
      }; }
    };
  }
  const book = { getId: () => 'book', getSheetByName: sheet, getSheets: () => [...tables.keys()].map(sheet) };
  function apply(batch) {
    const cloned = structuredClone(tables), names = new Set(named);
    for (const request of batch.requests) {
      if (request.addSheet) { const p=request.addSheet.properties; cloned.set(p.title, { id:p.sheetId, data:[] }); continue; }
      if (request.addNamedRange) {
        const name = request.addNamedRange.namedRange.namedRangeId;
        assert.ok(name, 'caller-supplied namedRangeId fences the atomic revision');
        if (names.has(name)) throw Error('Named range already exists'); names.add(name); continue;
      }
      if (request.appendDimension) continue;
      if (request.updateCells?.fields === 'userEnteredFormat.numberFormat') continue;
      const op = request.updateCells || request.appendCells || request.deleteDimension;
      const id = op.sheetId || op.start?.sheetId || op.range?.sheetId;
      const table = [...cloned.values()].find(t=>t.id===id); assert.ok(table, 'known sheet');
      if (request.deleteDimension) { table.data.splice(op.range.startIndex,op.range.endIndex-op.range.startIndex); continue; }
      const values = op.rows.map(row=>row.values.map(cell=>{
        assert.equal(cell.userEnteredValue?.formulaValue,undefined);
        return cell.userEnteredValue?.stringValue ?? cell.userEnteredValue?.numberValue ?? cell.userEnteredValue?.boolValue ?? '';
      }));
      if (request.appendCells) table.data.push(...values);
      else values.forEach((row,i)=> { const target = op.start.rowIndex+i; table.data[target] ||= []; row.forEach((v,j)=>table.data[target][op.start.columnIndex+j]=v); });
    }
    tables.clear(); cloned.forEach((v,k)=>tables.set(k,v)); named.clear(); names.forEach(v=>named.add(v));
  }
  const c = vm.createContext({ console, Date, Math, Set, Map,
    CLIENT_CONFIG:{ SPREADSHEET_ID:'book',USER_DATABASE_SPREADSHEET_ID:'staff',USER_DATABASE_SHEET_NAME:'Staff List' },
    _a1Sheet_:name=>"'"+String(name).replace(/'/g,"''")+"'",
    SpreadsheetApp:{ openById:()=>book },
    ScriptApp:{getScriptId:()=> 'portal'},
    Utilities:{getUuid:()=>crypto.randomUUID(),DigestAlgorithm:{SHA_256:'sha256'},Charset:{UTF_8:'utf8'},computeDigest:(_,v)=> [...crypto.createHash('sha256').update(v).digest()]},
    PropertiesService:{getScriptProperties:()=>({getProperty:()=>state.enabled?'true':null,setProperty(){}})},
    LockService:{getScriptLock:()=>({tryLock(){if(held)return false;held=true;return true;},waitLock(){assert.equal(held,false);held=true;},releaseLock(){assert.equal(held,true);held=false;}})},
    Sheets:{Spreadsheets:{Values:{batchGet(id,options){
      assert.equal(id,'book'); apiReads.push(options.ranges.slice());
      if(state.beforeRead) state.beforeRead(options,apiReads.length);
      return {valueRanges:options.ranges.map(range=>{
        const name=range.replace(/^'|'$/g,'').replace(/''/g,"'");
        assert.ok(tables.has(name),'known API table: '+name);
        return {values:structuredClone(tables.get(name).data)};
      })};
    }},batchUpdate(batch,id){assert.equal(id,'book'); assert.equal(held,true); requests.push(batch);
      if(state.before){state.before=false;throw Error('Network failed before commit');}
      if(state.delay){state.delay=false;state.pending=batch;throw Error('Network timeout while still running');}
      apply(batch); if(state.after){state.after=false;throw Error('Network failed after commit');} return {};
    }}},
    Logger:{log(){}}, readAllRowsWithFallback_:name=>c._legacyGetAllRows_(name),
    _invalidateReadCache_(){},
    parseSheetCell_:(_,key,value)=>value ?? '',
    getPortalSettings_:()=>({}),getStaffUserId:row=>row.ID,
    userHasModule:(u,m)=>u.modules.includes(m),
    withRequestContext_:(_,fn)=>fn(), logServerError_(){}, safeClientErrorMessage_:e=>e.message || String(e),
    errorCodeFrom_:e=>/permission/i.test(e.message)?'FORBIDDEN':/required|invalid|must/i.test(e.message)?'VALIDATION_ERROR':'INTERNAL_ERROR',
    withTrustedWriteUser_:(email,fn)=>{c.TRUSTED_WRITE_EMAIL=email;try{return fn();}finally{c.TRUSTED_WRITE_EMAIL='';}},
    requireRole:()=>state.user,requireRoleForEmail_:()=>state.user, requireBulkEntryWriter_:()=>state.user,
    getCurrentUserByEmail_:()=>({success:true,data:state.user}), applyCalculatedFields:(_,rows)=>rows,
    _fsrWebhookConfig_:()=>({}), getConfigByType:()=>['Call'], _leadStageIsFinal_:s=>!!s?.['Is Final Stage'],
    _leadStatusForStage:()=>'', _leadOutcomeForStage_:()=>'', leadArchiveState_:row=>row['Is Archived']===true,
    leadLifecycleStatus_:()=> 'Open', _isLeadInFinalStage_:()=>false,
    getActiveStages:()=>c.getAllRows('PIPELINE_STAGES'),getAllStages:()=>c.getAllRows('PIPELINE_STAGES'),
    sanitizeSheetRowValues_:rows=>rows, _normalizeLeadPriority_:v=>v, safeBooleanValue_:v=>v===true || v==='TRUE',
    canEditConfigPermission:()=>true, _callPhone_:v=>String(v||'').replace(/\D/g,''),
  });
  ['Utils','SheetDB','IndexService','CustomFieldValueService','LeadService','FollowupService','ArchiveService','CallLogService','Api','LeadCacheService','SyncTransaction','SyncService','SyncDeltaService','FsrClientWebhook'].forEach(name=>vm.runInContext(read('src/server/'+name+'.js'),c));
  const readService=read('src/server/SheetReadApiService.js');
  vm.runInContext(readService.slice(readService.indexOf('const _DATE_COLUMN_EXCEPTIONS_'),readService.indexOf('function _sheetsApiCellValue_')),c);
  vm.runInContext(read('src/BulkService.js'),c);
  // Exercise production schema checks: an identity stub hid duplicate-header failures.
  const schemaContext = vm.createContext({
    SHEET_NAMES: vm.runInContext('SHEET_NAMES', c), normalizeSheetName: c.normalizeSheetName
  });
  vm.runInContext(read('src/server/ArchitectureCore.js'), schemaContext);
  c.validateSheetHeaders_ = schemaContext.validateSheetHeaders_;
  c.now=()=> '2026-10-24 12:00:00'; c.today=()=> '2026-10-24'; c.formatDate=v=>String(v||'').slice(0,10);
  c._validateNextPlannedDateLimit_=()=>({ok:true}); c._fsrWebhookConfig_=()=>({});
  c._apiUser=()=>{if(!state.permission)throw Error('Permission denied');return state.user;};
  c._assertLeadAssignedUserAllowed_=()=>{}; c._applyLeadStatusFromStage=p=>{p['Lead Status']='Open';};
  c._portalDepartmentScopeSet_=()=>null;
  c._bulkAssignableUsers_=()=>[{id:'u1',name:'Synthetic user'}];
  const leadHeaders=Array.from(vm.runInContext('LEAD_MASTER_FIELDS',c));
  const fuHeaders=Array.from(vm.runInContext('FOLLOWUP_MASTER_FIELDS',c));
  const lead={'Lead ID':'L1','Company Name':'Synthetic Client',Phone:'9000000000','Assigned To':'u1','Stage ID':'S1','Updated At':'2026-10-23 12:00:00','Lead Status':'Open'};
  const fu={'Follow-up ID':'F1','Lead ID':'L1','Stage ID':'S1',Status:'Open','Planned Date':'2026-10-24','Next Follow-up Date':'2026-10-24','Updated At':'2026-10-23 12:00:00'};
  add('LEAD_MASTER',leadHeaders,[lead]); add('FOLLOWUPS',fuHeaders,[fu]);
  add('PIPELINE_STAGES',['Stage ID','Stage Name','Stage Order','Is Active','Is Final Stage'],[{'Stage ID':'S1','Stage Name':'New','Stage Order':1,'Is Active':true}]);
  add('FIELD_CONFIG',['Field ID','Sheet Name','Column Key','Is Visible']);
  add('CONFIG',['Config ID','Config Type','Value','Status']);
  add('Bulk_Config',['Field Name','Required','Data Type','Target Column','Validation Rule','Allowed Values'],[
    {'Field Name':'Company Name',Required:'Yes','Data Type':'Text','Target Column':'Company Name','Validation Rule':'notBlank'},
    {'Field Name':'Phone',Required:'Yes','Data Type':'Text','Target Column':'Phone','Validation Rule':'phone'},
    {'Field Name':'Lead ID','Data Type':'Text','Target Column':'Lead ID'},
    {'Field Name':'Assigned To','Data Type':'Text','Target Column':'Assigned To'}
  ]);
  add('_SYNC_OPERATIONS',Array.from(vm.runInContext('SYNC_RECEIPT_HEADERS_',c)));
  const rows=name=>{const data=tables.get(name)?.data||[];return data.slice(1).map(row=>Object.fromEntries(data[0].map((h,i)=>[h,row[i]??''])));};
  const base=(type,id)=>c.withServerContext_(()=>({type,id,values:c.syncBaseRow_(type,id)}));
  const command=(action,args,bases=[])=>({id:crypto.randomUUID(),portal:'portal',user:'u1',scope:c.leadCacheIdentity_(state.user).scope,action,args:structuredClone(args),bases:structuredClone(bases)});
  const call=cmd=>{vm.runInContext('_cfvSheetsEnsured_=false; _archiveSchemaEnsured_=false;',c);return JSON.parse(JSON.stringify(c.apiSyncPush('valid',structuredClone(cmd))));};
  return {c,state,tables,named,requests,apiReads,add,rows,base,command,call,apply};
}
module.exports={syncFixture};
