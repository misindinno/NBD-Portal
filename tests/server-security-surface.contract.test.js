/* eslint-disable no-console */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Extract one top-level declaration without depending on whitespace inside it.
function topLevelFunction(source, name) {
  const startPattern = new RegExp('^function\\s+' + escapeRegExp(name) + '\\s*\\(', 'm');
  const match = startPattern.exec(source);
  assert.ok(match, 'Missing top-level function ' + name);
  const tail = source.slice(match.index + match[0].length);
  const next = /^function\s+[A-Za-z_$][\w$]*\s*\(/m.exec(tail);
  return source.slice(match.index, next ? match.index + match[0].length + next.index : source.length);
}

function assertContainsContract(source, functionName, contract, label) {
  const body = topLevelFunction(source, functionName);
  assert.match(body, contract, (label || functionName) + ' is missing its authorization contract');
  return body;
}

const files = {
  api: read('src/server/Api.js'),
  auth: read('src/server/AuthService.js'),
  archive: read('src/server/ArchiveService.js'),
  bulk: read('src/BulkService.js'),
  code: read('src/server/Code.js'),
  config: read('src/server/ConfigService.js'),
  followup: read('src/server/FollowupService.js'),
  index: read('src/server/IndexService.js'),
  lead: read('src/server/LeadService.js'),
  nbd: read('src/server/NbdPushService.js'),
  sheetDb: read('src/server/SheetDB.js'),
  visit: read('src/server/VisitService.js'),
  whatsapp: read('src/server/WhatsAppService.js'),
  bigQuery: read('src/server/BigQueryService.js')
};

const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

test('central role and permission helpers require trusted API identity', () => {
  for (const helper of ['requireRole', 'requireConfigEditor', 'requireUserManager']) {
    const body = topLevelFunction(files.auth, helper);
    assert.match(body, /TRUSTED_WRITE_EMAIL/, helper + ' must resolve identity from trusted write context');
    assert.match(body, /Direct write calls are disabled/, helper + ' must reject a direct browser call');
    assert.doesNotMatch(body, /getCurrentUserByEmail_\(\s*email\s*\)/, helper + ' must not trust a caller email');
  }

  const compatibilityHelper = topLevelFunction(files.auth, 'requireRoleForEmail_');
  assert.match(compatibilityHelper, /return\s+requireRole\(\s*allowedRoles\s*\)/);
  assert.doesNotMatch(compatibilityHelper, /getCurrentUserByEmail_\(\s*email\s*\)/);

  const visitActor = topLevelFunction(files.visit, '_visitActor_');
  assert.match(visitActor, /TRUSTED_WRITE_EMAIL/);
  assert.match(visitActor, /Direct write calls are disabled/);
  assert.doesNotMatch(visitActor, /getCurrentUserByEmail_\(\s*email\s*\)/);
});

test('critical domain mutation surfaces reject direct browser execution', () => {
  const contracts = [
    [files.lead, 'saveLead', /requireRole\(/],
    [files.lead, 'updateLeadStage', /requireRole\(/],
    [files.lead, 'moveLeadStageWithFields', /requireRole\(/],
    [files.lead, 'deleteLead', /TRUSTED_WRITE_EMAIL/],
    [files.lead, 'saveLeadStageFields', /TRUSTED_WRITE_EMAIL/],
    [files.archive, 'archiveLead', /TRUSTED_WRITE_EMAIL/],
    [files.archive, 'restoreArchivedLead', /TRUSTED_WRITE_EMAIL/],
    [files.followup, 'saveFollowup', /requireRoleForEmail_\(/],
    [files.followup, 'markFollowupDone', /requireRoleForEmail_\(/],
    [files.visit, 'saveVisit', /_visitActor_\(/],
    [files.visit, 'updateVisit', /_visitActor_\(/],
    [files.visit, 'deleteVisit', /_visitActor_\(/],
    [files.config, 'addConfig', /requireConfigEditor\(/],
    [files.config, 'updateConfigStatus', /requireConfigEditor\(/],
    [files.config, 'savePortalSettings', /requireConfigEditor\(/],
    [files.config, 'saveStage', /requireConfigEditor\(/],
    [files.config, 'reorderStages', /requireConfigEditor\(/],
    [files.config, 'saveFieldConfig', /requireConfigEditor\(/],
    [files.code, '_saveUser', /requireUserManager\(/],
    [files.nbd, 'pushLeadToNbd', /requireRoleForEmail_\(/],
    [files.bulk, 'saveBulkRows', /assertServerContext_\(/],
    [files.bulk, 'createBulkFollowupOnlyRow', /assertServerContext_\(/]
  ];

  for (const [source, functionName, guard] of contracts) {
    assertContainsContract(source, functionName, guard);
  }

  const contextGuard = topLevelFunction(files.sheetDb, 'assertServerContext_');
  assert.match(contextGuard, /SERVER_CONTEXT_DEPTH\s*<=\s*0/);
  assert.match(contextGuard, /Direct sheet access is not allowed/);
});

test('administrator maintenance entry points require the container-admin gate', () => {
  const adminFunctions = [
    [files.code, 'updatePermissions'],
    [files.code, 'pushUpdate'],
    [files.code, 'setupSheets'],
    [files.auth, 'migrateUserPortalAccess'],
    [files.index, 'rebuildAllIndexes'],
    [files.followup, 'reopenClosedNonFinalFollowupsNextMonday'],
    [files.bigQuery, 'bqSeedFromMenu'],
    [files.bigQuery, 'bqBenchmarkFromMenu']
  ];

  for (const [source, functionName] of adminFunctions) {
    assertContainsContract(source, functionName, /requireContainerAdmin_\(/);
  }
});

test('authenticated API mutation wrappers establish trusted write context', () => {
  const wrappers = {
    apiSaveLead: 'saveLead',
    apiSaveLeadStageFields: 'saveLeadStageFields',
    apiDeleteLead: 'deleteLead',
    apiArchiveLead: 'archiveLead',
    apiArchiveLeads: 'archiveLead',
    apiRestoreArchivedLead: 'restoreArchivedLead',
    apiUpdateLeadStage: 'updateLeadStage',
    apiMoveLeadStageWithFields: 'moveLeadStageWithFields',
    apiSaveVisit: 'saveVisit',
    apiUpdateVisit: 'updateVisit',
    apiDeleteVisit: 'deleteVisit',
    apiSavePortalSettings: 'savePortalSettings',
    apiAddConfig: 'addConfig',
    apiUpdateConfigStatus: 'updateConfigStatus',
    apiSaveStage: 'saveStage',
    apiReorderStages: 'reorderStages',
    apiSaveFieldConfig: 'saveFieldConfig',
    apiSaveUser: '_saveUser',
    apiSaveFollowupDirect: 'saveFollowup',
    apiMarkFollowupDoneDirect: 'markFollowupDone',
    apiPushLeadToNbd: 'pushLeadToNbd',
    apiSaveBulkRows: 'saveBulkRows',
    apiCreateBulkFollowupOnlyRow: 'createBulkFollowupOnlyRow'
  };

  for (const [wrapper, target] of Object.entries(wrappers)) {
    const body = topLevelFunction(files.api, wrapper);
    assert.match(body, /withTrustedWriteUser_\(\s*user\.email\s*,/, wrapper + ' must establish trusted identity');
    assert.match(body, new RegExp('\\b' + escapeRegExp(target) + '\\s*\\('), wrapper + ' must call ' + target);
  }
});

test('password login is throttled and resets failures after successful authentication', () => {
  const login = topLevelFunction(files.api, 'apiLogin');
  assert.match(login, /assertLoginAllowed_\(\s*email\s*\)/);
  assert.match(login, /recordLoginFailure_\(\s*email\s*\)/);
  assert.match(login, /clearLoginFailures_\(\s*email\s*\)/);

  const limiter = topLevelFunction(files.auth, 'assertLoginAllowed_');
  assert.match(limiter, /AUTH_LOGIN_ATTEMPT_LIMIT/);
  assert.match(files.auth, /const\s+AUTH_LOGIN_ATTEMPT_WINDOW\s*=\s*300/);
});
test('WhatsApp credentials come only from Script Properties', () => {
  const configBody = topLevelFunction(files.whatsapp, '_waConfig_');
  for (const key of ['WA_GROUP_ID', 'MAS_USERNAME', 'MAS_PASSWORD', 'MAS_API_KEY']) {
    assert.match(configBody, new RegExp("getProperty\\(\\s*['\"]" + key + "['\"]\\s*\\)"), 'Missing Script Property ' + key);
  }

  assert.doesNotMatch(
    files.whatsapp,
    /\b(?:groupId|username|password|apiKey)\s*:\s*['"`]\s*[^'"`\s][^'"`]*['"`]/i,
    'WhatsApp credential-like fields must not contain non-empty string literals'
  );
  assert.doesNotMatch(
    files.whatsapp,
    /\b(?:WA_GROUP_ID|MAS_USERNAME|MAS_PASSWORD|MAS_API_KEY)\b\s*=\s*['"`][^'"`]+['"`]/,
    'WhatsApp secret identifiers must not be assigned literal values'
  );
});

test('doGet and Google redirect preserve browser and token security boundaries', () => {
  const doGet = topLevelFunction(files.code, 'doGet');
  assert.doesNotMatch(doGet, /XFrameOptionsMode\s*\.\s*ALLOWALL/);
  assert.doesNotMatch(doGet, /setXFrameOptionsMode\s*\(/);
  assert.match(doGet, /_serverHtmlEscape_\(\s*err\.message\s*\)/);

  const redirect = topLevelFunction(files.code, '_handleGoogleAuthRedirect_');
  assert.match(redirect, /\^\[A-Za-z0-9_-\]\+\\\.\[A-Za-z0-9_-\]\+\$/);
  assert.match(redirect, /JSON\.stringify\(\s*tokenText\s*\)/);
  assert.doesNotMatch(redirect, /replace\(\/\[\^a-f0-9\]/i);
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

console.log('\n' + (tests.length - failures) + '/' + tests.length + ' security contract tests passed.');
if (failures) process.exitCode = 1;
