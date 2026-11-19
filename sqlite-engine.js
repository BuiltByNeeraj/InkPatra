/**
 * Local SQLite frontend adapter for Bill Book
 * Committed HTTP mutations, read-only snapshot queries, and SQL data export.
 */
"use strict";

class InMemorySQLite {
  constructor() {
    this.tables = { settings: [], bills: [] };
    this.queryLog = [];
    this.token = null;
  }

  logQuery(sql) {
    this.queryLog.unshift({ sql, time: new Date().toLocaleTimeString() });
    this.queryLog = this.queryLog.slice(0, 200);
  }

  async initialize() {
    const response = await fetch('/api/state', { cache: 'no-store' });
    const state = await response.json();
    if (!response.ok) throw new Error(state.error || 'Cannot load database');
    this.token = state.csrf_token;
    this.applyState(state);
  }

  applyState(state) {
    this.tables = {settings: [state.settings], bills: state.bills};
  }

  async mutate(path, data) {
    let response;
    try {
      response = await fetch(path, {
        method: 'POST', headers: {'Content-Type': 'application/json', 'X-CSRF-Token': this.token},
        body: JSON.stringify(data),
      });
    } catch (error) {
      throw new Error('Local server unavailable. Save is not confirmed. Restart the server and reload before retrying.');
    }
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'Save failed');
    this.applyState(payload.state);
    this.logQuery(path);
    return payload.result;
  }

  async migrateBrowserData() {
    const sources = [];
    for (const key of ['billbook.sqlite.memory', 'billbook.v1']) {
      let raw;
      try { raw = localStorage.getItem(key); }
      catch (error) { alert('Browser storage is inaccessible. No browser data has been changed. You can still use the local SQLite database.'); return; }
      if (raw !== null) sources.push({key, raw});
    }
    for (const {key, raw} of sources) {
      if (!confirm(`Existing browser data found (${key}). Import into SQLite now? Existing invoice numbers will never be overwritten. The entire import fails on any conflict. Your browser data will remain untouched. Cancel to skip.`)) continue;
      try {
        const result = await this.mutate('/api/import', {
          payload: JSON.parse(raw), source: key, raw_source: raw, confirm_import: true,
        });
        alert(`Imported ${result.count} invoices into SQLite. Original browser data has been preserved.`);
      } catch (error) {
        alert(`Migration did not complete: ${error.message}. Original browser data has been preserved.`);
      }
    }
  }

  query(sql) {
    const trimmed = sql.trim();
    if (!/^SELECT\s/i.test(trimmed)) throw new Error('Only read-only snapshot SELECT queries are supported');
    this.logQuery(trimmed);

    // SELECT * FROM settings
    if (/FROM\s+settings/i.test(trimmed)) {
      return [...this.tables.settings];
    }

    // SELECT FROM bills
    if (/FROM\s+bills/i.test(trimmed)) {
      let rows = [...this.tables.bills];

      // Simple status filter in SQL
      const statusMatch = trimmed.match(/status\s*=\s*['"]([a-zA-Z]+)['"]/i);
      if (statusMatch) {
        rows = rows.filter((r) => r.status.toLowerCase() === statusMatch[1].toLowerCase());
      }

      // Simple number match
      const numberMatch = trimmed.match(/number\s*=\s*(\d+)/i);
      if (numberMatch) {
        const n = parseInt(numberMatch[1], 10);
        rows = rows.filter((r) => r.number === n);
      }

      // ORDER BY
      if (/ORDER\s+BY\s+number\s+DESC/i.test(trimmed)) {
        rows.sort((a, b) => b.number - a.number);
      } else {
        rows.sort((a, b) => a.number - b.number);
      }

      return rows;
    }

    // SELECT FROM query_log
    if (/FROM\s+query_log/i.test(trimmed)) {
      return [...this.queryLog];
    }

    // Generic fallback for custom SQL in the SQL Console
    return this.runGenericSQL(trimmed);
  }

  runGenericSQL(sql) {
    const lower = sql.toLowerCase();
    if (lower.startsWith("select")) {
      let targetTable = null;
      if (lower.includes("from bills")) targetTable = this.tables.bills;
      else if (lower.includes("from settings")) targetTable = this.tables.settings;
      else if (lower.includes("from query_log")) targetTable = this.queryLog;

      if (!targetTable) {
        throw new Error("Table not recognized. Available tables: bills, settings, query_log");
      }

      let result = [...targetTable];

      // WHERE clause
      const whereMatch = sql.match(/WHERE\s+(.+?)(ORDER|GROUP|LIMIT|$)/i);
      if (whereMatch) {
        const cond = whereMatch[1].trim();
        const eqMatch = cond.match(/([a-zA-Z0-9_]+)\s*=\s*['"]?([^'"]+)['"]?/);
        if (eqMatch) {
          const col = eqMatch[1].trim();
          const val = eqMatch[2].trim();
          result = result.filter((row) => String(row[col] ?? "").toLowerCase() === val.toLowerCase());
        }
      }

      // Aggregate: SUM, COUNT
      if (lower.includes("count(*)") || lower.includes("sum(")) {
        const count = result.length;
        const sumAmount = result.reduce((s, r) => s + (Number(r.amount) || 0), 0);
        const sumTax = result.reduce((s, r) => s + (Number(r.cgst_amount || 0) + Number(r.sgst_amount || 0) + Number(r.igst_amount || 0)), 0);
        return [{ total_records: count, sum_total_amount: sumAmount, sum_gst_tax: sumTax }];
      }

      // Projection: SELECT col1, col2
      const selectCols = sql.substring(6, sql.search(/from/i)).trim();
      if (selectCols && selectCols !== "*") {
        const cols = selectCols.split(",").map((c) => c.trim());
        result = result.map((r) => {
          const projected = {};
          cols.forEach((col) => {
            projected[col] = r[col] !== undefined ? r[col] : null;
          });
          return projected;
        });
      }

      return result;
    }

    throw new Error("Only SELECT queries are supported in console mode. Use interface forms for modifications.");
  }

  /* ---------------- Helper Methods ---------------- */

  getSettings() { return this.tables.settings[0]; }
  getBills() { return [...this.tables.bills]; }
  getBill(number) { return this.tables.bills.find(b => b.number === number); }
  saveSettings(settings) { return this.mutate('/api/settings', settings); }
  insertBill(bill) { return this.mutate('/api/bills/issue', bill); }
  updateBillStatus(number, status) {
    return this.mutate('/api/bills/status', {number, status, expected_status: this.getBill(number).status});
  }
  resetAll() { return this.mutate('/api/reset', {confirm_reset: true}); }
  async importSQL(sql) {
    if (!confirm('Import this SQL dump? The import is atomic and existing invoices or conflicting settings will not be overwritten.')) throw new Error('Import cancelled');
    return (await this.mutate('/api/import', {sql, confirm_import: true})).count;
  }
  async importJSON(payload) {
    if (!confirm('Import this JSON data? The import is atomic and existing invoices or conflicting settings will not be overwritten.')) throw new Error('Import cancelled');
    return this.mutate('/api/import', {payload, confirm_import: true});
  }

  /* ---------------- SQL Dump / Export / Import ---------------- */

  exportSQL() {
    const s = this.getSettings();
    const bills = this.getBills();
    let sql = `-- ========================================================\n`;
    sql += `-- Bill Book SQLite Database Dump\n`;
    sql += `-- Generated: ${new Date().toISOString()}\n`;
    sql += `-- SQLite data export\n`;
    sql += `-- ========================================================\n\n`;

    sql += `PRAGMA foreign_keys = ON;\n\n`;

    sql += `CREATE TABLE IF NOT EXISTS settings (\n`;
    sql += `  id INTEGER PRIMARY KEY,\n`;
    sql += `  book_name TEXT,\n`;
    sql += `  address TEXT,\n`;
    sql += `  gstin TEXT,\n`;
    sql += `  currency TEXT DEFAULT '₹',\n`;
    sql += `  range_from INTEGER DEFAULT 1,\n`;
    sql += `  range_to INTEGER DEFAULT 50,\n`;
    sql += `  default_gst_rate REAL DEFAULT 18.0,\n`;
    sql += `  default_gst_type TEXT DEFAULT 'cgst_sgst',\n`;
    sql += `  legal_line TEXT DEFAULT 'Subject to local District Jurisdiction only',\n`;
    sql += `  logo_url TEXT DEFAULT '',\n`;
    sql += `  updated_at TEXT\n`;
    sql += `);\n\n`;

    sql += `CREATE TABLE IF NOT EXISTS bills (\n`;
    sql += `  number INTEGER PRIMARY KEY,\n`;
    sql += `  date TEXT NOT NULL,\n`;
    sql += `  due_date TEXT,\n`;
    sql += `  payee TEXT NOT NULL,\n`;
    sql += `  payee_gstin TEXT,\n`;
    sql += `  memo TEXT,\n`;
    sql += `  base_amount REAL NOT NULL,\n`;
    sql += `  gst_rate REAL DEFAULT 0,\n`;
    sql += `  gst_type TEXT DEFAULT 'none',\n`;
    sql += `  cgst_amount REAL DEFAULT 0,\n`;
    sql += `  sgst_amount REAL DEFAULT 0,\n`;
    sql += `  igst_amount REAL DEFAULT 0,\n`;
    sql += `  amount REAL NOT NULL,\n`;
    sql += `  status TEXT DEFAULT 'issued',\n`;
    sql += `  issued_at TEXT NOT NULL,\n`;
    sql += `  paid_at TEXT,\n`;
    sql += `  void_at TEXT\n`;
    sql += `);\n\n`;

    sql += `-- Settings Data\n`;
    sql += `INSERT OR REPLACE INTO settings (id, book_name, address, gstin, currency, range_from, range_to, default_gst_rate, default_gst_type, legal_line, logo_url, updated_at)\n`;
    sql += `VALUES (1, ${this.escapeSQL(s.book_name)}, ${this.escapeSQL(s.address)}, ${this.escapeSQL(s.gstin)}, ${this.escapeSQL(s.currency)}, ${s.range_from}, ${s.range_to}, ${s.default_gst_rate}, ${this.escapeSQL(s.default_gst_type)}, ${this.escapeSQL(s.legal_line)}, ${this.escapeSQL(s.logo_url)}, ${this.escapeSQL(s.updated_at)});\n\n`;

    if (bills.length > 0) {
      sql += `-- Bills Records (${bills.length})\n`;
      bills.forEach((b) => {
        sql += `INSERT INTO bills (number, date, due_date, payee, payee_gstin, memo, base_amount, gst_rate, gst_type, cgst_amount, sgst_amount, igst_amount, amount, status, issued_at, paid_at, void_at)\n`;
        sql += `VALUES (${b.number}, ${this.escapeSQL(b.date)}, ${this.escapeSQL(b.due_date || b.date)}, ${this.escapeSQL(b.payee)}, ${this.escapeSQL(b.payee_gstin)}, ${this.escapeSQL(b.memo)}, ${b.base_amount}, ${b.gst_rate}, ${this.escapeSQL(b.gst_type)}, ${b.cgst_amount}, ${b.sgst_amount}, ${b.igst_amount}, ${b.amount}, ${this.escapeSQL(b.status)}, ${this.escapeSQL(b.issued_at)}, ${this.escapeSQL(b.paid_at)}, ${this.escapeSQL(b.void_at)});\n`;
      });
    }

    return sql;
  }

  escapeSQL(val) {
    if (val === null || val === undefined) return "NULL";
    return "'" + String(val).replace(/'/g, "''") + "'";
  }

 }

window.db = new InMemorySQLite();
