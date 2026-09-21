/* eslint-disable no-console */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('Bulk Entry grant authorizes a regular user only for bulk APIs', () => {
  const ctx = vm.createContext({});
  vm.runInContext(read('src/server/AuthService.js'), ctx);
  vm.runInContext(read('src/server/Api.js'), ctx);
  const user = { id: 'u1', role: 'USER', email: 'staff@example.test', modules: ['BulkEntry'] };
  ctx._apiUser = () => user;
  ctx.getCurrentUserByEmail_ = () => ({ success: true, data: user });
  assert.equal(ctx._requireBulkEntry_(), user);
  assert.throws(() => ctx.requireBulkEntryWriter_(), /Direct write calls/);
  vm.runInContext("TRUSTED_WRITE_EMAIL = 'staff@example.test'", ctx);
  assert.equal(ctx.requireBulkEntryWriter_(), user);
  assert.throws(() => ctx.requireRole(['ADMIN','MANAGER','SALES']), /Permission denied/);
  user.modules = ['Followups'];
  assert.throws(() => ctx._requireBulkEntry_(), /Permission denied/);
  assert.throws(() => ctx.requireBulkEntryWriter_(), /Permission denied/);
});

test('Bulk Entry appears in every portal user editor and uses smaller save requests', () => {
  for (const file of ['src/ConfigUserHelpers.html','src/ConfigUsers.html']) {
    const source = read(file);
    assert.match(source, /'BulkEntry'/);
    assert.doesNotMatch(source, /isLq.*['BulkEntry']/);
  }
  assert.match(read('src/BulkView.html'), /BULK_CHUNK_SIZE = 10/);
  assert.ok(read('src/AppUI.html').includes("const canUseBulkEntry = show('BulkEntry');"));
  assert.doesNotMatch(read('src/Diagnostics.html'), /watchdogMs|startWatchdog/);
});
