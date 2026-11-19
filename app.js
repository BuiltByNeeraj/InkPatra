"use strict";

// Every mutation waits for the committed server response before rendering success.
let mutationPending = false;
function committedAction(handler) {
  return async (event) => {
    event.preventDefault();
    if (mutationPending) return;
    mutationPending = true;
    const button = event.submitter || event.target.closest?.('button');
    if (button) button.disabled = true;
    try { await handler(event); }
    catch (error) { alert(error.message + '\nNo successful save is confirmed. Reload to check the database before retrying.'); }
    finally { mutationPending = false; if (button) button.disabled = false; }
  };
}

/**
 * Cheque-Style Bill Book with GST and In-Memory SQLite Record Engine
 */

// Serial number formatting
function fmtNum(n, width = 6) {
  const s = db.getSettings();
  const targetWidth = Math.max(String(s.range_to).length, width);
  return String(n).padStart(targetWidth, "0");
}

function lowestFreeNumber() {
  const s = db.getSettings();
  const bills = db.getBills();
  const issuedMap = {};
  bills.forEach((b) => { issuedMap[b.number] = b.status; });

  const total = s.range_to - s.range_from + 1;
  for (let i = 0; i < total; i++) {
    const n = s.range_from + i;
    if (!issuedMap[n]) return n;
  }
  return null;
}

function nextNumber() {
  return lowestFreeNumber();
}

function money(n) {
  const s = db.getSettings();
  const curr = s.currency || "₹";
  return curr + " " + Number(n).toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function fmtDate(iso) {
  if (!iso) return "";
  const parts = iso.split("-");
  if (parts.length === 3) return `${parts[2]}/${parts[1]}/${parts[0]}`;
  return iso;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

/* ---------------- Number to Words in Indian System ---------------- */

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
  if (n === 0 && paise === 0) return "Zero Rupees Only";
  let words = wholeInWords(n).replace(/\s+/g, " ").trim();
  if (!words) words = "Zero";
  words += " Rupees";
  if (paise > 0) words += " and " + twoDigits(paise) + " paise";
  words += " Only";
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function esc(str) {
  return String(str || "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

/* ---------------- Views / Tab Navigation ---------------- */

function switchTab(viewName) {
  document.querySelectorAll(".tab").forEach((t) => {
    t.classList.toggle("active", t.dataset.view === viewName);
  });
  document.querySelectorAll(".view").forEach((v) => {
    v.classList.toggle("active", v.id === "view-" + viewName);
  });
  if (viewName === "register") renderRegister();
  if (viewName === "sqlitedb") renderSQLiteView();
  if (viewName === "book") renderBook();
}

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => switchTab(tab.dataset.view));
});

/* ---------------- Book View ---------------- */

function renderBook() {
  const s = db.getSettings();
  const brandMark = document.querySelector(".brand-mark");
  if (brandMark) brandMark.textContent = s.currency || "₹";

  // Currency labels in modal
  document.querySelectorAll(".currency-label").forEach((el) => {
    el.textContent = s.currency || "₹";
  });

  // Profile setup banner
  const profileBanner = document.getElementById("profile-banner-wrap");
  if (profileBanner) {
    if (!s.book_name) {
      profileBanner.innerHTML = `
        <div class="profile-banner">
          <div>
            <strong>Set up your profile:</strong> Add your business/personal name, address, and GSTIN in Settings so they are printed on issued cheques.
          </div>
          <button type="button" class="btn small primary" id="btn-goto-profile">Complete Profile</button>
        </div>`;
      const btnGoto = document.getElementById("btn-goto-profile");
      if (btnGoto) btnGoto.addEventListener("click", () => switchTab("settings"));
    } else {
      profileBanner.innerHTML = "";
    }
  }

  const bills = db.getBills();
  const used = bills.filter((b) => b.status !== "void").length;
  const voided = bills.filter((b) => b.status === "void").length;
  const paid = bills.filter((b) => b.status === "paid").length;
  const totalTaxable = bills.filter((b) => b.status !== "void").reduce((s, b) => s + (Number(b.base_amount) || Number(b.amount)), 0);
  const totalTax = bills.filter((b) => b.status !== "void").reduce((s, b) => s + (Number(b.cgst_amount || 0) + Number(b.sgst_amount || 0) + Number(b.igst_amount || 0)), 0);
  const totalIssued = bills.filter((b) => b.status !== "void").reduce((s, b) => s + Number(b.amount), 0);
  const totalPaid = bills.filter((b) => b.status === "paid").reduce((s, b) => s + Number(b.amount), 0);
  const next = nextNumber();

  document.getElementById("book-meta").innerHTML = next === null
    ? `<strong>Cheque book exhausted.</strong> All ${s.range_to - s.range_from + 1} leaves have been issued — configure a new range in Settings.`
    : `<strong>Cheque Range ${fmtNum(s.range_from)}–${fmtNum(s.range_to)}</strong> &nbsp;·&nbsp; Next Cheque will be <strong>No. ${fmtNum(next)}</strong>` +
      (s.book_name ? ` &nbsp;·&nbsp; <strong>${esc(s.book_name)}</strong>` : "") +
      (s.gstin ? ` &nbsp;·&nbsp; GSTIN: <code>${esc(s.gstin)}</code>` : "");

  document.getElementById("stats").innerHTML = `
    <div class="stat"><div class="label">Cheques Issued</div><div class="value">${used + voided}</div></div>
    <div class="stat"><div class="label">Paid / Settled</div><div class="value">${paid}</div></div>
    <div class="stat"><div class="label">Leaves Left</div><div class="value">${s.range_to - s.range_from + 1 - (used + voided)}</div></div>
    <div class="stat"><div class="label">Total Taxable</div><div class="value">${money(totalTaxable)}</div></div>
    <div class="stat"><div class="label">GST Collected</div><div class="value">${money(totalTax)}</div></div>
    <div class="stat"><div class="label">Total Cheque Value</div><div class="value">${money(totalIssued)}</div></div>
    <div class="stat"><div class="label">Outstanding</div><div class="value">${money(totalIssued - totalPaid)}</div></div>`;

  // Draw leaves
  const leavesEl = document.getElementById("leaves");
  const totalLeaves = s.range_to - s.range_from + 1;
  leavesEl.innerHTML = "";
  if (totalLeaves > 400) {
    leavesEl.innerHTML = `<p class="hint">Range too large to draw all leaves (${totalLeaves}). Displaying first 200 leaves.</p>`;
  }

  const billsByNum = {};
  bills.forEach((b) => { billsByNum[b.number] = b; });

  const shownEnd = totalLeaves > 400 ? s.range_from + 200 : s.range_to;
  let html = "";
  for (let n = s.range_from; n <= shownEnd; n++) {
    const b = billsByNum[n];
    if (!b) {
      html += `
        <div class="leaf unused">
          <div class="stub">Blank</div>
          <div class="v-num">No. ${fmtNum(n)}</div>
          <div class="v-line"><span>— Unissued Cheque Leaf —</span></div>
        </div>`;
    } else {
      const gstTag = b.gst_rate > 0 ? `<span class="gst-tag">GST ${b.gst_rate}%</span>` : "";
      html += `
        <div class="leaf used ${b.status}" data-number="${n}" title="Open printable cheque">
          <div class="stub">${b.status}</div>
          <div class="v-num">No. ${fmtNum(n)} ${gstTag}</div>
          <div class="v-line">
            <span><strong>${esc(b.payee)}</strong></span>
            <span class="v-amount">${money(b.amount)}</span>
          </div>
          <div class="v-line">
            <span>${fmtDate(b.date)}</span>
            <span>${b.gst_rate > 0 ? `Tax: ${money(Number(b.cgst_amount || 0) + Number(b.sgst_amount || 0) + Number(b.igst_amount || 0))}` : ""}</span>
          </div>
          ${b.memo ? `<div class="v-memoline">${esc(b.memo)}</div>` : ""}
          <div class="amount-words">${amountInWords(b.amount)}</div>
        </div>`;
    }
  }
  leavesEl.innerHTML += html;

  const last = bills.filter((b) => b.status !== "void").sort((a, b) => b.number - a.number)[0];
  const btnPrintCurrent = document.getElementById("btn-print-current");
  btnPrintCurrent.disabled = !last;
  btnPrintCurrent.style.opacity = last ? "1" : ".4";

  const btnIssue = document.getElementById("btn-issue");
  btnIssue.disabled = next === null;
  btnIssue.style.opacity = next === null ? ".4" : "1";
}

document.getElementById("leaves").addEventListener("click", (e) => {
  const leaf = e.target.closest(".leaf.used");
  if (leaf) openPrint(Number(leaf.dataset.number));
});

document.getElementById("btn-print-current").addEventListener("click", () => {
  const last = db.getBills().filter((b) => b.status !== "void").sort((a, b) => b.number - a.number)[0];
  if (last) openPrint(last.number);
});

/* ---------------- Register View ---------------- */

function renderRegister() {
  const q = document.getElementById("search").value.trim().toLowerCase();
  const fs = document.getElementById("filter-status").value;
  const fg = document.getElementById("filter-gst").value;

  const bills = db.getBills().filter((b) => {
    if (fs && b.status !== fs) return false;
    if (fg === "with_gst" && !(b.gst_rate > 0)) return false;
    if (fg === "no_gst" && b.gst_rate > 0) return false;
    if (!q) return true;
    const searchString = `${b.number} ${b.payee} ${b.payee_gstin || ""} ${b.memo || ""} ${fmtNum(b.number)}`.toLowerCase();
    return searchString.includes(q);
  });

  const body = document.getElementById("register-body");
  body.innerHTML = bills.map((b) => {
    const taxAmt = Number(b.cgst_amount || 0) + Number(b.sgst_amount || 0) + Number(b.igst_amount || 0);
    const gstBadge = b.gst_rate > 0
      ? `<span class="badge" style="font-size:10px; border-color:#0f6b5c; color:#0f6b5c;">${b.gst_rate}% (${money(taxAmt)})</span>`
      : `<span style="color:var(--muted); font-size:12px;">Nil</span>`;

    return `
      <tr class="${b.status === "void" ? "row-void" : ""}">
        <td><strong>No. ${fmtNum(b.number)}</strong></td>
        <td>${fmtDate(b.date)}</td>
        <td><span class="badge" style="border-color:#b89230; color:#856404; font-size:11px;">${fmtDate(b.due_date || b.date)}</span></td>
        <td><strong>${esc(b.payee)}</strong></td>
        <td><code>${esc(b.payee_gstin || "—")}</code></td>
        <td>${esc(b.memo || "—")}</td>
        <td class="num">${money(b.base_amount || b.amount)}</td>
        <td class="num">${gstBadge}</td>
        <td class="num"><strong>${money(b.amount)}</strong></td>
        <td class="status"><span class="badge ${b.status}">${b.status}</span></td>
        <td class="actions">
          ${b.status === "issued" ? `<button class="btn small primary" data-act="paid" data-n="${b.number}">Mark Paid</button>` : ""}
          ${b.status !== "void" ? `<button class="btn small ghost" data-act="print" data-n="${b.number}">Print Cheque</button>
          <button class="btn small danger ghost" data-act="void" data-n="${b.number}">Void</button>` : ""}
        </td>
      </tr>`;
  }).join("");

  document.getElementById("register-empty").style.display = bills.length ? "none" : "block";
}

document.getElementById("register-body").addEventListener("click", committedAction(async (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const n = Number(btn.dataset.n);
  const act = btn.dataset.act;
  const bill = db.getBill(n);
  if (!bill) return;

  if (act === "paid") {
    await db.updateBillStatus(n, "paid");
    renderRegister();
    renderBook();
  } else if (act === "void") {
    if (confirm(`Void Cheque No. ${fmtNum(n)}? Like a torn cheque, this serial is permanently cancelled and cannot be re-issued.`)) {
      await db.updateBillStatus(n, "void");
      renderRegister();
      renderBook();
    }
  } else if (act === "print") {
    openPrint(n);
  }
}));

document.getElementById("search").addEventListener("input", renderRegister);
document.getElementById("filter-status").addEventListener("change", renderRegister);
document.getElementById("filter-gst").addEventListener("change", renderRegister);

/* ---------------- Issue Modal & Live GST Calculation ---------------- */

const overlay = document.getElementById("overlay");

function closeModal() {
  overlay.hidden = true;
}

const btnCloseModal = document.getElementById("btn-close-modal");
if (btnCloseModal) btnCloseModal.addEventListener("click", closeModal);
document.getElementById("btn-cancel").addEventListener("click", closeModal);
overlay.addEventListener("click", (e) => { if (e.target === overlay) closeModal(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !overlay.hidden) closeModal(); });

function computeGST() {
  const base = parseFloat(document.getElementById("f-base-amount").value) || 0;
  const applyGst = document.getElementById("f-apply-gst").checked;
  const gstRateSelect = document.getElementById("f-gst-rate").value;
  const customWrap = document.getElementById("f-custom-rate-wrap");

  let rate = 0;
  if (applyGst) {
    if (gstRateSelect === "custom") {
      customWrap.style.display = "block";
      rate = parseFloat(document.getElementById("f-custom-rate").value) || 0;
    } else {
      customWrap.style.display = "none";
      rate = parseFloat(gstRateSelect) || 0;
    }
  } else {
    customWrap.style.display = "none";
    rate = 0;
  }

  const gstType = document.getElementById("f-gst-type").value;
  let cgst = 0;
  let sgst = 0;
  let igst = 0;

  if (applyGst && rate > 0) {
    if (gstType === "cgst_sgst") {
      const halfRate = rate / 2;
      cgst = Math.round(((base * halfRate) / 100) * 100) / 100;
      sgst = Math.round(((base * halfRate) / 100) * 100) / 100;
      igst = 0;
    } else {
      cgst = 0;
      sgst = 0;
      igst = Math.round(((base * rate) / 100) * 100) / 100;
    }
  }

  const total = Math.round((base + cgst + sgst + igst) * 100) / 100;

  // Update calculation display
  document.getElementById("calc-taxable-val").textContent = money(base);

  const cgstRow = document.getElementById("calc-cgst-row");
  const sgstRow = document.getElementById("calc-sgst-row");
  const igstRow = document.getElementById("calc-igst-row");

  if (gstType === "cgst_sgst" && applyGst && rate > 0) {
    cgstRow.style.display = "flex";
    sgstRow.style.display = "flex";
    igstRow.style.display = "none";
    document.getElementById("calc-cgst-lbl").textContent = `CGST (${rate / 2}%):`;
    document.getElementById("calc-cgst-val").textContent = money(cgst);
    document.getElementById("calc-sgst-lbl").textContent = `SGST (${rate / 2}%):`;
    document.getElementById("calc-sgst-val").textContent = money(sgst);
  } else if (gstType === "igst" && applyGst && rate > 0) {
    cgstRow.style.display = "none";
    sgstRow.style.display = "none";
    igstRow.style.display = "flex";
    document.getElementById("calc-igst-lbl").textContent = `IGST (${rate}%):`;
    document.getElementById("calc-igst-val").textContent = money(igst);
  } else {
    cgstRow.style.display = "none";
    sgstRow.style.display = "none";
    igstRow.style.display = "none";
  }

  document.getElementById("calc-grand-total").textContent = money(total);
  document.getElementById("calc-amount-words").textContent = amountInWords(total);

  return { base, rate, gstType: applyGst ? gstType : "none", cgst, sgst, igst, total };
}

// Bind live computation events
document.getElementById("f-base-amount").addEventListener("input", computeGST);
document.getElementById("f-apply-gst").addEventListener("change", (e) => {
  document.getElementById("gst-fields-row").style.opacity = e.target.checked ? "1" : "0.5";
  computeGST();
});
document.getElementById("f-gst-rate").addEventListener("change", computeGST);
document.getElementById("f-custom-rate").addEventListener("input", computeGST);
document.getElementById("f-gst-type").addEventListener("change", computeGST);

document.getElementById("btn-issue").addEventListener("click", () => {
  const next = nextNumber();
  if (next === null) {
    alert("Cheque book range exhausted. Please extend the range in Settings.");
    return;
  }
  const s = db.getSettings();
  document.getElementById("modal-title").textContent = "Issue New Cheque-Bill";
  document.getElementById("f-number").value = fmtNum(next);
  document.getElementById("f-date").value = today();
  document.getElementById("f-due-date").value = today();
  document.getElementById("f-payee").value = "";
  document.getElementById("f-payee-gstin").value = "";
  document.getElementById("f-base-amount").value = "";
  document.getElementById("f-memo").value = "";
  document.getElementById("f-apply-gst").checked = true;
  document.getElementById("gst-fields-row").style.opacity = "1";
  document.getElementById("f-gst-rate").value = String(s.default_gst_rate || 18);
  document.getElementById("f-gst-type").value = s.default_gst_type || "cgst_sgst";
  computeGST();
  overlay.hidden = false;
  document.getElementById("f-payee").focus();
});

document.getElementById("form-issue").addEventListener("submit", committedAction(async (e) => {
  e.preventDefault();
  const n = nextNumber();
  if (n === null) return;
  const payee = document.getElementById("f-payee").value.trim();
  const date = document.getElementById("f-date").value;
  const dueDate = document.getElementById("f-due-date").value || date;
  const calc = computeGST();

  if (!payee || !date || !(calc.total > 0)) {
    alert("Please fill in all required fields (Payee, Date, and Amount).");
    return;
  }

  const bill = {
    number: n,
    date,
    due_date: dueDate,
    payee,
    payee_gstin: document.getElementById("f-payee-gstin").value.trim().toUpperCase(),
    memo: document.getElementById("f-memo").value.trim(),
    base_amount: calc.base,
    gst_rate: calc.rate,
    gst_type: calc.gstType,
    cgst_amount: calc.cgst,
    sgst_amount: calc.sgst,
    igst_amount: calc.igst,
    amount: calc.total,
    status: "issued",
    issued_at: new Date().toISOString(),
  };

  const savedBill = await db.insertBill(bill);
  closeModal();
  renderBook();
  renderRegister();
  renderSQLiteView();
  openPrint(savedBill.number);
}));

/* ---------------- Real Cheque Generator ---------------- */

function generateDateBoxes(isoDate) {
  // Format DDMMYYYY
  let d = "", m = "", y = "";
  if (isoDate) {
    const parts = isoDate.split("-");
    if (parts.length === 3) {
      y = parts[0];
      m = parts[1];
      d = parts[2];
    }
  }
  const dateStr = (d + m + y).padEnd(8, " ");
  const chars = dateStr.split("");

  return `
    <div class="cheque-date-grid">
      <div class="date-box" title="Date (D)">${chars[0] || ""}</div>
      <div class="date-box" title="Date (D)">${chars[1] || ""}</div>
      <div class="date-box date-separator"></div>
      <div class="date-box" title="Month (M)">${chars[2] || ""}</div>
      <div class="date-box" title="Month (M)">${chars[3] || ""}</div>
      <div class="date-box date-separator"></div>
      <div class="date-box" title="Year (Y)">${chars[4] || ""}</div>
      <div class="date-box" title="Year (Y)">${chars[5] || ""}</div>
      <div class="date-box" title="Year (Y)">${chars[6] || ""}</div>
      <div class="date-box" title="Year (Y)">${chars[7] || ""}</div>
    </div>`;
}

function chequeHTML(b) {
  const s = db.getSettings();
  const curr = s.currency || "₹";
  const stampClass = b.status === "paid" ? "paid" : b.status === "void" ? "void" : "issued";
  const taxAmt = Number(b.cgst_amount || 0) + Number(b.sgst_amount || 0) + Number(b.igst_amount || 0);
  const dueDate = b.due_date || b.date;

  // Generate authentic MICR code
  const micrCheque = fmtNum(b.number, 6);
  const micrCity = "110024018";
  const micrAcc = "000256";
  const micrTx = "29";

  return `
    <div class="cheque-container">
      <!-- 1. Perforated Counterfoil (Stub on Left) -->
      <div class="cheque-stub">
        <div class="stub-perforation-icon">✂</div>
        <div>
          <div class="stub-title">Counterfoil Record</div>
          <div class="stub-row">
            <span class="lbl">Cheque No.</span>
            <span class="val">No. ${fmtNum(b.number)}</span>
          </div>
          <div class="stub-row">
            <span class="lbl">Cheque Date</span>
            <span class="val">${fmtDate(b.date)}</span>
          </div>
          <div class="stub-row">
            <span class="lbl">Due Date</span>
            <span class="val" style="color:#8c3b00;">${fmtDate(dueDate)}</span>
          </div>
          <div class="stub-row">
            <span class="lbl">To / Payee</span>
            <span class="val">${esc(b.payee)}</span>
          </div>
          ${b.payee_gstin ? `<div class="stub-row"><span class="lbl">Payee GSTIN</span><span class="val">${esc(b.payee_gstin)}</span></div>` : ""}
          <div class="stub-row">
            <span class="lbl">For</span>
            <span class="val">${esc(b.memo || "—")}</span>
          </div>
        </div>

        <div>
          <div class="stub-ledger">
            <div class="stub-ledger-row">
              <span>Taxable:</span>
              <strong>${money(b.base_amount || b.amount)}</strong>
            </div>
            ${b.gst_rate > 0 ? `
            <div class="stub-ledger-row">
              <span>GST (${b.gst_rate}%):</span>
              <strong>${money(taxAmt)}</strong>
            </div>` : ""}
            <div class="stub-ledger-row" style="border-top:1.5px solid #234b3f; padding-top:4px; font-size:11.5px;">
              <span>Total:</span>
              <strong style="color:#0f6b5c;">${money(b.amount)}</strong>
            </div>
          </div>

          <div style="margin-top:10px; font-size:9.5px; color:#5a736c; font-style:italic;">
            <div>Issuer: ${esc(s.book_name || "Self")}</div>
            ${s.gstin ? `<div>GSTIN: ${esc(s.gstin)}</div>` : ""}
          </div>
        </div>
      </div>

      <!-- 2. Main Cheque Leaf -->
      <div class="cheque-leaf">
        <div class="cheque-inner-border"></div>

        <!-- Central Watermark (Company Logo or Crest) -->
        <div class="cheque-watermark">
          ${s.logo_url
            ? `<img src="${esc(s.logo_url)}" alt="Watermark Logo" class="watermark-img" />`
            : `<div class="watermark-crest">
                <div class="crest-sym">${esc(s.currency || "₹")}</div>
                <div class="crest-title">${esc(s.book_name || "BILL BOOK")}</div>
               </div>`
          }
        </div>

        <!-- Top-Left Diagonal Crossing -->
        <div class="cheque-crossing">
          // A/C PAYEE ONLY //
        </div>

        <!-- Top Header: Issuer Name, Address & GSTIN Together + Date Section -->
        <div class="cheque-top">
          <div class="cheque-issuer">
            <div class="issuer-name">${esc(s.book_name || "BILL BOOK CHEQUE")}</div>
            <div class="issuer-meta">
              <span class="issuer-address">${esc(s.address || "Main Office / Account Holder")}</span>
              ${s.gstin ? `<span class="issuer-gstin-badge">GSTIN: ${esc(s.gstin)}</span>` : ""}
            </div>
            <div class="cheque-meta-strip">
              <span class="cheque-num-badge">CHEQUE NO. <strong>${fmtNum(b.number)}</strong></span>
              <span class="cheque-due-badge">DUE DATE: <strong>${fmtDate(dueDate)}</strong></span>
            </div>
          </div>
          <div class="cheque-date-wrap">
            ${generateDateBoxes(b.date)}
            <div class="cheque-date-hint">DUE: <strong>${fmtDate(dueDate)}</strong> &nbsp;·&nbsp; VALID FOR 3 MONTHS</div>
          </div>
        </div>

        <!-- Payee Line -->
        <div class="cheque-payee-line" style="position:relative; z-index:2;">
          <span class="lead-text">PAY</span>
          <span class="payee-name-field">
            ${esc(b.payee)}
            ${b.payee_gstin ? `&nbsp;<span class="payee-gstin-tag">GSTIN: ${esc(b.payee_gstin)}</span>` : ""}
          </span>
          <span class="bearer-text">OR BEARER</span>
        </div>

        <!-- Amount in Words & Amount Number Box -->
        <div class="cheque-amount-row" style="position:relative; z-index:2;">
          <div class="cheque-words-wrap">
            <div class="words-line">
              <span class="lead-text">RUPEES</span>
              <span class="words-field">${amountInWords(b.amount)}</span>
            </div>
          </div>
          <div class="cheque-amount-box">
            <span class="curr-sym">${curr}</span>
            <span class="amount-digits">** ${Number(b.amount).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} /- **</span>
          </div>
        </div>

        <!-- Middle: GST Schedule & Memo -->
        <div class="cheque-middle" style="position:relative; z-index:2;">
          <div class="cheque-memo-box">
            <div class="memo-label">BEING PAYMENT OF / MEMO:</div>
            <div class="memo-text">${esc(b.memo || "Account Payment in full settlement")}</div>
          </div>

          <!-- Embedded GST Schedule Table -->
          ${b.gst_rate > 0 ? `
          <div class="cheque-gst-schedule">
            <div class="gst-sched-title">Tax Schedule (GST Breakdown)</div>
            <div class="gst-sched-row">
              <span>Taxable Value:</span>
              <strong>${money(b.base_amount || b.amount)}</strong>
            </div>
            ${b.cgst_amount > 0 ? `
            <div class="gst-sched-row">
              <span>CGST @ ${b.gst_rate / 2}%:</span>
              <span>${money(b.cgst_amount)}</span>
            </div>
            <div class="gst-sched-row">
              <span>SGST @ ${b.gst_rate / 2}%:</span>
              <span>${money(b.sgst_amount)}</span>
            </div>` : ""}
            ${b.igst_amount > 0 ? `
            <div class="gst-sched-row">
              <span>IGST @ ${b.gst_rate}%:</span>
              <span>${money(b.igst_amount)}</span>
            </div>` : ""}
            <div class="gst-sched-row" style="border-top:1px dotted #7ea89c; margin-top:2px; font-weight:bold;">
              <span>Total Cheque Amount:</span>
              <strong>${money(b.amount)}</strong>
            </div>
          </div>` : ""}
        </div>

        <!-- Bottom Signatory Area -->
        <div class="cheque-bottom-sign" style="position:relative; z-index:2;">
          <div class="signatory-box">
            <div class="signatory-firm">For ${esc(s.book_name || "Authorised Account")}</div>
            <div class="signatory-line"></div>
            <div class="signatory-lbl">Authorised Signatory</div>
            <div class="signatory-hint">Please sign above this line</div>
          </div>
        </div>

        <!-- Legal Jurisdiction Notice Line -->
        <div class="cheque-legal-notice">
          ⚖ ${esc(s.legal_line || "Subject to local District Jurisdiction only")} &nbsp;·&nbsp; Cheque-Bill Issued Under Applicable Commercial Terms
        </div>

        <!-- Bottom MICR Band (Magnetic Ink Character Recognition) -->
        <div class="cheque-micr-band">
          <div class="micr-segment">
            <span class="micr-sym">⑈</span>
            <span>${micrCheque}</span>
            <span class="micr-sym">⑈</span>
          </div>
          <div class="micr-segment">
            <span>${micrCity}</span>
            <span class="micr-sym">⑆</span>
          </div>
          <div class="micr-segment">
            <span>${micrAcc}</span>
            <span class="micr-sym">⑈</span>
          </div>
          <div class="micr-segment">
            <span>${micrTx}</span>
          </div>
        </div>

        <!-- Rubber Stamp Overlay -->
        <div class="cheque-stamp ${stampClass}">${b.status === "paid" ? "PAID" : b.status}</div>
      </div>
    </div>`;
}

function openPrint(n) {
  const b = db.getBill(n);
  if (!b) return;
  const area = document.getElementById("print-area");
  area.innerHTML = chequeHTML(b);
  area.hidden = false;
  window.print();
  area.addEventListener("afterprint", () => { area.hidden = true; }, { once: true });
}

/* ---------------- In-Memory SQLite View & Console ---------------- */

function renderSQLiteView() {
  const bills = db.getBills();
  const settings = db.getSettings();
  const queryLog = db.queryLog;

  document.getElementById("db-stat-bills-count").textContent = bills.length;
  document.getElementById("db-stat-settings-status").textContent = settings.book_name ? settings.book_name : "Ready";
  document.getElementById("db-stat-queries-count").textContent = queryLog.length;

  // Render log stream
  const logStream = document.getElementById("sql-log-stream");
  if (logStream) {
    logStream.innerHTML = queryLog.slice(0, 50).map((entry) => `
      <div class="sql-log-entry">
        <span class="sql-log-time">[${entry.time}]</span>
        <span class="sql-log-query">${esc(entry.sql)}</span>
        ${entry.params ? `<span class="sql-log-params">${esc(entry.params)}</span>` : ""}
      </div>
    `).join("");
  }
}

// Quick query buttons
document.querySelectorAll(".btn-quick-sql").forEach((btn) => {
  btn.addEventListener("click", () => {
    const sql = btn.dataset.sql;
    document.getElementById("sql-query-input").value = sql;
    runConsoleSQL();
  });
});

function runConsoleSQL() {
  const sql = document.getElementById("sql-query-input").value.trim();
  const feedback = document.getElementById("sql-console-feedback");
  const outputWrap = document.getElementById("sql-output-wrap");
  const head = document.getElementById("sql-result-head");
  const body = document.getElementById("sql-result-body");

  feedback.className = "sql-feedback";
  feedback.style.display = "none";

  if (!sql) return;

  const startTime = performance.now();
  try {
    const rows = db.query(sql);
    const duration = (performance.now() - startTime).toFixed(2);

    feedback.className = "sql-feedback success";
    feedback.textContent = `Query executed in ${duration} ms. ${rows.length} row(s) returned.`;

    if (rows && rows.length > 0) {
      const cols = Object.keys(rows[0]);
      head.innerHTML = `<tr>${cols.map((c) => `<th>${esc(c)}</th>`).join("")}</tr>`;
      body.innerHTML = rows.map((r) => `
        <tr>${cols.map((c) => `<td>${esc(r[c] !== null && r[c] !== undefined ? r[c] : "NULL")}</td>`).join("")}</tr>
      `).join("");
      outputWrap.style.display = "block";
    } else {
      head.innerHTML = "";
      body.innerHTML = `<tr><td style="text-align:center; padding:18px; color:var(--muted);">Zero rows returned.</td></tr>`;
      outputWrap.style.display = "block";
    }
    renderSQLiteView();
  } catch (err) {
    feedback.className = "sql-feedback error";
    feedback.textContent = `SQLite Error: ${err.message}`;
    outputWrap.style.display = "none";
  }
}

document.getElementById("btn-run-sql").addEventListener("click", runConsoleSQL);
document.getElementById("btn-clear-sql-output").addEventListener("click", () => {
  document.getElementById("sql-output-wrap").style.display = "none";
  document.getElementById("sql-console-feedback").style.display = "none";
});

// Export .SQL dump
async function downloadSQLDump() {
  await db.initialize();
  const sqlDump = db.exportSQL();
  const blob = new Blob([sqlDump], { type: "application/sql" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `billbook-sqlite-${today()}.sql`;
  a.click();
  URL.revokeObjectURL(a.href);
}

document.getElementById("btn-db-export-sql").addEventListener("click", committedAction(downloadSQLDump));
document.getElementById("btn-export-sql-settings").addEventListener("click", committedAction(downloadSQLDump));

// Import .SQL script
function triggerSQLImport() {
  document.getElementById("file-db-import-sql").click();
}
document.getElementById("btn-db-import-sql").addEventListener("click", triggerSQLImport);

document.getElementById("file-db-import-sql").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = committedAction(async () => {
    try {
      const count = await db.importSQL(reader.result);
      fillSettings();
      renderBook();
      renderRegister();
      renderSQLiteView();
      alert(`SQLite script executed. ${count} bills imported into SQLite.`);
    } catch (err) {
      alert("Error importing SQL script: " + err.message);
    }
  });
  reader.readAsText(file);
  e.target.value = "";
});

/* ---------------- Settings & Profile ---------------- */

function fillSettings() {
  const s = db.getSettings();
  document.getElementById("set-bookname").value = s.book_name || "";
  document.getElementById("set-address").value = s.address || "";
  document.getElementById("set-gstin").value = s.gstin || "";
  document.getElementById("set-currency").value = s.currency || "₹";
  document.getElementById("set-from").value = s.range_from || 1;
  document.getElementById("set-to").value = s.range_to || 50;
  document.getElementById("set-default-gst-rate").value = String(s.default_gst_rate || 18);
  document.getElementById("set-default-gst-type").value = s.default_gst_type || "cgst_sgst";
  document.getElementById("set-legal-line").value = s.legal_line || "Subject to local District Jurisdiction only";
  document.getElementById("set-logo-url").value = s.logo_url || "";

  const logoWrap = document.getElementById("logo-preview-wrap");
  const logoImg = document.getElementById("logo-preview-img");
  if (s.logo_url) {
    logoImg.src = s.logo_url;
    logoWrap.style.display = "flex";
  } else {
    logoWrap.style.display = "none";
  }
}

// Logo file upload handler
document.getElementById("set-logo-file").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    document.getElementById("set-logo-url").value = reader.result;
    document.getElementById("logo-preview-img").src = reader.result;
    document.getElementById("logo-preview-wrap").style.display = "flex";
  };
  reader.readAsDataURL(file);
});

document.getElementById("btn-remove-logo").addEventListener("click", () => {
  document.getElementById("set-logo-url").value = "";
  document.getElementById("set-logo-file").value = "";
  document.getElementById("logo-preview-wrap").style.display = "none";
});

document.getElementById("form-settings").addEventListener("submit", committedAction(async (e) => {
  e.preventDefault();
  const s = db.getSettings();
  const newFrom = Math.max(1, parseInt(document.getElementById("set-from").value, 10) || s.range_from);
  const newTo = Math.max(newFrom, parseInt(document.getElementById("set-to").value, 10) || s.range_to);

  const bills = db.getBills();
  const firstIssued = bills.map((b) => b.number).sort((a, b) => a - b)[0];
  if (firstIssued !== undefined && newFrom > firstIssued) {
    alert(`Books cannot start above an already-issued number (${fmtNum(firstIssued)}).`);
    return;
  }

  const updated = {
    book_name: document.getElementById("set-bookname").value.trim(),
    address: document.getElementById("set-address").value.trim(),
    gstin: document.getElementById("set-gstin").value.trim().toUpperCase(),
    currency: document.getElementById("set-currency").value.trim() || "₹",
    range_from: newFrom,
    range_to: newTo,
    default_gst_rate: parseFloat(document.getElementById("set-default-gst-rate").value) || 0,
    default_gst_type: document.getElementById("set-default-gst-type").value || "cgst_sgst",
    legal_line: document.getElementById("set-legal-line").value.trim() || "Subject to local District Jurisdiction only",
    logo_url: document.getElementById("set-logo-url").value || "",
  };

  await db.saveSettings(updated);
  renderBook();
  renderRegister();
  renderSQLiteView();
  alert("Profile, legal notice and settings saved to SQLite.");
}));

// JSON Export
document.getElementById("btn-export-json").addEventListener("click", committedAction(async () => {
  await db.initialize();
  const data = {
    settings: db.getSettings(),
    bills: db.getBills(),
    exportedAt: new Date().toISOString(),
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `bill-book-${today()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}));

// General Import (JSON or SQL)
document.getElementById("btn-import-data").addEventListener("click", () => {
  document.getElementById("file-general-import").click();
});

document.getElementById("file-general-import").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = committedAction(async () => {
    const text = reader.result;
    try {
      if (file.name.endsWith(".sql") || text.includes("CREATE TABLE") || text.includes("INSERT INTO")) {
        const count = await db.importSQL(text);
        fillSettings();
        renderBook();
        renderRegister();
        renderSQLiteView();
        alert(`SQLite Script imported: ${count} bill record(s) loaded.`);
      } else {
        const parsed = JSON.parse(text);
        await db.importJSON(parsed);
        fillSettings();
        renderBook();
        renderRegister();
        renderSQLiteView();
        alert("JSON data committed to SQLite.");
      }
    } catch (err) {
      alert("Could not import file: " + err.message);
    }
  });
  reader.readAsText(file);
  e.target.value = "";
});

// Reset Database
document.getElementById("btn-reset").addEventListener("click", committedAction(async (e) => {
  if (confirm("Delete ALL bills and reset the SQLite database? A verified recovery backup will be created first. Please also export your own backup.")) {
    if (confirm("Are you completely sure?")) {
      await db.resetAll();
      fillSettings();
      renderBook();
      renderRegister();
      renderSQLiteView();
      alert("Database reset completed.");
    }
  }
}));

/* ---------------- Initialization ---------------- */

async function initializeApplication() {
  const surfaces = [document.querySelector('main'), document.querySelector('header')];
  surfaces.forEach(element => { element.inert = true; });
  try {
    await db.initialize();
    await db.migrateBrowserData();
    fillSettings();
    renderBook();
    renderRegister();
    renderSQLiteView();
    surfaces.forEach(element => { element.inert = false; });
  } catch (error) {
    alert('Cannot load the local SQLite database. Run python3 server.py and open http://127.0.0.1:8080, then reload. Existing browser data has not been changed.\n' + error.message);
  }
}
initializeApplication();
