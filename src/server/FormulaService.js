// ─── FormulaService.gs ───────────────────────────────────────────────────────
// Safe formula engine — no eval(). Supports: DATEDIFF, TODAY, IF, SUM, CONCAT

function evaluateFormula(formulaStr, rowData) {
  try {
    let expr = formulaStr;
    // Replace {{Field Name}} placeholders with values
    // Fix #2: escape double-quotes inside string values before injecting
    expr = expr.replace(/\{\{([^}]+)\}\}/g, (_, field) => {
      const val = rowData[field.trim()];
      return typeof val === 'string' ? `"${String(val).replace(/"/g, '\\"')}"` : (val || 0);
    });
    return _safeEval(expr);
  } catch (e) {
    return '#ERR';
  }
}

function _safeEval(expr) {
  // DATEDIFF(date1, date2)
  expr = expr.replace(/DATEDIFF\(([^,]+),([^)]+)\)/g, (_, d1, d2) => {
    const diff = new Date(d2.trim().replace(/"/g,'')) - new Date(d1.trim().replace(/"/g,''));
    return Math.floor(diff / 86400000);
  });
  // TODAY()
  expr = expr.replace(/TODAY\(\)/g, `"${today()}"`);
  // IF(cond, trueVal, falseVal) — Fix #3: use a proper arg splitter to handle commas inside strings
  expr = expr.replace(/IF\((.+)\)/g, (_, inner) => {
    const args = _splitArgs(inner);
    if (args.length < 3) return '#ERR';
    return _evalCondition(args[0].trim()) ? args[1].trim() : args[2].trim();
  });
  // SUM(a, b, ...)
  expr = expr.replace(/SUM\(([^)]+)\)/g, (_, args) =>
    args.split(',').reduce((s, v) => s + (parseFloat(v.trim()) || 0), 0)
  );
  // CONCAT(a, b, ...) — Fix #4: support any number of arguments
  expr = expr.replace(/CONCAT\((.+?)\)/g, (_, inner) =>
    `"${_splitArgs(inner).map(a => a.trim().replace(/^"|"$/g, '')).join('').replace(/"/g, '\\"')}"`
  );
  // Basic arithmetic only
  if (/^[\d\s\+\-\*\/\.\(\)]+$/.test(expr)) return _evalArithmetic(expr);
  const trimmed = expr.trim();
  if (/^"([^"\\]|\\.)*"$/.test(trimmed)) return trimmed.slice(1, -1).replace(/\\"/g, '"');
  return '#ERR';
}

function _evalCondition(cond) {
  const ops = [['===','==='],['==','==='],['!==','!=='],['!=','!=='],['>=','>='],['<=','<='],['>', '>'],['<','<']];
  for (const [op, jsOp] of ops) {
    if (cond.includes(op)) {
      const [l, r] = cond.split(op).map(s => _parseComparable(s.trim()));
      if (jsOp === '===') return l === r;
      if (jsOp === '!==') return l !== r;
      if (jsOp === '>=')  return l >= r;
      if (jsOp === '<=')  return l <= r;
      if (jsOp === '>')   return l > r;
      if (jsOp === '<')   return l < r;
    }
  }
  return false;
}

function _parseComparable(value) {
  if (/^".*"$/.test(value)) return value.slice(1, -1);
  if (/^[\d\s\+\-\*\/\.\(\)]+$/.test(value)) return _evalArithmetic(value);
  return value;
}

function _evalArithmetic(expr) {
  const tokens = expr.match(/\d+(?:\.\d+)?|[()+\-*/]/g) || [];
  let pos = 0;

  function peek() { return tokens[pos]; }
  function take() { return tokens[pos++]; }

  function factor() {
    const token = take();
    if (token === '+') return +factor();
    if (token === '-') return -factor();
    if (token === '(') {
      const value = expression();
      if (take() !== ')') throw new Error('Invalid formula.');
      return value;
    }
    if (!/^\d+(?:\.\d+)?$/.test(token || '')) throw new Error('Invalid formula.');
    return Number(token);
  }

  function term() {
    let value = factor();
    while (peek() === '*' || peek() === '/') {
      const op = take();
      const next = factor();
      value = op === '*' ? value * next : value / next;
    }
    return value;
  }

  function expression() {
    let value = term();
    while (peek() === '+' || peek() === '-') {
      const op = take();
      const next = term();
      value = op === '+' ? value + next : value - next;
    }
    return value;
  }

  const result = expression();
  if (pos !== tokens.length) throw new Error('Invalid formula.');
  return result;
}

// Fix #6: removed Is Visible filter — formula fields computed regardless of visibility
// Fix #1: store result under Column Key, not Field Name
function applyCalculatedFields(sheetName, rows) {
  const fields = queryRows(SHEET_NAMES.FIELD_CONFIG,
    f => (f['Sheet Name'] || 'Leads') === sheetName && f['Field Type'] === 'Formula'
  );
  if (!fields.length) return rows;
  return rows.map(row => {
    fields.forEach(f => { row[f['Column Key']] = evaluateFormula(f['Formula Logic'], row); });
    return row;
  });
}

// Splits a comma-separated argument string while respecting quoted strings
function _splitArgs(str) {
  const args = [];
  let current = '';
  let inQuote = false;
  let quoteChar = '';
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (inQuote) {
      if (ch === '\\' && i + 1 < str.length) { current += ch + str[++i]; continue; }
      if (ch === quoteChar) inQuote = false;
      current += ch;
    } else if (ch === '"' || ch === "'") {
      inQuote = true; quoteChar = ch; current += ch;
    } else if (ch === ',') {
      args.push(current); current = '';
    } else {
      current += ch;
    }
  }
  if (current.length) args.push(current);
  return args;
}
