function apiClientFactoryVisitOptions(token) {
  _currentApiToken_ = token || '';
  return apiGuard_('apiClientFactoryVisitOptions', () => respond(_cfvOptions_(_cfvUser_(false))));
}
function apiClientFactoryVisitList(token, query) {
  _currentApiToken_ = token || '';
  return apiGuard_('apiClientFactoryVisitList', () => respond(_cfvList_(_cfvUser_(false), query)));
}
function apiClientFactoryVisitSave(token, payload) {
  _currentApiToken_ = token || '';
  return apiGuard_('apiClientFactoryVisitSave', () => respond(_cfvSave_(_cfvUser_(true), payload)));
}
function apiClientFactoryVisitHistory(token, id) {
  _currentApiToken_ = token || '';
  return apiGuard_('apiClientFactoryVisitHistory', () => respond(_cfvHistory_(_cfvUser_(false), id)));
}
function apiClientFactoryVisitInitialize(token) {
  _currentApiToken_ = token || '';
  return apiGuard_('apiClientFactoryVisitInitialize', () => respond(_cfvInitialize_(_cfvUser_(true))));
}
