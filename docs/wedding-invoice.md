# Wedding Invitation invoice template v1

This is an optional presentation of an existing invoice. **Cheque Style remains the default on each page load.** Selecting a template or mode does not issue an invoice, change a serial number, modify GST, or write to SQLite/localStorage.

## Preview on MX Linux

```bash
cd /home/Neeraj/Cheque-style-bill-book
python3 server.py 8080
```

1. Open **http://127.0.0.1:8080**.
2. Issue an invoice normally, or use an existing saved invoice.
3. Click **Preview Last Invoice** in Book, or **Preview** beside a record in Register.
4. Change **Template** from **Cheque Style** to **Wedding Invitation**.
5. Choose **Elegant** or **Playful**.
6. Click **Print / Save as PDF**, then choose a printer or the browser's PDF destination. Wedding pages use A4 portrait; cheque pages keep their existing landscape layout. Disable browser headers/footers for a clean document and enable background graphics if your browser/printer overrides print colors.

The selected template/mode stays in browser memory for that page session. Subsequent print actions use that selection; reload to return to Cheque Style. No template preference is stored in financial records. The preview dialog supports keyboard focus navigation and Escape to close.

## Elegant and Playful

Both modes show the same saved invoice number, dates, seller, recipient, GSTINs when provided, items, taxable value, tax amounts, status, and grand total. Elegant — Royal Celebration uses ivory, burgundy and antique gold, a gilded invitation arch with intertwined rings, and mirrored engraved floral corners. Playful — Creativity Weds Happiness has an asymmetric blush/peach invitation hero, a local illustrated bouquet, and a champagne gift-total panel. All fonts are local system serif fonts; no font, CDN, or image download is needed.

Elegant is headed **An Invoice, With Our Compliments**. Playful uses English-only decorative copy (user-entered invoice text is preserved in its original language):

- Main headline: **Creativity Weds Happiness**
- Taxed-invoice subtitle: **Together with their beloved GST family**, followed by the applicable **CGST & SGST** or **IGST** names.
- Nil/no-GST subtitle: **Together in a celebration of creativity**.
- Items: **The Celebration Details**.
- Total: **The Wedding Gift / Grand Total**.
- Contact: **RSVP — Kindly Settle With**.
- Footer: **Your presence is appreciated. Your payment is celebrated!**

Both modes retain an explicitly labeled **Tax Details** section with real tax labels, rates and saved amounts; decorative copy never replaces the breakdown.

Tax amounts are read from the saved invoice. CGST/SGST are not substituted for IGST, and rounded-zero taxes retain their applicable saved tax type. GST calculations and rounding have not changed.

## RSVP, address and itemisation

In the wedding preview, expand **Recipient, RSVP contacts & itemisation**. You may explicitly save:

- Recipient address.
- Seller mobile, email and website for this invoice's RSVP section.
- Item descriptions and taxable values describing the invoice's existing taxable amount.

Seller name/address/GSTIN/currency come from the existing business profile, as they do in the cheque template. RSVP contact fields are per invoice. Missing information is identified as not provided; it is not invented. Website/email values are rendered as escaped text rather than active links.

Existing invoices initially use their saved memo and taxable amount as one line item. No rows are rewritten to create this fallback. Add/remove rows in the optional editor to itemise an invoice. The server requires those values to sum exactly to its saved taxable value and rejects mismatches atomically. This editor does not change the invoice amount, quantity calculations, tax rate or taxes. The original billing form still has its single taxable-value workflow and single invoice-wide GST rate; this release does not add a product catalogue or per-item GST rates.

Click **Save presentation details** before printing edited fields. The preview uses committed data. Conflicting changes from another tab are rejected; reload before retrying. Unsaved edits trigger a discard confirmation when closing the preview.

## Configured jurisdiction/terms

Wedding invoices print only the nonempty **Legal Jurisdiction Notice** from Settings / Profile, exactly as supplied and escaped. Clear that setting and save to omit the line. The template does not choose a court, add a jurisdiction claim, or assert that the text establishes legal jurisdiction. The pre-existing cheque renderer is unchanged, including its historical footer behavior.

## Data compatibility

Optional details are stored in a separate `invoice_details` table linked to the existing invoice number. Financial fields remain in `bills` without schema or value changes.

On first start against a schema-v1 database, the server validates it, creates and verifies a recovery backup beside it, and adds the metadata table in a transaction (schema v2). If backup creation fails, the upgrade stops without changing the original database. The backup location is printed. No real user dataset is upgraded by automated tests; tests use temporary data directories.

JSON exports, SQL data exports, and full SQLite backups retain saved presentation details. Legacy exports without details still import normally. Full SQLite backups from schema v1 or v2 can be restored using the existing explicit, recovery-backed CLI procedure. New exports containing details require this version of the app; older app versions cannot read schema v2 directly. See the [Linux operations guide](linux-local-storage.md).

## Verification

Runtime dependencies remain Python's standard library and the browser. Development tests:

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -v
node tests/frontend.test.js
node tests/templates.test.js
node tests/browser-smoke.js
node tests/wedding-browser.js
```

The browser tests require the development machine's Chromium and `ws` Node utility. Wedding PDF tests additionally use `pdfinfo` and `pdftotext` (Poppler). They exercise real selectors/editor controls, check that selection makes no database writes, verify mobile layout and HTML escaping, and inspect both designs’ A4 PDFs containing long text and 80 items, plus both CGST/SGST and IGST cases. Normal two-item invoices are checked to fit a single A4 page. PNG captures use the same print styling and content width as the A4 PDFs. The existing cheque/GST suites remain in place; their audited renderer, stylesheet and GST source hashes are checked.

Optionally keep fictional A4 PDFs and browser-rendered print-preview PNG screenshots outside the repository for visual review:

```bash
BILLBOOK_TEST_ARTIFACTS=/tmp/billbook-wedding-redesign node tests/wedding-browser.js
```

Physical printer output and every browser's pagination behavior still need manual inspection. Long invoices intentionally span as many A4 pages as needed; there is no fixed-height crop or item limit in the renderer. The optional saved itemisation accepts up to 2,000 items within the existing 16 MiB API request limit.
