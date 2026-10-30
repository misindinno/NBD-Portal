const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { syncFixture } = require('./helpers/sync-fixture');
function setup() {
  const f = syncFixture();
  vm.runInContext(fs.readFileSync('src/server/SheetValueTypes.js', 'utf8'), f.c);
  return f;
}
test('date columns become numeric dates; text, IDs, phones and booleans retain types', () => {
  const {c} = setup();
  for (const value of ['2026-10-30', "'2026-10-30"]) {
    const cell = c.syncCell_(value, 'Planned Date');
    assert.equal(cell.userEnteredValue.numberValue, 46325);
    assert.equal(cell.userEnteredFormat.numberFormat.pattern, 'yyyy-mm-dd');
  }
  assert.equal(c.syncCell_('2026-10-30 14:25:30', 'Updated At').userEnteredValue.numberValue, 46325 + 51930 / 86400);
  for (const value of ['00123', '+919999999999', '=IMPORTXML("x")', '2026-10-30']) {
    assert.equal(c.syncCell_(value, 'Phone').userEnteredValue.stringValue, value);
  }
  assert.equal(c.syncCell_(true, 'Active').userEnteredValue.boolValue, true);
  assert.equal(c.syncCell_(12, 'Count').userEnteredValue.numberValue, 12);
  for (const value of ['2026-02-30', '30/10/2026', '2026-10-30T14:25:30Z', '2026-10-30 25:00:00']) {
    assert.equal(c.syncCell_(value, 'Planned Date').userEnteredValue.stringValue, value);
  }
});
test('atomic follow-up save writes typed dates and retry remains idempotent', () => {
  const f = setup();
  const command = f.command('apiMarkFollowupDoneDirect', ['F1', {
    'Done Date':'2026-10-24', 'Next Follow-up Date':'2026-10-27', Remark:'Type verification',
    'Was Productive':'Yes', 'Contact Mode':'Call Connected'
  }], [f.base('followup','F1'), f.base('lead','L1')]);
  const result = f.call(command);
  assert.equal(result.data?.state, 'committed', JSON.stringify(result));
  assert.equal(typeof f.rows('FOLLOWUPS')[0]['Planned Date'], 'number');
  assert.ok(f.requests[0].requests.some(r => r.updateCells?.fields === 'userEnteredFormat.numberFormat'));
  assert.equal(f.call(command).data.repeated, true);
  assert.equal(f.rows('FOLLOWUP_HISTORY').length, 1);
});
test('legacy conversion parses dates in script timezone without converting phone or remark text', () => {
  const {c} = setup();
  const calls = [];
  c.Session = {getScriptTimeZone: () => 'Asia/Kolkata'};
  c.Utilities.parseDate = (...args) => { calls.push(args); return new Date('2026-10-29T18:30:00Z'); };
  const row = c.sheetTypedRow_(['2026-10-30', '00123', '2026-10-30'], ['Done Date', 'Phone', 'Remark']);
  assert.ok(row[0] instanceof Date);
  assert.equal(row[1], '00123'); assert.equal(row[2], '2026-10-30');
  assert.deepEqual(calls, [['2026-10-30 00:00:00', 'Asia/Kolkata', 'yyyy-MM-dd HH:mm:ss']]);
});
