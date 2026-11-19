/* Pure invoice presentation: saved values in, escaped markup out. No tax calculation or storage. */
(function (root) {
  'use strict';
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[c]));
  const formatDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value || '') ? value.split('-').reverse().join('/') : String(value || '');
  const money = (value, currency) => `${currency} ${Number(value).toLocaleString('en-IN', {minimumFractionDigits:2, maximumFractionDigits:2})}`;

  function invoiceData(bill, seller) {
    const details = bill.details || {};
    const items = details.items?.length ? details.items.map(item => ({description:item.description, taxable_value:item.taxable_value})) :
      [{description:bill.memo || 'Services / goods as invoiced', taxable_value:bill.base_amount ?? bill.amount}];
    const taxes = [];
    // Use the saved type/rate, including taxes that round to zero. Never split or recompute tax.
    if (bill.gst_rate > 0 && bill.gst_type === 'cgst_sgst') {
      taxes.push({name:'CGST', rate:bill.gst_rate / 2, amount:bill.cgst_amount}, {name:'SGST', rate:bill.gst_rate / 2, amount:bill.sgst_amount});
    } else if (bill.gst_rate > 0 && bill.gst_type === 'igst') {
      taxes.push({name:'IGST', rate:bill.gst_rate, amount:bill.igst_amount});
    }
    return {
      number:bill.number, date:bill.date, dueDate:bill.due_date || bill.date, status:bill.status,
      seller:{name:seller.book_name, address:seller.address, gstin:seller.gstin,
        mobile:details.seller_mobile || '', email:details.seller_email || '', website:details.seller_website || ''},
      recipient:{name:bill.payee, address:details.recipient_address || '', gstin:bill.payee_gstin || ''},
      currency:seller.currency || '₹', items, taxes, taxable:bill.base_amount ?? bill.amount, total:bill.amount,
      jurisdiction:typeof seller.legal_line === 'string' ? seller.legal_line.trim() : '',
    };
  }

  function weddingHTML(data, mode = 'elegant') {
    if (!['elegant', 'playful'].includes(mode)) throw new Error('Unknown wedding mode');
    const playful = mode === 'playful';
    const taxNames = data.taxes.map(tax => tax.name).join(' & ');
    const family = data.taxes.length ? 'Together with their beloved GST family' : 'Together in a celebration of creativity';
    const field = (label, value) => value ? `<p><span class="wedding-label">${escape(label)}</span><span class="wedding-text">${escape(value)}</span></p>` : '';
    const hero = playful
      ? `<header class="wedding-heading">
          <div class="wedding-invite-copy"><p class="wedding-kicker">A little joy. A lovely creation.</p>
            <h1><span>Creativity</span> <em>Weds</em> <span>Happiness</span></h1>
            <p class="wedding-subtitle">${family}</p>
            ${taxNames ? `<p class="wedding-tax-family">${escape(taxNames)} join the celebration</p>` : ''}
          </div>
          <div class="wedding-vignette" aria-hidden="true"></div>
          <p class="wedding-document-label">An invoice from <strong>${escape(data.seller.name || 'Seller details not provided')}</strong></p>
        </header>`
      : `<header class="wedding-heading">
          <div class="wedding-arch">
            <div class="wedding-emblem" aria-hidden="true"><i></i><i></i></div>
            <p class="wedding-kicker">A Royal Celebration</p>
            <h1>An Invoice, With Our Compliments</h1>
            <p class="wedding-subtitle">In honour of a beautifully celebrated occasion</p>
          </div>
          <p class="wedding-document-label">Presented with gratitude by <strong>${escape(data.seller.name || 'Seller details not provided')}</strong></p>
        </header>`;
    return `<article class="wedding-invoice wedding-${mode}" data-invoice-number="${escape(data.number)}" aria-label="Wedding invitation-style invoice">
      ${hero}
      <dl class="wedding-meta">
        <div><dt>Invoice number</dt><dd>${escape(String(data.number).padStart(6, '0'))}</dd></div>
        <div><dt>Invoice date</dt><dd>${escape(formatDate(data.date))}</dd></div>
        <div><dt>Payment due</dt><dd>${escape(formatDate(data.dueDate))}</dd></div>
        <div><dt>Status</dt><dd>${escape(data.status)}</dd></div>
      </dl>
      <section class="wedding-parties" aria-label="Seller and recipient">
        <div><h2>${playful ? "The Hosts / Seller" : "With warm regards / Seller"}</h2>${field('Name', data.seller.name) || '<p>Seller name not provided</p>'}${field('Address', data.seller.address || 'Not provided')}${field('GSTIN', data.seller.gstin || (data.taxes.length ? 'Not provided' : ''))}</div>
        <div><h2>${playful ? "Our Guests / Recipient" : "Prepared especially for / Recipient"}</h2>${field('Name', data.recipient.name)}${field('Address', data.recipient.address || 'Not provided')}${field('GSTIN', data.recipient.gstin)}</div>
      </section>
      <section class="wedding-services" aria-label="Invoice line items">
        <h2>${playful ? 'The Celebration Details' : 'The Particulars of Your Celebration'}</h2>
        <table class="wedding-items"><colgroup><col class="wedding-col-number"><col><col class="wedding-col-amount"></colgroup>
          <thead><tr><th scope="col">#</th><th scope="col">Description</th><th scope="col">Taxable value</th></tr></thead>
          <tbody>${data.items.map((item, i) => `<tr><td>${i + 1}</td><td>${escape(item.description)}</td><td>${escape(money(item.taxable_value, data.currency))}</td></tr>`).join('')}</tbody>
        </table>
      </section>
      <section class="wedding-settlement" aria-label="Saved invoice totals">
        ${playful ? '' : '<aside class="wedding-settlement-note"><span aria-hidden="true">✧</span><p>Every detail,<br>beautifully considered.</p></aside>'}
        <div class="wedding-accounting"><h2>Tax Details</h2>
          <dl class="wedding-totals"><div><dt>Taxable value</dt><dd>${escape(money(data.taxable, data.currency))}</dd></div>
          ${data.taxes.map(tax => `<div data-tax="${escape(tax.name)}"><dt>${escape(tax.name)} (${escape(tax.rate)}%)</dt><dd>${escape(money(tax.amount, data.currency))}</dd></div>`).join('')}
          ${data.taxes.length ? '' : '<div><dt>GST</dt><dd>Not applied / nil rate</dd></div>'}</dl>
        </div>
        <dl class="wedding-grand-total"><dt>${playful ? 'The Wedding Gift / Grand Total' : 'Grand Total'}</dt><dd>${escape(money(data.total, data.currency))}</dd></dl>
      </section>
      <footer class="wedding-closing">
        <div class="wedding-rsvp"><h2>${playful ? 'RSVP — Kindly Settle With' : 'RSVP / With Our Gratitude'}</h2>
          ${field('Seller', data.seller.name || 'Not provided')}
          <div class="wedding-contacts">${field('Mobile', data.seller.mobile)}${field('Email', data.seller.email)}${field('Website', data.seller.website)}</div>
          ${!(data.seller.mobile || data.seller.email || data.seller.website) ? '<p class="wedding-contact-note">Contact details not provided.</p>' : ''}
        </div>
        <p class="wedding-farewell">${playful ? 'Your presence is appreciated. Your payment is celebrated!' : 'Thank you for making us part of your special occasion.'}</p>
        ${data.jurisdiction ? `<p class="wedding-jurisdiction">${escape(data.jurisdiction)}</p>` : ''}
      </footer>
    </article>`;
  }

  function render(bill, seller, options, chequeRenderer) {
    const template = options?.template || 'cheque';
    if (template === 'cheque') return chequeRenderer(bill);
    if (template === 'wedding') return weddingHTML(invoiceData(bill, seller), options?.mode || 'elegant');
    if (template === 'funeral') {
      const funeral = typeof module !== 'undefined' && module.exports ? require('./funeral-templates.js') : root.FuneralTemplates;
      return funeral.render(invoiceData(bill, seller), options?.funeralMode || 'respectful', {darkHumorOptIn: options?.darkHumorOptIn === true});
    }
    throw new Error('Unknown invoice template');
  }
  const api = Object.freeze({invoiceData, weddingHTML, render, escape});
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.InvoiceTemplates = api;
})(typeof window !== 'undefined' ? window : globalThis);
