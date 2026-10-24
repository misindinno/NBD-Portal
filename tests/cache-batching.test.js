'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {serverFixture, memoryStorage, browserFactory} = require('./helpers/lead-cache-fixture');
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
    const {snapshotBatch, ...legacyQuery} = query;
    return f.request(legacyQuery);
  }});
  client.bind(f.identity());
  assert.equal((await client.load()).length, 205);
  assert.equal(requests, 4);
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
