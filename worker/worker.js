// Aktien Ampel: Live-Kurse + Web-Push-Benachrichtigungen.
// GET  /?s=SYM[,SYM…]     -> Kurse (unverändert)
// POST /subscribe         -> Push-Abo + held-Ticker speichern
// POST /held              -> held-Ticker aktualisieren
// POST /unsubscribe       -> Abo löschen
// POST /test              -> Test-Push senden
// POST /run               -> Signal-Check manuell (Header X-Cron-Secret)
// scheduled()             -> Cron: Signale prüfen, bei Kaufen/Verkaufen pushen

const ALLOWED_ORIGINS = ["https://muellkuebel.github.io"];
const SYM = /^[A-Z0-9.\-^=]{1,15}$/;
const DATA_URL = "https://muellkuebel.github.io/aktien-ampel/data.json";
const SUB_PREFIX = "sub:";

function corsHeaders(origin, methods = "GET, POST, OPTIONS") {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": methods,
    "Access-Control-Allow-Headers": "Content-Type, X-Cron-Secret",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
  };
}

function json(data, status, headers) {
  return new Response(JSON.stringify(data), { status, headers });
}

async function quote(s) {
  const u = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(s)}?range=1d&interval=1m&includePrePost=false`;
  const r = await fetch(u, { headers: { "User-Agent": "Mozilla/5.0" }, cf: { cacheTtl: 15 } });
  const j = await r.json();
  const m = j?.chart?.result?.[0]?.meta;
  if (!m || typeof m.regularMarketPrice !== "number") throw new Error("no data");
  return {
    symbol: s,
    price: m.regularMarketPrice,
    currency: m.currency,
    time: m.regularMarketTime,
    prevClose: m.previousClose ?? m.chartPreviousClose ?? null,
  };
}

function b64urlToBytes(s) {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const b64 = (s + pad).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64url(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function concatBytes(...parts) {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function textBytes(str) {
  return new TextEncoder().encode(str);
}

async function sha256Hex(str) {
  const dig = await crypto.subtle.digest("SHA-256", textBytes(str));
  return [...new Uint8Array(dig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}


async function endpointKey(endpoint) {
  return SUB_PREFIX + (await sha256Hex(endpoint));
}


async function vapidKeyPair(env) {
  const d = env.VAPID_PRIVATE_KEY;
  const pub = env.VAPID_PUBLIC_KEY;
  const pubBytes = b64urlToBytes(pub);
  if (pubBytes.length !== 65 || pubBytes[0] !== 0x04) throw new Error("bad vapid public");
  const x = bytesToB64url(pubBytes.slice(1, 33));
  const y = bytesToB64url(pubBytes.slice(33, 65));
  const priv = await crypto.subtle.importKey(
    "jwk",
    { kty: "EC", crv: "P-256", d, x, y, ext: true },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );
  return { priv, pub, pubBytes };
}

async function createVapidJwt(env, audience) {
  const { priv, pub } = await vapidKeyPair(env);
  const header = bytesToB64url(textBytes(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const exp = Math.floor(Date.now() / 1000) + 12 * 3600;
  const claims = bytesToB64url(
    textBytes(JSON.stringify({ aud: audience, exp, sub: env.VAPID_SUBJECT || "mailto:muellkuebel@me.com" }))
  );
  const data = textBytes(`${header}.${claims}`);
  const sigDer = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, priv, data));
  // WebCrypto may return IEEE P1363 (r||s) already on CF Workers; normalize
  const sig = derEcdsaToJose(sigDer);
  return { jwt: `${header}.${claims}.${bytesToB64url(sig)}`, pub };
}

function derEcdsaToJose(sig) {
  // If already 64 bytes, assume raw r||s
  if (sig.length === 64) return sig;
  // Parse DER SEQUENCE { INTEGER r, INTEGER s }
  let i = 0;
  if (sig[i++] !== 0x30) return sig.slice(0, 64);
  let seqLen = sig[i++];
  if (seqLen & 0x80) {
    const n = seqLen & 0x7f;
    seqLen = 0;
    for (let k = 0; k < n; k++) seqLen = (seqLen << 8) | sig[i++];
  }
  if (sig[i++] !== 0x02) return sig.slice(0, 64);
  let rLen = sig[i++];
  let r = sig.slice(i, i + rLen);
  i += rLen;
  if (sig[i++] !== 0x02) return sig.slice(0, 64);
  let sLen = sig[i++];
  let s = sig.slice(i, i + sLen);
  // Strip leading zeros, left-pad to 32
  while (r.length > 32 && r[0] === 0) r = r.slice(1);
  while (s.length > 32 && s[0] === 0) s = s.slice(1);
  const out = new Uint8Array(64);
  out.set(r, 32 - r.length);
  out.set(s, 64 - s.length);
  return out;
}

async function hkdfExtract(salt, ikm) {
  const saltKey = await crypto.subtle.importKey(
    "raw",
    salt,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", saltKey, ikm));
}

async function hkdfExpand(prk, info, length) {
  const key = await crypto.subtle.importKey("raw", prk, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const out = new Uint8Array(length);
  let t = new Uint8Array(0);
  let offset = 0;
  let counter = 1;
  while (offset < length) {
    const input = concatBytes(t, info, new Uint8Array([counter]));
    t = new Uint8Array(await crypto.subtle.sign("HMAC", key, input));
    const take = Math.min(t.length, length - offset);
    out.set(t.slice(0, take), offset);
    offset += take;
    counter++;
  }
  return out;
}

async function encryptPushPayload(payloadStr, p256dhB64, authB64) {
  const clientPublic = b64urlToBytes(p256dhB64);
  const authSecret = b64urlToBytes(authB64);
  if (clientPublic.length !== 65 || clientPublic[0] !== 0x04) throw new Error("bad p256dh");
  if (authSecret.length !== 16) throw new Error("bad auth");

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const local = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const localPubRaw = new Uint8Array(await crypto.subtle.exportKey("raw", local.publicKey));

  const clientKey = await crypto.subtle.importKey("raw", clientPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: clientKey }, local.privateKey, 256));

  // IKM per RFC 8291
  const authInfo = concatBytes(textBytes("WebPush: info\0"), clientPublic, localPubRaw);
  // HKDF-Extract(salt=auth_secret, ikm=ecdh_secret)
  const prk1 = await hkdfExtract(authSecret, shared);
  const ikm = await hkdfExpand(prk1, authInfo, 32);

  const prk2 = await hkdfExtract(salt, ikm);
  const cek = await hkdfExpand(prk2, textBytes("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdfExpand(prk2, textBytes("Content-Encoding: nonce\0"), 12);

  const plaintext = concatBytes(textBytes(payloadStr), new Uint8Array([2])); // final record delimiter
  const aesKey = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["encrypt"]);
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, plaintext)
  );

  // Header: salt || rs(4096) || idlen || keyid(localPub)
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096);
  const header = concatBytes(salt, rs, new Uint8Array([localPubRaw.length]), localPubRaw);
  return concatBytes(header, encrypted);
}

async function sendWebPush(env, subscription, payloadObj) {
  const endpoint = subscription.endpoint;
  const keys = subscription.keys || {};
  if (!endpoint || !keys.p256dh || !keys.auth) throw new Error("bad subscription");

  const body = await encryptPushPayload(JSON.stringify(payloadObj), keys.p256dh, keys.auth);
  const aud = new URL(endpoint).origin;
  const { jwt, pub } = await createVapidJwt(env, aud);

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `vapid t=${jwt}, k=${pub}`,
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: "86400",
      Urgency: "normal",
    },
    body,
  });
  return res;
}

function displaySignal(held, z, rule) {
  const zBuy = Number(rule?.zBuy ?? -1.5);
  const zSell = Number(rule?.zSell ?? 1.5);
  if (held) return z >= zSell ? "Verkaufen" : "Halten";
  return z <= zBuy ? "Kaufen" : "Warten";
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

function notifyTitle(signal, name) {
  // Exact style: "Kaufen: Robinhood" / "Verkaufen: Robinhood"
  return `${signal}: ${name}`;
}

async function fetchMarket() {
  const r = await fetch(DATA_URL + "?t=" + Date.now(), { cf: { cacheTtl: 60 } });
  if (!r.ok) throw new Error("data.json " + r.status);
  const data = await r.json();
  const tickers = (data.stocks || []).map((s) => s.ticker);
  if (!tickers.length) throw new Error("no tickers");
  // Live quotes in chunks of 20
  const quotes = {};
  for (let i = 0; i < tickers.length; i += 15) {
    const chunk = tickers.slice(i, i + 15);
    const settled = await Promise.allSettled(chunk.map(quote));
    settled.forEach((res, idx) => {
      if (res.status === "fulfilled") quotes[chunk[idx]] = res.value;
    });
  }
  const rule = data.rule || {};
  const stocks = [];
  for (const st of data.stocks || []) {
    const q = quotes[st.ticker];
    const price = q && typeof q.price === "number" ? q.price : Number(st.price);
    const sma = Number(st.sma20);
    const sd = Number(st.sd20);
    let z = Number(st.z);
    let reason = st.reason || "";
    if (sma && sd && Number.isFinite(price)) {
      z = Math.round(((price - sma) / sd) * 1000) / 1000;
      reason = reasonLine(price, sma);
    }
    stocks.push({
      ticker: st.ticker,
      name: st.name,
      currency: st.currency || (q && q.currency) || "USD",
      price,
      priceDisplay: priceDisplayOf(price, st.currency || "USD"),
      sma20: sma,
      sd20: sd,
      z,
      reason,
    });
  }
  return { rule, stocks };
}

async function listSubs(env) {
  const out = [];
  let cursor;
  do {
    const page = await env.AMPEL_KV.list({ prefix: SUB_PREFIX, cursor });
    for (const k of page.keys || []) {
      const raw = await env.AMPEL_KV.get(k.name, "json");
      if (raw) out.push({ key: k.name, ...raw });
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return out;
}

async function processSubscriber(env, market, sub, { notify }) {
  const heldSet = new Set((sub.held || []).map((t) => String(t).toUpperCase()));
  const prev = sub.signals || {};
  const next = {};
  const pushes = [];
  for (const st of market.stocks) {
    const held = heldSet.has(st.ticker);
    const signal = displaySignal(held, st.z, market.rule);
    next[st.ticker] = signal;
    if (!notify) continue;
    const was = prev[st.ticker];
    // Only on transition INTO Kaufen or Verkaufen
    if ((signal === "Kaufen" || signal === "Verkaufen") && was !== signal) {
      pushes.push({
        title: notifyTitle(signal, st.name),
        body: `${st.priceDisplay} · ${st.reason}`,
        data: { ticker: st.ticker, signal, url: "https://muellkuebel.github.io/aktien-ampel/" },
      });
    }
  }
  const firstRun = !sub.signals || Object.keys(sub.signals).length === 0;
  const shouldNotify = notify && !firstRun;
  let gone = false;
  if (shouldNotify) {
    for (const p of pushes) {
      try {
        const res = await sendWebPush(env, sub.subscription, p);
        if (res.status === 404 || res.status === 410) {
          gone = true;
          break;
        }
      } catch (e) {
        // keep going; network blips
        console.log("push fail", e && e.message);
      }
    }
  }
  if (gone) {
    await env.AMPEL_KV.delete(sub.key);
    return { deleted: true, pushed: 0 };
  }
  const record = {
    subscription: sub.subscription,
    held: [...heldSet],
    signals: next,
    updatedAt: new Date().toISOString(),
    createdAt: sub.createdAt || new Date().toISOString(),
  };
  await env.AMPEL_KV.put(sub.key, JSON.stringify(record));
  return { deleted: false, pushed: shouldNotify ? pushes.length : 0, firstRun };
}

async function runSignalCheck(env) {
  const market = await fetchMarket();
  const subs = await listSubs(env);
  let pushed = 0;
  let deleted = 0;
  for (const sub of subs) {
    const r = await processSubscriber(env, market, sub, { notify: true });
    if (r.deleted) deleted++;
    else pushed += r.pushed;
  }
  return { ok: true, subscribers: subs.length, pushed, deleted, checked: market.stocks.length };
}

function normalizeHeld(held) {
  if (!Array.isArray(held)) return [];
  return [...new Set(held.map((t) => String(t).toUpperCase()).filter((t) => SYM.test(t)))];
}

function validSubscription(sub) {
  if (!(
    sub &&
    typeof sub.endpoint === "string" &&
    sub.endpoint.startsWith("https://") &&
    sub.keys &&
    typeof sub.keys.p256dh === "string" &&
    typeof sub.keys.auth === "string"
  )) return false;
  try {
    const p = b64urlToBytes(sub.keys.p256dh);
    const a = b64urlToBytes(sub.keys.auth);
    return p.length === 65 && p[0] === 0x04 && a.length === 16;
  } catch {
    return false;
  }
}

async function handleSubscribe(env, body) {
  if (!validSubscription(body.subscription)) return { status: 400, data: { error: "subscription" } };
  const held = normalizeHeld(body.held);
  const key = await endpointKey(body.subscription.endpoint);
  const existing = (await env.AMPEL_KV.get(key, "json")) || {};
  const record = {
    subscription: {
      endpoint: body.subscription.endpoint,
      expirationTime: body.subscription.expirationTime ?? null,
      keys: {
        p256dh: body.subscription.keys.p256dh,
        auth: body.subscription.keys.auth,
      },
    },
    held,
    // Empty signals => first scheduled run stores without notifying
    signals: existing.signals && Object.keys(existing.signals).length ? existing.signals : {},
    createdAt: existing.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await env.AMPEL_KV.put(key, JSON.stringify(record));
  return { status: 200, data: { ok: true, held } };
}

async function handleHeld(env, body) {
  if (!validSubscription(body.subscription) && !body.endpoint) return { status: 400, data: { error: "subscription" } };
  const endpoint = body.subscription?.endpoint || body.endpoint;
  const key = await endpointKey(endpoint);
  const existing = await env.AMPEL_KV.get(key, "json");
  if (!existing) return { status: 404, data: { error: "not_found" } };
  existing.held = normalizeHeld(body.held);
  existing.updatedAt = new Date().toISOString();
  await env.AMPEL_KV.put(key, JSON.stringify(existing));
  return { status: 200, data: { ok: true, held: existing.held } };
}

async function handleUnsubscribe(env, body) {
  const endpoint = body.subscription?.endpoint || body.endpoint;
  if (!endpoint) return { status: 400, data: { error: "endpoint" } };
  const key = await endpointKey(endpoint);
  await env.AMPEL_KV.delete(key);
  return { status: 200, data: { ok: true } };
}

async function handleTest(env, body) {
  if (!validSubscription(body.subscription)) return { status: 400, data: { error: "subscription" } };
  const name = body.name || "Robinhood";
  const signal = body.signal === "Verkaufen" ? "Verkaufen" : "Kaufen";
  const payload = {
    title: notifyTitle(signal, name),
    body: body.body || "91,43 $ · Test der Push-Benachrichtigung",
    data: { ticker: body.ticker || "HOOD", signal, url: "https://muellkuebel.github.io/aktien-ampel/", test: true },
  };
  const res = await sendWebPush(env, body.subscription, payload);
  const text = await res.text().catch(() => "");
  if (res.status === 404 || res.status === 410) {
    const key = await endpointKey(body.subscription.endpoint);
    await env.AMPEL_KV.delete(key);
    return { status: 410, data: { error: "gone", status: res.status } };
  }
  if (!res.ok) return { status: 502, data: { error: "push_failed", status: res.status, body: text.slice(0, 200) } };
  return { status: 200, data: { ok: true } };
}

async function handleQuotes(url, headers) {
  const list = (url.searchParams.get("s") || "").toUpperCase().split(",").filter(Boolean);
  if (!list.length || list.length > 20 || !list.every((x) => SYM.test(x)))
    return json({ error: "symbol" }, 400, headers);
  if (list.length === 1) {
    try {
      return json(await quote(list[0]), 200, headers);
    } catch {
      return json({ error: "fetch" }, 502, headers);
    }
  }
  const res = await Promise.allSettled(list.map(quote));
  const quotes = {};
  res.forEach((r, i) => {
    if (r.status === "fulfilled") quotes[list[i]] = r.value;
  });
  return json({ quotes }, Object.keys(quotes).length ? 200 : 502, headers);
}

export default {
  async fetch(req, env) {
    const origin = req.headers.get("Origin") || "";
    const headers = corsHeaders(origin);
    if (req.method === "OPTIONS") return new Response(null, { headers });

    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    // Legacy quote endpoint: GET / or GET /?s=
    if (req.method === "GET" && (path === "/" || path === "")) {
      if (url.searchParams.has("s")) return handleQuotes(url, headers);
      // Public VAPID key for the app
      return json({ ok: true, vapidPublicKey: env.VAPID_PUBLIC_KEY || null, service: "aktien-ampel-kurs" }, 200, headers);
    }
    if (req.method === "GET" && path === "/vapidPublicKey") {
      return json({ publicKey: env.VAPID_PUBLIC_KEY || null }, 200, headers);
    }

    if (req.method === "POST") {
      let body = {};
      try {
        body = await req.json();
      } catch {
        return json({ error: "json" }, 400, headers);
      }
      try {
        if (path === "/subscribe") {
          const r = await handleSubscribe(env, body);
          return json(r.data, r.status, headers);
        }
        if (path === "/held") {
          const r = await handleHeld(env, body);
          return json(r.data, r.status, headers);
        }
        if (path === "/unsubscribe") {
          const r = await handleUnsubscribe(env, body);
          return json(r.data, r.status, headers);
        }
        if (path === "/test") {
          const r = await handleTest(env, body);
          return json(r.data, r.status, headers);
        }
        if (path === "/run") {
          const secret = req.headers.get("X-Cron-Secret") || body.secret || "";
          if (!env.CRON_SECRET || secret !== env.CRON_SECRET) {
            return json({ error: "unauthorized" }, 401, headers);
          }
          const result = await runSignalCheck(env);
          return json(result, 200, headers);
        }
      } catch (e) {
        return json({ error: "server", message: String(e && e.message || e) }, 500, headers);
      }
      return json({ error: "not_found" }, 404, headers);
    }

    return json({ error: "method" }, 405, headers);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      runSignalCheck(env)
        .then((r) => console.log("cron", JSON.stringify(r)))
        .catch((e) => console.log("cron error", e && e.message))
    );
  },
};
