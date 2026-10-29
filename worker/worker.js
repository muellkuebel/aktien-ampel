// Aktien Ampel Kursdienst: liefert aktuelle Kurse von Yahoo Finance mit CORS.
// GET /?s=HOOD           -> {symbol, price, currency, time, prevClose}
// GET /?s=HOOD,RHM.DE,.. -> {quotes: {HOOD: {...}, ...}}
const ALLOWED_ORIGINS = ["https://muellkuebel.github.io"];
const SYM = /^[A-Z0-9.\-^=]{1,15}$/;

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

export default {
  async fetch(req) {
    const origin = req.headers.get("Origin") || "";
    const cors = {
      "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Vary": "Origin",
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
    };
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    const list = (new URL(req.url).searchParams.get("s") || "").toUpperCase().split(",").filter(Boolean);
    if (!list.length || list.length > 20 || !list.every((x) => SYM.test(x)))
      return new Response(JSON.stringify({ error: "symbol" }), { status: 400, headers: cors });
    if (list.length === 1) {
      try {
        return new Response(JSON.stringify(await quote(list[0])), { headers: cors });
      } catch (e) {
        return new Response(JSON.stringify({ error: "fetch" }), { status: 502, headers: cors });
      }
    }
    const res = await Promise.allSettled(list.map(quote));
    const quotes = {};
    res.forEach((r, i) => { if (r.status === "fulfilled") quotes[list[i]] = r.value; });
    return new Response(JSON.stringify({ quotes }), { status: Object.keys(quotes).length ? 200 : 502, headers: cors });
  },
};
