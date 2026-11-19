# Funeral Farewell invoice template

Funeral Farewell is an optional presentation of an existing saved invoice. It reuses the same invoice data, itemisation and contact metadata as the other templates. No deceased-person details, dates, photographs or additional personal records are required.

Cheque Style remains the application's default template. Selecting Funeral Farewell always starts in **Respectful Farewell**.

## Local preview on MX Linux

```bash
cd /home/Neeraj/Cheque-style-bill-book
python3 server.py 8080
```

1. Open **http://127.0.0.1:8080**.
2. Open a saved invoice using **Preview Last Invoice** in Book or **Preview** in Register.
3. Select **Funeral Farewell**. Respectful Farewell opens automatically, with ivory, soft grey, muted lavender, silver rules and a local white-lily SVG.
4. Expand **Recipient, provider contacts & itemisation** if you need to explicitly save those existing optional fields. No financial amounts can be edited here; item values must sum to the saved taxable value.
5. Use **Print / Save as PDF**. Funeral pages use A4 portrait. Disable browser headers/footers for a clean invoice. Review the actual browser print preview before sharing it with a recipient.

Respectful Farewell uses:

> With Heartfelt Condolences
>
> May cherished memories bring comfort during this difficult time.

Seller and recipient details, invoice number/date, payment due date, status, GSTINs when provided, all line items, taxable value, applicable saved tax components, total, provider contacts and configured jurisdiction/terms remain visible. Long invoices flow across additional A4 pages with repeating item headers. Long words and addresses wrap without a fixed-height crop.

## Explicit Dark Humor opt-in

Dark Humor is an optional novelty template, not recommended for grieving customers. It uses charcoal, muted silver, serif small capitals and restrained decoration.

To enable it, choose **Dark Humor — Novelty (opt-in)** and accept the explicit confirmation. Declining keeps Respectful Farewell. A visible notice appears above the preview, and the printed document itself says **Novelty template — not recommended for grieving customers**.

The novelty heading/message are:

> It's Still Business
>
> We prepared this invoice with a heavy heart. Sorry for your loss... but the books must balance.

Consent applies only to the currently open invoice preview. It is reset when you close that preview, open an invoice again, change templates, or return through browser back/forward cache. Cached novelty print content is cleared when consent is reset. Printing a different invoice cannot carry over the novelty selection. No selection or consent preference is saved in SQLite, localStorage, exports or backups. Reloading the application returns to Cheque Style; selecting Funeral Farewell again returns to Respectful Farewell.

## GST and exemption review

This is a template, not a tax classification system. It does **not** automatically enable GST, mark a service exempt, change invoice totals, alter profile defaults, or recalculate saved taxes.

A preparation notice outside the printable invoice flags **Funeral-service exemption check — separate compliance review required**. Confirm whether an exemption applies to the actual services billed before issuing or printing. The template does not decide which exemption is applicable; that review is separate from the billing calculation.

The original issue form retains its existing profile defaults and tax controls. Review those controls before issuing a new record. Nil/no-GST records remain nil/no-GST; taxed records retain the saved CGST/SGST or IGST labels, rates and amounts. The sample nil-GST invoices are fictional test data, not tax guidance or an exemption determination. The review notice is an operator reminder and is not printed as a claim that compliance review has occurred.

## Persistence and offline operation

- The pure funeral renderer consumes the existing shared invoice model.
- Switching templates/modes makes no API writes and cannot issue or duplicate an invoice.
- Optional presentation details use the existing explicit save action and existing metadata table. This feature needs no new database schema, storage format or migration.
- JSON/SQL export, full SQLite backups, recovery-backed restore, invoice numbering and GST calculation code remain unchanged.
- All scripts, CSS, the lily ornament and fonts are local. There are no CDNs, external images, remote fonts, frontend frameworks or new runtime packages.
- The Python server must be running on loopback for loading/saving. An internet connection is not required. Automated tests also verify rendering and PDF printing with browser networking disabled after loading the local assets.
- User-provided text, including contact details and terms, is HTML escaped. Website/email values are plain text. Blank jurisdiction text is omitted; no court or jurisdiction is invented.

## Automated verification

From the repository root:

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -v
node tests/frontend.test.js
node tests/templates.test.js
node tests/funeral.test.js
node tests/browser-smoke.js
node tests/wedding-browser.js
BILLBOOK_TEST_ARTIFACTS=/tmp/billbook-funeral-review node tests/funeral-browser.js
```

The browser test tools are the development machine's Chromium, `ws`, `pdfinfo` and `pdftotext`; none are required by the application itself. The funeral suite uses only fictional records in disposable temporary directories. It checks default mode, consent rejection/acceptance/reset, unchanged database bytes after selection, nil/CGST/SGST/IGST totals, actual editor saves, offline rendering/printing, mobile wrapping, HTML escaping and 80-item PDFs with an oversized item description and long addresses.

When the artifact directory above is supplied, it retains:

- `respectful-farewell.png` and `respectful-farewell.pdf`.
- `dark-humor.png` and `dark-humor.pdf`.
- Nil/taxed/offline and multi-page PDF test examples.

The PNGs are browser-rendered print previews at the same content width and print styling as the A4 PDFs. Review both modes visually, along with the first/last pages of a long invoice. Physical printer output, paper/ink differences and other browsers still need manual verification.
