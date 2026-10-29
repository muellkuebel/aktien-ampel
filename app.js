(() => {
  const APP_VERSION = "V1.30";
  const POS_KEY = "aktien-ampel-positions";
  const HIST_KEY = "aktien-ampel-history";
  const SET_KEY = "aktien-ampel-settings";

  const grid = document.getElementById("grid");
  const stand = document.getElementById("stand");
  const standMain = document.getElementById("stand-main");
  const menuFx = document.getElementById("menu-fx");
  const dialog = document.getElementById("dialog");
  const dialogTitle = document.getElementById("dialog-title");
  const dialogBody = document.getElementById("dialog-body");
  const dialogCancel = document.getElementById("dialog-cancel");
  const dialogOk = document.getElementById("dialog-ok");
  const menuBtn = document.getElementById("menu-btn");
  const menu = document.getElementById("menu");
  const menuClose = document.getElementById("menu-close");
  const feeBuyInput = document.getElementById("fee-buy");
  const feeSellInput = document.getElementById("fee-sell");
  const defaultBuyEurInput = document.getElementById("default-buy-eur");
  const feesSave = document.getElementById("fees-save");
  const btnExport = document.getElementById("btn-export");
  const btnImport = document.getElementById("btn-import");
  const importFile = document.getElementById("import-file");
  const orphanSection = document.getElementById("orphan-section");
  const orphanList = document.getElementById("orphan-list");
  const bilReal = document.getElementById("bil-real");
  const bilOpen = document.getElementById("bil-open");
  const bilTotal = document.getElementById("bil-total");

  let marketData = null;

  /* Height comes from CSS inset:0 — JS height left a black gap under the Bilanz on iPhone. */

  let dialogResolver = null;
  let dialogMode = null; // "buy" | "sell" | "confirm"
  let buyQtyMode = "betrag"; // "betrag" | "stueck" while buy dialog open
  let buyPriceUnit = "native"; // "native" | "EUR" while buy/sell dialog open

  function loadPositions() {
    try {
      return JSON.parse(localStorage.getItem(POS_KEY) || "{}") || {};
    } catch {
      return {};
    }
  }
  function savePositions(pos) {
    localStorage.setItem(POS_KEY, JSON.stringify(pos));
  }
  function loadHistory() {
    try {
      return JSON.parse(localStorage.getItem(HIST_KEY) || "[]") || [];
    } catch {
      return [];
    }
  }
  function saveHistory(hist) {
    localStorage.setItem(HIST_KEY, JSON.stringify(hist));
  }
  function loadSettings() {
    const defaults = { feeBuy: 1, feeSell: 1, defaultBuyEur: 100 };
    try {
      const raw = JSON.parse(localStorage.getItem(SET_KEY) || "{}") || {};
      return {
        feeBuy: Number.isFinite(Number(raw.feeBuy)) ? Number(raw.feeBuy) : defaults.feeBuy,
        feeSell: Number.isFinite(Number(raw.feeSell)) ? Number(raw.feeSell) : defaults.feeSell,
        defaultBuyEur: Number.isFinite(Number(raw.defaultBuyEur)) && Number(raw.defaultBuyEur) > 0
          ? Number(raw.defaultBuyEur)
          : defaults.defaultBuyEur,
      };
    } catch {
      return { ...defaults };
    }
  }
  function saveSettings(s) {
    localStorage.setItem(SET_KEY, JSON.stringify(s));
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function parseDecimal(raw) {
    let s = String(raw ?? "").trim().replace(/\s/g, "").replace(/\u00a0/g, "");
    if (!s) return NaN;
    const hasComma = s.includes(",");
    const hasDot = s.includes(".");
    if (hasComma && hasDot) {
      if (s.lastIndexOf(",") > s.lastIndexOf(".")) {
        s = s.replace(/\./g, "").replace(",", ".");
      } else {
        s = s.replace(/,/g, "");
      }
    } else if (hasComma) {
      s = s.replace(",", ".");
    }
    const v = Number(s);
    return Number.isFinite(v) ? v : NaN;
  }

  function formatDecimalInput(n, maxFrac = 6) {
    const x = Number(n);
    if (!Number.isFinite(x)) return "";
    let s = x.toFixed(Math.min(Math.max(maxFrac, 0), 8));
    s = s.replace(/\.?0+$/, "");
    if (s === "" || s === "-") s = "0";
    return s.replace(".", ",");
  }

  function formatChange(pct) {
    if (pct == null || Number.isNaN(pct)) return "–";
    const sign = pct > 0 ? "+" : "";
    return `${sign}${pct.toFixed(2).replace(".", ",")} %`;
  }
  function formatEur(n) {
    if (n == null || Number.isNaN(n)) return "–";
    return (
      n.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €"
    );
  }
  function formatSignedEur(n) {
    if (n == null || Number.isNaN(n)) return "–";
    const sign = n > 0 ? "+" : "";
    return sign + formatEur(n);
  }
  function formatPriceNum(price, currency) {
    const n = Number(price);
    if (Number.isNaN(n)) return "–";
    const fixed = n.toLocaleString("de-DE", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    return currency === "EUR" ? `${fixed} €` : `${fixed} $`;
  }
  function formatShares(n) {
    const s = Number(n);
    if (!Number.isFinite(s)) return "–";
    return s.toLocaleString("de-DE", { maximumFractionDigits: 6, minimumFractionDigits: 0 });
  }
  function formatDateDE(isoDate) {
    if (!isoDate) return "–";
    const [y, m, d] = isoDate.split("-");
    if (!d) return isoDate;
    return `${d}.${m}.${y}`;
  }

  /** Kurs-Zeitstempel für Dialoge (Europe/Berlin). */
  function formatKursMeta(iso) {
    if (!iso) return { text: "Kurszeit unbekannt", stale: false };
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return { text: "Kurszeit unbekannt", stale: false };
    const berlinYmd = (dt) =>
      new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin" }).format(dt);
    const fmt = new Intl.DateTimeFormat("de-DE", {
      timeZone: "Europe/Berlin",
      weekday: "short",
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    const parts = Object.fromEntries(
      fmt.formatToParts(d).filter((x) => x.type !== "literal").map((x) => [x.type, x.value])
    );
    const time = `${parts.hour}:${parts.minute}`;
    const sameDay = berlinYmd(d) === berlinYmd(new Date());
    const wd = (parts.weekday || "").replace(/\.$/, "");
    const text = sameDay
      ? `Kurs von ${time}`
      : `Kurs von ${wd} ${parts.day}.${parts.month}., ${time}`;
    const ageMin = (Date.now() - d.getTime()) / 60000;
    const isWeekday = ["Mon", "Tue", "Wed", "Thu", "Fri"].includes(
      new Intl.DateTimeFormat("en-US", {
        timeZone: "Europe/Berlin",
        weekday: "short",
      }).format(new Date())
    );
    const stale = isWeekday && ageMin > 45;
    return { text, stale };
  }

  function kursMetaHtml() {
    const meta = formatKursMeta(marketData && marketData.updated);
    const cls = meta.stale ? "dlg-kurs-meta is-stale" : "dlg-kurs-meta";
    return (
      `<div class="dlg-kurs-row"><p class="${cls}" id="kurs-meta">${escapeHtml(meta.text)}</p>` +
      `<button type="button" class="live-btn" id="live-btn">Aktuellen Kurs abrufen</button></div>` +
      `<p class="dlg-hint dlg-kurs-hint">Echten Ausführungskurs aus der Broker-App eintragen</p>`
    );
  }

  const QUOTE_URL = "https://aktien-ampel-kurs.muellkuebel.workers.dev/";
  /** Live-Kurs über den Cloudflare-Kursdienst holen und ins Preisfeld schreiben. */
  function wireLiveQuote(stock, input, getUnit, onUpdate) {
    const btn = dialogBody.querySelector("#live-btn");
    const metaEl = dialogBody.querySelector("#kurs-meta");
    if (!btn || !input) return;
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      btn.textContent = "Lädt …";
      try {
        const r = await fetch(QUOTE_URL + "?s=" + encodeURIComponent(stock.ticker) + "&t=" + Date.now(), { cache: "no-store" });
        const j = await r.json();
        if (!r.ok || typeof j.price !== "number") throw new Error("kein Kurs");
        let val = j.price;
        if (getUnit() === "EUR" && stock.currency === "USD") {
          const rate = currentEurUsd();
          if (rate) val = val / rate;
        }
        input.value = formatDecimalInput(val, 2);
        input.classList.remove("invalid");
        if (metaEl) {
          const t = j.time ? new Date(j.time * 1000) : new Date();
          const hm = new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin", hour: "2-digit", minute: "2-digit", hour12: false }).format(t);
          const sameDay = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin" }).format(t) === todayISO();
          const day = sameDay ? "" : new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin", weekday: "short", day: "2-digit", month: "2-digit" }).format(t).replace(/\.,?/, "") + ", ";
          metaEl.textContent = `Live-Kurs von ${day}${hm}`;
          metaEl.classList.remove("is-stale");
          metaEl.classList.add("is-live");
        }
        if (onUpdate) onUpdate();
        btn.textContent = "Aktualisiert ✓";
      } catch (e) {
        btn.textContent = "Fehler – nochmal";
      } finally {
        btn.disabled = false;
        setTimeout(() => {
          if (btn.isConnected && btn.textContent !== "Lädt …") btn.textContent = "Aktuellen Kurs abrufen";
        }, 2500);
      }
    });
  }

  function todayISO() {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Berlin",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
  }
  function currentEurUsd() {
    const rate = marketData?.fx?.usdPerEur;
    return rate && rate > 0 ? Number(rate) : null;
  }
  function toEur(amount, currency, usdPerEur) {
    const a = Number(amount);
    if (!Number.isFinite(a)) return NaN;
    if (currency === "EUR") return a;
    if (currency === "USD") {
      const fx = usdPerEur || currentEurUsd();
      if (!fx || fx <= 0) return NaN;
      return a / fx;
    }
    return NaN;
  }
  function displaySignal(held, z, rule) {
    const zBuy = Number(rule?.zBuy ?? -1.5);
    const zSell = Number(rule?.zSell ?? 1.5);
    if (held) return z >= zSell ? "Verkaufen" : "Halten";
    return z <= zBuy ? "Kaufen" : "Warten";
  }
  function signalClass(signal) {
    const s = (signal || "").toLowerCase();
    if (s === "kaufen") return "signal-kaufen";
    if (s === "verkaufen") return "signal-verkaufen";
    if (s === "halten") return "signal-halten";
    return "signal-warten";
  }

  function openDialog({ title, bodyHtml, okLabel, cancelLabel, focusSelector, mode, theme }) {
    return new Promise((resolve) => {
      dialogResolver = resolve;
      dialogMode = mode || "confirm";
      dialog.classList.remove("dialog-kaufen", "dialog-verkaufen", "dialog-accent", "dialog-stack");
      const th = theme === "verkaufen" ? "verkaufen" : "kaufen";
      dialog.classList.add("dialog-" + th, "dialog-stack", "dialog-accent");
      dialogTitle.textContent = title;
      dialogBody.innerHTML = bodyHtml;
      dialogOk.textContent = okLabel || "OK";
      dialogCancel.textContent = cancelLabel || "Abbrechen";
      dialog.showModal();
      if (focusSelector) {
        const el = dialogBody.querySelector(focusSelector);
        if (el) {
          el.focus();
          if (el.select) el.select();
        }
      } else {
        dialogOk.focus();
      }
    });
  }
  function closeDialog(result) {
    if (dialog.open) dialog.close();
    dialog.classList.remove("dialog-kaufen", "dialog-verkaufen", "dialog-accent", "dialog-stack");
    const r = dialogResolver;
    dialogResolver = null;
    dialogMode = null;
    // Drop focus so iOS/Safari does not leave a focus ring on the tile
    const ae = document.activeElement;
    if (ae && typeof ae.blur === "function") ae.blur();
    if (r) r(result);
  }
  function readValidatedNumber(id, { minExclusive = 0, allowZero = false } = {}) {
    const input = dialogBody.querySelector("#" + id);
    if (!input) return null;
    const val = parseDecimal(input.value);
    const ok = Number.isFinite(val) && (allowZero ? val >= 0 : val > minExclusive);
    if (!ok) {
      input.classList.add("invalid");
      input.focus();
      return null;
    }
    input.classList.remove("invalid");
    return val;
  }

  dialogCancel.addEventListener("click", () => closeDialog(null));
  // Tap on dimmed area outside the card = Abbrechen
  dialog.addEventListener("click", (e) => {
    const form = document.getElementById("dialog-form");
    if (!form) {
      if (e.target === dialog) closeDialog(null);
      return;
    }
    if (e.target === dialog || !form.contains(e.target)) closeDialog(null);
  });
  document.getElementById("dialog-form")?.addEventListener("click", (e) => e.stopPropagation());
  dialogOk.addEventListener("click", () => {
    if (dialogMode === "buy") {
      const price = readValidatedNumber("kaufpreis");
      if (price == null) return;
      if (buyQtyMode === "betrag") {
        const betrag = readValidatedNumber("betrag");
        if (betrag == null) return;
        closeDialog({ price, betrag, qtyMode: "betrag", priceUnit: buyPriceUnit });
      } else {
        const shares = readValidatedNumber("anzahl");
        if (shares == null) return;
        closeDialog({ price, shares, qtyMode: "stueck", priceUnit: buyPriceUnit });
      }
      return;
    }
    if (dialogMode === "sell") {
      const price = readValidatedNumber("verkaufspreis");
      if (price == null) return;
      closeDialog({ price });
      return;
    }
    closeDialog({ confirmed: true });
  });
  dialog.addEventListener("cancel", (e) => {
    e.preventDefault();
    closeDialog(null);
  });

  function fillMenuFields() {
    const s = loadSettings();
    feeBuyInput.value = formatDecimalInput(s.feeBuy, 2);
    feeSellInput.value = formatDecimalInput(s.feeSell, 2);
    defaultBuyEurInput.value = formatDecimalInput(s.defaultBuyEur, 2);
  }
  function openMenu() {
    fillMenuFields();
    if (marketData) {
      updateStand(marketData);
      updateOrphanMenu(marketData);
    }
    menu.showModal();
  }
  function closeMenu() {
    if (menu.open) menu.close();
  }
  menuBtn.addEventListener("click", openMenu);
  menuClose.addEventListener("click", closeMenu);
  menu.addEventListener("click", (e) => {
    if (e.target === menu) closeMenu();
  });
  feesSave.addEventListener("click", () => {
    const feeBuy = parseDecimal(feeBuyInput.value);
    const feeSell = parseDecimal(feeSellInput.value);
    const defaultBuyEur = parseDecimal(defaultBuyEurInput.value);
    let ok = true;
    if (!Number.isFinite(feeBuy) || feeBuy < 0) {
      feeBuyInput.classList.add("invalid");
      ok = false;
    } else feeBuyInput.classList.remove("invalid");
    if (!Number.isFinite(feeSell) || feeSell < 0) {
      feeSellInput.classList.add("invalid");
      ok = false;
    } else feeSellInput.classList.remove("invalid");
    if (!Number.isFinite(defaultBuyEur) || defaultBuyEur <= 0) {
      defaultBuyEurInput.classList.add("invalid");
      ok = false;
    } else defaultBuyEurInput.classList.remove("invalid");
    if (!ok) return;
    saveSettings({ feeBuy, feeSell, defaultBuyEur });
    if (marketData) {
      updateBilanz(marketData);
      render(marketData);
    }
    feesSave.textContent = "Gespeichert";
    setTimeout(() => {
      feesSave.textContent = "Einstellungen speichern";
    }, 1200);
  });


  function exportPayload() {
    return {
      app: "Aktien Ampel",
      version: APP_VERSION,
      exportedAt: new Date().toISOString(),
      settings: loadSettings(),
      positions: loadPositions(),
      history: loadHistory(),
    };
  }

  async function exportData() {
    const payload = exportPayload();
    const text = JSON.stringify(payload, null, 2);
    const filename = `aktien-ampel-backup-${todayISO()}.json`;
    const blob = new Blob([text], { type: "application/json" });
    const file = new File([blob], filename, { type: "application/json" });
    try {
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: "Aktien Ampel Sicherung" });
        return;
      }
    } catch (e) {
      /* fall through to download */
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function importDataObject(obj) {
    if (!obj || typeof obj !== "object") throw new Error("Ungültige Datei");
    if (obj.settings && typeof obj.settings === "object") {
      const cur = loadSettings();
      saveSettings({
        feeBuy: Number.isFinite(Number(obj.settings.feeBuy)) ? Number(obj.settings.feeBuy) : cur.feeBuy,
        feeSell: Number.isFinite(Number(obj.settings.feeSell)) ? Number(obj.settings.feeSell) : cur.feeSell,
        defaultBuyEur: Number.isFinite(Number(obj.settings.defaultBuyEur))
          ? Number(obj.settings.defaultBuyEur)
          : cur.defaultBuyEur,
      });
    }
    if (obj.positions && typeof obj.positions === "object") {
      savePositions(obj.positions);
    }
    if (Array.isArray(obj.history)) {
      saveHistory(obj.history);
    }
  }

  btnExport?.addEventListener("click", () => {
    exportData().catch((e) => console.error(e));
  });
  btnImport?.addEventListener("click", () => importFile?.click());
  importFile?.addEventListener("change", async () => {
    const file = importFile.files && importFile.files[0];
    importFile.value = "";
    if (!file) return;
    const ok = confirm("Gesicherte Daten laden und lokale Positionen/History/Einstellungen überschreiben?");
    if (!ok) return;
    try {
      const text = await file.text();
      const obj = JSON.parse(text);
      importDataObject(obj);
      fillMenuFields();
      if (marketData) render(marketData);
      alert("Daten geladen.");
    } catch (e) {
      console.error(e);
      alert("Laden fehlgeschlagen: " + (e.message || e));
    }
  });


  async function onBuy(stock, theme) {
    const settings = loadSettings();
    const fx = currentEurUsd();
    const isUsd = stock.currency === "USD";
    const prefillNative = formatDecimalInput(stock.price, 2);
    buyQtyMode = "betrag";
    buyPriceUnit = "native";
    const curToggle = isUsd
      ? `<div class="cur-toggle" role="group" aria-label="Währung">
           <button type="button" class="cur-btn is-active" data-cur="USD">$</button>
           <button type="button" class="cur-btn" data-cur="EUR">€</button>
         </div>`
      : "";
    const qtyToggle = `<div class="cur-toggle qty-toggle" role="group" aria-label="Eingabeart">
        <button type="button" class="cur-btn is-active" data-qty="betrag">Betrag</button>
        <button type="button" class="cur-btn" data-qty="stueck">Stück</button>
      </div>`;
    const resultPromise = openDialog({
      title: `${stock.name} gekauft?`,
      mode: "buy",
      theme: theme || "kaufen",
      okLabel: "Speichern",
      focusSelector: "#betrag",
      bodyHtml: `
        <p class="dlg-text">Kauf bestätigen (vermeidet Fehlklicks):</p>
        <div class="dlg-toggle-row">
          ${qtyToggle}
          ${curToggle}
        </div>
        <label class="dlg-label" for="kaufpreis">Kaufpreis (<span id="cur-label">${isUsd ? "USD" : "EUR"}</span>)</label>
        <input id="kaufpreis" class="dlg-input" type="text" inputmode="decimal" lang="de" autocomplete="off" enterkeyhint="done" value="${escapeHtml(prefillNative)}" />
        ${kursMetaHtml()}
        <div id="buy-qty-fields">
          <label class="dlg-label" for="betrag">Betrag inkl. Gebühr (EUR)</label>
          <input id="betrag" class="dlg-input" type="text" inputmode="decimal" lang="de" autocomplete="off" value="${escapeHtml(formatDecimalInput(settings.defaultBuyEur, 2))}" />
        </div>
        <p class="dlg-hint">Gebühr Kauf: ${escapeHtml(formatEur(settings.feeBuy))}</p>
        <div id="buy-preview"></div>
      `,
    });

    const priceInput = dialogBody.querySelector("#kaufpreis");
    const curLabel = dialogBody.querySelector("#cur-label");
    const qtyFields = dialogBody.querySelector("#buy-qty-fields");
    const preview = dialogBody.querySelector("#buy-preview");

    const priceEur = (rawPrice) => {
      const rate = currentEurUsd();
      if (!Number.isFinite(rawPrice) || rawPrice <= 0) return NaN;
      if (!isUsd) return rawPrice;
      if (buyPriceUnit === "EUR") return rawPrice;
      if (!rate) return NaN;
      return rawPrice / rate;
    };

    const refreshBuyPreview = () => {
      if (!preview) return;
      const price = parseDecimal(priceInput?.value);
      const pEur = priceEur(price);
      if (buyQtyMode === "betrag") {
        const betragEl = dialogBody.querySelector("#betrag");
        const betrag = parseDecimal(betragEl?.value);
        const fee = settings.feeBuy;
        if (!Number.isFinite(betrag) || betrag <= fee || !Number.isFinite(pEur) || pEur <= 0) {
          preview.innerHTML = `<p class="dlg-preview flat">Vorschau: –</p>`;
          return;
        }
        const invest = betrag - fee;
        const shares = invest / pEur;
        preview.innerHTML = `<p class="dlg-preview">${escapeHtml(formatEur(invest))} → ${escapeHtml(formatShares(Math.round(shares * 1e4) / 1e4))} St.</p>`;
      } else {
        const sharesEl = dialogBody.querySelector("#anzahl");
        const shares = parseDecimal(sharesEl?.value);
        if (!Number.isFinite(shares) || shares <= 0 || !Number.isFinite(pEur) || pEur <= 0) {
          preview.innerHTML = `<p class="dlg-preview flat">Vorschau: –</p>`;
          return;
        }
        const invest = shares * pEur;
        const total = invest + settings.feeBuy;
        preview.innerHTML = `<p class="dlg-preview">${escapeHtml(formatShares(shares))} St. → ${escapeHtml(formatEur(invest))} + ${escapeHtml(formatEur(settings.feeBuy))} Gebühr = ${escapeHtml(formatEur(total))}</p>`;
      }
    };

    const renderQtyFields = () => {
      if (buyQtyMode === "betrag") {
        qtyFields.innerHTML = `
          <label class="dlg-label" for="betrag">Betrag inkl. Gebühr (EUR)</label>
          <input id="betrag" class="dlg-input" type="text" inputmode="decimal" lang="de" autocomplete="off" value="${escapeHtml(formatDecimalInput(settings.defaultBuyEur, 2))}" />
        `;
        dialogBody.querySelector("#betrag")?.addEventListener("input", refreshBuyPreview);
      } else {
        qtyFields.innerHTML = `
          <label class="dlg-label" for="anzahl">Anzahl Stück</label>
          <input id="anzahl" class="dlg-input" type="text" inputmode="decimal" lang="de" autocomplete="off" value="1" />
        `;
        dialogBody.querySelector("#anzahl")?.addEventListener("input", refreshBuyPreview);
      }
      refreshBuyPreview();
    };

    dialogBody.querySelectorAll(".cur-btn[data-cur]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const want = btn.dataset.cur;
        const rate = currentEurUsd();
        if (!rate || !priceInput) return;
        const val = parseDecimal(priceInput.value);
        if (!Number.isFinite(val)) return;
        let native = val;
        if (buyPriceUnit === "EUR") native = val * rate;
        if (want === "EUR") {
          priceInput.value = formatDecimalInput(native / rate, 2);
          buyPriceUnit = "EUR";
          if (curLabel) curLabel.textContent = "EUR";
        } else {
          priceInput.value = formatDecimalInput(native, 2);
          buyPriceUnit = "native";
          if (curLabel) curLabel.textContent = "USD";
        }
        dialogBody.querySelectorAll(".cur-btn[data-cur]").forEach((b) => {
          b.classList.toggle("is-active", b.dataset.cur === want);
        });
        refreshBuyPreview();
      });
    });

    dialogBody.querySelectorAll(".cur-btn[data-qty]").forEach((btn) => {
      btn.addEventListener("click", () => {
        buyQtyMode = btn.dataset.qty;
        dialogBody.querySelectorAll(".cur-btn[data-qty]").forEach((b) => {
          b.classList.toggle("is-active", b.dataset.qty === buyQtyMode);
        });
        renderQtyFields();
      });
    });

    priceInput?.addEventListener("input", refreshBuyPreview);
    renderQtyFields();
    wireLiveQuote(stock, priceInput, () => buyPriceUnit, refreshBuyPreview);

    const result = await resultPromise;
    if (!result) return;

    let buyPrice = result.price;
    if (isUsd && result.priceUnit === "EUR") {
      const rate = currentEurUsd();
      if (rate) buyPrice = result.price * rate;
    }
    const pEur = isUsd ? buyPrice / (currentEurUsd() || buyPrice) : buyPrice;
    let shares;
    if (result.qtyMode === "betrag") {
      const invest = result.betrag - settings.feeBuy;
      if (!(invest > 0) || !(pEur > 0)) return;
      shares = invest / pEur;
    } else {
      shares = result.shares;
    }
    if (!(shares > 0)) return;

    const pos = loadPositions();
    pos[stock.ticker] = {
      ticker: stock.ticker,
      name: stock.name,
      currency: stock.currency,
      buyPrice,
      shares,
      buyDate: todayISO(),
      buyFx: stock.currency === "USD" ? fx : 1,
      feeBuy: settings.feeBuy,
      lastPrice: Number(stock.price),
      lastPriceAt: marketData?.updated || new Date().toISOString(),
      lastFx: stock.currency === "USD" ? fx : 1,
    };
    savePositions(pos);
    render(marketData);
  }

  function sellPreviewHtml(stock, position, sellPrice) {
    const settings = loadSettings();
    const shares = Number(position.shares) || 0;
    const buyFx = position.buyFx || currentEurUsd() || 1;
    const sellFx = stock.currency === "USD" ? currentEurUsd() : 1;
    const feeBuy = Number(position.feeBuy ?? settings.feeBuy);
    const feeSell = settings.feeSell;
    const costEur = toEur(shares * position.buyPrice, position.currency, buyFx) + feeBuy;
    const grossEur = toEur(shares * sellPrice, position.currency, sellFx);
    const proceedsEur = grossEur - feeSell;
    const pnlEur = proceedsEur - costEur;
    const pnlPct = costEur !== 0 ? (pnlEur / costEur) * 100 : 0;
    const cls = !Number.isFinite(pnlEur) || Math.abs(pnlEur) < 0.005 ? "flat" : pnlEur > 0 ? "pos" : "neg";
    return `<div class="dlg-preview-block">
      <p class="dlg-preview dlg-preview-line">Erlös nach Gebühr: <span class="nowrap">${escapeHtml(formatEur(proceedsEur))}</span></p>
      <p class="dlg-preview dlg-preview-line ${cls}">Ergebnis: <span class="nowrap">${escapeHtml(formatSignedEur(pnlEur))}</span> · <span class="nowrap">${escapeHtml(formatChange(pnlPct))}</span></p>
    </div>`;
  }

  async function onSell(stock, position, theme) {
    const settings = loadSettings();
    const isUsd = stock.currency === "USD";
    const prefill = formatDecimalInput(stock.price, 2);
    const toggleHtml = isUsd
      ? `<div class="cur-toggle" role="group" aria-label="Währung">
           <button type="button" class="cur-btn is-active" data-cur="USD">$</button>
           <button type="button" class="cur-btn" data-cur="EUR">€</button>
         </div>`
      : "";
    const resultPromise = openDialog({
      title: `${stock.name} verkauft?`,
      mode: "sell",
      theme: theme || "kaufen",
      okLabel: "Verkauft",
      focusSelector: "#verkaufspreis",
      bodyHtml: `
        <p class="dlg-text">${escapeHtml(formatShares(position.shares))} St. · Kauf ${escapeHtml(formatPriceNum(position.buyPrice, stock.currency))} am ${escapeHtml(formatDateDE(position.buyDate))}.</p>
        <div class="dlg-toggle-row dlg-toggle-row-end">
          ${toggleHtml}
        </div>
        <label class="dlg-label" for="verkaufspreis">Verkaufspreis (<span id="cur-label-sell">${isUsd ? "USD" : "EUR"}</span>)</label>
        <input id="verkaufspreis" class="dlg-input" type="text" inputmode="decimal" lang="de" autocomplete="off" enterkeyhint="done" value="${escapeHtml(prefill)}" />
        ${kursMetaHtml()}
        <p class="dlg-hint">Gebühr Verkauf: ${escapeHtml(formatEur(settings.feeSell))}</p>
        <div id="sell-preview">${sellPreviewHtml(stock, position, stock.price)}</div>
      `,
    });
    let inputUnit = "native";
    const vp = dialogBody.querySelector("#verkaufspreis");
    const curLabel = dialogBody.querySelector("#cur-label-sell");
    const nativeFromDisplay = (val) => {
      const rate = currentEurUsd();
      if (inputUnit === "EUR" && rate) return val * rate;
      return val;
    };
    const refresh = () => {
      const v = parseDecimal(vp.value);
      const box = dialogBody.querySelector("#sell-preview");
      if (!box || !vp) return;
      if (!Number.isFinite(v) || v <= 0) {
        box.innerHTML = `<p class="dlg-preview flat">Ergebnis: –</p>`;
        return;
      }
      box.innerHTML = sellPreviewHtml(stock, position, nativeFromDisplay(v));
    };
    if (vp) vp.addEventListener("input", refresh);
    wireLiveQuote(stock, vp, () => inputUnit, refresh);
    dialogBody.querySelectorAll(".cur-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const want = btn.dataset.cur;
        const rate = currentEurUsd();
        if (!rate || !vp) return;
        const val = parseDecimal(vp.value);
        if (!Number.isFinite(val)) return;
        let native = nativeFromDisplay(val);
        if (want === "EUR") {
          vp.value = formatDecimalInput(native / rate, 2);
          inputUnit = "EUR";
          if (curLabel) curLabel.textContent = "EUR";
        } else {
          vp.value = formatDecimalInput(native, 2);
          inputUnit = "native";
          if (curLabel) curLabel.textContent = "USD";
        }
        dialogBody.querySelectorAll(".cur-btn").forEach((b) => {
          b.classList.toggle("is-active", b.dataset.cur === want);
        });
        refresh();
      });
    });
    const result = await resultPromise;
    if (!result) return;
    // normalize sell price to native
    if (isUsd && inputUnit === "EUR") {
      const rate = currentEurUsd();
      if (rate) result.price = result.price * rate;
    }
    const pos = loadPositions();
    const held = pos[stock.ticker];
    if (!held) return;
    delete pos[stock.ticker];
    savePositions(pos);

    const sellFx = stock.currency === "USD" ? currentEurUsd() : 1;
    const buyFx = held.buyFx || sellFx || 1;
    const feeBuy = Number(held.feeBuy ?? settings.feeBuy);
    const feeSell = settings.feeSell;
    const shares = Number(held.shares) || 0;
    const costEur = toEur(shares * held.buyPrice, held.currency, buyFx) + feeBuy;
    const proceedsEur = toEur(shares * result.price, held.currency, sellFx) - feeSell;
    const pnlEur = proceedsEur - costEur;
    const pnlPct = costEur !== 0 ? (pnlEur / costEur) * 100 : 0;

    const hist = loadHistory();
    hist.unshift({
      ticker: stock.ticker,
      name: stock.name,
      currency: stock.currency,
      shares,
      buyPrice: held.buyPrice,
      buyDate: held.buyDate,
      buyFx,
      feeBuy,
      sellPrice: result.price,
      sellDate: todayISO(),
      sellFx,
      feeSell,
      costEur: round2(costEur),
      proceedsEur: round2(proceedsEur),
      pnlEur: round2(pnlEur),
      pnlPct: round2(pnlPct),
    });
    saveHistory(hist.slice(0, 100));
    render(marketData);
  }

  function round2(n) {
    return Math.round(n * 100) / 100;
  }

  function holdingParts(stock, position) {
    const shares = Number(position.shares) || 0;
    const buyFx = position.buyFx || currentEurUsd() || 1;
    const settings = loadSettings();
    const feeBuy = Number(position.feeBuy ?? settings.feeBuy);
    const feeSell = settings.feeSell;
    const costEur = toEur(shares * position.buyPrice, position.currency, buyFx) + feeBuy;
    const markEur = toEur(shares * stock.price, position.currency, currentEurUsd()) - feeSell;
    const pnlEur = markEur - costEur;
    const pnlPct = costEur !== 0 ? (pnlEur / costEur) * 100 : 0;
    return {
      line1: `Im Besitz seit ${formatDateDE(position.buyDate)} · ${formatShares(shares)} St.`,
      line2: `Kauf ${formatPriceNum(position.buyPrice, stock.currency)} · ${formatChange(pnlPct)}`,
    };
  }

  function setBilanzVal(el, eur, pct) {
    el.textContent = `${formatSignedEur(eur)} · ${formatChange(pct)}`;
    el.classList.remove("pos", "neg", "flat");
    if (!Number.isFinite(eur) || Math.abs(eur) < 0.005) el.classList.add("flat");
    else if (eur > 0) el.classList.add("pos");
    else el.classList.add("neg");
  }

  function watchlistTickers(data) {
    return new Set((data?.stocks || []).map((s) => s.ticker));
  }

  function orphanPositions(data) {
    const wl = watchlistTickers(data);
    const positions = loadPositions();
    return Object.entries(positions)
      .filter(([ticker]) => !wl.has(ticker))
      .map(([ticker, pos]) => ({ ticker, ...pos }));
  }

  /** Persist last known mark for open positions still on the watchlist. */
  function syncPositionMarks(data) {
    const positions = loadPositions();
    let changed = false;
    const fx = currentEurUsd();
    for (const s of data.stocks || []) {
      const pos = positions[s.ticker];
      if (!pos) continue;
      pos.lastPrice = Number(s.price);
      pos.lastPriceAt = data.updated || new Date().toISOString();
      pos.name = pos.name || s.name;
      pos.currency = pos.currency || s.currency;
      if (s.currency === "USD" && fx) pos.lastFx = fx;
      changed = true;
    }
    if (changed) savePositions(positions);
  }

  function updateOrphanMenu(data) {
    if (!orphanSection || !orphanList) return;
    const orphans = orphanPositions(data);
    if (!orphans.length) {
      orphanSection.hidden = true;
      orphanList.innerHTML = "";
      return;
    }
    orphanSection.hidden = false;
    orphanList.innerHTML = orphans
      .map((p) => {
        const price =
          p.lastPrice != null
            ? formatPriceNum(p.lastPrice, p.currency || "USD")
            : "Kurs unbekannt";
        return `<p class="orphan-item"><strong>${escapeHtml(p.name || p.ticker)}</strong> (${escapeHtml(p.ticker)}) · ${escapeHtml(formatShares(p.shares))} St. · letzter Kurs ${escapeHtml(price)} · <em>nicht mehr in der Watchlist</em></p>`;
      })
      .join("");
  }

  function updateBilanz(data) {
    const settings = loadSettings();
    const positions = loadPositions();
    const history = loadHistory();
    const stocksByTicker = Object.fromEntries((data.stocks || []).map((s) => [s.ticker, s]));
    const fx = currentEurUsd();

    // Realized from ALL history rows (independent of watchlist)
    let realized = 0;
    let realizedCost = 0;
    for (const t of history) {
      const pnl = Number(t.pnlEur);
      const cost = Number(t.costEur);
      if (Number.isFinite(pnl)) realized += pnl;
      if (Number.isFinite(cost)) realizedCost += cost;
    }

    let unrealized = 0;
    let openCost = 0;
    for (const [ticker, pos] of Object.entries(positions)) {
      const stock = stocksByTicker[ticker];
      const markPrice = stock
        ? Number(stock.price)
        : Number(pos.lastPrice);
      if (!Number.isFinite(markPrice)) continue;
      const shares = Number(pos.shares) || 0;
      const currency = pos.currency || stock?.currency || "USD";
      const buyFx = pos.buyFx || fx || 1;
      const markFx = currency === "USD" ? (stock ? fx : pos.lastFx || fx) : 1;
      const feeBuy = Number(pos.feeBuy ?? settings.feeBuy);
      const feeSell = settings.feeSell;
      const cost = toEur(shares * pos.buyPrice, currency, buyFx) + feeBuy;
      const mark = toEur(shares * markPrice, currency, markFx) - feeSell;
      if (!Number.isFinite(cost) || !Number.isFinite(mark)) continue;
      openCost += cost;
      unrealized += mark - cost;
    }

    const total = realized + unrealized;
    const totalCost = realizedCost + openCost;
    const realPct = realizedCost !== 0 ? (realized / realizedCost) * 100 : 0;
    const openPct = openCost !== 0 ? (unrealized / openCost) * 100 : 0;
    const totalPct = totalCost !== 0 ? (total / totalCost) * 100 : 0;

    setBilanzVal(bilReal, realized, realPct);
    setBilanzVal(bilOpen, unrealized, openPct);
    setBilanzVal(bilTotal, total, totalPct);
    updateOrphanMenu(data);
  }

  function formatStandShort(iso, fallbackDisplay) {
    if (!iso) {
      // fallbackDisplay like "29.10.2026 04:45 (Berlin)" → "Stand 29.10. 04:45"
      if (!fallbackDisplay || fallbackDisplay === "–") return "Stand: –";
      const m = String(fallbackDisplay).match(/(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}:\d{2})/);
      if (m) return `Stand ${m[1]}.${m[2]}. ${m[4]}`;
      return `Stand: ${fallbackDisplay.replace("\u00a0", " ").replace(" (Berlin)", "")}`;
    }
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return formatStandShort(null, fallbackDisplay);
    const fmt = new Intl.DateTimeFormat("de-DE", {
      timeZone: "Europe/Berlin",
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    const parts = Object.fromEntries(
      fmt.formatToParts(d).filter((x) => x.type !== "literal").map((x) => [x.type, x.value])
    );
    return `Stand ${parts.day}.${parts.month}. ${parts.hour}:${parts.minute}`;
  }

  function updateStand(data) {
    const short = formatStandShort(data.updated, data.updatedDisplay);
    if (standMain) {
      standMain.textContent = data.live ? short + " · live" : short;
      standMain.classList.toggle("is-live", Boolean(data.live));
    }
    if (stand) stand.textContent = `Stand: ${data.updatedDisplay || "–"}`;
    const fx = data.fx?.usdPerEur;
    if (menuFx) {
      menuFx.textContent = fx
        ? `EURUSD: ${Number(fx).toFixed(4).replace(".", ",")}`
        : "EURUSD: –";
    }
  }

  const loadedLogos = new Set();
  let introStart = 0;
  const INTRO_MS = 700;
  function render(data) {
    if (!data) return;
    marketData = data;
    updateStand(data);
    grid.innerHTML = "";
    if (!introStart) introStart = performance.now();
    const introElapsed = performance.now() - introStart;
    const intro = introElapsed < INTRO_MS;
    const stocks = data.stocks || [];
    const rule = data.rule || {};
    const positions = loadPositions();

    for (const s of stocks) {
      const position = positions[s.ticker] || null;
      const held = Boolean(position);
      const signal = displaySignal(held, Number(s.z), rule);
      const tile = document.createElement("article");
      tile.className = `tile ${signalClass(signal)}${held ? " is-held" : ""}`;
      tile.dataset.ticker = s.ticker;
      tile.setAttribute(
        "aria-label",
        `${s.name} ${signal}${held ? ", im Besitz" : ""}`
      );

      let holdHtml = "";
      if (held) {
        const hp = holdingParts(s, position);
        holdHtml = `<div class="holding" aria-label="Position">
          <span class="holding-a">${escapeHtml(hp.line1)}</span>
          <span class="holding-b">${escapeHtml(hp.line2)}</span>
        </div>`;
      }
      const actionable = signal === "Kaufen" || signal === "Verkaufen";
      const btnHtml = actionable
        ? `<button type="button" class="pos-btn ${signal === "Verkaufen" ? "btn-sell" : "btn-buy"}">${
            signal === "Verkaufen" ? "Verkauf eintragen" : "Kauf eintragen"
          }</button>`
        : "";

      const logoSrc = `logos/${encodeURIComponent(s.ticker)}.svg`;
      if (intro) {
        tile.classList.add("tile-intro");
        tile.style.animationDelay = `${-introElapsed}ms`;
      }
      tile.innerHTML = `
        <p class="signal">${escapeHtml(signal)}</p>
        <div class="tile-spacer" aria-hidden="true">
          <img class="tile-logo${loadedLogos.has(logoSrc) ? " is-loaded" : ""}" src="${logoSrc}" alt="" aria-hidden="true" draggable="false" />
        </div>
        <div class="meta">
          <p class="name">${escapeHtml(s.name)}</p>
          <p class="ticker">${escapeHtml(s.ticker)}</p>
          <p class="price">${escapeHtml(s.priceDisplay || String(s.price))}</p>
          <p class="change">${escapeHtml(formatChange(s.dayChangePct))}</p>
          <p class="reason">${escapeHtml(s.reason || "")}</p>
          ${holdHtml}
        </div>
        ${btnHtml}
      `;
      const logoImg = tile.querySelector(".tile-logo");
      if (logoImg && !loadedLogos.has(logoSrc)) {
        const done = () => {
          loadedLogos.add(logoSrc);
          requestAnimationFrame(() => logoImg.classList.add("is-loaded"));
        };
        if (logoImg.complete && logoImg.naturalWidth) done();
        else logoImg.addEventListener("load", done, { once: true });
      }

      if (actionable) {
        const theme = signal === "Verkaufen" ? "verkaufen" : "kaufen";
        const act = () => {
          if (signal === "Verkaufen") onSell(s, position, theme);
          else onBuy(s, theme);
        };
        const btn = tile.querySelector(".pos-btn");
        if (btn) {
          btn.addEventListener("click", (e) => {
            e.stopPropagation();
            act();
          });
        }
        tile.addEventListener("click", (e) => {
          if (e.target.closest(".pos-btn")) return;
          act();
        });
        tile.addEventListener("pointerdown", () => tile.classList.add("is-pressed"));
        const clearPress = () => tile.classList.remove("is-pressed");
        tile.addEventListener("pointerup", clearPress);
        tile.addEventListener("pointercancel", clearPress);
        tile.addEventListener("pointerleave", clearPress);
        tile.tabIndex = 0;
        tile.setAttribute("role", "button");
        tile.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            act();
          }
        });
      } else {
        tile.classList.add("tile-inert");
      }

      grid.appendChild(tile);
    }

    if (!stocks.length) {
      const empty = document.createElement("p");
      empty.textContent = "Keine Daten – bitte update_data.py ausführen.";
      empty.style.gridColumn = "1 / -1";
      grid.appendChild(empty);
    }

    syncPositionMarks(data);
    updateBilanz(data);
  }

  async function load() {
    const bust = `data.json?t=${Date.now()}`;
    const res = await fetch(bust, { cache: "no-store" });
    if (!res.ok) throw new Error(`data.json HTTP ${res.status}`);
    return res.json();
  }

  function reasonLine(last, sma) {
    if (!sma) return "Kein Abstand zum 20-Tage-Schnitt";
    const pct = ((last - sma) / sma) * 100;
    const n = Math.round(Math.abs(pct));
    if (n === 0) return "nahe am 20-Tage-Schnitt";
    return pct < 0 ? `${n} % unter dem 20-Tage-Schnitt` : `${n} % über dem 20-Tage-Schnitt`;
  }
  function priceDisplayOf(price, currency) {
    const t = new Intl.NumberFormat("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(price);
    return `${t} ${currency === "EUR" ? "€" : "$"}`;
  }

  /** Live-Kurse aller Aktien über den Cloudflare-Kursdienst holen. */
  let liveBusy = false;
  async function refreshLive() {
    if (!marketData || liveBusy) return;
    liveBusy = true;
    if (standMain) standMain.classList.add("is-loading");
    try {
      const syms = (marketData.stocks || []).map((x) => x.ticker).concat(["EURUSD=X"]);
      const r = await fetch(QUOTE_URL + "?s=" + syms.map(encodeURIComponent).join(",") + "&t=" + Date.now(), { cache: "no-store" });
      const j = await r.json();
      const q = (j && j.quotes) || {};
      let n = 0;
      for (const st of marketData.stocks || []) {
        const x = q[st.ticker];
        if (!x || typeof x.price !== "number") continue;
        n++;
        st.price = x.price;
        st.priceDisplay = priceDisplayOf(x.price, st.currency);
        if (x.prevClose) st.dayChangePct = Math.round((x.price / x.prevClose - 1) * 10000) / 100;
        const sma = Number(st.sma20), sd = Number(st.sd20);
        if (sma && sd) {
          st.z = Math.round(((x.price - sma) / sd) * 1000) / 1000;
          st.distFromSma20Pct = Math.round(((x.price - sma) / sma) * 10000) / 100;
          st.reason = reasonLine(x.price, sma);
        }
      }
      const fx = q["EURUSD=X"];
      if (fx && fx.price > 0) marketData.fx = Object.assign({}, marketData.fx, { usdPerEur: fx.price });
      if (!n) throw new Error("keine Kurse");
      const now = new Date();
      marketData.updated = now.toISOString();
      marketData.updatedDisplay = new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(now) + " (live)";
      marketData.live = true;
      if (!(dialog && dialog.open)) render(marketData);
      else updateStand(marketData);
    } catch (e) {
      if (standMain) standMain.classList.remove("is-live");
      console.warn("Live-Kurse fehlgeschlagen", e);
    } finally {
      liveBusy = false;
      if (standMain) standMain.classList.remove("is-loading");
    }
  }
  if (standMain) {
    standMain.setAttribute("role", "button");
    standMain.addEventListener("click", refreshLive);
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refreshLive();
  });

  load()
    .then((d) => {
      render(d);
      refreshLive();
    })
    .catch((err) => {
      if (stand) stand.textContent = "Stand: Daten fehlen";
      grid.innerHTML = `<article class="tile signal-warten" style="grid-column:1/-1;min-height:80px">
        <p class="signal">Fehler</p>
        <p class="reason">${escapeHtml(err.message)}</p>
      </article>`;
      console.error(err);
    });

  // Auto-Update (wie Geräte Laufzettel): neuer Service Worker übernimmt sofort
  // (skipWaiting + clients.claim). Still neu laden nur, solange in dieser Sitzung
  // noch nichts angetippt wurde und kein Dialog offen ist. Sonst erscheint ein
  // Hinweis „Update verfügbar · Neu laden“ (nur ohne offenen Dialog).
  if ("serviceWorker" in navigator) {
    const hadController = Boolean(navigator.serviceWorker.controller);
    let acted = false;
    let pending = false;
    let bar = null;
    const markActed = () => { acted = true; };
    ["pointerdown", "touchstart", "keydown"].forEach((ev) =>
      window.addEventListener(ev, markActed, { capture: true, passive: true })
    );
    const dialogOpen = () => Boolean(document.querySelector("dialog[open]"));
    const syncBar = () => {
      if (!pending) return;
      if (dialogOpen()) {
        if (bar) bar.remove();
        return;
      }
      if (!bar) {
        bar = document.createElement("div");
        bar.className = "update-hint";
        bar.setAttribute("role", "status");
        bar.innerHTML = '<span>Update verfügbar</span><button type="button">Neu laden</button>';
        bar.querySelector("button").addEventListener("click", () => {
          if (!dialogOpen()) location.reload();
        });
      }
      if (!bar.isConnected) document.body.appendChild(bar);
    };
    const tryApply = () => {
      if (!pending) return;
      if (!acted && !dialogOpen()) location.reload();
      else syncBar();
    };
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (!hadController || pending) return;
      pending = true;
      tryApply();
      document.addEventListener("close", () => setTimeout(syncBar, 0), true);
    });
    // Zusätzlich zum Service-Worker-Ereignis: Versionsnummer direkt vom Server
    // vergleichen (iOS meldet ein neues Update oft gar nicht oder sehr spät).
    const RUNNING = APP_VERSION;
    let swReg = null;
    const checkVersion = async () => {
      if (pending) { tryApply(); return; }
      try {
        if (swReg) swReg.update().catch(() => {});
        const r = await fetch("config.json?t=" + Date.now(), { cache: "no-store" });
        const j = await r.json();
        if (j && j.version && j.version !== RUNNING) {
          pending = true;
          document.addEventListener("close", () => setTimeout(syncBar, 0), true);
          tryApply();
        }
      } catch (e) {}
    };
    navigator.serviceWorker.register("sw.js").then((reg) => { swReg = reg; }).catch(() => {});
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "visible") return;
      acted = false; // neue Sitzung: noch keine Kachel angetippt
      checkVersion();
    });
    window.addEventListener("pageshow", (e) => { if (e.persisted) { acted = false; checkVersion(); } });
    setTimeout(checkVersion, 1500);
    setInterval(() => { if (document.visibilityState === "visible") checkVersion(); }, 60000);
  }
})();
