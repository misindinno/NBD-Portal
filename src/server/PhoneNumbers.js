// Phone stays scalar. Alternate No stores a newline-separated list, preserving
// existing single-number sheets and IndexedDB row mirrors without a migration.
function leadPhoneParts_(value) {
  return (Array.isArray(value) ? value : String(value == null ? '' : value).split(/[,;\n\r]+/))
    .map(v => String(v).trim()).filter(v => v && !/^(?:n\/?a|null|undefined)$/i.test(v));
}
function leadPhoneKey_(value) {
  let digits = String(value || '').replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  return digits;
}
function leadPhoneNumbers_(lead) {
  const seen = new Set();
  return ['Phone', 'Alternate No', 'WhatsApp No'].reduce((all, key) => all.concat(leadPhoneParts_((lead || {})[key])), [])
    .filter(value => { const key = leadPhoneKey_(value); if (!key || seen.has(key)) return false; seen.add(key); return true; });
}
function validateLeadPhones_(payload, existing) {
  const merged = Object.assign({}, existing || {}, payload);
  for (const field of ['Phone', 'Alternate No']) {
    if (!Object.prototype.hasOwnProperty.call(payload, field)) continue;
    if (existing && String(payload[field]) === String(existing[field])) continue;
    const numbers = leadPhoneParts_(payload[field]);
    if (field === 'Phone' && numbers.length > 1) throw new Error('Choose only one primary phone number.');
    for (const number of numbers) {
      const digits = number.replace(/\D/g, '');
      if (!/^[+\d\s()-]+$/.test(number) || digits.length < 7 || digits.length > 15)
        throw new Error('Enter a valid ' + (field === 'Phone' ? 'primary' : 'additional') + ' phone number (7–15 digits).');
    }
    payload[field] = field === 'Phone' ? (numbers[0] || '') : numbers.filter((n, i, all) =>
      leadPhoneKey_(n) !== leadPhoneKey_(merged.Phone) && all.findIndex(v => leadPhoneKey_(v) === leadPhoneKey_(n)) === i).join('\n');
  }
  return payload;
}
