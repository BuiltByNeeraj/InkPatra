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
const crypto = require('node:crypto');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'billbook-browser-'));
const profile = path.join(temp, 'browser');
let server, browser, socket, nextID = 0, confirmMigration = false;
const pending = new Map(), dialogs = [], errors = [];
let checks = 0;
const requests=[];
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
    } else if (message.method === 'Network.requestWillBeSent') {
      requests.push(message.params.request);
    } else if (message.method === 'Page.javascriptDialogOpening') {
      dialogs.push(message.params.message);
      const accept = message.params.type !== 'confirm' || (message.params.message.startsWith('Existing browser data') ? confirmMigration : true);
      send('Page.handleJavaScriptDialog', {accept}).catch(() => {});
    } else if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails);
  });
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
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
async function issue(payee, gstType='cgst_sgst') {
  await evaluate(String.raw`document.getElementById('btn-issue').click();
    document.getElementById('f-payee').value=${JSON.stringify(payee)};
    document.getElementById('f-base-amount').value='500';
    document.getElementById('f-gst-rate').value='18';
    document.getElementById('f-gst-type').value=${JSON.stringify(gstType)};
    document.getElementById('form-issue').dispatchEvent(new Event('submit', {bubbles:true,cancelable:true}));`);
}
(async () => {
  server = spawn('python3', ['-u', 'server.py', '0'], {env: {...process.env, XDG_DATA_HOME: temp, PYTHONDONTWRITEBYTECODE:'1'}, stdio:['ignore','pipe','pipe']});
  let output = ''; server.stdout.on('data', data => {output += data;});
  await until(() => output.includes('Bill Book:'), 'server startup');
  const url = output.match(/http:\/\/127\.0\.0\.1:\d+/)[0];
  await startBrowser(url);

  await issue('Asha & Ravi');
  await until(() => evaluate('!!db.getBill(1)'), 'initial invoice');
  const state = await (await fetch(url+'/api/state')).json();
  const financial = state.bills[0];
  const dbPath=path.join(temp,'cheque-style-bill-book','billbook.sqlite3');
  const hash=()=>crypto.createHash('sha256').update(fs.readFileSync(dbPath)).digest('hex');
  const beforeHash=hash(), beforePosts=requests.filter(r=>r.method==='POST').length;
  await evaluate(String.raw`document.getElementById('btn-preview-current').click()`);
  assert.equal(await evaluate("document.getElementById('invoice-template').value"),'cheque');
  assert.equal(await evaluate("!!document.querySelector('#invoice-preview-content .cheque-container')"),true); checks++;
  await evaluate(String.raw`document.getElementById('invoice-template').value='wedding'; document.getElementById('invoice-template').dispatchEvent(new Event('change'))`);
  assert.equal(await evaluate("!!document.querySelector('.wedding-elegant')"),true); checks++;
  await evaluate(String.raw`document.getElementById('wedding-mode').value='playful'; document.getElementById('wedding-mode').dispatchEvent(new Event('change'))`);
  assert.equal(await evaluate("document.getElementById('invoice-preview-content').textContent.includes('Creativity')"),true);
  assert.equal(hash(),beforeHash);
  assert.equal(requests.filter(r=>r.method==='POST').length,beforePosts); checks++;

  // Save new optional fields through the actual editor; it cannot change financial totals.
  await evaluate(String.raw`document.getElementById('invoice-details-editor').open=true;
    document.getElementById('invoice-recipient_address').value='Pune, Maharashtra\nIndia';
    document.getElementById('invoice-seller_mobile').value='9876543210';
    document.getElementById('invoice-seller_email').value='hello@example.test';
    document.getElementById('invoice-seller_website').value='celebrations.example.test';
    document.querySelector('.invoice-item-description').value='Photography';
    document.querySelector('.invoice-item-value').value='300';
    document.getElementById('btn-add-invoice-item').click();
    document.querySelectorAll('.invoice-item-description')[1].value='Album';
    document.querySelectorAll('.invoice-item-value')[1].value='200';
    document.getElementById('form-invoice-details').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));`);
  await until(()=>evaluate("document.getElementById('invoice-details-feedback').textContent.includes('saved')"),'details committed');
  assert.deepEqual(await evaluate('(()=>{const {details,...financial}=db.getBill(1);return financial;})()'),financial);
  assert.equal(await evaluate("document.querySelectorAll('.wedding-items tbody tr').length"),2); checks++;

  // Set a real-looking test profile and remove the default jurisdiction through saved settings.
  await evaluate(String.raw`db.saveSettings({...db.getSettings(),book_name:'Saffron Celebrations',address:'Pune, Maharashtra',gstin:'27SELLERGST1Z5',legal_line:''})`);
  await evaluate('InvoicePreview.open(1)');
  assert.equal(await evaluate("document.querySelector('.wedding-jurisdiction')===null"),true); checks++;

  async function pdfCheck(name, expectedPortrait, minimumPages=1, invoiceNumber=1) {
    await evaluate(`InvoicePreview.print(${invoiceNumber})`);
    const result=await send('Page.printToPDF',{printBackground:true,preferCSSPageSize:true,displayHeaderFooter:false});
    const filename=path.join(temp,name+'.pdf');fs.writeFileSync(filename,Buffer.from(result.data,'base64'));
    const info=spawnSync('pdfinfo',[filename],{encoding:'utf8'});
    assert.equal(info.status,0,info.stderr);
    const size=info.stdout.match(/Page size:\s+([\d.]+) x ([\d.]+)/);
    assert.ok(size,info.stdout);
    assert.equal(Number(size[1])<Number(size[2]),expectedPortrait,info.stdout);
    if(expectedPortrait) {assert.ok(Math.abs(Number(size[1])-595.28)<2);assert.ok(Math.abs(Number(size[2])-841.89)<2);}
    const pages=Number(info.stdout.match(/Pages:\s+(\d+)/)[1]);
    assert.ok(pages>=minimumPages,info.stdout);
    const text=spawnSync('pdftotext',['-layout',filename,'-'],{encoding:'utf8',maxBuffer:8*1024*1024});
    assert.equal(text.status,0,text.stderr);
    if(process.env.BILLBOOK_TEST_ARTIFACTS) {
      const output=path.resolve(process.env.BILLBOOK_TEST_ARTIFACTS);
      assert.ok(output !== process.cwd() && !output.startsWith(process.cwd()+path.sep),'Test artifacts must be outside the repository');
      fs.mkdirSync(output,{recursive:true});fs.copyFileSync(filename,path.join(output,name+'.pdf'));
    }
    return {text:text.stdout,pages};
  }
  async function screenshot(name) {
    if(!process.env.BILLBOOK_TEST_ARTIFACTS) return;
    await send('Emulation.setEmulatedMedia',{media:'print'});
    await send('Emulation.setDeviceMetricsOverride',{width:794,height:1123,deviceScaleFactor:1,mobile:false});
    await evaluate("document.getElementById('print-area').style.width='186mm';document.getElementById('print-area').style.margin='0 auto';document.fonts.ready");
    const clip=await evaluate("(()=>{const r=document.querySelector('#print-area .wedding-invoice').getBoundingClientRect();return {x:r.x+scrollX,y:r.y+scrollY,width:r.width,height:r.height,scale:1};})()");
    const result=await send('Page.captureScreenshot',{format:'png',clip,captureBeyondViewport:true});
    fs.writeFileSync(path.join(path.resolve(process.env.BILLBOOK_TEST_ARTIFACTS),name+'.png'),Buffer.from(result.data,'base64'));
    await evaluate("document.getElementById('print-area').style.width='';document.getElementById('print-area').style.margin=''");
    await send('Emulation.setEmulatedMedia',{media:''});
    await send('Emulation.clearDeviceMetricsOverride');
  }
  await evaluate(String.raw`document.getElementById('invoice-details-editor').open=false; document.getElementById('wedding-mode').value='elegant';document.getElementById('wedding-mode').dispatchEvent(new Event('change'))`);
  const elegant=await pdfCheck('royal-celebration',true);
  await screenshot('royal-celebration');
  assert.equal(elegant.pages,1,'A normal wedding invoice should fit one A4 page');
  for(const word of ['Photography','Album','590.00','9876543210','hello@example.test']) assert.ok(elegant.text.includes(word),word); checks++;
  await evaluate(String.raw`document.getElementById('wedding-mode').value='playful';document.getElementById('wedding-mode').dispatchEvent(new Event('change'))`);
  const playful=await pdfCheck('creativity-weds-happiness',true);
  await screenshot('creativity-weds-happiness');
  assert.equal(playful.pages,1); assert.ok(playful.text.includes('Creativity'));assert.ok(playful.text.includes('The Wedding Gift'));checks++;

  // Save 80 items and long party details; extract every item from a multi-page A4 PDF.
  await evaluate(String.raw`db.saveSettings({...db.getSettings(),book_name:'LongSellerName'.repeat(30),address:'Seller address line\n'.repeat(20)})`);
  await evaluate(String.raw`document.getElementById('invoice-details-editor').open=true;
    document.getElementById('invoice-recipient_address').value='Long recipient address line\n'.repeat(30);
    const editor=document.getElementById('invoice-items-editor');editor.replaceChildren();
    for(let i=0;i<80;i++) {
      document.getElementById('btn-add-invoice-item').click();
      const row=editor.lastElementChild;
      row.querySelector('textarea').value='LINE-'+String(i).padStart(3,'0')+' '+(i===40?'UnbrokenDescription'.repeat(160):'Wedding services and arrangements');
      row.querySelector('input').value='6.25';
    }
    document.getElementById('form-invoice-details').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));`);
  await until(()=>evaluate('db.getBill(1).details.items.length===80'),'80 item details');
  const longPages={};
  for(const mode of ['elegant','playful']) {
    await evaluate(`document.getElementById('wedding-mode').value='${mode}';document.getElementById('wedding-mode').dispatchEvent(new Event('change'))`);
    const many=await pdfCheck('many-items-'+mode,true,2);longPages[mode]=many.pages;
    for(let i=0;i<80;i++) assert.ok(many.text.includes('LINE-'+String(i).padStart(3,'0')),'missing line '+i+' in '+mode);
    assert.ok(many.text.includes('590.00'));assert.ok(many.text.includes('9876543210'));
    assert.ok(many.text.replace(/#\s+DESCRIPTION\s+TAXABLE VALUE/g,'').replace(/\s+/g,'').includes('UnbrokenDescription'.repeat(160)),'long item clipped in '+mode); checks++;
    await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
    assert.equal(await evaluate(String.raw`(()=>{const el=document.querySelector('#invoice-preview-content .wedding-invoice');return el.scrollWidth<=el.clientWidth+1;})()`),true,'mobile invoice overflows in '+mode); checks++;
    await send('Emulation.clearDeviceMetricsOverride');
  }

  // Hostile text is represented as text in the actual DOM, not executable markup.
  await evaluate(String.raw`db.saveInvoiceDetails(1,{...db.getBill(1).details,recipient_address:'<img src=x onerror="alert(1)"><script>window.injected=true</script>'})`);
  await evaluate('InvoicePreview.open(1)');
  assert.equal(await evaluate("document.querySelectorAll('#invoice-preview-content script, #invoice-preview-content img').length"),0);
  assert.equal(await evaluate('window.injected===undefined'),true);checks++;
  const sql=await evaluate('db.exportSQL()');
  const imported=spawnSync('python3',['-c','import json,sys;from storage import parse_sql_dump,normalize_import;s,b=normalize_import(parse_sql_dump(sys.stdin.read()));print(json.dumps(b))'],{input:sql,encoding:'utf8',env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});
  assert.equal(imported.status,0,imported.stderr);assert.deepEqual(JSON.parse(imported.stdout),await evaluate('db.getBills()'));checks++;

  await evaluate(String.raw`document.getElementById('invoice-template').value='cheque';document.getElementById('invoice-template').dispatchEvent(new Event('change'))`);
  const cheque=await pdfCheck('cheque-regression',false);
  assert.ok(cheque.text.includes('Asha & Ravi'));checks++;
  // A second invoice is explicitly issued for IGST coverage; template switching never creates it.
  await evaluate("document.getElementById('btn-close-invoice-preview').click()");
  await evaluate("db.saveSettings({...db.getSettings(),book_name:'Saffron Celebrations',address:'Pune, Maharashtra'})");
  await issue('Interstate Celebration Studio','igst');
  await until(()=>evaluate('!!db.getBill(2)'),'IGST issue');
  await evaluate("db.saveInvoiceDetails(2,{seller_mobile:'9876543210',seller_email:'hello@example.test',seller_website:'celebrations.example.test',recipient_address:'Bengaluru, Karnataka',items:[{description:'Creative direction',taxable_value:300},{description:'Celebration styling',taxable_value:200}]})");
  await evaluate('InvoicePreview.open(2)');
  await evaluate("document.getElementById('invoice-template').value='wedding';document.getElementById('invoice-template').dispatchEvent(new Event('change'))");
  for(const mode of ['elegant','playful']) {
    await evaluate(`document.getElementById('wedding-mode').value='${mode}';document.getElementById('wedding-mode').dispatchEvent(new Event('change'))`);
    const interstate=await pdfCheck('igst-'+mode,true,1,2);
    assert.match(interstate.text,/IGST/);assert.doesNotMatch(interstate.text,/CGST|SGST/);
    assert.ok(interstate.text.includes('90.00'));assert.ok(interstate.text.includes('590.00'));checks++;
  }
  const final=await (await fetch(url+'/api/state')).json();
  const {details,...unchanged}=final.bills[0];assert.deepEqual(unchanged,financial);assert.equal(final.bills.length,2);checks++;
  assert.equal(requests.some(request=>!request.url.startsWith(url)&&!request.url.startsWith('data:')),false,'External network dependency');checks++;
  assert.deepEqual(errors,[]);checks++;
  console.log(`Wedding browser integration: ${checks} checks passed; 80-item A4 PDFs: Elegant ${longPages.elegant} pages, Playful ${longPages.playful} pages. All items and long text retained; CGST/SGST and IGST checked in both modes.`);

})().catch(error => {console.error(error); process.exitCode=1;}).finally(async () => {
  await stopBrowser().catch(() => {});
  if (socket) socket.close();
  if (server && server.exitCode === null) {server.kill(); await once(server, 'exit');}
  fs.rmSync(temp, {recursive:true,force:true});
});
