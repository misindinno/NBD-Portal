const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function fixture(initial) {
  const data = structuredClone(initial), writes = [];
  const sheet = {
    getLastColumn: () => Math.max(0, ...data.map(row => row.length)),
    getRange(row, column, height = 1, width = 1) {
      return {
        getValues: () => Array.from({length:height}, (_,i) => Array.from({length:width}, (_,j) => data[row-1+i]?.[column-1+j] ?? '')),
        getValue: () => data[row-1]?.[column-1] ?? '',
        setValues(values) {
          writes.push({row,column,values});
          values.forEach((cells,i) => { data[row-1+i] ||= []; cells.forEach((value,j) => {data[row-1+i][column-1+j]=value;}); });
        }
      };
    }
  };
  const c = vm.createContext({CLIENT_CONFIG:{}, _invalidateReadCache_(){}});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../src/server/SheetDB.js'),'utf8'),c);
  c.getSheet=()=>sheet;c._styleHeaderRow=()=>{};
  return {data,writes,init:headers=>c.safeInitHeaders('test',headers)};
}

test('header initialization recognizes padded names and de-duplicates requested columns',()=>{
  const f=fixture([[' Value ID ','Lead ID'],['v1','l1']]);
  f.init(['Value ID',' Lead ID ','Field Value','Field Value',' ',null]);
  assert.deepEqual(f.data,[[' Value ID ','Lead ID','Field Value'],['v1','l1']]);
  assert.equal(f.writes.length,1);assert.equal(f.writes[0].column,3);
  f.init(['Value ID','Lead ID','Field Value']);assert.equal(f.writes.length,1);
});

test('blank first header never causes existing columns and data to be overwritten',()=>{
  const f=fixture([['','Lead ID','Remark'],['legacy-id','l1','Keep this']]);
  f.init(['Log ID','Lead ID','Remark']);
  assert.deepEqual(f.data,[['','Lead ID','Remark','Log ID'],['legacy-id','l1','Keep this']]);
});

test('a new empty sheet gets one normalized set of headers',()=>{
  const f=fixture([]);f.init([' Value ID ','Value ID','Lead ID']);
  assert.deepEqual(f.data,[['Value ID','Lead ID']]);
});
