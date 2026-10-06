const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function setup() {
  const headers = ['Lead ID', 'Company Name', 'Contact Person', 'Phone', 'Alternate No', 'Email', 'Lead Status', 'FSR Visit History'];
  const state = { rows: [], reads: [], locked: false };
  const sheet = {
    getLastRow: () => state.rows.length + 1,
    getRange(row, col, count, width) {
      state.reads.push({ row, col, count, width, locked: state.locked });
      return { getValues: () => state.rows.slice(row - 2, row - 2 + count).map(record => headers.slice(col - 1, col - 1 + width).map(key => record[key] || '')) };
    },
    appendRow(values) { assert.ok(state.locked); state.rows.push(Object.fromEntries(headers.map((key, i) => [key, values[i]]))); }
  };
  const ctx = vm.createContext({
    SHEET_NAMES: { LEADS: 'master', IDX_LEADS: 'index' },
    getSheet(name) { assert.equal(name, 'master'); return sheet; },
    getHeaders: () => headers,
    normalizeSheetValue: value => value,
    getAllRows() { throw Error('Duplicate checks must not use stale/cached indexes or full-sheet reads'); },
    rebuildIndexForSheet_() { throw Error('Duplicate checks must not rebuild indexes'); },
    pickLeadMasterFields_: row => row,
    LockService: { getScriptLock: () => ({ waitLock() { state.locked = true; }, releaseLock() { state.locked = false; } }) }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/server/LeadService.js'), 'utf8'), ctx);
  return { ctx, state };
}
const lead = { 'Lead ID': 'old-id', 'Company Name': 'Verritas Furniture Private Limited_Kolkata', Phone: '9836124365', 'Contact Person': 'Na', 'Lead Status': 'Open' };

test('deleted master records stop blocking the popup and locked insert', () => {
  const { ctx, state } = setup();
  state.rows = [lead];
  assert.equal(ctx.checkLeadDuplicates(lead.Phone, '', '', lead['Company Name']).length, 1);
  state.rows = [];
  assert.equal(ctx.checkLeadDuplicates(lead.Phone, '', '', lead['Company Name']).length, 0);
  assert.equal(ctx._insertLeadMasterRowBlockingDuplicates_({ ...lead, 'Lead ID': 'new-id' }).success, true);
  assert.equal(state.rows.length, 1);
  assert.equal(state.locked, false);
  assert.equal(ctx._insertLeadMasterRowBlockingDuplicates_({ ...lead, 'Lead ID': 'another' }).success, false);
  assert.equal(state.rows.length, 1);
  assert.ok(state.reads.at(-1).locked);
});

test('manual edits use current master values and missing index records still block', () => {
  const { ctx, state } = setup();
  state.rows = [lead];
  assert.equal(ctx.checkLeadDuplicates(lead.Phone, '', '', '').length, 1);
  state.rows = [{ ...lead, Phone: '9876543210', 'Company Name': 'Changed company' }];
  assert.equal(ctx.checkLeadDuplicates(lead.Phone, '', '', lead['Company Name']).length, 0);
  assert.equal(ctx._leadDuplicateMessage_(lead, ''), '');
  assert.equal(ctx.checkLeadDuplicates('98765 43210', '', '', '').length, 1);
  assert.match(ctx._leadDuplicateMessage_({ Phone: '9876543210' }, ''), /phone already exists/);
});

test('alternate numbers, case-insensitive email/company and self exclusion remain enforced', () => {
  const { ctx, state } = setup();
  state.rows = [{ ...lead, Phone: '98361 24365', 'Alternate No': '98765-43210', Email: 'Sales@Example.test' }];
  assert.equal(ctx.checkLeadDuplicates(lead.Phone, '', '', '').length, 1);
  assert.equal(ctx.checkLeadDuplicates('9876543210', '', '', '').length, 1);
  assert.equal(ctx.checkLeadDuplicates('', ' sales@example.test ', '', '').length, 1);
  assert.equal(ctx.checkLeadDuplicates('', '', '', 'VERRITAS   Furniture Private Limited_Kolkata').length, 1);
  assert.equal(ctx.checkLeadDuplicates(lead.Phone, '', 'old-id', '').length, 0);
  assert.equal(ctx._leadDuplicateMessage_(lead, 'old-id'), '');
  assert.match(ctx._leadDuplicateMessage_({ 'Alternate No': '9836124365' }), /alternate phone/);
  // The current record cannot hide a genuine duplicate when it appears last.
  state.rows.unshift({ ...lead, 'Lead ID': 'other-id' });
  assert.match(ctx._leadDuplicateMessage_(lead, 'old-id'), /phone already exists/);
});

test('large sheets read one bounded lookup span and never visit history', () => {
  const { ctx, state } = setup();
  state.rows = Array.from({ length: 7000 }, (_, i) => ({ 'Lead ID': 'id-' + i, Phone: String(9000000000 + i) }));
  assert.equal(ctx.checkLeadDuplicates('9000006999', '', '', '').length, 1);
  assert.equal(state.reads.length, 1);
  assert.equal(state.reads[0].width, 7);
  assert.equal(state.reads[0].count, 7000);
});

test('master read errors propagate instead of allowing an unchecked insert', () => {
  const { ctx, state } = setup();
  ctx.getHeaders = () => { throw Error('read unavailable'); };
  assert.throws(() => ctx._insertLeadMasterRowBlockingDuplicates_(lead), /read unavailable/);
  assert.equal(state.rows.length, 0);
  assert.equal(state.locked, false);
});
