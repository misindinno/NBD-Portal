const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const read = file => fs.readFileSync(path.join(__dirname, '../src/server', file), 'utf8');

function setup(rows = [], final = false) {
  const ctx = vm.createContext({
    SHEET_NAMES: { FOLLOWUPS: 'followups', STAGES: 'stages' },
    _isArchivedLead_: lead => lead['Is Archived'] === true,
    _leadStageIsFinal_: stage => !!stage?.['Is Final Stage'],
    queryRows: () => [{ 'Is Final Stage': final }],
    getRowsByIndexedColumn_: (_sheet, _key, id) => rows.filter(r => r['Lead ID'] === id),
    formatDate: value => value || ''
  });
  vm.runInContext(read('FollowupService.js'), ctx);
  return ctx;
}
const lead = { 'Lead ID': 'lead1', 'Stage ID': 'initial' };
const task = { 'Follow-up ID': 'fu1', 'Lead ID': 'lead1', Status: 'Open', 'Planned Date': '2026-10-17' };

test('non-final leads need their own dated open task', () => {
  for (const rows of [[], [{ ...task, Status: 'Closed' }], [{ ...task, Status: 'Archived' }],
    [{ ...task, Status: 'Done' }], [{ ...task, 'Lead ID': 'other' }],
    [{ ...task, 'Planned Date': '' }], [{ ...task, 'Follow-up Type': 'Stage Change' }],
    [{ ...task, Status: '', Outcome: 'Completed' }]]) {
    assert.throws(() => setup(rows)._assertNonFinalLeadHasOpenFollowup_(lead), /Add an open follow-up/);
  }
  assert.doesNotThrow(() => setup([task])._assertNonFinalLeadHasOpenFollowup_(lead));
});

test('final and archived leads are exempt; reopening to a non-final stage is validated', () => {
  assert.doesNotThrow(() => setup([], true)._assertNonFinalLeadHasOpenFollowup_(lead));
  assert.doesNotThrow(() => setup()._assertNonFinalLeadHasOpenFollowup_({ ...lead, 'Is Archived': true }));
  assert.throws(() => setup([], true)._assertNonFinalLeadHasOpenFollowup_(lead, { 'Is Final Stage': false }), /open follow-up/);
});

test('direct stage moves validate before writing and batch deactivation validates the whole group', () => {
  const code = read('LeadService.js');
  for (const name of ['updateLeadStage', 'moveLeadStageWithFields']) {
    const body = code.slice(code.indexOf('function ' + name + '(')).split('\nfunction ')[0];
    assert.ok(body.indexOf('_assertNonFinalLeadHasOpenFollowup_') < body.indexOf('updateRow('));
  }
  const body = read('ConfigService.js').split('function _moveLeadsFromInactiveStage_')[1];
  assert.ok(body.indexOf('_assertNonFinalLeadHasOpenFollowup_') < body.indexOf('updateRow('));
});
