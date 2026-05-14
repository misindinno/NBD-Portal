// ─── QueueService.js ──────────────────────────────────────────────────────────
// Append-only job queue backed by JOB_QUEUE sheet.
//
// Status lifecycle:
//   QUEUED → PROCESSING → DONE
//   QUEUED → PROCESSING → FAILED → QUEUED (retry, up to maxAttempts)
//   QUEUED → PROCESSING → FAILED → DEAD   (maxAttempts exceeded)
//
// Lease system prevents two workers from claiming the same job.
// Worker sets leaseUntil = now + 3 min. Stale jobs (leaseUntil expired
// while still PROCESSING) are automatically reclaimed by the next worker run.

const Q_STATUS = { QUEUED: 'QUEUED', PROCESSING: 'PROCESSING', DONE: 'DONE', FAILED: 'FAILED', DEAD: 'DEAD' };
const Q_MAX_ATTEMPTS  = 5;
const Q_LEASE_MS      = 3 * 60 * 1000; // 3 minutes

// Exponential-ish retry delays in seconds: 1m, 3m, 5m, 15m, 30m
const Q_RETRY_DELAYS  = [60, 180, 300, 900, 1800];

// ── Headers (order matches safeInitHeaders call in setupSheets) ───────────────
const Q_HEADERS = [
  'Request ID', 'Status', 'Created At', 'Updated At',
  'User Email', 'Module Name', 'Action Type', 'Payload JSON',
  'Attempt Count', 'Max Attempts', 'Next Retry At',
  'Lease Until', 'Lock Owner', 'Last Error', 'Processed At', 'Final Record ID'
];

// ── Enqueue ───────────────────────────────────────────────────────────────────
// Writes ONE row to JOB_QUEUE. Returns immediately — no heavy operations here.
// Idempotent: if requestId already exists, returns existing status (no duplicate).
function enqueueJob_(userEmail, moduleName, actionType, payload, requestId) {
  assertServerContext_();
  const id = requestId || generateUUID();

  // Idempotency check — prevent duplicate queue entries for the same request
  const existing = _findQueueRow_(id);
  if (existing) return { requestId: id, status: existing['Status'], alreadyQueued: true };

  const payloadStr = JSON.stringify(payload || {});
  if (payloadStr.length > 200000) throw new Error('Payload exceeds 200 KB limit.');

  const ts = now();
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
    'Final Record ID':''
  };

  const lock = LockService.getScriptLock();
  lock.waitLock(8000);
  try {
    const sheet = getSheet(SHEET_NAMES.QUEUE);
    const headers = getHeaders(SHEET_NAMES.QUEUE);
    sheet.appendRow(headers.map(h => row[h] !== undefined ? row[h] : ''));
  } finally {
    lock.releaseLock();
  }

  return { requestId: id, status: Q_STATUS.QUEUED };
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
// Atomically claims up to batchSize QUEUED (or stale PROCESSING) jobs.
// Returns array of claimed job objects ready for processing.
function claimJobs_(workerOwner, batchSize) {
  assertServerContext_();
  batchSize = Math.min(batchSize || 20, 20);

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return []; // another worker is active

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

    const nowMs  = Date.now();
    const nowStr = now();
    const leaseUntilStr = _msToDateStr_(nowMs + Q_LEASE_MS);

    const updates = []; // { rowIndex, newValues }

    for (let i = 1; i < data.length && claimed.length < batchSize; i++) {
      const row    = data[i];
      const status = String(row[statusCol] || '');
      const leaseUntil = row[leaseUntilCol] ? new Date(row[leaseUntilCol]).getTime() : 0;
      const nextRetry  = row[nextRetryCol]  ? new Date(row[nextRetryCol]).getTime()  : 0;
      const attempts   = Number(row[attemptCol] || 0);
      const maxAttempts= Number(row[maxAttCol]  || Q_MAX_ATTEMPTS);

      const isClaimable = (
        (status === Q_STATUS.QUEUED    && nextRetry <= nowMs) ||
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

      // Claim: set PROCESSING + lease
      const claimedRow = row.slice();
      claimedRow[statusCol]     = Q_STATUS.PROCESSING;
      claimedRow[leaseUntilCol] = leaseUntilStr;
      claimedRow[lockOwnerCol]  = workerOwner;
      claimedRow[updatedAtCol]  = nowStr;
      updates.push({ rowIndex: i + 1, values: claimedRow });

      // Build job object from row data
      const job = {};
      headers.forEach((h, j) => { job[h] = row[j]; });
      job['_rowIndex'] = i + 1;
      claimed.push(job);
    }

    // Batch-write all updates at once
    updates.forEach(u => {
      sheet.getRange(u.rowIndex, 1, 1, u.values.length).setValues([u.values]);
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
  const attempt    = Number(currentAttempt || 0) + 1;
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

// ── Internal helpers ──────────────────────────────────────────────────────────
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
