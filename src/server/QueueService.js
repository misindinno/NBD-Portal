// QueueService.gs
// Compatibility queue for older portal deployments that still write JOB_QUEUE rows.
// New UI paths use direct mutations, but old sheets can install this worker to drain
// pending legacy queue jobs safely.

const Q_STATUS = { QUEUED: 'QUEUED', PROCESSING: 'PROCESSING', DONE: 'DONE', FAILED: 'FAILED', DEAD: 'DEAD' };
const Q_MAX_ATTEMPTS = 5;
const Q_LEASE_MS = 5 * 60 * 1000;
const Q_RETRY_DELAYS = [60, 180, 300, 900, 1800];
const Q_HEADERS = [
  'Request ID', 'Status', 'Created At', 'Updated At',
  'User Email', 'Module Name', 'Action Type', 'Payload JSON',
  'Attempt Count', 'Max Attempts', 'Next Retry At',
  'Lease Until', 'Lock Owner', 'Last Error', 'Processed At', 'Final Record ID'
];

function ensureQueueSheet_() {
  safeInitHeaders(SHEET_NAMES.QUEUE, Q_HEADERS);
}

function enqueueJob_(userEmail, moduleName, actionType, payload, requestId) {
  assertServerContext_();
  ensureQueueSheet_();
  const id = requestId || generateUUID();
  const payloadStr = JSON.stringify(payload || {});
  if (payloadStr.length > 200000) throw new Error('Payload exceeds 200 KB limit.');
  const existing = _findQueueRow_(id);
  if (existing) return { requestId: id, status: existing['Status'], alreadyQueued: true };

  const ts = now();
  const row = {
    'Request ID': id,
    'Status': Q_STATUS.QUEUED,
    'Created At': ts,
    'Updated At': ts,
    'User Email': userEmail || '',
    'Module Name': moduleName || '',
    'Action Type': actionType || '',
    'Payload JSON': payloadStr,
    'Attempt Count': 0,
    'Max Attempts': Q_MAX_ATTEMPTS,
    'Next Retry At': ts,
    'Lease Until': '',
    'Lock Owner': '',
    'Last Error': '',
    'Processed At': '',
    'Final Record ID': _qDataId_(actionType, payload) || ''
  };

  const lock = LockService.getScriptLock();
  const locked = lock.tryLock(3000);
  try {
    if (locked) {
      const duplicate = _findQueueRow_(id);
      if (duplicate) return { requestId: id, status: duplicate['Status'], alreadyQueued: true };
    }
    const sheet = getSheet(SHEET_NAMES.QUEUE);
    const headers = getHeaders(SHEET_NAMES.QUEUE);
    sheet.appendRow(headers.map(h => row[h] !== undefined ? row[h] : ''));
  } finally {
    if (locked) lock.releaseLock();
  }
  return { requestId: id, status: Q_STATUS.QUEUED };
}

function getJobStatuses_(requestIds) {
  assertServerContext_();
  ensureQueueSheet_();
  const ids = {};
  (requestIds || []).forEach(id => { if (id) ids[String(id)] = true; });
  const result = {};
  getAllRows(SHEET_NAMES.QUEUE).forEach(r => {
    const id = String(r['Request ID'] || '');
    if (!ids[id]) return;
    result[id] = {
      status: r['Status'] || Q_STATUS.QUEUED,
      finalRecordId: r['Final Record ID'] || '',
      error: r['Last Error'] || '',
      processedAt: r['Processed At'] || ''
    };
  });
  return result;
}

function claimJobs_(workerOwner, batchSize) {
  assertServerContext_();
  ensureQueueSheet_();
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return [];

  const claimed = [];
  try {
    const sheet = getSheet(SHEET_NAMES.QUEUE);
    const data = sheet.getDataRange().getValues();
    if (data.length < 2) return [];
    const headers = data[0].map(String);
    const idx = h => headers.indexOf(h);
    const statusCol = idx('Status');
    const attemptCol = idx('Attempt Count');
    const maxCol = idx('Max Attempts');
    const retryCol = idx('Next Retry At');
    const leaseCol = idx('Lease Until');
    const ownerCol = idx('Lock Owner');
    const updatedCol = idx('Updated At');
    const createdCol = idx('Created At');
    const actionCol = idx('Action Type');
    const payloadCol = idx('Payload JSON');

    const nowMs = Date.now();
    const nowStr = now();
    const leaseUntil = _msToDateStr_(nowMs + Q_LEASE_MS);
    const blockedKeys = {};
    const candidates = [];
    const updates = [];

    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      if (String(row[statusCol] || '') !== Q_STATUS.PROCESSING) continue;
      const leaseMs = _dateMs_(row[leaseCol]);
      if (leaseMs && leaseMs > nowMs) {
        const key = _safeQueueRecordKey_(row[actionCol], row[payloadCol]);
        if (key) blockedKeys[key] = true;
      }
    }

    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      const status = String(row[statusCol] || '');
      const attempts = Number(row[attemptCol] || 0);
      const maxAttempts = Number(row[maxCol] || Q_MAX_ATTEMPTS);
      const retryMs = _dateMs_(row[retryCol]);
      const leaseMs = _dateMs_(row[leaseCol]);
      const claimable =
        (status === Q_STATUS.QUEUED && (!retryMs || retryMs <= nowMs)) ||
        (status === Q_STATUS.FAILED && retryMs && retryMs <= nowMs) ||
        (status === Q_STATUS.PROCESSING && leaseMs && leaseMs < nowMs);
      if (!claimable) continue;
      if (attempts >= maxAttempts) {
        const dead = row.slice();
        dead[statusCol] = Q_STATUS.DEAD;
        dead[updatedCol] = nowStr;
        updates.push({ rowIndex: i + 1, values: dead });
        continue;
      }
      const key = _safeQueueRecordKey_(row[actionCol], row[payloadCol]);
      if (key && blockedKeys[key]) continue;
      candidates.push({
        row,
        rowIndex: i + 1,
        recordKey: key,
        priority: _qActionPriority_(row[actionCol]),
        createdMs: _dateMs_(row[createdCol]),
        originalIndex: i
      });
    }

    candidates.sort((a, b) => {
      if (a.recordKey && a.recordKey === b.recordKey) return a.originalIndex - b.originalIndex;
      if (a.priority !== b.priority) return a.priority - b.priority;
      if (a.createdMs !== b.createdMs) return a.createdMs - b.createdMs;
      return a.originalIndex - b.originalIndex;
    });

    const claimedKeys = {};
    for (let i = 0; i < candidates.length && claimed.length < Math.min(Number(batchSize) || 20, 20); i++) {
      const c = candidates[i];
      if (c.recordKey && claimedKeys[c.recordKey]) continue;
      const next = c.row.slice();
      next[statusCol] = Q_STATUS.PROCESSING;
      next[leaseCol] = leaseUntil;
      next[ownerCol] = workerOwner;
      next[updatedCol] = nowStr;
      updates.push({ rowIndex: c.rowIndex, values: next });
      const job = {};
      headers.forEach((h, j) => { job[h] = c.row[j]; });
      job._rowIndex = c.rowIndex;
      claimed.push(job);
      if (c.recordKey) claimedKeys[c.recordKey] = true;
    }

    updates.forEach(u => sheet.getRange(u.rowIndex, 1, 1, u.values.length).setValues([u.values]));
  } finally {
    lock.releaseLock();
  }
  return claimed;
}

function markJobDone_(requestId, finalRecordId) {
  updateRow(SHEET_NAMES.QUEUE, 'Request ID', requestId, {
    'Status': Q_STATUS.DONE,
    'Updated At': now(),
    'Processed At': now(),
    'Final Record ID': finalRecordId || '',
    'Lease Until': '',
    'Lock Owner': '',
    'Last Error': ''
  });
}

function markJobFailed_(requestId, errorMsg, currentAttempt) {
  const attempt = Math.min(Number(currentAttempt || 0) + 1, Q_MAX_ATTEMPTS);
  const isDead = attempt >= Q_MAX_ATTEMPTS;
  const delayIndex = Math.min(attempt - 1, Q_RETRY_DELAYS.length - 1);
  updateRow(SHEET_NAMES.QUEUE, 'Request ID', requestId, {
    'Status': isDead ? Q_STATUS.DEAD : Q_STATUS.FAILED,
    'Updated At': now(),
    'Attempt Count': attempt,
    'Next Retry At': isDead ? '' : _msToDateStr_(Date.now() + Q_RETRY_DELAYS[delayIndex] * 1000),
    'Last Error': String(errorMsg || '').slice(0, 500),
    'Lease Until': '',
    'Lock Owner': ''
  });
}

function appendChangeLog_(moduleName, recordId, actionType, changedBy) {
  const seq = _nextChangeLogSeq_();
  const row = {
    'Sequence': seq,
    'Timestamp': now(),
    'Module': moduleName || '',
    'Record ID': recordId || '',
    'Action Type': actionType || '',
    'Changed By': changedBy || ''
  };
  const sheet = getSheet(SHEET_NAMES.CHANGE_LOG);
  const headers = getHeaders(SHEET_NAMES.CHANGE_LOG);
  sheet.appendRow(headers.map(h => row[h] !== undefined ? row[h] : ''));
  return seq;
}

function getQueueHistory_(userEmail, limit) {
  ensureQueueSheet_();
  const email = String(userEmail || '').trim().toLowerCase();
  return getAllRows(SHEET_NAMES.QUEUE)
    .filter(r => String(r['User Email'] || '').trim().toLowerCase() === email)
    .sort((a, b) => _dateMs_(b['Created At']) - _dateMs_(a['Created At']))
    .slice(0, Math.min(Number(limit) || 50, 100))
    .map(_queueHistoryDto_);
}

function getAllQueueHistory_(filterEmail, limit) {
  ensureQueueSheet_();
  const filter = String(filterEmail || '').trim().toLowerCase();
  return getAllRows(SHEET_NAMES.QUEUE)
    .filter(r => !filter || String(r['User Email'] || '').trim().toLowerCase() === filter)
    .sort((a, b) => _dateMs_(b['Created At']) - _dateMs_(a['Created At']))
    .slice(0, Math.min(Number(limit) || 100, 500))
    .map(_queueHistoryDto_);
}

function retryQueueJob_(requestId) {
  const id = String(requestId || '').trim();
  if (!id) throw new Error('Request ID is required.');
  const row = _findQueueRow_(id);
  if (!row) throw new Error('Queue job not found.');
  updateRow(SHEET_NAMES.QUEUE, 'Request ID', id, {
    'Status': Q_STATUS.QUEUED,
    'Updated At': now(),
    'Attempt Count': 0,
    'Next Retry At': now(),
    'Lease Until': '',
    'Lock Owner': '',
    'Processed At': ''
  });
  return { requestId: id, status: Q_STATUS.QUEUED };
}

function getQueueHealth_(userEmail, user, filterEmail) {
  ensureQueueSheet_();
  const isAdmin = user && user.role === 'ADMIN';
  const email = String(userEmail || '').trim().toLowerCase();
  const filter = String(filterEmail || '').trim().toLowerCase();
  const rows = getAllRows(SHEET_NAMES.QUEUE).filter(r => {
    const rowEmail = String(r['User Email'] || '').trim().toLowerCase();
    if (isAdmin && !filter) return true;
    if (isAdmin && filter) return rowEmail === filter;
    return rowEmail === email;
  });
  const stats = { total: rows.length, queued: 0, processing: 0, failed: 0, dead: 0, done: 0, staleProcessing: 0 };
  const nowMs = Date.now();
  rows.forEach(r => {
    const status = String(r['Status'] || '').toLowerCase();
    if (Object.prototype.hasOwnProperty.call(stats, status)) stats[status]++;
    if (String(r['Status'] || '') === Q_STATUS.PROCESSING && _dateMs_(r['Lease Until']) < nowMs) stats.staleProcessing++;
  });
  const props = PropertiesService.getScriptProperties();
  const triggers = ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'processQueue');
  return {
    triggerActive: triggers.length > 0,
    triggerCount: triggers.length,
    triggerStatus: getQueueTriggerStatus(),
    lastStartedAt: props.getProperty('QUEUE_WORKER_LAST_STARTED_AT') || '',
    lastFinishedAt: props.getProperty('QUEUE_WORKER_LAST_FINISHED_AT') || '',
    lastStatus: props.getProperty('QUEUE_WORKER_LAST_STATUS') || '',
    lastClaimed: Number(props.getProperty('QUEUE_WORKER_LAST_CLAIMED') || 0),
    lastProcessed: Number(props.getProperty('QUEUE_WORKER_LAST_PROCESSED') || 0),
    lastError: props.getProperty('QUEUE_WORKER_LAST_ERROR') || '',
    stats
  };
}

function _findQueueRow_(requestId) {
  ensureQueueSheet_();
  return getAllRows(SHEET_NAMES.QUEUE).find(r => String(r['Request ID'] || '') === String(requestId || '')) || null;
}

function _queueHistoryDto_(r) {
  return {
    requestId: String(r['Request ID'] || ''),
    status: String(r['Status'] || ''),
    userEmail: String(r['User Email'] || ''),
    createdAt: String(r['Created At'] || ''),
    updatedAt: String(r['Updated At'] || ''),
    moduleName: String(r['Module Name'] || ''),
    actionType: String(r['Action Type'] || ''),
    attemptCount: Number(r['Attempt Count'] || 0),
    maxAttempts: Number(r['Max Attempts'] || Q_MAX_ATTEMPTS),
    nextRetryAt: String(r['Next Retry At'] || ''),
    lastError: String(r['Last Error'] || ''),
    processedAt: String(r['Processed At'] || ''),
    finalRecordId: String(r['Final Record ID'] || '')
  };
}

function _safeQueueRecordKey_(actionType, payloadJson) {
  try { return _qRecordKey_(String(actionType || ''), JSON.parse(String(payloadJson || '{}'))); }
  catch (e) { return ''; }
}

function _qRecordKey_(actionType, payload) {
  const p = payload || {};
  switch (String(actionType || '')) {
    case 'saveLead':
    case 'deleteLead':
    case 'updateLeadStage':
    case 'moveLeadStageWithFields':
    case 'pushLeadToNbd':
      return p.leadId || p.id || p['Lead ID'] ? 'lead:' + (p.leadId || p.id || p['Lead ID']) : '';
    case 'saveFollowup':
    case 'markFollowupDone':
    case 'deleteFollowup':
      return p.id || p.followupId || p['Follow-up ID'] ? 'followup:' + (p.id || p.followupId || p['Follow-up ID']) : '';
    case 'saveBulkRows':
      return p.batchId ? 'bulk:' + p.batchId : '';
    case 'saveStage':
      return p['Stage ID'] || p.stageId ? 'stage:' + (p['Stage ID'] || p.stageId) : '';
    case 'saveFieldConfig':
      return p['Field ID'] || p.fieldId ? 'field:' + (p['Field ID'] || p.fieldId) : '';
    case 'saveUser':
      return p.ID || p['User ID'] || p.userId ? 'user:' + (p.ID || p['User ID'] || p.userId) : '';
    default:
      return '';
  }
}

function _qDataId_(actionType, payload) {
  const p = payload || {};
  return p.id || p.leadId || p.followupId || p.batchId || p['Lead ID'] || p['Follow-up ID'] ||
    p['Stage ID'] || p['Field ID'] || p['Config ID'] || p.ID || p['User ID'] || '';
}

function _qActionPriority_(actionType) {
  const action = String(actionType || '');
  if (action === 'markFollowupDone' || action === 'saveFollowup') return 0;
  if (action === 'updateLeadStage' || action === 'moveLeadStageWithFields' || action === 'pushLeadToNbd') return 1;
  if (action === 'saveLead') return 2;
  if (action === 'deleteLead' || action === 'deleteFollowup') return 3;
  if (action === 'saveBulkRows') return 9;
  return 5;
}

function _nextChangeLogSeq_() {
  const props = PropertiesService.getScriptProperties();
  const lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    const seq = Number(props.getProperty('CHANGE_LOG_SEQ') || 0) + 1;
    props.setProperty('CHANGE_LOG_SEQ', String(seq));
    return seq;
  } finally {
    lock.releaseLock();
  }
}

function _msToDateStr_(ms) {
  return Utilities.formatDate(new Date(ms), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');
}

function _dateMs_(value) {
  if (!value) return 0;
  const d = value instanceof Date ? value : new Date(String(value).replace(' ', 'T'));
  const ms = d.getTime();
  return isNaN(ms) ? 0 : ms;
}
