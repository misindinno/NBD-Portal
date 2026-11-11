const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),crypto=require('node:crypto');
const {syncFixture}=require('./helpers/sync-fixture');
function setup(){
 const f=syncFixture(),c=f.c;Object.assign(c.CLIENT_CONFIG,{ECS_ENABLED:true,PORTAL_KEY:'LQ'});
 c._ecsAssignableUsers_=()=>[{id:'u1',email:'u1@example.test',name:'Admin'},{id:'sales',email:'sales@example.test',name:'Sales'}];
 c.CacheService={getScriptCache:()=>({get:()=>null,put(){}})};
 c.PropertiesService={getScriptProperties:()=>({getProperty:()=>null})};
 vm.runInContext(fs.readFileSync('src/server/EcsService.js','utf8'),c);
 vm.runInContext(fs.readFileSync('src/server/EcsPushService.js','utf8'),c);
 for(const [name,headers]of Object.entries(vm.runInContext('ECS_TABLES_',c)))f.add(name,Array.from(headers));
 const r={id:crypto.randomUUID(),reference:'QRY-ORIGINAL',companyName:'Original Company',clientDetails:JSON.stringify({name:'Original Company',city:'Delhi',contact:'Owner'}),kind:'GENERAL',subject:'Original subject',message:'Original message preserved',status:'NEW',assignedTo:'sales@example.test',version:1,createdAt:'2026-10-01T00:00:00Z',updatedAt:'2026-10-01T00:00:00Z'};
 f.add('ECS_QUERIES',Array.from(vm.runInContext('ECS_TABLES_.ECS_QUERIES',c)),[r]);
 return {...f,r,save:p=>c.apiEcsSave('valid',f.command('apiEcsSave',[p]))};
}

test('ECS provisioning accepts only the allowlisted connection set in LQ',()=>{
 const f=setup();f.c.ecsPortals_=()=>[{key:'lq-portal'},{key:'nbd-portal'}];f.c._ecsQueryError_=code=>Error(code);
 let saved;f.c.PropertiesService={getScriptProperties:()=>({setProperty:(key,value)=>{saved={key,value};}})};
 assert.throws(()=>f.c.ecsConfigureConnections_({connections:{'unknown':'x'.repeat(32)}}),/INVALID_REQUEST/);
 assert.equal(saved,undefined);
 f.c.ecsConfigureConnections_({connections:{'lq-portal':'x'.repeat(32),'nbd-portal':'y'.repeat(32)}});
 assert.equal(saved.key,'ECS_PUSH_SECRETS_JSON');
 f.c.CLIENT_CONFIG.PORTAL_KEY='NBD';assert.throws(()=>f.c.ecsConfigureConnections_({connections:{}}),/only in LQ/);
});

test('ECS push cannot replace an existing client link or call a remote destination',()=>{
 const f=setup();f.c.ecsPortals_=()=>[{key:'lq-portal'}];f.c.ecsClientDirectory_=()=>[{id:'linked',sourceKey:'lq-portal',sourceRecordId:'lead-1'}];
 f.tables.get('ECS_QUERIES').data[1][5]='linked';
 f.c.ecsRemote_=()=>{throw Error('Remote must not run');};
 const cmd=f.command('apiEcsPush',[{id:f.r.id,version:1,portalKey:'lq-portal',leadId:'lead-2'}]);
 assert.equal(f.c.apiEcsPush('valid',cmd).data.state,'conflict');
 assert.equal(f.rows('ECS_ACTIVITIES').length,0);
});

test('ECS raw mirror enforces assignment for queries and their history',()=>{
 const f=setup();vm.runInContext(fs.readFileSync('src/server/SheetMirrorService.js','utf8'),f.c);
 const u={id:'sales',email:'sales@example.test',role:'SALES',modules:['ECS']};
 const queries={name:'ECS_QUERIES',exists:true,headers:['id','assignedTo'],rows:[{rowNumber:2,cells:['own','sales@example.test']},{rowNumber:3,cells:['other','other@example.test']}]};
 f.c.sheetMirrorReadTable_=()=>queries;
 const visible=f.c.sheetMirrorScopedRows_(u,{kind:'ecsQueries'},queries);
 assert.equal(visible.length,1);assert.equal(visible[0].cells[0],'own');
 const history={name:'ECS_ACTIVITIES',exists:true,headers:['id','queryId'],rows:[{rowNumber:2,cells:['a','own']},{rowNumber:3,cells:['b','other']}]};
 assert.equal(f.c.sheetMirrorScopedRows_(u,{kind:'ecsActivities'},history).length,1);
 assert.throws(()=>f.c.sheetMirrorScopedRows_(u,{kind:'ecsQueries'},{...queries,headers:['id','id']}),/Invalid sheet schema/);
});

test('ECS destination receipt, local client link and audit survive lost acknowledgements',()=>{
 const f=setup();f.c.ecsPortals_=f.c.ecsConnectedPortals_=()=>[{key:'lq-portal',name:'LQ'}];
 let pushes=0;f.c.ecsRemote_=(key,p)=>p.action==='check'?{matches:[],total:0}:(pushes++,{queryId:f.r.id,portalKey:key,leadId:'lead-created',followupId:'followup-created'});
 const cmd=f.command('apiEcsPush',[{id:f.r.id,version:1,portalKey:'lq-portal',assignedTo:'sales',followupDate:'2026-10-30',remark:'Test'}]);
 f.state.after=true;assert.equal(f.c.apiEcsPush('valid',cmd).data.state,'retry');
 assert.equal(f.c.apiEcsPush('valid',cmd).data.state,'committed');assert.equal(pushes,1);
 assert.equal(f.rows('ECS_ACTIVITIES').length,1);assert.equal(f.rows('ECS_QUERIES')[0].clientId,'portal:lq-portal:lead-created');
});
test('ECS gate rejects public and private endpoints outside LQ',()=>{const f=setup();f.c.CLIENT_CONFIG.PORTAL_KEY='NBD';assert.throws(()=>f.c.ecsAssert_(),/only in LQ/);assert.equal(f.c.apiEcsPublicClients('test').success,false);assert.equal(f.save({operation:'update',items:[]}).success,false);});
test('ECS update and audit commit together, preserving original fields',()=>{const f=setup();const result=f.save({operation:'update',items:[{id:f.r.id,version:1}],status:'IN_PROGRESS',note:'=literal note'});assert.equal(result.success,true,JSON.stringify(result));assert.equal(result.data.state,'committed');assert.equal(f.rows('ECS_QUERIES')[0].version,2);assert.equal(f.rows('ECS_QUERIES')[0].message,f.r.message);assert.equal(JSON.parse(f.rows('ECS_ACTIVITIES')[0].details).note,'=literal note');});
test('ECS lost commit response retries once without duplicate notes',()=>{const f=setup(),cmd=f.command('apiEcsSave',[{operation:'update',items:[{id:f.r.id,version:1}],note:'A note'}]);f.state.after=true;assert.equal(f.c.apiEcsSave('valid',cmd).data.state,'retry');assert.equal(f.c.apiEcsSave('valid',cmd).data.state,'committed');assert.equal(f.rows('ECS_ACTIVITIES').length,1);assert.equal(f.rows('ECS_QUERIES')[0].version,2);});
test('ECS stale bulk updates change no records or history',()=>{const f=setup();const result=f.save({operation:'update',items:[{id:f.r.id,version:2}],status:'CLOSED'});assert.equal(result.data.state,'conflict');assert.equal(f.rows('ECS_ACTIVITIES').length,0);assert.equal(f.rows('ECS_QUERIES')[0].status,'NEW');});
test('ECS sales sees own assignments only and cannot assign without manage',()=>{const f=setup();const u={id:'sales',email:'sales@example.test',role:'SALES',modules:['ECS','ECSEdit']};assert.equal(f.c.ecsVisible_(f.r,u),true);assert.equal(f.c.ecsVisible_({...f.r,assignedTo:'other@example.test'},u),false);assert.throws(()=>f.c.withServerContext_(()=>f.c.syncAtomicWrite_(u,f.command('apiEcsSave',[]),()=>f.c.ecsMutate_(u,{operation:'update',items:[{id:f.r.id,version:1}],assignedTo:'u1@example.test'}))),/Permission denied/);});
test('ECS public validation rejects mixed clients, invalid phones, honeypots and invalid categories',()=>{const f=setup();const p={requestId:crypto.randomUUID(),clientDetails:{name:'Example',contact:'Owner',city:'Delhi'},requesterName:'Customer',kind:'GENERAL',subject:'Question',message:'Please explain this product.'};assert.equal(f.c.ecsPublicPayload_(p).subject,p.subject);for(const extra of [{clientId:'123'},{requesterPhone:'xyz'},{website:'bot'},{kind:'BAD'}])assert.throws(()=>f.c.ecsPublicPayload_({...p,...extra}));});
test('ECS new client keeps original query snapshot and original query ID',()=>{const f=setup();const result=f.save({operation:'link',id:f.r.id,version:1,createClient:true});assert.equal(result.data.state,'committed',JSON.stringify(result));assert.equal(f.rows('ECS_CLIENTS').length,1);assert.equal(f.rows('ECS_QUERIES')[0].id,f.r.id);assert.equal(f.rows('ECS_QUERIES')[0].clientDetails,f.r.clientDetails);assert.equal(f.rows('ECS_ACTIVITIES')[0].action,'CLIENT_CREATED');});
test('ECS public retry is idempotent and returns only a receipt',()=>{const f=setup(),p={requestId:crypto.randomUUID(),clientDetails:{name:'New Company',contact:'Owner',city:'Delhi'},requesterName:'Customer',kind:'GENERAL',subject:'Question',message:'Please explain this product.'};const a=f.c.apiEcsSubmitPublic(p),b=f.c.apiEcsSubmitPublic(p);assert.equal(a.success,true,JSON.stringify(a));assert.deepEqual(a.data,b.data);assert.deepEqual(Object.keys(a.data).sort(),['accepted','reference']);assert.equal(f.rows('ECS_QUERIES').length,2);assert.equal(f.rows('ECS_ACTIVITIES').length,1);assert.equal(f.c.apiEcsSubmitPublic({...p,message:'Different message text'}).success,false);});


test('release includes LQ ECS navigation, public form and IndexedDB integration',()=>{
 const read=p=>fs.readFileSync(p,'utf8');
 assert.match(read('clients/lq-portal/ClientConfig.js'),/ECS_ENABLED:\s*true/);
 for(const name of ['cs-portal','dead-portal','lq-lamination','nbd-client1','nbd-lamination'])assert.doesNotMatch(read('clients/'+name+'/ClientConfig.js'),/ECS_ENABLED:\s*true/);
 assert.match(read('src/Index.html'),/include\('Ecs'\)/);
 assert.match(read('src/AppUI.html'),/navItem\('ecs'/);
 assert.match(read('src/server/Code.js'),/page === 'ecs-form'/);
 for(const path of ['src/Ecs.html','src/EcsPublicForm.html','src/server/EcsService.js','src/server/EcsPushService.js','src/server/EcsDestinations.js'])assert.ok(read(path).length>0,path);
 assert.match(read('src/PortalSync.html'),/apiEcsSave/);
 assert.match(read('src/server/SyncTransaction.js'),/ECS_QUERIES/);
 assert.match(read('src/server/SheetMirrorService.js'),/ECS_QUERIES/);
});
