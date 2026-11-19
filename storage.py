"""Disk-backed bill book. No third-party dependencies; no tax recalculation."""
from contextlib import contextmanager, closing
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
import fcntl
import hashlib
import json
import math
import os
import re
import sqlite3
import uuid

ROOT = Path(__file__).resolve().parent
DEFAULTS = dict(id=1, book_name='', address='', gstin='', currency='₹', range_from=1,
                range_to=50, default_gst_rate=18.0, default_gst_type='cgst_sgst',
                legal_line='Subject to local District Jurisdiction only', logo_url='', updated_at='')
BILL_FIELDS = ('number date due_date payee payee_gstin memo base_amount gst_rate gst_type '
               'cgst_amount sgst_amount igst_amount amount status issued_at paid_at void_at').split()
DETAILS_SCHEMA = '''CREATE TABLE invoice_details (
 number INTEGER PRIMARY KEY REFERENCES bills(number) ON DELETE CASCADE, content TEXT NOT NULL);'''
SCHEMA = '''
CREATE TABLE settings (
 id INTEGER PRIMARY KEY CHECK(id=1), book_name TEXT, address TEXT, gstin TEXT,
 currency TEXT, range_from INTEGER, range_to INTEGER, default_gst_rate REAL,
 default_gst_type TEXT, legal_line TEXT, logo_url TEXT, updated_at TEXT);
CREATE TABLE bills (
 number INTEGER PRIMARY KEY CHECK(number>0), date TEXT NOT NULL, due_date TEXT,
 payee TEXT NOT NULL, payee_gstin TEXT, memo TEXT, base_amount REAL NOT NULL,
 gst_rate REAL, gst_type TEXT, cgst_amount REAL, sgst_amount REAL, igst_amount REAL,
 amount REAL NOT NULL, status TEXT CHECK(status IN ('issued','paid','void')) NOT NULL,
 issued_at TEXT NOT NULL, paid_at TEXT, void_at TEXT);
CREATE TABLE migrations (digest TEXT PRIMARY KEY, source TEXT NOT NULL, created_at TEXT NOT NULL);
'''
SCHEMA += DETAILS_SCHEMA + '\nPRAGMA user_version=2;'


def now():
    return datetime.now(timezone.utc).isoformat()


def outside_repo(path):
    path = Path(path).expanduser().resolve()
    if path == ROOT or ROOT in path.parents:
        raise ValueError('Customer data and backups must be outside the repository')
    return path


def data_directory():
    return outside_repo(Path(os.environ.get('XDG_DATA_HOME', Path.home() / '.local/share')) / 'cheque-style-bill-book')


def integer(value, name):
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= 9007199254740991:
        raise ValueError(f'{name} must be a positive safe integer')
    return value


def numeric(value, name):
    try:
        valid = not isinstance(value, bool) and isinstance(value, (int, float)) and math.isfinite(value) and value >= 0
    except OverflowError:
        valid = False
    if not valid:
        raise ValueError(f'Invalid {name}')
    return value


def settings_record(raw):
    if not isinstance(raw, dict) or set(raw) - set(DEFAULTS):
        raise ValueError('Invalid settings fields')
    result = {**DEFAULTS, **raw, 'id': 1}
    for k in ('range_from', 'range_to'):
        integer(result[k], k)
    if result['range_from'] > result['range_to']:
        raise ValueError('Invalid invoice number range')
    numeric(result['default_gst_rate'], 'default_gst_rate')
    if result['default_gst_type'] not in ('none', 'cgst_sgst', 'igst'):
        raise ValueError('Invalid GST type')
    for k in set(DEFAULTS) - {'id', 'range_from', 'range_to', 'default_gst_rate'}:
        if not isinstance(result[k], str):
            raise ValueError(f'Invalid {k}')
    return result


def invoice_details(raw, taxable):
    """Optional presentation fields. Itemisation describes the existing taxable amount."""
    fields = ('recipient_address', 'seller_mobile', 'seller_email', 'seller_website')
    if not isinstance(raw, dict) or set(raw) - {*fields, 'items'}:
        raise ValueError('Invalid invoice detail fields')
    result = {key: raw.get(key, '') for key in fields}
    for key, value in result.items():
        if not isinstance(value, str):
            raise ValueError(f'Invalid {key}')
    items = raw.get('items', [])
    if not isinstance(items, list) or len(items) > 2000:
        raise ValueError('Expected up to 2000 line items')
    result['items'] = []
    for item in items:
        if not isinstance(item, dict) or set(item) != {'description', 'taxable_value'}:
            raise ValueError('Each item requires a description and taxable value')
        if not isinstance(item['description'], str) or not item['description'].strip():
            raise ValueError('Item description is required')
        numeric(item['taxable_value'], 'item taxable value')
        result['items'].append(dict(item))
    if items and sum((Decimal(str(item['taxable_value'])) for item in items), Decimal(0)) != Decimal(str(taxable)):
        raise ValueError('Item taxable values must add up exactly to the saved invoice taxable value')
    return result


def bill_record(raw):
    if not isinstance(raw, dict) or set(raw) - {*BILL_FIELDS, 'details'}:
        raise ValueError('Invalid invoice fields')
    r = dict(raw)
    integer(r.get('number'), 'number')
    for key in ('date', 'payee', 'issued_at'):
        if not isinstance(r.get(key), str) or not r[key].strip():
            raise ValueError(f'Invoice requires {key}')
    for key in ('date', 'due_date'):
        if key == 'due_date' and not r.get(key):
            r[key] = r['date']
        try:
            datetime.strptime(r[key], '%Y-%m-%d')
        except (ValueError, TypeError):
            raise ValueError(f'Invalid {key}') from None
    for key in ('base_amount', 'amount'):
        numeric(r.get(key), key)
    for key in ('gst_rate', 'cgst_amount', 'sgst_amount', 'igst_amount'):
        numeric(r.setdefault(key, 0), key)
    r.setdefault('gst_type', 'none')
    r.setdefault('status', 'issued')
    if r['gst_type'] not in ('none', 'cgst_sgst', 'igst') or r['status'] not in ('issued', 'paid', 'void'):
        raise ValueError('Invalid GST type or invoice status')
    for key in ('payee_gstin', 'memo'):
        r.setdefault(key, '')
        if not isinstance(r[key], str):
            raise ValueError(f'Invalid {key}')
    for key in ('paid_at', 'void_at'):
        r.setdefault(key, None)
        if r[key] is not None and not isinstance(r[key], str):
            raise ValueError(f'Invalid {key}')
    if 'details' in r:
        r['details'] = invoice_details(r['details'], r['base_amount'])
    return r


def normalize_import(payload):
    """Accept current exports/localStorage and legacy billbook.v1, without modifying source."""
    if not isinstance(payload, dict) or 'bills' not in payload:
        raise ValueError('Import requires a bills collection')
    raw_settings = payload.get('settings')
    if isinstance(raw_settings, list):
        if len(raw_settings) != 1:
            raise ValueError('Expected exactly one settings record')
        raw_settings = raw_settings[0]
    raw_bills = payload['bills']
    legacy = isinstance(raw_settings, dict) and 'bookName' in raw_settings
    if legacy:
        s = raw_settings
        raw_settings = dict(book_name=s.get('bookName', ''), address=s.get('address', ''),
                            currency=s.get('currency', '₹'), range_from=s.get('from', 1), range_to=s.get('to', 50))
    if isinstance(raw_bills, dict):
        raw_bills = list(raw_bills.values())
    if not isinstance(raw_bills, list):
        raise ValueError('Invalid bills collection')
    bills = []
    for raw in raw_bills:
        if legacy:
            raw = dict(number=int(raw['number']), date=raw['date'], payee=raw['payee'],
                       memo=raw.get('memo', ''), base_amount=float(raw['amount']), amount=float(raw['amount']),
                       status=raw.get('status', 'issued'), issued_at=raw.get('issuedAt') or now(),
                       paid_at=raw.get('paidAt'), void_at=raw.get('voidAt'))
        bills.append(bill_record(raw))
    if len({b['number'] for b in bills}) != len(bills):
        raise ValueError('Duplicate invoice numbers in import')
    return settings_record(raw_settings) if raw_settings is not None else None, bills


def parse_sql_dump(text):
    """Parse literal INSERT data from app exports; never execute uploaded SQL."""
    statements, buffer = [], ''
    # complete_statement understands quoted semicolons and multiline strings.
    for char in text:
        buffer += char
        if char == ';' and sqlite3.complete_statement(buffer):
            statements.append(buffer.strip())
            buffer = ''
    if re.sub(r'--[^\n]*', '', buffer).strip():
        raise ValueError('Incomplete SQL script')
    payload = {'bills': []}
    for statement in statements:
        # Remove leading comments only (comments inside values must survive).
        statement = re.sub(r'\A(?:\s|--[^\n]*(?:\n|$))*', '', statement)
        if not statement:
            continue
        if re.fullmatch(r'(?:BEGIN TRANSACTION|COMMIT|PRAGMA foreign_keys\s*=\s*ON);', statement, re.I):
            continue
        if re.match(r'CREATE TABLE (?:IF NOT EXISTS )?(?:settings|bills)\s*\(', statement, re.I):
            continue  # Schema is never taken from an imported script.
        match = re.fullmatch(r'INSERT(?: OR REPLACE)? INTO (settings|bills)\s*\(([^)]+)\)\s*VALUES\s*\((.*)\)\s*;', statement, re.I | re.S)
        if not match:
            raise ValueError('Only application SQL dump data is supported')
        table, columns, values = match.groups()
        columns = [c.strip() for c in columns.split(',')]
        allowed = set(DEFAULTS if table.lower() == 'settings' else [*BILL_FIELDS, 'details'])
        if len(set(columns)) != len(columns) or set(columns) - allowed:
            raise ValueError('Unknown or duplicate SQL columns')
        tokens, pos = [], 0
        pattern = re.compile(r"\s*('(?:[^']|'')*'|NULL|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\s*(,|$)", re.I | re.S)
        while pos < len(values):
            token = pattern.match(values, pos)
            if not token:
                raise ValueError('SQL imports must contain literal values only')
            value, separator = token.groups()
            tokens.append(value[1:-1].replace("''", "'") if value.startswith("'") else
                          None if value.upper() == 'NULL' else json.loads(value))
            pos = token.end()
            if not separator:
                break
        if len(tokens) != len(columns) or pos != len(values):
            raise ValueError('Invalid SQL values')
        record = dict(zip(columns, tokens))
        if 'details' in record:
            record['details'] = json.loads(record['details'])
        if table.lower() == 'settings':
            if 'settings' in payload:
                raise ValueError('Duplicate settings')
            payload['settings'] = record
        else:
            payload['bills'].append(record)
    return payload


class Store:
    def __init__(self, directory=None):
        self.directory = outside_repo(directory) if directory is not None else data_directory()
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(self.directory, 0o700)
        self.path = self.directory / 'billbook.sqlite3'
        if self.path.is_symlink():
            raise ValueError('Database must not be a symbolic link')
        self.lock = open(self.directory / 'application.lock', 'a')
        try:
            fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            self.lock.close()
            raise ValueError('Application is running; stop it before backup/restore commands') from None
        try:
            exists = self.path.exists()
            with self.connection() as con:
                if not exists:
                    con.executescript(SCHEMA)
                    self._settings(con, {**DEFAULTS, 'updated_at': now()})
            os.chmod(self.path, 0o600)
            self.validate(self.path)
            with closing(sqlite3.connect(self.path)) as check:
                version = check.execute('PRAGMA user_version').fetchone()[0]
            if version == 1:
                recovery = self.backup()
                with self.connection() as con:
                    con.execute(DETAILS_SCHEMA)
                    con.execute('PRAGMA user_version=2')
                print('Schema upgraded; verified recovery backup:', recovery, flush=True)
            self.validate(self.path)
        except Exception:
            self.close()
            raise

    def close(self):
        self.lock.close()

    @contextmanager
    def connection(self):
        con = sqlite3.connect(self.path, timeout=15)
        con.row_factory = sqlite3.Row
        con.execute('PRAGMA synchronous=FULL')
        con.execute('PRAGMA foreign_keys=ON')
        try:
            con.execute('BEGIN IMMEDIATE')
            yield con
            con.commit()
        except Exception:
            con.rollback()
            raise
        finally:
            con.close()

    @staticmethod
    def _settings(con, settings):
        con.execute('INSERT INTO settings (' + ','.join(DEFAULTS) + ') VALUES (' + ','.join('?' for _ in DEFAULTS) + ') ON CONFLICT(id) DO UPDATE SET ' + ','.join(k + '=excluded.' + k for k in DEFAULTS if k != 'id'), [settings[k] for k in DEFAULTS])

    @staticmethod
    def _insert(con, bill):
        con.execute('INSERT INTO bills (' + ','.join(BILL_FIELDS) + ') VALUES (' + ','.join('?' for _ in BILL_FIELDS) + ')', [bill[k] for k in BILL_FIELDS])
        if 'details' in bill:
            con.execute('INSERT INTO invoice_details VALUES (?,?)', (bill['number'], json.dumps(bill['details'], ensure_ascii=False)))

    @staticmethod
    def _snapshot(con):
        result = dict(settings=dict(con.execute('SELECT * FROM settings WHERE id=1').fetchone()),
                      bills=[dict(r) for r in con.execute('SELECT * FROM bills ORDER BY number')])
        if con.execute('PRAGMA user_version').fetchone()[0] == 2:
            details = {r['number']: json.loads(r['content']) for r in con.execute('SELECT * FROM invoice_details')}
            for bill in result['bills']:
                if bill['number'] in details:
                    bill['details'] = details[bill['number']]
        return result

    def snapshot(self):
        with self.connection() as con:
            return self._snapshot(con)

    def save_settings(self, raw):
        s = settings_record(raw)
        s['updated_at'] = now()
        with self.connection() as con:
            first = con.execute('SELECT MIN(number) FROM bills').fetchone()[0]
            if first is not None and s['range_from'] > first:
                raise ValueError('Range starts above an existing invoice')
            self._settings(con, s)
        return s

    def issue(self, raw):
        with self.connection() as con:
            s = dict(con.execute('SELECT * FROM settings').fetchone())
            used = {r[0] for r in con.execute('SELECT number FROM bills WHERE number BETWEEN ? AND ?', (s['range_from'], s['range_to']))}
            n = s['range_from']
            while n in used:
                n += 1
            if n > s['range_to']:
                raise ValueError('Invoice book exhausted')
            if raw.get('number') != n:
                raise ValueError('Invoice number changed; reload and review before issuing')
            if raw.get('status', 'issued') != 'issued':
                raise ValueError('New invoices must be issued')
            bill = bill_record({**raw, 'number': n, 'issued_at': now(), 'paid_at': None, 'void_at': None})
            self._insert(con, bill)
        return bill

    def update_status(self, number, status, expected_status):
        if status not in ('paid', 'void'):
            raise ValueError('Unsupported status transition')
        integer(number, 'number')
        with self.connection() as con:
            row = con.execute('SELECT * FROM bills WHERE number=?', (number,)).fetchone()
            if row is None or row['status'] != expected_status or row['status'] == 'void' or (status == 'paid' and row['status'] != 'issued'):
                raise ValueError('Invoice changed or transition forbidden; reload')
            key = 'paid_at' if status == 'paid' else 'void_at'
            con.execute(f'UPDATE bills SET status=?, {key}=? WHERE number=?', (status, now(), number))
            result = dict(con.execute('SELECT * FROM bills WHERE number=?', (number,)).fetchone())
        return result

    def save_invoice_details(self, number, raw, expected):
        integer(number, 'number')
        with self.connection() as con:
            bill = con.execute('SELECT base_amount FROM bills WHERE number=?', (number,)).fetchone()
            if bill is None:
                raise ValueError('Invoice not found')
            previous = con.execute('SELECT content FROM invoice_details WHERE number=?', (number,)).fetchone()
            previous = json.loads(previous['content']) if previous else None
            if previous != expected:
                raise ValueError('Invoice details changed in another tab; reload before saving')
            details = invoice_details(raw, bill['base_amount'])
            con.execute('INSERT INTO invoice_details VALUES (?,?) ON CONFLICT(number) DO UPDATE SET content=excluded.content',
                        (number, json.dumps(details, ensure_ascii=False)))
        return details

    def import_data(self, payload, source='file', raw_source=None):
        if not isinstance(source, str) or len(source) > 128 or (raw_source is not None and not isinstance(raw_source, str)):
            raise ValueError('Invalid import source metadata')
        settings, bills = normalize_import(payload)
        encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True).encode()
        digest = hashlib.sha256(encoded).hexdigest()
        # Preserve source outside the repository before any import. Never delete browser keys.
        self.write_new(self.directory / ('migration-' + uuid.uuid4().hex + '.json'),
                       json.dumps({'source': source, 'payload': payload, 'raw_source': raw_source}, ensure_ascii=False).encode())
        with self.connection() as con:
            if con.execute('SELECT 1 FROM migrations WHERE digest=?', (digest,)).fetchone():
                raise ValueError('This dataset was already imported')
            current = self._snapshot(con)
            if settings is not None:
                meaningful = {k: v for k, v in current['settings'].items() if k not in ('updated_at', 'id')}
                default = {k: v for k, v in DEFAULTS.items() if k not in ('updated_at', 'id')}
                incoming = {k: settings[k] for k in meaningful}
                if meaningful != default and meaningful != incoming:
                    raise ValueError('Imported settings conflict with existing settings')
                if current['bills'] and meaningful != incoming:
                    raise ValueError('Cannot replace settings on an existing bill book')
                self._settings(con, settings)
            for bill in bills:
                self._insert(con, bill)  # Duplicate numbers roll back the entire import.
            con.execute('INSERT INTO migrations VALUES (?,?,?)', (digest, source, now()))
        return len(bills)

    def reset(self):
        recovery = self.backup()
        with self.connection() as con:
            con.execute('DELETE FROM bills')
            con.execute('DELETE FROM migrations')
            self._settings(con, {**DEFAULTS, 'updated_at': now()})
        return str(recovery)

    @staticmethod
    def sync_directory(directory):
        descriptor = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)

    @staticmethod
    def write_new(path, content):
        with open(path, 'xb') as file:
            os.chmod(path, 0o600)
            file.write(content)
            file.flush()
            os.fsync(file.fileno())
        Store.sync_directory(path.parent)

    @staticmethod
    def validate(path):
        uri = Path(path).resolve().as_uri() + '?mode=ro'
        with closing(sqlite3.connect(uri, uri=True)) as con:
            con.row_factory = sqlite3.Row
            if con.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                raise ValueError('Database integrity check failed')
            version = con.execute('PRAGMA user_version').fetchone()[0]
            if version not in (1, 2):
                raise ValueError('Unsupported backup version')
            objects = {(r['type'], r['name']) for r in con.execute("SELECT type,name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'")}
            expected_objects = {('table', 'settings'), ('table', 'bills'), ('table', 'migrations')}
            if version == 2:
                expected_objects.add(('table', 'invoice_details'))
            if objects != expected_objects:
                raise ValueError('Unexpected database objects')
            tables = [('settings', list(DEFAULTS)), ('bills', BILL_FIELDS), ('migrations', ['digest', 'source', 'created_at'])]
            if version == 2:
                tables.append(('invoice_details', ['number', 'content']))
            for table, fields in tables:
                if [r['name'] for r in con.execute(f'PRAGMA table_info({table})')] != fields:
                    raise ValueError('Invalid backup schema')
            settings = con.execute('SELECT * FROM settings').fetchall()
            if len(settings) != 1 or settings[0]['id'] != 1:
                raise ValueError('Invalid settings record')
            settings_record(dict(settings[0]))
            for row in con.execute('SELECT * FROM bills'):
                bill_record(dict(row))
            if con.execute('PRAGMA foreign_key_check').fetchone():
                raise ValueError('Orphaned invoice details')
            result = Store._snapshot(con)
            for bill in result['bills']:
                bill_record(bill)
            if version == 2:
                numbers = {bill['number'] for bill in result['bills']}
                for row in con.execute('SELECT number FROM invoice_details'):
                    if row['number'] not in numbers:
                        raise ValueError('Orphaned invoice details')
            return result

    def backup(self, destination=None):
        destination = outside_repo(destination) if destination else self.directory / ('backup-' + uuid.uuid4().hex + '.sqlite3')
        if destination.exists():
            raise ValueError('Backup destination already exists')
        # Exclusive creation prevents overwriting an unrelated file.
        self.write_new(destination, b'')
        try:
            with closing(sqlite3.connect(self.path)) as source, closing(sqlite3.connect(destination)) as target:
                source.backup(target)
            self.validate(destination)
            with open(destination, 'rb') as file:
                os.fsync(file.fileno())
            self.sync_directory(destination.parent)
        except Exception:
            destination.unlink(missing_ok=True)
            raise
        return destination

    def restore(self, replacement, confirm=False):
        if not confirm:
            raise ValueError('Restore requires --confirm-restore')
        replacement = outside_repo(replacement)
        if replacement == self.path:
            raise ValueError('Cannot restore from the live database')
        # Snapshot input into a private staging file before validation (no TOCTOU activation).
        staged = self.directory / ('restore-' + uuid.uuid4().hex + '.sqlite3')
        try:
            self.write_new(staged, replacement.read_bytes())
            snapshot = self.validate(staged)
            with closing(sqlite3.connect(staged)) as source:
                migrations = source.execute('SELECT digest,source,created_at FROM migrations').fetchall()
            recovery = self.backup()  # Verified before touching live records.
            with self.connection() as con:
                con.execute('DELETE FROM bills')
                con.execute('DELETE FROM migrations')
                self._settings(con, snapshot['settings'])
                for bill in snapshot['bills']:
                    self._insert(con, bill_record(bill))
                con.executemany('INSERT INTO migrations VALUES (?,?,?)', migrations)
                if con.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                    raise ValueError('Restored database integrity check failed')
            return recovery
        finally:
            staged.unlink(missing_ok=True)
