# Bill Book

A cheque-book style bill issuing app — plain HTML/CSS/JavaScript, no build step, no dependencies.

## Run it

Open `index.html` directly in a browser, or serve the folder:

```sh
python3 -m http.server 8000 --directory .
# then visit http://localhost:8000
```

## What it does

- **Book** — a serially numbered pad of leaves (like a cheque book). Each issued bill consumes the next number in the range; used leaves show payee, amount, and amount-in-words on their stub.
- **Issue bill** — takes the next free serial automatically, records date, payee, amount, and memo, then opens the printable bill.
- **Register** — searchable, filterable table of every bill with *Mark paid* and *Void* actions. Voided numbers are burned (not re-issued), exactly like a torn cheque leaf.
- **Printable bill** — an A4-style sheet with serial, amount in words (Indian numbering: lakh/crore), a status stamp, and a signature line. Print via the browser dialog.
- **Settings** — your name/address, currency symbol, and the book's serial range. Export/import all data as JSON.

## Data

Everything is stored in your browser's `localStorage` under the key `billbook.v1`. Nothing leaves your machine. Use **Settings → Export data** for backups.

## Files

| File | Purpose |
|------|---------|
| `index.html` | Page structure: book, register, settings, issue modal, printable bill |
| `styles.css` | Ledger-paper styling, stub/leaf layout, print stylesheet |
| `app.js` | Serial bookkeeping, register rendering, amount-in-words, print flow, import/export |
