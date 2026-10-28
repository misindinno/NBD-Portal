const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const {read}=require('./helpers/lead-cache-fixture');
function fixture(){const c=vm.createContext({Set});vm.runInContext(read('src/Pipeline.html').replace(/^<script>\s*/, '').split('function _pipelineApplyFilters')[0],c);return c;}
const stages=[{'Stage ID':'new','Stage Name':'New','Stage Order':1},{'Stage ID':'dq','Stage Name':'Disqualified','Stage Order':9,'Is Final Stage':true}];
test('existing Disqualified stage links automatically; explicit custom target overrides it',()=>{
  const c=fixture();assert.equal(c.pipelineDisqualifiedStage(stages)['Stage ID'],'dq');
  const custom={ 'Stage ID':'custom','Stage Name':'Not interested','Stage Order':10,'Pipeline Data Source':'central_disqualified'};
  assert.equal(c.pipelineDisqualifiedStage([...stages,custom])['Stage ID'],'custom');
  assert.equal(c.pipelineDisqualifiedStage(stages.map(s=>({...s,'Pipeline Data Source':'portal'}))),null);
});
test('central projection deduplicates stale local rows and preserves original data and assignment',()=>{
  const c=fixture(),local=[{'Lead ID':'local','Stage ID':'new'},{'Lead ID':'moved','Stage ID':'dq'}];
  const central=[{'Lead ID':'moved','Stage ID':'old-stage','Transfer State':'Transferred','Assigned To':'u1','Company Name':'Saved client'}];
  const result=c.pipelineMergeCentralLeads(local,central,{'Stage ID':'custom'});
  assert.equal(result.length,2);const saved=result.find(r=>r['Lead ID']==='moved');
  assert.equal(saved['Stage ID'],'custom');assert.equal(saved['Assigned To'],'u1');assert.equal(saved._centralDisqualified,true);
  assert.equal(central[0]['Stage ID'],'old-stage');assert.equal(local.length,2);
});
test('incomplete transfers and archived central entries never appear as active pipeline cards',()=>{
  const c=fixture();const central=['Pending','Copied','Transferred'].map((state,i)=>({'Lead ID':String(i),'Transfer State':state}));
  central.push({'Lead ID':'archived','Transfer State':'Transferred','Is Archived':'TRUE'});
  assert.deepEqual(Array.from(c.pipelineMergeCentralLeads([],central,stages[1]),r=>r['Lead ID']),['2']);
  assert.equal(c.pipelineMergeCentralLeads([],central,null).length,0);
});
test('renamed custom stages are selected for central transfer by data source or explicit outcome',()=>{
  const c=vm.createContext({Set,CLIENT_CONFIG:{}});vm.runInContext(read('src/server/DisqualifiedService.js'),c);
  assert.deepEqual(Array.from(c.dqStageIds_([{...stages[0],'Pipeline Data Source':'central_disqualified'},
    {'Stage ID':'outcome','Stage Name':'Closed clients','Stage Outcome':'Disqualified'},stages[1]])),['new','outcome','dq']);
});
