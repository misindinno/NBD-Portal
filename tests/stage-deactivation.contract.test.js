const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function setup(stages, leads = [], options = {}) {
  const rows = { stages: structuredClone(stages), leads: structuredClone(leads) };
  const events = [];
  const context = {
    SHEET_NAMES: { STAGES: 'stages', LEADS: 'leads' },
    requireConfigEditor() {
      if (options.denied) throw new Error('Permission denied.');
      return { id: 'admin' };
    },
    getAllRows: sheet => structuredClone(rows[sheet]),
    queryRows: (sheet, filter) => structuredClone(rows[sheet]).filter(filter),
    updateRow(sheet, key, id, patch) {
      if (id === options.failId) return false;
      const row = rows[sheet].find(row => String(row[key]) === String(id));
      if (!row) return false;
      Object.assign(row, patch);
      events.push({ type: 'write', sheet, id });
      return true;
    },
    insertRow: (sheet, row) => rows[sheet].push(structuredClone(row)),
    now: () => '2026-09-08 12:00:00',
    generateUUID: () => 'new-stage',
    respond: (data, error) => ({ success: !error, data, error }),
    _bumpStamp: key => events.push({ type: 'stamp', key }),
    insertLeadActivityLog_: (...args) => events.push({ type: 'activity', args }),
    pushFsrLeadIds_: (ids, event) => events.push({ type: 'webhook', ids: Array.from(ids), event })
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/server/ConfigService.js'), 'utf8'), context);
  context.invalidateAppConfigCache = () => events.push({ type: 'config' });
  return { rows, events, save: patch => context.saveStage(patch, 'admin@example.com') };
}

const stage = (id, order, active = true) => ({
  'Stage ID': id, 'Stage Name': id, 'Stage Order': order, 'Is Active': active
});
const lead = (id, stageId, extra = {}) => ({
  'Lead ID': id, 'Stage ID': stageId, 'Lead Status': 'Open', ...extra
});
const tests = [];
const test = (name, run) => tests.push({ name, run });

test('deactivation moves all matching leads to the previous active stage in numeric order', () => {
  const original = [
    lead('one', 'current', { 'Assigned To': 'sales', 'Next Follow-up Date': '2026-09-10', custom: 'keep' }),
    lead('two', 'current', { 'Lead Status': 'Archived', 'Is Archived': true, 'Pre-Archive Status': 'Won' }),
    lead('three', 'previous'),
    lead('four', 'current', { 'Lead Status': 'Won', 'NBD Lead ID': 'nbd-4' })
  ];
  const app = setup([stage('later', 20), stage('current', 10), stage('inactive', 8, 'FALSE'), stage('previous', '3', 'TRUE'), stage('first', 1)], original);
  const result = app.save({ 'Stage ID': 'current', 'Is Active': false });
  assert.equal(result.success, true);
  assert.equal(result.data.movedLeadCount, 3);
  assert.equal(result.data.targetStageName, 'previous');
  for (const i of [0, 1, 3]) {
    assert.deepStrictEqual(app.rows.leads[i], {
      ...original[i], 'Stage ID': 'previous',
      'Stage Updated At': '2026-09-08 12:00:00', 'Updated At': '2026-09-08 12:00:00'
    });
  }
  assert.deepStrictEqual(app.rows.leads[2], original[2]);
  assert.equal(app.rows.stages.find(s => s['Stage ID'] === 'current')['Is Active'], false);
  assert.equal(app.events.filter(e => e.type === 'activity').length, 3);
  const activity = app.events.find(e => e.type === 'activity').args;
  assert.equal(activity[1], 'Stage Change');
  assert.equal(activity[2], 'current');
  assert.equal(activity[3], 'previous');
  assert.equal(activity[5], 'admin');
  assert.ok(app.events.some(e => e.type === 'stamp' && e.key === 'leads'));
  assert.ok(app.events.some(e => e.type === 'stamp' && e.key === 'stages'));
  assert.deepStrictEqual(app.events.find(e => e.type === 'webhook').ids, ['one', 'two', 'four']);
  const writes = app.events.filter(e => e.type === 'write');
  assert.equal(writes[writes.length - 1].sheet, 'stages');
});

test('string FALSE also deactivates and skips boolean inactive predecessors', () => {
  const app = setup([stage('first', 1), stage('skip', 2, false), stage('current', 3)], [lead('one', 'current')]);
  assert.equal(app.save({ 'Stage ID': 'current', 'Is Active': 'FALSE' }).success, true);
  assert.equal(app.rows.leads[0]['Stage ID'], 'first');
});

test('occupied stage without an earlier active stage is rejected before any write', () => {
  const app = setup([stage('inactive', 1, false), stage('current', 2), stage('later', 3)], [lead('one', 'current')]);
  const result = app.save({ 'Stage ID': 'current', 'Is Active': false });
  assert.equal(result.success, false);
  assert.match(result.error, /no previous active stage/);
  assert.equal(app.events.length, 0);
  assert.equal(app.rows.stages[1]['Is Active'], true);
  assert.equal(app.rows.leads[0]['Stage ID'], 'current');
});

test('empty first stage can be deactivated', () => {
  const app = setup([stage('first', 1)]);
  const result = app.save({ 'Stage ID': 'first', 'Is Active': false });
  assert.equal(result.success, true);
  assert.equal(result.data.movedLeadCount, 0);
});

test('ordinary edits, activation and new stages do not move leads', () => {
  for (const patch of [
    { 'Stage ID': 'current', 'Stage Name': 'Renamed' },
    { 'Stage ID': 'current', 'Is Active': true },
    { 'Stage Name': 'New inactive', 'Is Active': false }
  ]) {
    const app = setup([stage('first', 1), stage('current', 2)], [lead('one', 'current')]);
    assert.equal(app.save(patch).success, true);
    assert.equal(app.rows.leads[0]['Stage ID'], 'current');
    assert.ok(!app.events.some(e => e.type === 'activity' || e.type === 'webhook'));
  }
});

test('saving an already inactive stage repairs any remaining leads and repeated saves do not duplicate moves', () => {
  const app = setup([stage('first', 1), stage('current', 2, false)], [lead('one', 'current')]);
  assert.equal(app.save({ 'Stage ID': 'current', 'Is Active': false }).data.movedLeadCount, 1);
  assert.equal(app.save({ 'Stage ID': 'current', 'Is Active': false }).data.movedLeadCount, 0);
  assert.equal(app.events.filter(e => e.type === 'activity').length, 1);
});

test('partial migration failure keeps the source active and refreshes successfully moved leads', () => {
  const options = { failId: 'two' };
  const app = setup([stage('first', 1), stage('current', 2)], [lead('one', 'current'), lead('two', 'current')], options);
  assert.throws(() => app.save({ 'Stage ID': 'current', 'Is Active': false }), /reassignment failed/);
  assert.equal(app.rows.stages[1]['Is Active'], true);
  assert.equal(app.rows.leads[0]['Stage ID'], 'first');
  assert.equal(app.rows.leads[1]['Stage ID'], 'current');
  assert.ok(app.events.some(e => e.type === 'stamp' && e.key === 'leads'));
  assert.deepStrictEqual(app.events.find(e => e.type === 'webhook').ids, ['one']);
  delete options.failId;
  assert.equal(app.save({ 'Stage ID': 'current', 'Is Active': false }).data.movedLeadCount, 1);
  assert.equal(app.events.filter(e => e.type === 'activity').length, 2);
});

test('unknown stage IDs and unauthorized saves cannot move leads', () => {
  const app = setup([stage('first', 1)], [lead('one', 'first')]);
  assert.equal(app.save({ 'Stage ID': 'missing', 'Is Active': false }).success, false);
  assert.equal(app.events.length, 0);
  const denied = setup([stage('first', 1)], [lead('one', 'first')], { denied: true });
  assert.throws(() => denied.save({ 'Stage ID': 'first', 'Is Active': false }), /Permission denied/);
  assert.equal(denied.events.length, 0);
});

let failed = 0;
for (const { name, run } of tests) {
  try { run(); console.log('PASS ' + name); }
  catch (error) { failed++; console.error('FAIL ' + name); console.error(error); }
}
if (failed) process.exitCode = 1;
