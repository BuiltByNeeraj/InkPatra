import http.client
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest

from server import LocalServer
from storage import Store, ROOT
from test_storage import invoice


class SecurityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = Store(self.temp.name)
        self.server = LocalServer(0, self.store)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.store.close()
        self.temp.cleanup()

    def request(self, method='GET', path='/api/state', headers=None, data=None):
        con = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=5)
        con.request(method, path, body=json.dumps(data) if data is not None else None, headers=headers or {})
        response = con.getresponse()
        body = response.read()
        result = response.status, dict(response.getheaders()), body
        con.close()
        return result

    def headers(self):
        return {'Origin': self.server.origin, 'X-CSRF-Token': self.server.csrf_token, 'Content-Type': 'application/json'}

    def test_bound_exclusively_to_loopback(self):
        self.assertEqual(self.server.server_address[0], '127.0.0.1')

    def test_host_validation_and_dns_rebinding(self):
        for host in ['evil.example', f'localhost:{self.server.server_port}', '127.0.0.1', f'127.0.0.1:{self.server.server_port}.evil.example']:
            self.assertEqual(self.request(headers={'Host': host})[0], 403)

    def test_origin_and_fetch_site_blocked_on_reads(self):
        for headers in [{'Origin': 'https://evil.example'}, {'Origin': 'null'}, {'Sec-Fetch-Site': 'cross-site'}, {'Sec-Fetch-Site': 'same-site'}]:
            self.assertEqual(self.request(headers=headers)[0], 403)

    def test_csrf_and_origin_required_for_writes(self):
        valid = self.headers()
        for headers in [{}, {k: v for k,v in valid.items() if k != 'Origin'}, {k:v for k,v in valid.items() if k != 'X-CSRF-Token'}, {**valid, 'X-CSRF-Token': 'wrong'}, {**valid, 'Origin': 'http://evil.example'}]:
            self.assertEqual(self.request('POST', '/api/bills/issue', headers, invoice())[0], 403)
        self.assertEqual(self.store.snapshot()['bills'], [])

    def test_duplicate_security_headers_rejected(self):
        for name, value in [('Host', self.server.authority), ('Origin', self.server.origin), ('X-CSRF-Token', self.server.csrf_token)]:
            con = http.client.HTTPConnection('127.0.0.1', self.server.server_port)
            con.putrequest('POST', '/api/reset', skip_host=True)
            for key, val in {'Host': self.server.authority, **self.headers(), 'Content-Length': '2'}.items():
                con.putheader(key, val)
            con.putheader(name, value)
            con.endheaders(b'{}')
            response = con.getresponse()
            self.assertEqual(response.status, 403)
            response.read(); con.close()

    def test_no_cors_and_no_arbitrary_sql_api(self):
        status, headers, _ = self.request()
        self.assertEqual(status, 200)
        self.assertNotIn('Access-Control-Allow-Origin', headers)
        self.assertEqual(headers['Cache-Control'], 'no-store')
        self.assertIn("frame-ancestors 'none'", headers['Content-Security-Policy'])
        self.assertEqual(self.request('POST', '/api/sql', self.headers(), {'query': 'DELETE FROM bills'})[0], 404)
        self.assertEqual(self.request('OPTIONS')[0], 405)

    def test_only_allowlisted_assets_served(self):
        for path in ['/.git/config', '/server.py', '/storage.py', '/README.md', '/../storage.py', '/billbook.sqlite3']:
            self.assertEqual(self.request(path=path)[0], 404)
        self.assertEqual(self.request(path='/app.js')[0], 200)

    def test_content_type_body_validation_and_explicit_import(self):
        self.assertEqual(self.request('POST', '/api/bills/issue', {**self.headers(), 'Content-Type': 'text/plain'}, invoice())[0], 415)
        self.assertEqual(self.request('POST', '/api/import', self.headers(), {'payload': {'bills': [invoice()]}})[0], 400)
        self.assertEqual(self.request('POST', '/api/reset', self.headers(), {})[0], 400)
        self.assertEqual(self.request('POST', '/api/bills/issue', self.headers(), {'amount': 1})[0], 400)

    def test_api_commit_then_load_status_and_atomic_import(self):
        status, _, body = self.request('POST', '/api/bills/issue', self.headers(), invoice())
        self.assertEqual(status, 200)
        result = json.loads(body)
        with self.store.connection() as con:
            self.assertEqual(con.execute('SELECT COUNT(*) FROM bills').fetchone()[0], 1)
        self.assertEqual(result['state']['bills'][0]['amount'], 590)
        data = {'number': 1, 'status': 'void', 'expected_status': 'issued'}
        self.assertEqual(self.request('POST', '/api/bills/status', self.headers(), data)[0], 200)
        data = {'payload': {'bills': [invoice(2), invoice()]}, 'confirm_import': True}
        self.assertEqual(self.request('POST', '/api/import', self.headers(), data)[0], 409)
        self.assertEqual(len(json.loads(self.request()[2])['bills']), 1)

    def test_invalid_numeric_data_and_json_are_rejected(self):
        for amount in [float('nan'), float('inf'), 10 ** 500, -1]:
            data = invoice(); data['amount'] = amount
            self.assertEqual(self.request('POST', '/api/bills/issue', self.headers(), data)[0], 400)
        self.assertEqual(self.store.snapshot()['bills'], [])

    def test_failed_save_returns_error_and_preserves_database(self):
        from unittest.mock import patch
        original = self.store._insert
        def fail(con, bill):
            original(con, bill)
            raise OSError('simulated failure')
        with patch.object(self.store, '_insert', side_effect=fail):
            status, _, body = self.request('POST', '/api/bills/issue', self.headers(), invoice())
        self.assertEqual(status, 500)
        self.assertNotIn('state', json.loads(body))
        self.assertEqual(self.store.snapshot()['bills'], [])


class ServerRestartTests(unittest.TestCase):
    def test_real_server_process_restart_and_committed_data(self):
        with tempfile.TemporaryDirectory() as temp:
            env = {**os.environ, 'XDG_DATA_HOME': temp, 'PYTHONDONTWRITEBYTECODE': '1'}
            def start():
                process = subprocess.Popen([sys.executable, '-u', 'server.py', '0'], cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                line = process.stdout.readline()
                self.assertTrue(line.startswith('Bill Book:'), line + process.stderr.read() if process.poll() is not None else line)
                port = int(line.strip().rsplit(':', 1)[1])
                return process, port
            def request(port, method='GET', data=None, token=None):
                con = http.client.HTTPConnection('127.0.0.1', port, timeout=5)
                headers = {'Content-Type': 'application/json', 'Origin': f'http://127.0.0.1:{port}', 'X-CSRF-Token': token} if token else {}
                con.request(method, '/api/bills/issue' if data else '/api/state', json.dumps(data) if data else None, headers)
                response = con.getresponse(); result = json.loads(response.read()); con.close()
                return response.status, result
            process, port = start()
            try:
                _, state = request(port)
                self.assertEqual(request(port, 'POST', invoice(), state['csrf_token'])[0], 200)
            finally:
                process.kill(); process.communicate(timeout=5)
            process, port = start()
            try:
                _, restarted = request(port)
                self.assertEqual(restarted['bills'][0]['payee'], invoice()['payee'])
                self.assertNotEqual(restarted['csrf_token'], state['csrf_token'])
                self.assertEqual(request(port, 'POST', invoice(2), state['csrf_token'])[0], 403)
            finally:
                process.terminate(); process.communicate(timeout=5)
