'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const source = fs.readFileSync('app.js', 'utf8');
const engine = fs.readFileSync('sqlite-engine.js', 'utf8');
function environment() {
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      value: '', checked: true, style: {}, textContent: '', innerHTML: '', disabled: false,
      addEventListener() {}, classList: {add() {}, remove() {}, toggle() {}}, closest() {return null;},
    });
    return elements.get(id);
  }
  const context = vm.createContext({window: {}, document: {getElementById: element, querySelectorAll: () => [], addEventListener() {}},
    console, Date, performance, confirm: () => false, alert() {}, localStorage: {getItem: () => null},
    fetch: async () => {throw new Error('offline');}});
  vm.runInContext(engine, context);
  vm.runInContext(source.replace(/initializeApplication\(\);\s*$/, ''), context);
  return {context, element, db: context.window.db};
}

test('GST function matches audited original source exactly', () => {
  const gst = source.slice(source.indexOf('function computeGST()'), source.indexOf('\ndocument.getElementById("f-base-amount").addEventListener')).trim();
  assert.equal(crypto.createHash('sha256').update(gst).digest('hex'), 'df9d2db331e03fbc7449d22a9a5989ede0381467018c7835a437df04d79937ee');
});

test('GST regression: standard, zero, custom, disabled and separate half-tax rounding', () => {
  const {context, element} = environment();
  // Preserve monetary formatting while isolating DOM controls from persistence.
  context.money = n => String(n);
  context.amountInWords = n => String(n);
  const vectors = [
    [500, '18', true, 'cgst_sgst', 0, 45, 45, 0, 590],
    [500, '18', true, 'igst', 0, 0, 0, 90, 590],
    [100, '0', true, 'cgst_sgst', 0, 0, 0, 0, 100],
    [100, '28', false, 'igst', 0, 0, 0, 0, 100],
    [99.99, 'custom', true, 'cgst_sgst', 7.5, 3.75, 3.75, 0, 107.49],
    [0.05, '18', true, 'cgst_sgst', 0, 0, 0, 0, 0.05],
    [0.05, '18', true, 'igst', 0, 0, 0, 0.01, 0.06],
    [0.06, '18', true, 'cgst_sgst', 0, 0.01, 0.01, 0, 0.08],
    [1234.56, '5', true, 'cgst_sgst', 0, 30.86, 30.86, 0, 1296.28],
    [1234.56, '12', true, 'igst', 0, 0, 0, 148.15, 1382.71],
  ];
  for (const [base, rate, apply, type, custom, cgst, sgst, igst, total] of vectors) {
    element('f-base-amount').value = String(base);
    element('f-gst-rate').value = rate;
    element('f-apply-gst').checked = apply;
    element('f-gst-type').value = type;
    element('f-custom-rate').value = String(custom);
    const actual = context.computeGST();
    assert.deepEqual([actual.cgst, actual.sgst, actual.igst, actual.total], [cgst, sgst, igst, total]);
  }
});

test('backend failure leaves frontend snapshot unchanged', async () => {
  const {context, db} = environment();
  db.applyState({settings: {book_name: 'keep'}, bills: [{number: 1}]});
  context.fetch = async () => ({ok: false, json: async () => ({error: 'conflict'})});
  await assert.rejects(db.insertBill({number: 1}), /conflict/);
  assert.equal(db.getBills()[0].number, 1);
  assert.equal(db.getSettings().book_name, 'keep');
});

test('frontend waits for committed response before changing snapshot or confirming success', async () => {
  const {context, db} = environment();
  db.applyState({settings: {}, bills: []});
  let finish;
  context.fetch = () => new Promise(resolve => {finish = resolve;});
  let confirmed = false;
  const button = {disabled: false};
  const action = context.committedAction(async () => {await db.insertBill({number: 1}); confirmed = true;});
  const pending = action({preventDefault() {}, target: {closest: () => button}});
  assert.equal(confirmed, false);
  assert.equal(db.getBills().length, 0);
  assert.equal(button.disabled, true);
  finish({ok: true, json: async () => ({result: {number: 1}, state: {settings: {}, bills: [{number: 1}]}})});
  await pending;
  assert.equal(confirmed, true);
  assert.equal(db.getBills().length, 1);
  assert.equal(button.disabled, false);
});

test('migration is explicit and never writes or clears localStorage', async () => {
  const {context, db} = environment();
  const raw = '{"settings":[{}],"bills":[]}';
  const calls = [];
  context.localStorage = {getItem: key => key === 'billbook.sqlite.memory' ? raw : null,
    setItem() {throw new Error('Must not modify localStorage');}, removeItem() {throw new Error('Must not remove localStorage');}, clear() {throw new Error('Must not clear localStorage');}};
  db.mutate = async (path, data) => {calls.push(data); return {count: 0};};
  context.confirm = () => false;
  await db.migrateBrowserData();
  assert.equal(calls.length, 0);
  context.confirm = () => true;
  await db.migrateBrowserData();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].raw_source, raw);
  assert.equal(calls[0].confirm_import, true);
});

test('duplicate UI submissions are blocked until commit', async () => {
  const {context} = environment();
  let complete, calls = 0;
  const action = context.committedAction(async () => {calls++; await new Promise(r => {complete = r;});});
  const event = {preventDefault() {}, target: {closest: () => null}};
  const first = action(event);
  await action(event);
  assert.equal(calls, 1);
  complete(); await first;
});


test('offline save retains form and never confirms success', async () => {
  const {context, db} = environment();
  const messages = [];
  context.alert = text => messages.push(text);
  let closed = false;
  const action = context.committedAction(async () => {await db.insertBill({number: 1}); closed = true;});
  await action({preventDefault() {}, target: {closest: () => null}});
  assert.equal(closed, false);
  assert.match(messages[0], /Save is not confirmed/);
});

test('JSON import cancellation does not contact backend', async () => {
  const {context, db} = environment();
  context.confirm = () => false;
  let called = false;
  context.fetch = () => {called = true; throw new Error('must not run');};
  await assert.rejects(db.importJSON({bills: []}), /cancelled/);
  assert.equal(called, false);
});
