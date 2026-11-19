#!/usr/bin/env python3
"""Linux local bill book. Start: python3 server.py [port]."""
import argparse
from http.server import HTTPServer, BaseHTTPRequestHandler
import json
from pathlib import Path
import secrets
import sqlite3
from urllib.parse import urlsplit

from storage import Store, parse_sql_dump

ROOT = Path(__file__).resolve().parent
ASSETS = {'/': ('index.html', 'text/html'), '/index.html': ('index.html', 'text/html'),
          '/app.js': ('app.js', 'text/javascript'), '/sqlite-engine.js': ('sqlite-engine.js', 'text/javascript'),
          '/styles.css': ('styles.css', 'text/css')}
MAX_BODY = 16 * 1024 * 1024


class LocalServer(HTTPServer):
    def __init__(self, port, store):
        self.store = store
        self.csrf_token = secrets.token_urlsafe(32)
        super().__init__(('127.0.0.1', port), Handler)
        self.authority = f'127.0.0.1:{self.server_port}'
        self.origin = f'http://{self.authority}'


class Handler(BaseHTTPRequestHandler):
    timeout = 10

    def log_message(self, format, *args):
        pass  # Do not log invoice contents or URLs supplied by clients.

    def respond(self, status, content, mime='application/json'):
        if mime == 'application/json':
            content = json.dumps(content, ensure_ascii=False, allow_nan=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', mime + ('; charset=utf-8' if mime.startswith('text/') else ''))
        self.send_header('Content-Length', str(len(content)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('Cross-Origin-Resource-Policy', 'same-origin')
        self.send_header('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
        # No Access-Control-Allow-Origin: only same-origin clients are supported.
        self.end_headers()
        self.wfile.write(content)

    def allowed(self, mutation=False):
        hosts = self.headers.get_all('Host', [])
        origins = self.headers.get_all('Origin', [])
        if hosts != [self.server.authority]:
            self.respond(403, {'error': 'Invalid Host; use ' + self.server.origin})
            return False
        if len(origins) > 1 or (origins and origins != [self.server.origin]):
            self.respond(403, {'error': 'Invalid Origin'})
            return False
        sites = self.headers.get_all('Sec-Fetch-Site', [])
        if len(sites) > 1 or (sites and sites[0] not in ('none', 'same-origin')):
            self.respond(403, {'error': 'Cross-site requests are forbidden'})
            return False
        if mutation:
            tokens = self.headers.get_all('X-CSRF-Token', [])
            if origins != [self.server.origin] or len(tokens) != 1 or not secrets.compare_digest(tokens[0].encode(), self.server.csrf_token.encode()):
                self.respond(403, {'error': 'Origin and CSRF token required'})
                return False
            if self.headers.get_all('Content-Type', []) != ['application/json']:
                self.respond(415, {'error': 'Use application/json'})
                return False
        return True

    def do_GET(self):
        if not self.allowed():
            return
        path = urlsplit(self.path).path
        if path == '/api/state':
            self.respond(200, {**self.server.store.snapshot(), 'csrf_token': self.server.csrf_token})
        elif path == '/api/status':
            self.respond(200, {'status': 'online', 'engine': 'SQLite (disk)', 'sqlite_version': sqlite3.sqlite_version})
        elif path in ASSETS:
            filename, mime = ASSETS[path]
            self.respond(200, (ROOT / filename).read_bytes(), mime)
        else:
            self.respond(404, {'error': 'Not found'})

    def do_OPTIONS(self):
        if self.allowed():
            self.respond(405, {'error': 'Cross-origin access is not supported'})

    def do_POST(self):
        if not self.allowed(mutation=True):
            return
        try:
            if self.headers.get('Transfer-Encoding') or len(self.headers.get_all('Content-Length', [])) != 1:
                raise ValueError('Content-Length required; transfer encoding is unsupported')
            length = int(self.headers['Content-Length'])
            if not 0 < length <= MAX_BODY:
                self.respond(413, {'error': 'Request is empty or exceeds 16 MiB'})
                return
            data = json.loads(self.rfile.read(length), parse_constant=lambda _: (_ for _ in ()).throw(ValueError('Nonfinite JSON value')))
            if not isinstance(data, dict):
                raise ValueError('Expected a JSON object')
            path = urlsplit(self.path).path
            store = self.server.store
            if path == '/api/bills/issue':
                result = store.issue(data)
            elif path == '/api/bills/status':
                result = store.update_status(data.get('number'), data.get('status'), data.get('expected_status'))
            elif path == '/api/settings':
                result = store.save_settings(data)
            elif path == '/api/import':
                if data.get('confirm_import') is not True:
                    raise ValueError('Explicit import confirmation required')
                payload = parse_sql_dump(data['sql']) if 'sql' in data else data.get('payload')
                result = {'count': store.import_data(payload, data.get('source', 'file'), data.get('raw_source'))}
            elif path == '/api/reset':
                if data.get('confirm_reset') is not True:
                    raise ValueError('Explicit reset confirmation required')
                result = {'recovery_backup': store.reset()}
            else:
                self.respond(404, {'error': 'Not found'})
                return
            self.respond(200, {'result': result, 'state': store.snapshot()})
        except sqlite3.IntegrityError:
            self.respond(409, {'error': 'Invoice number already exists or data conflicts; nothing was imported'})
        except (ValueError, TypeError, KeyError, RecursionError) as error:
            self.respond(400, {'error': str(error)})
        except (sqlite3.Error, OSError):
            self.respond(500, {'error': 'Storage operation failed. No successful save is confirmed; check disk access and reload before retrying.'})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('port', nargs='?', type=int, default=8080)
    group = parser.add_mutually_exclusive_group()
    group.add_argument('--backup', metavar='DESTINATION', help='Create a verified SQLite backup; server must be stopped')
    group.add_argument('--restore', metavar='BACKUP', help='Restore a verified backup; server must be stopped')
    parser.add_argument('--confirm-restore', action='store_true')
    args = parser.parse_args()
    store = Store()
    try:
        if args.backup:
            print('Verified backup:', store.backup(args.backup))
        elif args.restore:
            print('Restored. Verified recovery backup:', store.restore(args.restore, args.confirm_restore))
        else:
            server = LocalServer(args.port, store)
            print('Bill Book:', server.origin, '\nDatabase:', store.path, flush=True)
            try:
                server.serve_forever()
            except KeyboardInterrupt:
                pass
            finally:
                server.server_close()
    finally:
        store.close()


if __name__ == '__main__':
    main()
