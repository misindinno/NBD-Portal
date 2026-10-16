const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
function context(extra = {}) {
  const c = vm.createContext({assertServerContext_(){}, normalizeSheetName:n=>n,
    normalizeSheetValue:v=>v, SHEET_NAMES:{LEADS:'leads',IDX_LEADS:'index',FOLLOWUPS:'followups',IDX_FOLLOWUPS:'fi',USERS:'users',IDX_USERS:'ui'}, ...extra});
  vm.runInContext(fs.readFileSync('src/server/IndexService.js','utf8'),c);
  return c;
}
test('stale row pointer resolves the actual ID without reading the entire master',()=>{
  const c=context(); c.findIndexedRowNumber_=()=>2;
  c._getRowObjectAt_=(_,n)=>({'Lead ID':n===2?'other':'wanted'});
  c.findRowIndexWithoutIndex_=()=>8;
  c.getAllRows=()=>{throw Error('full scan');};
  assert.equal(c.getRowByIndexedId_('leads','Lead ID','wanted')['Lead ID'],'wanted');
});
test('column lookup includes records omitted by a stale index',()=>{
  const c=context({getAllRows:()=>[{'Lead ID':'a'},{'Lead ID':'b'},{'Lead ID':'a'}]});
  assert.equal(c.getRowsByIndexedColumn_('followups','Lead ID','a').length,2);
});
test('rebuild replaces stale tail in one write and retains old data if write fails',()=>{
  let written; const old=[['old'],['stale']];
  const index={getLastRow:()=>3,getMaxRows:()=>10,getRange:()=>({setValues(rows){written=rows;throw Error('write unavailable');},clearContent(){throw Error('must not clear first');}})};
  const source={getDataRange:()=>({getValues:()=>[['Lead ID','Phone'],['a','123']]})};
  const c=context({safeInitHeaders(){},getSheet:n=>n==='leads'?source:index});
  assert.throws(()=>c.rebuildIndexForSheet_('leads'),/write unavailable/);
  assert.equal(written[0][0],'a');assert.ok(written[1].every(x=>x===''));
  assert.deepEqual(old,[['old'],['stale']]);
});
test('fallback finder reads the ID column and treats IDs literally',()=>{
  const calls=[]; const finder={matchEntireCell(v){assert.equal(v,true);return this;},matchCase(){return this;},useRegularExpression(v){assert.equal(v,false);return this;},findNext(){return {getRow:()=>7};}};
  const c=context({getSheet:()=>({getLastRow:()=>100,getLastColumn:()=>30,getRange(...args){calls.push(args);return args[0]===1?{getValues:()=>[['Name','Lead ID']]}:{createTextFinder:id=>{assert.equal(id,'a.*');return finder;}};}})});
  assert.equal(c.findRowIndexWithoutIndex_('leads','Lead ID','a.*'),7);
  assert.deepEqual(calls,[[1,1,1,30],[2,2,99,1]]);
});
