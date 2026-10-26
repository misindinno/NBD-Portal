const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const {read}=require('./helpers/lead-cache-fixture');
function fixture() {
  const nodes=new Map(),calls=[];let constructions=0;
  const holder={scrollTop:180,scrollLeft:25};nodes.set('lead-table',{querySelector:()=>holder});
  nodes.set('content',{innerHTML:''});
  const c=vm.createContext({window:{},App:{currentPage:'leads',user:{role:'ADMIN'},config:{stages:[],users:[],statuses:[],priorities:[],sources:[]}},
    el:id=>nodes.get(id),document:{documentElement:{style:{setProperty(){}}}},escapeHtml:String,icon:()=>'',renderIcons(){},leadPriorityOptions:()=>[],hasModule:()=>false,_isNBDPortal:()=>false,
    Tabulator:function(selector,options){
      constructions++;calls.push(['construct',options]);this.rows=options.data;
      this.on=(event,fn)=>{if(event==='tableBuilt')queueMicrotask(fn);};
      this.getData=()=>this.rows;
      this.blockRedraw=()=>calls.push(['block']);this.restoreRedraw=()=>calls.push(['restore']);
      this.deleteRow=async ids=>{calls.push(['delete',ids]);this.rows=this.rows.filter(row=>!ids.includes(row['Lead ID']));};
      this.updateOrAddData=async rows=>{calls.push(['update',rows]);for(const row of rows){const old=this.rows.find(r=>r['Lead ID']===row['Lead ID']);if(old)Object.assign(old,row);else this.rows.push(row);}};
      this.setSort=()=>calls.push(['sort']);this.destroy=()=>calls.push(['destroy']);this.replaceData=async rows=>{calls.push(['replace']);this.rows=rows;};
    }});
  vm.runInContext(read('src/Leads.html').replace(/^<script>\s*/,'').replace(/<\/script>\s*$/,''),c);
  return {c,nodes,calls,holder,get constructions(){return constructions;}};
}

test('initial lead list uses a bounded virtual table; refresh patches changed and removed rows without rebuilding',async()=>{
  const f=fixture(), rows=[{'Lead ID':'1','Company Name':'First'}, {'Lead ID':'2','Company Name':'Remove'}];
  await f.c._renderLeadsTable(rows);f.nodes.set('leads-page',{});
  const options=f.calls[0][1];assert.equal(options.index,'Lead ID');assert.equal(options.height,'60vh');assert.equal(options.renderVertical,'virtual');
  f.calls.length=0;
  await f.c._renderLeadsTable([{'Lead ID':'1','Company Name':'Changed'}, {'Lead ID':'3','Company Name':'New'}]);
  assert.equal(f.constructions,1);assert.equal(f.calls.some(c=>['destroy','replace'].includes(c[0])),false);
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls.find(c=>c[0]==='delete')[1])),['2']);
  assert.equal(f.calls.find(c=>c[0]==='update')[1].length,2);assert.equal(f.holder.scrollTop,180);
  f.calls.length=0;
  await f.c._renderLeadsTable([{'Lead ID':'1','Company Name':'Changed'}, {'Lead ID':'3','Company Name':'New'}]);
  assert.equal(f.calls.length,0,'unchanged data must not mutate the table');
});

test('removed fields are cleared once and different object key order does not force updates',()=>{
  const f=fixture();
  const delta=f.c._leadRowChanges([{'Lead ID':'1',Phone:'old',_previewSource:'sheet-mirror'}],[{'Lead ID':'1',Phone:''}]);
  assert.equal(delta.updated[0]._previewSource,'');
  const next=f.c._leadRowChanges(delta.updated,[{Phone:'','Lead ID':'1'}]);assert.equal(next.updated.length,0);
});
