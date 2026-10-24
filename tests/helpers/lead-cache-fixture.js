'use strict';
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), crypto = require('node:crypto');
const root = path.resolve(__dirname, '../..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
function serverFixture(count = 205) {
  const state = {
    portal: 'synthetic-nbd', user: { id: 'u1', role: 'SALES', modules: ['Leads'], department: 'Sales' },
    authorized: true, disabled: false, departments: [], reads: 0, writes: 0,
    rows: Array.from({ length: count }, (_, index) => ({ 'Lead ID': String(index).padStart(5, '0'), 'Company Name': 'Synthetic customer ' + index, 'Assigned To': 'u1', 'Lead Status': 'Open', 'Stage ID': 's1', Phone: '0000000000', 'Updated At': '2026-10-24 12:00:00' }))
  };
  const c = vm.createContext({
    console, Set, Date,
    Utilities: { DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' }, computeDigest: (_a, text) => Array.from(crypto.createHash('sha256').update(text).digest()) },
    ScriptApp: { getScriptId: () => state.portal },
    PropertiesService: { getScriptProperties: () => ({ getProperty: key => key === 'LEAD_READ_CACHE_ENABLED' && !state.disabled ? 'true' : null }) },
    withRequestContext_: (_name, fn) => fn(), withServerContext_: fn => fn(),
    readAuthSession_: token => token === 'synthetic-session' ? { email: 'synthetic@example.test' } : null,
    getCurrentUserByEmail_: () => state.authorized ? { success: true, data: state.user } : { success: false, error: 'ACCESS_DENIED' }, refreshAuthSession_() {},
    userHasModule: (user, name) => user.modules.includes(name),
    respond: (data, error, code) => ({ success: !error, data, error, code }),
    logServerError_() {}, safeClientErrorMessage_: error => error.message, errorCodeFrom_: error => /denied/i.test(error.message) ? 'FORBIDDEN' : 'ERROR',
    SHEET_NAMES: { LEADS: 'leads', USERS: 'users', FIELD_CONFIG: 'fields', LEAD_FIELD_VALUES: 'values' },
    getAllRows(name) {
      state.reads++;
      if (name === 'leads') return structuredClone(state.rows);
      if (name === 'users') return [{ ID: 'u1', Department: 'Sales' }, { ID: 'u2', Department: 'Other' }];
      return [];
    },
    getStaffUserId: row => row.ID,
    getPortalSettings_: () => ({ visibleDepartments: state.departments }),
    _isArchivedLead_: row => row['Is Archived'] === true,
    getSpreadsheet: () => ({ getSheetByName: () => ({}) }), normalizeSheetName: name => name,
    queryRows: () => [], applyCalculatedFields: (_name, rows) => rows,
    safeInitHeaders() { state.writes++; throw Error('Read must not initialize Sheets'); }
  });
  ['src/server/CustomFieldValueService.js','src/server/Api.js','src/server/LeadCacheService.js'].forEach(file => vm.runInContext(read(file), c, { filename: file }));
  return { c, state, identity: () => c.leadCacheIdentity_(state.user),
    call(query, token = 'synthetic-session') { return JSON.parse(JSON.stringify(c.apiGetLeadCachePage(token, query))); },
    request(query) { const result = this.call(query); if (!result.success) { const error = Error(result.error); error.code = result.code; throw error; } return result.data; }
  };
}
function memoryStorage() {
  const data = new Map();
  return { data, fail: false, puts: 0,
    async get(key) { if (this.fail) throw Error('Storage denied'); return structuredClone(data.get(key)); },
    async put(value) { if (this.fail) throw Error('Quota'); this.puts++; data.set(value.key, structuredClone(value)); },
    async remove(key) { if (this.fail) throw Error('Storage denied'); data.delete(key); },
    async clear() { data.clear(); }
  };
}
function browserFactory() {
  const source = read('src/IndexedDbCache.html').replace(/^<script>\s*/, '').split('const LeadReadCache =')[0];
  const c = vm.createContext({ console, setTimeout, clearTimeout, TextEncoder, Uint8Array, crypto: crypto.webcrypto, structuredClone });
  vm.runInContext(source, c);
  return c;
}
module.exports = { root, read, serverFixture, memoryStorage, browserFactory };
