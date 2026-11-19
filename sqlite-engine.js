/**
 * In-Memory SQLite Engine & Store for Bill Book
 * Provides relational table management, SQL execution, query logging,
 * and standard .sql export/import in memory.
 */
"use strict";

class InMemorySQLite {
  constructor(storageKey = "billbook.sqlite.memory") {
    this.storageKey = storageKey;
    this.tables = {
      settings: [],
      bills: [],
      query_log: [],
    };
    this.queryLog = [];
    this.initSchema();
    this.loadFromStorage();
  }

  initSchema() {
    this.logQuery("CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY, book_name TEXT, address TEXT, gstin TEXT, currency TEXT DEFAULT '₹', range_from INTEGER DEFAULT 1, range_to INTEGER DEFAULT 50, default_gst_rate REAL DEFAULT 18.0, default_gst_type TEXT DEFAULT 'cgst_sgst', legal_line TEXT DEFAULT 'Subject to local District Jurisdiction only', logo_url TEXT DEFAULT '', updated_at TEXT);");
    this.logQuery("CREATE TABLE IF NOT EXISTS bills (number INTEGER PRIMARY KEY, date TEXT NOT NULL, due_date TEXT, payee TEXT NOT NULL, payee_gstin TEXT, memo TEXT, base_amount REAL NOT NULL, gst_rate REAL DEFAULT 0, gst_type TEXT DEFAULT 'none', cgst_amount REAL DEFAULT 0, sgst_amount REAL DEFAULT 0, igst_amount REAL DEFAULT 0, amount REAL NOT NULL, status TEXT DEFAULT 'issued', issued_at TEXT NOT NULL, paid_at TEXT, void_at TEXT);");
    this.logQuery("CREATE TABLE IF NOT EXISTS query_log (id INTEGER PRIMARY KEY AUTOINCREMENT, query TEXT NOT NULL, params TEXT, executed_at TEXT NOT NULL);");
  }

  logQuery(sql, params = null) {
    const entry = {
      id: this.queryLog.length + 1,
      sql: sql.trim(),
      params: params ? JSON.stringify(params) : null,
      time: new Date().toLocaleTimeString(),
      timestamp: new Date().toISOString(),
    };
    this.queryLog.unshift(entry);
    if (this.queryLog.length > 200) this.queryLog.pop();
  }

  saveToStorage() {
    try {
      const data = {
        settings: this.tables.settings,
        bills: this.tables.bills,
      };
      localStorage.setItem(this.storageKey, JSON.stringify(data));
    } catch (e) {
      console.warn("Storage save failed:", e);
    }
  }

  loadFromStorage() {
    try {
      const raw = localStorage.getItem(this.storageKey);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed.settings && Array.isArray(parsed.settings)) {
          this.tables.settings = parsed.settings;
          if (this.tables.settings[0]) {
            if (!this.tables.settings[0].legal_line) {
              this.tables.settings[0].legal_line = "Subject to local District Jurisdiction only";
            }
            if (this.tables.settings[0].logo_url === undefined) {
              this.tables.settings[0].logo_url = "";
            }
          }
        }
        if (parsed.bills && Array.isArray(parsed.bills)) {
          this.tables.bills = parsed.bills.map((b) => ({
            ...b,
            due_date: b.due_date || b.date || "",
          }));
        }
        return;
      }

      // Check legacy billbook.v1 for seamless migration
      const legacyRaw = localStorage.getItem("billbook.v1");
      if (legacyRaw) {
        const legacy = JSON.parse(legacyRaw);
        if (legacy.settings) {
          this.tables.settings = [{
            id: 1,
            book_name: legacy.settings.bookName || "",
            address: legacy.settings.address || "",
            gstin: "",
            currency: legacy.settings.currency || "₹",
            range_from: legacy.settings.from || 1,
            range_to: legacy.settings.to || 50,
            default_gst_rate: 18.0,
            default_gst_type: "cgst_sgst",
            legal_line: "Subject to local District Jurisdiction only",
            logo_url: "",
            updated_at: new Date().toISOString(),
          }];
        }
        if (legacy.bills) {
          this.tables.bills = Object.values(legacy.bills).map((b) => ({
            number: Number(b.number),
            date: b.date || "",
            due_date: b.date || "",
            payee: b.payee || "",
            payee_gstin: "",
            memo: b.memo || "",
            base_amount: Number(b.amount || 0),
            gst_rate: 0,
            gst_type: "none",
            cgst_amount: 0,
            sgst_amount: 0,
            igst_amount: 0,
            amount: Number(b.amount || 0),
            status: b.status || "issued",
            issued_at: b.issuedAt || new Date().toISOString(),
            paid_at: b.paidAt || null,
            void_at: b.voidAt || null,
          }));
        }
        this.saveToStorage();
        return;
      }
    } catch (e) {
      console.warn("Could not load from storage:", e);
    }

    // Default settings row
    if (this.tables.settings.length === 0) {
      this.tables.settings = [{
        id: 1,
        book_name: "",
        address: "",
        gstin: "",
        currency: "₹",
        range_from: 1,
        range_to: 50,
        default_gst_rate: 18.0,
        default_gst_type: "cgst_sgst",
        legal_line: "Subject to local District Jurisdiction only",
        logo_url: "",
        updated_at: new Date().toISOString(),
      }];
    }
  }

  /* ---------------- Core SQL Execution ---------------- */

  execute(sql, params = {}) {
    const trimmed = sql.trim();
    this.logQuery(trimmed, params);

    // INSERT INTO bills
    if (/^INSERT\s+INTO\s+bills/i.test(trimmed)) {
      const bill = { ...params };
      if (!bill.due_date) bill.due_date = bill.date || "";
      const idx = this.tables.bills.findIndex((b) => b.number === bill.number);
      if (idx >= 0) {
        this.tables.bills[idx] = bill;
      } else {
        this.tables.bills.push(bill);
      }
      this.tables.bills.sort((a, b) => a.number - b.number);
      this.saveToStorage();
      return { success: true, changes: 1 };
    }

    // UPDATE bills
    if (/^UPDATE\s+bills/i.test(trimmed)) {
      let changes = 0;
      const num = params.number;
      const bill = this.tables.bills.find((b) => b.number === num);
      if (bill) {
        Object.assign(bill, params);
        changes++;
      }
      this.saveToStorage();
      return { success: true, changes };
    }

    // UPDATE settings / INSERT INTO settings
    if (/^UPDATE\s+settings|^INSERT\s+OR\s+REPLACE\s+INTO\s+settings/i.test(trimmed)) {
      const s = {
        id: 1,
        ...params,
        legal_line: params.legal_line || "Subject to local District Jurisdiction only",
        logo_url: params.logo_url || "",
        updated_at: new Date().toISOString(),
      };
      this.tables.settings = [s];
      this.saveToStorage();
      return { success: true, changes: 1 };
    }

    // DELETE FROM bills (reset)
    if (/^DELETE\s+FROM\s+bills/i.test(trimmed)) {
      const count = this.tables.bills.length;
      this.tables.bills = [];
      this.saveToStorage();
      return { success: true, changes: count };
    }

    return { success: true, changes: 0 };
  }

  query(sql) {
    const trimmed = sql.trim();
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

  getSettings() {
    if (!this.tables.settings.length) this.loadFromStorage();
    return this.tables.settings[0] || {
      id: 1,
      book_name: "",
      address: "",
      gstin: "",
      currency: "₹",
      range_from: 1,
      range_to: 50,
      default_gst_rate: 18.0,
      default_gst_type: "cgst_sgst",
      legal_line: "Subject to local District Jurisdiction only",
      logo_url: "",
      updated_at: new Date().toISOString(),
    };
  }

  saveSettings(s) {
    this.execute("UPDATE settings SET book_name = :book_name, address = :address, gstin = :gstin, currency = :currency, range_from = :range_from, range_to = :range_to, default_gst_rate = :default_gst_rate, default_gst_type = :default_gst_type, legal_line = :legal_line, logo_url = :logo_url WHERE id = 1;", s);
  }

  getBills() {
    return this.query("SELECT * FROM bills ORDER BY number ASC;");
  }

  getBill(num) {
    const res = this.query(`SELECT * FROM bills WHERE number = ${num};`);
    return res[0] || null;
  }

  insertBill(bill) {
    return this.execute("INSERT INTO bills (number, date, due_date, payee, payee_gstin, memo, base_amount, gst_rate, gst_type, cgst_amount, sgst_amount, igst_amount, amount, status, issued_at) VALUES (:number, :date, :due_date, :payee, :payee_gstin, :memo, :base_amount, :gst_rate, :gst_type, :cgst_amount, :sgst_amount, :igst_amount, :amount, :status, :issued_at);", bill);
  }

  updateBillStatus(num, status) {
    const now = new Date().toISOString();
    const updateObj = { number: num, status };
    if (status === "paid") updateObj.paid_at = now;
    if (status === "void") updateObj.void_at = now;
    return this.execute("UPDATE bills SET status = :status WHERE number = :number;", updateObj);
  }

  resetAll() {
    this.execute("DELETE FROM bills;");
    this.tables.settings = [{
      id: 1,
      book_name: "",
      address: "",
      gstin: "",
      currency: "₹",
      range_from: 1,
      range_to: 50,
      default_gst_rate: 18.0,
      default_gst_type: "cgst_sgst",
      legal_line: "Subject to local District Jurisdiction only",
      logo_url: "",
      updated_at: new Date().toISOString(),
    }];
    this.saveToStorage();
  }

  /* ---------------- SQL Dump / Export / Import ---------------- */

  exportSQL() {
    const s = this.getSettings();
    const bills = this.getBills();
    let sql = `-- ========================================================\n`;
    sql += `-- Bill Book SQLite Memory Database Dump\n`;
    sql += `-- Generated: ${new Date().toISOString()}\n`;
    sql += `-- SQLite In-Memory Database Script\n`;
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
        sql += `INSERT OR REPLACE INTO bills (number, date, due_date, payee, payee_gstin, memo, base_amount, gst_rate, gst_type, cgst_amount, sgst_amount, igst_amount, amount, status, issued_at, paid_at, void_at)\n`;
        sql += `VALUES (${b.number}, ${this.escapeSQL(b.date)}, ${this.escapeSQL(b.due_date || b.date)}, ${this.escapeSQL(b.payee)}, ${this.escapeSQL(b.payee_gstin)}, ${this.escapeSQL(b.memo)}, ${b.base_amount}, ${b.gst_rate}, ${this.escapeSQL(b.gst_type)}, ${b.cgst_amount}, ${b.sgst_amount}, ${b.igst_amount}, ${b.amount}, ${this.escapeSQL(b.status)}, ${this.escapeSQL(b.issued_at)}, ${this.escapeSQL(b.paid_at)}, ${this.escapeSQL(b.void_at)});\n`;
      });
    }

    return sql;
  }

  escapeSQL(val) {
    if (val === null || val === undefined) return "NULL";
    return "'" + String(val).replace(/'/g, "''") + "'";
  }

  importSQL(sqlText) {
    const lines = sqlText.split("\n");
    let importedBills = 0;
    lines.forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("--") || trimmed.startsWith("PRAGMA") || trimmed.startsWith("CREATE")) return;

      // Match INSERT INTO bills
      if (/INSERT.*?INTO\s+bills/i.test(trimmed)) {
        const valMatch = trimmed.match(/VALUES\s*\((.+)\);?/i);
        if (valMatch) {
          const parts = this.parseSQLValues(valMatch[1]);
          if (parts.length >= 13) {
            const bill = {
              number: parseInt(parts[0], 10),
              date: parts[1],
              due_date: parts[2] || parts[1],
              payee: parts[3],
              payee_gstin: parts[4] || "",
              memo: parts[5] || "",
              base_amount: parseFloat(parts[6]) || 0,
              gst_rate: parseFloat(parts[7]) || 0,
              gst_type: parts[8] || "none",
              cgst_amount: parseFloat(parts[9]) || 0,
              sgst_amount: parseFloat(parts[10]) || 0,
              igst_amount: parseFloat(parts[11]) || 0,
              amount: parseFloat(parts[12]) || 0,
              status: parts[13] || "issued",
              issued_at: parts[14] || new Date().toISOString(),
              paid_at: parts[15] || null,
              void_at: parts[16] || null,
            };
            this.insertBill(bill);
            importedBills++;
          } else if (parts.length >= 12) {
            // Backward compatibility without due_date column
            const bill = {
              number: parseInt(parts[0], 10),
              date: parts[1],
              due_date: parts[1],
              payee: parts[2],
              payee_gstin: parts[3] || "",
              memo: parts[4] || "",
              base_amount: parseFloat(parts[5]) || 0,
              gst_rate: parseFloat(parts[6]) || 0,
              gst_type: parts[7] || "none",
              cgst_amount: parseFloat(parts[8]) || 0,
              sgst_amount: parseFloat(parts[9]) || 0,
              igst_amount: parseFloat(parts[10]) || 0,
              amount: parseFloat(parts[11]) || 0,
              status: parts[12] || "issued",
              issued_at: parts[13] || new Date().toISOString(),
              paid_at: parts[14] || null,
              void_at: parts[15] || null,
            };
            this.insertBill(bill);
            importedBills++;
          }
        }
      }

      // Match INSERT INTO settings
      if (/INSERT.*?INTO\s+settings/i.test(trimmed)) {
        const valMatch = trimmed.match(/VALUES\s*\((.+)\);?/i);
        if (valMatch) {
          const parts = this.parseSQLValues(valMatch[1]);
          if (parts.length >= 8) {
            const s = {
              id: 1,
              book_name: parts[1] || "",
              address: parts[2] || "",
              gstin: parts[3] || "",
              currency: parts[4] || "₹",
              range_from: parseInt(parts[5], 10) || 1,
              range_to: parseInt(parts[6], 10) || 50,
              default_gst_rate: parseFloat(parts[7]) || 18.0,
              default_gst_type: parts[8] || "cgst_sgst",
              legal_line: parts[9] || "Subject to local District Jurisdiction only",
              logo_url: parts[10] || "",
              updated_at: new Date().toISOString(),
            };
            this.saveSettings(s);
          }
        }
      }
    });

    this.saveToStorage();
    return importedBills;
  }

  parseSQLValues(str) {
    const result = [];
    let current = "";
    let inQuote = false;
    for (let i = 0; i < str.length; i++) {
      const c = str[i];
      if (c === "'" && (i === 0 || str[i - 1] !== "\\")) {
        inQuote = !inQuote;
      } else if (c === "," && !inQuote) {
        result.push(this.cleanSQLVal(current));
        current = "";
      } else {
        current += c;
      }
    }
    if (current) result.push(this.cleanSQLVal(current));
    return result;
  }

  cleanSQLVal(val) {
    const trimmed = val.trim();
    if (trimmed.toUpperCase() === "NULL") return null;
    if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
      return trimmed.slice(1, -1).replace(/''/g, "'");
    }
    return trimmed;
  }
}

// Global instance for browser environment
window.db = new InMemorySQLite();
