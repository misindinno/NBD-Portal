// Verified shared storage for central archive and disqualified workbooks.
function centralRead_(book, name, fresh) {
  let values;
  if(fresh) {
    // SpreadsheetApp can reuse a read made before an Advanced Sheets write.
    // Verification must use a fresh server read from the same API as the write.
    values=(Sheets.Spreadsheets.Values.get(book,_a1Sheet_(name),{valueRenderOption:'UNFORMATTED_VALUE'}).values||[]).map(row=>row.map(dqLiteral_));
  } else {
    const sheet=SpreadsheetApp.openById(book).getSheetByName(name);
    if(!sheet)throw new Error('Central sheet not initialized: '+name);
    values=sheet.getDataRange().getDisplayValues();
  }
  const headers = values[0] || [];
  if (new Set(headers).size !== headers.length || !DQ_META_.every(key => headers.includes(key))) throw new Error('Invalid central sheet headers: ' + name);
  return {name, headers, rows:values.slice(1).map((values,index) => ({row:index+2, value:Object.fromEntries(headers.map((h,i) => [h, values[i] == null ? '' : values[i]]))}))};
}
function centralUpsert_(book, name, records, read) {
  if (!records.length) return;
  if(new Set(records.map(r=>r['Central Key'])).size!==records.length)throw new Error('Duplicate incoming central key. Source retained.');
  const table=read(name,true), index=new Map();
  table.rows.forEach(row => {
    const key=row.value['Central Key']; if (!key) return;
    if (index.has(key)) throw new Error('Duplicate central record key in ' + name);
    index.set(key,row);
  });
  const changes=[], added=[];
  records.forEach(record => {
    if (record['Origin Workbook'] !== SPREADSHEET_ID || !record['Central Key']) throw new Error('Invalid central origin.');
    const unknown=Object.keys(record).filter(key => key && record[key] !== '' && !table.headers.includes(key));
    if (unknown.length) throw new Error('Central schema needs columns: ' + unknown.join(', '));
    const existing=index.get(record['Central Key']);
    const merged={...(existing ? existing.value : {}),...record};
    const values=table.headers.map(h => dqLiteral_(merged[h]));
    if (values.some(v => v.length > 49000)) throw new Error('Central cell exceeds the supported size. Source retained.');
    if (existing) changes.push({range:_a1Sheet_(name)+'!A'+existing.row+':'+_columnLetter_(table.headers.length)+existing.row, values:[values]});
    else added.push(values);
  });
  if (changes.length) Sheets.Spreadsheets.Values.batchUpdate({valueInputOption:'RAW',data:changes},book);
  // Sheets append allocates rows atomically across the six independent scripts.
  if (added.length) Sheets.Spreadsheets.Values.append({values:added},book,_a1Sheet_(name)+'!A:'+_columnLetter_(table.headers.length),{valueInputOption:'RAW',insertDataOption:'INSERT_ROWS'});
  const verified=read(name,true).rows;
  records.forEach(record => {
    const hits=verified.filter(row => row.value['Central Key']===record['Central Key']);
    const mismatch=hits.length===1?Object.keys(record).filter(key=>dqLiteral_(record[key])!==dqLiteral_(hits[0].value[key])):['Central Key'];
    if(mismatch.length)throw new Error('Central verification failed in '+name+' ('+mismatch.join(', ')+'). Source retained.');
  });
}
