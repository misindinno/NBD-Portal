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
  let response;
  try {
    response = UrlFetchApp.fetch(baseUrl + '/api/v1/clients/' + encodeURIComponent(leadId) + '/visits?limit=20&offset=' + offset, {
      method: 'get', headers: { Accept: 'application/json', Authorization: 'Bearer ' + key },
      muteHttpExceptions: true, followRedirects: false
    });
  } catch (_) { throw new Error('FSR visit history is temporarily unavailable. Try again.'); }
  const status = response.getResponseCode();
  if (status === 401 || status === 403) throw new Error('FSR API access was rejected. Ask an administrator to check the API key.');
  if (status !== 200) throw new Error('FSR visit history is temporarily unavailable. Try again.');
  let data;
  try { data = JSON.parse(response.getContentText()).data; }
  catch (_) { throw new Error('FSR returned an invalid history response.'); }
  const pagination = data && data.pagination;
  if (!data || !data.client || data.client.id !== leadId || !Array.isArray(data.visits) || data.visits.length > 20 ||
      data.visits.some(visit => !visit || typeof visit.id !== 'string' || visit.sourceRecordId !== leadId || visit.sourceKey !== data.client.sourceKey) ||
      !pagination || pagination.offset !== offset || pagination.limit !== 20 || !Number.isInteger(pagination.total) || pagination.total < 0 ||
      (pagination.nextOffset !== null && (pagination.nextOffset !== offset + 20 || pagination.nextOffset >= pagination.total))) {
    throw new Error('FSR returned an invalid history response.');
  }
  return { configured: true, total: pagination.total, offset, nextOffset: pagination.nextOffset, visits: data.visits, fsrOrigin: baseUrl };
}
