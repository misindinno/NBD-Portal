const CALL_INBOX_SHEET_ = 'CALL_WEBHOOK_INBOX';
const CALL_INBOX_HEADERS_ = ['Item ID','Delivery ID','Received At','Status','Payload','Attempts','Result','Error','Processed At'];

function _parseCallyzerBatch_(raw) {
  if (typeof raw !== 'string' || raw.length > 1000000) return { error: 'PAYLOAD_TOO_LARGE' };
  let employees;
  try { employees = JSON.parse(raw); } catch (_) { return { error: 'INVALID_PAYLOAD' }; }
  if (!Array.isArray(employees) || !employees.length || employees.length > 100 || employees.some(e => !e || !Array.isArray(e.call_logs))) return { error: 'INVALID_PAYLOAD' };
  const total = employees.reduce((n, e) => n + e.call_logs.length, 0);
  if (!total || total > 200) return { error: 'BATCH_LIMIT' };
  const items = [], issues = [];
  let invalid = 0;
  employees.forEach(employee => employee.call_logs.forEach(input => {
    const call = _normalizeCall_(employee, input);
    if (call && JSON.stringify(call).length < 45000) items.push(call);
    else { invalid++; if (issues.length < 20) issues.push({ status: 'invalid', callId: _callText_(input && input.id, 200) }); }
  }));
  return { total, items, invalid, issues };
}

function _ensureCallWorker_() {
  if (!ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === 'processCallWebhookInbox_')) {
    ScriptApp.newTrigger('processCallWebhookInbox_').timeBased().everyMinutes(1).create();
  }
}

function _enqueueCallyzer_(raw) {
  assertServerContext_();
  if (!_callWebhookSettings_().enabled) return { success: false, code: 'WEBHOOK_DISABLED' };
  const batch = _parseCallyzerBatch_(raw);
  if (batch.error) return { success: false, code: batch.error };
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return { success: false, code: 'BUSY', retry: true };
  try {
    if (!_callWebhookSettings_().enabled) return { success: false, code: 'WEBHOOK_DISABLED' };
    safeInitHeaders(CALL_INBOX_SHEET_, CALL_INBOX_HEADERS_);
    const table = _callTable_(CALL_INBOX_SHEET_);
    if (table.rows.filter(r => ['Pending','Failed'].includes(r.record.Status)).length + batch.items.length > 2000) return { success: false, code: 'INBOX_FULL', retry: true };
    _ensureCallWorker_();
    const id = Utilities.getUuid(), receivedAt = now();
    if (batch.items.length) {
      const rows = batch.items.map((call, i) => [id + ':' + i, id, receivedAt, 'Pending', JSON.stringify(call), 0, '', '', '']);
      table.sheet.getRange(table.sheet.getLastRow() + 1, 1, rows.length, CALL_INBOX_HEADERS_.length).setValues(rows);
      SpreadsheetApp.flush();
    }
    return { success: true, deliveryId: id, receivedAt, status: batch.items.length ? 'Received' : 'Completed', total: batch.total, queued: batch.items.length, invalid: batch.invalid, issues: batch.issues };
  } finally { lock.releaseLock(); }
}

function _updateCallDeliveryProcessingLocked_(inbox) {
  const logs = _callTable_(CALL_WEBHOOK_DELIVERIES_);
  const byDelivery = new Map();
  inbox.rows.forEach(r => {
    const id = r.record['Delivery ID'];
    if (!byDelivery.has(id)) byDelivery.set(id, []);
    byDelivery.get(id).push(r.record);
  });
  logs.rows.forEach(entry => {
    let result;
    try { result = JSON.parse(entry.record.Result); } catch (_) { return; }
    const jobs = byDelivery.get(result.deliveryId);
    if (!jobs) return;
    const processing = { processed: 0, added: 0, updated: 0, duplicate: 0, anonymous: 0, unmatched: 0, ambiguous: 0, failed: 0 };
    jobs.forEach(job => {
      if (job.Status === 'Failed') processing.failed++;
      if (job.Status === 'Done') {
        processing.processed++;
        try { const counts = JSON.parse(job.Result); Object.keys(counts).forEach(k => { if (k in processing) processing[k] += Number(counts[k]) || 0; }); } catch (_) {}
      }
    });
    result.status = processing.failed ? 'Failed' : processing.processed === jobs.length ? 'Completed' : 'Processing';
    Object.assign(result, processing);
    // Update only the summary, retaining original payload and acknowledgement.
    const serialized = JSON.stringify(result);
    if (serialized !== String(entry.record.Result || '')) logs.sheet.getRange(entry.row, 2, 1, 1).setValues([[serialized]]);
  });
}

// Private time-trigger entry point. A saved inbox row is marked Done only after upsert.
function processCallWebhookInbox_() {
  return withServerContext_(() => {
    const started = Date.now();
    const attempted = new Set();
    for (let batch = 0; batch < 5 && Date.now() - started < 180000; batch++) {
      if (!_processCallWebhookBatch_(attempted)) break;
      // Give waiting portal saves a chance to acquire the shared lock.
      if (typeof Utilities.sleep === 'function') Utilities.sleep(100);
    }
  });
}

function _processCallWebhookBatch_(attempted) {
    const lock = LockService.getScriptLock();
    if (!lock.tryLock(1000)) return;
    try {
      // Another execution may have changed lead/user data while the lock was released.
      _invalidateReadCache_();
      const table = _callTable_(CALL_INBOX_SHEET_);
      if (!table.sheet) return;
      const context = table.rows.some(item => item.record.Status === 'Pending' && !attempted.has(item.record['Item ID'])) ? _callUpsertContext_() : null;
      const started = Date.now(); let count = 0;
      for (const item of table.rows) {
        if (count >= 5 || Date.now() - started > 5000) break;
        if (item.record.Status !== 'Pending' || attempted.has(item.record['Item ID'])) continue;
        attempted.add(item.record['Item ID']);
        count++;
        try {
          const result = _upsertCallsLocked_([JSON.parse(item.record.Payload)], context);
          Object.assign(item.record, { Status: 'Done', Result: JSON.stringify(result), Error: '', 'Processed At': now() });
        } catch (error) {
          const attempts = Number(item.record.Attempts || 0) + 1;
          Object.assign(item.record, { Attempts: attempts, Status: attempts >= 3 ? 'Failed' : 'Pending', Error: 'Processing failed. Retry from Webhooks or inspect Apps Script executions.' });
          logServerError_(error, { api: 'processCallWebhookInbox' });
        }
        _writeCallRow_(table, item.record, item.row);
      }
      if (context && context.dirty) { _invalidateReadCache_(); _bumpStamp('followup_history'); _bumpStamp('calls'); }
      _updateCallDeliveryProcessingLocked_(table);
      // Evict whole completed deliveries so retained summaries never lose part of a batch.
      const groups = new Map();
      table.rows.forEach(r => {
        const id = r.record['Delivery ID'];
        if (!groups.has(id)) groups.set(id, []);
        groups.get(id).push(r);
      });
      let doneCount = table.rows.filter(r => r.record.Status === 'Done').length;
      const remove = [];
      for (const group of groups.values()) {
        if (doneCount <= 500) break;
        if (group.every(r => r.record.Status === 'Done')) {
          remove.push(...group); doneCount -= group.length;
        }
      }
      const ranges = [];
      remove.sort((a,b) => b.row - a.row).forEach(r => {
        const previous = ranges[ranges.length - 1];
        if (previous && r.row === previous.start - 1) { previous.start = r.row; previous.count++; }
        else ranges.push({ start: r.row, count: 1 });
      });
      ranges.forEach(range => table.sheet.deleteRows(range.start, range.count));
      SpreadsheetApp.flush();
      return count;
    } finally { lock.releaseLock(); }
}

function _retryCallDelivery_(deliveryId) {
  requireConfigEditor();
  const lock = LockService.getScriptLock(); lock.waitLock(10000);
  try {
    _ensureCallWorker_();
    const table = _callTable_(CALL_INBOX_SHEET_);
    let retried = 0;
    table.rows.filter(r => r.record['Delivery ID'] === deliveryId && r.record.Status === 'Failed').forEach(r => {
      Object.assign(r.record, { Status: 'Pending', Attempts: 0, Error: '' });
      _writeCallRow_(table, r.record, r.row); retried++;
    });
    _updateCallDeliveryProcessingLocked_(table);
    return { retried };
  } finally { lock.releaseLock(); }
}
