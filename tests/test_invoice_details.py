from contextlib import closing
import json
from pathlib import Path
import sqlite3
from unittest.mock import patch

from storage import Store, SCHEMA, DETAILS_SCHEMA
import test_storage
from test_storage import invoice
import unittest


class InvoiceDetailsTests(unittest.TestCase):
    setUp = test_storage.StorageTests.setUp
    tearDown = test_storage.StorageTests.tearDown
    # Reuse fixtures only, without duplicating the inherited persistence suite.
    def details(self):
        return {'recipient_address':'Long address\nSecond line', 'seller_mobile':'9876543210',
                'seller_email':'hello@example.test', 'seller_website':'example.test',
                'items':[{'description':'Photography','taxable_value':300}, {'description':'Album','taxable_value':200}]}

    def test_details_save_preserves_financial_data_and_survives_restart(self):
        original = self.store.issue(invoice())
        self.store.save_invoice_details(1,self.details(),None)
        self.assertEqual({k:v for k,v in self.store.snapshot()['bills'][0].items() if k != 'details'},original)
        directory=self.store.directory
        self.store.close(); self.store=Store(directory)
        self.assertEqual(self.store.snapshot()['bills'][0]['details'],self.details())

    def test_itemisation_mismatch_and_stale_details_rejected(self):
        self.store.issue(invoice())
        invalid=self.details(); invalid['items'][0]['taxable_value']=301
        with self.assertRaises(ValueError):
            self.store.save_invoice_details(1,invalid,None)
        self.assertNotIn('details',self.store.snapshot()['bills'][0])
        self.store.save_invoice_details(1,self.details(),None)
        with self.assertRaises(ValueError):
            self.store.save_invoice_details(1,self.details(),None)

    def test_details_json_backup_restore_and_recovery_roundtrip(self):
        self.store.issue(invoice())
        self.store.save_invoice_details(1,self.details(),None)
        original=self.store.snapshot()
        backup=self.store.backup()
        self.store.reset()
        self.store.import_data(json.loads(json.dumps(original)))
        self.assertEqual(self.store.snapshot(),original)
        self.store.save_invoice_details(1,{**self.details(),'seller_mobile':'changed'},self.details())
        recovery=self.store.restore(backup,True)
        self.assertEqual(self.store.snapshot(),original)
        self.assertEqual(Store.validate(recovery)['bills'][0]['details']['seller_mobile'],'changed')

    def test_reset_removes_details_without_orphans(self):
        self.store.issue(invoice()); self.store.save_invoice_details(1,self.details(),None)
        self.store.reset()
        with self.store.connection() as con:
            self.assertEqual(con.execute('SELECT COUNT(*) FROM invoice_details').fetchone()[0],0)

    def legacy_database(self):
        directory=Path(self.temp.name)/'legacy'
        directory.mkdir()
        path=directory/'billbook.sqlite3'
        with closing(sqlite3.connect(path)) as con:
            con.executescript(SCHEMA.replace(DETAILS_SCHEMA,'').replace('user_version=2','user_version=1'))
            from storage import DEFAULTS, bill_record
            Store._settings(con,DEFAULTS)
            Store._insert(con,bill_record(invoice()))
            con.commit()
        return directory,path

    def test_schema_upgrade_creates_verified_v1_backup_and_preserves_rows(self):
        directory,path=self.legacy_database()
        before=Store.validate(path)
        upgraded=Store(directory)
        try:
            self.assertEqual(upgraded.snapshot(),before)
            backups=list(directory.glob('backup-*.sqlite3'))
            self.assertEqual(len(backups),1)
            self.assertEqual(Store.validate(backups[0]),before)
            with closing(sqlite3.connect(backups[0])) as con:
                self.assertEqual(con.execute('PRAGMA user_version').fetchone()[0],1)
            # Restoring a v1 backup preserves v2's optional metadata capability.
            upgraded.save_invoice_details(1,self.details(),None)
            recovery=upgraded.restore(backups[0],True)
            self.assertEqual(upgraded.snapshot(),before)
            self.assertEqual(Store.validate(recovery)['bills'][0]['details'],self.details())
        finally:
            upgraded.close()

    def test_upgrade_backup_failure_preserves_original(self):
        directory,path=self.legacy_database()
        before=path.read_bytes()
        with patch.object(Store,'backup',side_effect=OSError('disk full')):
            with self.assertRaises(OSError):
                Store(directory)
        self.assertEqual(path.read_bytes(),before)
        self.assertEqual(len(Store.validate(path)['bills']),1)

    def test_orphan_details_in_backup_are_rejected(self):
        backup=self.store.backup()
        with closing(sqlite3.connect(backup)) as con:
            con.execute('INSERT INTO invoice_details VALUES (?,?)',(999,json.dumps(self.details())))
            con.commit()
        with self.assertRaises(ValueError):
            Store.validate(backup)

    def test_invalid_details_import_rolls_back_all_rows(self):
        invalid=invoice(2); invalid['details']={**self.details(),'items':[{'description':'Wrong total','taxable_value':1}]}
        with self.assertRaises(ValueError):
            self.store.import_data({'bills':[invoice(),invalid]})
        self.assertEqual(self.store.snapshot()['bills'],[])

    def test_invalid_details_restore_preserves_existing_records(self):
        self.store.issue(invoice()); self.store.save_invoice_details(1,self.details(),None)
        before=self.store.snapshot()
        backup=self.store.backup()
        with closing(sqlite3.connect(backup)) as con:
            con.execute('UPDATE invoice_details SET content=?',(json.dumps({'items':[{'description':'Wrong sum','taxable_value':1}]}),))
            con.commit()
        with self.assertRaises(ValueError):
            self.store.restore(backup,True)
        self.assertEqual(self.store.snapshot(),before)
