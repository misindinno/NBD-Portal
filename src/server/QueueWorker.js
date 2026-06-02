// ─── QueueWorker.js ───────────────────────────────────────────────────────────
// Background queue processor. Called by a time-based trigger every 1 minute.
//
// Safety constraints:
//   - Processes repeated batches per run until queue is empty or cutoff is near
//   - Hard cutoff at 4.5 minutes elapsed time
//   - Uses a lease system — each claimed job is locked for 3 minutes
//   - Stale jobs (lease expired, still PROCESSING) are automatically reclaimed
//
// Trigger setup: call setupQueueTrigger() once from Apps Script editor or menu.

const WORKER_ID        = 'worker-' + Math.random().toString(36).slice(2, 8);
const WORKER_BATCH_SIZE = 20;
const WORKER_CUTOFF_MS  = 4.5 * 60 * 1000; // stop before 6-min GAS limit
const WORKER_CLAIM_MARGIN_MS = 30 * 1000; // don't claim a fresh batch near cutoff

// ── Main entry point (called by time trigger) ─────────────────────────────────
function processQueue() {
  return withServerContext_(() => {
    const startMs = Date.now();
    const props = PropertiesService.getScriptProperties();
    props.setProperty('QUEUE_WORKER_LAST_STARTED_AT', now());
    props.setProperty('QUEUE_WORKER_LAST_STATUS', 'RUNNING');
    try {
      let processed = 0;
      let claimedTotal = 0;
      let cutoffHit = false;

      while (Date.now() - startMs <= WORKER_CUTOFF_MS - WORKER_CLAIM_MARGIN_MS) {
        const jobs = claimJobs_(WORKER_ID, WORKER_BATCH_SIZE);
        claimedTotal += jobs.length;
        if (!jobs.length) break;

        for (const job of jobs) {
          if (Date.now() - startMs > WORKER_CUTOFF_MS) {
            cutoffHit = true;
            break;
          }
          _processQueueJob_(job);
          processed++;
        }
        if (cutoffHit) break;
      }

      props.setProperty('QUEUE_WORKER_LAST_CLAIMED', String(claimedTotal));
      if (!claimedTotal) {
        props.setProperty('QUEUE_WORKER_LAST_FINISHED_AT', now());
        props.setProperty('QUEUE_WORKER_LAST_PROCESSED', '0');
        props.setProperty('QUEUE_WORKER_LAST_STATUS', 'IDLE');
        return; // nothing to do
      }
      props.setProperty('QUEUE_WORKER_LAST_FINISHED_AT', now());
      props.setProperty('QUEUE_WORKER_LAST_PROCESSED', String(processed));
      props.setProperty('QUEUE_WORKER_LAST_STATUS', cutoffHit ? 'CUTOFF' : 'OK');
    } catch (e) {
      props.setProperty('QUEUE_WORKER_LAST_FINISHED_AT', now());
      props.setProperty('QUEUE_WORKER_LAST_STATUS', 'ERROR');
      props.setProperty('QUEUE_WORKER_LAST_ERROR', String(e.message || e).slice(0, 500));
      // Worker-level failure — log but don't crash the trigger
      try {
        Logger.log('[QueueWorker] Fatal error: ' + e.message);
      } catch (_) {}
    }
  });
}

// ── Process one job ───────────────────────────────────────────────────────────
function _processQueueJob_(job) {
  const requestId  = String(job['Request ID']  || '');
  const userEmail  = String(job['User Email']  || '');
  const moduleName = String(job['Module Name'] || '');
  const actionType = String(job['Action Type'] || '');
  const attempt    = Number(job['Attempt Count'] || 0);

  let payload = {};
  try {
    payload = JSON.parse(job['Payload JSON'] || '{}');
  } catch (e) {
    markJobFailed_(requestId, 'Invalid payload JSON: ' + e.message, attempt);
    return;
  }

  try {
    // Re-validate user is still active before processing
    const userResult = getCurrentUserByEmail_(userEmail);
    if (!userResult.success) {
      // Permanent failure — user was deactivated or removed
      markJobFailed_(requestId, 'User not found or deactivated: ' + userEmail, Q_MAX_ATTEMPTS - 1);
      return;
    }

    // Dispatch to the appropriate service function
    const result = withTrustedWriteUser_(userEmail, () =>
      _dispatchQueuedJob_(actionType, userEmail, payload)
    );

    if (!result || !result.success) {
      const errMsg = result ? result.error : 'Unknown error';
      _handleJobError_(requestId, errMsg, attempt, actionType);
      return;
    }

    // Success — mark DONE and write change log
    const finalRecordId = _extractRecordId_(result.data, actionType, payload);
    markJobDone_(requestId, finalRecordId);
    appendChangeLog_(moduleName, finalRecordId || requestId, actionType, userEmail);
    _bumpStampForModule_(moduleName, actionType);

  } catch (e) {
    _handleJobError_(requestId, e.message, attempt, actionType);
  }
}

// ── Route to service function ─────────────────────────────────────────────────
function _dispatchQueuedJob_(actionType, userEmail, payload) {
  switch (actionType) {
    // ── Leads
    case 'saveLead':              return saveLead(payload, userEmail);
    case 'saveBulkRows':          return respond(saveBulkRows(payload.rows || [], userEmail, payload.batchId || '', payload.mode || 'create'));
    case 'deleteLead':            return deleteLead(payload.id, userEmail);
    case 'updateLeadStage':       return updateLeadStage(payload.leadId, payload.stageId, payload.note, userEmail);
    case 'moveLeadStageWithFields':
      return moveLeadStageWithFields(payload.leadId, payload.stageId, payload.fields || {}, payload.note, userEmail);
    case 'pushLeadToNbd':         return pushLeadToNbd(payload.leadId, userEmail, payload.nbdAssignedTo, payload.mapToNbdLeadId || '', payload.qualifiedRemark || '');
    // ── Follow-ups
    case 'saveFollowup':          return saveFollowup(payload, userEmail);
    case 'markFollowupDone':      return markFollowupDone(payload.id, payload.data || {}, userEmail);
    case 'deleteFollowup':        return deleteFollowup(payload.id, userEmail);
    // ── Config / admin
    case 'addConfig':             return addConfig(payload.type, payload.value, userEmail);
    case 'updateConfigStatus':    return updateConfigStatus(payload.id, payload.status, userEmail);
    case 'saveStage':             return saveStage(payload, userEmail);
    case 'reorderStages':         return reorderStages(payload.ids, userEmail);
    case 'saveFieldConfig':       return saveFieldConfig(payload, userEmail);
    case 'savePortalSettings':    return savePortalSettings(payload, userEmail);
    case 'saveUser':              return _saveUser(payload, userEmail);
    default:
      return respond(null, 'Unknown action type: ' + actionType);
  }
}

// ── Error handling ────────────────────────────────────────────────────────────
function _handleJobError_(requestId, errMsg, attempt, actionType) {
  const msg = String(errMsg || 'Unknown error').slice(0, 500);

  // Permanent errors do not retry. "Not found" can be transient when a queued
  // update depends on a just-created record, so it follows the retry schedule.
  const isPermanent = (
    /permission denied|not authoris|access denied/i.test(msg) ||
    /invalid payload|unsupported/i.test(msg)
  );

  if (isPermanent) {
    markJobFailed_(requestId, msg, Q_MAX_ATTEMPTS - 1); // set to DEAD immediately
  } else {
    markJobFailed_(requestId, msg, attempt);
  }

  Logger.log('[QueueWorker] Job ' + requestId + ' failed (' + actionType + '): ' + msg);
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function _extractRecordId_(data, actionType, payload) {
  if (typeof data === 'string') return data; // many services return the ID as a string
  if (data && data.batchId)      return data.batchId;
  if (data && data.nbdLeadId)    return data.nbdLeadId;
  if (data && data.leadId)       return data.leadId;
  if (data && data.followupId)   return data.followupId;
  if (data && data.id)           return data.id;
  return _qDataId_(actionType, payload);
}

function _bumpStampForModule_(moduleName, actionType) {
  const stampMap = {
    leads:     ['leads'],
    followups: ['followups'],
    config:    ['config'],
    stages:    ['stages', 'config'],
    fields:    ['fields', 'config'],
  };
  const actionMap = {
    saveLead:                ['leads', 'followups'],
    saveBulkRows:            ['leads', 'followups'],
    deleteLead:              ['leads', 'followups', 'followup_history', 'activity_logs'],
    updateLeadStage:         ['leads', 'activity_logs'],
    moveLeadStageWithFields: ['leads', 'activity_logs'],
    pushLeadToNbd:           ['leads', 'activity_logs'],
    saveFollowup:            ['followups', 'leads', 'activity_logs'],
    markFollowupDone:        ['followups', 'followup_history', 'leads', 'activity_logs'],
    deleteFollowup:          ['followups'],
    addConfig:               ['config'],
    updateConfigStatus:      ['config'],
    saveStage:               ['stages', 'config'],
    reorderStages:           ['stages', 'config'],
    saveFieldConfig:         ['fields', 'config'],
    savePortalSettings:      ['config', 'leads'],
    saveUser:                ['config']
  };
  Array.from(new Set(actionMap[actionType] || stampMap[moduleName] || [])).forEach(s => _bumpStamp(s));
}

// ── Trigger management ────────────────────────────────────────────────────────
// Call once from the Apps Script editor: setupQueueTrigger()
function setupQueueTrigger() {
  // Remove existing queue triggers first (avoid duplicates)
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'processQueue')
    .forEach(t => ScriptApp.deleteTrigger(t));

  // Create a new every-1-minute trigger
  ScriptApp.newTrigger('processQueue')
    .timeBased()
    .everyMinutes(1)
    .create();

  Logger.log('[QueueWorker] Trigger created: processQueue every 1 minute.');
  return 'Queue trigger installed successfully.';
}

function removeQueueTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'processQueue')
    .forEach(t => ScriptApp.deleteTrigger(t));
  Logger.log('[QueueWorker] Queue trigger removed.');
  return 'Queue trigger removed.';
}

function getQueueTriggerStatus() {
  const triggers = ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'processQueue');
  return triggers.length > 0
    ? 'ACTIVE — ' + triggers.length + ' trigger(s) running'
    : 'NOT SET — run setupQueueTrigger() to enable background processing';
}
