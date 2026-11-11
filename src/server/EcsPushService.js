// Destination URLs are deployment-controlled; callers can only select a key.
// Provisioned by the existing authenticated FSR integration, never by public form callers.
function ecsConfigureConnections_(request){
  ecsAssert_();
  const values=request.connections;
  if(!values||typeof values!=='object'||Array.isArray(values))throw _ecsQueryError_('INVALID_REQUEST');
  const keys=ecsPortals_().map(p=>p.key);
  const selected=Object.keys(values);
  if(!selected.length||selected.some(k=>!keys.includes(k)||typeof values[k]!=='string'||values[k].length<32||values[k].length>500))throw _ecsQueryError_('INVALID_REQUEST');
  PropertiesService.getScriptProperties().setProperty('ECS_PUSH_SECRETS_JSON',JSON.stringify(Object.fromEntries(selected.map(k=>[k,values[k]]))));
  return {configured:selected};
}
function ecsConnectedPortals_(){const secrets=ecsParse_(PropertiesService.getScriptProperties().getProperty('ECS_PUSH_SECRETS_JSON'));return ecsPortals_().filter(p=>typeof secrets[p.key]==='string'&&secrets[p.key].length>=32);}
function ecsPortals_(){
  return typeof ECS_DESTINATIONS_==='undefined'?[]:ECS_DESTINATIONS_;
}
function ecsDestination_(key){ecsAssert_();const p=ecsPortals_().find(p=>p.key===key);if(!p)throw new Error('Invalid destination portal.');return p;}
function ecsRemote_(key,data){
  const portal=ecsDestination_(key),secrets=ecsParse_(PropertiesService.getScriptProperties().getProperty('ECS_PUSH_SECRETS_JSON'));
  const secret=secrets[key];if(typeof secret!=='string'||secret.length<32)throw new Error('ECS destination connection needs administrator setup.');
  const timestamp=Math.floor(Date.now()/1000),payload=JSON.stringify({...data,portalKey:key});
  const signature=Utilities.computeHmacSha256Signature('ecs-query.v1.'+timestamp+'.'+payload,secret,Utilities.Charset.UTF_8).map(b=>('0'+((b+256)%256).toString(16)).slice(-2)).join('');
  let response=UrlFetchApp.fetch(portal.url+'?webhook=ecs-query&format=json',{method:'post',contentType:'application/json',payload:JSON.stringify({timestamp,payload,signature}),followRedirects:false,muteHttpExceptions:true});
  if([302,303].includes(response.getResponseCode())){const headers=response.getAllHeaders(),url=String(headers.Location||headers.location||'');if(!/^https:\/\/script\.googleusercontent\.com\//.test(url))throw new Error('Invalid portal redirect.');response=UrlFetchApp.fetch(url,{followRedirects:false,muteHttpExceptions:true});}
  if(response.getResponseCode()!==200)throw new Error('Destination did not confirm the request. Retry safely.');
  let result;try{result=JSON.parse(response.getContentText());}catch(_){throw new Error('Invalid portal response.');}
  if(result.success!==true)throw new Error('ECS destination: '+String(result.code||'UNCONFIRMED').replace(/[^A-Z_]/g,'').slice(0,60));
  return result.data;
}
function ecsIdentity_(r){const d=ecsParse_(r.clientDetails);return {queryId:r.id,companyName:r.companyName,phone:d.phone||r.requesterPhone||'',email:r.requesterEmail||''};}
function apiEcsDestinationOptions(token,key){_currentApiToken_=token||'';return apiGuard_('apiEcsDestinationOptions',()=>{ecsUser_(true);return respond(ecsRemote_(key,{action:'options'}));});}
function apiEcsCheckLeads(token,id){_currentApiToken_=token||'';return apiGuard_('apiEcsCheckLeads',()=>{
  const user=ecsUser_(true),r=ecsQuery_(id,user),matches=[],errors=[];
  ecsConnectedPortals_().forEach(p=>{try{const result=ecsRemote_(p.key,{action:'check',...ecsIdentity_(r)});if(!Array.isArray(result.matches))throw new Error('Invalid matches.');result.matches.forEach(m=>matches.push({...m,portalKey:p.key,portalName:p.name}));}catch(e){errors.push({portalKey:p.key,message:e.message});}});
  return respond({matches,errors});
});}
function apiEcsPush(token,command){_currentApiToken_=token||'';return apiGuard_('apiEcsPush',()=>{
  const user=ecsUser_(true),p=command&&command.args&&command.args[0];if(!p||command.action!=='apiEcsPush'||JSON.stringify(command).length>14000)throw new Error('Invalid push request.');ecsId_(command.id);
  const identity=leadCacheIdentity_(user);if(command.portal!==identity.portal||command.user!==user.id||command.scope!==identity.scope)throw new Error('Permission denied.');
  const r=ecsQuery_(p.id,user),portal=ecsDestination_(p.portalKey),d=ecsParse_(r.clientDetails);
  // A committed receipt wins over a stale version on safe network retries.
  const prior=getAllRows(SYNC_RECEIPTS_).find(row=>row['Operation ID']===command.id);
  if(prior)return respond(syncAtomicWrite_(user,{...command,bases:[]},()=>{throw new Error('Invalid receipt.');}));
  if(Number(r.version)!==p.version)return respond({state:'conflict',message:'Query changed. Refresh before pushing.'});
  const leadId=ecsText_(p.leadId,160),assignedTo=ecsText_(p.assignedTo,254),date=ecsText_(p.followupDate,10),remark=ecsText_(p.remark,2000);
  if(r.clientId){
    const linked=ecsClientDirectory_().find(c=>c.id===r.clientId);
    if(!linked||!leadId||linked.sourceKey!==portal.key||String(linked.sourceRecordId)!==leadId)return respond({state:'conflict',message:'This query is already linked. Continue the lead linked to this query.'});
  }
  if((!leadId&&!assignedTo)||(!leadId&&!date)||date&&(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(date))||new Date(date).toISOString().slice(0,10)!==date))throw new Error('Choose a user and valid follow-up date.');
  if(!leadId){
    for(const destination of ecsConnectedPortals_()){
      const check=ecsRemote_(destination.key,{action:'check',...ecsIdentity_(r),excludeQueryLead:true});
      if(!Array.isArray(check.matches))throw new Error('Invalid duplicate check.');
      if(check.total>0)throw new Error('Duplicate lead found. Use Check existing leads and continue that lead.');
    }
  }
  const receipt=ecsRemote_(portal.key,{action:leadId?'continue':'push',...ecsIdentity_(r),leadId,reference:r.reference,contact:d.contact||r.requesterName,city:d.city||'',state:d.state||'',address:d.address||'',subject:r.subject,message:r.message,kind:r.kind,actor:user.email,assignedTo,followupDate:date,remark});
  if(!receipt||receipt.queryId!==r.id||receipt.portalKey!==portal.key||!receipt.leadId||!receipt.followupId||leadId&&receipt.leadId!==leadId)throw new Error('Invalid destination receipt. Retry safely.');
  try{return respond(syncAtomicWrite_(user,{...command,bases:[]},()=>{
    const current=ecsQuery_(r.id,user);if(Number(current.version)!==p.version)throw new Error('SYNC_CONFLICT: Destination saved; query changed. Retry after refreshing to recover its receipt.');
    const clientId='portal:'+portal.key+':'+receipt.leadId,client={id:clientId,sourceKey:portal.key,sourceName:portal.name,sourceRecordId:receipt.leadId,sourceClientId:receipt.leadId,name:receipt.lead?receipt.lead.name:r.companyName,contact:d.contact||'',phone:d.phone||'',address:d.address||'',city:d.city||'',state:d.state||'',isActive:true};
    if(!syncTxUpdate_('ECS_CLIENTS','id',clientId,client))syncTxInsert_('ECS_CLIENTS',client);
    syncTxUpdate_('ECS_QUERIES','id',r.id,{clientId,sourceKey:portal.key,sourceName:portal.name,version:Number(current.version)+1,updatedAt:new Date().toISOString()});
    ecsActivity_(r.id,user,leadId?'EXISTING_LEAD_LINKED':'PUSHED_AS_LEAD',{portalKey:portal.key,portalName:portal.name,leadId:receipt.leadId,followupId:receipt.followupId,reusedFollowup:!!receipt.reusedFollowup,note:remark});return respond(receipt);
  }));}catch(e){if(/SYNC_CONFLICT/.test(e.message))return respond({state:'conflict',message:e.message});throw e;}
});}
