'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const templates = require('../invoice-templates.js');
const funeral = require('../funeral-templates.js');
const bill = Object.freeze({number:12,date:'2026-11-19',due_date:'2026-12-01',payee:'Account holder',payee_gstin:'27RECIPIENT1Z5',memo:'Services as agreed',base_amount:500,gst_rate:0,gst_type:'none',cgst_amount:0,sgst_amount:0,igst_amount:0,amount:500,status:'issued',issued_at:'original',details:Object.freeze({recipient_address:'Recipient address\nPune',seller_mobile:'9876543210',seller_email:'contact@example.test',seller_website:'example.test'})});
const seller = Object.freeze({book_name:'Willow Care Services',address:'Pune, Maharashtra',gstin:'27SELLERGST1Z5',currency:'₹',legal_line:''});
const render = (invoice=bill, mode='respectful') => templates.render(invoice,seller,{template:'funeral',funeralMode:mode,darkHumorOptIn:mode==='dark'});

test('Funeral defaults to Respectful, regardless of wedding mode or an unused opt-in flag', () => {
  for(const options of [{template:'funeral'},{template:'funeral',mode:'playful'},{template:'funeral',darkHumorOptIn:true}]) {
    const html=templates.render(bill,seller,options);
    assert.match(html,/funeral-respectful/);
    assert.match(html,/With Heartfelt Condolences/);
    for(const phrase of [/Services &amp; Arrangements/,/Invoice Summary/,/With Respect &amp; Gratitude/]) assert.match(html,phrase);
    assert.match(html,/May cherished memories bring comfort during this difficult time\./);
    assert.doesNotMatch(html,/It's Still Business|books must balance|funeral-novelty/);
  }
});

test('Dark Humor requires explicit mode and boolean opt-in; it is labeled on the invoice', () => {
  const data=templates.invoiceData(bill,seller);
  for(const consent of [undefined,false,'true',1]) assert.throws(()=>funeral.render(data,'dark',{darkHumorOptIn:consent}),/explicit opt-in/);
  assert.throws(()=>funeral.render(data,'other'),/Unknown/);
  const html=render(bill,'dark');
  assert.match(html,/It's Still Business/);
  assert.match(html,/We prepared this invoice with a heavy heart\. Sorry for your loss\.\.\. but the books must balance\./);
  assert.match(html,/Novelty template — not recommended for grieving customers/);
  assert.match(html,/Tax Details/);
  assert.match(html,/Grand Total/);
});

test('Existing nil/no-GST selection is preserved in both modes without tax assumptions', () => {
  const before=JSON.stringify(bill);
  for(const mode of ['respectful','dark']) {
    const html=render(bill,mode);
    assert.match(html,/Not applied \/ nil rate \(as saved\)/);
    assert.doesNotMatch(html,/data-tax=|18%|CGST|SGST|IGST/);
    assert.match(html,/₹ 500\.00/);
  }
  assert.equal(JSON.stringify(bill),before);
});

test('CGST/SGST, IGST and rounded-zero tax amounts render as saved in both modes', () => {
  for(const mode of ['respectful','dark']) {
    const intra=render({...bill,gst_rate:18,gst_type:'cgst_sgst',cgst_amount:45,sgst_amount:45,amount:590},mode);
    assert.match(intra,/CGST \(9%\)/);assert.match(intra,/SGST \(9%\)/);assert.doesNotMatch(intra,/IGST/);
    assert.match(intra,/₹ 590\.00/);
    const inter=render({...bill,gst_rate:18,gst_type:'igst',igst_amount:89.99,amount:589.99},mode);
    assert.match(inter,/IGST \(18%\)/);assert.doesNotMatch(inter,/CGST|SGST/);
    assert.match(inter,/₹ 89\.99/);assert.match(inter,/₹ 589\.99/);
    const zero=render({...bill,base_amount:0.05,amount:0.05,gst_rate:18,gst_type:'cgst_sgst'},mode);
    assert.match(zero,/CGST \(9%\)/);assert.match(zero,/₹ 0\.00/);
  }
});

test('Both modes retain mandatory identifiers, items, contacts and exact input data', () => {
  const invoice=Object.freeze({...bill,details:Object.freeze({...bill.details,items:Object.freeze([Object.freeze({description:'Service one',taxable_value:300}),Object.freeze({description:'Service two',taxable_value:200})])})});
  const before=JSON.stringify(invoice);
  for(const mode of ['respectful','dark']) {
    const html=render(invoice,mode);
    for(const text of ['000012','19/11/2026','01/12/2026','issued','Account holder','Willow Care Services','Pune, Maharashtra','27SELLERGST1Z5','27RECIPIENT1Z5','Recipient address','Service one','Service two','300.00','200.00','500.00','9876543210','contact@example.test','example.test']) assert.ok(html.includes(text),text);
  }
  assert.equal(JSON.stringify(invoice),before);
});

test('No deceased-person name, date or photograph is required or invented', () => {
  const html=templates.render({...bill,details:undefined},seller,{template:'funeral'});
  assert.match(html,/Services as agreed/);
  assert.doesNotMatch(html,/<img|deceased|deceased_name|photograph|Date of death/i);
});

test('All user-controlled fields are escaped, including contacts, currency and configured terms', () => {
  const attack='"><script>alert(1)</script><img src=x onerror=alert(2)>&';
  const data=templates.invoiceData({...bill,number:attack,date:attack,due_date:attack,status:attack,payee:attack,payee_gstin:attack,details:{recipient_address:attack,seller_mobile:attack,seller_email:attack,seller_website:attack,items:[{description:attack,taxable_value:500}]}},{book_name:attack,address:attack,gstin:attack,currency:attack,legal_line:attack});
  for(const mode of ['respectful','dark']) {
    const html=funeral.render(data,mode,{darkHumorOptIn:mode==='dark'});
    assert.doesNotMatch(html,/<script|<img/);
    assert.match(html,/&lt;script&gt;/);assert.match(html,/&quot;&gt;/);assert.match(html,/&amp;/);
  }
});

test('Long party details and every item are retained without truncation', () => {
  const name='Long customer name '.repeat(300),address='Long address line\n'.repeat(120);
  const items=Array.from({length:100},(_,i)=>({description:`ROW-${i} `+'Service description '.repeat(40),taxable_value:5}));
  const invoice={...bill,payee:name,details:{...bill.details,recipient_address:address,items}};
  for(const mode of ['respectful','dark']) {
    const html=render(invoice,mode);
    assert.ok(html.includes(name));assert.ok(html.includes(address));
    items.forEach(item=>assert.ok(html.includes(item.description)));
    assert.equal((html.match(/<tr>/g)||[]).length,101);
  }
});

test('Blank jurisdiction is omitted and configured terms are escaped without additions', () => {
  assert.doesNotMatch(render(),/class="funeral-jurisdiction"/);
  const html=templates.render(bill,{...seller,legal_line:'Agreed & configured terms'},{template:'funeral'});
  assert.match(html,/Agreed &amp; configured terms/);assert.doesNotMatch(html,/District|Court|exclusive jurisdiction/);
});

test('Funeral styles are local, use A4 pages and allow pagination with repeated headers', () => {
  const css=fs.readFileSync('funeral-templates.css','utf8');
  assert.match(css,/@page farewell \{ size: A4 portrait/);
  assert.match(css,/table-header-group/);
  assert.match(css,/overflow: visible; height: auto; max-height: none/);
  assert.match(css,/\.funeral-services, \.funeral-items, \.funeral-invoice \{ break-inside: auto/);
  assert.doesNotMatch(css,/@import|https?:\/\//);
  assert.match(css,/url\('funeral-lily.svg'\)/);
});

test('Wedding renderer and stylesheet remain byte-for-byte unchanged by this feature', () => {
  const source=fs.readFileSync('invoice-templates.js','utf8');
  const wedding=source.slice(source.indexOf('  function weddingHTML'),source.indexOf('  function render'));
  assert.equal(crypto.createHash('sha256').update(wedding).digest('hex'),'6f9115e63c642f102d33b45dfa6b28f912d545054f374de6d1b7d8200b0b6348');
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync('invoice-templates.css')).digest('hex'),'37bf5a6c67d958681982fc559fa5416f1e79dd73f514e9596ccf7e9816d5cbc4');
});
