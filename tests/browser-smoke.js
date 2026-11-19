'use strict';
// Optional integration test: Chromium and the locally available ws test utility.
// No browser library is used by the application.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawn, spawnSync} = require('node:child_process');
const {once} = require('node:events');
const WebSocket = require('ws');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'billbook-browser-'));
const profile = path.join(temp, 'browser');
let server, browser, socket, nextID = 0, confirmMigration = false;
const pending = new Map(), dialogs = [], errors = [];
let checks = 0;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label) {
  for (let i = 0; i < 120; i++) {if (await check()) return; await sleep(50);}
  throw new Error('Timed out: ' + label + '; dialogs=' + JSON.stringify(dialogs));
}
function send(method, params={}) {
  const id = ++nextID;
  return new Promise((resolve, reject) => {
    pending.set(id, {resolve, reject}); socket.send(JSON.stringify({id, method, params}));
  });
}
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true});
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
async function startBrowser(url) {
  browser = spawn(process.env.CHROMIUM || 'chromium', ['--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', '--user-data-dir=' + profile, 'about:blank'], {stdio: ['ignore', 'ignore', 'pipe']});
  let debugPort;
  await until(async () => {
    try { debugPort = Number(fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]); return !!debugPort; } catch {return false;}
  }, 'Chromium debug port');
  const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
  socket = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
  await once(socket, 'open');
  socket.on('message', data => {
    const message = JSON.parse(data);
    if (message.id) {
      const callback = pending.get(message.id); pending.delete(message.id);
      if (message.error) callback.reject(new Error(JSON.stringify(message.error))); else callback.resolve(message.result);
    } else if (message.method === 'Page.javascriptDialogOpening') {
      dialogs.push(message.params.message);
      const accept = message.params.type !== 'confirm' || (message.params.message.startsWith('Existing browser data') ? confirmMigration : true);
      send('Page.handleJavaScriptDialog', {accept}).catch(() => {});
    } else if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails);
  });
  await send('Page.enable'); await send('Runtime.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', {source: 'window.print = () => {};'});
  await send('Page.navigate', {url});
  await ready();
}
async function ready() {await until(() => evaluate("!!document.querySelector('main') && !document.querySelector('main').inert && !!window.db?.token"), 'application initialization');}
async function stopBrowser() {
  if (!browser || browser.exitCode !== null) return;
  await send('Browser.close').catch(() => {});
  if (browser.exitCode === null) await once(browser, 'exit');
}
async function issue(payee) {
  await evaluate(`document.getElementById('btn-issue').click();
    document.getElementById('f-payee').value=${JSON.stringify(payee)};
    document.getElementById('f-base-amount').value='500';
    document.getElementById('f-gst-rate').value='18';
    document.getElementById('f-gst-type').value='cgst_sgst';
    document.getElementById('form-issue').dispatchEvent(new Event('submit', {bubbles:true,cancelable:true}));`);
}
(async () => {
  server = spawn('python3', ['-u', 'server.py', '0'], {env: {...process.env, XDG_DATA_HOME: temp, PYTHONDONTWRITEBYTECODE:'1'}, stdio:['ignore','pipe','pipe']});
  let output = ''; server.stdout.on('data', data => {output += data;});
  await until(() => output.includes('Bill Book:'), 'server startup');
  const url = output.match(/http:\/\/127\.0\.0\.1:\d+/)[0];
  await startBrowser(url);
  assert.equal(await evaluate('db.getBills().length'), 0); checks++;

  const legacyRaw = JSON.stringify({bills:[{number:1,date:'2026-11-19',payee:'Migrated customer',base_amount:100,amount:100,issued_at:'original',status:'paid',paid_at:'original-paid'}]});
  await evaluate(`localStorage.setItem('billbook.sqlite.memory',${JSON.stringify(legacyRaw)})`);
  await evaluate("document.querySelector('main').inert=true"); await send('Page.reload'); await ready();
  assert.equal(await evaluate('db.getBills().length'), 0);
  assert.equal(await evaluate("localStorage.getItem('billbook.sqlite.memory')"), legacyRaw); checks++;
  confirmMigration = true;
  await evaluate("document.querySelector('main').inert=true"); await send('Page.reload'); await ready();
  assert.equal(await evaluate('db.getBills().length'), 1);
  assert.equal(await evaluate("localStorage.getItem('billbook.sqlite.memory')"), legacyRaw); checks++;
  confirmMigration = false;

  await issue('Browser customer');
  await until(() => evaluate('db.getBills().length === 2'), 'invoice commit');
  assert.equal(await evaluate('db.getBill(2).amount'), 590);
  assert.equal(await evaluate("document.getElementById('print-area').textContent.includes('Browser customer')"), true); checks++;

  // Exercise the existing register control through its actual event handler.
  await evaluate(`document.querySelector('[data-view="register"]').click(); document.querySelector('button[data-act="paid"][data-n="2"]').click()`);
  await until(() => evaluate("db.getBill(2).status === 'paid'"), 'paid commit'); checks++;

  const dump = await evaluate('db.exportSQL()');
  const parsed = spawnSync('python3', ['-c', 'import sys,json; from storage import parse_sql_dump,normalize_import; s,b=normalize_import(parse_sql_dump(sys.stdin.read())); print(json.dumps({"settings":s,"bills":b}))'], {input:dump, encoding:'utf8', env:{...process.env, PYTHONDONTWRITEBYTECODE:'1'}});
  assert.equal(parsed.status, 0, parsed.stderr);
  assert.deepEqual(JSON.parse(parsed.stdout).bills, await evaluate('db.getBills()')); checks++;

  await stopBrowser();
  // DevToolsActivePort belongs to the stopped browser; remove only this test-owned marker.
  fs.rmSync(path.join(profile,'DevToolsActivePort'), {force:true});
  await startBrowser(url);
  assert.equal(await evaluate('db.getBill(2).status'), 'paid');
  assert.equal(await evaluate("localStorage.getItem('billbook.sqlite.memory')"), legacyRaw); checks++;

  await evaluate(`document.querySelector('[data-view="register"]').click(); document.querySelector('button[data-act="void"][data-n="2"]').click()`);
  await until(() => evaluate("db.getBill(2).status === 'void'"), 'void commit');
  await evaluate(`document.querySelector('[data-view="book"]').click()`);
  await issue('Next invoice');
  await until(() => evaluate('!!db.getBill(3)'), 'next invoice'); checks++;

  const state = await (await fetch(url + '/api/state')).json();
  assert.equal(state.bills.length, 3);
  assert.equal(state.bills[1].status, 'void'); checks++;
  assert.deepEqual(errors, []); checks++;
  console.log(`Browser integration: ${checks} checks passed (migration, actual UI issue/paid/void, SQL export roundtrip, browser restart, numbering, committed disk state, no JS exceptions).`);
})().catch(error => {console.error(error); process.exitCode=1;}).finally(async () => {
  await stopBrowser().catch(() => {});
  if (socket) socket.close();
  if (server && server.exitCode === null) {server.kill(); await once(server, 'exit');}
  fs.rmSync(temp, {recursive:true,force:true});
});
