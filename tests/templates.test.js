'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const templates = require('../invoice-templates.js');
const bill = {number:7, date:'2026-11-19', due_date:'2026-12-01', payee:'Asha & Ravi', payee_gstin:'27RECIPIENT1Z5', memo:'Wedding photography', base_amount:500, gst_rate:18, gst_type:'cgst_sgst', cgst_amount:45, sgst_amount:45, igst_amount:0, amount:590, status:'issued', issued_at:'original'};
const seller = {book_name:'Saffron Celebrations', address:'Pune, Maharashtra', gstin:'27SELLERGST1Z5', currency:'₹', range_to:50, legal_line:''};
const wedding = (changes={}, mode='elegant', profile=seller) => templates.render({...bill,...changes}, profile, {template:'wedding',mode});

test('Cheque Style is the default and receives the original invoice', () => {
  let received;
  assert.equal(templates.render(bill,seller,undefined,b => {received=b; return 'original-cheque';}), 'original-cheque');
  assert.equal(received,bill);
  assert.throws(() => templates.render(bill,seller,{template:'other'}), /Unknown/);
});

test('Elegant is the default wedding mode and has professional wording', () => {
  const html = templates.render(bill,seller,{template:'wedding'});
  assert.match(html,/wedding-elegant/);
  assert.match(html,/An Invoice, With Our Compliments/);
  assert.doesNotMatch(html,/Creativity|Wedding Gift|payment is celebrated/);
});

test('Playful wording, mandatory identifiers and saved totals are present', () => {
  const html = wedding({},'playful');
  for(const text of ['Creativity','Weds','Happiness','Together with their beloved GST family','CGST &amp; SGST join the celebration','The Celebration Details','The Wedding Gift / Grand Total','RSVP — Kindly Settle With','Your presence is appreciated. Your payment is celebrated!','000007','19/11/2026','01/12/2026','27RECIPIENT1Z5','27SELLERGST1Z5','Wedding photography','590.00']) assert.ok(html.includes(text),text);
});

test('IGST never displays CGST or SGST wording; saved amounts are not recomputed', () => {
  const html = wedding({gst_type:'igst',cgst_amount:0,sgst_amount:0,igst_amount:89.99,amount:589.99},'playful');
  assert.match(html,/IGST join the celebration/);
  assert.doesNotMatch(html,/CGST|SGST/);
  assert.match(html,/89\.99/);
  assert.match(html,/589\.99/);
});

test('Nil and no-GST invoices have no tax-family blessing; zero-rounded GST retains correct type', () => {
  for(const changes of [{gst_rate:0}, {gst_rate:0,gst_type:'none'}]) {
    assert.doesNotMatch(wedding(changes,'playful'),/GST family|CGST|SGST|IGST/);
  }
  const html = wedding({base_amount:0.05,cgst_amount:0,sgst_amount:0,amount:0.05},'playful');
  assert.match(html,/data-tax="CGST"/);
  assert.match(html,/data-tax="SGST"/);
  assert.match(html,/₹ 0\.00/);
});

test('All modes render identical saved invoice data without modifying inputs', () => {
  const invoice = Object.freeze({...bill, details:Object.freeze({recipient_address:'Recipient address', seller_mobile:'9876543210', seller_email:'hello@example.test', seller_website:'example.test', items:Object.freeze([Object.freeze({description:'Photography',taxable_value:300}),Object.freeze({description:'Album',taxable_value:200})])})});
  const before = JSON.stringify(invoice);
  const data = templates.invoiceData(invoice,Object.freeze({...seller}));
  assert.equal(data.taxable,500); assert.equal(data.total,590);
  assert.deepEqual(data.taxes.map(t => t.amount),[45,45]);
  for(const mode of ['elegant','playful']) {
    const html=templates.weddingHTML(data,mode);
    for(const text of ['Photography','Album','300.00','200.00','500.00','590.00','9876543210','hello@example.test','example.test','Recipient address']) assert.ok(html.includes(text),text);
  }
  assert.equal(JSON.stringify(invoice),before);
});

test('User-controlled strings are HTML escaped including all contacts, currency and jurisdiction', () => {
  const attack='"><img src=x onerror="alert(1)"><script>alert(2)</script>&';
  const input={...bill,number:attack,date:attack,status:attack,payee:attack,payee_gstin:attack,memo:attack,
    details:{recipient_address:attack,seller_mobile:attack,seller_email:attack,seller_website:attack,items:[{description:attack,taxable_value:500}]}};
  const html=templates.weddingHTML(templates.invoiceData(input,{book_name:attack,address:attack,gstin:attack,currency:attack,legal_line:attack}),'playful');
  assert.doesNotMatch(html,/<img|<script/);
  assert.match(html,/&lt;script&gt;/);
  assert.match(html,/&quot;&gt;/);
  assert.match(html,/&amp;/);
});

test('Jurisdiction is omitted when absent or blank, and configured text is displayed verbatim', () => {
  for(const legal_line of [undefined,'','  ']) assert.doesNotMatch(wedding({},'elegant',{...seller,legal_line}),/class="wedding-jurisdiction"|Court|District/);
  const html=wedding({},'elegant',{...seller,legal_line:'Agreed terms: Pune & Mumbai'});
  assert.match(html,/Agreed terms: Pune &amp; Mumbai/);
  assert.doesNotMatch(html,/establishes|District|exclusive jurisdiction/);
});

test('Long names, multiline addresses and every line item remain in full markup', () => {
  const long='Long name '.repeat(300);
  const address='Address line\n'.repeat(100);
  const items=Array.from({length:100},(_,i)=>({description:`ITEM-${i}-`+'description '.repeat(50),taxable_value:5}));
  const html=wedding({payee:long,details:{recipient_address:address,items}},'elegant',{...seller,book_name:long,address});
  assert.ok(html.includes(long)); assert.ok(html.includes(address));
  assert.equal((html.match(/<tr>/g)||[]).length,101);
  items.forEach(item=>assert.ok(html.includes(item.description)));
});

test('Print CSS isolates A4 wedding pages, repeats item headers and permits pagination', () => {
  const css=fs.readFileSync('invoice-templates.css','utf8');
  assert.match(css,/@page wedding\s*\{\s*size: A4 portrait/);
  assert.match(css,/table-header-group/);
  assert.match(css,/overflow: visible; height: auto; max-height: none/);
  assert.match(css,/\.wedding-services, \.wedding-items, \.wedding-invoice \{ break-inside: auto/);
  assert.match(fs.readFileSync('styles.css','utf8'),/size: landscape/);
});

test('Existing cheque renderer and cheque CSS match the audited baseline exactly', () => {
  const source=fs.readFileSync('app.js','utf8');
  const cheque=source.slice(source.indexOf('function chequeHTML('),source.indexOf('\nfunction openPrint(')).trim();
  assert.equal(crypto.createHash('sha256').update(cheque).digest('hex'),'ed9f1ee1dd1752ec46b8b939f350e1fea69c2fbc1725fb9ef3e60c3096b1c0d0');
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync('styles.css')).digest('hex'),'3cfee1ff662f8912023702557c492f3864d9167464542a5b7c8b3bfc020b6854');
});


test('Decorative Playful copy is English-only and compositions have different structures', () => {
  const elegant=wedding({},'elegant'),playful=wedding({},'playful');
  assert.doesNotMatch(playful,/[\u0900-\u097f]|Shagun|prarthaniya|Software Weds Amount/);
  assert.match(elegant,/class="wedding-arch"/);
  assert.doesNotMatch(elegant,/class="wedding-vignette"/);
  assert.match(playful,/class="wedding-vignette"/);
  assert.doesNotMatch(playful,/class="wedding-arch"/);
  for(const html of [elegant,playful]) {
    assert.match(html,/Tax Details/);
    assert.match(html,/CGST \(9%\)/);assert.match(html,/SGST \(9%\)/);
  }
});
