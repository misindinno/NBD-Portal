const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('src/server/NbdPushService.js','utf8');
function setup(extra={}) {
  const c = vm.createContext({CLIENT_CONFIG:{APP_TITLE:'LQ Portal',NBD_TARGET_SPREADSHEET_ID:'nbd',ARCHIVE_SPREADSHEET_ID:'archive',DISQUALIFIED_SPREADSHEET_ID:'dq'},SHEET_NAMES:{LEADS:'LEAD_MASTER'},assertServerContext_(){}, ...extra});
  vm.runInContext(source,c); return c;
}
test('matches live active, archive, disqualified, alternate phones and source IDs',()=>{
  const c=setup(), lead={'Lead ID':'lq','NBD Lead ID':'old',Phone:'+91 9876543210',Email:'NA','Company Name':'Test Company'};
  const matches=c._nbdMatchRows_(lead,[
    {location:'Archive',row:{'Lead ID':'a','Alternate No':'9876543210'}},
    {location:'Disqualified',row:{'Lead ID':'d','Source Lead ID':'lq'}},
    {location:'Active',row:{'Lead ID':'old'}},
    {location:'Active',row:{'Lead ID':'na',Email:'NA'}},
    {location:'Active',row:{'Lead ID':'name','Company Name':' test   company '}}
  ]);
  assert.equal(matches.length,4);
  assert.equal(c._nbdMatchRows_(lead,[]).length,0,'stale saved ID is not proof of existence');
});
test('fresh sheet reads ignore stale indexes; unknown origins block and other portal rows do not',()=>{
  const data={nbd:[['Lead ID','Phone'],['new','1234567890']],archive:[['Lead ID','Origin Workbook'],['a','nbd'],['other','lq']],dq:[['Lead ID','Origin Workbook'],['legacy','']]};
  const c=setup({SpreadsheetApp:{openById:id=>({getSheetByName:()=>({getDataRange:()=>({getValues:()=>data[id]})})})}});
  assert.equal(c._nbdVerificationRows_('nbd').length,3);
  assert.match(c._nbdVerificationRows_('nbd')[2].location,/unassigned origin/);
  data.archive=[['Broken']]; assert.throws(()=>c._nbdVerificationRows_('nbd'),/schema/);
});
test('batch verification rejects unauthorized rows and enforces maximum batch',()=>{
  const c=setup({getAllRows:()=>[{'Lead ID':'mine'},{'Lead ID':'other'}],_canWriteLead:r=>r['Lead ID']==='mine'});
  assert.throws(()=>c.verifyNbdLeads_(['other'],{}),/permission/);
  assert.throws(()=>c.verifyNbdLeads_(Array(51).fill('mine'),{}),/50/);
  c.CLIENT_CONFIG.APP_TITLE='LQ Lamination'; assert.throws(()=>c.verifyNbdLeads_(['mine'],{}),/only in LQ/);
});
test('external append preserves empty schema columns and typed date positions',()=>{
  let saved;
  const c=setup({sheetTypedRow_:(v,h)=>v.map((x,i)=>h[i]==='Created At'?123:x),sanitizeSheetRowValues_:v=>v,formatSheetDateRow_(){}});
  c._appendExternalRow_({getName:()=> 'lead',getLastRow:()=>1,getRange:()=>({setValues:v=>{saved=v;}})},['Lead ID','','Company Name','Created At'],{'Lead ID':'id','Company Name':'Test','Created At':'2026-11-13'});
  assert.deepEqual(Array.from(saved[0]),['id','','Test',123]);
});
test('single push checks current target and central records under lock before creating',()=>{
  assert.ok(source.indexOf('locked = lock.tryLock') < source.indexOf('const verifiedMatches'));
  assert.match(source,/const duplicates = verifiedMatches/);
  assert.doesNotMatch(source,/if \(linkedNbdLeadId && !mapToNbdLeadId\)/);
});
test('legacy central rows without lead IDs still prevent duplicate creation',()=>{
  const c=setup({SpreadsheetApp:{openById:id=>({getSheetByName:()=>({getDataRange:()=>({getValues:()=>id==='dq' ? [['Lead ID','Company Name','Origin Workbook'],['','Indian Velvet House','']] : [['Lead ID','Origin Workbook']]})})})}});
  const matches=c._nbdMatchRows_({'Lead ID':'source','Company Name':'Indian Velvet House'},c._nbdVerificationRows_('nbd'));
  assert.equal(matches.length,1); assert.equal(matches[0].nbdLeadId,''); assert.match(matches[0].location,/Disqualified/);
});
