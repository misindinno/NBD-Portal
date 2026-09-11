const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { test } = require('node:test');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const UID = 'C6F91250-022A-4162-9196-44866796D14C';
function harness(options = {}) {
  const sheets = new Map();
  const props = new Map([['CALLYZER_WEBHOOK_ENABLED', options.disabled ? 'false' : 'true']]);
  let locked = false, mutations = 0, failAfter = options.failAfter;
  const stamps = [];
  function sheet(name) {
    if (sheets.has(name)) return sheets.get(name);
    const rows = [];
    const value = {
      rows, getLastRow: () => rows.length,
      getRange: (r, c, h = 1, w = 1) => ({
        setNumberFormat() { return this; },
        getValues: () => Array.from({ length: h }, (_, i) => Array.from({ length: w }, (_, j) => rows[r - 1 + i]?.[c - 1 + j] ?? '')),
        setValues: data => {
          assert.ok(locked, 'writes must hold one script lock');
          if (name === 'HISTORY' && r > 1 && failAfter === mutations++) { failAfter = undefined; throw Error('write interrupted'); }
          data.forEach((row, i) => { rows[r - 1 + i] ||= []; row.forEach((v, j) => { rows[r - 1 + i][c - 1 + j] = v; }); });
        },
      }),
      getDataRange: () => ({ getValues: () => rows.map(row => row.slice()) }),
      deleteRows: (start, count) => rows.splice(start - 1, count),
    };
    sheets.set(name, value); return value;
  }
  const headers = ['History ID','Follow-up ID','Lead ID','Planned Date','Done Date','Done By','Follow-up Type','Contact Mode','Remark','Outcome','Next Planned Date','Stage ID','Created At'];
  const leads = options.leads || [{ 'Lead ID': 'L1', Phone: '9876543210', 'Stage ID': 'S1', 'Assigned To': UID }];
  const users = options.users || [{ ID: UID, Name: 'Portal User' }];
  const context = vm.createContext({
    console, Map, Set, Date, JSON, URL, Utilities: { getUuid: () => "test-request" },
    CLIENT_CONFIG: {}, SHEET_NAMES: { LEADS: 'LEADS', FOLLOWUP_HISTORY: 'HISTORY' },
    normalizeSheetName: x => x,
    assertServerContext_: () => {},
    withServerContext_: fn => fn(), withRequestContext_: (name, fn) => fn(),
    PropertiesService: { getScriptProperties: () => ({ getProperty: key => props.get(key), setProperty: (key, value) => props.set(key, value) }) },
    ScriptApp: { getService: () => ({ getUrl: () => 'https://script.google.com/macros/s/deployment/exec' }) },
    Session: { getScriptTimeZone: () => 'Asia/Kolkata' },
    LockService: { getScriptLock: () => ({ waitLock() { assert.ok(!locked); locked = true; }, tryLock() { if (options.busy) return false; assert.ok(!locked); locked = true; return true; }, releaseLock() { locked = false; } }) },
    now: () => '2026-09-10 12:00:00',
    getSheet: sheet, getSpreadsheet: () => ({ getSheetByName: name => sheets.get(name) }),
    getHeaders: name => sheet(name).rows[0],
    safeInitHeaders: (name, wanted) => {
      const rows = sheet(name).rows; if (!rows.length) rows.push([]);
      wanted.forEach(h => { if (!rows[0].includes(h)) rows[0].push(h); });
    },
    ensureFollowupSheets_: () => context.safeInitHeaders('HISTORY', headers),
    getAllRows: name => { assert.equal(name, 'LEADS'); return leads; },
    getUsersWithPortalAccess_: () => users,
    rowObjectFromHeaders_: (heads, row) => Object.fromEntries(heads.map((h, i) => [h, row[i] ?? ''])),
    SpreadsheetApp: { flush: () => {} }, _invalidateReadCache_: () => {}, _bumpStamp: key => stamps.push(key),
    requireConfigEditor: () => { if (options.forbid) throw Error('Permission denied'); },
    logServerError_: () => {},
    HtmlService: { createHtmlOutput: body => ({ html: body }) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: body => ({ body, setMimeType() { return this; } }) },
  });
  vm.runInContext(read('src/server/ArchitectureCore.js'), context);
  vm.runInContext(read('src/server/CallWebhookService.js'), context);
  vm.runInContext(read('src/server/Code.js'), context);
  function payload(calls, tags = [UID]) { return JSON.stringify([{ emp_name: 'Untrusted employee label', emp_tags: tags, call_logs: calls }]); }
  const send = (calls, tags) => JSON.parse(context.doPost({ parameter: { webhook: 'callyzer', format: 'json' }, postData: { contents: payload(calls, tags) } }).body);
  const history = () => (sheets.get('HISTORY')?.rows.slice(1) || []).map(row => Object.fromEntries(sheet('HISTORY').rows[0].map((h, i) => [h, row[i] ?? ''])));
  return { context, send, history, sheets, props, stamps, leads, locked: () => locked };
}
const call = changes => ({ id: 'call-001', client_country_code: '91', client_number: '9876543210', call_date: '2026-09-09', call_time: '17:49:41', duration: '30', call_type: 'Outgoing', note: 'Send quotation', crm_status: 'Interested', call_recording_url: 'https://media1.callyzer.co/recording.mp3', modified_at: '2026-09-09 17:52:00', call_method: 'PhoneCall', call_mode: 'Voice', ...changes });

test('unsigned POST adds call remarks, real user ID, time and recording without changing lead workflow', () => {
  const h = harness(); const before = JSON.stringify(h.leads);
  const result = h.send([call()]);
  assert.equal(result.added, 1); assert.equal(result.success, true);
  const row = h.history()[0];
  assert.equal(row['Done By'], UID); assert.equal(row['Lead ID'], 'L1');
  assert.match(row.Remark, /Send quotation/); assert.match(row.Remark, /Call result: Interested/);
  assert.equal(row['Call Time'], '17:49:41'); assert.equal(row['Call Duration Seconds'], 30);
  assert.equal(row['Call Recording URL'], 'https://media1.callyzer.co/recording.mp3');
  assert.equal(JSON.stringify(h.leads), before); assert.ok(h.stamps.includes('followup_history'));
  assert.equal('issues' in result, false); assert.equal(JSON.stringify(result).includes('L1'), false);
  assert.equal(h.locked(), false);
});

test('plain, lower-case and id= employee tags resolve user IDs; unrelated tags are ignored', () => {
  for (const tag of [UID, UID.toLowerCase(), 'id=' + UID]) {
    const h = harness(); assert.equal(h.send([call()], ['Sales', tag]).added, 1); assert.equal(h.history()[0]['Done By'], UID);
  }
});

test('missing, inactive/unknown and multiple user tags are reported without attaching calls', () => {
  for (const tags of [[], ['unknown'], [UID, 'user-2']]) {
    const h = harness({ users: [{ ID: UID }, { ID: 'user-2' }] });
    assert.equal(h.send([call()], tags).invalidUser, 1); assert.equal(h.history().length, 0);
  }
  const h = harness({ users: [] }); assert.equal(h.send([call()]).invalidUser, 1);
});

test('retries and older events do not duplicate or overwrite, newer events update the same entry', () => {
  const h = harness(); assert.equal(h.send([call(), call()]).duplicate, 1);
  assert.equal(h.send([call()]).duplicate, 1);
  assert.equal(h.send([call({ modified_at: '2026-09-09 17:53:00', note: 'Updated note', duration: '87' })]).updated, 1);
  assert.equal(h.send([call()]).duplicate, 1); assert.equal(h.history().length, 1);
  assert.match(h.history()[0].Remark, /Updated note/); assert.equal(h.history()[0]['Call Duration Seconds'], 87);
});

test('international and alternate phone formats match; shared numbers and archived leads are skipped', () => {
  const h = harness({ leads: [{ 'Lead ID': 'L1', Phone: '1234567890', 'Alternate No': '+91 (98765) 43210' }] });
  assert.equal(h.send([call({ client_number: '00919876543210' })]).added, 1);
  for (const leads of [[], [{ 'Lead ID': 'L1', Phone: '9876543210', 'Is Archived': true }], [{ 'Lead ID': 'L1', Phone: '9876543210' }, { 'Lead ID': 'L2', Phone: '9876543210' }]]) {
    const x = harness({ leads }); const r = x.send([call()]); assert.equal(r.unmatched + r.ambiguous, 1); assert.equal(x.history().length, 0);
  }
});

test('a call ID cannot be reassigned to a different lead or user on a later delivery', () => {
  const h = harness({ users: [{ ID: UID }, { ID: 'user-2' }] }); h.send([call()]);
  assert.equal(h.send([call({ modified_at: '2026-09-09 17:54:00' })], ['user-2']).ambiguous, 1);
  h.leads[0]['Lead ID'] = 'L2';
  assert.equal(h.send([call({ modified_at: '2026-09-09 17:55:00' })]).ambiguous, 1);
  assert.equal(h.history()[0]['Lead ID'], 'L1');
});

test('mixed batches isolate invalid records, including malformed calendar dates and durations', () => {
  const h = harness();
  const result = h.send([call(), call({ id: 'bad', call_date: '2026-02-30' }), call({ id: 'bad2', duration: '-1' }), null]);
  assert.equal(result.added, 1); assert.equal(result.invalid, 3);
});

test('unsafe recording URLs are removed and remarks are stored as text', () => {
  const h = harness(); h.send([call({ note: '=IMPORTXML("https://example.com")', call_recording_url: 'javascript:alert(1)' })]);
  assert.equal(h.history()[0]['Call Recording URL'], ''); assert.ok(h.history()[0].Remark.startsWith("'="));
  for (const url of ['http://example.com/a', 'https://user:pass@example.com/a', 'https://example.com/"bad', 'https://example.com\\evil']) assert.equal(h.context._callRecordingUrl_(url), '');
});

test('disabled, oversized, malformed, unknown and busy requests have explicit failure responses', () => {
  assert.equal(harness({ disabled: true }).send([call()]).code, 'WEBHOOK_DISABLED');
  assert.equal(harness({ busy: true }).send([call()]).code, 'BUSY');
  const h = harness();
  assert.equal(h.context._receiveCallyzer_('x'.repeat(1000001)).code, 'PAYLOAD_TOO_LARGE');
  assert.equal(h.context._receiveCallyzer_('{').code, 'INVALID_PAYLOAD');
  assert.equal(h.context._receiveCallyzer_('{}').code, 'INVALID_PAYLOAD');
  assert.equal(h.send(Array.from({ length: 201 }, () => call())).code, 'BATCH_LIMIT');
  assert.equal(JSON.parse(h.context.doPost({ parameter: { webhook: 'unknown', format: 'json' } }).body).code, 'UNKNOWN_WEBHOOK');
  assert.equal(h.history().length, 0);
});

test('partial write failure is retriable and replay adds only the missing record', () => {
  const h = harness({ failAfter: 1 });
  const calls = [call(), call({ id: 'call-2' })];
  assert.equal(h.send(calls).code, 'PROCESSING_FAILED'); assert.equal(h.history().length, 1);
  assert.equal(h.locked(), false);
  const retry = h.send(calls); assert.equal(retry.duplicate, 1); assert.equal(retry.added, 1); assert.equal(h.history().length, 2);
});

test('management persists enable/pause and returns only bounded delivery history and user labels', () => {
  const h = harness({ disabled: true });
  h.context._saveCallWebhook_({ enabled: true });
  for (let i = 0; i < 105; i++) h.send([call()]);
  const page = h.context._callWebhookPage_();
  assert.equal(page.deliveries.length, 30); assert.equal(h.sheets.get('CALL_WEBHOOK_DELIVERIES').getLastRow(), 101);
  assert.ok(page.url.endsWith('?webhook=callyzer')); assert.equal(page.users[0].id, UID);
  h.context._saveCallWebhook_({ enabled: false }); assert.equal(h.send([call()]).code, 'WEBHOOK_DISABLED');
  assert.throws(() => harness({ forbid: true }).context._saveCallWebhook_({ enabled: true }), /Permission denied/);
  assert.throws(() => h.context._saveCallWebhook_({ enabled: 'false' }), /boolean/);
});

test('call remark rendering escapes HTML, preserves normal remarks, and links only HTTPS recordings', () => {
  const escapeHtml = value => String(value ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
  const ctx = vm.createContext({ URL, escapeHtml });
  vm.runInContext(read('src/Webhooks.html').replace(/^<script>/, '').replace(/<\/script>\s*$/, ''), ctx);
  const normal = ctx._callRemarkHtml({ Remark: 'Normal remark' }); assert.match(normal, /Normal remark/); assert.doesNotMatch(normal, /Call recording/);
  const html = ctx._callRemarkHtml({ 'Call ID': 'call1', Remark: '<img onerror=alert(1)>', 'Call Duration Seconds': 87, 'Call Recording URL': 'https://example.com/call.mp3' });
  assert.match(html, /1m 27s/); assert.match(html, /Call recording/); assert.match(html, /noopener noreferrer/); assert.doesNotMatch(html, /<img/);
  assert.doesNotMatch(ctx._callRemarkHtml({ 'Call ID': 'x', 'Call Recording URL': 'javascript:alert(1)' }), /href=/);
});

test('webhook management API requires authenticated configuration permission', () => {
  const ctx = vm.createContext({}); vm.runInContext(read('src/server/Api.js'), ctx);
  ctx.apiGuard_ = (name, fn) => fn(); ctx._requireConfigReader = () => { throw Error('Permission denied'); };
  assert.throws(() => ctx.apiGetCallWebhook('bad'), /Permission denied/);
  assert.throws(() => ctx.apiSaveCallWebhook('bad', { enabled: true }), /Permission denied/);
  const ui = vm.createContext({ window: { loadConfig() {} }, App: { user: { modules: [], canManageUsers: true } } });
  vm.runInContext(read('src/AppUI.html').replace(/^<script>/, '').replace(/<\/script>\s*$/, ''), ui);
  assert.equal(ui.canNavigate('webhooks'), false); ui.App.user.canEditConfig = true; assert.equal(ui.canNavigate('webhooks'), true);
});

test('Callyzer receives a direct HTML acknowledgement from bare and named POST URLs', () => {
  for (const parameter of [{}, { webhook: 'callyzer' }]) {
    const h = harness();
    const result = h.context.doPost({ parameter, postData: { contents: JSON.stringify([{ emp_tags: [UID], call_logs: [call()] }]) } });
    assert.match(result.html, /^<pre>/);
    assert.match(result.html, /&quot;added&quot;:1/);
    assert.equal(result.body, undefined, 'default response must not use the redirecting ContentService');
    assert.equal(h.history().length, 1);
  }
});

test('direct acknowledgements preserve failure receipts without exposing HTML from payloads', () => {
  const h = harness({ disabled: true });
  assert.match(h.context.doPost({ parameter: {}, postData: { contents: '[]' } }).html, /WEBHOOK_DISABLED/);
  assert.match(h.context.doPost({ parameter: { webhook: '<script>bad</script>' } }).html, /UNKNOWN_WEBHOOK/);
  assert.equal(h.history().length, 0);
});

test('debug logs preserve received employee tags and the exact response without exposing payloads publicly', () => {
  const h = harness();
  const response = h.send([call()], null);
  assert.equal(response.invalidUser, 1);
  const page = h.context._callWebhookPage_();
  const entry = page.deliveries[0];
  assert.equal(entry.requestPayload, undefined);
  const detail = h.context._callWebhookDelivery_(entry.deliveryId);
  assert.equal(JSON.parse(detail.requestPayload)[0].emp_tags, null);
  assert.equal(JSON.parse(detail.requestPayload)[0].call_logs[0].id, 'call-001');
  assert.deepEqual(JSON.parse(detail.responseBody), response);
  assert.ok(detail.processingMs >= 0);
  assert.equal(detail.payloadTruncated, false);
  for (const key of ['requestPayload','responseBody','deliveryId','issues']) assert.equal(key in response, false);
});

test('debug payload size is bounded without truncating the saved call remark', () => {
  const h = harness();
  h.send([call({ extra: 'x'.repeat(40000) })]);
  const entry = h.context._callWebhookPage_().deliveries[0];
  const detail = h.context._callWebhookDelivery_(entry.deliveryId);
  assert.equal(detail.requestPayload.length, 30000);
  assert.equal(detail.payloadTruncated, true);
  assert.ok(detail.payloadCharacters > 40000);
  assert.match(h.history()[0].Remark, /Send quotation/);
});

test('paused, malformed and partially failed deliveries retain debugging receipts', () => {
  const paused = harness({ disabled: true }); paused.send([call()]);
  let entry = paused.context._callWebhookPage_().deliveries[0];
  assert.equal(JSON.parse(paused.context._callWebhookDelivery_(entry.deliveryId).responseBody).code, 'WEBHOOK_DISABLED');
  const h = harness();
  h.context.doPost({ parameter: {}, postData: { contents: '{broken' } });
  entry = h.context._callWebhookPage_().deliveries[0];
  assert.equal(h.context._callWebhookDelivery_(entry.deliveryId).requestPayload, '{broken');
  assert.equal(JSON.parse(h.context._callWebhookDelivery_(entry.deliveryId).responseBody).code, 'INVALID_PAYLOAD');
  const failed = harness({ failAfter: 1 }); const response = failed.send([call(), call({ id: 'call-2' })]);
  entry = failed.context._callWebhookPage_().deliveries[0];
  assert.equal(entry.added, 1);
  assert.deepEqual(JSON.parse(failed.context._callWebhookDelivery_(entry.deliveryId).responseBody), response);
});

test('debug logs are best-effort and cannot turn a saved call into a failed webhook response', () => {
  const h = harness(); h.context._recordCallWebhook_ = () => { throw Error('logging unavailable'); };
  assert.equal(h.send([call()]).added, 1); assert.equal(h.history().length, 1);
});

test('delivery detail lookup requires configuration permission and rejects invalid or expired IDs', () => {
  const h = harness();
  assert.throws(() => h.context._callWebhookDelivery_('<script>'), /Invalid delivery/);
  assert.throws(() => h.context._callWebhookDelivery_('missing'), /not found/);
  const ctx = vm.createContext({}); vm.runInContext(read('src/server/Api.js'), ctx);
  ctx.apiGuard_ = (name, fn) => fn(); ctx._requireConfigReader = () => { throw Error('Permission denied'); };
  assert.throws(() => ctx.apiGetCallWebhookDelivery('bad', 'id'), /Permission denied/);
});

test('debug payloads render as text and are fetched only when expanded', async () => {
  const nodes = Object.fromEntries(['[data-debug-meta]','[data-request]','[data-response]'].map(key => [key, { textContent: '' }]));
  const panel = { dataset: {}, innerHTML: '', textContent: '', querySelector: key => nodes[key] };
  const summary = { dataset: { deliveryId: 'delivery1' }, parentElement: { querySelector: () => panel } };
  let fetches = 0;
  const ctx = vm.createContext({ api: { getCallWebhookDelivery: async id => {
    assert.equal(id, 'delivery1'); fetches++;
    return { requestPayload: '{"note":"<img src=x onerror=alert(1)>"}', responseBody: '{"invalidUser":1}', payloadTruncated: true, payloadCharacters: 40000 };
  } } });
  vm.runInContext(read('src/Webhooks.html').replace(/^<script>/, '').replace(/<\/script>\s*$/, ''), ctx);
  assert.equal(fetches, 0);
  await ctx._loadCallWebhookDelivery(summary);
  assert.match(nodes['[data-request]'].textContent, /<img/);
  assert.doesNotMatch(panel.innerHTML, /<img/);
  assert.match(nodes['[data-debug-meta]'].textContent, /Truncated/);
  await ctx._loadCallWebhookDelivery(summary); assert.equal(fetches, 1);
});
