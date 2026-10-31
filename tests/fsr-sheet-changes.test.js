'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
function harness() {
  const jobs = [], triggers = [];
  const props = { FSR_WEBHOOK_URL: 'https://fsr.example/api/webhooks/clients/cs-portal', FSR_WEBHOOK_SECRET: 'test', FSR_CLIENT_SHEET: 'LEAD_MASTER' };
  const data = [['Lead ID', 'Company Name'], ['001', 'First'], ['002', 'Second']];
  const sheet = { getName: () => 'LEAD_MASTER', getParent: () => ({ getId: () => 'book' }), getLastRow: () => data.length, getLastColumn: () => 2,
    getRange: (r,c,nr,nc) => ({ getValues: () => data.slice(r-1,r-1+nr).map(row => row.slice(c-1,c-1+nc)) }) };
  const ctx = vm.createContext({ CLIENT_CONFIG: { SPREADSHEET_ID: 'book' }, SHEET_NAMES: { LEADS: 'LEAD_MASTER' },
    withServerContext_: fn => fn(), requireContainerAdmin_: () => {},
    PropertiesService: { getScriptProperties: () => ({ getProperty: key => props[key] }) },
    SpreadsheetApp: { openById: () => ({}) },
    ScriptApp: { EventType: { ON_EDIT: 'edit', ON_FORM_SUBMIT: 'form' }, getProjectTriggers: () => triggers,
      deleteTrigger: trigger => triggers.splice(triggers.indexOf(trigger),1),
      newTrigger: handler => { const builder = { forSpreadsheet: () => builder, onEdit: () => builder, onFormSubmit: () => builder, timeBased: () => builder, everyMinutes: () => builder, create: () => triggers.push({ getHandlerFunction: () => handler }) }; return builder; } },
    diagnosticErrorSummary_: e => e.message, diagnosticLog_: () => {}, Logger: { log() {} }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../src/server/FsrClientWebhook.js'),'utf8'),ctx);
  ctx.pushFsrLeadIds_ = (ids,event) => { jobs.push({ ids: Array.from(ids), event }); return [{ queued: true }]; };
  const range = { getSheet: () => sheet, getRow: () => 1, getLastRow: () => 3 };
  return { ctx, sheet, range, jobs, props, triggers };
}
test('pasted edits and form submissions enqueue every affected lead without sending HTTP', () => {
  const h = harness();
  h.ctx.handleFsrClientEdit({ range: h.range });
  h.ctx.handleFsrClientCreate({ range: h.range });
  assert.deepEqual(h.jobs, [{ ids: ['001','002'], event: 'client.updated' }, { ids: ['001','002'], event: 'client.created' }]);
});
test('unrelated sheets, workbooks, missing events and header-only edits do not queue clients', () => {
  const h = harness();
  h.ctx.handleFsrClientEdit();
  h.ctx.handleFsrClientEdit({ range: { ...h.range, getLastRow: () => 1 } });
  h.sheet.getName = () => 'FOLLOWUPS'; h.ctx.handleFsrClientEdit({ range: h.range });
  h.sheet.getName = () => 'LEAD_MASTER'; h.sheet.getParent = () => ({getId: () => 'other-book'}); h.ctx.handleFsrClientEdit({ range: h.range });
  assert.equal(h.jobs.length,0);
});
test('trigger installation is repeatable and includes the delivery worker', () => {
  const h = harness(); h.ctx.installFsrClientTriggers(); h.ctx.installFsrClientTriggers();
  assert.equal(h.triggers.length,3);
  assert.equal(h.ctx.getFsrClientWebhookStatus().workerInstalled,true);
  delete h.props.FSR_WEBHOOK_SECRET;
  assert.throws(() => h.ctx.installFsrClientTriggers(), /Configure/);
});
