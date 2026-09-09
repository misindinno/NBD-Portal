// Read FSR directly after Api.js has checked the current user's access to the lead.
// Private helpers cannot be invoked through google.script.run.
function _fsrReadLeadVisits_(leadId, page) {
  assertServerContext_();
  if (typeof leadId !== 'string' || !leadId.trim() || leadId.length > 160 || /[\u0000-\u001f]/.test(leadId)) throw new Error('Invalid client ID.');
  const offset = page == null ? 0 : Number(page);
  if (!Number.isInteger(offset) || offset < 0 || offset > 100000) throw new Error('Invalid history page.');
  const props = PropertiesService.getScriptProperties();
  const baseUrl = String(props.getProperty('FSR_API_BASE_URL') || '').trim().replace(/\/+$/, '');
  const key = String(props.getProperty('FSR_API_KEY') || '').trim();
  if (!baseUrl || !key) return { configured: false, total: 0, offset, nextOffset: null, visits: [], fsrOrigin: '' };
  if (!/^https:\/\/[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?(?::443)?$/.test(baseUrl) || !/^fsr_api_[a-f0-9]{32}\.[A-Za-z0-9_-]{43}$/.test(key)) {
    throw new Error('Check the FSR API URL and key in Script Properties.');
  }
  const sourceKey = typeof CLIENT_CONFIG !== 'undefined' ? CLIENT_CONFIG.FSR_SOURCE_KEY : '';
  if (!/^[a-z0-9][a-z0-9_-]{0,99}$/.test(sourceKey || '')) throw new Error('Configure the FSR source key in ClientConfig.');
  let response;
  try {
    response = UrlFetchApp.fetch(baseUrl + '/api/v1/clients/' + encodeURIComponent(leadId) + '/visits?limit=20&offset=' + offset + '&sourceKey=' + encodeURIComponent(sourceKey), {
      method: 'get', headers: { Accept: 'application/json', Authorization: 'Bearer ' + key },
      muteHttpExceptions: true, followRedirects: false
    });
  } catch (_) { throw new Error('FSR visit history is temporarily unavailable. Try again.'); }
  const status = response.getResponseCode();
  if (status === 401 || status === 403) throw new Error('FSR API access was rejected. Ask an administrator to check the API key.');
  if (status === 404) throw new Error('FSR history endpoint was not found. Ask an administrator to check the deployed FSR URL.');
  if (status === 409) throw new Error('FSR could not identify a unique client. Ask an administrator to check the portal source key.');
  if (status === 429) throw new Error('FSR is receiving too many requests. Wait a moment, then refresh history.');
  if (status !== 200) throw new Error('FSR visit history is temporarily unavailable. Try again.');
  let data;
  try { data = JSON.parse(response.getContentText()).data; }
  catch (_) { throw new Error('FSR returned an invalid history response.'); }
  const pagination = data && data.pagination;
  if (!data || !data.client || data.client.id !== leadId || data.client.sourceKey !== sourceKey || !Array.isArray(data.visits) || data.visits.length > 20 ||
      data.visits.some(visit => !visit || typeof visit.id !== 'string' || visit.sourceRecordId !== leadId || visit.sourceKey !== data.client.sourceKey) ||
      !pagination || pagination.offset !== offset || pagination.limit !== 20 || !Number.isInteger(pagination.total) || pagination.total < 0 ||
      (pagination.nextOffset !== null && (pagination.nextOffset !== offset + 20 || pagination.nextOffset >= pagination.total))) {
    throw new Error('FSR returned an invalid history response.');
  }
  return { configured: true, total: pagination.total, offset, nextOffset: pagination.nextOffset, visits: data.visits, fsrOrigin: baseUrl };
}

// Only these fixed messages may cross the API boundary. Never return an upstream
// response body, request URL, API key, or arbitrary exception text to the browser.
function _fsrHistoryErrorInfo_(error) {
  const message = String(error && error.message || error || '');
  const messages = {
    'Check the FSR API URL and key in Script Properties.': 'FSR_CONFIGURATION_ERROR',
    'Configure the FSR source key in ClientConfig.': 'FSR_CONFIGURATION_ERROR',
    'FSR API access was rejected. Ask an administrator to check the API key.': 'FSR_ACCESS_DENIED',
    'FSR history endpoint was not found. Ask an administrator to check the deployed FSR URL.': 'FSR_ENDPOINT_NOT_FOUND',
    'FSR could not identify a unique client. Ask an administrator to check the portal source key.': 'FSR_CLIENT_AMBIGUOUS',
    'FSR is receiving too many requests. Wait a moment, then refresh history.': 'FSR_RATE_LIMITED',
    'FSR visit history is temporarily unavailable. Try again.': 'FSR_UNAVAILABLE',
    'FSR returned an invalid history response.': 'FSR_INVALID_RESPONSE'
  };
  return Object.prototype.hasOwnProperty.call(messages, message)
    ? { code: messages[message], message } : null;
}
