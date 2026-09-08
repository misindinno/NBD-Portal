const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
function load(file, globals = {}) {
  const context = vm.createContext(globals);
  const source = file.endsWith('.html')
    ? read(file).replace(/^<script>\s*/, '').replace(/<\/script>\s*$/, '')
    : read(file);
  vm.runInContext(source, context, { filename: file });
  return context;
}

test('old module permissions cannot reopen retired routes or grant new access', () => {
  const auth = load('src/server/AuthService.js');
  assert.deepEqual(Array.from(auth.parseUserModules('StageFields,Visits,Pipeline')), ['Pipeline']);
  assert.deepEqual(Array.from(auth.getEffectiveUserModules({ 'Allowed Modules': 'StageFields,Visits' }, 'SALES')), []);
  assert.deepEqual(Array.from(auth.getEffectiveUserModules({ 'Allowed Modules': 'NONE' }, 'SALES')), []);
  assert.ok(auth.getEffectiveUserModules({ 'Allowed Modules': '' }, 'SALES').includes('Leads'));

  const app = load('src/AppUI.html', {
    window: { loadConfig() {} },
    App: { user: { role: 'ADMIN', modules: ['StageFields', 'Visits', 'Leads', 'Pipeline'] } }
  });
  for (const route of ['stagefields', 'visits', 'unknown']) assert.equal(app.canNavigate(route), false);
  for (const route of ['today', 'leads', 'pipeline']) assert.equal(app.canNavigate(route), true);
});

test('lead details load without any visit service and retain their history and custom values', () => {
  const lead = { 'Lead ID': 'L1', 'Stage ID': 'S1', CF_Notes: 'keep' };
  const followups = [{ 'Follow-up ID': 'F1', 'Lead ID': 'L1' }];
  const history = [{ 'History ID': 'H1', 'Lead ID': 'L1' }];
  const logs = [{ 'Log ID': 'A1', 'Lead ID': 'L1' }];
  const api = load('src/server/Api.js', {
    SHEET_NAMES: { LEADS: 'LEADS' },
    getRowByIndexedId_: () => lead,
    getRowsWithCustomFieldValues_: (sheet, rows) => rows,
    getFollowups: () => followups,
    getFollowupHistory: () => history,
    getLeadActivityLogs: () => logs,
    getLeadCustomValues: () => lead,
    respond: data => ({ success: true, data })
  });
  api.apiGuard_ = (name, fn) => fn();
  api._requireAnyModule = names => {
    assert.ok(!names.includes('Visits') && !names.includes('StageFields'));
    return { id: 'admin', role: 'ADMIN' };
  };
  api._canReadAssignedRow = () => true;
  api._scopeFollowupRows = rows => rows;
  api._scopeFollowupHistoryRows = rows => rows;
  api._scopeActivityLogRows = rows => rows;
  const result = api.apiGetLead('token', 'L1');
  assert.equal(result.data.lead, lead);
  assert.equal(result.data.followups, followups);
  assert.equal(result.data.followupHistory, history);
  assert.equal(result.data.activityLogs, logs);
  assert.equal('visitHistory' in result.data, false);
  assert.equal(api.apiGetLeadFieldValues('token', 'L1').data.lead.CF_Notes, 'keep');
  for (const name of ['apiGetVisits', 'apiGetClientVisitHistory', 'apiSaveVisit', 'apiUpdateVisit', 'apiDeleteVisit', 'apiSaveLeadStageFields']) {
    assert.equal(typeof api[name], 'undefined');
  }
  assert.equal(typeof api.apiMoveLeadStageWithFields, 'function');
});

test('custom field storage only initializes supported lead and follow-up sheets', () => {
  const initialized = [];
  const custom = load('src/server/CustomFieldValueService.js', {
    SHEET_NAMES: { LEAD_FIELD_VALUES: 'LEAD_VALUES', FOLLOWUP_FIELD_VALUES: 'FOLLOWUP_VALUES' },
    safeInitHeaders: (sheet, headers) => initialized.push({ sheet, headers })
  });
  custom.ensureCustomFieldValueSheets_();
  custom.ensureCustomFieldValueSheets_();
  assert.deepEqual(initialized.map(row => row.sheet), ['LEAD_VALUES', 'FOLLOWUP_VALUES']);
  assert.ok(initialized[0].headers.includes('Lead ID'));
  assert.ok(initialized[1].headers.includes('Follow-up ID'));
  assert.equal(custom._customValueSheetName_('Leads'), 'LEAD_VALUES');
  assert.equal(custom._customValueSheetName_('Followups'), 'FOLLOWUP_VALUES');
  assert.throws(() => custom._customValueSheetName_('Visits'), /Unsupported/);
});

test('portal settings no longer read stage form settings or require notification credentials', () => {
  const readKeys = [];
  const config = load('src/server/ConfigService.js', {
    PropertiesService: { getScriptProperties: () => ({
      getProperty(key) {
        readKeys.push(key);
        return key === 'PORTAL_VISIBLE_DEPARTMENTS' ? 'Sales' : '';
      }
    }) }
  });
  const settings = config.getPortalSettings_();
  assert.deepEqual(Array.from(settings.visibleDepartments), ['Sales']);
  assert.equal('stageFieldFormStages' in settings, false);
  assert.deepEqual(readKeys, ['PORTAL_VISIBLE_DEPARTMENTS', 'PORTAL_ESCALATE_FORM_URL']);
});

test('the app shell resolves every included file after removing the retired modules', () => {
  const index = read('src/Index.html');
  for (const match of index.matchAll(/include\('([^']+)'\)/g)) {
    assert.ok(fs.existsSync(path.join(root, 'src', match[1] + '.html')), 'Missing include: ' + match[1]);
  }
  for (const file of ['src/StageFieldForm.html', 'src/VisitForm.html', 'src/server/VisitService.js', 'src/server/WhatsAppService.js']) {
    assert.equal(fs.existsSync(path.join(root, file)), false);
  }
});
