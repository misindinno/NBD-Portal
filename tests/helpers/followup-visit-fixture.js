const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {fixture,root,modules}=require('./cfv-fixture');
function followupVisitFixture(options) {
  const f=fixture(options);
  f.c.SHEET_NAMES.FOLLOWUPS='FOLLOWUPS';
  f.followup={'Follow-up ID':'fu-001','Lead ID':'001','Created By':'host1',Status:'Open'};
  f.c.getRowByIndexedId_=(sheet,key,id)=>sheet==='FOLLOWUPS'&&id===f.followup['Follow-up ID']?{...f.followup}:null;
  f.c._leadIndexRowsForScope_=()=>[f.lead];
  vm.runInContext(fs.readFileSync(path.join(root,'src/server/FollowupVisitService.js'),'utf8'),f.c);
  f.quick=(extra={})=>({requestId:'request-followup-visit-0001',followupId:'fu-001',date:'2026-10-28',remark:'Discuss product samples',visitType:'Factory',...extra});
  f.grants=[...modules,'Followups','Leads'];
  return f;
}
module.exports={followupVisitFixture};
