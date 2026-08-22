/* eslint-disable no-console */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function formatDate(value, _timeZone, pattern) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const pad = number => String(number).padStart(2, '0');
  const day = [date.getUTCFullYear(), pad(date.getUTCMonth() + 1), pad(date.getUTCDate())].join('-');
  if (pattern === 'yyyy-MM-dd') return day;
  return day + ' ' + [pad(date.getUTCHours()), pad(date.getUTCMinutes()), pad(date.getUTCSeconds())].join(':');
}

function loadServerHelpers() {
  const context = vm.createContext({
    console,
    Logger: { log() {} },
    Session: { getScriptTimeZone: () => 'UTC' },
    Utilities: {
      formatDate,
      getUuid: () => 'test-request-id'
    },
    SHEET_NAMES: {
      LEADS: 'LEAD_MASTER',
      FOLLOWUPS: 'FOLLOWUPS',
      FOLLOWUP_HISTORY: 'FOLLOWUP_HISTORY',
      STAGES: 'PIPELINE_STAGES',
      CONFIG: 'CONFIG',
      USERS: 'Staff List',
      USER_PORTAL_ACCESS: 'USER_PORTAL_ACCESS',
      LEAD_ACTIVITY_LOGS: 'LEAD_ACTIVITY_LOGS',
      FIELD_CONFIG: 'FIELD_CONFIG',
      LEAD_FIELD_VALUES: 'LEAD_FIELD_VALUES',
      FOLLOWUP_FIELD_VALUES: 'FOLLOWUP_FIELD_VALUES',
      VISIT_FIELD_VALUES: 'VISIT_FIELD_VALUES',
      VISITS: 'VISITS',
      IDX_LEADS: 'IDX_LEADS',
      IDX_FOLLOWUPS: 'IDX_FOLLOWUPS',
      IDX_USERS: 'IDX_USERS',
      BULK_AUDIT_LOG: 'BULK_IMPORT_LOG'
    },
    normalizeSheetName: value => String(value || '').trim().toUpperCase(),
    normalizeSheetValue: value => value == null ? '' : value,
    _serialToDateTimeString_: value => value === 1 ? '1899-12-31 00:00:00' : '',
    today: () => '2026-08-21',
    now: () => '2026-08-21 12:00:00'
  });

  const files = [
    path.join(ROOT, 'src', 'server', 'ArchitectureCore.js'),
    path.join(ROOT, 'src', 'server', 'PaginationService.js')
  ];
  files.forEach(file => vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file }));
  return context;
}

const helpers = loadServerHelpers();
const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

test('safe boolean parsing accepts explicit truthy and falsey sheet values', () => {
  for (const value of [true, 'TRUE', ' yes ', '1', 'Y']) assert.equal(helpers.safeBooleanValue_(value), true);
  for (const value of [false, 'FALSE', ' no ', '0', 'N', '', null, 'unexpected']) {
    assert.equal(helpers.safeBooleanValue_(value), false);
  }
});

test('safe number parsing preserves blanks and rejects non-finite values', () => {
  assert.equal(helpers.safeNumberValue_('42.5'), 42.5);
  assert.equal(helpers.safeNumberValue_(0), 0);
  assert.equal(helpers.safeNumberValue_(''), '');
  assert.equal(helpers.safeNumberValue_('not-a-number'), '');
  assert.equal(helpers.safeNumberValue_(Infinity), '');
});

test('safe date parsing normalizes supported text and rejects invalid input', () => {
  assert.equal(helpers.safeDateValue_('2026-08-21'), '2026-08-21');
  assert.equal(helpers.safeDateValue_('2026-08-21T09:30'), '2026-08-21 09:30:00');
  assert.equal(helpers.safeDateValue_('2026-08-21 09:30:45'), '2026-08-21 09:30:45');
  assert.equal(helpers.safeDateValue_('definitely-not-a-date'), '');
  assert.equal(helpers.safeDateValue_(1), '1899-12-31 00:00:00');
});

test('schema parsing coerces typed cells and trims text cells', () => {
  assert.equal(helpers.parseSheetCell_('LEAD_MASTER', 'Is Archived', 'YES'), true);
  assert.equal(helpers.parseSheetCell_('PIPELINE_STAGES', 'Stage Order', '12'), 12);
  assert.equal(helpers.parseSheetCell_('LEAD_MASTER', 'Lead ID', '  L-1  '), 'L-1');
  assert.equal(helpers.parseSheetCell_('FIELD_CONFIG', 'Is Required', 'YES'), true);
  assert.equal(helpers.parseSheetCell_('VISITS', 'AMOUNT', '1250.50'), 1250.5);
  assert.equal(helpers.parseSheetCell_('BULK_IMPORT_LOG', 'Total Rows', '30'), 30);
  assert.equal(helpers.parseSheetCell_('LEAD_MASTER', 'Unknown', null), '');
});

test('header validation rejects duplicate and missing required columns', () => {
  assert.deepEqual(
    Array.from(helpers.validateSheetHeaders_('LEAD_MASTER', ['Lead ID', 'Stage ID', 'Assigned To'])),
    ['Lead ID', 'Stage ID', 'Assigned To']
  );
  assert.throws(
    () => helpers.validateSheetHeaders_('LEAD_MASTER', ['Lead ID', 'Stage ID', 'Stage ID', 'Assigned To']),
    /Duplicate header/
  );
  assert.throws(
    () => helpers.validateSheetHeaders_('LEAD_MASTER', ['Lead ID', 'Stage ID']),
    /Missing required header.*Assigned To/
  );
});

test('formula neutralization blocks executable prefixes but preserves negative numbers', () => {
  assert.equal(helpers.neutralizeSheetFormula_('=IMPORTXML("x")'), "'=IMPORTXML(\"x\")");
  assert.equal(helpers.neutralizeSheetFormula_('+SUM(A1:A2)'), "'+SUM(A1:A2)");
  assert.equal(helpers.neutralizeSheetFormula_('-CMD()'), "'-CMD()");
  assert.equal(helpers.neutralizeSheetFormula_('-12.50'), '-12.50');
  assert.deepEqual(Array.from(helpers.sanitizeSheetRowValues_(['@x', 'safe'])), ["'@x", 'safe']);
});

test('lifecycle outcome is canonical and independent from archive state', () => {
  assert.equal(helpers.canonicalStageOutcome_({ 'Stage Name': 'Deal Won' }), 'Won');
  assert.equal(helpers.canonicalStageOutcome_({ 'Stage Outcome': 'lost' }), 'Lost');
  assert.equal(helpers.canonicalStageOutcome_({ 'Stage Name': 'Disqualified by policy' }), 'Disqualified');
  assert.equal(helpers.canonicalStageOutcome_({ 'Stage Name': 'Contacted' }), 'Open');
  assert.equal(helpers.leadLifecycleStatus_({ 'Lead Status': 'lost' }, null), 'Lost');
  assert.equal(helpers.leadLifecycleStatus_({ 'Lead Status': 'Archived' }, null), 'Open');
  assert.equal(helpers.leadArchiveState_({ 'Lead Status': 'Lost' }), false);
  assert.equal(helpers.leadArchiveState_({ 'Is Archived': 'TRUE', 'Lead Status': 'Lost' }), true);
  assert.equal(helpers.leadArchiveState_({ 'Archived At': '2026-08-21 10:00:00' }), true);
});

test('page request sanitizes search, direction, page, and page size', () => {
  const req = helpers.pageRequest_({
    page: -4,
    pageSize: 999,
    search: '  LOST LEAD  ',
    sortDir: 'sideways',
    filters: { status: 'Lost' }
  }, { maxPageSize: 100, pageSize: 25, sortField: 'Created At', sortDir: 'desc' });
  assert.deepEqual(JSON.parse(JSON.stringify(req)), {
    page: 1,
    pageSize: 100,
    search: 'lost lead',
    sortField: 'Created At',
    sortDir: 'asc',
    filters: { status: 'Lost' }
  });
  assert.equal(helpers.pageRequest_({ pageSize: 1 }, {}).pageSize, 10);
});

test('pagination returns only the requested slice and clamps an out-of-range page', () => {
  const rows = Array.from({ length: 23 }, (_, index) => index + 1);
  const middle = helpers.paginateRows_(rows, { page: 2, pageSize: 10 }, { marker: true });
  assert.deepEqual(Array.from(middle.items), [11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
  assert.equal(middle.total, 23);
  assert.equal(middle.totalPages, 3);
  assert.equal(middle.hasPrevious, true);
  assert.equal(middle.hasNext, true);
  assert.equal(middle.marker, true);

  const clamped = helpers.paginateRows_(rows, { page: 99, pageSize: 10 });
  assert.equal(clamped.page, 3);
  assert.deepEqual(Array.from(clamped.items), [21, 22, 23]);

  const empty = helpers.paginateRows_([], { page: 5, pageSize: 25 });
  assert.equal(empty.page, 1);
  assert.equal(empty.totalPages, 1);
  assert.deepEqual(Array.from(empty.items), []);
});

test('page sorting supports numeric and natural text ordering in both directions', () => {
  assert.ok(helpers.comparePageValues_(2, 10, 'asc') < 0);
  assert.ok(helpers.comparePageValues_('Lead 2', 'Lead 10', 'asc') < 0);
  assert.ok(helpers.comparePageValues_('Lead 2', 'Lead 10', 'desc') > 0);
  assert.equal(helpers._pageSortField_('unsafe', ['Created At'], 'Created At'), 'Created At');
});

test('lead query includes all lost leads regardless of call history and applies status filters', () => {
  const stageMap = { LOST: { 'Stage ID': 'LOST', 'Stage Outcome': 'lost', 'Is Final Stage': true } };
  const lead = {
    'Lead ID': 'L-9',
    'Company Name': 'Acme Industries',
    'Stage ID': 'LOST',
    'Priority': 'Cold',
    _lifecycleStatus: 'Lost'
  };
  const base = { search: '', filters: { status: 'Lost', statusTab: 'all' } };
  assert.equal(helpers._leadMatchesPageQuery_(lead, stageMap, base, base.filters), true);
  const wrongStatus = { search: '', filters: { status: 'Won', statusTab: 'all' } };
  assert.equal(helpers._leadMatchesPageQuery_(lead, stageMap, wrongStatus, wrongStatus.filters), false);
  const searched = { search: 'acme', filters: { statusTab: 'all' } };
  assert.equal(helpers._leadMatchesPageQuery_(lead, stageMap, searched, searched.filters), true);
});

test('lead summary and facets remain deterministic', () => {
  const stageMap = {
    OPEN: { 'Is Final Stage': false },
    LOST: { 'Is Final Stage': true }
  };
  const rows = [
    { 'Stage ID': 'OPEN', 'Priority': 'Hot', _lifecycleStatus: 'Open' },
    { 'Stage ID': 'LOST', 'Priority': 'Cold', _lifecycleStatus: 'Lost' },
    { 'Stage ID': 'OPEN', 'Priority': 'Warm', _lifecycleStatus: 'Open', 'NBD Lead ID': 'N-1' }
  ];
  assert.deepEqual(JSON.parse(JSON.stringify(helpers._leadPageSummary_(rows, stageMap))), {
    total: 3, open: 2, hot: 1, warm: 1, cold: 1, closed: 1, nbd: 1
  });
  assert.deepEqual(Array.from(helpers._pageDistinct_([
    { State: 'Delhi' }, { State: 'Punjab' }, { State: 'Delhi' }, { State: '' }
  ], 'State')), ['Delhi', 'Punjab']);
});

test('global search is server-backed, scoped by its snapshot, and payload-bounded', () => {
  helpers.getFollowupPageSnapshotFast_ = () => ({
    leads: [
      { 'Lead ID': 'L-1', 'Company Name': 'Acme Industries', 'Contact Person': 'Riya', 'Updated At': '2026-08-21' },
      { 'Lead ID': 'L-2', 'Company Name': 'Beta', 'Contact Person': 'Acme Contact', 'Updated At': '2026-08-20' }
    ],
    followups: [
      { 'Follow-up ID': 'F-1', 'Lead ID': 'L-1', Discussion: 'Acme pricing review', 'Updated At': '2026-08-21' }
    ]
  });
  const result = helpers.getGlobalSearch_({ id: 'U-1' }, 'acme');
  assert.equal(result.counts.leads, 1);
  assert.equal(result.counts.contacts, 1);
  assert.equal(result.counts.followups, 1);
  assert.equal(result.total, 3);
  assert.equal(result.followups[0]._leadCompanyName, 'Acme Industries');
  assert.ok(result.leads.length <= 4 && result.contacts.length <= 4 && result.followups.length <= 4);

  const leadsOnly = helpers.getGlobalSearch_({ id: 'U-1' }, 'acme', { leads: true, followups: false });
  assert.equal(leadsOnly.followups.length, 0);
  const followupsOnly = helpers.getGlobalSearch_({ id: 'U-1' }, 'acme', { leads: false, followups: true });
  assert.equal(followupsOnly.leads.length + followupsOnly.contacts.length, 0);
  assert.equal(followupsOnly.followups.length, 1);
});
test('follow-up tab and query helpers classify dates and filter linked lead data', () => {
  const overdue = { 'Lead ID': 'L-1', 'Planned Date': '2026-08-20', Status: 'Open', 'Follow-up Type': 'Call' };
  assert.equal(helpers._pageFollowupTabMatch_(overdue, 'overdue'), true);
  assert.equal(helpers._pageFollowupTabMatch_(overdue, 'today'), false);
  assert.equal(helpers._pageIsOpenFollowup_(overdue), true);
  assert.equal(helpers._pageIsOpenFollowup_({ Status: 'Closed' }), false);

  const leadMap = { 'L-1': { 'Company Name': 'Acme', State: 'Delhi', 'Assigned To': 'owner@example.com' } };
  const req = { search: 'acme' };
  const filters = { type: 'Call', state: 'Delhi', assignedTo: 'owner@example.com' };
  assert.equal(helpers._followupMatchesPageQuery_(overdue, leadMap, {}, req, filters), true);
  assert.equal(helpers._followupMatchesPageQuery_(overdue, {}, {}, req, filters), false);

  const standalone = { 'Lead ID': '', 'Discussion': 'Independent reminder', 'Planned Date': '2026-08-21' };
  assert.equal(
    helpers._followupMatchesPageQuery_(standalone, {}, {}, { search: 'independent' }, {}),
    true
  );
});

test('follow-up summary reports due buckets and closed conversion metrics', () => {
  const leadMap = { 'L-1': { 'Lead ID': 'L-1' } };
  const openRows = [
    { 'Lead ID': 'L-1', 'Planned Date': '2026-08-20' },
    { 'Lead ID': 'L-1', 'Planned Date': '2026-08-21' },
    { 'Lead ID': 'L-1', 'Planned Date': '2026-08-22' }
  ];
  const closedRows = [
    { 'Lead ID': 'L-1', 'Done Date': '2026-08-21', 'Contact Mode': 'Call Connected', Outcome: 'Won' },
    { 'Lead ID': 'L-1', 'Done Date': '2026-08-20', 'Contact Mode': 'Not Picked' }
  ];
  const summary = helpers._followupPageSummary_(openRows, closedRows, leadMap, {}, { search: '' }, {});
  assert.deepEqual(JSON.parse(JSON.stringify(summary)), {
    all: 3, today: 1, overdue: 1, future: 1, closed: 2, closedToday: 1,
    notPicked: 1, connected: 1, connectionRate: 50, conversions: 1, conversionRate: 100
  });
});

test('archive summaries and sort values cover suggestion and archived modes', () => {
  const suggestions = [
    { _notPickedStreak: 7, _notPickedTotal: 10, _lastNotPickedDate: '2026-08-19' },
    { _notPickedStreak: 9, _notPickedTotal: 12, _lastNotPickedDate: '2026-08-20' },
    { _notPickedStreak: 2, _notPickedTotal: 3, _lastNotPickedDate: '2026-08-18' }
  ];
  assert.deepEqual(JSON.parse(JSON.stringify(helpers._archivePageSummary_('suggestions', suggestions))), {
    total: 3, warning: 1, critical: 1
  });
  assert.equal(helpers._archivePageSortValue_(suggestions[1], 'suggestions', 'streak'), 9);
  assert.equal(
    helpers._archiveRowLifecycleStatus_({ 'Lead Status': 'Open', _stageOutcome: 'lost' }),
    'Lost'
  );
  assert.deepEqual(JSON.parse(JSON.stringify(helpers._archivePageSummary_('archived', [
    { _followupCount: 4, _notPickedCount: 2 },
    { _followupCount: 3, _notPickedCount: 1 }
  ]))), { total: 2, followups: 7, notPicked: 3 });
});

test('post-load icon rendering is idempotent and Follow-up tab icons stay at 14px', () => {
  const read = file => fs.readFileSync(path.join(ROOT, 'src', file), 'utf8');
  const utils = read('AppUtils.html');
  const css = read('CSSFollowupQuery.html');
  assert.match(utils, /tagName\?\.toLowerCase\(\) === 'svg'/);
  assert.doesNotMatch(utils, /target === document \|\|/);
  assert.doesNotMatch(utils, /attrs\['data-lucide'\]\s*=/);
  assert.match(utils, /removeAttribute\('data-lucide'\)/);
  assert.match(utils, /classList\.add\('portal-icon'\)/);
  assert.match(utils, /\['lucide', 'portal-icon'/);
  assert.match(utils, /\['width', 'height', 'min-width', 'min-height', 'max-width', 'max-height'\]/);
  assert.match(utils, /style\.setProperty\(prop, sizePx, 'important'\)/);
  assert.match(utils, /style\.setProperty\('flex', '0 0 ' \+ sizePx, 'important'\)/);
  assert.match(utils, /lockPortalIconSize\(renderedIcon, node\)/);
  assert.match(css, /\.fu-page \.fu-tab > svg\s*\{[^}]*width:\s*14px !important;[^}]*height:\s*14px !important;/s);
});

test('loaded portal icons keep the shared 14px content and 16px sidebar contract', () => {
  const css = fs.readFileSync(path.join(ROOT, 'src', 'CSS.html'), 'utf8');
  assert.match(css, /#main \.portal-icon,[\s\S]*?width:\s*14px !important;[\s\S]*?height:\s*14px !important;/);
  assert.match(css, /#sidebar \.portal-icon,[\s\S]*?width:\s*16px !important;[\s\S]*?height:\s*16px !important;/);
});

test('existing lead edit forms expose backend-required custom fields', () => {
  const sharedForm = fs.readFileSync(path.join(ROOT, 'src', 'LeadFormShared.html'), 'utf8');
  assert.match(sharedForm, /\$\{buildLeadCustomFieldsHTML\(d, customFields, configOptions\)\}/);
  assert.doesNotMatch(sharedForm, /leadId\s*\?\s*['"]{2}\s*:\s*buildLeadCustomFieldsHTML/);
});

test('primary worklists fetch complete collections once and process them client-side', () => {
  const read = file => fs.readFileSync(path.join(ROOT, 'src', file), 'utf8');
  const leads = read('Leads.html');
  const followups = read('Followups.html');
  const archive = read('Archive.html');
  const core = read('AppCore.html');
  const combined = [leads, followups, archive, core].join('\n');

  assert.match(leads, /await api\.getLeads\(\)/);
  assert.match(leads, /leadTable\.setFilter\(pred\.test\)/);
  assert.match(followups, /_getFollowupPageSnapshot\(force, \{ includeHistory: true \}\)/);
  assert.match(followups, /rows = _fuApplyFilters\(rows, ctx\)/);
  assert.match(followups, /data\.slice\(0, _fuRenderedCount\)\.map\(_fuTableRow\)/);
  assert.match(followups, /function _fuAppendVisibleRows\s*\(/);
  assert.match(followups, /function _fuRouteIsActive\s*\(/);
  assert.match(followups, /_fuSnapshotRequest\.promise/);
  assert.match(archive, /api\.getArchiveData\(\)/);
  assert.match(archive, /api\.getArchiveSuggestions\(\)/);
  assert.match(archive, /api\.getLostArchiveLeads\(\)/);
  assert.match(archive, /function _archFiltered\s*\(/);
  assert.doesNotMatch(combined, /get(?:Leads|Followups|Archive)Page/);
  assert.doesNotMatch(combined, /_leadRenderPagination|_fuPagination|_archPagHTML|_archSetPage/);

  const store = read('Store.html');
  assert.match(store, /function _installDebugButtonDrag\s*\(/);
  assert.match(store, /DEBUG_BUTTON_POSITION_KEY/);
  assert.match(store, /setPointerCapture/);
  assert.match(store, /suppressClick/);
  const loadingCss = read('CSS.html');
  assert.match(read('AppUtils.html'), /function beginTableLoading\s*\(/);
  assert.match(loadingCss, /\.table-loading-overlay\s*\{/);
  for (const file of ['Followups.html', 'Leads.html', 'Archive.html']) {
    const source = read(file);
    assert.match(source, /beginTableLoading\s*\(/, file + ' must show rows while a full refresh is in flight');
    assert.match(source, /finally\s*\{\s*finishLoading\(\)/, file + ' must clear the loading state');
  }
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

console.log('\n' + (tests.length - failures) + '/' + tests.length + ' contract tests passed.');
if (failures) process.exitCode = 1;
