'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {serverFixture, memoryStorage, browserFactory, read} = require('./helpers/lead-cache-fixture');
const {moduleFixture, moduleClient} = require('./helpers/portal-cache-fixture');

test('9000 history rows download in six verified RPCs instead of ninety-plus', async () => {
  const f = moduleFixture();
  f.tables.history = Array.from({length:9000}, (_,i) => ({...f.tables.history[0], 'History ID':'history-'+i}));
  const b = moduleClient(f);
  const result = await b.client.get('apiGetFollowupPageSnapshot', {includeHistory:true});
  assert.equal(result.followupHistory.length, 9000);
  assert.equal(result.followupHistory.at(-1)['History ID'], 'history-8999');
  assert.equal(b.requests, 6, 'five batches and a final live revision check');
  assert.equal(b.storage.puts, 1, 'only the complete snapshot is persisted');
  assert.equal(f.state.writes, 0);
});

test('large row payloads split before the record cap and preserve every value', async () => {
  const f = serverFixture(120), storage = memoryStorage();
  f.state.rows.forEach(row => { row.Remarks = 'x'.repeat(20000); });
  const pages = [];
  const client = browserFactory().createLeadReadCache({storage, request: query => {
    const page = f.request(query);
    if (page.items) pages.push(page);
    return page;
  }});
  client.bind(f.identity());
  const result = await client.load();
  assert.equal(result.length, 120);
  assert.equal(result[119].Remarks.length, 20000);
  assert.ok(pages.length >= 3);
  pages.forEach(page => assert.ok(JSON.stringify(page.items).length <= 1000000));
  assert.equal(storage.puts, 1);
});

test('legacy clients still get 100 records and new clients can read legacy servers', async () => {
  const f = serverFixture(205);
  const legacy = f.request(f.identity());
  assert.equal(legacy.items.length, 100);
  assert.equal(legacy.nextCursor, '100');
  const storage = memoryStorage(); let requests = 0;
  const client = browserFactory().createLeadReadCache({storage, request: query => {
    requests++;
    const {snapshotBatch, canonicalHashes, ...legacyQuery} = query;
    return f.request(legacyQuery);
  }});
  client.bind(f.identity());
  assert.equal((await client.load()).length, 205);
  assert.equal(requests, 4);
});

function reordered(value) {
  if (Array.isArray(value)) return value.map(reordered);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).reverse().map(key => [key, reordered(value[key])]));
}

test('RPC object-key reordering preserves cold, warm and delta snapshot integrity', async () => {
  const f = moduleFixture();
  vm.runInContext(read('src/server/SyncDeltaService.js'), f.c);
  f.c.syncEnabled_ = () => true;
  const request = f.request, responses = [];
  f.request = query => {const page = reordered(request(query)); responses.push(page); return page;};
  const b = moduleClient(f);
  const first = await b.client.get('apiGetFollowupPageSnapshot', {includeHistory:true});
  assert.equal(first.followupHistory.length, 5);
  assert.equal([...b.storage.data.values()][0].hashFormat, 'canonical-v1');
  // Even disk/transport object order changes are harmless; array order remains significant.
  for (const [key,value] of b.storage.data) b.storage.data.set(key, reordered(value));
  b.client.verifyNext(); const before = b.requests;
  await b.client.get('apiGetFollowupPageSnapshot', {includeHistory:true});
  assert.equal(b.requests - before, 1);
  f.tables.history[0].Remark = 'Updated in Sheet';
  f.tables.history.pop(); b.client.verifyNext(); responses.length = 0;
  const updated = await b.client.get('apiGetFollowupPageSnapshot', {includeHistory:true});
  assert.equal(updated.followupHistory.length, 4);
  assert.equal(updated.followupHistory[0].Remark, 'Updated in Sheet');
  assert.ok(responses.some(page => page.delta));
});

test('canonical hashing still rejects changed content and reordered record arrays', async () => {
  for (const corrupt of [page => {page.items[0]['Company Name'] = 'Corrupt';}, page => {page.items.reverse();}]) {
    const f = serverFixture(3), storage = memoryStorage();
    const client = browserFactory().createLeadReadCache({storage, request:query => {
      const page = reordered(f.request(query));
      if (page.items) corrupt(page);
      return page;
    }});
    client.bind(f.identity());
    await assert.rejects(client.load(), /Invalid snapshot integrity/);
    assert.equal(storage.puts, 0);
  }
});

test('batch continuation rechecks permissions and never publishes a partial snapshot', async () => {
  const f = serverFixture(2005), storage = memoryStorage();
  let locked = false;
  const client = browserFactory().createLeadReadCache({storage, onLock: () => {locked = true;}, request: query => {
    if (query.cursor) f.state.user.modules = [];
    return f.request(query);
  }});
  client.bind(f.identity());
  await assert.rejects(client.load(), /Permission denied/);
  assert.equal(locked, true);
  assert.equal(storage.puts, 0);
  assert.equal(storage.data.size, 0);
});

test('an oversized individual row still advances the cursor rather than looping', () => {
  const f = serverFixture(2);
  f.state.rows[0].Remarks = 'x'.repeat(1000001);
  const query = {...f.identity(), snapshotBatch:true};
  const first = f.request(query);
  assert.equal(first.items.length, 1);
  assert.equal(first.nextCursor, '1');
  const second = f.request({...query, revision:first.revision, cursor:first.nextCursor});
  assert.equal(second.items.length, 1);
  assert.equal(second.nextCursor, null);
});
