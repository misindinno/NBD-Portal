// QueueWorker.gs
// Time-based processor for legacy JOB_QUEUE rows.

const QUEUE_WORKER_ID = 'worker-' + Math.random().toString(36).slice(2, 8);
const QUEUE_WORKER_BATCH_SIZE = 20;
const QUEUE_WORKER_CUTOFF_MS = 4.5 * 60 * 1000;
const QUEUE_WORKER_CLAIM_MARGIN_MS = 30 * 1000;

function processQueue() {
  return withServerContext_(() => {
    ensureQueueSheet_();
    const startMs = Date.now();
    const props = PropertiesService.getScriptProperties();
    props.setProperty('QUEUE_WORKER_LAST_STARTED_AT', now());
    props.setProperty('QUEUE_WORKER_LAST_STATUS', 'RUNNING');
    props.setProperty('QUEUE_WORKER_LAST_ERROR', '');

    let processed = 0;
    let claimedTotal = 0;
    let cutoffHit = false;
    try {
      while (Date.now() - startMs <= QUEUE_WORKER_CUTOFF_MS - QUEUE_WORKER_CLAIM_MARGIN_MS) {
        const jobs = claimJobs_(QUEUE_WORKER_ID, QUEUE_WORKER_BATCH_SIZE);
        claimedTotal += jobs.length;
        if (!jobs.length) break;
        for (const job of jobs) {
          if (Date.now() - startMs > QUEUE_WORKER_CUTOFF_MS) {
            cutoffHit = true;
            break;
          }
          _processQueueJob_(job);
          processed++;
        }
        if (cutoffHit) break;
      }
      props.setProperty('QUEUE_WORKER_LAST_CLAIMED', String(claimedTotal));
      props.setProperty('QUEUE_WORKER_LAST_PROCESSED', String(processed));
      props.setProperty('QUEUE_WORKER_LAST_FINISHED_AT', now());
      props.setProperty('QUEUE_WORKER_LAST_STATUS', !claimedTotal ? 'IDLE' : (cutoffHit ? 'CUTOFF' : 'OK'));
      return { claimed: claimedTotal, processed, cutoffHit };
    } catch (e) {
      props.setProperty('QUEUE_WORKER_LAST_FINISHED_AT', now());
      props.setProperty('QUEUE_WORKER_LAST_STATUS', 'ERROR');
      props.setProperty('QUEUE_WORKER_LAST_ERROR', String(e.message || e).slice(0, 500));
      Logger.log('[QueueWorker] Fatal error: ' + (e.message || e));
      return { claimed: claimedTotal, processed, error: String(e.message || e) };
    }
  });
}

function _processQueueJob_(job) {
  const requestId = String(job['Request ID'] || '');
  const userEmail = String(job['User Email'] || '');
  const moduleName = String(job['Module Name'] || '');
  const actionType = String(job['Action Type'] || '');
  const attempt = Number(job['Attempt Count'] || 0);
  let payload = {};

  try {
    payload = JSON.parse(job['Payload JSON'] || '{}');
  } catch (e) {
    markJobFailed_(requestId, 'Invalid payload JSON: ' + e.message, attempt);
    return;
  }

  try {
    const userResult = getCurrentUserByEmail_(userEmail);
    if (!userResult.success) {
      markJobFailed_(requestId, 'User not found or deactivated: ' + userEmail, Q_MAX_ATTEMPTS - 1);
      return;
    }

    const result = withTrustedWriteUser_(userEmail, () => _dispatchWrite(actionType, userEmail, payload));
    if (!result || !result.success) {
      _handleQueueJobError_(requestId, result ? result.error : 'Unknown error', attempt);
      return;
    }

    const finalRecordId = _extractQueueRecordId_(result.data, actionType, payload);
    markJobDone_(requestId, finalRecordId);
    appendChangeLog_(moduleName, finalRecordId || requestId, actionType, userEmail);
    _bumpStampForQueueAction_(moduleName, actionType);
  } catch (e) {
    _handleQueueJobError_(requestId, e.message || String(e), attempt);
  }
}

function _handleQueueJobError_(requestId, errMsg, attempt) {
  const msg = String(errMsg || 'Unknown error').slice(0, 500);
  const permanent = /permission denied|not authoris|access denied|invalid payload|unsupported|invalid action/i.test(msg);
  markJobFailed_(requestId, msg, permanent ? Q_MAX_ATTEMPTS - 1 : attempt);
  Logger.log('[QueueWorker] Job ' + requestId + ' failed: ' + msg);
}

function _extractQueueRecordId_(data, actionType, payload) {
  if (typeof data === 'string') return data;
  if (data && data.batchId) return data.batchId;
  if (data && data.nbdLeadId) return data.nbdLeadId;
  if (data && data.leadId) return data.leadId;
  if (data && data.followupId) return data.followupId;
  if (data && data.id) return data.id;
  return _qDataId_(actionType, payload);
}

function _bumpStampForQueueAction_(moduleName, actionType) {
  const actionMap = {
    saveLead: ['leads', 'followups'],
    saveBulkRows: ['leads', 'followups'],
    deleteLead: ['leads', 'followups', 'followup_history', 'activity_logs'],
    updateLeadStage: ['leads', 'activity_logs'],
    moveLeadStageWithFields: ['leads', 'activity_logs'],
    pushLeadToNbd: ['leads', 'activity_logs'],
    saveFollowup: ['followups', 'leads', 'activity_logs'],
    markFollowupDone: ['followups', 'followup_history', 'leads', 'activity_logs'],
    deleteFollowup: ['followups'],
    addConfig: ['config'],
    updateConfigStatus: ['config'],
    saveStage: ['stages', 'config'],
    reorderStages: ['stages', 'config'],
    saveFieldConfig: ['fields', 'config'],
    savePortalSettings: ['config', 'leads'],
    saveUser: ['config']
  };
  const moduleMap = {
    leads: ['leads'],
    followups: ['followups'],
    config: ['config'],
    stages: ['stages', 'config'],
    fields: ['fields', 'config']
  };
  Array.from(new Set(actionMap[actionType] || moduleMap[moduleName] || [])).forEach(_bumpStamp);
}

function setupQueueTrigger() {
  return withServerContext_(() => {
    ensureQueueSheet_();
    ScriptApp.getProjectTriggers()
      .filter(t => t.getHandlerFunction() === 'processQueue')
      .forEach(t => ScriptApp.deleteTrigger(t));
    ScriptApp.newTrigger('processQueue').timeBased().everyMinutes(1).create();
    Logger.log('[QueueWorker] Trigger created: processQueue every 1 minute.');
    return 'Queue trigger installed successfully.';
  });
}

function setupQueueTriggerIfMissing_() {
  const exists = ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === 'processQueue');
  if (!exists) setupQueueTrigger();
}

function removeQueueTrigger() {
  return withServerContext_(() => {
    ScriptApp.getProjectTriggers()
      .filter(t => t.getHandlerFunction() === 'processQueue')
      .forEach(t => ScriptApp.deleteTrigger(t));
    Logger.log('[QueueWorker] Queue trigger removed.');
    return 'Queue trigger removed.';
  });
}

function getQueueTriggerStatus() {
  const triggers = ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'processQueue');
  return triggers.length
    ? 'ACTIVE - ' + triggers.length + ' trigger(s) running every minute.'
    : 'NOT SET - run Install Queue Auto Process from the sheet menu.';
}
