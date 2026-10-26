const vm = require('node:vm');
const { syncFixture } = require('./sync-fixture');
const { read, browserFactory, memoryStorage } = require('./lead-cache-fixture');
function mirrorFixture() {
  const f = syncFixture();
  f.c.Session = {getScriptTimeZone: () => 'Asia/Kolkata'};
  ['ClientFactoryVisitService', 'SheetMirrorService'].forEach(name => vm.runInContext(read('src/server/' + name + '.js'), f.c));
  f.add('Staff List', ['ID','Department','Password'], [{ ID:'u1', Department:'Sales', Password:'NEVER_EXPORT' }, { ID:'u2',Department:'Other' }]);
  f.c._cfvDirectory_ = () => [{ id:'u1',department:'Sales' }];
  f.identity = () => JSON.parse(JSON.stringify(f.c.sheetMirrorIdentity_(f.state.user)));
  f.request = (endpoint, query) => {
    const result = JSON.parse(JSON.stringify(f.c[endpoint]('valid', query)));
    if (!result.success) throw Object.assign(new Error(result.error), { code:result.code });
    return result.data;
  };
  return f;
}
function mirrorClient(f, options = {}) {
  const c = browserFactory(), stores = new Map();
  vm.runInContext(read('src/SheetMirror.html').replace(/^<script>\s*/, '').split('const SheetMirror =')[0], c);
  const storage = { table(name) { if (!stores.has(name)) stores.set(name, memoryStorage()); return stores.get(name); },
    async clear() { for (const store of stores.values()) await store.clear(); } };
  let locks = 0, requests = 0;
  const client = c.createSheetMirror({ storage, request: async (endpoint, query) => { requests++; return options.request ? options.request(endpoint, query) : f.request(endpoint, query); }, onLock: () => locks++, now: options.now });
  client.bind(f.identity());
  return { client, storage, stores, c, get locks() { return locks; }, get requests() { return requests; } };
}
module.exports = { mirrorFixture, mirrorClient };
