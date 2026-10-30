// Convert only schema date columns, never IDs, phone numbers or arbitrary text.
// Sheets serials represent local wall-clock time, not a UTC instant.
function sheetDateCell_(value, header) {
  if (typeof _isDateColumnHeader_ !== 'function' || !_isDateColumnHeader_(header)) return null;
  let text = value;
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) return null;
    text = Utilities.formatDate(value, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');
  }
  if (typeof text !== 'string') return null;
  const match = text.match(/^'?(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!match) return null; // Do not guess locale-dependent or timezone-bearing strings.
  const parts = match.slice(1).map(v => Number(v || 0));
  const [year, month, day, hour, minute, second] = parts;
  if (year < 1900 || hour > 23 || minute > 59 || second > 59) return null;
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return {
    serial: date.getTime() / 86400000 + 25569,
    text: text.replace(/^'/, '').replace('T', ' '),
    pattern: match[4] === undefined ? 'yyyy-mm-dd' : 'yyyy-mm-dd hh:mm:ss'
  };
}

function sheetTypedRow_(values, headers) {
  return values.map((value, index) => {
    const date = sheetDateCell_(value, headers[index]);
    if (!date) return value;
    const text = date.text.length === 10 ? date.text + ' 00:00:00' : date.text.length === 16 ? date.text + ':00' : date.text;
    return Utilities.parseDate(text, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');
  });
}

function formatSheetDateRow_(sheet, rowNumber, values, headers) {
  values.forEach((value, index) => {
    const date = sheetDateCell_(value, headers[index]);
    if (date) sheet.getRange(rowNumber, index + 1).setNumberFormat(date.pattern);
  });
}
