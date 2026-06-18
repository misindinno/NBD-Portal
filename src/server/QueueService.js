// ─── QueueService.js ──────────────────────────────────────────────────────────
// Append-only job queue backed by JOB_QUEUE sheet.
//
// Status lifecycle:
//   QUEUED → PROCESSING → DONE
//   QUEUED → PROCESSING → FAILED → PROCESSING (retry, up to maxAttempts)
//   QUEUED → PROCESSING → FAILED → DEAD       (maxAttempts exceeded)
//
// Lease system prevents two workers from claiming the same job.
// Worker sets leaseUntil = now + 3 min. Stale jobs (leaseUntil expired
// while still PROCESSING) are automatically reclaimed by the next worker run.

const Q_STATUS = { QUEUED: 'QUEUED', PROCESSING: 'PROCESSING', DONE: 'DONE', FAILED: 'FAILED', DEAD: 'DEAD' };
const Q_MAX_ATTEMPTS  = 5;
const Q_LEASE_MS      = 5 * 60 * 1000; // 5 minutes, covers long bulk chunks before GAS cutoff

// Exponential-ish retry delays in seconds: 1m, 3m, 5m, 15m, 30m
const Q_RETRY_DELAYS  = [60, 180, 300, 900, 1800];

// ── Headers (order matches safeInitHeaders call in setupSheets) ───────────────
const Q_HEADERS = [
  'Request ID', 'Status', 'Created At', 'Updated At',
  'User Email', 'Module Name', 'Action Type', 'Payload JSON',
  'Attempt Count', 'Max Attempts', 'Next Retry At',
  'Lease Until', 'Lock Owner', 'Last Error', 'Processed At', 'Final Record ID'
];

// ── Record key — one job at a time per record ─────────────────────────────────
// Returns a stable "<type>:<id>" string for any action type so the claim loop
// can block duplicate-record jobs across ALL modules, not just leads.
// Returns '' for actions that have no specific record (bulk config ops, etc.).
function _qRecordKey_(actionType, payload) {
  if (!payload) return '';
  const p = payload;
  switch (actionType) {
    // Leads
    case 'saveLead':
      return p['Lead ID'] ? 'lead:' + p['Lead ID'] : (p.leadId ? 'lead:' + p.leadId : '');
    case 'saveBulkRows':
      return p.batchId ? 'bulk:' + p.batchId : '';
    case 'deleteLead':
      return p.id ? 'lead:' + p.id : '';
    case 'updateLeadStage':
    case 'moveLeadStageWithFields':
    case 'pushLeadToNbd':
      return p.leadId ? 'lead:' + p.leadId : '';
    // Follow-ups (key on the followup id; fallback to lead so saves/done for same followup serialize)
    case 'saveFollowup':
      return p.id ? 'followup:' + p.id : (p.leadId ? 'lead:' + p.leadId : '');
    case 'markFollowupDone':
    case 'deleteFollowup':
      return p.id ? 'followup:' + p.id : '';
    // Config
    case 'updateConfigStatus':
      return p.id ? 'config:' + p.id : '';
    case 'saveStage':
      return (p['Stage ID'] || p.stageId) ? 'stage:' + (p['Stage ID'] || p.stageId) : '';
    case 'saveFieldConfig':
      return (p['Field ID'] || p.fieldId) ? 'field:' + (p['Field ID'] || p.fieldId) : '';
    case 'saveUser':
      return (p['ID'] || p['User ID'] || p.userId) ? 'user:' + (p['ID'] || p['User ID'] || p.userId) : '';
    // Bulk / no specific record — no blocking needed
    default:
      return '';
  }
}

function _qDataId_(actionType, payload) {
  if (!payload) return '';
  const p = payload || {};
  switch (actionType) {
    case 'saveLead':
      return p['Lead ID'] || p.leadId || '';
    case 'saveBulkRows':
      return p.batchId || '';
    case 'deleteLead':
      return p.id || p.leadId || p['Lead ID'] || '';
    case 'updateLeadStage':
    case 'moveLeadStageWithFields':
    case 'pushLeadToNbd':
      return p.leadId || p['Lead ID'] || '';
    case 'saveFollowup':
      return p['Follow-up ID'] || p.followupId || p.id || '';
    case 'markFollowupDone':
    case 'deleteFollowup':
      return p.id || p.followupId || p['Follow-up ID'] || '';
    case 'addConfig':
    case 'updateConfigStatus':
      return p.id || p['Config ID'] || '';
    case 'saveStage':
      return p['Stage ID'] || p.stageId || '';
    case 'reorderStages':
      return Array.isArray(p.ids) ? p.ids.join(',') : '';
    case 'saveFieldConfig':
      return p['Field ID'] || p.fieldId || '';
    case 'saveUser':
      return p['ID'] || p['User ID'] || p.userId || p.id || '';
    default:
      return p.id || p.leadId || p.followupId || p['Lead ID'] || p['Follow-up ID'] || '';
  }
}

// ── Enqueue ───────────────────────────────────────────────────────────────────
// Writes ONE row to JOB_QUEUE. Returns immediately — no heavy operations here.
// Idempotent: if requestId already exists, returns existing status (no duplicate).
function enqueueJob_(userEmail, moduleName, actionType, payload, requestId) {
  assertServerContext_();
  const id = requestId || generateUUID();

  const payloadStr = JSON.stringify(payload || {});
  if (payloadStr.length > 200000) throw new Error('Payload exceeds 200 KB limit.');

  const ts = now();
  const dataId = _qDataId_(actionType, payload);
  const row = {
    'Request ID':     id,
    'Status':         Q_STATUS.QUEUED,
    'Created At':     ts,
    'Updated At':     ts,
    'User Email':     userEmail || '',
    'Module Name':    moduleName || '',
    'Action Type':    actionType || '',
    'Payload JSON':   payloadStr,
    'Attempt Count':  0,
    'Max Attempts':   Q_MAX_ATTEMPTS,
    'Next Retry At':  ts,
    'Lease Until':    '',
    'Lock Owner':     '',
    'Last Error':     '',
    'Processed At':   '',
    'Final Record ID': dataId || ''
  };

  const existing = _findQueueRow_(id);
  if (existing) return { requestId: id, status: existing['Status'], alreadyQueued: true };

  const lock = LockService.getScriptLock();
  const locked = lock.tryLock(1500);
  try {
    // Fast path: use the lock when it is immediately available so duplicate
    // request IDs remain idempotent under normal conditions.
    if (locked) {
      const lockedExisting = _findQueueRow_(id);
      if (lockedExisting) return { requestId: id, status: lockedExisting['Status'], alreadyQueued: true };
    }
    _appendQueueRow_(row);
  } finally {
    if (locked) lock.releaseLock();
  }

  return { requestId: id, status: Q_STATUS.QUEUED, lockBypassed: !locked };
}

function _appendQueueRow_(row) {
  const sheet = getSheet(SHEET_NAMES.QUEUE);
  const headers = getHeaders(SHEET_NAMES.QUEUE);
  sheet.appendRow(headers.map(h => row[h] !== undefined ? row[h] : ''));
}

// ── Status query (used by polling endpoint) ───────────────────────────────────
// Returns a map of { requestId → { status, finalRecordId, error } }
// Reads only the QUEUE sheet (small, fast).
function getJobStatuses_(requestIds) {
  assertServerContext_();
  if (!Array.isArray(requestIds) || !requestIds.length) return {};

  const idSet = {};
  requestIds.forEach(id => { if (id) idSet[String(id)] = true; });

  const result = {};
  const rows = getAllRows(SHEET_NAMES.QUEUE);
  rows.forEach(r => {
    const id = String(r['Request ID'] || '');
    if (idSet[id]) {
      result[id] = {
        status:        r['Status'] || Q_STATUS.QUEUED,
        finalRecordId: r['Final Record ID'] || '',
        error:         r['Last Error'] || '',
        processedAt:   r['Processed At'] || ''
      };
    }
  });
  return result;
}

// ── Job claiming (worker use only) ────────────────────────────────────────────
function _qActionPriority_(actionType) {
  const action = String(actionType || '');
  if (action === 'markFollowupDone' || action === 'saveFollowup') return 0;
  if (action === 'updateLeadStage' || action === 'moveLeadStageWithFields' || action === 'pushLeadToNbd') return 1;
  if (action === 'saveLead') return 2;
  if (action === 'deleteLead' || action === 'deleteFollowup') return 3;
  if (action === 'saveBulkRows') return 9;
  return 5;
}

// Atomically claims up to batchSize QUEUED (or stale PROCESSING) jobs.
// Returns array of claimed job objects ready for processing.
function claimJobs_(workerOwner, batchSize, options) {
  assertServerContext_();
  batchSize = Math.min(batchSize || 20, 20);
  options = options || {};
  const lockWaitMs = Number(options.lockWaitMs || 10000);
  const preferredActions = (options.preferredActions || []).reduce((m, a) => {
    m[String(a)] = true;
    return m;
  }, {});
  const hasPreferredActions = Object.keys(preferredActions).length > 0;

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(lockWaitMs)) return []; // another worker is active

  const claimed = [];
  try {
    const sheet = getSheet(SHEET_NAMES.QUEUE);
    const data  = sheet.getDataRange().getValues();
    if (data.length < 2) return [];

    const headers = data[0].map(String);
    const colIdx  = h => headers.indexOf(h);
    const statusCol     = colIdx('Status');
    const attemptCol    = colIdx('Attempt Count');
    const maxAttCol     = colIdx('Max Attempts');
    const nextRetryCol  = colIdx('Next Retry At');
    const leaseUntilCol = colIdx('Lease Until');
    const lockOwnerCol  = colIdx('Lock Owner');
    const updatedAtCol  = colIdx('Updated At');
    const createdAtCol  = colIdx('Created At');

    const nowMs  = Date.now();
    const nowStr = now();
    const leaseUntilStr = _msToDateStr_(nowMs + Q_LEASE_MS);

    const updates = []; // { rowIndex, newValues }
    const payloadCol   = colIdx('Payload JSON');
    const actionCol    = colIdx('Action Type');

    // Jobs for the same record are claimed in sheet order by the same worker,
    // so stage 1 then stage 2 can finish in one cron run. Live leases owned by
    // another worker still block the record to prevent concurrent writes.
    const blockedKeys = new Set();

    // First pass: mark keys of jobs that are actively PROCESSING (live lease)
    // so we don't start their successor in the same batch run.
    for (let i = 1; i < data.length; i++) {
      const row    = data[i];
      const status = String(row[statusCol] || '');
      if (status !== Q_STATUS.PROCESSING) continue;
      const leaseUntil = row[leaseUntilCol] ? new Date(row[leaseUntilCol]).getTime() : 0;
      if (leaseUntil <= nowMs) continue; // stale — will be reclaimed
      try {
        const key = _qRecordKey_(String(row[actionCol] || ''), JSON.parse(String(row[payloadCol] || '{}')));
        if (key) blockedKeys.add(key);
      } catch (_) {}
    }

    const candidates = [];

    for (let i = 1; i < data.length; i++) {
      const row    = data[i];
      const status = String(row[statusCol] || '');
      const leaseUntil = row[leaseUntilCol] ? new Date(row[leaseUntilCol]).getTime() : 0;
      const nextRetry  = row[nextRetryCol]  ? new Date(row[nextRetryCol]).getTime()  : 0;
      const attempts   = Number(row[attemptCol] || 0);
      const maxAttempts= Number(row[maxAttCol]  || Q_MAX_ATTEMPTS);
      const actionType = String(row[actionCol] || '');
      if (hasPreferredActions && !preferredActions[actionType]) continue;

      const isClaimable = (
        (status === Q_STATUS.QUEUED    && nextRetry <= nowMs) ||
        (status === Q_STATUS.FAILED    && nextRetry > 0 && nextRetry <= nowMs) ||
        (status === Q_STATUS.PROCESSING && leaseUntil > 0 && leaseUntil < nowMs) // stale lease
      );
      if (!isClaimable) continue;
      if (attempts >= maxAttempts) {
        // Mark DEAD — max retries exceeded
        const deadRow = row.slice();
        deadRow[statusCol]    = Q_STATUS.DEAD;
        deadRow[updatedAtCol] = nowStr;
        updates.push({ rowIndex: i + 1, values: deadRow });
        continue;
      }

      // Serial-per-record guard: skip only if another live worker owns this record.
      let recordKey = '';
      try {
        recordKey = _qRecordKey_(actionType, JSON.parse(String(row[payloadCol] || '{}')));
      } catch (_) {}
      if (recordKey && blockedKeys.has(recordKey)) continue;

      candidates.push({
        row,
        rowIndex: i + 1,
        actionType,
        recordKey,
        priority: _qActionPriority_(actionType),
        createdMs: row[createdAtCol] ? new Date(row[createdAtCol]).getTime() : 0,
        originalIndex: i
      });
    }

    candidates.sort((a, b) => {
      if (a.recordKey && a.recordKey === b.recordKey) return a.originalIndex - b.originalIndex;
      if (a.priority !== b.priority) return a.priority - b.priority;
      if (a.createdMs !== b.createdMs) return a.createdMs - b.createdMs;
      return a.originalIndex - b.originalIndex;
    });

    const claimedKeys = new Set();
    for (let c = 0; c < candidates.length && claimed.length < batchSize; c++) {
      const candidate = candidates[c];
      const row = candidate.row;
      if (candidate.recordKey && claimedKeys.has(candidate.recordKey)) {
        // Keep jobs for the same record ordered. The next claim loop in the
        // same worker run will pick the successor after the first job is done.
        continue;
      }

      // Claim: set PROCESSING + lease
      const claimedRow = row.slice();
      claimedRow[statusCol]     = Q_STATUS.PROCESSING;
      claimedRow[leaseUntilCol] = leaseUntilStr;
      claimedRow[lockOwnerCol]  = workerOwner;
      claimedRow[updatedAtCol]  = nowStr;
      updates.push({ rowIndex: candidate.rowIndex, values: claimedRow });

      // Build job object from row data
      const job = {};
      headers.forEach((h, j) => { job[h] = row[j]; });
      job['_rowIndex'] = candidate.rowIndex;
      claimed.push(job);
      if (candidate.recordKey) claimedKeys.add(candidate.recordKey);
    }

    // Batch-write all updates at once. Apps Script ranges are 1-based and row 1
    // is the header, so an invalid queue row should not stop the full worker.
    updates.forEach(u => {
      const rowIndex = Number(u.rowIndex || 0);
      if (rowIndex < 2) {
        Logger.log('[Queue] Skipping invalid claim update rowIndex=' + u.rowIndex);
        return;
      }
      sheet.getRange(rowIndex, 1, 1, u.values.length).setValues([u.values]);
    });

  } finally {
    lock.releaseLock();
  }

  return claimed;
}

// ── Mark job DONE ─────────────────────────────────────────────────────────────
function markJobDone_(requestId, finalRecordId) {
  assertServerContext_();
  updateRow(SHEET_NAMES.QUEUE, 'Request ID', requestId, {
    'Status':         Q_STATUS.DONE,
    'Updated At':     now(),
    'Processed At':   now(),
    'Final Record ID': finalRecordId || '',
    'Lease Until':    '',
    'Lock Owner':     ''
  });
}

// ── Mark job FAILED (with retry scheduling) ───────────────────────────────────
function markJobFailed_(requestId, errorMsg, currentAttempt) {
  assertServerContext_();
  const attempt    = Math.min(Number(currentAttempt || 0) + 1, Q_MAX_ATTEMPTS);
  const delayIndex = Math.min(attempt - 1, Q_RETRY_DELAYS.length - 1);
  const delayMs    = Q_RETRY_DELAYS[delayIndex] * 1000;
  const isDead     = attempt >= Q_MAX_ATTEMPTS;

  updateRow(SHEET_NAMES.QUEUE, 'Request ID', requestId, {
    'Status':         isDead ? Q_STATUS.DEAD : Q_STATUS.FAILED,
    'Updated At':     now(),
    'Attempt Count':  attempt,
    'Next Retry At':  isDead ? '' : _msToDateStr_(Date.now() + delayMs),
    'Last Error':     String(errorMsg || '').slice(0, 500),
    'Lease Until':    '',
    'Lock Owner':     ''
  });
}

// ── Change Log ────────────────────────────────────────────────────────────────
// Append-only log of processed changes. Frontend polls for new entries using
// the last known sequence number to do incremental cache updates.
function appendChangeLog_(moduleName, recordId, actionType, changedBy) {
  assertServerContext_();
  const seq = _nextChangeLogSeq_();
  const ts  = now();
  const row = {
    'Sequence':    seq,
    'Timestamp':   ts,
    'Module':      moduleName || '',
    'Record ID':   recordId   || '',
    'Action Type': actionType || '',
    'Changed By':  changedBy  || ''
  };
  const sheet   = getSheet(SHEET_NAMES.CHANGE_LOG);
  const headers = getHeaders(SHEET_NAMES.CHANGE_LOG);
  sheet.appendRow(headers.map(h => row[h] !== undefined ? row[h] : ''));
  return seq;
}

// Returns all CHANGE_LOG rows with Sequence > lastSeq (max 200 rows).
function getChangesAfter_(lastSeq) {
  assertServerContext_();
  const after = Number(lastSeq) || 0;
  const rows  = getAllRows(SHEET_NAMES.CHANGE_LOG);
  return rows
    .filter(r => Number(r['Sequence'] || 0) > after)
    .slice(-200) // cap at 200 rows
    .map(r => ({
      sequence:   Number(r['Sequence']),
      timestamp:  r['Timestamp']   || '',
      module:     r['Module']      || '',
      recordId:   r['Record ID']   || '',
      actionType: r['Action Type'] || '',
      changedBy:  r['Changed By']  || ''
}));
}

function _queuePendingPayload_(row) {
  const status = String(row['Status'] || '');
  const action = String(row['Action Type'] || '');
  if (![Q_STATUS.QUEUED, Q_STATUS.PROCESSING, Q_STATUS.FAILED].includes(status)) return null;
  if (!['updateLeadStage', 'moveLeadStageWithFields'].includes(action)) return null;
  try {
    const payload = JSON.parse(row['Payload JSON'] || '{}');
    return {
      leadId: String(payload.leadId || ''),
      stageId: String(payload.stageId || ''),
      fields: payload.fields && typeof payload.fields === 'object' ? payload.fields : {},
      note: String(payload.note || '')
    };
  } catch (e) {
    return null;
  }
}

// ── Queue history for a user ──────────────────────────────────────────────────
// Returns recent jobs for a specific user, sorted newest-first.
// Strips Payload JSON before returning (can be large).
function getQueueHistory_(userEmail, limit) {
  assertServerContext_();
  const maxRows = Math.min(Number(limit) || 50, 100);
  const email   = String(userEmail || '').trim().toLowerCase();
  const rows    = getAllRows(SHEET_NAMES.QUEUE);

  return rows
    .filter(r => String(r['User Email'] || '').trim().toLowerCase() === email)
    .sort((a, b) => {
      const ta = a['Created At'] ? new Date(a['Created At']).getTime() : 0;
      const tb = b['Created At'] ? new Date(b['Created At']).getTime() : 0;
      return tb - ta;
    })
    .slice(0, maxRows)
    .map(r => ({
      requestId:     String(r['Request ID']      || ''),
      status:        String(r['Status']           || ''),
      createdAt:     String(r['Created At']       || ''),
      updatedAt:     String(r['Updated At']       || ''),
      moduleName:    String(r['Module Name']      || ''),
      actionType:    String(r['Action Type']      || ''),
      attemptCount:  Number(r['Attempt Count']    || 0),
      maxAttempts:   Number(r['Max Attempts']     || Q_MAX_ATTEMPTS),
      nextRetryAt:   String(r['Next Retry At']    || ''),
      lastError:     String(r['Last Error']       || ''),
      processedAt:   String(r['Processed At']     || ''),
      finalRecordId: String(r['Final Record ID']  || ''),
      pendingPayload: _queuePendingPayload_(r)
    }));
}

// ── All-users queue history (admin only) ──────────────────────────────────────
function getAllQueueHistory_(filterEmail, limit) {
  assertServerContext_();
  const maxRows = Math.min(Number(limit) || 100, 500);
  const rows = getAllRows(SHEET_NAMES.QUEUE);
  const filter = filterEmail ? String(filterEmail).trim().toLowerCase() : '';

  return rows
    .filter(r => !filter || String(r['User Email'] || '').trim().toLowerCase() === filter)
    .sort((a, b) => {
      const ta = a['Created At'] ? new Date(a['Created At']).getTime() : 0;
      const tb = b['Created At'] ? new Date(b['Created At']).getTime() : 0;
      return tb - ta;
    })
    .slice(0, maxRows)
    .map(r => ({
      requestId:     String(r['Request ID']      || ''),
      status:        String(r['Status']           || ''),
      userEmail:     String(r['User Email']       || ''),
      createdAt:     String(r['Created At']       || ''),
      updatedAt:     String(r['Updated At']       || ''),
      moduleName:    String(r['Module Name']      || ''),
      actionType:    String(r['Action Type']      || ''),
      attemptCount:  Number(r['Attempt Count']    || 0),
      maxAttempts:   Number(r['Max Attempts']     || Q_MAX_ATTEMPTS),
      nextRetryAt:   String(r['Next Retry At']    || ''),
      lastError:     String(r['Last Error']       || ''),
      processedAt:   String(r['Processed At']     || ''),
      finalRecordId: String(r['Final Record ID']  || ''),
    }));
}

// ── Internal helpers ──────────────────────────────────────────────────────────
// Queue operational health for the Queue page and debugging stuck jobs.
function retryQueueJob_(requestId) {
  assertServerContext_();
  const id = String(requestId || '').trim();
  if (!id) throw new Error('Request ID is required.');
  const row = _findQueueRow_(id);
  if (!row) throw new Error('Queue job not found.');
  const status = String(row['Status'] || '');
  if (![Q_STATUS.FAILED, Q_STATUS.DEAD].includes(status)) {
    throw new Error('Only retrying or failed jobs can be retried.');
  }
  updateRow(SHEET_NAMES.QUEUE, 'Request ID', id, {
    'Status': Q_STATUS.QUEUED,
    'Updated At': now(),
    'Attempt Count': 0,
    'Next Retry At': now(),
    'Lease Until': '',
    'Lock Owner': '',
    'Processed At': '',
    'Last Error': String(row['Last Error'] || '').slice(0, 500)
  });
  return { requestId: id, status: Q_STATUS.QUEUED };
}

function getQueueHealth_(userEmail, user, filterEmail) {
  assertServerContext_();
  const email = String(userEmail || '').trim().toLowerCase();
  const isAdmin = user && user.role === 'ADMIN';
  const filter = String(filterEmail || '').trim().toLowerCase();
  const rows = getAllRows(SHEET_NAMES.QUEUE)
    .filter(r => {
      const rowEmail = String(r['User Email'] || '').trim().toLowerCase();
      if (isAdmin && !filter) return true;
      if (isAdmin && filter) return rowEmail === filter;
      return rowEmail === email;
    });
  const nowMs = Date.now();
  const stats = {
    scope: isAdmin ? (filter ? 'filtered' : 'admin') : 'user',
    total: rows.length,
    queued: 0,
    processing: 0,
    failed: 0,
    dead: 0,
    done: 0,
    staleProcessing: 0,
    oldestPendingAt: '',
    oldestPendingMinutes: null
  };
  let oldestPendingMs = 0;

  rows.forEach(r => {
    const status = String(r['Status'] || '');
    if (status === Q_STATUS.QUEUED) stats.queued++;
    else if (status === Q_STATUS.PROCESSING) stats.processing++;
    else if (status === Q_STATUS.FAILED) stats.failed++;
    else if (status === Q_STATUS.DEAD) stats.dead++;
    else if (status === Q_STATUS.DONE) stats.done++;

    const leaseUntil = _dateMs_(r['Lease Until']);
    if (status === Q_STATUS.PROCESSING && leaseUntil > 0 && leaseUntil < nowMs) stats.staleProcessing++;

    if (status === Q_STATUS.QUEUED || status === Q_STATUS.PROCESSING || status === Q_STATUS.FAILED) {
      const createdMs = _dateMs_(r['Created At']);
      if (createdMs && (!oldestPendingMs || createdMs < oldestPendingMs)) {
        oldestPendingMs = createdMs;
        stats.oldestPendingAt = String(r['Created At'] || '');
      }
    }
  });

  if (oldestPendingMs) {
    stats.oldestPendingMinutes = Math.max(0, Math.floor((nowMs - oldestPendingMs) / 60000));
  }

  const props = PropertiesService.getScriptProperties();
  const triggers = ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'processQueue');
  return {
    triggerActive: triggers.length > 0,
    triggerCount: triggers.length,
    triggerStatus: triggers.length > 0
      ? 'ACTIVE - ' + triggers.length + ' trigger(s) running'
      : 'NOT SET - run setupQueueTrigger() to enable background processing',
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
  const rows = getAllRows(SHEET_NAMES.QUEUE);
  return rows.find(r => String(r['Request ID'] || '') === String(requestId)) || null;
}

function _nextChangeLogSeq_() {
  const props = PropertiesService.getScriptProperties();
  const key   = 'CHANGE_LOG_SEQ';
  const lock  = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    const seq = (Number(props.getProperty(key) || 0)) + 1;
    props.setProperty(key, String(seq));
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
