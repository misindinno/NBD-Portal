const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.join(__dirname, '..');
const fields = [
  { 'Field Name': 'All-stage note', 'Column Key': 'note', 'Field Type': 'Textarea', 'Is Required': true, 'Stage ID': '', 'Validation Min': '', 'Validation Max': '' },
  { 'Field Name': 'Initial-stage code', 'Column Key': 'code', 'Field Type': 'Text', 'Is Required': true, 'Stage ID': 'initial', 'Validation Min': '', 'Validation Max': '' }
];
const server = { SHEET_NAMES: { FIELD_CONFIG: 'fields' }, queryRows: (_sheet, predicate) => fields.filter(predicate), toProperCase_: value => value };
vm.createContext(server);
vm.runInContext(fs.readFileSync(path.join(root, 'src/server/LeadService.js'), 'utf8'), server);
assert.doesNotThrow(() => server._prepareLeadPayload({ code: 'A' }, 'initial', {}, false, { allowEmptyGlobalOnCreate: true }));
assert.throws(() => server._prepareLeadPayload({ code: 'A' }, 'initial', {}, false), /All-stage note is required/);
assert.throws(() => server._prepareLeadPayload({ note: 'Hello' }, 'initial', {}, false, { allowEmptyGlobalOnCreate: true }), /Initial-stage code is required/);
assert.strictEqual(server._prepareLeadPayload({ note: 'Hello', code: 'A' }, 'initial', {}, false, { allowEmptyGlobalOnCreate: true }).note, 'Hello');
const client = { escapeHtml: value => String(value), App: { config: { stages: [{ 'Stage ID': 'initial', 'Is Initial Stage': true }] } } };
vm.createContext(client);
vm.runInContext(fs.readFileSync(path.join(root, 'src/Pipeline.html'), 'utf8').match(/function _isFinalStage\(stage\) \{[^}]+\}/)[0], client);
vm.runInContext(fs.readFileSync(path.join(root, 'src/LeadCustomFields.html'), 'utf8').replace(/<\/?script>/g, ''), client);
const markup = client.buildLeadCustomFieldsHTML({ 'Stage ID': 'initial' }, fields);
assert.match(markup, /name="note" data-custom-key="note" data-required="false"/);
assert.match(markup, /name="code" data-custom-key="code" data-required="true"/);
const editMarkup = client.buildLeadCustomFieldsHTML({ 'Lead ID': 'existing', 'Stage ID': 'initial' }, fields);
assert.match(editMarkup, /name="note" data-custom-key="note" data-required="true"/);
client.App.config.stages.push({'Stage ID':'dq','Is Final Stage':true,'Is Skippable':true});
const finalMarkup = client.buildLeadCustomFieldsHTML({'Lead ID':'existing','Stage ID':'dq'}, [
  {...fields[0], 'Skip Visibility':'skip_only'}, {...fields[1], 'Stage ID':'dq'}
]);
assert.doesNotMatch(finalMarkup, /name="note"|cf-skip-checkbox/);
assert.match(finalMarkup, /name="code" data-custom-key="code" data-required="true"/);
assert.match(fs.readFileSync(path.join(root, 'src/LeadForm.html'), 'utf8'), /globalOptionalOnCreate: true/);
assert.doesNotMatch(fs.readFileSync(path.join(root, 'src/LeadForm.html'), 'utf8'), /App\.token/);
assert.doesNotMatch(fs.readFileSync(path.join(root, 'src/LeadCustomFields.html'), 'utf8'), /App\.token/);
console.log('Lead creation fields and authenticated RPC checks passed.');

const skipField = { ...fields[0], 'Column Key':'skip', 'Field Name':'Exit explanation', 'Skip Visibility':'skip_only' };
fields.push(skipField);
for (const [stageId, final, skippable] of [['open',false,false],['optional',false,true],['dq',true,true],['initial',false,true]]) {
  const stage = { 'Stage ID':stageId, 'Is Final Stage':final, 'Is Skippable':skippable };
  server.getAllStages = () => [stage];
  const prepare = (values, skip, create=false) => server._prepareLeadPayload(values, stageId, {}, skip, {allowEmptyGlobalOnCreate:create});
  assert.doesNotThrow(() => prepare({ note:'done', code:'A' }, false));
  if (stageId === 'initial') {
    assert.throws(() => prepare({skip:'why'},true,true), /Initial-stage code is required/);
  } else if (stageId === 'optional') {
    assert.throws(() => prepare({},true), /Exit explanation is required/);
    assert.doesNotThrow(() => prepare({skip:'why'},true));
  } else {
    assert.throws(() => prepare({skip:'why'},true), /All-stage note is required/);
    assert.doesNotThrow(() => prepare({note:'done'},true));
  }
}
vm.runInContext(fs.readFileSync(path.join(root,'src/Pipeline.html'),'utf8').match(/function _pipelineStageFields\(stageId\) \{[\s\S]*?\n\}/)[0],client);
client.App.config.leadFields = fields;
assert.deepStrictEqual(Array.from(client._pipelineStageFields('dq'),f=>f['Column Key']), ['note']);
const sync = {};
vm.createContext(sync);
vm.runInContext(fs.readFileSync(path.join(root,'src/PortalSync.html'),'utf8').split('function createPortalOutbox')[0].replace('<script>',''),sync);
assert.equal(sync.portalSyncRetryableInvalid_({action:'apiMoveLeadStageWithFields',message:'Votre justification est obligatoire'}),true);
assert.equal(sync.portalSyncRetryableInvalid_({action:'apiSaveLead',message:'Invalid email'}),false);
