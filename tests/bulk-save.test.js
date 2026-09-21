const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

function setup() {
  const names = { LEADS: 'leads', FOLLOWUPS: 'followups', LEAD_FIELD_VALUES: 'values', FOLLOWUP_FIELD_VALUES: 'fuValues', IDX_LEADS: 'leadIndex', IDX_FOLLOWUPS: 'fuIndex', FIELD_CONFIG: 'fields', USERS: 'users', IDX_USERS: 'userIndex' };
  const data = {}, headers = {}, writes = [], scans = [], errors = [];
  let serial = 0, locked = false;
  const fields = [
    { 'Field ID': 'note-field', 'Field Name': 'Note', 'Column Key': 'note', 'Field Type': 'Textarea', 'Is Required': true, 'Stage ID': '', 'Validation Min': '', 'Validation Max': '' },
    { 'Field ID': 'code-field', 'Field Name': 'Code', 'Column Key': 'code', 'Field Type': 'Text', 'Is Required': true, 'Stage ID': 'initial', 'Validation Min': '', 'Validation Max': '' }
  ];
  const ctx = vm.createContext({
    SHEET_NAMES: names, assertServerContext_() {}, normalizeSheetName: n => n, normalizeSheetValue: value => value,
    toProperCase_: value => value, now: () => '2026-09-21 15:00:00', today: () => '2026-09-21',
    generateUUID: () => 'id-' + (++serial), Logger: { log: message => errors.push(message) },
    withTrustedWriteUser_: (_email, fn) => fn(),
    requireBulkEntryWriter_: () => ({ id: 'user1', role: 'ADMIN' }),
    requireRole: () => ({ id: 'user1', role: 'ADMIN' }),
    respond: (value, error) => ({ success: !error, data: value, error }),
    _invalidateReadCache_() {}, _bumpStamp() {}, pushFsrLeadIds_() {}, pushFsrLeadById_() {},
    LockService: { getScriptLock: () => ({ waitLock() { assert.equal(locked, false); locked = true; }, releaseLock() { locked = false; } }) },
    getConfigByType: () => ['Call'], ensureFollowupSheets_() {},
    getHeaders: sheet => headers[sheet],
    safeInitHeaders(sheet, required) { if (!headers[sheet]) headers[sheet] = Array.from(required); if (!data[sheet]) data[sheet] = []; },
    getAllRows(sheet) { scans.push(sheet); return (data[sheet] || []).map(row => Object.fromEntries(headers[sheet].map((h, i) => [h, row[i]]))); },
    getSheet(sheet) {
      if (!data[sheet]) data[sheet] = [];
      return {
        getLastRow: () => data[sheet].length + 1,
        getLastColumn: () => (headers[sheet] || []).length,
        getRange: (row, col, count, width) => ({ clearContent() { data[sheet] = []; }, setValues(values) {
          if (ctx.failSheet === sheet) { ctx.failSheet = ''; throw Error('Service timed out'); }
          assert.equal(locked, true, 'bulk data and index writes stay under the lock');
          assert.equal(values.length, count); assert.equal(values[0].length, width);
          writes.push({ sheet, count });
          values.forEach((v, i) => { data[sheet][row - 2 + i] = Array.from(v); });
        } }),
        getDataRange: () => ({ getValues() { scans.push(sheet); return [headers[sheet], ...data[sheet]]; } }),
        deleteRow(row) { data[sheet].splice(row - 2, 1); }
      };
    }
  });
  ['src/server/LeadService.js', 'src/server/CustomFieldValueService.js', 'src/server/IndexService.js', 'src/BulkService.js'].forEach(file => vm.runInContext(read(file), ctx));
  headers.leads = Array.from(vm.runInContext('LEAD_MASTER_FIELDS', ctx));
  headers.followups = Array.from(vm.runInContext('FOLLOWUP_MASTER_FIELDS', ctx));
  headers.values = ['Value ID','Lead ID','Field ID','Column Key','Field Value','File URL','Updated By','Updated At'];
  ctx.getLeadCustomFieldsForStage = () => fields;
  ctx._bulkCustomFieldsForLeadWrite_ = () => fields;
  ctx._assertLeadAssignedUserAllowed_ = () => {};
  ctx._applyLeadStatusFromStage = payload => { payload['Lead Status'] = 'Open'; };
  ctx._bulkInitialStageId_ = () => 'initial';
  ctx._safeLogBulkImport_ = () => {};
  ctx._bulkLeadIndexRows_ = () => ctx.getAllRows('leadIndex');
  ctx.ensureCustomFieldValueSheets_ = () => {};
  ctx.getBulkConfig = () => ctx._bulkAddRequiredInitialStageFields_(['Company Name','Phone'].map(fieldName => ({ fieldName, targetHeader: fieldName, required: true, dataType: 'Text', validationRule: 'optional', allowedValues: [] })), {});
  return { ctx, data, headers, writes, scans, fields, errors };
}

const row = (n, extra = {}) => ({ 'Company Name': 'Client ' + n, Phone: '900000000' + n, code: 'A', __rowNumber: n, ...extra });

test('filled global fields and blank optional fields both save in bulk with matching followups', () => {
  const { ctx, data, headers, writes, scans } = setup();
  const result = ctx.saveBulkRows([row(1, { note: 'Filled' }), row(2)], 'admin@example.test', 'batch', 'create');
  assert.equal(result.summary.saved, 2);
  assert.equal(result.summary.errors, 0);
  assert.equal(data.leads.length, 2);
  assert.equal(data.followups.length, 2);
  assert.equal(data.values.length, 3, 'two codes and one nonempty note');
  const noteColumn = headers.values.indexOf('Field Value');
  assert.ok(data.values.some(value => value[noteColumn] === 'Filled'));
  assert.equal(writes.filter(write => write.sheet === 'leadIndex').length, 1);
  assert.equal(writes.filter(write => write.sheet === 'fuIndex').length, 1);
  assert.equal(scans.filter(sheet => sheet === 'values').length, 0, 'new leads do not scan all existing custom values');
  assert.equal(scans.filter(sheet => sheet === 'fuIndex').length, 0, 'new followups do not scan the full index');
  const resultIds = result.rowResults.map(r => r.recordId);
  assert.deepEqual(Array.from(data.leadIndex, r => r[0]), Array.from(resultIds));
  assert.deepEqual(data.leadIndex.map(r => r[r.length - 1]), [2, 3]);
  assert.deepEqual(data.fuIndex.map(r => r[1]), Array.from(resultIds));
});

test('bulk validation keeps stage-specific requirements and validates provided global values', () => {
  const { ctx, fields } = setup();
  assert.equal(ctx.validateBulkRows([row(1, { code: '' })], 'create').summary.errors, 1);
  fields[0]['Validation Max'] = 3;
  assert.equal(ctx.validateBulkRows([row(1, { note: 'Too long' })], 'create').summary.errors, 1);
  assert.equal(ctx.validateBulkRows([row(1)], 'create').summary.valid, 1);
  assert.equal(ctx._bulkLeadDomainErrors_({ row: { code: 'A' } }, 'update', { 'Lead ID': 'existing', 'Stage ID': 'initial' }).length, 1);
});

test('a failed batch is rolled back and never silently replayed as individual saves', () => {
  const { ctx, data } = setup();
  let fallbackSaves = 0;
  ctx.saveLead = () => { fallbackSaves++; };
  ctx.failSheet = 'followups';
  assert.throws(() => ctx.saveBulkRows([row(1, { note: 'Filled' })], 'admin@example.test', 'batch', 'create'), error => error.bulkSaveStep === 'saving initial follow-ups and their index');
  assert.equal(fallbackSaves, 0);
  assert.equal(data.leads.length, 0);
  assert.equal(data.leadIndex.length, 0, 'rollback removes index records too');
});

test('duplicate checks remain inside the write lock and reject existing leads', () => {
  const { ctx } = setup();
  assert.equal(ctx.saveBulkRows([row(1)], 'admin@example.test', 'batch1', 'create').summary.saved, 1);
  const result = ctx.saveBulkRows([row(1)], 'admin@example.test', 'batch2', 'create');
  assert.equal(result.summary.saved, 0);
  assert.match(result.rowResults[0].errors, /Duplicate/);
});

test('new custom values skip scans and blank writes; edits can still clear values', () => {
  const { ctx } = setup();
  let scans = 0;
  const inserted = [], updated = [];
  ctx.queryRows = () => { scans++; return [{ 'Value ID': 'value1' }]; };
  ctx.insertRow = (_sheet, row) => inserted.push(row);
  ctx.updateRow = (_sheet, _key, id, row) => updated.push({ id, row });
  ctx.upsertCustomFieldValues_('Leads', 'new-lead', { note: '', code: 'A' }, 'user1', 'initial', { newEntity: true });
  assert.equal(scans, 0); assert.equal(inserted.length, 1);
  ctx.upsertCustomFieldValues_('Leads', 'old-lead', { note: '' }, 'user1', 'initial');
  assert.equal(scans, 1); assert.equal(updated[0].row['Field Value'], '');
});

test('lead core edits never load followups or activity history', () => {
  const { ctx } = setup();
  ctx.getLead = () => { throw Error('Full history should not load on edit'); };
  ctx.getRowByIndexedId_ = () => ({ 'Lead ID': 'existing', 'Stage ID': 'initial', 'Assigned To': 'user1' });
  ctx._canWriteLead = () => true;
  ctx._isLeadPushedToNbd_ = () => false;
  ctx._leadDuplicateMessage_ = () => '';
  ctx.updateRow = () => true;
  const result = ctx.saveLead({ 'Lead ID': 'existing', '__edit_scope': 'core', 'Company Name': 'Changed' });
  assert.equal(result.success, true);
});

test('bulk API exposes a safe failing step and client includes its request reference', () => {
  const source = read('src/server/Api.js');
  const ctx = vm.createContext({
    withRequestContext_: (_op, fn) => fn(), withServerContext_: fn => fn(),
    withTrustedWriteUser_: (_email, fn) => fn(), logServerError_() {},
    errorCodeFrom_: () => 'TIMEOUT',
    respond: (_value, error, code, details) => ({ success: !error, error: 'The request timed out.', code, details, meta: { requestId: 'request-123' } }),
    saveBulkRows() { const error = Error('Service timed out'); error.bulkSaveStep = 'saving additional fields'; throw error; }
  });
  vm.runInContext(source, ctx);
  ctx._requireBulkEntry_ = () => ({ email: 'admin@example.test' });
  const result = ctx.apiSaveBulkRows('token', [row(1)], 'create');
  assert.equal(result.success, false);
  assert.equal(result.details.step, 'saving additional fields');
  const view = read('src/BulkView.html');
  vm.runInContext(view.slice(view.indexOf('  function _bulkSaveErrorMessage('), view.indexOf('  async function saveQueued(')), ctx);
  const message = ctx._bulkSaveErrorMessage({ message: result.error, details: result.details, requestId: result.meta.requestId });
  assert.match(message, /saving additional fields/);
  assert.match(message, /request-123/);
});
