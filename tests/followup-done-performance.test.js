const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

function sheetFixture(data) {
  const reads = [], writes = [];
  const sheet = {
    getLastRow: () => data.length, getLastColumn: () => data[0].length,
    getDataRange() { throw Error('Full-sheet read is forbidden on this path'); },
    getRange(row, col, height = 1, width = 1) {
      return {
        getValues() { reads.push({ row, col, height, width }); return data.slice(row - 1, row - 1 + height).map(r => r.slice(col - 1, col - 1 + width)); },
        setValues(values) { writes.push({ row, values }); if (sheet.failWrite) throw Error('write failed'); values.forEach((r, i) => r.forEach((v, j) => { data[row - 1 + i][col - 1 + j] = v; })); },
        createTextFinder(target) {
          return { matchEntireCell(value) { assert.equal(value, true); return this; }, matchCase(value) { assert.equal(value, true); return this; }, useRegularExpression(value) { assert.equal(value, false); return this; }, findNext() {
            for (let i = row - 1; i < row - 1 + height; i++) if (String(data[i][col - 1]) === target) return { getRow: () => i + 1 };
            return null;
          } };
        }
      };
    }
  };
  return { sheet, reads, writes, data };
}

function updateContext(fixture, hint) {
  let held = false, released = 0;
  const synced = [];
  const ctx = vm.createContext({
    CLIENT_CONFIG: {}, SpreadsheetApp: { flush() {} }, SHEET_NAMES: { FOLLOWUPS: 'followups' },
    LockService: { getScriptLock: () => ({ waitLock() { held = true; }, releaseLock() { held = false; released++; } }) },
    findIndexedRowNumber_() { assert.equal(held, true); return hint; },
    syncIndexRow_: (...args) => synced.push(args),
    sanitizeSheetRowValues_: values => values.map(value => typeof value === 'string' && value.startsWith('=') ? "'" + value : value)
  });
  vm.runInContext(read('src/server/SheetDB.js'), ctx);
  ctx.getSheet = () => fixture.sheet;
  ctx.normalizeSheetValue = value => value;
  return { ctx, synced, released: () => released };
}

test('one follow-up update reads only its header and target row even with 7000 records', () => {
  const fixture = sheetFixture([['Follow-up ID', 'Remark', 'Next Date', 'Amount'], ...Array.from({ length: 7000 }, (_, i) => ['FU-' + i, 'unchanged', '2026-09-25', 42])]);
  const { ctx, synced, released } = updateContext(fixture, 6689);
  assert.equal(ctx._legacyUpdateRow_('followups', 'Follow-up ID', 'FU-6687', { Remark: 'Done' }), true);
  assert.equal(fixture.data[6688][1], 'Done');
  assert.equal(fixture.data[6688][2], '2026-09-25');
  assert.equal(fixture.data[6688][3], 42);
  assert.equal(fixture.reads.reduce((count, r) => count + r.height * r.width, 0), 8);
  assert.equal(synced[0][2], 6689);
  assert.equal(released(), 1);
});

test('stale index is verified and falls back to only the ID column', () => {
  const fixture = sheetFixture([['ID', 'Value'], ['other', 'keep'], ['target', 'old']]);
  const { ctx, synced } = updateContext(fixture, 2);
  assert.equal(ctx._legacyUpdateRow_('followups', 'ID', 'target', { Value: '=SUM(A1)' }), true);
  assert.equal(fixture.data[1][1], 'keep');
  assert.equal(fixture.data[2][1], "'=SUM(A1)");
  assert.ok(fixture.reads.some(r => r.height === 2 && r.width === 1));
  assert.equal(synced[0][2], 3);
});

test('missing IDs never write and a write failure releases the lock', () => {
  const fixture = sheetFixture([['ID', 'Value'], ['other', 'keep']]);
  const { ctx, released } = updateContext(fixture, 1);
  assert.equal(ctx._legacyUpdateRow_('followups', 'ID', 'missing', { Value: 'bad' }), false);
  assert.equal(fixture.writes.length, 0);
  fixture.sheet.failWrite = true;
  assert.throws(() => ctx._legacyUpdateRow_('followups', 'ID', 'other', { Value: 'bad' }), /write failed/);
  assert.equal(released(), 2);
});

test('index lookup returns an exact match without transferring the entire index', () => {
  const fixture = sheetFixture([['ID', 'Row Number'], ['abc', 10], ['ABC', 20], ['ABC-more', 30]]);
  const ctx = vm.createContext({ getSheet: () => fixture.sheet, safeInitHeaders() {}, normalizeSheetValue: value => value, Logger: { log() {} } });
  vm.runInContext(read('src/server/IndexService.js'), ctx);
  const found = ctx._findIndexRecord_({ indexSheet: 'index', headers: ['ID', 'Row Number'] }, 'ID', 'ABC');
  assert.equal(found.rowNumber, 3);
  assert.equal(found.row['Row Number'], 20);
  assert.equal(fixture.reads.length, 2);
  assert.equal(ctx._findIndexRecord_({ indexSheet: 'index' }, 'ID', 'AB'), null);
});

function doneContext(failHistory) {
  const writes = [], histories = [], steps = [];
  const row = { 'Follow-up ID': 'FU1', 'Lead ID': 'L1', 'Stage ID': 'S1', 'Planned Date': '2026-09-24', 'Next Follow-up Date': '2026-09-24', Status: 'Open' };
  const lead = { 'Lead ID': 'L1', 'Stage ID': 'S1' };
  const ctx = vm.createContext({
    SHEET_NAMES: { FOLLOWUPS: 'followups', LEADS: 'leads', STAGES: 'stages', FOLLOWUP_HISTORY: 'history' },
    safeInitHeaders() {}, requireRoleForEmail_: () => ({ id: 'user1', role: 'ADMIN' }),
    getRowByIndexedId_: sheet => sheet === 'followups' ? row : lead,
    formatDate: value => value, today: () => '2026-09-24', now: () => '2026-09-24 12:00:00', generateUUID: () => 'history1',
    queryRows: () => [{ 'Stage ID': 'S1', 'Is Final Stage': false }], _leadStageIsFinal_: () => false,
    updateRow: (sheet, key, id, patch) => { writes.push({ sheet, patch }); return true; },
    insertRow: (_sheet, history) => { if (failHistory) throw Error('Service timed out'); histories.push(history); },
    pickFollowupMasterFields_: value => value, _bumpStamp() {}, pushFsrLeadById_() {},
    respond: (data, error) => ({ success: !error, data, error }),
    withDiagnosticSpan_: (_name, attrs, fn) => { steps.push(attrs.step); return fn(); }
  });
  vm.runInContext(read('src/server/FollowupService.js'), ctx);
  ctx._canWriteFollowupRow = () => true;
  return { ctx, writes, histories, steps };
}
const donePayload = { 'Done Date': '2026-09-24', 'Next Follow-up Date': '2026-09-28', Remark: 'Address shared', 'Contact Mode': 'Call Connected', 'Was Productive': 'Yes' };

test('Save Done preserves history, schedules the next follow-up and updates lead dates', () => {
  const { ctx, writes, histories, steps } = doneContext(false);
  const result = ctx.markFollowupDone('FU1', donePayload, 'user@example.test');
  assert.equal(result.success, true);
  assert.equal(histories.length, 1);
  assert.equal(histories[0]['Remark'], 'Address shared');
  assert.equal(histories[0]['Planned Date'], '2026-09-24');
  assert.equal(writes[0].patch['Planned Date'], '2026-09-28');
  assert.equal(writes[1].patch['Next Follow-up Date'], '2026-09-28');
  assert.ok(steps.includes('saving follow-up history'));
});

test('history timeout restores the original follow-up and retains the failing step', () => {
  const { ctx, writes } = doneContext(true);
  assert.throws(() => ctx.markFollowupDone('FU1', donePayload, 'user@example.test'), error => error.followupDoneStep === 'saving follow-up history');
  assert.equal(writes.length, 2);
  assert.equal(writes[1].patch['Planned Date'], '2026-09-24');
});

test('disabled API writes go directly to a single locked update', () => {
  const fixture = sheetFixture([['ID', 'Value'], ['target', 'old']]);
  const { ctx, released } = updateContext(fixture, 2);
  ctx._invalidateReadCache_ = () => {};
  ctx._rawWriteSafe_ = () => false;
  ctx._sheetsApiUpdateRow_ = () => { throw Error('Disabled API write must not be attempted'); };
  assert.equal(ctx.updateRow('followups', 'ID', 'target', { Value: 'saved' }), true);
  assert.equal(released(), 1);
  assert.equal(fixture.data[1][1], 'saved');
});

test('lock timeout is identified before any row write and does not release an unowned lock', () => {
  const fixture = sheetFixture([['ID', 'Value'], ['target', 'old']]);
  const { ctx } = updateContext(fixture, 2);
  ctx.LockService = { getScriptLock: () => ({
    waitLock(ms) { assert.ok(ms > 45000); throw Error('Lock timeout'); },
    releaseLock() { throw Error('Cannot release an unowned lock'); }
  }) };
  assert.throws(() => ctx._legacyUpdateRow_('followups', 'ID', 'target', { Value: 'saved' }), error => error.sheetUpdateStep === 'waiting for another write to release the script lock');
  assert.equal(fixture.writes.length, 0);
});
