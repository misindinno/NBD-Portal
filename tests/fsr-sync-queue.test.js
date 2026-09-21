'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function setup() {
  const rows = [];
  let locked = false, triggerCount = 0, sends = 0, fail = false;
  const queue = {
    getLastRow: () => rows.length,
    getRange(r, c, nr, nc) {
      return {
        getValues: () => Array.from({ length: nr }, (_, i) => rows[r - 1 + i].slice(c - 1, c - 1 + nc)),
        setValues(values) { values.forEach((value, i) => { const target = r - 1 + i; if (!rows[target]) rows[target] = []; value.forEach((cell, j) => rows[target][c - 1 + j] = cell); }); }
      };
    },
    deleteRows(r, count) { rows.splice(r - 1, count); }
  };
  const lock = { tryLock() { if (locked) return false; locked = true; return true; }, waitLock() { if (locked) throw Error('Lock held during webhook send'); locked = true; }, releaseLock() { locked = false; } };
  const ctx = vm.createContext({
    SHEET_NAMES: { LEADS: 'LEADS' },
    withServerContext_: f => f(), assertServerContext_() {},
    safeInitHeaders() { if (!rows.length) rows.push(['Queue ID','Lead IDs','Event Type','Status','Attempts','Created At','Updated At','Last Error']); },
    getSheet: name => name === 'FSR_SYNC_QUEUE' ? queue : { getName: () => 'LEADS' },
    getSpreadsheet: () => ({ getSheetByName: name => name === 'FSR_SYNC_QUEUE' ? queue : null }),
    LockService: { getScriptLock: () => lock },
    ScriptApp: { getProjectTriggers: () => triggerCount ? [{ getHandlerFunction: () => 'processFsrSyncQueue_' }] : [], newTrigger: () => ({ timeBased() { return this; }, everyMinutes() { return this; }, create() { triggerCount++; } }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: key => key === 'FSR_WEBHOOK_URL' ? 'https://example.test' : key === 'FSR_WEBHOOK_SECRET' ? 'secret' : '' }) },
    Utilities: { getUuid: () => 'id-' + rows.length },
    SpreadsheetApp: { flush() {} },
    now: () => '2026-09-21 12:00:00',
    diagnosticErrorSummary_: e => e.message,
    diagnosticLog_() {}, Logger: { log() {} }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../src/server/FsrClientWebhook.js'),'utf8'), ctx);
  ctx._fsrLeadRowNumbersById_ = (_, wanted) => Object.keys(wanted).map((_,i) => i + 2);
  ctx._pushFsrLeadRows_ = found => { assert.equal(locked, false); sends++; return found.map(() => fail ? { status: 503 } : { status: 200 }); };
  return { ctx, rows, sends: () => sends, setFail: value => { fail = value; }, triggers: () => triggerCount, locked: () => locked };
}

test('save queues FSR sync without waiting for HTTP and worker releases lock before delivery', () => {
  const h = setup();
  const result = h.ctx.pushFsrLeadIds_(['lead-1','lead-2'], 'client.created');
  assert.equal(result[0].queued, true);
  assert.equal(h.sends(), 0);
  assert.equal(h.triggers(), 1);
  h.ctx.processFsrSyncQueue_();
  assert.equal(h.sends(), 1);
  assert.equal(h.rows[1][3], 'Done');
  assert.equal(h.locked(), false);
});

test('failed delivery remains queued and retries on later worker runs', () => {
  const h = setup(); h.ctx.pushFsrLeadById_('lead-1','client.updated'); h.setFail(true);
  h.ctx.processFsrSyncQueue_();
  assert.equal(h.rows[1][3], 'Pending'); assert.equal(h.rows[1][4], 1); assert.equal(h.sends(), 1);
  h.setFail(false); h.ctx.processFsrSyncQueue_();
  assert.equal(h.rows[1][3], 'Done'); assert.equal(h.rows[1][4], 1);
});
