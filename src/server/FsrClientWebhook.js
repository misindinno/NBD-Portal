// Signed, best-effort outbound sync for LEAD_MASTER rows. Client identity is
// embedded in each lead row in this portal, so one delivery covers both models.

const FSR_WEBHOOK_URL_PROPERTY_ = 'FSR_WEBHOOK_URL';
const FSR_WEBHOOK_SECRET_PROPERTY_ = 'FSR_WEBHOOK_SECRET';
const FSR_CLIENT_SHEET_PROPERTY_ = 'FSR_CLIENT_SHEET';
const FSR_WEBHOOK_BATCH_SIZE_ = 50;

function handleFsrClientEdit(event) {
  if (!event || !event.range) return;
  return withServerContext_(() => fsrSendRange_(event.range, 'client.updated'));
}

function handleFsrClientCreate(event) {
  if (!event || !event.range) return;
  return withServerContext_(() => fsrSendRange_(event.range, 'client.created'));
}

function installFsrClientTriggers() {
  requireContainerAdmin_(false);
  installFsrClientEditTrigger();
  installFsrClientCreateTrigger();
  return 'FSR lead/client edit and form-submit triggers installed.';
}

function installFsrClientEditTrigger() {
  requireContainerAdmin_(false);
  return _installFsrClientTrigger_('handleFsrClientEdit', ScriptApp.EventType.ON_EDIT);
}

function installFsrClientCreateTrigger() {
  requireContainerAdmin_(false);
  return _installFsrClientTrigger_('handleFsrClientCreate', ScriptApp.EventType.ON_FORM_SUBMIT);
}

function setFsrClientWebhookProperties(url, secret, sheetName) {
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
}

function getFsrClientWebhookStatus() {
  requireContainerAdmin_(false);
  return _fsrClientWebhookStatus_();
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
  requireContainerAdmin_(false);
  return withServerContext_(() => _pushFsrLeadRows_([Number(rowNumber)], 'client.created'));
}

function pushFsrLeadById_(leadId, eventType, sheet) {
  return pushFsrLeadIds_([leadId], eventType, sheet)[0] || { skipped: true, reason: 'lead_row_not_found' };
}

function pushFsrLeadIds_(leadIds, eventType, sheet) {
  try {
    sheet = sheet || getSheet(SHEET_NAMES.LEADS);
    if (!_isFsrClientSheet_(sheet)) return [{ skipped: true, reason: 'not_client_sheet' }];
    const wanted = (leadIds || []).reduce((map, id) => {
      const value = String(id || '').trim();
      if (value) map[value] = true;
      return map;
    }, {});
    if (!Object.keys(wanted).length) return [];
    const rows = _fsrLeadRowNumbersById_(sheet, wanted);
    return _pushFsrLeadRows_(rows, eventType || 'client.updated', sheet);
  } catch (error) {
    _logFsrWebhookFailure_('lead_lookup_failed', error, { eventType });
    return [{ error: diagnosticErrorSummary_(error) }];
  }
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
    .map(rowNumber => _fsrBuildLeadDelivery_(sheet, headers, rowNumber, eventType, config))
    .filter(Boolean);
  const results = [];
  for (let offset = 0; offset < deliveries.length; offset += FSR_WEBHOOK_BATCH_SIZE_) {
    _fsrPostDeliveryBatch_(deliveries.slice(offset, offset + FSR_WEBHOOK_BATCH_SIZE_)).forEach(result => results.push(result));
  }
  return results;
}

function _fsrBuildLeadDelivery_(sheet, headers, rowNumber, eventType, config) {
  const values = sheet.getRange(rowNumber, 1, 1, headers.length).getValues()[0];
  const row = {};
  headers.forEach((header, index) => {
    if (header) row[header] = normalizeSheetValue(values[index]);
  });
  const recordId = String(row['Lead ID'] || '').trim();
  const clientName = String(row['Company Name'] || row['Client Name'] || '').trim();
  if (!recordId || !clientName) return null;

  const timestamp = String(Date.now());
  const payload = {
    event: eventType || 'client.updated',
    source: {
      system: 'google_sheets',
      spreadsheetId: sheet.getParent().getId(),
      sheetName: sheet.getName(),
      rowNumber,
      recordId
    },
    client: _fsrClientPayloadFromLead_(row),
    row
  };
  const body = JSON.stringify(payload);
  return {
    request: {
      url: config.url,
      method: 'post',
      contentType: 'application/json',
      payload: body,
      muteHttpExceptions: true,
      headers: {
        'X-FSR-Timestamp': timestamp,
        'X-FSR-Signature': 'sha256=' + _fsrWebhookSignature_(config.secret, timestamp + '.' + body)
      }
    },
    event: payload.event,
    recordId,
    rowNumber
  };
}

function _fsrPostDeliveryBatch_(deliveries) {
  if (!deliveries.length) return [];
  try {
    const responses = UrlFetchApp.fetchAll(deliveries.map(delivery => delivery.request));
    return deliveries.map((delivery, index) => {
      const status = responses[index].getResponseCode();
      const result = {
        status,
        event: delivery.event,
        recordId: delivery.recordId,
        rowNumber: delivery.rowNumber
      };
      if (status < 200 || status >= 300) {
        _logFsrWebhookFailure_('delivery_rejected', new Error('FSR webhook HTTP ' + status), result);
      }
      return result;
    });
  } catch (error) {
    _logFsrWebhookFailure_('delivery_failed', error, { batchSize: deliveries.length });
    return deliveries.map(delivery => ({
      error: diagnosticErrorSummary_(error),
      event: delivery.event,
      recordId: delivery.recordId,
      rowNumber: delivery.rowNumber
    }));
  }
}

function _fsrClientPayloadFromLead_(row) {
  return {
    'Client ID': row['Lead ID'] || '',
    'Client Name': row['Company Name'] || row['Client Name'] || '',
    'Contact Person': row['Contact Person'] || '',
    'Phone': row['Phone'] || row['Primary Mobile'] || '',
    'Address': row['Address'] || '',
    'City': row['City'] || '',
    'State': row['State'] || '',
    'Status': row['Lead Status'] || row['Status'] || '',
    'Assigned To': row['Assigned To'] || row['Sales Person'] || ''
  };
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
  const bytes = Utilities.computeHmacSha256Signature(message, secret);
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
