/* eslint-disable no-console */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function absolute(relativePath) {
  return path.join(ROOT, relativePath);
}

function read(relativePath) {
  const file = absolute(relativePath);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function topLevelFunction(source, name) {
  const startPattern = new RegExp('^function\\s+' + escapeRegExp(name) + '\\s*\\(', 'm');
  const match = startPattern.exec(source);
  assert.ok(match, 'Missing top-level function ' + name);
  const tail = source.slice(match.index + match[0].length);
  const next = /^function\s+[A-Za-z_$][\w$]*\s*\(/m.exec(tail);
  return source.slice(match.index, next ? match.index + match[0].length + next.index : source.length);
}

function inlineScripts(html) {
  return Array.from(String(html).matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi), match => match[1]);
}

function declaredClientLimits(source) {
  const limits = {};
  for (const key of ['events', 'rpcs', 'reportLength']) {
    const match = String(source).match(new RegExp('\\b' + key + '\\s*:\\s*(\\d+)'));
    assert.ok(match, 'Diagnostics LIMITS must declare ' + key);
    limits[key] = Number(match[1]);
    assert.ok(Number.isSafeInteger(limits[key]) && limits[key] > 0, key + ' limit must be a positive integer');
  }
  assert.ok(limits.events <= 200, 'Client event history must remain operationally bounded');
  assert.ok(limits.rpcs <= 100, 'Client RPC history must remain operationally bounded');
  assert.ok(limits.reportLength <= 64 * 1024, 'Shareable report body must remain at most 64 KiB');
  return limits;
}
function mockElement(tagName) {
  return {
    tagName: String(tagName || 'div').toUpperCase(),
    children: [],
    dataset: {},
    style: {},
    attributes: {},
    textContent: '',
    appendChild(child) { this.children.push(child); child.parentNode = this; return child; },
    removeChild(child) { this.children = this.children.filter(item => item !== child); },
    remove() { if (this.parentNode) this.parentNode.removeChild(this); },
    setAttribute(name, value) { this.attributes[name] = String(value); },
    addEventListener() {},
    focus() {},
    select() {}
  };
}

function loadClientDiagnostics(source) {
  assert.ok(source.trim(), 'Missing src/Diagnostics.html');
  const scripts = inlineScripts(source);
  assert.ok(scripts.length, 'Diagnostics.html must contain an inline script');

  const listeners = {};
  const body = mockElement('body');
  const documentElement = mockElement('html');
  const document = {
    body,
    documentElement,
    readyState: 'loading',
    title: 'Diagnostics contract portal',
    createElement: mockElement,
    createTextNode(text) { const node = mockElement('#text'); node.textContent = String(text); return node; },
    getElementById() { return null; },
    querySelector() { return null; },
    addEventListener(type, handler) { (listeners['document:' + type] ||= []).push(handler); }
  };

  let clock = 1000;
  const context = vm.createContext({
    console: { log() {}, warn() {}, error() {} },
    document,
    navigator: {
      userAgent: 'diagnostics-contract-browser',
      clipboard: { writeText: async () => undefined }
    },
    location: {
      href: 'https://portal.invalid/exec?token=URL_TOKEN_SECRET&password=URL_PASSWORD_SECRET',
      origin: 'https://portal.invalid',
      pathname: '/exec',
      reload() {}
    },
    performance: { now: () => ++clock },
    crypto: { randomUUID: () => 'client-request-id' },
    Date,
    Error,
    JSON,
    Math,
    Promise,
    URL,
    TextEncoder,
    setTimeout: () => 1,
    clearTimeout() {},
    setInterval: () => 1,
    clearInterval() {},
    addEventListener(type, handler, options) {
      (listeners[type] ||= []).push({ handler, options });
    },
    removeEventListener() {},
    sessionStorage: {
      getItem: () => 'SESSION_STORAGE_TOKEN_SECRET',
      setItem() {},
      removeItem() {}
    },
    localStorage: {
      getItem: () => 'LOCAL_STORAGE_TOKEN_SECRET',
      setItem() {},
      removeItem() {}
    }
  });
  context.window = context;
  context.self = context;
  document.defaultView = context;

  scripts.forEach((script, index) => vm.runInContext(script, context, {
    filename: 'Diagnostics.html#script-' + (index + 1)
  }));
  return { diagnostics: context.PortalDiagnostics, listeners };
}

const files = {
  index: read('src/Index.html'),
  client: read('src/Diagnostics.html'),
  appCore: read('src/AppCore.html'),
  api: read('src/server/Api.js'),
  architecture: read('src/server/ArchitectureCore.js'),
  server: read('src/server/DebugService.js'),
  sheetDb: read('src/server/SheetDB.js')
};

const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

test('Diagnostics is included before dependencies and application modules', () => {
  assert.ok(files.client, 'Missing src/Diagnostics.html');
  const includeAt = files.index.search(/<\?!=\s*include\(\s*['"]Diagnostics['"]\s*\)\s*;?\s*\?>/);
  const firstDependencyAt = files.index.search(/<script\s+src=/i);
  const appCoreAt = files.index.search(/include\(\s*['"]AppCore['"]\s*\)/);
  assert.ok(includeAt >= 0, 'Index.html must include Diagnostics');
  assert.ok(firstDependencyAt < 0 || includeAt < firstDependencyAt,
    'Diagnostics must load before remote script dependencies');
  assert.ok(appCoreAt < 0 || includeAt < appCoreAt,
    'Diagnostics must load before AppCore and the rest of the application');
});

test('client report is bounded and redacts sensitive values at runtime', () => {
  const { diagnostics } = loadClientDiagnostics(files.client);
  const limits = declaredClientLimits(files.client);
  assert.ok(diagnostics && typeof diagnostics === 'object', 'Diagnostics must expose window.PortalDiagnostics');
  for (const method of [
    'record', 'getReport', 'formatReport', 'rpcStart', 'rpcSuccess', 'rpcFailure',
    'phase', 'resetStartupWatchdog', 'showRecoveryPanel'
  ]) {
    assert.equal(typeof diagnostics[method], 'function', 'PortalDiagnostics.' + method + ' must be a function');
  }

  const secrets = {
    token: 'CLIENT_TOKEN_VALUE_MUST_NOT_LEAK',
    password: 'CLIENT_PASSWORD_VALUE_MUST_NOT_LEAK',
    spreadsheetId: '1CLIENT_SPREADSHEET_IDENTIFIER_MUST_NOT_LEAK_987654321'
  };
  for (let i = 0; i < 300; i++) {
    diagnostics.record('contract-event', {
      index: i,
      token: secrets.token,
      password: secrets.password,
      spreadsheetId: secrets.spreadsheetId,
      authSigningSecretPresent: true,
      message: 'x'.repeat(5000)
    });
  }

  const rpc = diagnostics.rpcStart('apiDiagnosticPing');
  diagnostics.rpcSuccess(rpc, {
    operation: 'apiDiagnosticPing',
    requestId: 'server-request-id',
    meta: { requestId: 'server-request-id', operation: 'apiDiagnosticPing', durationMs: 17 }
  });

  const report = diagnostics.getReport();
  assert.ok(report && typeof report === 'object' && !Array.isArray(report),
    'getReport() must return a structured object');
  assert.ok(Array.isArray(report.events), 'Diagnostic report must expose a bounded events array');
  assert.ok(Array.isArray(report.rpcs), 'Diagnostic report must expose a bounded RPC array');
  assert.ok(report.events.length <= limits.events, 'Diagnostic event history exceeds its declared limit');
  assert.ok(report.rpcs.length <= limits.rpcs, 'Diagnostic RPC history exceeds its declared limit');

  const serialized = JSON.stringify(report);
  const formatted = diagnostics.formatReport();
  assert.equal(typeof formatted, 'string', 'formatReport() must return the shareable text report');
  assert.ok(Buffer.byteLength(formatted, 'utf8') <= limits.reportLength + 256,
    'Formatted report exceeds its declared body limit plus fixed markers');
  for (const secret of Object.values(secrets)) {
    assert.ok(!serialized.includes(secret), 'Diagnostic report leaked ' + secret);
    assert.ok(!formatted.includes(secret), 'Formatted report leaked ' + secret);
  }
  assert.match(serialized, /"authSigningSecretPresent":true/,
    'Safe credential-presence booleans must remain visible without exposing values');
  for (const browserSecret of [
    'URL_TOKEN_SECRET', 'URL_PASSWORD_SECRET',
    'SESSION_STORAGE_TOKEN_SECRET', 'LOCAL_STORAGE_TOKEN_SECRET'
  ]) {
    assert.ok(!serialized.includes(browserSecret), 'Diagnostic report leaked browser secret ' + browserSecret);
    assert.ok(!formatted.includes(browserSecret), 'Formatted report leaked browser secret ' + browserSecret);
  }
  assert.match(serialized, /server-request-id/, 'RPC report must preserve the server request ID for correlation');
});

test('global script, resource, and unhandled rejection failures are captured', () => {
  assert.match(files.client, /addEventListener\(\s*['"]error['"]/,
    'Diagnostics must capture global error events');
  assert.match(files.client, /addEventListener\(\s*['"]unhandledrejection['"]/,
    'Diagnostics must capture unhandled promise rejections');
  assert.match(files.client, /event\.target|target\s*=\s*event/i,
    'The error handler must inspect event.target for resource failures');
  assert.match(files.client, /tagName/i, 'Resource failures must record the failed element type');
  assert.match(files.client, /\bsrc\b|\bhref\b/i, 'Resource failures must record a sanitized resource location');
  assert.match(files.client, /addEventListener\([\s\S]{0,160}['"]error['"][\s\S]{0,800}(?:true|capture\s*:\s*true)/i,
    'Resource error capture must run in the capture phase');
});

test('startup watchdog checkpoints reset phase budget and recovered state', () => {
  const { diagnostics } = loadClientDiagnostics(files.client);
  diagnostics.resetStartupWatchdog('startup.initial-page');
  let report = diagnostics.getReport();
  assert.equal(report.startupWatchdog.checkpoint, 'startup.initial-page');
  assert.equal(report.startupWatchdog.active, true);
  assert.equal(report.startupWatchdog.budgetMs, diagnostics.limits.watchdogMs);

  diagnostics.showRecoveryPanel('Temporary startup timeout');
  diagnostics.markReady({ mode: 'app', page: 'today' });
  report = diagnostics.getReport();
  assert.equal(report.recoveryReason, '', 'Recovered startup must not retain an active recovery reason');
  assert.equal(report.startupWatchdog.active, false);
  assert.ok(report.events.some(event => event.type === 'startup.recovered'),
    'Recovered startup must retain an audit event for the prior timeout');
});

test('RPC diagnostics record client timing and server correlation metadata', () => {
  assert.match(files.appCore, /PortalDiagnostics/,
    'AppCore must integrate the early diagnostics object');
  assert.match(files.appCore, /diagnostics\.rpcStart\(/,
    'RPC wrapper must start a diagnostic timing record');
  assert.match(files.appCore, /diagnostics\.rpcSuccess\(/,
    'RPC wrapper must finish successful diagnostics');
  assert.match(files.appCore, /diagnostics\.rpcFailure\(/,
    'RPC wrapper must finish failed diagnostics');
  assert.match(files.appCore, /requestId[\s\S]{0,200}meta|meta[\s\S]{0,200}requestId/,
    'RPC wrapper must retain response metadata containing requestId');
  assert.match(files.client, /durationMs[\s\S]{0,300}Date\.now|Date\.now[\s\S]{0,300}durationMs/i,
    'Client diagnostics must capture client-observed duration');
  assert.match(files.architecture, /requestId\s*:\s*Utilities\.getUuid\(\)/,
    'Server request context must generate a request ID');
  assert.match(files.architecture, /durationMs\s*:/,
    'Server response metadata must expose server duration');
});

test('startup failure UI exposes bounded recovery actions', () => {
  assert.match(files.client, /function\s+showRecoveryPanel\s*\(/,
    'Diagnostics must expose a startup failure panel');
  assert.match(files.client, /reload/i, 'Startup recovery must offer reload');
  assert.match(files.client, /signInAgain|sign in again|clear(?:Session|Auth)/i,
    'Startup recovery must offer a safe session reset');
  assert.match(files.client, /copyReport|copy debug report/i,
    'Startup recovery must offer report copy');
  assert.match(files.client, /apiDiagnosticPing|callDiagnosticPing|runChecks/i,
    'Startup recovery must offer or record a guarded health check');
  assert.match(files.client, /function\s+startWatchdog\s*\(/,
    'Diagnostics must own the startup watchdog');
  assert.match(files.client, /watchdogCheckpoint/,
    'Startup watchdog reports must identify the phase checkpoint');
  assert.match(read('src/AppAuth.html'), /resetStartupWatchdog\(\s*['"]startup\.initial-page['"]\s*\)/,
    'The initial page must receive a fresh watchdog budget after bootstrap');
});

test('public-safe ping and administrator snapshot APIs use the correct guards', () => {
  const ping = topLevelFunction(files.api, 'apiDiagnosticPing');
  assert.match(ping, /apiGuard_\(\s*['"]apiDiagnosticPing['"]/);
  assert.match(ping, /publicDiagnosticPing_\(/,
    'Public diagnostics ping must delegate to the payload-safe service');
  assert.doesNotMatch(ping, /_apiUser\(|CLIENT_CONFIG|SHEET_NAMES|SpreadsheetApp/,
    'Pre-login ping must not require identity or expose deployment/data-store details');

  const snapshot = topLevelFunction(files.api, 'apiGetDiagnosticSnapshot');
  assert.match(snapshot, /apiGuard_\(\s*['"]apiGetDiagnosticSnapshot['"]/);
  assert.match(snapshot, /requireDiagnosticAdmin_\(\s*_apiUser\(\)\s*\)/,
    'Diagnostics snapshot must be administrator-only');
  assert.match(snapshot, /adminDiagnosticSnapshot_\(/,
    'Diagnostics snapshot must delegate to the sanitized diagnostics service');
});

test('server diagnostic sanitization is executable and spans are bounded', () => {
  assert.ok(files.server, 'Missing src/server/DebugService.js');
  assert.match(files.server, /function\s+sanitizeDiagnosticValue_\s*\(/);
  assert.match(files.server, /function\s+diagnosticLog_\s*\(/);
  assert.match(files.server, /function\s+withDiagnosticSpan_\s*\(/);
  const limitMatch = files.server.match(/(?:const|let|var)\s+DIAGNOSTIC_MAX_SPANS_?\s*=\s*(\d+)/);
  assert.ok(limitMatch, 'DebugService must declare DIAGNOSTIC_MAX_SPANS');
  assert.ok(Number(limitMatch[1]) > 0 && Number(limitMatch[1]) <= 100,
    'Server diagnostic span history must be bounded to 1..100 records');
  assert.match(topLevelFunction(files.server, 'diagnosticLog_'), /sanitizeDiagnosticValue_\(/,
    'Structured diagnostic logs must sanitize details before logging');

  const captured = [];
  const context = vm.createContext({
    console: { log: value => captured.push(value), error: value => captured.push(value) },
    Logger: { log: value => captured.push(value) },
    Utilities: { getUuid: () => 'server-contract-request-id' },
    Date,
    JSON,
    Math
  });
  vm.runInContext(files.server, context, { filename: 'DebugService.js' });
  assert.equal(typeof context.sanitizeDiagnosticValue_, 'function');
  const sanitized = context.sanitizeDiagnosticValue_({
    token: 'SERVER_TOKEN_VALUE_MUST_NOT_LEAK',
    password: 'SERVER_PASSWORD_VALUE_MUST_NOT_LEAK',
    spreadsheetId: '1SERVER_SPREADSHEET_IDENTIFIER_MUST_NOT_LEAK_123456789',
    credentialPresent: true,
    nested: { authorization: 'Bearer SERVER_AUTHORIZATION_MUST_NOT_LEAK' },
    message: 'y'.repeat(10000)
  });
  const serialized = JSON.stringify(sanitized);
  for (const secret of [
    'SERVER_TOKEN_VALUE_MUST_NOT_LEAK',
    'SERVER_PASSWORD_VALUE_MUST_NOT_LEAK',
    '1SERVER_SPREADSHEET_IDENTIFIER_MUST_NOT_LEAK_123456789',
    'SERVER_AUTHORIZATION_MUST_NOT_LEAK'
  ]) assert.ok(!serialized.includes(secret), 'Server diagnostics leaked ' + secret);
  assert.equal(sanitized.credentialPresent, true,
    'Server diagnostics must preserve safe credential-presence booleans');
  assert.ok(Buffer.byteLength(serialized, 'utf8') <= 8192,
    'A single sanitized server diagnostic payload must remain bounded');
});

test('SheetDB core reads and writes are wrapped in diagnostic spans', () => {
  const contracts = {
    getAllRows: 'read_all',
    insertRow: 'write_insert',
    updateRow: 'write_update',
    deleteRow: 'write_delete',
    deleteAllRowsWhere: 'write_delete_many'
  };
  for (const [functionName, operation] of Object.entries(contracts)) {
    const body = topLevelFunction(files.sheetDb, functionName);
    assert.match(body, /withSheetDbTiming_\(/, functionName + ' must use the SheetDB tracing wrapper');
    assert.match(body, new RegExp("['\"]" + escapeRegExp(operation) + "['\"]"),
      functionName + ' must use stable operation name ' + operation);
  }
  const timing = topLevelFunction(files.sheetDb, 'withSheetDbTiming_');
  assert.match(timing, /withDiagnosticSpan_\(\s*['"]sheetdb\./,
    'SheetDB tracing wrapper must emit a diagnostic span');
  assert.doesNotMatch(timing, /rowObj|updates|values|idValue|payload/,
    'Sheet tracing metadata must not include row values or update payloads');
});

test('debug panel renders dynamic text safely and diagnostic snapshots export no identifier values', () => {
  assert.match(files.client, /reasonNode\.textContent\s*=\s*recoveryReason/,
    'Diagnostics panel must render the dynamic recovery reason with textContent');
  assert.match(files.client, /output\.textContent\s*=/,
    'Diagnostics panel must render dynamic check/report output with textContent');
  assert.doesNotMatch(files.client, /\.innerHTML\s*=\s*(?:recoveryReason|reason|error|formatReport\()/,
    'Diagnostics panel must not parse dynamic report/error text as HTML');
  assert.doesNotMatch(files.client, /\+\s*(?:safeReason|recoveryReason)|\$\{\s*(?:safeReason|recoveryReason)/,
    'Static panel markup must not interpolate dynamic failure details');

  const snapshot = topLevelFunction(files.server, 'adminDiagnosticSnapshot_');
  assert.doesNotMatch(snapshot, /(?:spreadsheetId|spreadsheet ID)\s*:/i,
    'Server diagnostic snapshots must not export spreadsheet identifier values');
  assert.match(snapshot, /!!\s*\(\s*config\s*&&\s*config\.SPREADSHEET_ID\s*\)/,
    'Snapshot may expose main data-store configuration only as a boolean');
  assert.match(snapshot, /!!\s*\(\s*config\s*&&\s*config\.USER_DATABASE_SPREADSHEET_ID\s*\)/,
    'Snapshot may expose user data-store configuration only as a boolean');

  assert.match(files.client, /token|password|authorization|cookie/i,
    'Client redaction rules must explicitly cover credential keys');
  assert.match(files.server, /token|password|authorization|cookie|spreadsheet.?id/i,
    'Server redaction rules must explicitly cover credential and spreadsheet ID keys');
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

console.log('\n' + (tests.length - failures) + '/' + tests.length + ' diagnostics contract tests passed.');
if (failures) process.exitCode = 1;
