#!/usr/bin/env python3
"""Fetch Yahoo Finance chart data for Aktien Ampel and write data.json.

Signal rule (from ../config.json):
  SMA20 = mean of last 20 daily closes
  SD20  = sample stdev of those 20 closes
  z     = (last close − SMA20) / SD20
  NOT held: z ≤ zBuy → Kaufen, else Warten
  HELD: z ≥ zSell → Verkaufen, else Halten
  UI maps final label from holdings + z (localStorage)

Also fetches EURUSD=X for USD→EUR conversion in the Bilanz.
"""
from __future__ import annotations

import json
import statistics
import sys
import time
import urllib.request
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/120.0.0.0 Safari/537.36"
)
BERLIN = ZoneInfo("Europe/Berlin")
APP_DIR = Path(__file__).resolve().parent.parent
CONFIG_PATH = APP_DIR / "config.json"
OUT_PATH = APP_DIR / "data.json"


def load_config() -> dict:
    with CONFIG_PATH.open(encoding="utf-8") as f:
        return json.load(f)


def fetch_chart(ticker: str, range_: str = "3mo", interval: str = "1d") -> dict:
    url = (
        f"https://query1.finance.yahoo.com/v8/finance/chart/{ticker}"
        f"?range={range_}&interval={interval}"
    )
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = json.loads(resp.read().decode())
    result = data.get("chart", {}).get("result")
    if not result:
        err = data.get("chart", {}).get("error")
        raise RuntimeError(f"no chart data for {ticker}: {err}")
    return result[0]


def closes_from_result(result: dict) -> list[float]:
    quote = (result.get("indicators") or {}).get("quote") or []
    if not quote:
        return []
    out = []
    for c in quote[0].get("close") or []:
        if c is not None:
            out.append(float(c))
    return out


def last_price(result: dict) -> float:
    meta = result.get("meta") or {}
    last = meta.get("regularMarketPrice")
    if last is not None:
        return float(last)
    closes = closes_from_result(result)
    if not closes:
        raise RuntimeError("no price")
    return closes[-1]


def fetch_eurusd() -> dict:
    """EURUSD=X: USD per 1 EUR. EUR = USD / rate."""
    result = fetch_chart("EURUSD=X", range_="5d", interval="1d")
    rate = last_price(result)
    if rate <= 0:
        raise RuntimeError(f"invalid EURUSD rate: {rate}")
    return {
        "pair": "EURUSD=X",
        "usdPerEur": round(rate, 6),
        "note": "USD amount / usdPerEur = EUR amount",
    }


def signal_from_z(z: float, z_buy: float, z_sell: float) -> str:
    """Baseline label assuming NOT held. UI remaps when position is held."""
    if z <= z_buy:
        return "Kaufen"
    return "Warten"


def reason_line(last: float, sma20: float) -> str:
    if sma20 == 0:
        return "Kein Abstand zum 20-Tage-Schnitt"
    pct = (last - sma20) / sma20 * 100.0
    n = int(round(abs(pct)))
    if n == 0:
        return "nahe am 20-Tage-Schnitt"
    if pct < 0:
        return f"{n} % unter dem 20-Tage-Schnitt"
    return f"{n} % über dem 20-Tage-Schnitt"


def format_price(price: float, currency: str) -> str:
    if currency == "EUR":
        return f"{price:,.2f} €".replace(",", "X").replace(".", ",").replace("X", ".")
    return f"{price:,.2f} $".replace(",", "X").replace(".", ",").replace("X", ".")


def process_ticker(entry: dict, rule: dict) -> dict:
    ticker = entry["ticker"]
    name = entry["name"]
    currency = entry.get("currency", "USD")
    window = int(rule["smaWindow"])
    z_buy = float(rule["zBuy"])
    z_sell = float(rule["zSell"])

    result = fetch_chart(ticker)
    meta = result.get("meta") or {}
    closes = closes_from_result(result)
    if len(closes) < window:
        raise RuntimeError(f"{ticker}: need >= {window} closes, got {len(closes)}")

    window_closes = closes[-window:]
    sma20 = statistics.mean(window_closes)
    sd20 = statistics.stdev(window_closes)

    last = meta.get("regularMarketPrice")
    last = float(last) if last is not None else closes[-1]
    z = 0.0 if sd20 == 0 else (last - sma20) / sd20

    prev = meta.get("chartPreviousClose")
    if prev is None:
        prev = closes[-2] if len(closes) >= 2 else last
    prev = float(prev)
    if len(closes) >= 2 and abs(closes[-1] - last) < max(0.01, abs(last) * 1e-6):
        prev = closes[-2]

    day_change_pct = ((last - prev) / prev * 100.0) if prev else 0.0
    signal = signal_from_z(z, z_buy, z_sell)
    dist_pct = ((last - sma20) / sma20 * 100.0) if sma20 else 0.0

    return {
        "ticker": ticker,
        "name": name,
        "currency": currency,
        "price": round(last, 4),
        "priceDisplay": format_price(last, currency),
        "dayChangePct": round(day_change_pct, 2),
        "sma20": round(sma20, 4),
        "sd20": round(sd20, 4),
        "z": round(z, 3),
        "distFromSma20Pct": round(dist_pct, 2),
        "signal": signal,
        "reason": reason_line(last, sma20),
    }


def main() -> int:
    cfg = load_config()
    rule = cfg["signalRule"]
    stocks = []
    errors = []

    fx = None
    try:
        fx = fetch_eurusd()
        print(f"EURUSD={fx['usdPerEur']}")
        time.sleep(0.35)
    except Exception as exc:  # noqa: BLE001
        errors.append({"ticker": "EURUSD=X", "error": str(exc)})
        print(f"ERROR EURUSD=X: {exc}", file=sys.stderr)

    for entry in cfg["tickers"]:
        try:
            stocks.append(process_ticker(entry, rule))
            time.sleep(0.35)
        except Exception as exc:  # noqa: BLE001
            errors.append({"ticker": entry["ticker"], "error": str(exc)})
            print(f"ERROR {entry['ticker']}: {exc}", file=sys.stderr)

    if not stocks:
        print("FATAL: no stocks fetched", file=sys.stderr)
        return 1

    now = datetime.now(BERLIN)
    payload = {
        "updated": now.isoformat(timespec="seconds"),
        "updatedDisplay": now.strftime("%d.%m.%Y %H:%M") + " (Berlin)",
        "source": "Yahoo Finance chart API v8, range=3mo interval=1d",
        "rule": rule,
        "version": cfg.get("version", "V1.1"),
        "fx": fx,
        "stocks": stocks,
        "errors": errors,
    }
    OUT_PATH.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {OUT_PATH} with {len(stocks)} stocks at {payload['updatedDisplay']}")
    for s in stocks:
        print(f"  {s['ticker']:8} {s['signal']:9} z={s['z']:+.3f}  {s['reason']}")
    return 0 if len(stocks) == 12 and fx else 2


if __name__ == "__main__":
    raise SystemExit(main())
