// ECS is an LQ-only module. Sheets owns shared records; the browser mirrors them.
const ECS_TABLES_ = {
  ECS_QUERIES:['id','reference','requestDigest','sourceKey','sourceName','clientId','companyName','clientDetails','requesterName','requesterPhone','requesterEmail','kind','subject','message','status','assignedTo','version','createdAt','updatedAt'],
  ECS_ACTIVITIES:['id','queryId','actor','action','details','createdAt'],
  ECS_CLIENTS:['id','sourceKey','sourceName','sourceRecordId','sourceClientId','name','contact','phone','address','city','state','isActive']
};
const ECS_STATUSES_=['NEW','IN_PROGRESS','WAITING_FOR_CLIENT','RESOLVED','CLOSED','SPAM'];
const ECS_KINDS_=['GENERAL','ORDER','QUOTATION','PRODUCT','SERVICE','COMPLAINT'];
function ecsEnabled_(){return CLIENT_CONFIG.ECS_ENABLED===true && CLIENT_CONFIG.PORTAL_KEY==='LQ';}
function ecsAssert_(){if(!ecsEnabled_())throw new Error('Permission denied. ECS is available only in LQ.');}
function ecsUser_(write,manage){ecsAssert_();const u=_requireModule('ECS');if(write&&(u.role==='VIEWER'||u.role!=='ADMIN'&&!userHasModule(u,manage?'ECSManage':'ECSEdit')))throw new Error('Permission denied. ECS access is required.');return u;}
function ecsRows_(name){return syncTxHandles_(name)?syncTxRows_(name):getAllRows(name);}
function ecsParse_(value){if(value&&typeof value==='object')return value;try{return JSON.parse(value||'{}');}catch(_){return {};}}
function ecsText_(v,max,min){if(v!=null&&typeof v!=='string')throw new Error('Invalid ECS field.');const s=String(v||'').trim();if(s.length>(max||200)||s.length<(min||0)||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(s))throw new Error('Invalid or missing ECS field.');return s;}
function ecsId_(id){if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id||''))throw new Error('Invalid ECS request reference.');return id;}
function ecsDirectory_(){return _ecsAssignableUsers_();}
function ecsVisible_(row,user){
  if(user.role==='ADMIN')return true;
  const assignee=String(row.assignedTo||'').toLowerCase();
  if(assignee===String(user.email||'').toLowerCase()||assignee===String(user.id))return true;
  if(!_hasGlobalRead(user))return false;
  const staff=ecsDirectory_().find(u=>u.email===assignee||u.id===assignee);
  return !!staff&&_canReadAssignedRow({'Assigned To':staff.id},user);
}
function ecsQuery_(id,user){const r=ecsRows_('ECS_QUERIES').find(r=>String(r.id)===String(id));if(!r||!ecsVisible_(r,user))throw new Error('Permission denied. Query unavailable.');return r;}
function ecsClientDirectory_(){
  const imported=ecsRows_('ECS_CLIENTS').filter(r=>r.isActive!==false&&String(r.isActive).toLowerCase()!=='false');
  const local=getAllRows(SHEET_NAMES.LEADS).filter(r=>r['Lead ID']&&!_isArchivedLead_(r)).map(r=>({id:'lq:'+r['Lead ID'],sourceKey:'lq-portal',sourceName:'LQ Portal',sourceRecordId:r['Lead ID'],sourceClientId:r['Lead ID'],name:r['Company Name'],contact:r['Contact Person'],phone:r.Phone,address:r.Address,city:r.City,state:r.State,isActive:true,assignedId:r['Assigned To']}));
  // Keep imported IDs stable: existing queries reference these IDs, not the local alias.
  return [...imported.map(r=>({...r,assignedId:local.find(l=>l.sourceKey===r.sourceKey&&l.sourceRecordId===r.sourceRecordId)?.assignedId})),...local.filter(l=>!imported.some(r=>l.sourceKey===r.sourceKey&&l.sourceRecordId===r.sourceRecordId))];
}
function ecsClientVisible_(client,user){if(user.role==='ADMIN')return true;if(client.sourceKey==='lq-portal'&&client.assignedId)return _canReadAssignedRow({'Assigned To':client.assignedId},user);return ecsRows_('ECS_QUERIES').some(q=>q.clientId===client.id&&ecsVisible_(q,user));}
function ecsActivity_(queryId,user,action,details){syncTxInsert_('ECS_ACTIVITIES',{id:generateUUID(),queryId,actor:user.email||'Public form',action,details:JSON.stringify(details),createdAt:new Date().toISOString()});}
function ecsInitialize_(){ecsAssert_();Object.keys(ECS_TABLES_).forEach(n=>safeInitHeaders(n,ECS_TABLES_[n]));safeInitHeaders(SYNC_RECEIPTS_,SYNC_RECEIPT_HEADERS_);return {ready:true};}
function apiEcsInitialize(token){_currentApiToken_=token||'';return apiGuard_('apiEcsInitialize',()=>{const u=ecsUser_(true,true);if(u.role!=='ADMIN')throw new Error('Permission denied.');return respond(ecsInitialize_());});}
function apiEcsOptions(token){_currentApiToken_=token||'';return apiGuard_('apiEcsOptions',()=>{const u=ecsUser_();return respond({statuses:ECS_STATUSES_,kinds:ECS_KINDS_,canEdit:u.role!=='VIEWER'&&(u.role==='ADMIN'||userHasModule(u,'ECSEdit')),canManage:u.role!=='VIEWER'&&(u.role==='ADMIN'||userHasModule(u,'ECSManage')),assignees:ecsDirectory_().filter(a=>u.role==='ADMIN'||_canReadAssignedRow({'Assigned To':a.id},u)),url:ScriptApp.getService().getUrl().replace(/\/dev$/,'/exec')+'?page=ecs-form',enabled:PropertiesService.getScriptProperties().getProperty('ECS_PUBLIC_PAUSED')!=='true',portals:ecsConnectedPortals_().map(p=>({key:p.key,name:p.name}))});});}
function apiEcsClients(token,search){_currentApiToken_=token||'';return apiGuard_('apiEcsClients',()=>{const u=ecsUser_(),s=ecsText_(search,100,2).toLowerCase();return respond(ecsClientDirectory_().filter(c=>ecsClientVisible_(c,u)&&[c.name,c.phone,c.city].join(' ').toLowerCase().includes(s)).slice(0,50));});}
function apiEcsSetPublicEnabled(token,enabled){_currentApiToken_=token||'';return apiGuard_('apiEcsSetPublicEnabled',()=>{ecsUser_(true,true);if(typeof enabled!=='boolean')throw new Error('Invalid setting.');PropertiesService.getScriptProperties().setProperty('ECS_PUBLIC_PAUSED',String(!enabled));return respond({enabled});});}
function apiEcsPublicClients(search){return apiGuard_('apiEcsPublicClients',()=>{ecsAssert_();if(PropertiesService.getScriptProperties().getProperty('ECS_PUBLIC_PAUSED')==='true')return respond([]);const s=ecsText_(search,100,3).toLowerCase();return respond(ecsClientDirectory_().filter(c=>[c.name,c.city].join(' ').toLowerCase().includes(s)).slice(0,20).map(c=>({id:c.id,name:c.name,city:c.city,state:c.state,sourceName:c.sourceName,maskedPhone:'••••••'+String(c.phone||'').replace(/\D/g,'').slice(-4)})));});}
function ecsPublicPayload_(input){
  if(!input||typeof input!=='object'||Array.isArray(input)||JSON.stringify(input).length>14000||input.website)throw new Error('Invalid ECS submission.');
  const p={requestId:ecsId_(input.requestId),clientId:ecsText_(input.clientId,160),requesterName:ecsText_(input.requesterName,200,2),requesterPhone:ecsText_(input.requesterPhone,40),requesterEmail:ecsText_(input.requesterEmail,254),kind:ecsText_(input.kind,30),subject:ecsText_(input.subject,200,3),message:ecsText_(input.message,5000,10)};
  if(!ECS_KINDS_.includes(p.kind)||p.requesterEmail&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.requesterEmail))throw new Error('Invalid query type or email.');
  const phone=v=>{if(v&&(!/^[+\d\s().-]+$/.test(v)||v.replace(/\D/g,'').length<7||v.replace(/\D/g,'').length>15))throw new Error('Invalid phone number.');};phone(p.requesterPhone);
  if(Boolean(p.clientId)===Boolean(input.clientDetails))throw new Error('Choose a client or enter new company details.');
  if(input.clientDetails){const d=input.clientDetails;p.clientDetails={name:ecsText_(d.name,300,2),contact:ecsText_(d.contact,200,2),phone:ecsText_(d.phone,40),address:ecsText_(d.address,800),city:ecsText_(d.city,120,2),state:ecsText_(d.state,120)};phone(p.clientDetails.phone);}
  return p;
}
function apiEcsSubmitPublic(input){return apiGuard_('apiEcsSubmitPublic',()=>{
  ecsAssert_();if(PropertiesService.getScriptProperties().getProperty('ECS_PUBLIC_PAUSED')==='true')throw new Error('ECS submissions are paused.');
  const p=ecsPublicPayload_(input),user={id:'ecs-public',email:'Public form',role:'PUBLIC'};
  const result=syncAtomicWrite_(user,{id:p.requestId,action:'ecsPublicSubmit',args:[p],bases:[]},()=>{
    Object.keys(ECS_TABLES_).forEach(n=>syncTxInit_(n,ECS_TABLES_[n]));
    const cache=CacheService.getScriptCache(),key='ecs-public:'+Math.floor(Date.now()/60000),count=Number(cache.get(key)||0);if(count>=30)throw new Error('Too many submissions. Please retry shortly.');
    const client=p.clientId?ecsClientDirectory_().find(c=>c.id===p.clientId):null;if(p.clientId&&!client)throw new Error('Client unavailable. Search again.');
    cache.put(key,String(count+1),120);
    const d=client?{name:client.name,contact:client.contact||'',phone:client.phone||'',address:client.address||'',city:client.city||'',state:client.state||''}:p.clientDetails;
    const assigned=client&&ecsDirectory_().find(u=>u.id===client.assignedId),time=new Date().toISOString(),reference='QRY-'+p.requestId.replace(/-/g,'').toUpperCase();
    syncTxInsert_('ECS_QUERIES',{id:p.requestId,reference,requestDigest:leadCacheDigest_(p),sourceKey:client?client.sourceKey:'lq-portal',sourceName:client?client.sourceName:'LQ Portal',clientId:p.clientId,companyName:d.name,clientDetails:JSON.stringify(d),requesterName:p.requesterName,requesterPhone:p.requesterPhone,requesterEmail:p.requesterEmail,kind:p.kind,subject:p.subject,message:p.message,status:'NEW',assignedTo:assigned?assigned.email:'',version:1,createdAt:time,updatedAt:time});
    ecsActivity_(p.requestId,user,'CREATED',{status:'NEW',newClient:!client});return respond({accepted:true,reference});
  });
  // Public acknowledgements never expose internal query details or receipts.
  if(result.state!=='committed')throw new Error('Submission not confirmed. Retry with the same details.');return respond(result.result);
});}
function ecsMutate_(user,p){
  Object.keys(ECS_TABLES_).forEach(n=>syncTxInit_(n,ECS_TABLES_[n]));
  if(p.operation==='update'){
    if(!Array.isArray(p.items)||!p.items.length||p.items.length>50||new Set(p.items.map(i=>i.id)).size!==p.items.length)throw new Error('Invalid ECS selection.');
    if(p.status!==undefined&&!ECS_STATUSES_.includes(p.status))throw new Error('Invalid query status.');
    const note=ecsText_(p.note,2000);if(p.status===undefined&&p.assignedTo===undefined&&!note)throw new Error('Choose an update.');
    if(p.assignedTo!==undefined){if(user.role!=='ADMIN'&&!userHasModule(user,'ECSManage'))throw new Error('Permission denied. Assignment requires manage access.');const selected=ecsText_(p.assignedTo,254);if(selected&&!ecsDirectory_().some(u=>u.email===selected&&(user.role==='ADMIN'||_canReadAssignedRow({'Assigned To':u.id},user))))throw new Error('Invalid assignee.');}
    const rows=p.items.map(i=>{const r=ecsQuery_(i.id,user);if(Number(r.version)!==i.version)throw new Error('SYNC_CONFLICT: Query changed. Refresh before saving.');return r;});
    rows.forEach(r=>{const patch={version:Number(r.version)+1,updatedAt:new Date().toISOString()};if(p.status!==undefined)patch.status=p.status;if(p.assignedTo!==undefined)patch.assignedTo=p.assignedTo;syncTxUpdate_('ECS_QUERIES','id',r.id,patch);ecsActivity_(r.id,user,'UPDATED',{fromStatus:r.status,toStatus:patch.status||r.status,fromAssignee:r.assignedTo,toAssignee:p.assignedTo===undefined?r.assignedTo:p.assignedTo,note});});return {updated:rows.length};
  }
  if(p.operation==='link'){
    const r=ecsQuery_(p.id,user);if(Number(r.version)!==p.version||r.clientId)throw new Error('SYNC_CONFLICT: Query changed or already linked.');
    let client;
    if(p.createClient===true){if(!userHasModule(user,'ECSManage')&&user.role!=='ADMIN')throw new Error('Permission denied.');const d=ecsParse_(r.clientDetails);client={id:'ecs:'+r.id,sourceKey:'lq-portal',sourceName:'LQ Portal',sourceRecordId:'QUERY-'+r.id,sourceClientId:'QUERY-'+r.id,name:r.companyName,contact:d.contact||'',phone:d.phone||'',address:d.address||'',city:d.city||'',state:d.state||'',isActive:true};syncTxInsert_('ECS_CLIENTS',client);}
    else{client=ecsClientDirectory_().find(c=>c.id===p.clientId&&ecsClientVisible_(c,user));if(!client)throw new Error('Invalid client.');}
    syncTxUpdate_('ECS_QUERIES','id',r.id,{clientId:client.id,companyName:client.name,sourceKey:client.sourceKey,sourceName:client.sourceName,version:Number(r.version)+1,updatedAt:new Date().toISOString()});ecsActivity_(r.id,user,p.createClient?'CLIENT_CREATED':'CLIENT_LINKED',{clientId:client.id,companyName:client.name});return {id:r.id};
  }
  throw new Error('Invalid ECS operation.');
}
function apiEcsSave(token,command){_currentApiToken_=token||'';return apiGuard_('apiEcsSave',()=>{
  const user=ecsUser_(true),p=command&&command.args&&command.args[0];
  if(!command||command.action!=='apiEcsSave'||!p||JSON.stringify(command).length>30000)throw new Error('Invalid ECS command.');ecsId_(command.id);
  const identity=leadCacheIdentity_(user);if(command.portal!==identity.portal||command.user!==user.id||command.scope!==identity.scope)throw new Error('Permission denied. Account or permissions changed.');
  try{return respond(syncAtomicWrite_(user,{...command,bases:[]},()=>respond(ecsMutate_(user,p))));}catch(e){if(/SYNC_CONFLICT/.test(e.message))return respond({state:'conflict',message:e.message});throw e;}
});}
