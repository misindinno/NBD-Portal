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
vm.runInContext(fs.readFileSync(path.join(root, 'src/LeadCustomFields.html'), 'utf8').replace(/<\/?script>/g, ''), client);
const markup = client.buildLeadCustomFieldsHTML({ 'Stage ID': 'initial' }, fields);
assert.match(markup, /name="note" data-custom-key="note" data-required="false"/);
assert.match(markup, /name="code" data-custom-key="code" data-required="true"/);
const editMarkup = client.buildLeadCustomFieldsHTML({ 'Lead ID': 'existing', 'Stage ID': 'initial' }, fields);
assert.match(editMarkup, /name="note" data-custom-key="note" data-required="true"/);
assert.match(fs.readFileSync(path.join(root, 'src/LeadForm.html'), 'utf8'), /globalOptionalOnCreate: true/);
assert.doesNotMatch(fs.readFileSync(path.join(root, 'src/LeadForm.html'), 'utf8'), /App\.token/);
assert.doesNotMatch(fs.readFileSync(path.join(root, 'src/LeadCustomFields.html'), 'utf8'), /App\.token/);
console.log('Lead creation fields and authenticated RPC checks passed.');
