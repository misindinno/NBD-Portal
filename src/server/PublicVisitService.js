// Public intake is intentionally separate from historical VISITS/FSR records.
const VISIT_INTAKE_SHEET_ = 'VISIT_SUBMISSIONS';
const VISIT_INTAKE_HEADERS_ = ['Visit ID','Request ID','Client ID','Client Name','Visit Date','Remarks','Status','Management Notes','Submitted At','Updated At','Updated By'];
const VISIT_INTAKE_STATUSES_ = ['New','Scheduled','Completed','Cancelled'];

function _visitIntakeSheet_() {
  assertServerContext_();
  safeInitHeaders(VISIT_INTAKE_SHEET_, VISIT_INTAKE_HEADERS_);
  return getSheet(VISIT_INTAKE_SHEET_);
}
function _visitIntakeEnabled_() {
  return PropertiesService.getScriptProperties().getProperty('PUBLIC_VISIT_PAUSED') !== 'true';
}
function _visitPublicClients_() {
  // Public disclosure is limited to the client selector requested by the owner.
  return getAllRows(SHEET_NAMES.LEADS).filter(r => r['Lead ID'] && r['Company Name'] && !_isArchivedLead_(r))
    .map(r => ({id:String(r['Lead ID']),name:String(r['Company Name'])}))
    .sort((a,b) => a.name.localeCompare(b.name));
}
function apiPublicVisitOptions() {
  return apiGuard_('apiPublicVisitOptions', () => respond({enabled:_visitIntakeEnabled_(),clients:_visitIntakeEnabled_() ? _visitPublicClients_() : []}));
}
function _validatePublicVisit_(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) throw new Error('Invalid visit submission.');
  const id=String(p.requestId||'');
  const client=String(p.clientId||'');
  const date=String(p.visitDate||'');
  const remarks=String(p.remarks||'').trim();
  if (!/^[a-zA-Z0-9_-]{20,80}$/.test(id)) throw new Error('Invalid submission reference. Reload the form.');
  if (!client || client.length>100) throw new Error('Choose a client.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date+'T00:00:00Z')) || new Date(date+'T00:00:00Z').toISOString().slice(0,10)!==date) throw new Error('Enter a valid visit date.');
  if (remarks.length>2000) throw new Error('Remarks must be 2,000 characters or less.');
  if (p.website) throw new Error('Unable to accept this submission.');
  return {requestId:id,clientId:client,visitDate:date,remarks};
}
function _visitSafeText_(value) {
  const text=String(value==null?'':value);
  return /^[=+@-]/.test(text) ? "'"+text : text;
}
function apiSubmitPublicVisit(payload) {
  return apiGuard_('apiSubmitPublicVisit', () => {
    const p=_validatePublicVisit_(payload);
    const lock=LockService.getScriptLock();
    if (!lock.tryLock(5000)) return respond(null,'The portal is busy. Please retry with the same form.');
    try {
      if (!_visitIntakeEnabled_()) return respond(null,'Visit submissions are currently paused.');
      const sheet=_visitIntakeSheet_();
      const last=sheet.getLastRow();
      const existing=last>1 ? sheet.getRange(2,2,last-1,1).createTextFinder(p.requestId).matchEntireCell(true).matchCase(true).useRegularExpression(false).findNext() : null;
      // A retry returns only an acknowledgement, never a private visit record.
      if (existing) return respond({accepted:true,reference:p.requestId});
      const cache=CacheService.getScriptCache();
      const key='public-visits:'+Math.floor(Date.now()/60000);
      const count=Number(cache.get(key)||0);
      if (count>=30) return respond(null,'Too many submissions. Please try again shortly.');
      const client=_visitPublicClients_().find(c=>c.id===p.clientId);
      if (!client) return respond(null,'This client is no longer available. Reload the form.');
      cache.put(key,String(count+1),120);
      const time=now();
      if(last+1>sheet.getMaxRows()) sheet.insertRowsAfter(sheet.getMaxRows(),1);
      sheet.getRange(last+1,1,1,VISIT_INTAKE_HEADERS_.length).setValues([[
        generateUUID(),p.requestId,p.clientId,_visitSafeText_(client.name),p.visitDate,_visitSafeText_(p.remarks),'New','',time,time,''
      ]]);
      SpreadsheetApp.flush();
      return respond({accepted:true,reference:p.requestId});
    } finally {lock.releaseLock();}
  });
}
function apiVisitManagement(token, query) {
  _currentApiToken_=token||'';
  return apiGuard_('apiVisitManagement', () => {
    _requireModule('VisitManagement');
    const sheet=_visitIntakeSheet_();
    const rows=sheet.getLastRow()>1 ? sheet.getRange(2,1,sheet.getLastRow()-1,VISIT_INTAKE_HEADERS_.length).getDisplayValues() : [];
    const q=query||{}, search=String(q.search||'').toLowerCase().slice(0,100), status=String(q.status||'');
    const filtered=rows.filter(r=>r[0] && (!status||r[6]===status) && (!search||[r[0],r[3],r[4],r[5]].join(' ').toLowerCase().includes(search))).reverse();
    const page=Math.min(Math.max(1,Math.floor(Number(q.page)||1)),Math.max(1,Math.ceil(filtered.length/50)));
    return respond({rows:filtered.slice((page-1)*50,page*50).map(r=>Object.fromEntries(VISIT_INTAKE_HEADERS_.map((h,i)=>[h,r[i]]))),total:filtered.length,page,
      enabled:_visitIntakeEnabled_(),url:ScriptApp.getService().getUrl().replace(/\/dev$/, '/exec')+'?page=visit-form',statuses:VISIT_INTAKE_STATUSES_});
  });
}
function apiUpdateManagedVisit(token, payload) {
  _currentApiToken_=token||'';
  return apiGuard_('apiUpdateManagedVisit', () => {
    const user=_requireModule('VisitManagement'), p=payload||{};
    if (!VISIT_INTAKE_STATUSES_.includes(p.status) || String(p.notes||'').length>2000) return respond(null,'Invalid status or notes.');
    const lock=LockService.getScriptLock(); lock.waitLock(10000);
    try {
      const sheet=_visitIntakeSheet_(), last=sheet.getLastRow();
      const hit=last>1 && sheet.getRange(2,1,last-1,1).createTextFinder(String(p.id||'')).matchEntireCell(true).matchCase(true).useRegularExpression(false).findNext();
      if(!hit) return respond(null,'Visit not found.');
      const r=hit.getRow(), old=sheet.getRange(r,7,1,5).getDisplayValues()[0];
      if(old[3]!==String(p.updatedAt||'')) return respond(null,'This visit changed. Refresh before saving.');
      sheet.getRange(r,7,1,5).setValues([[p.status,_visitSafeText_(p.notes||''),old[2],now(),user.id||user.email]]);
      return respond({saved:true});
    } finally {lock.releaseLock();}
  });
}
function apiSetPublicVisitEnabled(token, enabled) {
  _currentApiToken_=token||'';
  return apiGuard_('apiSetPublicVisitEnabled', () => {
    _requireModule('VisitManagement');
    if(typeof enabled!=='boolean') return respond(null,'Invalid setting.');
    PropertiesService.getScriptProperties().setProperty('PUBLIC_VISIT_PAUSED',String(!enabled));
    return respond({enabled});
  });
}
