'use strict';
// Runs the real Today markup in an isolated headless browser against synthetic
// data. No dependencies, deployed portal, credentials or Sheets writes.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const http = require('node:http'), { spawn } = require('node:child_process'), assert = require('node:assert/strict');
const { todayData, todayConfig, escapeHtml } = require('../tests/helpers/today-fixture');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, 'src', file), 'utf8');
const shell = () => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic Today Activity</title>${read('CSS.html')}</head><body><div id="content"><div id="today-wrap"></div></div><script>
const initial = ${JSON.stringify(todayData())};
let data = structuredClone(initial), fetchCount = 0, nextSnapshot = null, pendingRead = null, holdRead = false;
const App = {currentPage:'today',user:{id:'u1',role:'ADMIN'},config:${JSON.stringify(todayConfig())}};
const AppCache = {getRows:key=>data[key]||[],setRows:(key,rows)=>{data[key]=rows;},clear:()=>{data={};}};
const AppLookup = {stageName:value=>value}, AuthToken={get:()=> 'synthetic'};
const el=id=>document.getElementById(id), icon=()=>'', renderIcons=()=>{};
const escapeHtml=${escapeHtml.toString()}, remarkHtml=escapeHtml, formatDate=escapeHtml, formatDateTime=escapeHtml;
const _fmtDate=value=>String(value||'').slice(0,10), localDateInputValue=date=>date?new Date(date).toISOString().slice(0,10):'2026-11-20';
const brandPrimary=()=> '#4338ca',brandPrimaryLight=()=> '#818cf8';
const pagePreviewRead=async()=>{fetchCount++;if(holdRead)return await new Promise(resolve=>pendingRead=resolve);return structuredClone(nextSnapshot||initial);};
const fixtureState=()=>({range:window._todayRange||'today',card:_todayCardFilter,from:el('td-from')?.value,to:el('td-to')?.value,user:el('td-user')?.value,type:el('td-type')?.value,group:el('td-group')?.value});
const setFilter=(id,value)=>{el(id).value=value;el(id).dispatchEvent(new Event('change',{bubbles:true}));};
const clickCard=key=>[...document.querySelectorAll('#td-cards button')].find(node=>node.getAttribute('onclick').includes("('"+key+"')")).click();
</script>${read('Today.html')}<script>_renderToday();</script></body></html>`;

async function main() {
  const browser = process.argv[2] || ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(fs.existsSync);
  if (!browser) throw Error('Pass a Chromium executable as the first argument.');
  const tempRoot = fs.realpathSync(os.tmpdir()), profile = fs.mkdtempSync(path.join(tempRoot, 'nbd-today-browser-'));
  const server = http.createServer((req,res) => { res.setHeader('Content-Type','text/html;charset=utf-8'); res.end(shell()); });
  let child, ws;
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    child = spawn(browser, ['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--disable-background-networking','--remote-debugging-port=0','--user-data-dir=' + profile,'about:blank'], {windowsHide:true,stdio:['ignore','ignore','pipe']});
    let launchError, launchLog=''; child.on('error', error => { launchError=error; });
    child.stderr.on('data', chunk => { launchLog=(launchLog+chunk).slice(-4000); });
    const portFile = path.join(profile,'DevToolsActivePort');
    for (let i=0; !fs.existsSync(portFile) && i<100; i++) { if(launchError) throw launchError; if(child.exitCode!==null) break; await pause(100); }
    if (!fs.existsSync(portFile)) throw Error('Browser did not start. Exit: '+child.exitCode+'; '+launchLog);
    const port=fs.readFileSync(portFile,'utf8').split('\n')[0];
    const target=await fetch('http://127.0.0.1:'+port+'/json/new?about:blank',{method:'PUT'}).then(r=>r.json());
    ws=new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject;});
    let id=0; const pending=new Map(), exceptions=[];
    ws.onmessage=event=>{const message=JSON.parse(event.data);if(message.id){const item=pending.get(message.id);if(item){pending.delete(message.id);clearTimeout(item.timer);message.error?item.reject(Error(message.error.message)):item.resolve(message.result);}}else if(message.method==='Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails);};
    const send=(method,params={})=>new Promise((resolve,reject)=>{const key=++id;const timer=setTimeout(()=>{pending.delete(key);reject(Error('Timed out: '+method));},10000);pending.set(key,{resolve,reject,timer});ws.send(JSON.stringify({id:key,method,params}));});
    const evaluate=async expression=>{const result=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails));return result.result.value;};
    await send('Runtime.enable');await send('Network.enable');await send('Network.setBlockedURLs',{urls:['https://*']});await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
    await send('Page.navigate',{url:'http://127.0.0.1:'+server.address().port});
    for(let i=0;i<100;i++){if(await evaluate('!!document.getElementById("td-cards")?.children.length'))break;await pause(50);}
    assert.equal(await evaluate('document.querySelectorAll("#td-cards button").length'),9);
    assert.equal(await evaluate('document.querySelectorAll(".fu-table thead th")[3].textContent'),'Lead Source');
    assert.deepEqual(await evaluate("[...new Set([...document.querySelectorAll('#td-tbody .fu-row')].map(row=>row.cells[3].textContent))].sort()"),['Referral','Website','—']);
    console.log('PASS: real Today markup renders nine main cards and all charts.');
    await evaluate("setFilter('td-from','2026-11-20');setFilter('td-to','2026-11-20');setFilter('td-user','u1');setFilter('td-type','Call');setFilter('td-group','lead:City');clickCard('calls');");
    const selected=await evaluate('fixtureState()');
    assert.equal(await evaluate("el('td-group-summary').textContent"),'1 groups · 2 records · 1 unique leads');
    assert.equal(await evaluate("document.querySelector('#td-tbody .td-group-row th').colSpan"),8);
    assert.equal(await evaluate("document.querySelector('#td-tbody .fu-row').cells[3].textContent"),'Referral');
    await evaluate('loadToday()');assert.deepEqual(await evaluate('fixtureState()'),selected);
    await evaluate('loadToday(structuredClone(initial))');assert.deepEqual(await evaluate('fixtureState()'),selected);
    assert.equal(await evaluate('fetchCount'),1);
    await evaluate("clickCard('productive');clickCard('productive');clickCard('calls')");assert.deepEqual(await evaluate('fixtureState()'),selected);
    console.log('PASS: card clicks, manual refresh and background refresh retain every selected filter.');
    await evaluate("holdRead=true;window.refreshPromise=loadToday();setFilter('td-type','Visit');setFilter('td-group','agent');");
    const changed=await evaluate('fixtureState()');
    await evaluate('pendingRead(structuredClone(initial));window.refreshPromise');
    assert.deepEqual(await evaluate('fixtureState()'),changed);await evaluate('holdRead=false');
    await evaluate('nextSnapshot={leads:[],followups:[],followupHistory:[],activityLogs:[]};loadToday()');
    assert.deepEqual(await evaluate('fixtureState()'),changed);assert.match(await evaluate("el('td-tbody').textContent"),/No activity/);
    await evaluate("nextSnapshot=null;loadToday()");
    await evaluate("setFilter('td-group','lead:City');nextSnapshot={leads:[],followups:[],followupHistory:[],activityLogs:[]};loadToday()");
    assert.equal(await evaluate("el('td-group').value"),'lead:City');
    await evaluate('nextSnapshot=null;loadToday()');assert.equal(await evaluate("el('td-group').value"),'lead:City');
    console.log('PASS: filter edits during a pending refresh and empty snapshots preserve selection.');
    await evaluate("_todayClearFilters();clickCard('won');setFilter('td-group','lead:City');");
    assert.equal(await evaluate("Number(el('td-row-count').textContent)"),3);
    await evaluate("setFilter('td-from','2026-11-18');setFilter('td-to','2026-11-18')");
    assert.equal(await evaluate("Number(el('td-row-count').textContent)"),1);assert.equal((await evaluate('fixtureState()')).card,'won');
    await evaluate("setFilter('td-from','2025-01-01');setFilter('td-to','2025-01-01')");assert.match(await evaluate("el('td-group-summary').textContent"),/^0 groups/);
    console.log('PASS: Won card and grouped drilldown respect date changes, India midnight and zero results.');
    await evaluate("_todayClearFilters();App.user.role='SALES';_renderToday()");
    assert.equal(await evaluate("!!el('td-user')"),false);
    await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
    await evaluate("setFilter('td-group','lead:City');clickCard('connected')");
    const layout=await evaluate("({width:innerWidth,body:document.documentElement.scrollWidth,group:el('td-group').getBoundingClientRect().toJSON(),summary:el('td-group-summary').textContent})");
    assert.ok(layout.group.x>=0 && layout.group.right<=layout.width,JSON.stringify(layout));
    assert.ok(layout.body<=layout.width+1,'Mobile page must not overflow the viewport: '+JSON.stringify(layout));
    assert.match(layout.summary,/3 groups/);
    console.log('PASS: non-admin view hides the user selector; 390px mobile grouping controls fit.');
    assert.deepEqual(exceptions,[]);console.log('PASS: no uncaught browser errors.');
  } finally {
    if(ws) ws.close();
    if(child && child.exitCode===null){child.kill();await Promise.race([new Promise(resolve=>child.once('exit',resolve)),pause(2000)]);}
    await new Promise(resolve=>server.close(resolve));
    const resolved=path.resolve(profile);
    // Remove only the temporary profile this process created, inside os.tmpdir.
    if(path.dirname(resolved)===tempRoot && path.basename(resolved).startsWith('nbd-today-browser-')) {
      try { fs.rmSync(resolved,{recursive:true,force:true,maxRetries:3,retryDelay:200}); } catch { console.warn('Temporary browser profile retained:',resolved); }
    }
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
