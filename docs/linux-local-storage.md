# Linux local storage and operations

The Python server is now required. Opening `index.html` directly, running a plain static server, or hosting these files on GitHub Pages does not enable billing. The frontend will keep its controls inactive when it cannot load the local backend.

## Start on MX Linux

Use the system Python 3. No pip packages, Node.js, frontend build, network connection, or administrative privileges are needed to run the app.

```bash
cd /home/Neeraj/Cheque-style-bill-book
python3 server.py 8080
```

Open **http://127.0.0.1:8080** in your browser. Use that exact hostname, not `localhost`. Leave the terminal running; stop with Ctrl+C. After a PC reboot, run the same command again. Starting the server does not clear or reimport any records.

The database location is:

```text
${XDG_DATA_HOME:-$HOME/.local/share}/cheque-style-bill-book/billbook.sqlite3
```

The server prints its actual database location. The application directory is private to the Linux user (0700), and the database and generated backup/source files use 0600 permissions. Run as your normal user. Do not use `sudo`, change Linux accounts, or change `XDG_DATA_HOME` between launches unless you intend to use a separate dataset. The server refuses to place application data or backups within this repository.

## Existing browser records: explicit migration

Nothing reads browser records into SQLite without confirmation. No application code writes, clears, or removes localStorage keys.

1. Before switching from the old app, open it at its original URL in the original browser profile and export **JSON**. Keep an independent copy.
2. Start the new server and open its exact URL above.
3. If that browser origin contains `billbook.sqlite.memory` or `billbook.v1`, the app offers to import each source. Cancel leaves the SQLite database and browser source unchanged. You can import later by reloading.
4. Approving imports the entire dataset in one transaction and saves the original source in a private `migration-*.json` file beside the database. Browser records remain untouched after success or failure.
5. If the old origin was `localhost`, another port, `file://`, or another browser profile, its localStorage cannot be read by the new origin. Use the old app's JSON export and the existing **Import Data / Script** control.
6. Check invoice count, numbers, tax values, paid/void status, and business settings against the original. JSON exports can be compared before and after.

If the old app is no longer usable, visit its original URL/profile and use the browser's developer tools to inspect/export the relevant localStorage key. These keys are origin-specific; an empty database at the new URL does not mean the old data has been erased. Do not clear browser storage while recovering records. Current JSON exports, current localStorage records (settings array), and legacy `billbook.v1` records are supported. Invalid legacy data is rejected rather than guessed or silently discarded.

Import safety:

- Every invoice number must be unique, including paid and void invoices. Any duplicate aborts the entire import; there is no overwrite/merge mode.
- Conflicting business settings are rejected. An empty book with default settings can adopt imported settings; an existing book cannot have its settings replaced by an import.
- A repeated identical dataset is rejected. Original source snapshots are retained even for failed transactional imports, where validation has succeeded.
- JSON and application SQL dumps are supported. SQL dumps are parsed as literal data; uploaded statements are never executed. Unsupported statements abort the import. This is not a general SQLite script runner.
- For data spread across several origins/books, retain separate exports and reconcile conflicts explicitly before import. Do not renumber original invoices merely to bypass a conflict.

## Backup

**JSON export:** Use the existing **Export Data (JSON)** button. It loads a fresh committed backend snapshot before downloading settings and invoices. Keep exports outside the repository. JSON imports are transactional and additive; they will refuse collisions rather than replace an existing book.

**Full SQLite backup:** Stop the server with Ctrl+C, then run:

```bash
mkdir -p "$HOME/BillBookBackups"
python3 server.py --backup "$HOME/BillBookBackups/billbook-$(date +%Y%m%d-%H%M%S).sqlite3"
```

The command uses SQLite's backup API and validates database integrity, schema, settings, and invoice records before reporting success. It refuses to overwrite an existing destination. The destination directory must already exist. Full SQLite backups include migration history; JSON exports include settings and invoices only.

Copy important backups to another physical device. A backup beside the live database is useful for recovery but cannot protect against disk failure. Backups contain customer information and are not encrypted.

## Restore a full SQLite backup

Stop the server first. Copying over the live database manually is not supported. Run:

```bash
python3 server.py --restore "$HOME/BillBookBackups/your-backup.sqlite3" --confirm-restore
python3 server.py 8080
```

Restore requires explicit confirmation and an exclusive application lock:

1. Copy the replacement into a private staging file and validate it before activation.
2. Create and verify a new recovery backup of the current database. If this fails, do not modify the current records.
3. Replace settings, invoices, and migration history inside one SQLite transaction. A failed operation rolls back to the original data.
4. Print the recovery backup path after success. Reload all open browser tabs to discard stale snapshots.

Full SQLite backups from schema v1 and v2 are accepted for restore. The current version adds an optional invoice-details table after a verified backup when opening a v1 database. Older SQL/JSON exports use the import workflow above. Recovery backups remain in the application data directory. Resetting the book through the existing UI also creates a verified recovery backup before deleting records.

## Persistence and security design

- File-backed SQLite, rollback journaling, `synchronous=FULL`, and short `BEGIN IMMEDIATE` transactions. Each request opens and closes its own database connection.
- Invoice number allocation and insertion occur in the same transaction. A stale proposed number is rejected. Paid/void transitions check the previously loaded status. Void numbers stay occupied.
- GST remains calculated by the unchanged frontend function. The backend validates and persists its numeric values without recomputing taxes or changing rounding. Existing historical tax values are retained during migration.
- The frontend changes its cached state, closes the issue form, prints, or shows a successful save only after receiving a committed response. A network interruption after commit can leave the outcome uncertain: reload before retrying.
- Host must equal `127.0.0.1:<port>`. Foreign/null Origins and cross-site Fetch Metadata are rejected. Every write requires the exact same Origin, JSON content type, and an unpredictable per-process CSRF token. No cross-origin CORS permissions are returned.
- The API has no SQL execution endpoint. The existing console is a limited, read-only query helper over the browser snapshot; reload for changes made in other tabs. The server serves only explicitly listed frontend assets, with restrictive security headers and no directory browsing.
- The Python server is loopback-only and intended for a trusted Linux user session. It does not defend against malware or other programs running as the same user, browser extensions with broad access, physical disk failure, or privileged local users.
- The CSP blocks external images and network requests. Use the existing logo file upload for offline printing; remote logo URLs are not loaded.

## Automated verification

From the repository root:

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -v
node tests/frontend.test.js
node --check app.js
node --check sqlite-engine.js
```

Python tests use disposable temporary directories, including real server subprocess restarts and failed restore simulations. Node.js is needed only for frontend/GST tests, not to run the app. The GST suite checks the audited function's source hash and fixed expected rounding cases.

An optional browser integration test uses locally installed Chromium and the `ws` Node test utility (already available on the development machine):

```bash
node tests/browser-smoke.js
```

It uses a disposable browser profile and application directory under `/tmp`, tests real UI saves/migration/browser restarts, and suppresses the native print dialog in the test browser only. Its Chromium process uses `--no-sandbox` for headless test compatibility; this does not affect the normal application/browser.

## Manual acceptance

1. Export old browser data before migration. Verify that cancelling migration leaves it untouched; approve once and compare records and tax values.
2. Configure a profile and range; issue both intra-state and inter-state bills. Compare their printed layouts and tax totals with the old app.
3. Close the browser, reopen the app, and verify invoices. Stop/restart the server and verify again.
4. Reboot MX Linux, start the server with the same user/environment, and verify records and settings.
5. In two tabs, open an issue form at the same number. Save one; confirm the second receives a conflict and cannot overwrite it. Reload that tab before continuing.
6. Mark an invoice paid, then void it. Issue another and verify the voided number is not reused.
7. Export JSON and SQL. Try reimporting into the populated book; verify a conflict leaves all records unchanged. Test restoration only after making an independent full backup.
8. Create a full SQLite backup, issue another test invoice, stop the server, restore, and verify the expected earlier state. Check the printed recovery backup contains the state from immediately before restoration.
9. Stop the server while a browser form is open. Try saving; confirm an error appears and the form remains open. Restart and reload to inspect the actual saved state before retrying.
10. Disconnect the network and confirm local billing and uploaded-logo printing still work. Review the final print/PDF manually; automated browser tests do not certify printer output.

## Optional wedding presentation

The [Wedding Invitation guide](wedding-invoice.md) covers template selection, RSVP contacts, itemisation, A4 printing and schema-v1 compatibility. Switching templates does not write records or change taxes.
