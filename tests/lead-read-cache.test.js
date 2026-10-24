'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { serverFixture, memoryStorage, browserFactory, read } = require('./helpers/lead-cache-fixture');
function fixture(count) {
  const server = serverFixture(count), storage = memoryStorage();
  const state = { requests: [], locks: 0 };
  const client = browserFactory().createLeadReadCache({ storage, request: async query => { state.requests.push(query); return server.request(query); }, onLock: () => state.locks++ });
  client.bind(server.identity());
  return { server, storage, state, client };
}
test('cold snapshots use bounded pages and one atomic complete commit; warm reads validate online', async () => {
  const f = fixture(4005);
  assert.equal((await f.client.load()).length, 4005);
  assert.equal(f.state.requests.length, 4); // 3 pages + final revision verification
  assert.equal(f.storage.puts, 1);
  const saved = [...f.storage.data.values()][0];
  assert.equal(saved.complete, true); assert.equal(saved.cursor, null); assert.equal(saved.total, 4005);
  f.state.requests.length = 0;
  assert.equal((await f.client.load()).length, 4005); assert.equal(f.state.requests.length, 1);
  assert.equal(f.client.status().state, 'verified-cache'); assert.equal(f.server.state.writes, 0);
});
test('zero results commit a complete empty snapshot, with no invented rows or totals', async () => {
  const f = fixture(0); assert.equal((await f.client.load()).length, 0);
  assert.equal([...f.storage.data.values()][0].total, 0);
  await f.client.load(); assert.equal(f.client.status().state, 'verified-cache');
});
test('direct Sheet edits, deletion, archive and reassignment replace the cache without stamps', async () => {
  const f = fixture(4); await f.client.load();
  f.server.state.rows[0]['Company Name'] = 'Edited directly';
  f.server.state.rows[1]['Is Archived'] = true;
  f.server.state.rows[2]['Assigned To'] = 'u2'; f.server.state.rows.pop();
  const rows = await f.client.load(); assert.equal(rows.length, 1); assert.equal(rows[0]['Company Name'], 'Edited directly');
  assert.equal([...f.storage.data.values()][0].rows.length, 1);
});
test('current assignment and department scopes apply to each page and admin still has full scope', () => {
  const f = serverFixture(2); f.state.rows[1]['Assigned To'] = 'u2';
  const query = () => ({ ...f.identity() });
  assert.equal(f.call(query()).data.total, 1);
  f.state.user.role = 'VIEWER'; f.state.departments = ['Sales'];
  assert.equal(f.call(query()).data.total, 1);
  f.state.user.role = 'ADMIN'; assert.equal(f.call(query()).data.total, 2);
});
test('permission revocation locks and purges before old private data can render', async () => {
  const f = fixture(2); await f.client.load(); f.server.state.user.modules = [];
  await assert.rejects(f.client.load(), /Permission denied/);
  assert.equal(f.storage.data.size, 0); assert.equal(f.state.locks, 1); assert.equal(f.client.enabled(), false);
});
test('role or department changes require fresh bootstrap; disabled pilot locks the old cache', async () => {
  for (const change of [f => f.server.state.user.role = 'MANAGER', f => f.server.state.departments = ['Other'], f => f.server.state.disabled = true]) {
    const f = fixture(1); await f.client.load(); change(f);
    await assert.rejects(f.client.load(), /CACHE_SCOPE_CHANGED|CACHE_DISABLED/);
    assert.equal(f.storage.data.size, 0); assert.equal(f.state.locks, 1);
  }
});
test('authentication and Leads grant are checked before reading Sheets', () => {
  const f = serverFixture(2), query = f.identity();
  assert.equal(f.call(query, '').success, false); assert.equal(f.state.reads, 0);
  f.state.authorized = false; assert.equal(f.call(query).success, false); assert.equal(f.state.reads, 0);
});
test('user and portal IDs isolate snapshots; wrong-portal requests never expose rows', async () => {
  const f = fixture(2); await f.client.load();
  assert.equal(f.server.call({ ...f.server.identity(), portal: 'wrong' }).success, false);
  f.server.state.user.id = 'u2'; f.client.bind(f.server.identity()); assert.equal((await f.client.load()).length, 0);
  f.server.state.portal = 'second-portal'; f.client.bind(f.server.identity()); await f.client.load();
  assert.equal(f.storage.data.size, 3);
});
test('no credentials or user-directory objects enter persisted lead records', async () => {
  const f = fixture(1);
  Object.assign(f.server.state.rows[0], { Password: 'never', 'API Key': 'never', access_token: 'never', users: { directory: 'never' }, Category: 'Safe category' });
  const rows = await f.client.load();
  const json = JSON.stringify([...f.storage.data.values()]);
  assert.ok(!json.includes('never')); assert.equal(rows[0].Category, 'Safe category');
  assert.ok(!json.includes('synthetic-session'));
});
test('corrupt local content with a matching stored revision is discarded and downloaded', async () => {
  const f = fixture(1); await f.client.load(); const saved = [...f.storage.data.values()][0];
  saved.rows[0]['Company Name'] = 'Corrupt';
  assert.equal((await f.client.load())[0]['Company Name'], 'Synthetic customer 0');
  assert.equal(f.client.status().state, 'verified-network');
});
test('duplicate IDs fail closed; invalid/replayed cursors and stale revisions are rejected', () => {
  const f = serverFixture(205), query = f.identity(), page = f.call(query).data;
  for (const cursor of ['0','-1','1','999999','abc']) assert.equal(f.call({ ...query, revision: page.revision, cursor }).success, false);
  f.state.rows[0]['Company Name'] = 'Changed';
  assert.equal(f.call({ ...query, revision: page.revision, cursor: '100' }).error, 'CACHE_REVISION_CHANGED');
  f.state.rows.push({ ...f.state.rows[0] }); assert.equal(f.call(query).success, false);
});
test('interrupted replacement never publishes partial data or advances the stored cursor', async () => {
  const f = serverFixture(2005), storage = memoryStorage();
  const client = browserFactory().createLeadReadCache({ storage, request: query => { if (query.cursor) throw Error('Network lost'); return f.request(query); } });
  client.bind(f.identity()); await assert.rejects(client.load(), /Network lost/);
  assert.equal(storage.data.size, 0); assert.equal(storage.puts, 0);
});
test('a changing snapshot restarts with a bounded retry and never combines revisions', async () => {
  const f = serverFixture(2005), storage = memoryStorage(); let changes = 0;
  const client = browserFactory().createLeadReadCache({ storage, request: query => {
    if (query.cursor && !changes++) f.state.rows[0]['Company Name'] = 'New revision';
    return f.request(query);
  } });
  client.bind(f.identity()); const rows = await client.load();
  assert.equal(rows[0]['Company Name'], 'New revision'); assert.equal(rows.length, 2005); assert.equal(storage.puts, 1);
});
test('storage denial/quota keeps authorized network reads working', async () => {
  const f = fixture(105); f.storage.fail = true;
  assert.equal((await f.client.load()).length, 105); assert.equal(f.client.status().storage, 'unavailable'); assert.equal(f.storage.data.size, 0);
});
test('network failure never falls back to unverified private cached data', async () => {
  const f = serverFixture(1), storage = memoryStorage(); let offline = false;
  const client = browserFactory().createLeadReadCache({ storage, request: query => { if (offline) throw Error('Offline'); return f.request(query); } });
  client.bind(f.identity()); await client.load(); offline = true;
  await assert.rejects(client.load(), /Offline/); assert.equal(client.status().state, 'unavailable');
});
test('logout while RPC is in flight rejects late results and prevents repopulation', async () => {
  const f = serverFixture(1), storage = memoryStorage(); let release, started;
  const dispatched = new Promise(resolve => started = resolve);
  const client = browserFactory().createLeadReadCache({ storage, request: query => new Promise(resolve => { release = () => resolve(f.request(query)); started(); }) });
  client.bind(f.identity()); const pending = client.load(); await dispatched; await client.lock(); release();
  await assert.rejects(pending, /CACHE_CANCELLED/); assert.equal(storage.data.size, 0);
});
test('confirmed mutation invalidation rejects a stale read and keeps optimistic state out of persistence', async () => {
  const f = serverFixture(1), storage = memoryStorage(); let release, started;
  const dispatched = new Promise(resolve => started = resolve);
  const client = browserFactory().createLeadReadCache({ storage, request: query => new Promise(resolve => { const old = f.request(query); release = () => resolve(old); started(); }) });
  client.bind(f.identity()); const pending = client.load(); await dispatched;
  f.state.rows[0]['Company Name'] = 'Confirmed save'; await client.invalidate(); release();
  await assert.rejects(pending, /CACHE_CANCELLED/); assert.equal(storage.data.size, 0);
  assert.doesNotMatch(read('src/IndexedDbCache.html'), /AppCache\.getRows|Store\.getState/);
});
test('concurrent loads share one sync and returned rows cannot mutate durable data', async () => {
  const f = fixture(1); const [a, b] = await Promise.all([f.client.load(), f.client.load()]);
  assert.equal(f.state.requests.length, 2); a[0]['Company Name'] = 'Optimistic';
  assert.equal([...f.storage.data.values()][0].rows[0]['Company Name'], 'Synthetic customer 0');
  assert.equal((await f.client.load())[0]['Company Name'], 'Synthetic customer 0'); assert.equal(b.length, 1);
});
test('duplicate cross-tab logout signals share cleanup and preserve the final private-state reset', async () => {
  let locks = 0, resets = 0;
  const client = browserFactory().createLeadReadCache({ request: () => {}, storage: memoryStorage(), onLock: () => ++locks === 1, afterLock: needed => { if (needed) resets++; } });
  await Promise.all([client.lock(), client.lock()]);
  assert.equal(locks, 1); assert.equal(resets, 1);
});
test('duplicate/replayed network pages cannot be committed under a server revision', async () => {
  for (const corrupt of [page => { page.items[0] = page.items[1]; }, page => { page.offset = 0; }, page => { page.nextCursor = '100'; }]) {
    const f = serverFixture(2005), storage = memoryStorage();
    const client = browserFactory().createLeadReadCache({ storage, request: query => {
      const page = f.request(query); if (query.cursor) corrupt(page); return page;
    } });
    client.bind(f.identity()); await assert.rejects(client.load(), /Invalid|duplicate/); assert.equal(storage.puts, 0);
  }
});
test('continuous edits exhaust a bounded retry instead of accepting an inconsistent snapshot', async () => {
  const f = serverFixture(2005), storage = memoryStorage(); let changes = 0;
  const client = browserFactory().createLeadReadCache({ storage, request: query => {
    if (query.cursor) f.state.rows[0]['Company Name'] = 'Change ' + ++changes;
    return f.request(query);
  } });
  client.bind(f.identity()); await assert.rejects(client.load(), /CACHE_REVISION_CHANGED/);
  assert.equal(changes, 3); assert.equal(storage.puts, 0);
});
test('a new identity bound during an old request cannot receive or persist the prior user snapshot', async () => {
  const f = serverFixture(1), storage = memoryStorage(); let release, started;
  const dispatched = new Promise(resolve => started = resolve);
  const client = browserFactory().createLeadReadCache({ storage, request: query => new Promise(resolve => { const old = f.request(query); release = () => resolve(old); started(); }) });
  client.bind(f.identity()); const pending = client.load(); await dispatched;
  f.state.user.id = 'u2'; client.bind(f.identity()); release(); await assert.rejects(pending, /CACHE_CANCELLED/);
  assert.equal(storage.puts, 0);
});
test('RPC adapter invalidates only after success, rejects old-session responses and locks forbidden reads', async () => {
  const vm = require('node:vm');
  const tokens = new Map([['nbd_token','first-session']]); let handler, invalidations = 0, locks = 0;
  const storage = { getItem: key => tokens.get(key), setItem: (key,value) => tokens.set(key,value), removeItem: key => tokens.delete(key) };
  const chain = { withSuccessHandler(fn) { handler = fn; return this; }, withFailureHandler() { return this; }, apiSaveLead() {}, apiGetLeadCachePage() {} };
  const c = vm.createContext({ sessionStorage:storage,localStorage:{getItem:()=>'',removeItem(){}},window:{},google:{script:{run:chain}},LeadReadCache:{invalidate:async()=>invalidations++},lockPrivateReadCache:()=>locks++ });
  vm.runInContext(read('src/AppCore.html').replace(/<\/?script>/g,''),c);
  const call = name => vm.runInContext(`api._authedRead('${name}',{})`,c);
  let pending = call('apiSaveLead'); handler({success:true,data:'id'}); await pending; assert.equal(invalidations,1);
  pending = call('apiSaveLead'); handler({success:false,error:'Save failed'}); await assert.rejects(pending,/Save failed/); assert.equal(invalidations,1);
  pending = call('apiSaveLead'); handler({success:false,error:'Access denied.',code:'FORBIDDEN'}); await assert.rejects(pending,/Access denied/); assert.equal(locks,0,'a denied action alone must not log out the entire portal');
  pending = call('apiGetLeadCachePage'); tokens.set('nbd_token','new-session'); handler({success:true,data:[]}); await assert.rejects(pending,/Session changed/); assert.equal(locks,0);
  pending = call('apiGetLeadCachePage'); handler({success:false,error:'Access denied.',code:'FORBIDDEN'}); await assert.rejects(pending,/Access denied/); assert.equal(locks,1);
});
test('offline suspension cancels pending cache writes while retaining the need for online verification', async () => {
  const f = serverFixture(1), storage = memoryStorage(); let release, started;
  const dispatched = new Promise(resolve => started = resolve);
  const client = browserFactory().createLeadReadCache({ storage, request: query => new Promise(resolve => { release = () => resolve(f.request(query)); started(); }) });
  client.bind(f.identity()); const pending = client.load(); await dispatched; client.suspend(); release();
  await assert.rejects(pending,/CACHE_CANCELLED/); assert.equal(storage.puts,0); assert.equal(client.status().state,'unavailable');
});
