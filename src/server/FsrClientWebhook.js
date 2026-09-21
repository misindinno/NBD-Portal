// Signed, best-effort outbound sync for LEAD_MASTER rows. Client identity is
// embedded in each lead row in this portal, so one delivery covers both models.

const FSR_WEBHOOK_URL_PROPERTY_ = 'FSR_WEBHOOK_URL';
const FSR_WEBHOOK_SECRET_PROPERTY_ = 'FSR_WEBHOOK_SECRET';
const FSR_CLIENT_SHEET_PROPERTY_ = 'FSR_CLIENT_SHEET';
const FSR_WEBHOOK_BATCH_SIZE_ = 50;
const FSR_WEBHOOK_RESPONSE_LOG_LIMIT_ = 2000;
const FSR_WEBHOOK_MAX_ATTEMPTS_ = 3;
const FSR_WEBHOOK_RETRY_BASE_MS_ = 1000;
const FSR_EVENT_TYPES_ = [
  'client.created',
  'client.updated',
  'client.assigned',
  'client.merged',
  'client.closed',
  'client.deleted'
];

function handleFsrClientEdit(event) {
  if (!event || !event.range) return;
  return withServerContext_(() => fsrSendRange_(event.range, 'client.updated'));
}

function handleFsrClientCreate(event) {
  if (!event || !event.range) return;
  return withServerContext_(() => fsrSendRange_(event.range, 'client.created'));
}

function installFsrClientTriggers() {
  return withServerContext_(() => {
    requireContainerAdmin_(false);
    _installFsrClientTrigger_('handleFsrClientEdit', ScriptApp.EventType.ON_EDIT);
    _installFsrClientTrigger_('handleFsrClientCreate', ScriptApp.EventType.ON_FORM_SUBMIT);
    return 'FSR lead/client edit and form-submit triggers installed.';
  });
}

function installFsrClientEditTrigger() {
  return withServerContext_(() => {
    requireContainerAdmin_(false);
    return _installFsrClientTrigger_('handleFsrClientEdit', ScriptApp.EventType.ON_EDIT);
  });
}

function installFsrClientCreateTrigger() {
  return withServerContext_(() => {
    requireContainerAdmin_(false);
    return _installFsrClientTrigger_('handleFsrClientCreate', ScriptApp.EventType.ON_FORM_SUBMIT);
  });
}

function setFsrClientWebhookProperties(url, secret, sheetName) {
  return withServerContext_(() => {
    requireContainerAdmin_(false);
    url = String(url || '').trim();
    secret = String(secret || '').trim();
    sheetName = String(sheetName || SHEET_NAMES.LEADS).trim();
    if (!/^https:\/\//i.test(url)) throw new Error('FSR webhook URL must be public HTTPS.');
    if (!secret) throw new Error('FSR webhook secret is required.');
    PropertiesService.getScriptProperties().setProperties({
      FSR_WEBHOOK_URL: url,
      FSR_WEBHOOK_SECRET: secret,
      FSR_CLIENT_SHEET: sheetName
    }, false);
    return { configured: true, sheetName, url };
  });
}

function getFsrClientWebhookStatus() {
  return withServerContext_(() => {
    requireContainerAdmin_(false);
    return _fsrClientWebhookStatus_();
  });
}

function _fsrClientWebhookStatus_() {
  const config = _fsrWebhookConfig_();
  return {
    configured: !!(config.url && config.secret),
    urlConfigured: !!config.url,
    secretConfigured: !!config.secret,
    sheetName: config.sheetName,
    editTriggerInstalled: _hasFsrClientTrigger_('handleFsrClientEdit'),
    createTriggerInstalled: _hasFsrClientTrigger_('handleFsrClientCreate')
  };
}

function pushFsrCreatedRow(rowNumber) {
  return withServerContext_(() => {
    requireContainerAdmin_(false);
    return _pushFsrLeadRows_([Number(rowNumber)], 'client.created');
  });
}

const FSR_SYNC_QUEUE_SHEET_ = 'FSR_SYNC_QUEUE';
const FSR_SYNC_QUEUE_HEADERS_ = ['Queue ID','Lead IDs','Event Type','Status','Attempts','Created At','Updated At','Last Error'];

// Portal writes save first, then leave outbound delivery to a separate execution.
function pushFsrLeadById_(leadId, eventType, sheet) {
  return pushFsrLeadIds_([leadId], eventType, sheet)[0] || { skipped: true, reason: 'lead_id_missing' };
}

function pushFsrLeadIds_(leadIds, eventType, sheet) {
  try {
    assertServerContext_();
    const config = _fsrWebhookConfig_();
    if (!config.url || !config.secret) return [{ skipped: true, reason: 'missing_webhook_config' }];
    if (sheet && !_isFsrClientSheet_(sheet)) return [{ skipped: true, reason: 'not_client_sheet' }];
    const ids = Array.from(new Set((leadIds || []).map(id => String(id || '').trim()).filter(Boolean)));
    if (!ids.length) return [];
    const event = _fsrEventType_(eventType);
    safeInitHeaders(FSR_SYNC_QUEUE_SHEET_, FSR_SYNC_QUEUE_HEADERS_);
    const queue = getSheet(FSR_SYNC_QUEUE_SHEET_);
    const createdAt = now();
    const rows = [];
    for (let i = 0; i < ids.length; i += 25) {
      rows.push([Utilities.getUuid(), JSON.stringify(ids.slice(i, i + 25)), event, 'Pending', 0, createdAt, createdAt, '']);
    }
    queue.getRange(queue.getLastRow() + 1, 1, rows.length, FSR_SYNC_QUEUE_HEADERS_.length).setValues(rows);
    SpreadsheetApp.flush();
    _ensureFsrSyncWorker_();
    return [{ queued: true, count: ids.length }];
  } catch (error) {
    _logFsrWebhookFailure_('queue_failed', error, { eventType });
    return [{ error: diagnosticErrorSummary_(error) }];
  }
}

function _ensureFsrSyncWorker_() {
  if (!ScriptApp.getProjectTriggers().some(trigger => trigger.getHandlerFunction() === 'processFsrSyncQueue_')) {
    ScriptApp.newTrigger('processFsrSyncQueue_').timeBased().everyMinutes(1).create();
  }
}

// A worker failure leaves the item in the sheet for the next run or manual retry.
function processFsrSyncQueue_() {
  return withServerContext_(() => {
    const started = Date.now();
    const attempted = new Set();
    for (let processed = 0; processed < 5 && Date.now() - started < 180000; processed++) {
      const lock = LockService.getScriptLock();
      if (!lock.tryLock(1000)) return;
      let job;
      try {
        const queue = getSpreadsheet(FSR_SYNC_QUEUE_SHEET_).getSheetByName(FSR_SYNC_QUEUE_SHEET_);
        if (!queue || queue.getLastRow() < 2) return;
        let values = queue.getRange(2, 1, queue.getLastRow() - 1, FSR_SYNC_QUEUE_HEADERS_.length).getValues();
        if (!values.some(row => row[3] === 'Processing')) {
          const done = values.map((row, i) => ({ row: i + 2, status: row[3] })).filter(item => item.status === 'Done');
          done.slice(0, Math.max(0, done.length - 300)).reverse().forEach(item => queue.deleteRows(item.row, 1));
          if (done.length > 300) values = queue.getRange(2, 1, queue.getLastRow() - 1, FSR_SYNC_QUEUE_HEADERS_.length).getValues();
        }
        const index = values.findIndex(row => !attempted.has(String(row[0])) && (row[3] === 'Pending' || (row[3] === 'Processing' && Date.now() - new Date(row[6]).getTime() > 600000)));
        if (index < 0) return;
        const row = values[index];
        job = { sheet: queue, rowNumber: index + 2, id: row[0], ids: row[1], event: row[2], attempts: Number(row[4] || 0), createdAt: row[5] };
        attempted.add(String(job.id));
        queue.getRange(job.rowNumber, 4, 1, 4).setValues([['Processing', job.attempts, row[5], now()]]);
        SpreadsheetApp.flush();
      } finally { lock.releaseLock(); }

      let failure = '';
      try {
        const ids = JSON.parse(job.ids);
        if (!Array.isArray(ids) || ids.length > 25) throw new Error('Invalid queued lead IDs.');
        const wanted = ids.reduce((map, id) => { map[String(id)] = true; return map; }, {});
        const sheet = getSheet(SHEET_NAMES.LEADS);
        const found = _fsrLeadRowNumbersById_(sheet, wanted);
        if (found.length) {
          const results = _pushFsrLeadRows_(found, job.event, sheet);
          if (results.some(result => result.error || result.skipped || (result.status && (result.status < 200 || result.status >= 300)))) {
            throw new Error('FSR delivery failed; inspect webhook diagnostics.');
          }
        }
      } catch (error) {
        failure = diagnosticErrorSummary_(error);
        _logFsrWebhookFailure_('queued_delivery_failed', error, { queueId: job.id, attempt: job.attempts + 1 });
      }

      const finishLock = LockService.getScriptLock(); finishLock.waitLock(10000);
      try {
        const attempts = job.attempts + (failure ? 1 : 0);
        const status = failure ? attempts >= 3 ? 'Failed' : 'Pending' : 'Done';
        job.sheet.getRange(job.rowNumber, 4, 1, 5).setValues([[status, attempts, job.createdAt, now(), failure]]);
        SpreadsheetApp.flush();
      } finally { finishLock.releaseLock(); }
    }
  });
}

function retryFailedFsrSyncQueue_() {
  return withServerContext_(() => {
    requireContainerAdmin_(false);
    const lock = LockService.getScriptLock(); lock.waitLock(10000);
    try {
      const queue = getSpreadsheet(FSR_SYNC_QUEUE_SHEET_).getSheetByName(FSR_SYNC_QUEUE_SHEET_);
      if (!queue || queue.getLastRow() < 2) return 0;
      const statuses = queue.getRange(2, 4, queue.getLastRow() - 1, 2).getValues();
      let retried = 0;
      statuses.forEach((row, i) => {
        if (row[0] !== 'Failed') return;
        queue.getRange(i + 2, 4, 1, 2).setValues([['Pending', 0]]);
        retried++;
      });
      if (retried) _ensureFsrSyncWorker_();
      return retried;
    } finally { lock.releaseLock(); }
  });
}

function fsrSendRange_(range, eventType) {
  try {
    const sheet = range.getSheet();
    if (!_isFsrClientSheet_(sheet)) return [{ skipped: true, reason: 'not_client_sheet' }];
    const start = Math.max(2, range.getRow());
    const end = Math.min(sheet.getLastRow(), range.getLastRow());
    const rows = [];
    for (let row = start; row <= end; row++) rows.push(row);
    return _pushFsrLeadRows_(rows, eventType || 'client.updated', sheet);
  } catch (error) {
    _logFsrWebhookFailure_('range_send_failed', error, { eventType });
    return [{ error: diagnosticErrorSummary_(error) }];
  }
}

function _pushFsrLeadRows_(rowNumbers, eventType, sheet) {
  const config = _fsrWebhookConfig_();
  if (!config.url || !config.secret) return [{ skipped: true, reason: 'missing_webhook_config' }];
  sheet = sheet || getSheet(SHEET_NAMES.LEADS);
  if (!_isFsrClientSheet_(sheet)) return [{ skipped: true, reason: 'not_client_sheet' }];

  const uniqueRows = Array.from(new Set((rowNumbers || [])
    .map(Number)
    .filter(row => row >= 2 && row <= sheet.getLastRow())))
    .sort((a, b) => a - b);
  if (!uniqueRows.length) return [];

  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]
    .map(header => String(header || '').trim());
  const deliveries = uniqueRows
    .map(rowNumber => _fsrBuildLeadDelivery_(sheet, headers, rowNumber, eventType))
    .filter(Boolean);
  const results = [];
  for (let offset = 0; offset < deliveries.length; offset += FSR_WEBHOOK_BATCH_SIZE_) {
    _fsrPostDeliveryBatch_(deliveries.slice(offset, offset + FSR_WEBHOOK_BATCH_SIZE_), config).forEach(result => results.push(result));
  }
  return results;
}

function _fsrBuildLeadDelivery_(sheet, headers, rowNumber, eventType) {
  const values = sheet.getRange(rowNumber, 1, 1, headers.length).getValues()[0];
  const row = {};
  headers.forEach((header, index) => {
    if (header) row[header] = normalizeSheetValue(values[index]);
  });
  const recordId = _fsrLeadValue_(row, ['Lead ID', 'Client ID', 'ID'], 160);
  const data = _fsrClientDataFromLead_(row);
  if (!recordId || !data.name) return null;

  const normalizedEvent = _fsrEventType_(eventType);
  const payload = {
    schemaVersion: '1.0',
    eventType: normalizedEvent,
    occurredAt: new Date().toISOString(),
    source: {
      recordId,
      clientId: recordId
    },
    data
  };
  const version = Number(_fsrLeadValue_(row, ['Version', 'Record Version'], 20));
  if (Number.isInteger(version) && version >= 0) payload.source.version = version;
  if (normalizedEvent === 'client.merged') {
    const mergedIntoRecordId = _fsrLeadValue_(row, ['Merged Into Record ID', 'Merged Into Client ID'], 160);
    if (!mergedIntoRecordId) throw new Error('Merged Into Record ID is required for client.merged.');
    payload.data.mergedIntoRecordId = mergedIntoRecordId;
  }

  return {
    body: JSON.stringify(payload),
    event: normalizedEvent,
    eventId: 'evt_' + Utilities.getUuid(),
    requestId: 'req_' + Utilities.getUuid(),
    recordId,
    rowNumber
  };
}

function _fsrPostDeliveryBatch_(deliveries, config) {
  if (!deliveries.length) return [];
  const resultsByEventId = {};
  let pending = deliveries.slice();

  for (let attempt = 1; attempt <= FSR_WEBHOOK_MAX_ATTEMPTS_ && pending.length; attempt++) {
    let responses;
    try {
      responses = UrlFetchApp.fetchAll(pending.map(delivery => _fsrRequestForAttempt_(delivery, config)));
    } catch (error) {
      pending.forEach(delivery => _logFsrWebhookFailure_('delivery_attempt_failed', error, {
        attempt,
        event: delivery.event,
        eventId: delivery.eventId,
        requestId: delivery.requestId,
        sourceRecordId: delivery.recordId,
        rowNumber: delivery.rowNumber
      }));
      if (attempt < FSR_WEBHOOK_MAX_ATTEMPTS_) {
        Utilities.sleep(FSR_WEBHOOK_RETRY_BASE_MS_ * Math.pow(2, attempt - 1));
        continue;
      }
      pending.forEach(delivery => {
        resultsByEventId[delivery.eventId] = _fsrDeliveryErrorResult_(delivery, error, attempt);
      });
      break;
    }

    const retry = [];
    pending.forEach((delivery, index) => {
      const response = responses[index];
      const status = response.getResponseCode();
      const responseBody = _fsrWebhookResponseForLog_(response);
      const result = {
        status,
        event: delivery.event,
        eventId: delivery.eventId,
        requestId: delivery.requestId,
        recordId: delivery.recordId,
        rowNumber: delivery.rowNumber,
        attempt,
        response: responseBody
      };
      _logFsrWebhookResponse_(delivery, status, responseBody, attempt);
      if (_fsrRetryableStatus_(status) && attempt < FSR_WEBHOOK_MAX_ATTEMPTS_) {
        retry.push(delivery);
        return;
      }
      if (status < 200 || status >= 300) {
        _logFsrWebhookFailure_('delivery_rejected', new Error('FSR webhook HTTP ' + status), {
          status,
          attempt,
          event: delivery.event,
          eventId: delivery.eventId,
          requestId: delivery.requestId,
          sourceRecordId: delivery.recordId,
          rowNumber: delivery.rowNumber
        });
      }
      resultsByEventId[delivery.eventId] = result;
    });

    pending = retry;
    if (pending.length) Utilities.sleep(FSR_WEBHOOK_RETRY_BASE_MS_ * Math.pow(2, attempt - 1));
  }

  return deliveries.map(delivery => resultsByEventId[delivery.eventId] || {
    error: 'Webhook delivery ended without a result.',
    event: delivery.event,
    eventId: delivery.eventId,
    requestId: delivery.requestId,
    recordId: delivery.recordId,
    rowNumber: delivery.rowNumber
  });
}

function _fsrRequestForAttempt_(delivery, config) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  return {
    url: config.url,
    method: 'post',
    contentType: 'application/json',
    payload: delivery.body,
    muteHttpExceptions: true,
    headers: {
      'X-FSR-Event-Id': delivery.eventId,
      'X-FSR-Timestamp': timestamp,
      'X-FSR-Signature': 'v1=' + _fsrWebhookSignature_(config.secret, timestamp + '.' + delivery.body),
      'X-Request-Id': delivery.requestId
    }
  };
}

function _fsrRetryableStatus_(status) {
  return status === 429 || status === 500 || status === 503;
}

function _fsrDeliveryErrorResult_(delivery, error, attempt) {
  return {
    error: diagnosticErrorSummary_(error),
    event: delivery.event,
    eventId: delivery.eventId,
    requestId: delivery.requestId,
    recordId: delivery.recordId,
    rowNumber: delivery.rowNumber,
    attempt
  };
}

function _logFsrWebhookResponse_(delivery, status, responseBody, attempt) {
  try {
    diagnosticLog_(status >= 200 && status < 300 ? 'INFO' : 'WARN', 'INTEGRATION.FSR_WEBHOOK', 'delivery_response', {
      status,
      attempt,
      event: delivery.event,
      eventId: delivery.eventId,
      requestId: delivery.requestId,
      sourceRecordId: delivery.recordId,
      rowNumber: delivery.rowNumber,
      response: responseBody
    });
  } catch (_) {
    try {
      Logger.log('[FSR webhook response] ' + JSON.stringify({
        status,
        attempt,
        event: delivery.event,
        eventId: delivery.eventId,
        requestId: delivery.requestId,
        rowNumber: delivery.rowNumber
      }));
    } catch (_) {}
  }
}

function _fsrWebhookResponseForLog_(response) {
  try {
    const text = String(response && response.getContentText ? response.getContentText() : '').trim();
    if (!text) return null;
    const truncated = text.length > FSR_WEBHOOK_RESPONSE_LOG_LIMIT_;
    const bounded = text.slice(0, FSR_WEBHOOK_RESPONSE_LOG_LIMIT_);
    if (!truncated) {
      try { return JSON.parse(bounded); }
      catch (_) {}
    }
    return { body: bounded, truncated };
  } catch (error) {
    return { unavailable: true, reason: diagnosticErrorSummary_(error) };
  }
}

function _fsrClientDataFromLead_(row) {
  return {
    name: _fsrLeadValue_(row, ['Company Name', 'Client Name', 'Shop Name', 'Firm Name', 'Name'], 200),
    contact: _fsrLeadValue_(row, ['Contact Person', 'Primary Contact Person', 'Contact Name'], 160),
    phone: _fsrLeadValue_(row, ['Primary Mobile', 'Primary Mobile Number', 'Primary Contact Number', 'Phone', 'Mobile', 'Alternate Mobile'], 40),
    address: _fsrLeadValue_(row, ['Address', 'Full Address', 'Billing Address', 'Location'], 500),
    city: _fsrLeadValue_(row, ['City', 'District'], 120),
    state: _fsrLeadValue_(row, ['State', 'State Name', 'Province', 'Region'], 120),
    leadSource: _fsrLeadValue_(row, ['Source', 'Lead Source', 'Enquiry Source', 'Inquiry Source', 'Campaign Source'], 160),
    status: _fsrLeadValue_(row, ['Lead Status', 'Status', 'Client Status', 'Active Status'], 80) || 'ACTIVE',
    assignedTo: _fsrLeadValue_(row, ['Assigned User ID', 'Assigned User Id', 'Assigned User', 'Assigned To', 'Owner', 'Sales Person', 'Salesperson', 'FSR'], 200)
  };
}

function _fsrLeadValue_(row, aliases, maxLength) {
  for (let index = 0; index < aliases.length; index++) {
    const value = row[aliases[index]];
    if (value !== null && value !== undefined && String(value).trim() !== '') {
      return String(value).trim().slice(0, maxLength);
    }
  }
  return '';
}

function _fsrEventType_(eventType) {
  const normalized = String(eventType || 'client.updated').trim().toLowerCase();
  if (FSR_EVENT_TYPES_.indexOf(normalized) === -1) {
    throw new Error('Unsupported FSR webhook event type: ' + normalized);
  }
  return normalized;
}

function _fsrLeadRowNumbersById_(sheet, wanted) {
  if (sheet.getLastRow() < 2) return [];
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(String);
  const idColumn = headers.indexOf('Lead ID');
  if (idColumn === -1) return [];
  return sheet.getRange(2, idColumn + 1, sheet.getLastRow() - 1, 1).getValues()
    .reduce((rows, value, index) => {
      if (wanted[String(value[0] || '').trim()]) rows.push(index + 2);
      return rows;
    }, []);
}

function _fsrWebhookSignature_(secret, message) {
  const bytes = Utilities.computeHmacSha256Signature(message, secret, Utilities.Charset.UTF_8);
  return bytes.map(byte => {
    const value = byte < 0 ? byte + 256 : byte;
    return ('0' + value.toString(16)).slice(-2);
  }).join('');
}

function _fsrWebhookConfig_() {
  const properties = PropertiesService.getScriptProperties();
  return {
    url: String(properties.getProperty(FSR_WEBHOOK_URL_PROPERTY_) || '').trim(),
    secret: String(properties.getProperty(FSR_WEBHOOK_SECRET_PROPERTY_) || '').trim(),
    sheetName: String(properties.getProperty(FSR_CLIENT_SHEET_PROPERTY_) || SHEET_NAMES.LEADS).trim()
  };
}

function _isFsrClientSheet_(sheet) {
  if (!sheet) return false;
  const actual = String(sheet.getName() || '').trim().toLowerCase();
  const configured = _fsrWebhookConfig_().sheetName.toLowerCase();
  return [String(SHEET_NAMES.LEADS).toLowerCase(), configured].indexOf(actual) !== -1;
}

function _installFsrClientTrigger_(handler, eventType) {
  const spreadsheet = SpreadsheetApp.openById(CLIENT_CONFIG.SPREADSHEET_ID);
  ScriptApp.getProjectTriggers()
    .filter(trigger => trigger.getHandlerFunction && trigger.getHandlerFunction() === handler)
    .forEach(trigger => ScriptApp.deleteTrigger(trigger));
  const builder = ScriptApp.newTrigger(handler).forSpreadsheet(spreadsheet);
  if (eventType === ScriptApp.EventType.ON_FORM_SUBMIT) builder.onFormSubmit();
  else builder.onEdit();
  builder.create();
  return handler + ' installed.';
}

function _hasFsrClientTrigger_(handler) {
  return ScriptApp.getProjectTriggers().some(trigger =>
    trigger.getHandlerFunction && trigger.getHandlerFunction() === handler
  );
}

function _logFsrWebhookFailure_(event, error, details) {
  try {
    if (typeof diagnosticLog_ === 'function') {
      diagnosticLog_('WARN', 'INTEGRATION.FSR_WEBHOOK', event, {
        error,
        details: details || {}
      });
      return;
    }
  } catch (_) {}
  try { Logger.log('[FSR webhook] ' + event + ': ' + diagnosticErrorSummary_(error)); }
  catch (_) {}
}
