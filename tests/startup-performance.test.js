const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
test('staff permissions are loaded once for large directories without changing portal overrides', () => {
  let ensures = 0;
  const reads = [];
  const users = Array.from({length: 500}, (_, i) => ({ ID: 'u'+i, 'Email Address': 'u'+i+'@example.test', 'Is Active': true, Permission: 'SALES' }));
  const access = [
    {'Portal Key':'LQ','User ID':'u0', Permission:'ADMIN'},
    {'Portal Key':'NBD','User ID':'u0', Permission:'VIEWER', 'Allowed Modules':'Leads'},
    {'Portal Key':'NBD','Email Address':'U1@EXAMPLE.TEST','Is Active':false}
  ];
  const ctx = vm.createContext({ CLIENT_CONFIG: {PORTAL_KEY:'NBD'}, SHEET_NAMES:{USERS:'users', USER_PORTAL_ACCESS:'access'},
    safeInitHeaders(){ensures++;}, getAllRows(name){reads.push(name); return name === 'users' ? users : access;},
    getStaffUserId: u => u.ID, isActiveUserValue: v => v !== false && v !== 'FALSE'
  });
  vm.runInContext(read('src/server/AuthService.js'),ctx);
  const result = ctx.getUsersWithPortalAccess_();
  assert.equal(result.length,499);
  assert.equal(result[0].Permission,'VIEWER');
  assert.equal(result[0]['Allowed Modules'],'Leads');
  assert.equal(result[1].Permission,'SALES');
  assert.equal(ensures,1);
  assert.deepEqual(reads,['access','users']);
  assert.equal(ctx.getUsersWithPortalAccess_('NBD',true).length,500);
});
test('startup returns identity/config even if optional worklist counts are unavailable', () => {
  const ctx = vm.createContext({
    Logger: {log() {}}, withRequestContext_: (_op,fn)=>fn(), withServerContext_: fn=>fn(),
    readAuthSession_:()=>({email:'user@example.test'}), getCurrentUserByEmail_:()=>({success:true,data:{id:'user',role:'SALES'}}),
    refreshAuthSession_(){}, getAppConfigFast_:()=>({stages:[]}),
    leadCacheIdentity_:()=>({schema:1,portal:'synthetic',user:'user',scope:'synthetic-scope',enabled:true}),
    getNavigationSummary_(){throw Error('must not scan worklists at bootstrap');},
    PropertiesService:{getScriptProperties:()=>({getProperty:()=>null})}, respond:data=>({success:true,data})
  });
  vm.runInContext(read('src/server/Api.js'),ctx);
  const result=ctx.apiBootstrapData('session');
  assert.equal(result.success,true);
  assert.equal(result.data.user.id,'user');
  assert.ok(result.data.config);
  assert.equal(result.data.cacheIdentity.user,'user');
  assert.equal(ctx._bootstrapReadMode_,false);
});

test('web requests use the configured client workbook and keep staff reads separate', () => {
  const opened=[];
  const ctx=vm.createContext({
    CLIENT_CONFIG:{SPREADSHEET_ID:'client',USER_DATABASE_SPREADSHEET_ID:'staff',USER_DATABASE_SHEET_NAME:'Staff List'},
    SHEET_NAMES:{USER_PORTAL_ACCESS:'access',IDX_USERS:'userIndex'},
    SpreadsheetApp:{openById(id){opened.push(id);return {id};},getActiveSpreadsheet(){throw Error('active container must not be used');}}
  });
  vm.runInContext(read('src/server/SheetDB.js'),ctx);
  assert.equal(ctx.withServerContext_(()=>ctx.getSpreadsheet('CONFIG')).id,'client');
  assert.equal(ctx.withServerContext_(()=>ctx.getSpreadsheet('USERS')).id,'staff');
  assert.equal(ctx.withServerContext_(()=>ctx.getSpreadsheet('access')).id,'staff');
  assert.deepEqual(opened,['client','staff']);
});

test('slow startup offers a reload without cancelling the request and clears on recovery', async () => {
  let showNotice, cleared=false, notice=null, resolveStartup;
  const actions=[];
  const ctx=vm.createContext({
    setTimeout(fn,delay){assert.equal(delay,30000);showNotice=fn;return 1;},
    clearTimeout(){cleared=true;},
    document:{
      getElementById:id=>id==='content'?{prepend:element=>{notice=element;}}:notice,
      createElement:()=>({style:{},setAttribute(){},querySelector:()=>({}),remove(){notice=null;}})
    },
    Store:{dispatch:(...args)=>actions.push(args)}, window:{location:{reload(){}}}
  });
  vm.runInContext(read('src/AppAuth.html').replace(/<\/?script>/g,''),ctx);
  ctx._loadAppSession_=()=>new Promise(resolve=>{resolveStartup=resolve;});
  let done=false;
  const pending=ctx._continueAppInit('session').then(()=>{done=true;});
  showNotice();
  assert.match(notice.innerHTML,/Loading is taking longer/);
  await Promise.resolve();
  assert.equal(done,false,'the slow notice does not reject or cancel startup');
  resolveStartup(); await pending;
  assert.equal(cleared,true); assert.equal(notice,null);
  assert.equal(actions.at(-1)[1].value,false);
});
