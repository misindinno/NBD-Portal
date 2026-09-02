const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');
const webhook = read('src/server/FsrClientWebhook.js');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('webhook secret stays in Script Properties and deliveries are HMAC signed', () => {
  assert.match(webhook, /getProperty\(FSR_WEBHOOK_SECRET_PROPERTY_\)/);
  assert.match(webhook, /Utilities\.computeHmacSha256Signature\(message, secret\)/);
  assert.match(webhook, /'X-FSR-Timestamp': timestamp/);
  assert.match(webhook, /'X-FSR-Signature': 'sha256=' \+ _fsrWebhookSignature_/);
  assert.doesNotMatch(webhook, /whsec_[A-Za-z0-9_-]+/);
  assert.doesNotMatch(webhook, /fsr-indinno\.vercel\.app/);
});

test('complete lead rows map to the FSR client upsert contract', () => {
  assert.match(webhook, /\n\s*recordId\n/);
  assert.match(webhook, /client: _fsrClientPayloadFromLead_\(row\)/);
  assert.match(webhook, /\n\s*row\n\s*};/);
  assert.match(webhook, /'Client ID': row\['Lead ID'\]/);
  assert.match(webhook, /'Client Name': row\['Company Name'\]/);
  assert.match(webhook, /'Status': row\['Lead Status'\]/);
});

test('sheet edits, form submits, and pasted ranges use installable batched delivery', () => {
  assert.match(webhook, /function handleFsrClientEdit\(event\)/);
  assert.match(webhook, /function handleFsrClientCreate\(event\)/);
  assert.match(webhook, /ScriptApp\.newTrigger\(handler\)\.forSpreadsheet\(spreadsheet\)/);
  assert.match(webhook, /builder\.onEdit\(\)/);
  assert.match(webhook, /builder\.onFormSubmit\(\)/);
  assert.match(webhook, /UrlFetchApp\.fetchAll\(/);
  assert.match(webhook, /FSR_WEBHOOK_BATCH_SIZE_/);
});

test('every lead mutation family emits a best-effort webhook event', () => {
  const lead = read('src/server/LeadService.js');
  const followup = read('src/server/FollowupService.js');
  const archive = read('src/server/ArchiveService.js');
  const bulk = read('src/BulkService.js');
  const nbdPush = read('src/server/NbdPushService.js');
  assert.ok((lead.match(/pushFsrLeadById_\(/g) || []).length >= 5);
  assert.ok((followup.match(/pushFsrLead/g) || []).length >= 3);
  assert.equal((archive.match(/pushFsrLeadById_\(/g) || []).length, 2);
  assert.match(bulk, /pushFsrLeadIds_\(leadIds, 'client\.created'\)/);
  assert.match(nbdPush, /operation\.kind === 'created' \? 'client\.created' : 'client\.updated'/);
});

test('webhook failures are diagnostic, redacted, and never fail lead saves', () => {
  const diagnostics = read('src/server/DebugService.js');
  assert.match(webhook, /diagnosticLog_\('WARN', 'INTEGRATION\.FSR_WEBHOOK'/);
  assert.match(diagnostics, /fsrWebhookUrl: !!properties\.getProperty\('FSR_WEBHOOK_URL'\)/);
  assert.match(diagnostics, /fsrWebhookSecret: !!properties\.getProperty\('FSR_WEBHOOK_SECRET'\)/);
  assert.match(diagnostics, /status\.configured && status\.editTriggerInstalled/);
  assert.doesNotMatch(webhook, /getContentText\(/);
});

test('webhook configuration and trigger management require container admin', () => {
  assert.match(webhook, /function setFsrClientWebhookProperties\([^)]*\) \{\s*requireContainerAdmin_\(false\)/);
  assert.match(webhook, /function installFsrClientEditTrigger\(\) \{\s*requireContainerAdmin_\(false\)/);
  assert.match(webhook, /function installFsrClientCreateTrigger\(\) \{\s*requireContainerAdmin_\(false\)/);
  assert.match(webhook, /function getFsrClientWebhookStatus\(\) \{\s*requireContainerAdmin_\(false\)/);
  assert.match(read('src/server/DebugService.js'), /const status = _fsrClientWebhookStatus_\(\)/);
});

test('signature implementation matches HMAC SHA-256', () => {
  const context = {
    console,
    Set,
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => '' }) },
    Utilities: {
      computeHmacSha256Signature(message, secret) {
        return Array.from(crypto.createHmac('sha256', secret).update(message).digest())
          .map(value => value > 127 ? value - 256 : value);
      }
    }
  };
  vm.createContext(context);
  vm.runInContext(webhook, context, { filename: 'FsrClientWebhook.js' });
  const expected = crypto.createHmac('sha256', 'secret').update('123.body').digest('hex');
  assert.equal(context._fsrWebhookSignature_('secret', '123.body'), expected);
  assert.deepEqual(
    JSON.parse(JSON.stringify(context._fsrClientPayloadFromLead_({
      'Lead ID': 'lead-1',
      'Company Name': 'Acme',
      'Contact Person': 'Asha',
      Phone: '9999999999',
      Address: 'Road 1',
      City: 'Delhi',
      State: 'Delhi',
      'Lead Status': 'Open',
      'Assigned To': 'sales-1'
    }))),
    {
      'Client ID': 'lead-1',
      'Client Name': 'Acme',
      'Contact Person': 'Asha',
      Phone: '9999999999',
      Address: 'Road 1',
      City: 'Delhi',
      State: 'Delhi',
      Status: 'Open',
      'Assigned To': 'sales-1'
    }
  );
});

let failures = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    console.log('PASS ' + name);
  } catch (error) {
    failures++;
    console.error('FAIL ' + name);
    console.error(error && error.stack || error);
  }
}

console.log('\n' + (tests.length - failures) + '/' + tests.length + ' FSR webhook contract tests passed.');
if (failures) process.exitCode = 1;
