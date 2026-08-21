// Server-only diagnostics. Public entry points live in Api.js.

const DIAGNOSTIC_VERSION_ = 1;
const DIAGNOSTIC_MAX_SPANS_ = 40;
const DIAGNOSTIC_MAX_ERRORS_ = 20;
const DIAGNOSTIC_SLOW_REQUEST_MS_ = 2500;
const DIAGNOSTIC_SLOW_SPAN_MS_ = 1200;
const DIAGNOSTIC_ERROR_CACHE_KEY_ = 'PORTAL_DIAGNOSTIC_ERRORS_V1';
const DIAGNOSTIC_ERROR_CACHE_TTL_SECONDS_ = 21600;

function diagnosticErrorCategory_(error) {
  const message = String(error && error.message || error || '').toLowerCase();
  if (/session_expired|session expired/.test(message)) return 'AUTH.SESSION_EXPIRED';
  if (/access_denied|permission denied|not authorized|forbidden/.test(message)) return 'AUTH.FORBIDDEN';
  if (/required sheet not found|sheet.+not found/.test(message)) return 'DATA.SHEET_MISSING';
  if (/not found/.test(message)) return 'DATA.NOT_FOUND';
  if (/schema|header|column/.test(message)) return 'DATA.SCHEMA_INVALID';
  if (/required|invalid|must be|cannot|maximum|minimum/.test(message)) return 'VALIDATION.INVALID_INPUT';
  if (/quota|rate.?limit|too many|429|exhausted/.test(message)) return 'PLATFORM.QUOTA';
  if (/timed?\s*out|deadline|execution time/.test(message)) return 'PLATFORM.TIMEOUT';
  if (/urlfetch|http\s*[45]\d\d|integration|external request/.test(message)) return 'INTEGRATION.FAILURE';
  return 'INTERNAL.UNEXPECTED';
}

function redactDiagnosticText_(value) {
  let text = String(value == null ? '' : value);
  text = text.replace(/Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [REDACTED]');
  text = text.replace(/([?&](?:token|access_token|id_token|api_key|key|secret|password)=)[^&#\s]+/gi, '$1[REDACTED]');
  text = text.replace(/((?:password|passcode|token|secret|api.?key|authorization)\s*[:=]\s*)[^\s,;}\]]+/gi, '$1[REDACTED]');
  text = text.replace(/\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}(?:\.[A-Za-z0-9_-]{20,})?\b/g, '[REDACTED_TOKEN]');
  text = text.replace(/https?:\/\/\S+/gi, '[REDACTED_URL]');
  text = text.replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[REDACTED_ID]');
  text = text.replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[REDACTED_EMAIL]');
  text = text.replace(/\+?\d[\d\s().-]{7,}\d/g, '[REDACTED_PHONE]');
  return text.slice(0, 800);
}

function safeClientErrorMessage_(error) {
  const category = diagnosticErrorCategory_(error);
  const sanitized = redactDiagnosticText_(error && error.message || error || 'Request failed.');
  if (category === 'AUTH.SESSION_EXPIRED') return 'SESSION_EXPIRED';
  if (category === 'AUTH.FORBIDDEN') return 'Access denied.';
  if (category === 'VALIDATION.INVALID_INPUT') return sanitized || 'Invalid request.';
  if (category === 'PLATFORM.QUOTA') return 'The service is temporarily rate limited. Please retry.';
  if (category === 'PLATFORM.TIMEOUT') return 'The request timed out. Please retry.';
  if (category === 'DATA.NOT_FOUND') return 'The requested record was not found.';
  if (category === 'DATA.SHEET_MISSING' || category === 'DATA.SCHEMA_INVALID') {
    return 'The portal data configuration is invalid. Contact an administrator.';
  }
  if (category === 'INTEGRATION.FAILURE') return 'An external service request failed.';
  return 'Request failed. Please retry or contact an administrator.';
}

function diagnosticErrorSummary_(error) {
  const category = diagnosticErrorCategory_(error);
  const summaries = {
    'AUTH.SESSION_EXPIRED': 'The authenticated session expired.',
    'AUTH.FORBIDDEN': 'The request was not authorized.',
    'DATA.SHEET_MISSING': 'A required data store is unavailable.',
    'DATA.NOT_FOUND': 'A requested record was not found.',
    'DATA.SCHEMA_INVALID': 'A data store schema check failed.',
    'VALIDATION.INVALID_INPUT': 'Request validation failed.',
    'PLATFORM.QUOTA': 'A platform quota limited the request.',
    'PLATFORM.TIMEOUT': 'The request exceeded its execution deadline.',
    'INTEGRATION.FAILURE': 'An external integration failed.',
    'INTERNAL.UNEXPECTED': 'An unexpected server error occurred.'
  };
  return summaries[category] || summaries['INTERNAL.UNEXPECTED'];
}

function safeDiagnosticStack_(error) {
  const stack = String(error && error.stack || '');
  if (!stack) return '';
  return stack.split('\n').slice(1, 8).map(redactDiagnosticText_).join('\n').slice(0, 800);
}

function isDiagnosticSensitiveKey_(key) {
  return /password|passcode|token|secret|authorization|cookie|credential|api.?key|client.?id|spreadsheet.?id|folder.?id|drive.?id|user.?id|lead.?id|follow.?up.?id/i.test(String(key || ''));
}

function sanitizeDiagnosticValue_(value, key, depth, seen) {
  const level = Number(depth || 0);
  const visited = seen || [];
  if (key === 'requestId') return String(value == null ? '' : value).slice(0, 64);
  if (isDiagnosticSensitiveKey_(key)) {
    return typeof value === 'boolean' ? value : '[REDACTED]';
  }
  if (value === null || value === undefined || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return redactDiagnosticText_(value);
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value.toISOString();
  if (value instanceof Error) {
    return {
      category: diagnosticErrorCategory_(value),
      summary: diagnosticErrorSummary_(value),
      fingerprint: diagnosticErrorFingerprint_(value)
    };
  }
  if (typeof value === 'function') return '[FUNCTION]';
  if (level >= 4) return '[TRUNCATED]';
  if (visited.indexOf(value) !== -1) return '[CIRCULAR]';
  const nextSeen = visited.concat([value]);
  if (Array.isArray(value)) {
    return value.slice(0, 20).map(item => sanitizeDiagnosticValue_(item, '', level + 1, nextSeen));
  }
  const output = {};
  Object.keys(value).slice(0, 30).forEach(property => {
    output[property] = sanitizeDiagnosticValue_(value[property], property, level + 1, nextSeen);
  });
  return output;
}

function diagnosticErrorFingerprint_(error, operation) {
  const category = diagnosticErrorCategory_(error);
  const normalized = String(error && error.message || error || 'unknown')
    .toLowerCase()
    .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/g, '<email>')
    .replace(/https?:\/\/\S+/g, '<url>')
    .replace(/[a-f0-9]{8}-[a-f0-9-]{27,}/g, '<uuid>')
    .replace(/\b\d+\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .slice(0, 300);
  const source = category + '|' + String(operation || currentDiagnosticOperation_()) + '|' + normalized;
  try {
    const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, source, Utilities.Charset.UTF_8);
    return bytes.slice(0, 8).map(byte => ('0' + ((byte + 256) % 256).toString(16)).slice(-2)).join('');
  } catch (_) {
    return category.replace(/[^A-Z]/g, '').slice(0, 12) || 'UNEXPECTED';
  }
}

function currentDiagnosticOperation_() {
  return REQUEST_CONTEXT_ && REQUEST_CONTEXT_.operation ? REQUEST_CONTEXT_.operation : 'background';
}

function diagnosticLog_(severity, category, event, details) {
  try {
    const payload = sanitizeDiagnosticValue_({
      severity: String(severity || 'INFO').toUpperCase(),
      category: String(category || 'DIAGNOSTIC.EVENT'),
      event: String(event || 'diagnostic'),
      timestamp: new Date().toISOString(),
      context: typeof requestMeta_ === 'function' ? requestMeta_({ includeSpans: false }) : {},
      details: details || {}
    });
    const serialized = JSON.stringify(payload);
    if (payload.severity === 'ERROR') console.error(serialized);
    else if (payload.severity === 'WARN') console.warn(serialized);
    else console.log(serialized);
  } catch (_) {
    try {
      Logger.log('{"severity":"WARN","category":"DIAGNOSTIC.LOG_FAILURE","event":"diagnostic_log_failed"}');
    } catch (_) {}
  }
}
function withDiagnosticSpan_(name, attributes, fn) {
  const startedAt = Date.now();
  let status = 'ok';
  let category = '';
  try {
    return fn();
  } catch (error) {
    status = 'error';
    category = diagnosticErrorCategory_(error);
    throw error;
  } finally {
    const durationMs = Math.max(0, Date.now() - startedAt);
    const span = {
      name: String(name || 'span').slice(0, 80),
      status,
      category: category || undefined,
      durationMs,
      attributes: sanitizeDiagnosticValue_(attributes || {})
    };
    if (REQUEST_CONTEXT_) {
      REQUEST_CONTEXT_.spans = REQUEST_CONTEXT_.spans || [];
      if (REQUEST_CONTEXT_.spans.length < DIAGNOSTIC_MAX_SPANS_) REQUEST_CONTEXT_.spans.push(span);
      else REQUEST_CONTEXT_.droppedSpans = Number(REQUEST_CONTEXT_.droppedSpans || 0) + 1;
    }
    if (durationMs >= DIAGNOSTIC_SLOW_SPAN_MS_) {
      try { diagnosticLog_('WARN', 'PERFORMANCE.SLOW_DEPENDENCY', 'slow_span', span); }
      catch (_) {}
    }
  }
}

function finalizeRequestDiagnostics_(context) {
  if (!context) return;
  const durationMs = Math.max(0, Date.now() - context.startedAt);
  context.durationMs = durationMs;
  if (durationMs >= DIAGNOSTIC_SLOW_REQUEST_MS_) {
    diagnosticLog_('WARN', 'PERFORMANCE.SLOW_REQUEST', 'slow_request', {
      operation: context.operation,
      durationMs,
      spanCount: (context.spans || []).length,
      droppedSpans: Number(context.droppedSpans || 0),
      slowestSpans: (context.spans || []).slice().sort((a, b) => b.durationMs - a.durationMs).slice(0, 5)
    });
  }
}

function recordDiagnosticErrorFingerprint_(error) {
  const category = diagnosticErrorCategory_(error);
  const operation = currentDiagnosticOperation_();
  const fingerprint = diagnosticErrorFingerprint_(error, operation);
  const nowIso = new Date().toISOString();
  try {
    const cache = CacheService.getScriptCache();
    let items = [];
    try { items = JSON.parse(cache.get(DIAGNOSTIC_ERROR_CACHE_KEY_) || '[]'); }
    catch (_) { items = []; }
    if (!Array.isArray(items)) items = [];
    const existing = items.find(item => item.fingerprint === fingerprint && item.operation === operation);
    if (existing) {
      existing.count = Math.min(999999, Number(existing.count || 0) + 1);
      existing.lastSeen = nowIso;
    } else {
      items.unshift({ fingerprint, category, operation, count: 1, lastSeen: nowIso });
    }
    items.sort((a, b) => String(b.lastSeen).localeCompare(String(a.lastSeen)));
    cache.put(DIAGNOSTIC_ERROR_CACHE_KEY_, JSON.stringify(items.slice(0, DIAGNOSTIC_MAX_ERRORS_)), DIAGNOSTIC_ERROR_CACHE_TTL_SECONDS_);
  } catch (_) {}
  return { fingerprint, category, operation };
}

function recentDiagnosticErrors_() {
  try {
    const items = JSON.parse(CacheService.getScriptCache().get(DIAGNOSTIC_ERROR_CACHE_KEY_) || '[]');
    return Array.isArray(items) ? sanitizeDiagnosticValue_(items.slice(0, DIAGNOSTIC_MAX_ERRORS_)) : [];
  } catch (_) {
    return [];
  }
}

function diagnosticSheetLabel_(sheetName) {
  const normalized = typeof normalizeSheetName === 'function' ? normalizeSheetName(sheetName) : String(sheetName || '');
  const keys = Object.keys(SHEET_NAMES || {});
  for (let i = 0; i < keys.length; i++) {
    const candidate = typeof normalizeSheetName === 'function' ? normalizeSheetName(SHEET_NAMES[keys[i]]) : SHEET_NAMES[keys[i]];
    if (String(candidate) === String(normalized)) return keys[i];
  }
  return 'OTHER';
}

function runDiagnosticCheck_(name, fn) {
  const startedAt = Date.now();
  try {
    const data = fn();
    return {
      name,
      status: 'ok',
      durationMs: Math.max(0, Date.now() - startedAt),
      data: sanitizeDiagnosticValue_(data)
    };
  } catch (error) {
    const recorded = recordDiagnosticErrorFingerprint_(error);
    diagnosticLog_('ERROR', recorded.category, 'diagnostic_check_failed', {
      check: name,
      fingerprint: recorded.fingerprint
    });
    return {
      name,
      status: 'error',
      durationMs: Math.max(0, Date.now() - startedAt),
      error: { category: recorded.category, fingerprint: recorded.fingerprint }
    };
  }
}

function publicDiagnosticPing_() {
  return {
    status: 'ok',
    service: 'portal',
    diagnosticsVersion: DIAGNOSTIC_VERSION_,
    serverTime: new Date().toISOString()
  };
}

function requireDiagnosticAdmin_(user) {
  if (!user || String(user.role || '').trim().toUpperCase() !== 'ADMIN') {
    throw new Error('Permission denied. Administrator access is required.');
  }
  return user;
}

function diagnosticRequiredSheetSpecs_() {
  return [
    { label: 'USERS', name: SHEET_NAMES.USERS },
    { label: 'LEADS', name: SHEET_NAMES.LEADS },
    { label: 'FOLLOWUPS', name: SHEET_NAMES.FOLLOWUPS },
    { label: 'FOLLOWUP_HISTORY', name: SHEET_NAMES.FOLLOWUP_HISTORY },
    { label: 'LEAD_ACTIVITY_LOGS', name: SHEET_NAMES.LEAD_ACTIVITY_LOGS },
    { label: 'STAGES', name: SHEET_NAMES.STAGES },
    { label: 'FIELD_CONFIG', name: SHEET_NAMES.FIELD_CONFIG },
    { label: 'CONFIG', name: SHEET_NAMES.CONFIG }
  ];
}

function inspectDiagnosticSheet_(spec) {
  try {
    return withDiagnosticSpan_('diagnostic.sheet_check', { sheet: spec.label, mode: 'metadata' }, () => {
      const sheet = getSheet(spec.name);
      const lastRow = sheet.getLastRow();
      const lastColumn = sheet.getLastColumn();
      const headers = lastColumn > 0 ? sheet.getRange(1, 1, 1, lastColumn).getValues()[0].map(value => String(value || '').trim()) : [];
      const schema = typeof sheetSchemaFor_ === 'function' ? sheetSchemaFor_(spec.name) : null;
      const required = schema && schema.required || [];
      const missing = required.filter(header => headers.indexOf(header) === -1);
      const nonBlank = headers.filter(Boolean);
      const duplicateCount = nonBlank.length - Array.from(new Set(nonBlank)).length;
      return {
        label: spec.label,
        available: true,
        dimensions: { rows: Math.max(0, lastRow - 1), columns: lastColumn },
        headers: {
          count: nonBlank.length,
          valid: nonBlank.length > 0 && missing.length === 0 && duplicateCount === 0 && headers.length === nonBlank.length,
          missingRequired: missing,
          duplicateCount,
          blankCount: Math.max(0, headers.length - nonBlank.length)
        }
      };
    });
  } catch (error) {
    const recorded = recordDiagnosticErrorFingerprint_(error);
    diagnosticLog_('ERROR', recorded.category, 'diagnostic_sheet_check_failed', {
      sheet: spec.label,
      fingerprint: recorded.fingerprint
    });
    return {
      label: spec.label,
      available: false,
      error: { category: recorded.category, fingerprint: recorded.fingerprint }
    };
  }
}

function adminDiagnosticSnapshot_(user) {
  const checks = [
    runDiagnosticCheck_('config', () => {
      const config = typeof CLIENT_CONFIG !== 'undefined' ? CLIENT_CONFIG : null;
      const clientConfigLoaded = !!config;
      const appConfigured = !!(config && config.APP_TITLE);
      const mainDataStoreConfigured = !!(config && config.SPREADSHEET_ID);
      const userDataStoreConfigured = !!(config && config.USER_DATABASE_SPREADSHEET_ID);
      const userSheetConfigured = !!(config && config.USER_DATABASE_SHEET_NAME);
      return {
        healthy: clientConfigLoaded && appConfigured && mainDataStoreConfigured &&
          userDataStoreConfigured && userSheetConfigured,
        clientConfigLoaded,
        appConfigured,
        mainDataStoreConfigured,
        userDataStoreConfigured,
        userSheetConfigured
      };
    }),
    runDiagnosticCheck_('authContext', () => {
      const authenticated = !!user;
      const admin = String(user && user.role || '').toUpperCase() === 'ADMIN';
      return {
        healthy: authenticated && admin,
        authenticated,
        admin,
        role: String(user && user.role || 'UNKNOWN').toUpperCase(),
        sessionBacked: !!_currentApiToken_,
        effectiveUserAvailable: !!Session.getEffectiveUser().getEmail(),
        activeUserAvailable: !!Session.getActiveUser().getEmail()
      };
    }),
    runDiagnosticCheck_('requiredSheets', () => {
      const sheets = diagnosticRequiredSheetSpecs_().map(inspectDiagnosticSheet_);
      return { healthy: sheets.every(sheet => sheet.available && sheet.headers && sheet.headers.valid), sheets };
    }),
    runDiagnosticCheck_('credentialPresence', () => {
      const properties = PropertiesService.getScriptProperties();
      return {
        authSigningSecret: !!properties.getProperty('AUTH_SIGNING_SECRET'),
        googleClientId: !!properties.getProperty('GOOGLE_CLIENT_ID'),
        whatsAppGroupId: !!properties.getProperty('WA_GROUP_ID'),
        whatsAppUsername: !!properties.getProperty('MAS_USERNAME'),
        whatsAppPassword: !!properties.getProperty('MAS_PASSWORD'),
        whatsAppApiKey: !!properties.getProperty('MAS_API_KEY')
      };
    }),
    runDiagnosticCheck_('runtime', () => ({
      engine: 'V8',
      timezone: Session.getScriptTimeZone(),
      locale: Session.getActiveUserLocale(),
      now: new Date().toISOString()
    })),
    runDiagnosticCheck_('recentErrors', () => ({ fingerprints: recentDiagnosticErrors_() }))
  ];
  return {
    status: checks.some(check =>
      check.status === 'error' || (check.data && check.data.healthy === false)
    ) ? 'degraded' : 'ok',
    diagnosticsVersion: DIAGNOSTIC_VERSION_,
    generatedAt: new Date().toISOString(),
    request: typeof requestMeta_ === 'function' ? requestMeta_({ includeSpans: true }) : {},
    checks
  };
}
