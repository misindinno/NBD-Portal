const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { syncFixture } = require('./helpers/sync-fixture');
const source = fs.readFileSync('src/server/PhoneNumbers.js','utf8');
function helpers() { const c=vm.createContext({});vm.runInContext(source,c);return c; }
test('phone lists preserve formatting and normalize duplicate country prefixes',()=>{
 const c=helpers();const row={Phone:'98765 43210','Alternate No':'+91 9876543210; 9234567890\n9345678901','WhatsApp No':'9234567890'};
 assert.deepEqual(Array.from(c.leadPhoneNumbers_(row)),['98765 43210','9234567890','9345678901']);
 const p=c.validateLeadPhones_({...row});assert.equal(p['Alternate No'],'9234567890\n9345678901');
 assert.throws(()=>c.validateLeadPhones_({Phone:'9876543210,9234567890'}),/one primary/);
 assert.throws(()=>c.validateLeadPhones_({'Alternate No':'9234567890;bad'}),/valid additional/);
 assert.equal(c.validateLeadPhones_({'Alternate No':''})['Alternate No'],'');
});
test('bulk creates multiple phone numbers atomically and retry does not duplicate them',()=>{
 const f=syncFixture();f.c._bulkInitialStageId_=()=> 'S1';
 const cmd=f.command('apiSaveBulkRows',[[{'Company Name':'Many numbers',Phone:'9000000001','Additional Phones':'9000000002, 9000000003'}],'create']);
 const result=f.call(cmd);assert.equal(result.data?.state,'committed',JSON.stringify(result));
 assert.equal(result.data.result.summary.saved,1,JSON.stringify(result));
 assert.equal(f.rows('LEAD_MASTER')[1]['Alternate No'],'9000000002\n9000000003');
 assert.equal(f.call(cmd).data.repeated,true);assert.equal(f.rows('LEAD_MASTER').length,2);
});
test('UI collects every dynamic field, rejects repeated numbers and escapes phone markup',()=>{
 const c=vm.createContext({escapeHtml:s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;')});
 vm.runInContext(fs.readFileSync('src/LeadFormShared.html','utf8').split('function buildLeadFormHTML')[0].replace('<script>',''),c);
 let values=['9234567890','9345678901'];const form={querySelector:()=>({}),querySelectorAll:()=>values.map(value=>({value,focus(){}}))};
 const payload={Phone:'9876543210'};c.collectLeadPhones(form,payload);assert.equal(payload['Alternate No'],values.join('\n'));
 values=['+91 9876543210'];assert.throws(()=>c.collectLeadPhones(form,payload),/different/);
 const html=c.leadPhonesHTML({Phone:'9876543210','Alternate No':'9234567890\n9345678901'});assert.equal((html.match(/href="tel:/g)||[]).length,3);assert.match(html,/Primary/);assert.match(html,/Additional/);
 assert.doesNotMatch(c.leadPhonesHTML({Phone:'<img src=x onerror=alert(1)>'}),/<img/);
});

test('legacy bulk phone validation accepts multiple additional numbers as text',()=>{
 const f=syncFixture();f.c._bulkInitialStageId_=()=> 'S1';
 const table=f.tables.get('Bulk_Config');table.data.push(['Alternate No','No','Number','Alternate No','phone','']);
 const cmd=f.command('apiSaveBulkRows',[[{'Company Name':'Legacy config',Phone:'9000000001','Alternate No':'9000000002,9000000003'}],'create']);
 const result=f.call(cmd);assert.equal(result.data?.result?.summary?.saved,1,JSON.stringify(result));
 assert.equal(f.rows('LEAD_MASTER')[1]['Alternate No'],'9000000002\n9000000003');
});
