// ─── FieldValidation.js (server) ─────────────────────────────────────────────
// Shared field validation logic.
// Client-side mirror: src/FieldValidation.html — keep the two in sync.

const FieldValidation = {
  COLUMN_KEY_RE: /^[A-Za-z][A-Za-z0-9_]{1,60}$/,

  ALLOWED_FIELD_TYPES: [
    'Text', 'Textarea', 'Number', 'Date', 'Date Time', 'Time',
    'Select', 'Multi Select', 'Checkbox', 'Email', 'Phone', 'URL',
    'File', 'Formula',
  ],

  ALLOWED_SHEETS: ['Leads', 'Followups', 'Visits'],

  // Derive a column key from a human-readable field name (same as server _columnKeyFromName)
  columnKeyFromName(name) {
    return 'CF_' + String(name || '').trim()
      .replace(/[^A-Za-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 50);
  },

  // Validate a field config payload before saving.
  // existingFields: array of current field rows (used for duplicate-key check).
  // Returns { ok: true, derivedKey } on success,
  //         { ok: false, field, message, derivedKey? } on first error.
  validateField(field, existingFields) {
    const fieldName = String(field['Field Name'] || '').trim();
    if (!fieldName) return { ok: false, field: 'Field Name', message: 'Field Name is required.' };

    const rawKey = String(field['Column Key'] || '').trim() || this.columnKeyFromName(fieldName);
    if (!this.COLUMN_KEY_RE.test(rawKey)) return {
      ok: false, field: 'Column Key', derivedKey: rawKey,
      message: 'Column Key must start with a letter and contain only letters, numbers, or underscores (2–61 chars).',
    };

    const sheetName = String(field['Sheet Name'] || 'Leads').trim();
    if (!this.ALLOWED_SHEETS.includes(sheetName)) return {
      ok: false, field: 'Sheet Name',
      message: 'Custom fields can only be created for Leads, Followups or Visits.',
    };

    const fieldType = String(field['Field Type'] || 'Text').trim();
    if (!this.ALLOWED_FIELD_TYPES.includes(fieldType)) return {
      ok: false, field: 'Field Type',
      message: 'Unsupported field type: ' + fieldType,
    };

    if (fieldType === 'Formula' && !String(field['Formula Logic'] || '').trim()) return {
      ok: false, field: 'Formula Logic',
      message: 'Formula Logic is required for formula fields.',
    };

    if (fieldType === 'File' && field['Max File MB'] !== '' && field['Max File MB'] !== undefined) {
      const maxMb = Number(field['Max File MB']);
      if (!Number.isFinite(maxMb) || maxMb <= 0) return {
        ok: false, field: 'Max File MB',
        message: 'Max File MB must be a positive number.',
      };
    }

    const regexStr = field['Validation Regex'];
    if (regexStr) {
      try { new RegExp(regexStr); } catch (_) {
        return { ok: false, field: 'Validation Regex', message: 'Validation Regex is invalid.' };
      }
    }

    const fieldId = field['Field ID'];
    const dup = (existingFields || []).find(f =>
      (f['Sheet Name'] || 'Leads') === sheetName &&
      f['Column Key'] === rawKey &&
      f['Field ID']   !== fieldId
    );
    if (dup) return {
      ok: false, field: 'Column Key', derivedKey: rawKey,
      message: `Column Key "${rawKey}" already exists for ${sheetName}. Choose a different key.`,
    };

    return { ok: true, derivedKey: rawKey };
  },
};
