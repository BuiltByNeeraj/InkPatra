/* Browser preview controls. Template changes never issue or update an invoice. */
(function (root) {
  'use strict';
  const selection = {template:'cheque', mode:'elegant', funeralMode:'respectful', darkHumorOptIn:false};
  let darkOptInInvoice = null;
  let db, helpers, number = null, previousFocus, dirty = false;
  const byId = id => document.getElementById(id);
  function render() {
    const bill = db.getBill(number);
    if (!bill) return;
    byId('invoice-preview-content').innerHTML = InvoiceTemplates.render(bill, db.getSettings(), selection, helpers.cheque);
    byId('wedding-mode-field').hidden = selection.template !== 'wedding';
    byId('funeral-mode-field').hidden = selection.template !== 'funeral';
    byId('funeral-tax-review').hidden = selection.template !== 'funeral';
    byId('funeral-novelty-note').hidden = selection.template !== 'funeral' || selection.funeralMode !== 'dark';
    byId('invoice-details-editor').hidden = !['wedding','funeral'].includes(selection.template);
    byId('invoice-details-summary').textContent = selection.template === 'funeral' ? 'Recipient, provider contacts & itemisation' : 'Recipient, RSVP contacts & itemisation';
  }
  function resetFuneralMode() {
    selection.funeralMode = 'respectful';
    selection.darkHumorOptIn = false;
    darkOptInInvoice = null;
    byId('funeral-mode').value = 'respectful';
    byId('funeral-novelty-note').hidden = true;
    const area = byId('print-area');
    if (area.querySelector('.funeral-dark')) {
      area.replaceChildren(); area.hidden = true; delete area.dataset.template;
    }
  }
  function row(item = {description:'', taxable_value:''}) {
    const wrapper = document.createElement('div');
    wrapper.className = 'invoice-item-editor';
    wrapper.innerHTML = '<label>Description<textarea class="invoice-item-description" required></textarea></label><label>Taxable value<input class="invoice-item-value" type="number" min="0" step="any" required></label><button type="button" class="btn small ghost">Remove</button>';
    wrapper.querySelector('textarea').value = item.description;
    wrapper.querySelector('input').value = item.taxable_value;
    wrapper.querySelector('button').addEventListener('click', () => {wrapper.remove(); dirty = true;});
    byId('invoice-items-editor').append(wrapper);
  }
  function fillDetails() {
    const bill = db.getBill(number), details = bill.details || {};
    for (const key of ['recipient_address', 'seller_mobile', 'seller_email', 'seller_website']) byId('invoice-' + key).value = details[key] || '';
    byId('invoice-items-editor').replaceChildren();
    const items = details.items?.length ? details.items : InvoiceTemplates.invoiceData(bill, db.getSettings()).items;
    items.forEach(row);
    byId('invoice-saved-taxable').textContent = helpers.money(bill.base_amount ?? bill.amount);
    byId('invoice-details-feedback').textContent = '';
    dirty = false;
  }
  function open(invoiceNumber) {
    if (number !== null && dirty && !confirm('Discard unsaved invoice presentation details?')) return;
    resetFuneralMode();
    number = invoiceNumber;
    if (!db.getBill(number)) return;
    previousFocus = document.activeElement;
    fillDetails(); render();
    byId('invoice-preview-overlay').hidden = false;
    document.querySelector('main').inert = true;
    document.querySelector('header').inert = true;
    byId('invoice-template').focus();
  }
  function close() {
    if (byId('form-invoice-details').dataset.saving === 'true') return;
    if (dirty && !confirm('Discard unsaved invoice presentation details?')) return;
    dirty = false;
    resetFuneralMode();
    byId('invoice-preview-overlay').hidden = true;
    document.querySelector('main').inert = false;
    document.querySelector('header').inert = false;
    previousFocus?.focus();
  }
  function print(invoiceNumber = number) {
    const bill = db.getBill(invoiceNumber);
    if (!bill) return;
    if (selection.funeralMode === 'dark' && darkOptInInvoice !== invoiceNumber) {resetFuneralMode(); render();}
    const area = byId('print-area');
    area.dataset.template = selection.template;
    area.innerHTML = InvoiceTemplates.render(bill, db.getSettings(), selection, helpers.cheque);
    area.hidden = false;
    const afterPrint = () => {area.hidden = true;};
    window.addEventListener('afterprint', afterPrint, {once:true});
    window.print();
  }
  function initialize(store, formatters) {
    db = store; helpers = formatters;
    byId('invoice-template').value = selection.template;
    byId('wedding-mode').value = selection.mode;
    resetFuneralMode();
    byId('invoice-template').addEventListener('change', event => {
      resetFuneralMode(); selection.template = event.target.value; render();
    });
    byId('funeral-mode').addEventListener('change', event => {
      if (selection.template === 'funeral' && event.target.value === 'dark' &&
          confirm('Dark Humor is a novelty template, not recommended for grieving customers. Explicitly enable it for this invoice preview?')) {
        selection.funeralMode = 'dark'; selection.darkHumorOptIn = true; darkOptInInvoice = number;
      } else {resetFuneralMode();}
      render();
    });
    byId('wedding-mode').addEventListener('change', event => {selection.mode = event.target.value; render();});
    root.addEventListener('pageshow', event => {
      if (event.persisted) {resetFuneralMode(); if (number !== null) render();}
    });
    byId('btn-close-invoice-preview').addEventListener('click', close);
    byId('btn-preview-print').addEventListener('click', () => {
      if (dirty) {alert('Save or discard the edited details before printing. The preview shows saved data.'); return;}
      print();
    });
    byId('invoice-preview-overlay').addEventListener('click', event => {if (event.target === byId('invoice-preview-overlay')) close();});
    byId('btn-add-invoice-item').addEventListener('click', () => {row(); dirty = true;});
    byId('form-invoice-details').addEventListener('input', () => {dirty = true;});
    byId('form-invoice-details').addEventListener('submit', helpers.committedAction(async event => {
      event.preventDefault();
      const form = byId('form-invoice-details');
      form.dataset.saving = 'true';
      const details = {};
      for (const key of ['recipient_address', 'seller_mobile', 'seller_email', 'seller_website']) details[key] = byId('invoice-' + key).value.trim();
      details.items = Array.from(byId('invoice-items-editor').children, item => ({
        description:item.querySelector('textarea').value.trim(), taxable_value:Number(item.querySelector('input').value),
      }));
      try {
        await db.saveInvoiceDetails(number, details);
        dirty = false; render();
        byId('invoice-details-feedback').textContent = 'Presentation details saved. Invoice amounts and GST are unchanged.';
      } finally {form.dataset.saving = 'false';}
    }));
    document.addEventListener('keydown', event => {
      if (byId('invoice-preview-overlay').hidden) return;
      if (event.key === 'Escape') {event.preventDefault(); close();}
      if (event.key === 'Tab') {
        const focusable = Array.from(byId('invoice-preview-overlay').querySelectorAll('button, select, input, textarea, summary')).filter(el => !el.disabled && el.getClientRects().length);
        const first = focusable[0], last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {event.preventDefault(); last.focus();}
        else if (!event.shiftKey && document.activeElement === last) {event.preventDefault(); first.focus();}
      }
    });
    byId('btn-preview-current').addEventListener('click', () => {
      const last = db.getBills().filter(bill => bill.status !== 'void').sort((a,b) => b.number-a.number)[0];
      if (last) open(last.number);
    });
  }
  root.InvoicePreview = Object.freeze({initialize, open, print});
})(window);
