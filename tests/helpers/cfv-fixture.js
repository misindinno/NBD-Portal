'use strict';
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), crypto = require('node:crypto'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const modules = ['ClientFactoryVisits','ClientFactoryVisitsCreate','ClientFactoryVisitsManage'];
const staff = (id, department='Sales') => ({ ID:id, Name:'Test '+id, Department:department, 'Email Address':id+'@example.test', 'Is Active':true, Permission:'SALES', 'Allowed Modules':modules.join(',') });
function fixture(options={}) {
  const tables = new Map(), named = new Set(), writes=[], users=[staff('host1'),staff('host2'),staff('outside','Other')];
  let sequence=0, locked=false;
  const state={ user:options.user || { id:'host1',email:'host1@example.test',role:'ADMIN',modules:[] }, failBefore:false,failAfter:false };
  const lead={ 'Lead ID':'001','Company Name':'Synthetic Client','Assigned To':'host1','Lead Status':'Open' };
  const getSheet = name => tables.has(name) ? { getSheetId:()=> [...tables.keys()].indexOf(name)+1,getDataRange:()=>({getValues:()=>tables.get(name).map(row=>row.slice())}) } : null;
  const book={getId:()=> 'synthetic-workbook',getSheetByName:getSheet};
  const c=vm.createContext({ console, Date, SHEET_NAMES:{USERS:'STAFF',USER_PORTAL_ACCESS:'ACCESS',LEADS:'LEADS'}, CLIENT_CONFIG:{PORTAL_KEY:'NBD'},
    ScriptApp:{getScriptId:()=> 'synthetic-portal'},
    Utilities:{getUuid:()=> 'uuid-'+(++sequence), DigestAlgorithm:{SHA_256:'sha256'}, computeDigest:(_,value)=> [...crypto.createHash('sha256').update(value).digest()], formatDate(date,zone,pattern){assert.equal(zone,'Asia/Kolkata');const iso=new Date(date.getTime()+330*60000).toISOString();return pattern==='yyyy-MM-dd'?iso.slice(0,10):iso.slice(0,16);}},
    generateUUID:()=> 'visit-'+(++sequence),
    LockService:{getScriptLock:()=>({waitLock(){assert.equal(locked,false);locked=true;},releaseLock(){locked=false;}})},
    withServerContext_:fn=>fn(),assertServerContext_(){},getSpreadsheet:()=>book,
    getAllRows(name){if(name==='STAFF')return users.map(r=>({...r}));if(name==='LEADS')return [{...lead}];throw Error('Unexpected existing-sheet access: '+name);},
    getPortalSettings_:()=>({visibleDepartments:['Sales']}),
    _userMatchesDepartmentSettings_:(row,settings)=>settings.visibleDepartments.includes(row.Department),
    safeInitHeaders(name,headers){assert.ok(['CLIENT_FACTORY_VISITS','CLIENT_FACTORY_VISIT_EVENTS'].includes(name));writes.push({init:name});if(!tables.has(name))tables.set(name,[headers.slice()]);else {const h=tables.get(name)[0];headers.forEach(key=>{if(!h.includes(key))h.push(key);});}},
    Sheets:{Spreadsheets:{batchUpdate(batch,id){
      assert.equal(id,'synthetic-workbook');assert.equal(locked,true);assert.equal(batch.requests.length,3);
      if(state.failBefore){state.failBefore=false;throw Error('Temporary network failure');}
      const staged=new Map([...tables].map(([key,value])=>[key,value.map(row=>row.slice())]));
      const ranges = new Set(named);
      for(const request of batch.requests){
        if(request.addNamedRange){const id=request.addNamedRange.namedRange.namedRangeId;assert.ok(id);if(ranges.has(id))throw Error('Range ID already exists');ranges.add(id);continue;}
        const op=request.appendCells||request.updateCells;const name=[...tables.keys()][(op.sheetId || op.start.sheetId)-1];assert.ok(['CLIENT_FACTORY_VISITS','CLIENT_FACTORY_VISIT_EVENTS'].includes(name));
        assert.equal(op.fields,'userEnteredValue');const values=op.rows[0].values.map(cell=>{assert.equal(typeof cell.userEnteredValue.stringValue,'string');return cell.userEnteredValue.stringValue;});
        if(request.appendCells)staged.get(name).push(values);else staged.get(name)[op.start.rowIndex]=values;}
      staged.forEach((value,key)=>tables.set(key,value));ranges.forEach(id=>named.add(id));writes.push({batch:JSON.parse(JSON.stringify(batch))});
      if(state.failAfter){state.failAfter=false;throw Error('Connection lost after commit');}
      return {};
    }}},respond:(data,error,code)=>({success:!error,data,error,code}),safeClientErrorMessage_:error=>error.message
  });
  for(const file of ['ArchitectureCore','AuthService','Api','ClientFactoryVisitService','ClientFactoryVisitApi'])vm.runInContext(fs.readFileSync(path.join(root,'src/server/'+file+'.js'),'utf8'),c);
  c.logServerError_=()=>{};
  c.TEST_STATE=state;
  vm.runInContext(`_apiUser=function(){if(_currentApiToken_!=='valid')throw Error('SESSION_EXPIRED');return TEST_STATE.user;};`,c);
  const call=(name,payload)=>JSON.parse(JSON.stringify(c[name]('valid',payload)));
  const initialize=()=>call('apiClientFactoryVisitInitialize');
  const records=()=>{
    const values=tables.get('CLIENT_FACTORY_VISITS')||[];
    return values.slice(1).map(row=>Object.fromEntries(values[0].map((h,i)=>[h,row[i]])));
  };
  if(options.initialized!==false){assert.equal(initialize().success,true);writes.length=0;}
  const payload=(extra={})=>({requestId:crypto.randomUUID().replace(/-/g,''),Company:'Synthetic Visitor Co','Visitor Name':'Test Visitor',Phone:'+91 90000 00000',Email:'visitor@example.test','Visitor Count':2,Destination:'Factory',Site:'Synthetic test site','Host ID':'host1','Planned Start':'2026-01-01T10:00','Planned End':'2026-01-01T11:00',Purpose:'Product demonstration',Requirements:'Sample review',Status:'Scheduled','Lead ID':'','Lead Key':'',...extra});
  return {c,state,tables,writes,users,lead,call,initialize,records,payload};
}
module.exports={fixture,modules,root};
