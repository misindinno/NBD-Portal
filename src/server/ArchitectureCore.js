// Shared architecture primitives. All helpers are private to Apps Script (trailing _)
// so browser calls must pass through Api.js.

let REQUEST_CONTEXT_ = null;
let SHEET_SCHEMA_CACHE_ = null;
let HEADER_VALIDATION_CACHE_ = {};

function withRequestContext_(operation, fn) {
  const previous = REQUEST_CONTEXT_;
  REQUEST_CONTEXT_ = {
    requestId: Utilities.getUuid(),
    operation: String(operation || 'unknown').slice(0, 100),
    startedAt: Date.now(),
    spans: [],
    droppedSpans: 0,
    errorCategory: ''
  };
  try {
    return fn(REQUEST_CONTEXT_);
  } finally {
    if (typeof finalizeRequestDiagnostics_ === 'function') {
      try { finalizeRequestDiagnostics_(REQUEST_CONTEXT_); }
      catch (_) {}
    }
    REQUEST_CONTEXT_ = previous;
  }
}

function requestMeta_(options) {
  if (!REQUEST_CONTEXT_) return {};
  const meta = {
    requestId: REQUEST_CONTEXT_.requestId,
    operation: REQUEST_CONTEXT_.operation,
    durationMs: Math.max(0, Date.now() - REQUEST_CONTEXT_.startedAt),
    spanCount: (REQUEST_CONTEXT_.spans || []).length,
    droppedSpans: Number(REQUEST_CONTEXT_.droppedSpans || 0)
  };
  if (options && options.includeSpans) {
    meta.spans = (REQUEST_CONTEXT_.spans || []).slice(0, 40);
  }
  return meta;
}

function errorCodeFrom_(error) {
  const message = String(error && error.message || error || 'Unknown error');
  if (/SESSION_EXPIRED/i.test(message)) return 'SESSION_EXPIRED';
  if (/ACCESS_DENIED|permission denied|not authorized/i.test(message)) return 'FORBIDDEN';
  if (/not found/i.test(message)) return 'NOT_FOUND';
  if (/schema|header|column/i.test(message)) return 'DATA_SCHEMA_INVALID';
  if (/required|invalid|must be|cannot|maximum|minimum/i.test(message)) return 'VALIDATION_ERROR';
  if (/quota|rate.?limit|too many|429|exhausted/i.test(message)) return 'RATE_LIMITED';
  return 'INTERNAL_ERROR';
}

function logServerError_(error, details) {
  const category = typeof diagnosticErrorCategory_ === 'function'
    ? diagnosticErrorCategory_(error)
    : errorCodeFrom_(error);
  if (REQUEST_CONTEXT_) REQUEST_CONTEXT_.errorCategory = category;
  const recorded = typeof recordDiagnosticErrorFingerprint_ === 'function'
    ? recordDiagnosticErrorFingerprint_(error)
    : { fingerprint: '', category };
  const payload = {
    severity: 'ERROR',
    category,
    event: 'request_error',
    fingerprint: recorded.fingerprint || '',
    message: typeof diagnosticErrorSummary_ === 'function'
      ? diagnosticErrorSummary_(error)
      : 'An unexpected server error occurred.',
    stack: typeof safeDiagnosticStack_ === 'function' ? safeDiagnosticStack_(error) : '',
    context: requestMeta_({ includeSpans: true }),
    details: details || {}
  };
  if (typeof diagnosticLog_ === 'function') {
    try {
      diagnosticLog_('ERROR', category, 'request_error', payload);
      return;
    } catch (_) {}
  }
  try { console.error(JSON.stringify(payload)); }
  catch (_) { Logger.log(payload.message); }
}

function sheetSchemas_() {
  if (SHEET_SCHEMA_CACHE_) return SHEET_SCHEMA_CACHE_;
  const text = { type: 'string' };
  const date = { type: 'date' };
  const bool = { type: 'boolean' };
  const number = { type: 'number' };
  SHEET_SCHEMA_CACHE_ = {};
  SHEET_SCHEMA_CACHE_[SHEET_NAMES.LEADS] = {
    required: ['Lead ID','Stage ID','Assigned To'],
    fields: {
      'Lead ID': text, 'Stage ID': text, 'Assigned To': text,
      'Lead Status': text, 'Pre-Archive Status': text, 'Is Archived': bool,
      'Archived At': date, 'Created At': date, 'Updated At': date,
      'Stage Updated At': date, 'Last Follow-up Date': date, 'Next Follow-up Date': date
    }
  };
  SHEET_SCHEMA_CACHE_[SHEET_NAMES.FOLLOWUPS] = {
    required: ['Follow-up ID','Lead ID'],
    fields: {
      'Follow-up ID': text, 'Lead ID': text, 'Status': text,
      'Planned Date': date, 'Follow-up Date': date, 'Next Follow-up Date': date,
      'Done Date': date, 'Created At': date, 'Updated At': date
    }
  };
  SHEET_SCHEMA_CACHE_[SHEET_NAMES.FOLLOWUP_HISTORY] = {
    required: ['History ID','Follow-up ID','Lead ID'],
    fields: {
      'History ID': text, 'Follow-up ID': text, 'Lead ID': text,
      'Planned Date': date, 'Done Date': date, 'Next Planned Date': date, 'Created At': date
    }
  };
  SHEET_SCHEMA_CACHE_[SHEET_NAMES.STAGES] = {
    required: ['Stage ID','Stage Name'],
    fields: {
      'Stage ID': text, 'Stage Name': text, 'Stage Order': number,
      'Is Active': bool, 'Is Final Stage': bool, 'Created At': date, 'Updated At': date
    }
  };
  SHEET_SCHEMA_CACHE_[SHEET_NAMES.CONFIG] = {
    required: ['Config ID','Config Type','Value','Status'],
    fields: { 'Config ID': text, 'Config Type': text, 'Value': text, 'Status': text }
  };
  SHEET_SCHEMA_CACHE_[normalizeSheetName(SHEET_NAMES.USERS)] = {
    required: [],
    fields: { 'Can Edit Config': bool, 'Is Active': bool }
  };
  SHEET_SCHEMA_CACHE_[SHEET_NAMES.USER_PORTAL_ACCESS] = {
    required: [],
    fields: {
      'Can Edit Config': bool, 'Can Manage Users': bool, 'Is Active': bool,
      'Created At': date, 'Updated At': date
    }
  };
  SHEET_SCHEMA_CACHE_[SHEET_NAMES.LEAD_ACTIVITY_LOGS] = {
    required: [],
    fields: { 'Created At': date }
  };
  SHEET_SCHEMA_CACHE_[SHEET_NAMES.FIELD_CONFIG] = {
    required: [],
    fields: {
      'Validation Min': number, 'Validation Max': number, 'Max File MB': number,
      'Display Order': number, 'Allow Multiple': bool, 'Is Required': bool,
      'Is Visible': bool, 'Skip Visibility': bool, 'Per Stage': bool
    }
  };
  [SHEET_NAMES.LEAD_FIELD_VALUES, SHEET_NAMES.FOLLOWUP_FIELD_VALUES, SHEET_NAMES.VISIT_FIELD_VALUES].forEach(name => {
    SHEET_SCHEMA_CACHE_[name] = { required: [], fields: { 'Updated At': date } };
  });
  SHEET_SCHEMA_CACHE_[SHEET_NAMES.VISITS] = {
    required: [],
    fields: {
      'DATE': date, 'Created At': date, 'Updated At': date,
      'ACCOMODATION TOUR': number, 'ACCOMODATION STAY': number, 'AMOUNT': number,
      'LEADS': number, 'FSR': number, 'SC': number, 'VISIT': number, 'CONVERSION': number
    }
  };
  [SHEET_NAMES.IDX_LEADS, SHEET_NAMES.IDX_FOLLOWUPS, SHEET_NAMES.IDX_USERS].forEach(name => {
    SHEET_SCHEMA_CACHE_[name] = {
      required: [],
      fields: {
        'Row Number': number, 'Is Active': bool, 'Updated At': date,
        'Next Follow-up Date': date, 'Planned Date': date
      }
    };
  });
  SHEET_SCHEMA_CACHE_[SHEET_NAMES.BULK_AUDIT_LOG] = {
    required: [],
    fields: {
      'Timestamp': date, 'Total Rows': number, 'Valid Rows': number,
      'Saved Rows': number, 'Error Rows': number
    }
  };
  return SHEET_SCHEMA_CACHE_;
}

function sheetSchemaFor_(sheetName) {
  return sheetSchemas_()[normalizeSheetName(sheetName)] || null;
}

function validateSheetHeaders_(sheetName, headers, opts) {
  const normalized = (headers || []).map(h => String(h == null ? '' : h).trim());
  const key = normalizeSheetName(sheetName) + '|' + normalized.join('\u001f');
  if (HEADER_VALIDATION_CACHE_[key]) return normalized;

  const seen = {};
  const duplicates = [];
  normalized.forEach(header => {
    if (!header) return;
    if (seen[header]) duplicates.push(header);
    seen[header] = true;
  });
  if (duplicates.length) {
    throw new Error('Duplicate header(s) in ' + normalizeSheetName(sheetName) + ': ' + Array.from(new Set(duplicates)).join(', '));
  }

  const schema = sheetSchemaFor_(sheetName);
  if (schema && !(opts && opts.allowMissingRequired)) {
    const missing = (schema.required || []).filter(header => !seen[header]);
    if (missing.length) {
      throw new Error('Missing required header(s) in ' + normalizeSheetName(sheetName) + ': ' + missing.join(', '));
    }
  }
  HEADER_VALIDATION_CACHE_[key] = true;
  return normalized;
}

function safeBooleanValue_(value) {
  if (value === true || value === false) return value;
  const text = String(value == null ? '' : value).trim().toUpperCase();
  if (['TRUE','YES','1','Y'].includes(text)) return true;
  if (['FALSE','NO','0','N',''].includes(text)) return false;
  return false;
}

function safeNumberValue_(value) {
  if (value === '' || value === null || value === undefined) return '';
  const number = Number(value);
  return Number.isFinite(number) ? number : '';
}

function safeDateValue_(value) {
  if (value === '' || value === null || value === undefined) return '';
  if (value instanceof Date) {
    if (isNaN(value.getTime())) return '';
    return Utilities.formatDate(value, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');
  }
  if (typeof value === 'number') return _serialToDateTimeString_(value);
  const text = String(value).trim();
  if (!text) return '';
  const normalized = text.replace('T', ' ');
  if (/^\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2}(?::\d{2})?)?$/.test(normalized)) {
    return normalized.length === 10 ? normalized : (normalized.length === 16 ? normalized + ':00' : normalized);
  }
  const parsed = new Date(text);
  if (isNaN(parsed.getTime())) return '';
  return Utilities.formatDate(parsed, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');
}

function parseSheetCell_(sheetName, header, value) {
  const schema = sheetSchemaFor_(sheetName);
  const spec = schema && schema.fields && schema.fields[header];
  if (!spec) return normalizeSheetValue(value);
  if (spec.type === 'boolean') return safeBooleanValue_(value);
  if (spec.type === 'number') return safeNumberValue_(value);
  if (spec.type === 'date') return safeDateValue_(value);
  return value == null ? '' : String(value).trim();
}

function neutralizeSheetFormula_(value) {
  if (typeof value !== 'string') return value;
  const text = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
  if (!text) return text;
  if (/^[=+@]/.test(text) || (/^-/.test(text) && !/^-\d+(?:\.\d+)?$/.test(text))) {
    return "'" + text;
  }
  return text;
}

function sanitizeSheetRowValues_(values) {
  return (values || []).map(neutralizeSheetFormula_);
}

function canonicalStageOutcome_(stage) {
  const outcome = String(stage && stage['Stage Outcome'] || '').trim().toLowerCase();
  const name = String(stage && stage['Stage Name'] || '').trim().toLowerCase();
  if (outcome.includes('disqualif') || name.includes('disqualif')) return 'Disqualified';
  if (outcome === 'lost' || name.includes('lost')) return 'Lost';
  if (outcome === 'won' || outcome === 'qualified' || /won|qualified/.test(name)) return 'Won';
  return 'Open';
}

function leadLifecycleStatus_(lead, stage) {
  const derived = canonicalStageOutcome_(stage);
  if (derived !== 'Open') return derived;
  const raw = String(lead && lead['Lead Status'] || '').trim();
  if (/^(won|lost|disqualified)$/i.test(raw)) return raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
  return 'Open';
}

function leadArchiveState_(lead) {
  const archived = String(lead && lead['Is Archived'] || '').trim().toUpperCase();
  return archived === 'TRUE' || archived === 'YES' || archived === '1' || !!(lead && lead['Archived At']) ||
    String(lead && lead['Lead Status'] || '').trim().toLowerCase() === 'archived';
}

function pageRequest_(input, defaults) {
  const raw = input || {};
  const base = defaults || {};
  const maxSize = Math.max(1, Number(base.maxPageSize) || 100);
  const pageSize = Math.min(maxSize, Math.max(10, Number(raw.pageSize || raw.size || base.pageSize || 25) || 25));
  return {
    page: Math.max(1, Number(raw.page || 1) || 1),
    pageSize,
    search: String(raw.search || '').trim().toLowerCase().slice(0, 200),
    sortField: String(raw.sortField || base.sortField || '').trim(),
    sortDir: String(raw.sortDir || base.sortDir || 'asc').toLowerCase() === 'desc' ? 'desc' : 'asc',
    filters: raw.filters && typeof raw.filters === 'object' ? raw.filters : {}
  };
}

function paginateRows_(rows, request, extra) {
  const total = (rows || []).length;
  const totalPages = Math.max(1, Math.ceil(total / request.pageSize));
  const page = Math.min(request.page, totalPages);
  const start = (page - 1) * request.pageSize;
  return Object.assign({
    items: (rows || []).slice(start, start + request.pageSize),
    page,
    pageSize: request.pageSize,
    total,
    totalPages,
    hasPrevious: page > 1,
    hasNext: page < totalPages
  }, extra || {});
}

function comparePageValues_(a, b, direction) {
  const av = a == null ? '' : a;
  const bv = b == null ? '' : b;
  let result;
  if (typeof av === 'number' && typeof bv === 'number') result = av - bv;
  else result = String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: 'base' });
  return direction === 'desc' ? -result : result;
}
