#!/usr/bin/env python3
"""
Cheque-Style Bill Book - In-Memory SQLite Local Server
Uses Python's standard library sqlite3 (:memory:) and http.server.
Usage: python3 server.py [port]
"""

import sys
import os
import json
import sqlite3
from http.server import HTTPServer, SimpleHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8080

# In-Memory SQLite Connection
conn = sqlite3.connect(":memory:", check_same_thread=False)
conn.row_factory = sqlite3.Row
cursor = conn.cursor()

# Initialize Schema
cursor.execute("""
CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY,
  book_name TEXT,
  address TEXT,
  gstin TEXT,
  currency TEXT DEFAULT '₹',
  range_from INTEGER DEFAULT 1,
  range_to INTEGER DEFAULT 50,
  default_gst_rate REAL DEFAULT 18.0,
  default_gst_type TEXT DEFAULT 'cgst_sgst',
  legal_line TEXT DEFAULT 'Subject to local District Jurisdiction only',
  logo_url TEXT DEFAULT '',
  updated_at TEXT
);
""")

cursor.execute("""
CREATE TABLE IF NOT EXISTS bills (
  number INTEGER PRIMARY KEY,
  date TEXT NOT NULL,
  due_date TEXT,
  payee TEXT NOT NULL,
  payee_gstin TEXT,
  memo TEXT,
  base_amount REAL NOT NULL,
  gst_rate REAL DEFAULT 0,
  gst_type TEXT DEFAULT 'none',
  cgst_amount REAL DEFAULT 0,
  sgst_amount REAL DEFAULT 0,
  igst_amount REAL DEFAULT 0,
  amount REAL NOT NULL,
  status TEXT DEFAULT 'issued',
  issued_at TEXT NOT NULL,
  paid_at TEXT,
  void_at TEXT
);
""")

cursor.execute("""
INSERT OR IGNORE INTO settings (id, book_name, address, gstin, currency, range_from, range_to, default_gst_rate, default_gst_type, legal_line, logo_url, updated_at)
VALUES (1, '', '', '', '₹', 1, 50, 18.0, 'cgst_sgst', 'Subject to local District Jurisdiction only', '', datetime('now'));
""")
conn.commit()


class BillBookHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/status":
            self.send_json({
                "status": "online",
                "engine": "Python SQLite3 (:memory:)",
                "sqlite_version": sqlite3.sqlite_version,
            })
            return
        elif parsed.path == "/api/settings":
            row = cursor.execute("SELECT * FROM settings WHERE id = 1").fetchone()
            self.send_json(dict(row) if row else {})
            return
        elif parsed.path == "/api/bills":
            rows = cursor.execute("SELECT * FROM bills ORDER BY number ASC").fetchall()
            self.send_json([dict(r) for r in rows])
            return
        elif parsed.path == "/api/export.sql":
            sql_dump = "\n".join(conn.iterdump())
            self.send_response(200)
            self.send_header("Content-Type", "application/sql")
            self.send_header("Content-Disposition", 'attachment; filename="billbook-sqlite-memory.sql"')
            self.end_headers()
            self.wfile.write(sql_dump.encode("utf-8"))
            return

        # Fallback to serving static files
        super().do_GET()

    def do_POST(self):
        parsed = urlparse(self.path)
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length).decode("utf-8") if length > 0 else "{}"
        try:
            data = json.loads(body)
        except Exception:
            data = {}

        if parsed.path == "/api/settings":
            cursor.execute("""
                UPDATE settings SET
                  book_name = ?, address = ?, gstin = ?, currency = ?,
                  range_from = ?, range_to = ?, default_gst_rate = ?, default_gst_type = ?,
                  legal_line = ?, logo_url = ?,
                  updated_at = datetime('now')
                WHERE id = 1
            """, (
                data.get("book_name", ""),
                data.get("address", ""),
                data.get("gstin", ""),
                data.get("currency", "₹"),
                int(data.get("range_from", 1)),
                int(data.get("range_to", 50)),
                float(data.get("default_gst_rate", 18.0)),
                data.get("default_gst_type", "cgst_sgst"),
                data.get("legal_line", "Subject to local District Jurisdiction only"),
                data.get("logo_url", ""),
            ))
            conn.commit()
            self.send_json({"success": True})
            return

        elif parsed.path == "/api/bills":
            cursor.execute("""
                INSERT OR REPLACE INTO bills (
                  number, date, due_date, payee, payee_gstin, memo, base_amount,
                  gst_rate, gst_type, cgst_amount, sgst_amount, igst_amount,
                  amount, status, issued_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
            """, (
                int(data["number"]),
                data["date"],
                data.get("due_date", data["date"]),
                data["payee"],
                data.get("payee_gstin", ""),
                data.get("memo", ""),
                float(data.get("base_amount", data.get("amount", 0))),
                float(data.get("gst_rate", 0)),
                data.get("gst_type", "none"),
                float(data.get("cgst_amount", 0)),
                float(data.get("sgst_amount", 0)),
                float(data.get("igst_amount", 0)),
                float(data["amount"]),
                data.get("status", "issued"),
            ))
            conn.commit()
            self.send_json({"success": True})
            return

        elif parsed.path == "/api/sql":
            query = data.get("query", "").strip()
            try:
                cur = conn.cursor()
                cur.execute(query)
                if query.lower().startswith("select") or query.lower().startswith("pragma"):
                    rows = cur.fetchall()
                    cols = [col[0] for col in cur.description] if cur.description else []
                    results = [dict(zip(cols, row)) for row in rows]
                    self.send_json({"success": True, "columns": cols, "rows": results})
                else:
                    conn.commit()
                    self.send_json({"success": True, "rowsAffected": cur.rowcount})
            except Exception as e:
                self.send_json({"success": False, "error": str(e)}, status=400)
            return

        self.send_response(404)
        self.end_headers()

    def send_json(self, data, status=200):
        body = json.dumps(data, indent=2, default=str).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    server = HTTPServer(("0.0.0.0", PORT), BillBookHandler)
    print(f"===========================================================")
    print(f" Cheque-Style Bill Book In-Memory SQLite Server running at:")
    print(f" http://localhost:{PORT}")
    print(f" Using Python sqlite3 {sqlite3.sqlite_version} (:memory:)")
    print(f"===========================================================")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down server.")
        server.server_close()
