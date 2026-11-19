from contextlib import closing
import concurrent.futures
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from storage import Store, DEFAULTS, normalize_import, parse_sql_dump, ROOT


def invoice(number=1, **changes):
    return dict(number=number, date='2026-11-19', due_date='2026-12-01', payee="O'Brien; Trading", memo='line one\nline two',
                base_amount=500, gst_rate=18, gst_type='cgst_sgst', cgst_amount=45, sgst_amount=45,
                igst_amount=0, amount=590, status='issued', issued_at='2026-11-19T10:00:00Z', **changes)


class StorageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = Store(Path(self.temp.name) / 'data')

    def tearDown(self):
        self.store.close()
        self.temp.cleanup()

    def test_disk_restart_preserves_invoice_settings_and_status(self):
        self.store.save_settings({**DEFAULTS, 'book_name': 'Test business'})
        self.store.issue(invoice())
        self.store.update_status(1, 'paid', 'issued')
        before = self.store.snapshot()
        directory = self.store.directory
        self.store.close()
        self.store = Store(directory)
        self.assertEqual(before, self.store.snapshot())
        self.assertEqual(self.store.path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(directory.stat().st_mode & 0o777, 0o700)

    def test_process_restart(self):
        directory = self.store.directory
        self.store.issue(invoice())
        self.store.close()
        result = subprocess.run([sys.executable, '-c', 'from storage import Store; import sys; s=Store(sys.argv[1]); print(s.snapshot()["bills"][0]["amount"]); s.close()', str(directory)], cwd=ROOT, capture_output=True, text=True, check=True)
        self.assertEqual(result.stdout.strip(), '590.0')
        self.store = Store(directory)

    def test_duplicate_issue_never_overwrites(self):
        self.store.issue(invoice())
        before = self.store.snapshot()
        with self.assertRaises(ValueError):
            self.store.issue(invoice())
        self.assertEqual(before, self.store.snapshot())

    def test_void_numbers_not_reused_and_transitions(self):
        self.store.issue(invoice())
        self.store.update_status(1, 'void', 'issued')
        self.assertEqual(self.store.issue(invoice(2))['number'], 2)
        with self.assertRaises(ValueError):
            self.store.update_status(1, 'paid', 'void')
        self.assertEqual(self.store.snapshot()['bills'][0]['status'], 'void')

    def test_stale_status_rejected(self):
        self.store.issue(invoice())
        self.store.update_status(1, 'paid', 'issued')
        with self.assertRaises(ValueError):
            self.store.update_status(1, 'void', 'issued')

    def test_concurrent_number_allocation(self):
        def issue():
            try:
                return self.store.issue(invoice())['number']
            except ValueError:
                return 'conflict'
        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
            results = list(pool.map(lambda _: issue(), range(6)))
        self.assertEqual(results.count(1), 1)
        self.assertEqual(len(self.store.snapshot()['bills']), 1)

    def test_range_exhaustion_and_custom_start(self):
        self.store.save_settings({**DEFAULTS, 'range_from': 100, 'range_to': 100})
        self.store.issue(invoice(100))
        with self.assertRaises(ValueError):
            self.store.issue(invoice(101))
        with self.assertRaises(ValueError):
            self.store.save_settings({**DEFAULTS, 'range_from': 101, 'range_to': 110})

    def test_current_localstorage_migration_source_preserved(self):
        payload = {'settings': [dict(DEFAULTS)], 'bills': [invoice()]}
        original = json.dumps(payload)
        self.assertEqual(self.store.import_data(payload, 'billbook.sqlite.memory', original), 1)
        self.assertEqual(json.dumps(payload), original)
        preserved = json.loads(next(self.store.directory.glob('migration-*.json')).read_text())
        self.assertEqual(preserved['raw_source'], original)
        self.assertEqual(self.store.snapshot()['bills'][0]['memo'], 'line one\nline two')
        with self.assertRaises(ValueError):
            self.store.import_data(payload)

    def test_legacy_migration_and_zero_gst(self):
        payload = {'settings': {'bookName': 'Legacy', 'from': 10, 'to': 20}, 'bills': {'10': {'number': 10, 'date': '2026-01-01', 'payee': 'Legacy customer', 'amount': 12.34, 'status': 'paid', 'paidAt': 'original'}}}
        self.store.import_data(payload, 'billbook.v1')
        data = self.store.snapshot()
        self.assertEqual(data['settings']['book_name'], 'Legacy')
        self.assertEqual(data['bills'][0]['paid_at'], 'original')
        self.assertEqual(data['bills'][0]['gst_rate'], 0)

    def test_conflict_rolls_back_entire_import(self):
        self.store.issue(invoice())
        before = self.store.snapshot()
        with self.assertRaises(sqlite3.IntegrityError):
            self.store.import_data({'bills': [invoice(2), invoice()]})
        self.assertEqual(before, self.store.snapshot())

    def test_conflicting_settings_and_duplicate_input_rejected(self):
        self.store.save_settings({**DEFAULTS, 'book_name': 'Keep this'})
        for payload in [{'settings': DEFAULTS, 'bills': []}, {'bills': [invoice(), invoice()]}]:
            with self.assertRaises(ValueError):
                self.store.import_data(payload)
        self.assertEqual(self.store.snapshot()['settings']['book_name'], 'Keep this')

    def test_json_roundtrip_preserves_tax_values(self):
        self.store.issue(invoice())
        original = self.store.snapshot()
        self.store.reset()
        self.store.import_data(json.loads(json.dumps(original)))
        self.assertEqual(self.store.snapshot(), original)

    def test_sql_literals_multiline_escaped_quote(self):
        sql = """-- exported data
CREATE TABLE IF NOT EXISTS bills (ignored);
INSERT INTO bills (number,date,payee,memo,base_amount,amount,issued_at)
VALUES (1,'2026-11-19','O''Brien; Trading','line one
line two',500,590,'original');
"""
        self.store.import_data(parse_sql_dump(sql))
        row = self.store.snapshot()['bills'][0]
        self.assertEqual(row['payee'], "O'Brien; Trading")
        self.assertEqual(row['memo'], 'line one\nline two')

    def test_sql_never_executes_commands(self):
        for sql in ["ATTACH DATABASE '/tmp/no' AS x;", 'DELETE FROM bills;', "INSERT INTO bills (number) VALUES (abs(1));", 'PRAGMA writable_schema=ON;']:
            with self.assertRaises(ValueError):
                parse_sql_dump(sql)

    def test_validated_backup_restore_and_recovery(self):
        self.store.issue(invoice())
        original = self.store.snapshot()
        backup = self.store.backup()
        self.assertEqual(Store.validate(backup), original)
        self.store.issue(invoice(2))
        before = self.store.snapshot()
        recovery = self.store.restore(backup, confirm=True)
        self.assertEqual(self.store.snapshot(), original)
        self.assertEqual(Store.validate(recovery), before)
        with self.assertRaises(ValueError):
            self.store.backup(backup)

    def test_restore_requires_confirmation(self):
        backup = self.store.backup()
        with self.assertRaises(ValueError):
            self.store.restore(backup)

    def test_corrupt_restore_preserves_live_database(self):
        self.store.issue(invoice())
        original = self.store.path.read_bytes()
        bad = Path(self.temp.name) / 'corrupt.sqlite3'
        bad.write_bytes(b'not a sqlite database')
        with self.assertRaises(sqlite3.DatabaseError):
            self.store.restore(bad, confirm=True)
        self.assertEqual(original, self.store.path.read_bytes())

    def test_unexpected_schema_restore_rejected(self):
        backup = self.store.backup()
        with closing(sqlite3.connect(backup)) as con:
            con.execute('CREATE TABLE unexpected (x)')
            con.commit()
        with self.assertRaises(ValueError):
            self.store.restore(backup, confirm=True)

    def test_failed_recovery_backup_prevents_restore(self):
        backup = self.store.backup()
        self.store.issue(invoice())
        before = self.store.snapshot()
        with patch.object(self.store, 'backup', side_effect=OSError('disk full')):
            with self.assertRaises(OSError):
                self.store.restore(backup, confirm=True)
        self.assertEqual(before, self.store.snapshot())

    def test_failed_restore_transaction_rolls_back(self):
        self.store.issue(invoice())
        backup = self.store.backup()
        self.store.issue(invoice(2))
        before = self.store.snapshot()
        with patch.object(self.store, '_insert', side_effect=sqlite3.OperationalError('disk full')):
            with self.assertRaises(sqlite3.OperationalError):
                self.store.restore(backup, confirm=True)
        self.assertEqual(before, self.store.snapshot())
        recoveries = [p for p in self.store.directory.glob('backup-*') if p != backup]
        self.assertEqual(Store.validate(recoveries[0]), before)

    def test_invalid_data_no_partial_save(self):
        for value in [float('nan'), float('inf'), -1]:
            bill = invoice(); bill['amount'] = value
            with self.assertRaises(ValueError):
                self.store.issue(bill)
        self.assertEqual(self.store.snapshot()['bills'], [])

    def test_app_lock_and_repository_data_guard(self):
        with self.assertRaises(ValueError):
            Store(self.store.directory)
        with self.assertRaises(ValueError):
            Store(ROOT / 'customer-data')
        with self.assertRaises(ValueError):
            self.store.backup(ROOT / 'backup.sqlite3')

    def test_xdg_data_directory(self):
        with patch.dict(os.environ, {'XDG_DATA_HOME': self.temp.name}):
            other = Store()
            try:
                self.assertEqual(other.path, Path(self.temp.name) / 'cheque-style-bill-book/billbook.sqlite3')
            finally:
                other.close()

    def test_failure_after_insert_rolls_back_and_does_not_consume_number(self):
        original = self.store._insert
        def fail(con, bill):
            original(con, bill)
            raise OSError('simulated disk failure')
        with patch.object(self.store, '_insert', side_effect=fail):
            with self.assertRaises(OSError):
                self.store.issue(invoice())
        self.assertEqual(self.store.snapshot()['bills'], [])
        self.assertEqual(self.store.issue(invoice())['number'], 1)

    def test_restore_rejects_invalid_invoice_values(self):
        backup = self.store.backup()
        with closing(sqlite3.connect(backup)) as con:
            con.execute("INSERT INTO bills(number,date,payee,base_amount,amount,status,issued_at) VALUES (1,'invalid','bad',1,1,'issued','original')")
            con.commit()
        before = self.store.snapshot()
        with self.assertRaises(ValueError):
            self.store.restore(backup, confirm=True)
        self.assertEqual(before, self.store.snapshot())

    def test_cli_backup_restore(self):
        env = {**os.environ, 'XDG_DATA_HOME': self.temp.name, 'PYTHONDONTWRITEBYTECODE': '1'}
        def run(*args):
            return subprocess.run([sys.executable, *args], cwd=ROOT, env=env, capture_output=True, text=True)
        # A separate data directory exercises the default CLI path resolution.
        create = run('-c', 'from storage import Store; s=Store(); s.save_settings({"book_name":"CLI backup"}); s.close()')
        self.assertEqual(create.returncode, 0, create.stderr)
        backup = str(Path(self.temp.name) / 'cli-backup.sqlite3')
        result = run('server.py', '--backup', backup)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(Path(backup).is_file())
        self.assertNotEqual(run('server.py', '--restore', backup).returncode, 0)
        result = run('server.py', '--restore', backup, '--confirm-restore')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('Verified recovery backup', result.stdout)
