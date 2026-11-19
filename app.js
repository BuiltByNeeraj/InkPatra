"use strict";

const LS_KEY = "billbook.v1";

const defaultState = () => ({
  settings: { bookName: "", address: "", currency: "₹", from: 1, to: 50 },
  bills: {}, // number -> { number, date, payee, amount, memo, status: issued|paid|void, issuedAt }
});

let state = load();

function load() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.settings && parsed.bills) return parsed;
    }
  } catch (e) { /* corrupted or unavailable storage */ }
  return defaultState();
}

function save() {
  localStorage.setItem(LS_KEY, JSON.stringify(state));
}

/* ---------------- serial numbers ---------------- */

function fmtNum(n) {
  const width = String(state.settings.to).length;
  return String(n).padStart(Math.max(width, 6), "0");
}

function isInRange(n) {
  return n >= state.settings.from && n <= state.settings.to;
}

function lowestFreeNumber() {
  const { from, to } = state.settings;
  const width = to - from + 1;
  for (let i = 0; i < width; i++) {
    const n = from + i;
    if (!state.bills[n] || state.bills[n].status === "void") {
      // void numbers stay consumed; find truly unissued
      if (!state.bills[n]) return n;
    }
  }
  return null;
}

function nextNumber() {
  return lowestFreeNumber();
}

/* ---------------- helpers ---------------- */

function money(n) {
  return state.settings.currency + " " + Number(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const ONES = ["zero","one","two","three","four","five","six","seven","eight","nine","ten",
  "eleven","twelve","thirteen","fourteen","fifteen","sixteen","seventeen","eighteen","nineteen"];
const TENS = ["","","twenty","thirty","forty","fifty","sixty","seventy","eighty","ninety"];

function twoDigits(n) {
  if (n < 20) return ONES[n];
  const t = Math.floor(n / 10);
  const o = n % 10;
  return o ? TENS[t] + "-" + ONES[o] : TENS[t];
}

function wholeInWords(n) {
  if (n >= 10000000) {
    return wholeInWords(Math.floor(n / 10000000)) + " crore " + wholeInWords(n % 10000000);
  }
  if (n >= 100000) {
    return twoDigits(Math.floor(n / 100000)) + " lakh " + wholeInWords(n % 100000);
  }
  if (n >= 1000) {
    return twoDigits(Math.floor(n / 1000)) + " thousand " + wholeInWords(n % 1000);
  }
  if (n >= 100) {
    return twoDigits(Math.floor(n / 100)) + " hundred " + (n % 100 ? wholeInWords(n % 100) : "");
  }
  return n > 0 ? twoDigits(n) : "";
}

function amountInWords(amount) {
  const n = Math.floor(Number(amount));
  const paise = Math.round((Number(amount) - n) * 100);
  if (n === 0 && paise === 0) return "Zero";
  let words = wholeInWords(n).replace(/\s+/g, " ").trim();
  if (paise > 0) words += (words ? " and " : "") + twoDigits(paise) + " paise";
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function fmtDate(iso) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

function activeBills() {
  return Object.values(state.bills).sort((a, b) => a.number - b.number);
}

function statusOfNumber(n) {
  const b = state.bills[n];
  return b ? b.status : "unused";
}

/* ---------------- views / tabs ---------------- */

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
    tab.classList.add("active");
    document.getElementById("view-" + tab.dataset.view).classList.add("active");
    if (tab.dataset.view === "register") renderRegister();
  });
});

/* ---------------- book view ---------------- */

function renderBook() {
  const { from, to } = state.settings;
  const bills = activeBills();
  const used = bills.filter((b) => b.status !== "void").length;
  const voided = bills.filter((b) => b.status === "void").length;
  const paid = bills.filter((b) => b.status === "paid").length;
  const totalIssued = bills.filter((b) => b.status !== "void").reduce((s, b) => s + Number(b.amount), 0);
  const totalPaid = bills.filter((b) => b.status === "paid").reduce((s, b) => s + Number(b.amount), 0);
  const next = nextNumber();

  document.getElementById("book-meta").innerHTML = next === null
    ? `<strong>Book exhausted.</strong> All ${to - from + 1} leaves have been used — open a new range in Settings.`
    : `<strong>Leaf range ${fmtNum(from)}–${fmtNum(to)}</strong> &nbsp;·&nbsp; next bill will be <strong>No. ${fmtNum(next)}</strong>` +
      (state.settings.bookName ? ` &nbsp;·&nbsp; ${state.settings.bookName}` : "");

  document.getElementById("stats").innerHTML = `
    <div class="stat"><div class="label">Issued</div><div class="value">${used + voided}</div></div>
    <div class="stat"><div class="label">Paid</div><div class="value">${paid}</div></div>
    <div class="stat"><div class="label">Leaves left</div><div class="value">${to - from + 1 - (used + voided)}</div></div>
    <div class="stat"><div class="label">Total issued</div><div class="value">${money(totalIssued)}</div></div>
    <div class="stat"><div class="label">Total collected</div><div class="value">${money(totalPaid)}</div></div>
    <div class="stat"><div class="label">Outstanding</div><div class="value">${money(totalIssued - totalPaid)}</div></div>`;

  const leaves = document.getElementById("leaves");
  const total = to - from + 1;
  if (total > 400) {
    leaves.innerHTML = `<p class="hint">Range too large to draw (${total} leaves). Showing the 200 lowest numbers only.</p>`;
  }
  const shown = total > 400 ? from + 200 : to;
  let html = "";
  for (let n = from; n <= shown; n++) {
    const st = statusOfNumber(n);
    const b = state.bills[n];
    if (st === "unused") {
      html += `<div class="leaf unused"><div class="stub">stub</div>
        <div class="v-num">${fmtNum(n)}</div><div class="v-line"><span>— blank leaf —</span></div></div>`;
    } else {
      html += `<div class="leaf used ${st}" data-number="${n}" title="Open printable bill">
        <div class="stub">${st}</div>
        <div class="v-num">${fmtNum(n)}</div>
        <div class="v-line"><span>${esc(b.payee)}</span><span class="v-amount">${money(b.amount)}</span></div>
        <div class="v-line"><span>${fmtDate(b.date)}</span><span></span></div>
        ${b.memo ? `<div class="v-memoline">${esc(b.memo)}</div>` : ""}
        <div class="amount-words">${amountInWords(b.amount)}</div></div>`;
    }
  }
  leaves.innerHTML += html;

  const last = bills.filter((b) => b.status !== "void").sort((a, b) => b.number - a.number)[0];
  document.getElementById("btn-print-current").disabled = !last;
  document.getElementById("btn-print-current").style.opacity = last ? "1" : ".4";
  document.getElementById("btn-issue").disabled = next === null;
  document.getElementById("btn-issue").style.opacity = next === null ? ".4" : "1";
}

document.getElementById("leaves").addEventListener("click", (e) => {
  const leaf = e.target.closest(".leaf.used");
  if (leaf) openPrint(Number(leaf.dataset.number));
});

document.getElementById("btn-print-current").addEventListener("click", () => {
  const last = activeBills().filter((b) => b.status !== "void").sort((a, b) => b.number - a.number)[0];
  if (last) openPrint(last.number);
});

/* ---------------- register view ---------------- */

function renderRegister() {
  const q = document.getElementById("search").value.trim().toLowerCase();
  const fs = document.getElementById("filter-status").value;
  const bills = activeBills().filter((b) => {
    if (fs && b.status !== fs) return false;
    if (!q) return true;
    return (b.payee + " " + b.memo + " " + fmtNum(b.number)).toLowerCase().includes(q);
  });

  const body = document.getElementById("register-body");
  body.innerHTML = bills.map((b) => `
    <tr class="${b.status === "void" ? "row-void" : ""}">
      <td><strong>${fmtNum(b.number)}</strong></td>
      <td>${fmtDate(b.date)}</td>
      <td>${esc(b.payee)}</td>
      <td>${esc(b.memo || "")}</td>
      <td class="num"><strong>${money(b.amount)}</strong></td>
      <td class="status"><span class="badge ${b.status}">${b.status}</span></td>
      <td class="actions">
        ${b.status === "issued" ? `<button class="btn small primary" data-act="paid" data-n="${b.number}">Mark paid</button>` : ""}
        ${b.status !== "void" ? `<button class="btn small ghost" data-act="print" data-n="${b.number}">Print</button>
        <button class="btn small danger ghost" data-act="void" data-n="${b.number}">Void</button>` : ""}
      </td>
    </tr>`).join("");

  document.getElementById("register-empty").style.display = bills.length ? "none" : "block";
}

document.getElementById("register-body").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const n = Number(btn.dataset.n);
  const act = btn.dataset.act;
  const bill = state.bills[n];
  if (!bill) return;
  if (act === "paid") {
    bill.status = "paid";
    bill.paidAt = new Date().toISOString();
    save();
    renderRegister();
  } else if (act === "void") {
    if (confirm(`Void bill No. ${fmtNum(n)}? The number is burned and cannot be re-issued, like a torn cheque leaf.`)) {
      bill.status = "void";
      bill.voidAt = new Date().toISOString();
      save();
      renderRegister();
    }
  } else if (act === "print") {
    openPrint(n);
  }
});

document.getElementById("search").addEventListener("input", renderRegister);
document.getElementById("filter-status").addEventListener("change", renderRegister);

/* ---------------- issue modal ---------------- */

const overlay = document.getElementById("overlay");

document.getElementById("btn-issue").addEventListener("click", () => {
  const next = nextNumber();
  if (next === null) return;
  document.getElementById("modal-title").textContent = "Issue bill";
  document.getElementById("f-number").value = fmtNum(next);
  document.getElementById("f-date").value = today();
  document.getElementById("f-payee").value = "";
  document.getElementById("f-amount").value = "";
  document.getElementById("f-memo").value = "";
  overlay.hidden = false;
  document.getElementById("f-payee").focus();
});

document.getElementById("btn-cancel").addEventListener("click", () => { overlay.hidden = true; });
overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.hidden = true; });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") overlay.hidden = true; });

document.getElementById("form-issue").addEventListener("submit", (e) => {
  e.preventDefault();
  const n = nextNumber();
  if (n === null) return;
  const bill = {
    number: n,
    date: document.getElementById("f-date").value,
    payee: document.getElementById("f-payee").value.trim(),
    amount: Number(document.getElementById("f-amount").value),
    memo: document.getElementById("f-memo").value.trim(),
    status: "issued",
    issuedAt: new Date().toISOString(),
  };
  if (!bill.payee || !(bill.amount > 0) || !bill.date) return;
  state.bills[n] = bill;
  save();
  overlay.hidden = true;
  renderBook();
  openPrint(n);
});

/* ---------------- printable bill ---------------- */

function billHTML(b) {
  const s = state.settings;
  const stampClass = b.status === "paid" ? "paid" : b.status === "void" ? "void" : "issued";
  return `<div class="bill-wrap"><div class="bill-sheet">
    <div class="bill-head">
      <div>
        <div class="who">${esc(s.bookName || "Bill")}</div>
        <div class="addr">${esc(s.address || "")}</div>
      </div>
      <div class="no">
        <div class="lbl">Bill No.</div>
        <div class="val">${fmtNum(b.number)}</div>
        <div class="addr">Date: ${fmtDate(b.date)}</div>
      </div>
    </div>
    <div class="bill-body">
      <div class="b-row"><div class="k">Received from</div><div>${esc(s.bookName || "—")}</div></div>
      <div class="b-row"><div class="k">Issued to</div><div><strong>${esc(b.payee)}</strong></div></div>
      <div class="b-row"><div class="k">Being payment of</div><div>${esc(b.memo || "—")}</div></div>
      <div class="b-row"><div class="k">Amount (in words)</div><div><em>${amountInWords(b.amount)}</em></div></div>
    </div>
    <div class="bill-amount-line">
      <span>Total due</span>
      <span class="amt">${money(b.amount)}</span>
    </div>
    <div class="bill-foot">
      <span>Status: ${b.status === "paid" ? "Paid in full" : b.status === "void" ? "VOID" : "Due"}</span>
      <span>Signature: ____________________</span>
    </div>
  </div>
  <div class="bill-stamp ${stampClass}">${b.status === "paid" ? "Paid" : b.status}</div></div>`;
}

function openPrint(n) {
  const b = state.bills[n];
  if (!b) return;
  const area = document.getElementById("print-area");
  area.innerHTML = billHTML(b);
  area.hidden = false;
  window.print();
  area.addEventListener("afterprint", () => { area.hidden = true; }, { once: true });
}

/* ---------------- settings ---------------- */

function fillSettings() {
  const s = state.settings;
  document.getElementById("set-bookname").value = s.bookName;
  document.getElementById("set-address").value = s.address;
  document.getElementById("set-currency").value = s.currency;
  document.getElementById("set-from").value = s.from;
  document.getElementById("set-to").value = s.to;
}

document.getElementById("form-settings").addEventListener("submit", (e) => {
  e.preventDefault();
  const s = state.settings;
  const newFrom = Math.max(1, parseInt(document.getElementById("set-from").value, 10) || s.from);
  const newTo = Math.max(newFrom, parseInt(document.getElementById("set-to").value, 10) || s.to);

  const firstIssued = activeBills().map((b) => b.number).sort((a, b) => a - b)[0];
  if (firstIssued !== undefined && newFrom > firstIssued) {
    alert(`Books cannot start above an already-issued number (${fmtNum(firstIssued)}).`);
    return;
  }

  s.bookName = document.getElementById("set-bookname").value.trim();
  s.address = document.getElementById("set-address").value.trim();
  s.currency = document.getElementById("set-currency").value.trim() || "₹";
  s.from = newFrom;
  s.to = newTo;
  save();
  renderBook();
  alert("Settings saved.");
});

document.getElementById("btn-export").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `bill-book-${today()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});

document.getElementById("btn-import").addEventListener("click", () => document.getElementById("file-import").click());
document.getElementById("file-import").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(reader.result);
      if (!parsed || !parsed.settings || !parsed.bills) throw new Error("bad file");
      state = parsed;
      save();
      fillSettings();
      renderBook();
      alert("Data imported.");
    } catch (err) {
      alert("Could not import: not a valid Bill Book export.");
    }
  };
  reader.readAsText(file);
  e.target.value = "";
});

document.getElementById("btn-reset").addEventListener("click", () => {
  if (confirm("Delete ALL bills and reset the book? This cannot be undone. Export first if in doubt.")) {
    if (confirm("Are you really sure?")) {
      state = defaultState();
      save();
      fillSettings();
      renderBook();
    }
  }
});

/* ---------------- util ---------------- */

function esc(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

/* ---------------- init ---------------- */

fillSettings();
renderBook();
