// Aktien Ampel Kursdienst: liefert den aktuellen Kurs eines Symbols von Yahoo Finance mit CORS.
const ALLOWED_ORIGINS = ["https://muellkuebel.github.io"];
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
    const s = (new URL(req.url).searchParams.get("s") || "").toUpperCase();
    if (!/^[A-Z0-9.\-^=]{1,15}$/.test(s)) return new Response(JSON.stringify({ error: "symbol" }), { status: 400, headers: cors });
    const u = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(s)}?range=1d&interval=1m&includePrePost=false`;
    try {
      const r = await fetch(u, { headers: { "User-Agent": "Mozilla/5.0" }, cf: { cacheTtl: 15 } });
      const j = await r.json();
      const m = j?.chart?.result?.[0]?.meta;
      if (!m || typeof m.regularMarketPrice !== "number") throw new Error("no data");
      return new Response(JSON.stringify({ symbol: s, price: m.regularMarketPrice, currency: m.currency, time: m.regularMarketTime }), { headers: cors });
    } catch (e) {
      return new Response(JSON.stringify({ error: "fetch" }), { status: 502, headers: cors });
    }
  },
};
