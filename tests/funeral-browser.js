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
let darkConsent = false, darkPrompts = 0;
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
      const dark = message.params.message.startsWith('Dark Humor is a novelty template');
      if(dark) darkPrompts++;
      const accept = message.params.type !== 'confirm' || (dark ? darkConsent : message.params.message.startsWith('Existing browser data') ? confirmMigration : true);
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
async function issue(payee, gstType='none') {
  await evaluate(String.raw`document.getElementById('btn-issue').click();
    document.getElementById('f-payee').value=${JSON.stringify(payee)};
    document.getElementById('f-base-amount').value='500';
    document.getElementById('f-gst-rate').value='18';
    document.getElementById('f-apply-gst').checked=${gstType!=='none'};
    document.getElementById('f-gst-type').value=${JSON.stringify(gstType==='none'?'cgst_sgst':gstType)};
    document.getElementById('form-issue').dispatchEvent(new Event('submit', {bubbles:true,cancelable:true}));`);
}
async function selectTemplate(value) {
  await evaluate(`document.getElementById('invoice-template').value='${value}';document.getElementById('invoice-template').dispatchEvent(new Event('change'))`);
}
async function selectMode(value, consent=false) {
  darkConsent=consent;
  await evaluate(`document.getElementById('funeral-mode').value='${value}';document.getElementById('funeral-mode').dispatchEvent(new Event('change'))`);
}
async function currentMode() {return evaluate("document.getElementById('funeral-mode').value");}
async function pdfCheck(name, invoiceNumber=1) {
  await evaluate(`InvoicePreview.print(${invoiceNumber})`);
  const result=await send('Page.printToPDF',{printBackground:true,preferCSSPageSize:true,displayHeaderFooter:false});
  const filename=path.join(temp,name+'.pdf');fs.writeFileSync(filename,Buffer.from(result.data,'base64'));
  const info=spawnSync('pdfinfo',[filename],{encoding:'utf8'});assert.equal(info.status,0,info.stderr);
  const size=info.stdout.match(/Page size:\s+([\d.]+) x ([\d.]+)/);
  assert.ok(size,info.stdout);assert.ok(Math.abs(Number(size[1])-595.28)<2);assert.ok(Math.abs(Number(size[2])-841.89)<2);
  const pages=Number(info.stdout.match(/Pages:\s+(\d+)/)[1]);
  const text=spawnSync('pdftotext',['-layout',filename,'-'],{encoding:'utf8',maxBuffer:8*1024*1024});assert.equal(text.status,0,text.stderr);
  if(process.env.BILLBOOK_TEST_ARTIFACTS) {
    const output=path.resolve(process.env.BILLBOOK_TEST_ARTIFACTS);
    assert.ok(output!==process.cwd()&&!output.startsWith(process.cwd()+path.sep),'Artifacts must be outside repository');
    fs.mkdirSync(output,{recursive:true});fs.copyFileSync(filename,path.join(output,name+'.pdf'));
  }
  return {text:text.stdout,pages};
}
async function screenshot(name) {
  if(!process.env.BILLBOOK_TEST_ARTIFACTS) return;
  await send('Emulation.setEmulatedMedia',{media:'print'});
  await send('Emulation.setDeviceMetricsOverride',{width:794,height:1123,deviceScaleFactor:1,mobile:false});
  await evaluate("document.getElementById('print-area').style.width='186mm';document.getElementById('print-area').style.margin='0 auto';document.fonts.ready");
  const clip=await evaluate("(()=>{const r=document.querySelector('#print-area .funeral-invoice').getBoundingClientRect();return {x:r.x+scrollX,y:r.y+scrollY,width:r.width,height:r.height,scale:1};})()");
  const result=await send('Page.captureScreenshot',{format:'png',clip,captureBeyondViewport:true});
  fs.writeFileSync(path.join(path.resolve(process.env.BILLBOOK_TEST_ARTIFACTS),name+'.png'),Buffer.from(result.data,'base64'));
  await evaluate("document.getElementById('print-area').style.width='';document.getElementById('print-area').style.margin=''");
  await send('Emulation.setEmulatedMedia',{media:''});await send('Emulation.clearDeviceMetricsOverride');
}
(async () => {
  server=spawn('python3',['-u','server.py','0'],{env:{...process.env,XDG_DATA_HOME:temp,PYTHONDONTWRITEBYTECODE:'1'},stdio:['ignore','pipe','pipe']});
  let output='';server.stdout.on('data',data=>{output+=data;});await until(()=>output.includes('Bill Book:'),'server startup');
  const url=output.match(/http:\/\/127\.0\.0\.1:\d+/)[0];
  await startBrowser(url);
  await evaluate("db.saveSettings({...db.getSettings(),book_name:'Willow Care Services',address:'Pune, Maharashtra',gstin:'',legal_line:''})");
  await issue('Account Holder');await until(()=>evaluate('!!db.getBill(1)'),'nil GST invoice issued');
  const originals={1:await evaluate('db.getBill(1)')};
  assert.equal(originals[1].gst_rate,0);assert.equal(originals[1].amount,500);
  const dbPath=path.join(temp,'cheque-style-bill-book','billbook.sqlite3');
  const hash=()=>crypto.createHash('sha256').update(fs.readFileSync(dbPath)).digest('hex');
  const before=hash(),posts=requests.filter(r=>r.method==='POST').length;
  await evaluate("document.getElementById('btn-preview-current').click()");
  assert.equal(await evaluate("document.getElementById('invoice-template').value"),'cheque');checks++;
  await selectTemplate('funeral');assert.equal(await currentMode(),'respectful');
  assert.equal(await evaluate("!!document.querySelector('#invoice-preview-content .funeral-respectful')"),true);checks++;
  assert.equal(await evaluate("!document.getElementById('funeral-tax-review').hidden"),true);
  assert.equal(await evaluate("document.getElementById('funeral-tax-review').textContent.includes('exemption')"),true);checks++;
  assert.equal(darkPrompts,0);
  await selectMode('dark',false);assert.equal(darkPrompts,1);assert.equal(await currentMode(),'respectful');checks++;
  await selectMode('dark',true);assert.equal(darkPrompts,2);assert.equal(await currentMode(),'dark');
  assert.equal(await evaluate("!document.getElementById('funeral-novelty-note').hidden"),true);checks++;
  await evaluate("window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}))");
  assert.equal(await currentMode(),'respectful');checks++;
  await selectTemplate('wedding');await selectTemplate('funeral');assert.equal(await currentMode(),'respectful');checks++;
  await selectMode('dark',true);await evaluate("document.getElementById('btn-close-invoice-preview').click()");
  await evaluate('InvoicePreview.open(1)');assert.equal(await currentMode(),'respectful');checks++;
  assert.equal(hash(),before);assert.equal(requests.filter(r=>r.method==='POST').length,posts);
  assert.deepEqual(await evaluate('db.getBill(1)'),originals[1]);checks++;

  // Reuse the existing explicit metadata editor. No deceased-person fields or photographs.
  await evaluate(String.raw`document.getElementById('invoice-details-editor').open=true;
    document.getElementById('invoice-recipient_address').value='Recipient address\nPune, Maharashtra';
    document.getElementById('invoice-seller_mobile').value='9876543210';
    document.getElementById('invoice-seller_email').value='care@example.test';
    document.getElementById('invoice-seller_website').value='willow.example.test';
    document.querySelector('.invoice-item-description').value='Service coordination';document.querySelector('.invoice-item-value').value='300';
    document.getElementById('btn-add-invoice-item').click();
    document.querySelectorAll('.invoice-item-description')[1].value='Memorial programmes';document.querySelectorAll('.invoice-item-value')[1].value='200';
    document.getElementById('form-invoice-details').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));`);
  await until(()=>evaluate('db.getBill(1).details?.items?.length===2'),'details saved');
  await evaluate("document.getElementById('invoice-details-editor').open=false");
  const respectful=await pdfCheck('respectful-farewell');assert.equal(respectful.pages,1);
  assert.ok(respectful.text.includes('With Heartfelt Condolences'));assert.ok(respectful.text.includes('500.00'));
  assert.doesNotMatch(respectful.text,/CGST|SGST|IGST|Novelty/);await screenshot('respectful-farewell');checks++;
  await selectMode('dark',true);
  const dark=await pdfCheck('dark-humor');assert.equal(dark.pages,1);
  assert.ok(dark.text.includes("It's Still Business"));assert.ok(dark.text.includes('not recommended for grieving customers'));
  assert.ok(dark.text.includes('500.00'));assert.doesNotMatch(dark.text,/CGST|SGST|IGST/);await screenshot('dark-humor');checks++;

  // Rendering and printing work without network access once the local document is loaded.
  await send('Network.emulateNetworkConditions',{offline:true,latency:0,downloadThroughput:0,uploadThroughput:0});
  for(const mode of ['respectful','dark']) {
    await selectMode(mode,mode==='dark');const offline=await pdfCheck('offline-'+mode);
    assert.ok(offline.text.includes('500.00'));assert.equal(offline.pages,1);checks++;
  }
  await send('Network.emulateNetworkConditions',{offline:false,latency:0,downloadThroughput:-1,uploadThroughput:-1});

  // Issue two additional invoices explicitly to cover saved CGST/SGST and IGST selections.
  await evaluate("document.getElementById('btn-close-invoice-preview').click()");
  assert.equal(await evaluate("document.querySelector('#print-area .funeral-dark')===null"),true);checks++;
  for(const [n,gstType] of [[2,'cgst_sgst'],[3,'igst']]) {
    await issue('Account '+n,gstType);await until(()=>evaluate(`!!db.getBill(${n})`),'tax invoice '+n);
    originals[n]=await evaluate(`db.getBill(${n})`);
    await evaluate(`db.saveInvoiceDetails(${n},{...db.getBill(1).details})`);
    await evaluate(`InvoicePreview.open(${n})`);assert.equal(await currentMode(),'respectful');
    for(const mode of ['respectful','dark']) {
      await selectMode(mode,mode==='dark');const pdf=await pdfCheck(gstType+'-'+mode,n);
      assert.ok(pdf.text.includes('590.00'));
      if(gstType==='igst') {assert.match(pdf.text,/IGST/);assert.doesNotMatch(pdf.text,/CGST|SGST/);assert.ok(pdf.text.includes('90.00'));}
      else {assert.match(pdf.text,/CGST/);assert.match(pdf.text,/SGST/);assert.doesNotMatch(pdf.text,/IGST/);assert.ok(pdf.text.includes('45.00'));}
      checks++;
    }
    await evaluate("document.getElementById('btn-close-invoice-preview').click()");
  }
  await evaluate('InvoicePreview.open(1)');await selectMode('dark',true);
  await evaluate('InvoicePreview.print(2)');assert.equal(await currentMode(),'respectful');
  assert.equal(await evaluate("!!document.querySelector('#print-area .funeral-respectful')"),true);
  assert.equal(await evaluate("!!document.querySelector('#invoice-preview-content .funeral-respectful')"),true);checks++;

  // Long address and an oversized item row must break across pages without losing text.
  await evaluate(String.raw`db.saveSettings({...db.getSettings(),address:'Provider address line\n'.repeat(20)})`);
  await evaluate(String.raw`db.saveInvoiceDetails(1,{...db.getBill(1).details,recipient_address:'Long recipient address line\n'.repeat(30),items:Array.from({length:80},(_,i)=>({description:'LINE-'+String(i).padStart(3,'0')+' '+(i===40?'UnbrokenDescription'.repeat(160):'Service particulars'),taxable_value:6.25}))})`);
  await evaluate('InvoicePreview.open(1)');const pages={};
  for(const mode of ['respectful','dark']) {
    await selectMode(mode,mode==='dark');const pdf=await pdfCheck('many-items-'+mode);pages[mode]=pdf.pages;
    assert.ok(pdf.pages>1);
    for(let i=0;i<80;i++) assert.ok(pdf.text.includes('LINE-'+String(i).padStart(3,'0')),'Missing item '+i+' in '+mode);
    assert.ok(pdf.text.replace(/#\s+DESCRIPTION\s+TAXABLE VALUE/g,'').replace(/\s+/g,'').includes('UnbrokenDescription'.repeat(160)),'Long row clipped in '+mode);
    assert.ok(pdf.text.includes('500.00'));assert.ok(pdf.text.includes('care@example.test'));checks++;
    await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
    assert.equal(await evaluate("(()=>{const el=document.querySelector('#invoice-preview-content .funeral-invoice');return el.scrollWidth<=el.clientWidth+1;})()"),true);checks++;
    await send('Emulation.clearDeviceMetricsOverride');
  }
  await evaluate(`db.saveInvoiceDetails(1,{...db.getBill(1).details,recipient_address:'<img src=x onerror="alert(1)"><script>window.injected=true</script>'})`);
  await evaluate('InvoicePreview.open(1)');assert.equal(await currentMode(),'respectful');
  assert.equal(await evaluate("document.querySelectorAll('#invoice-preview-content img,#invoice-preview-content script').length"),0);checks++;
  // No saved financial fields were changed by any template/mode action or metadata edit.
  const final=await (await fetch(url+'/api/state')).json();assert.equal(final.bills.length,3);
  for(const saved of final.bills) {const {details,...financial}=saved;assert.deepEqual(financial,originals[saved.number]);}checks++;
  assert.equal(requests.some(request=>!request.url.startsWith(url)&&!request.url.startsWith('data:')),false);checks++;
  assert.deepEqual(errors,[]);checks++;
  console.log(`Funeral browser integration: ${checks} checks passed. 80-item A4 PDFs: Respectful ${pages.respectful} pages, Dark Humor ${pages.dark} pages. Opt-in/reset, no data writes on selection, offline rendering, nil/CGST/SGST/IGST and pagination verified.`);
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{
  await stopBrowser().catch(()=>{});if(socket)socket.close();
  if(server&&server.exitCode===null){server.kill();await once(server,'exit');}
  fs.rmSync(temp,{recursive:true,force:true});
});
