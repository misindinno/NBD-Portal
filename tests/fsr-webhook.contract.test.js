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

test('webhook requests use all required headers and the v1 HMAC contract', () => {
  assert.match(webhook, /getProperty\(FSR_WEBHOOK_SECRET_PROPERTY_\)/);
  assert.match(webhook, /Utilities\.computeHmacSha256Signature\(message, secret, Utilities\.Charset\.UTF_8\)/);
  assert.match(webhook, /Math\.floor\(Date\.now\(\) \/ 1000\)/);
  assert.match(webhook, /'X-FSR-Event-Id': delivery\.eventId/);
  assert.match(webhook, /'X-FSR-Timestamp': timestamp/);
  assert.match(webhook, /'X-FSR-Signature': 'v1=' \+ _fsrWebhookSignature_\(config\.secret, timestamp \+ '\.' \+ delivery\.body\)/);
  assert.match(webhook, /'X-Request-Id': delivery\.requestId/);
  assert.doesNotMatch(webhook, /whsec_[A-Za-z0-9_-]+/);
  assert.doesNotMatch(webhook, /fsr-indinno\.vercel\.app/);
});

test('complete lead rows map to the canonical FSR client envelope', () => {
  assert.match(webhook, /schemaVersion: '1\.0'/);
  assert.match(webhook, /eventType: normalizedEvent/);
  assert.match(webhook, /occurredAt: new Date\(\)\.toISOString\(\)/);
  assert.match(webhook, /source: \{\s*recordId,\s*clientId: recordId/);
  assert.match(webhook, /data\s*\n\s*};/);
  assert.match(webhook, /name: _fsrLeadValue_\(row, \['Company Name'/);
  assert.match(webhook, /phone: _fsrLeadValue_\(row, \['Primary Mobile'/);
  assert.match(webhook, /leadSource: _fsrLeadValue_\(row, \['Source'/);
  assert.match(webhook, /assignedTo: _fsrLeadValue_\(row, \['Assigned User ID'/);
});

test('sheet edits, form submits, and pasted ranges use installable batched delivery', () => {
  const menu = read('src/server/Code.js');
  assert.match(webhook, /function handleFsrClientEdit\(event\)/);
  assert.match(webhook, /function handleFsrClientCreate\(event\)/);
  assert.match(menu, /addItem\('[^']*Install FSR Create \+ Update Triggers', 'installFsrClientTriggers'\)/);
  assert.match(webhook, /ScriptApp\.newTrigger\(handler\)\.forSpreadsheet\(spreadsheet\)/);
  assert.match(webhook, /builder\.onEdit\(\)/);
  assert.match(webhook, /builder\.onFormSubmit\(\)/);
  assert.match(webhook, /UrlFetchApp\.fetchAll\(/);
  assert.match(webhook, /FSR_WEBHOOK_BATCH_SIZE_/);
  assert.match(webhook, /FSR_WEBHOOK_MAX_ATTEMPTS_ = 3/);
  assert.match(webhook, /status === 429 \|\| status === 500 \|\| status === 503/);
  assert.match(webhook, /Utilities\.sleep\(FSR_WEBHOOK_RETRY_BASE_MS_/);
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

test('webhook responses and failures are diagnostic, bounded, and never fail lead saves', () => {
  const diagnostics = read('src/server/DebugService.js');
  assert.match(webhook, /'delivery_response'/);
  assert.match(webhook, /response\.getContentText\(\)/);
  assert.match(webhook, /text\.slice\(0, FSR_WEBHOOK_RESPONSE_LOG_LIMIT_\)/);
  assert.match(webhook, /eventId: delivery\.eventId/);
  assert.match(webhook, /requestId: delivery\.requestId/);
  assert.match(webhook, /sourceRecordId: delivery\.recordId/);
  assert.match(webhook, /diagnosticLog_\('WARN', 'INTEGRATION\.FSR_WEBHOOK'/);
  assert.match(diagnostics, /fsrWebhookUrl: !!properties\.getProperty\('FSR_WEBHOOK_URL'\)/);
  assert.match(diagnostics, /fsrWebhookSecret: !!properties\.getProperty\('FSR_WEBHOOK_SECRET'\)/);
  assert.match(diagnostics, /status\.configured && status\.editTriggerInstalled/);
  assert.match(diagnostics, /function sanitizeDiagnosticValue_\(/);
});

test('webhook configuration and trigger management require container admin', () => {
  assert.match(webhook, /function setFsrClientWebhookProperties\([^)]*\) \{\s*return withServerContext_\(\(\) => \{\s*requireContainerAdmin_\(false\)/);
  assert.match(webhook, /function installFsrClientTriggers\(\) \{\s*return withServerContext_\(\(\) => \{\s*requireContainerAdmin_\(false\)/);
  assert.match(webhook, /function installFsrClientEditTrigger\(\) \{\s*return withServerContext_\(\(\) => \{\s*requireContainerAdmin_\(false\)/);
  assert.match(webhook, /function installFsrClientCreateTrigger\(\) \{\s*return withServerContext_\(\(\) => \{\s*requireContainerAdmin_\(false\)/);
  assert.match(webhook, /function getFsrClientWebhookStatus\(\) \{\s*return withServerContext_\(\(\) => \{\s*requireContainerAdmin_\(false\)/);
  assert.match(webhook, /function pushFsrCreatedRow\([^)]*\) \{\s*return withServerContext_\(\(\) => \{\s*requireContainerAdmin_\(false\)/);
  assert.match(read('src/server/DebugService.js'), /const status = _fsrClientWebhookStatus_\(\)/);
});

test('signature implementation matches HMAC SHA-256', () => {
  const context = {
    console,
    Set,
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => '' }) },
    Utilities: {
      Charset: { UTF_8: 'UTF-8' },
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
  const delivery = {
    body: '{"eventType":"client.updated"}',
    eventId: 'evt_fixed',
    requestId: 'req_fixed'
  };
  const request = context._fsrRequestForAttempt_(delivery, { url: 'https://example.test/webhook', secret: 'secret' });
  assert.equal(request.payload, delivery.body);
  assert.equal(request.headers['X-FSR-Event-Id'], 'evt_fixed');
  assert.equal(request.headers['X-Request-Id'], 'req_fixed');
  assert.match(request.headers['X-FSR-Signature'], /^v1=[a-f0-9]{64}$/);
  assert.equal(
    request.headers['X-FSR-Signature'],
    'v1=' + crypto.createHmac('sha256', 'secret')
      .update(request.headers['X-FSR-Timestamp'] + '.' + delivery.body)
      .digest('hex')
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(context._fsrClientDataFromLead_({
      'Company Name': 'Acme',
      'Contact Person': 'Asha',
      'Primary Mobile': '9999999999',
      Address: 'Road 1',
      City: 'Delhi',
      State: 'Delhi',
      Source: 'Referral',
      'Lead Status': 'Open',
      'Assigned User ID': 'sales-1'
    }))),
    {
      name: 'Acme',
      contact: 'Asha',
      phone: '9999999999',
      address: 'Road 1',
      city: 'Delhi',
      state: 'Delhi',
      leadSource: 'Referral',
      status: 'Open',
      assignedTo: 'sales-1'
    }
  );
});

test('retry preserves event identity and body while refreshing timestamp and signature', () => {
  let now = 1788344107000;
  let callCount = 0;
  const requests = [];
  const sleeps = [];
  class FakeDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const retryContext = {
    console,
    Set,
    Date: FakeDate,
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => '' }) },
    Utilities: {
      Charset: { UTF_8: 'UTF-8' },
      computeHmacSha256Signature(message, secret) {
        return Array.from(crypto.createHmac('sha256', secret).update(message).digest())
          .map(value => value > 127 ? value - 256 : value);
      },
      sleep(milliseconds) {
        sleeps.push(milliseconds);
        now += milliseconds;
      }
    },
    UrlFetchApp: {
      fetchAll(batch) {
        requests.push(batch[0]);
        callCount++;
        const status = callCount === 1 ? 503 : 200;
        return [{
          getResponseCode: () => status,
          getContentText: () => JSON.stringify({
            data: { success: status === 200, code: status === 200 ? 'WEBHOOK_PROCESSED' : 'TEMPORARY_FAILURE' }
          })
        }];
      }
    },
    diagnosticLog_() {},
    diagnosticErrorSummary_: () => 'An external integration failed.',
    Logger: { log() {} }
  };
  vm.createContext(retryContext);
  vm.runInContext(webhook, retryContext, { filename: 'FsrClientWebhook.js' });
  const delivery = {
    body: '{"schemaVersion":"1.0","eventType":"client.updated"}',
    event: 'client.updated',
    eventId: 'evt_stable',
    requestId: 'req_stable',
    recordId: 'lead-1',
    rowNumber: 2
  };
  const results = retryContext._fsrPostDeliveryBatch_([delivery], {
    url: 'https://example.test/webhook',
    secret: 'secret'
  });

  assert.equal(requests.length, 2);
  assert.equal(results[0].status, 200);
  assert.equal(results[0].attempt, 2);
  assert.deepEqual(sleeps, [1000]);
  assert.equal(requests[0].payload, delivery.body);
  assert.equal(requests[1].payload, delivery.body);
  assert.equal(requests[0].headers['X-FSR-Event-Id'], delivery.eventId);
  assert.equal(requests[1].headers['X-FSR-Event-Id'], delivery.eventId);
  assert.equal(requests[0].headers['X-Request-Id'], delivery.requestId);
  assert.equal(requests[1].headers['X-Request-Id'], delivery.requestId);
  assert.notEqual(requests[0].headers['X-FSR-Timestamp'], requests[1].headers['X-FSR-Timestamp']);
  assert.notEqual(requests[0].headers['X-FSR-Signature'], requests[1].headers['X-FSR-Signature']);
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
