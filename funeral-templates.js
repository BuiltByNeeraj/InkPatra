/* Funeral presentation only: shares InvoiceTemplates.invoiceData; never calculates taxes or writes records. */
(function (root) {
  'use strict';
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[c]));
  const date = value => /^\d{4}-\d{2}-\d{2}$/.test(value || '') ? value.split('-').reverse().join('/') : String(value || '');
  const money = (value, currency) => `${currency} ${Number(value).toLocaleString('en-IN', {minimumFractionDigits:2, maximumFractionDigits:2})}`;
  function render(data, mode = 'respectful', options = {}) {
    if (!['respectful', 'dark'].includes(mode)) throw new Error('Unknown funeral mode');
    if (mode === 'dark' && options.darkHumorOptIn !== true) throw new Error('Dark Humor requires explicit opt-in');
    const dark = mode === 'dark';
    const field = (label, value) => value ? `<p><span class="funeral-label">${escape(label)}</span><span class="funeral-text">${escape(value)}</span></p>` : '';
    return `<article class="funeral-invoice funeral-${mode}" data-invoice-number="${escape(data.number)}" aria-label="Funeral Farewell invoice">
      <header class="funeral-heading">
        ${dark ? '<p class="funeral-novelty">Novelty template — not recommended for grieving customers</p>' : ''}
        <div class="funeral-lily" aria-hidden="true"></div>
        <p class="funeral-kicker">${dark ? 'A farewell to outstanding balances' : 'Funeral &amp; Memorial Services'}</p>
        <h1>${dark ? "It's Still Business" : 'With Heartfelt Condolences'}</h1>
        <p class="funeral-message">${dark ? 'We prepared this invoice with a heavy heart. Sorry for your loss... but the books must balance.' : 'May cherished memories bring comfort during this difficult time.'}</p>
        <p class="funeral-document-label">INVOICE <span aria-hidden="true">·</span> ${escape(data.seller.name || 'Service provider not provided')}</p>
      </header>
      <dl class="funeral-meta">
        <div><dt>Invoice number</dt><dd>${escape(String(data.number).padStart(6,'0'))}</dd></div>
        <div><dt>Invoice date</dt><dd>${escape(date(data.date))}</dd></div>
        <div><dt>Payment due</dt><dd>${escape(date(data.dueDate))}</dd></div>
        <div><dt>Status</dt><dd>${escape(data.status)}</dd></div>
      </dl>
      <section class="funeral-parties" aria-label="Service provider and recipient">
        <div><h2>Service provider / Seller</h2>${field('Name',data.seller.name || 'Not provided')}${field('Address',data.seller.address || 'Not provided')}${field('GSTIN',data.seller.gstin || (data.taxes.length ? 'Not provided' : ''))}</div>
        <div><h2>Billed to / Recipient</h2>${field('Name',data.recipient.name)}${field('Address',data.recipient.address || 'Not provided')}${field('GSTIN',data.recipient.gstin)}</div>
      </section>
      <section class="funeral-services" aria-label="Invoice line items">
        <h2>${dark ? 'Services &amp; particulars' : 'Services &amp; Arrangements'}</h2>
        <table class="funeral-items"><colgroup><col class="funeral-col-number"><col><col class="funeral-col-value"></colgroup>
          <thead><tr><th scope="col">#</th><th scope="col">Description</th><th scope="col">Taxable value</th></tr></thead>
          <tbody>${data.items.map((item,i)=>`<tr><td>${i+1}</td><td>${escape(item.description)}</td><td>${escape(money(item.taxable_value,data.currency))}</td></tr>`).join('')}</tbody>
        </table>
      </section>
      <section class="funeral-settlement" aria-label="Saved invoice totals and tax details">
        <h2>${dark ? 'Tax Details' : 'Invoice Summary'}</h2>
        <dl class="funeral-totals">
          <div><dt>Taxable value</dt><dd>${escape(money(data.taxable,data.currency))}</dd></div>
          ${data.taxes.map(tax=>`<div data-tax="${escape(tax.name)}"><dt>${escape(tax.name)} (${escape(tax.rate)}%)</dt><dd>${escape(money(tax.amount,data.currency))}</dd></div>`).join('')}
          ${data.taxes.length ? '' : '<div><dt>GST</dt><dd>Not applied / nil rate (as saved)</dd></div>'}
          <div class="funeral-total"><dt>Grand Total</dt><dd>${escape(money(data.total,data.currency))}</dd></div>
        </dl>
      </section>
      <footer class="funeral-closing">
        <h2>Service provider contact</h2>
        ${field('Provider',data.seller.name || 'Not provided')}
        <div class="funeral-contacts">${field('Mobile',data.seller.mobile)}${field('Email',data.seller.email)}${field('Website',data.seller.website)}</div>
        ${!(data.seller.mobile || data.seller.email || data.seller.website) ? '<p class="funeral-contact-note">Contact details not provided.</p>' : ''}
        ${data.jurisdiction ? `<p class="funeral-jurisdiction">${escape(data.jurisdiction)}</p>` : ''}
        <p class="funeral-signoff">${dark ? 'Please settle by the payment due date shown above.' : 'With Respect &amp; Gratitude'}</p>
      </footer>
    </article>`;
  }
  const api = Object.freeze({render});
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FuneralTemplates = api;
})(typeof window !== 'undefined' ? window : globalThis);
