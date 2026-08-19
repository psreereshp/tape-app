#!/usr/bin/env python3
"""
Regenerates docs/tickers.json — the local ticker/company-name database
that powers the search-as-you-type dropdown in the app.

Sources (both free, no key, no signup):
  - US (NASDAQ/NYSE/AMEX): api.nasdaq.com's public stock-screener endpoint.
  - Canada (TSX/TSXV): tsx.com's public company-directory endpoint.

Output format is deliberately terse — a JSON array of 3-element arrays
[symbol, name, exchange] — since this file ships to every visitor's
browser and gets parsed on every page load:

  [["AAPL", "Apple Inc.", "NASDAQ"], ["RY.TO", "Royal Bank of Canada", "TSX"], ...]

`symbol` is already in the form Yahoo Finance's endpoints accept (the
same endpoints the Worker uses for quotes/charts) — Canadian tickers get
their exchange suffix appended (.TO for TSX, .V for TSX Venture) and any
share-class dot (e.g. "IGBT.UN") is rewritten to a dash, matching Yahoo's
convention ("IGBT-UN.TO").

This is a point-in-time snapshot, not a live feed — re-run this script
and commit docs/tickers.json occasionally to pick up new listings/delistings.
Nothing here runs automatically; there's no cron wired up for it, same as
the rest of this project's low-maintenance philosophy.

Usage:
    python3 scripts/build_tickers.py
"""

import json
import re
import sys
import urllib.request
from pathlib import Path

UA = "Mozilla/5.0 (compatible; TapeTickerBuild/1.0)"
OUT_PATH = Path(__file__).resolve().parent.parent / "docs" / "tickers.json"

US_EXCHANGES = {
    "nasdaq": "NASDAQ",
    "nyse": "NYSE",
    "amex": "AMEX",
}

CA_DIRECTORIES = {
    "tsx": "TSX",
    "tsxv": "TSXV",
}

CA_SUFFIX = {
    "TSX": ".TO",
    "TSXV": ".V",
}

# Cosmetic cleanup for US screener names — they include boilerplate suffixes
# that just add noise to a search dropdown.
US_NAME_STRIP = re.compile(
    r"\s+(Common Stock|Ordinary Shares|Class [A-Z] Common Stock|American Depositary Shares).*$",
    re.IGNORECASE,
)


def fetch_json(url, headers=None, method="GET", body=None):
    req = urllib.request.Request(url, method=method)
    req.add_header("User-Agent", UA)
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    data = body.encode("utf-8") if body else None
    with urllib.request.urlopen(req, data=data, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def to_yahoo_symbol(raw_symbol, suffix=""):
    sym = raw_symbol.strip().upper().replace(".", "-").replace("/", "-")
    return f"{sym}{suffix}"


def fetch_us():
    out = []
    seen = set()
    for param, label in US_EXCHANGES.items():
        url = (
            "https://api.nasdaq.com/api/screener/stocks"
            f"?tableonly=true&limit=10000&offset=0&exchange={param}"
        )
        data = fetch_json(url)
        rows = (data.get("data") or {}).get("table", {}).get("rows") or []
        for row in rows:
            raw_symbol = (row.get("symbol") or "").strip()
            name = (row.get("name") or "").strip()
            if not raw_symbol or not name or "^" in raw_symbol:
                continue  # preferred-share series — NASDAQ's "^" notation doesn't match Yahoo's symbol format
            symbol = to_yahoo_symbol(raw_symbol)
            if symbol in seen:
                continue
            seen.add(symbol)
            name = US_NAME_STRIP.sub("", name).strip()
            out.append([symbol, name, label])
        print(f"  {label}: {len(rows)} rows", file=sys.stderr)
    return out


def fetch_ca():
    out = []
    seen = set()
    for path, label in CA_DIRECTORIES.items():
        url = f"https://www.tsx.com/json/company-directory/search/{path}/*"
        data = fetch_json(url)
        rows = data.get("results") or []
        suffix = CA_SUFFIX[label]
        for row in rows:
            raw_symbol = (row.get("symbol") or "").strip()
            name = (row.get("name") or "").strip()
            if not raw_symbol or not name:
                continue
            symbol = to_yahoo_symbol(raw_symbol, suffix)
            if symbol in seen:
                continue
            seen.add(symbol)
            out.append([symbol, name, label])
        print(f"  {label}: {len(rows)} rows", file=sys.stderr)
    return out


def main():
    print("Fetching US listings (NASDAQ/NYSE/AMEX)...", file=sys.stderr)
    us = fetch_us()
    print("Fetching Canadian listings (TSX/TSXV)...", file=sys.stderr)
    ca = fetch_ca()

    combined = us + ca
    combined.sort(key=lambda row: row[0])

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(combined, separators=(",", ":")), encoding="utf-8")

    size_kb = OUT_PATH.stat().st_size / 1024
    print(f"Wrote {len(combined)} tickers ({size_kb:.0f} KB) to {OUT_PATH}", file=sys.stderr)


if __name__ == "__main__":
    main()
