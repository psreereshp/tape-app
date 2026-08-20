# Tape — hosted web app

A mobile-friendly web app version of the `swing-trade-analyst` skill, so friends without Claude Pro/Cowork can use it. Three tabs:

- **Markets** (the default landing view) — S&P 500 / Nasdaq / Dow sparkline cards and the day's market headlines, so the app opens to something populated instead of an empty search box.
- **Analyze** — type a ticker, get the same traffic-light dashboard (verdict, entry/stop/target, 52-week chart, expandable technical/sentiment detail) the skill produces.
- **Paper Trading** — practice swing trading with a virtual $100,000 portfolio and live prices, with optional push notifications when a position hits its stop or target.

Everything runs as a normal website friends can "Add to Home Screen." No paid API keys required — the LLM behind Analyze runs on Google Gemini's free tier, and all market data comes from Yahoo Finance's public endpoints, which need no key and no signup either.

## How it works

```
Friend's phone/browser
   │  types "NVDA", taps Analyze
   ▼
docs/  (static HTML/CSS/JS — hosted on GitHub Pages)
   │  POST { ticker: "NVDA" }
   ▼
worker/worker.js  (Cloudflare Worker — holds your Gemini key server-side)
   │  fetches quote + price history from Yahoo Finance,
   │  computes RSI/MACD locally, fetches ticker news from Yahoo
   ▼
Yahoo Finance public endpoints (no key required)
   │  raw price history + company info + headlines
   ▼
worker/worker.js
   │  sends data + skill instructions to Gemini, forces structured JSON output
   ▼
Google Gemini API (gemini-3.6-flash, free tier)
   │  dashboard JSON
   ▼
back to the browser → renders the dashboard, with a "Paper trade this setup" button
```

Paper trading runs mostly on-device: your friend's portfolio (cash, positions, trade history) lives in their browser's `localStorage`, not on any server — private to their device, gone if they clear browser data, no login needed. The one thing that *does* need a server is stop/target alerts that fire even when the app is closed:

```
Friend opens a position with a stop/target set
   │  POST /watch { ticker, stop, target, push subscription }
   ▼
Cloudflare KV  (a small server-side list of "positions to watch")
   ▲
   │  every few hours, the Worker's Cron Trigger wakes up
   │
worker/worker.js scheduled()
   │  checks live prices for every watched ticker (via Yahoo Finance)
   │  if a stop/target was crossed → sends an encrypted Web Push notification
   ▼
Friend's phone — notification arrives even if the app/browser is closed
   │  tap it → app opens, fetches a fresh price, asks "close this position?"
   ▼
Position closes in their local portfolio, using the fresh price (not the stale push price)
```

The Markets tab works the same read-through-cache way: it asks the Worker for `/market`, the Worker serves whatever's in KV if it's fresh (indices ≤6h old, news ≤20min old), and only fetches live from Yahoo Finance when the cache is stale or empty. That's just about keeping page loads fast — there's no daily quota to protect anymore.

Three pieces to deploy, all free:
1. **Cloudflare Worker** — the backend. Holds your Gemini and Web Push (VAPID) keys server-side. Deployed via a GitHub connection (Cloudflare builds and deploys automatically on every push — see Step 2).
2. **Cloudflare KV + Cron Trigger** — a tiny key-value store plus a scheduled job, both added as bindings/triggers in the Worker's dashboard page. Powers push alerts *and* keeps the Markets tab fast. Skippable, but both features degrade without it — see Step 2.5.
3. **GitHub Pages** — the frontend. Static files, deployed by pushing to a GitHub repo. This is the URL you send your friends.

Nothing here talks to your local machine after deployment — all three pieces run in the cloud.

---

## Step 1 — Get a free Google Gemini API key

1. Go to **https://aistudio.google.com/apikey** and sign in with a Google account.
2. **Create API key** → **Create API key in new project** (or an existing one). No card required — the free tier has no billing account attached.
3. Save the key somewhere — you'll paste it into Cloudflare in Step 2.

The free tier has no dollar cost, just a daily/per-minute request cap (check your exact numbers at **https://aistudio.google.com/rate-limit** once the key exists) — see **Costs** below.

## Step 2 — Deploy the Worker (backend)

This repo includes a [`wrangler.jsonc`](wrangler.jsonc) at the root, so Cloudflare can build and deploy the Worker directly from a GitHub push — no CLI, no manual paste-into-dashboard editing.

1. Push this repo to a GitHub repository (a **public** repo is required for the free GitHub Pages step later, since `docs/` is served from the same repo).
2. Go to **https://dash.cloudflare.com** → sign up free if you don't have an account.
3. **Workers & Pages → Create → Create Worker**. Give it a name (e.g. `tape-proxy`), deploy the default "Hello World" once.
4. Open the Worker → **Settings** → find the **Build** section → connect it to your GitHub repo. Cloudflare will detect `wrangler.jsonc` and use it for the KV binding + Cron Trigger automatically once you add them (Step 2.5) and push.
5. Go to the Worker's **Settings → Variables and Secrets**. Add:
   - `GEMINI_API_KEY` — secret — your key from Step 1
   - `APP_KEY` — secret — make up any random string (e.g. `openssl rand -hex 16`, or just mash the keyboard). This is a lightweight check so random people can't hit your endpoint and burn through your Gemini free-tier quota — see **Security notes** below for its real limits.
6. Optionally add `ALLOWED_ORIGIN` set to your future GitHub Pages URL (Step 4) to restrict CORS — you can add this after Step 4 once you know the URL.
7. Copy the Worker's URL from the top of the page — it looks like `https://tape-proxy.<your-subdomain>.workers.dev`. You'll need this in Step 5.

**You can skip Step 2.5** — everything works without it, just less efficiently: push notifications won't be available, and the Markets tab recomputes live on every page load instead of serving from a shared cache. Worth doing even if you don't care about push, purely for page-load speed.

## Step 2.5 — KV, Cron Trigger, VAPID keys (recommended)

This powers two things: a phone notification the moment a paper position hits its stop or target (even with the app closed), and a shared cache so the Markets tab loads instantly no matter how many friends open it.

1. **Create the KV namespace** (doubles as the "positions to watch" list and the market-data cache):
   - Cloudflare dashboard → **Storage & Databases → KV** → **Create namespace**. Name it e.g. `tape-watchlist`.
   - Update [`wrangler.jsonc`](wrangler.jsonc)'s `kv_namespaces[0].id` to the new namespace's ID, commit, and push — Cloudflare will rebuild and bind it automatically.
2. **Add the Cron Trigger**: already declared in `wrangler.jsonc` (`0 */4 * * *`, every 4 hours) — nothing to do manually, it activates on the next deploy.
3. **Set the VAPID keys** (Web Push authentication — only needed for push notifications, not for the Markets tab — already generated for you):
   - Open [`VAPID_KEYS_PRIVATE.txt`](VAPID_KEYS_PRIVATE.txt) in this project. **Do not commit this file or paste it into `docs/`.**
   - Worker → **Settings → Variables and Secrets** → add:
     - `VAPID_PRIVATE_KEY` — the private key from that file, as a **secret**.
     - `VAPID_PUBLIC_KEY` — the public key from that file, as a **plain variable** (it's meant to be public — it also goes in `docs/config.js` in Step 5).
     - `VAPID_SUBJECT` — a plain variable, `mailto:` + your email. Push services use this to contact you if something's wrong with your server; it's not shown to end users.
   - Want your own keys instead of the generated ones? Any tool that outputs a P-256 EC keypair works, but the easiest is to ask Claude to regenerate them the same way this project's were made (Python `cryptography`, P-256, uncompressed-point + base64url encoding).

## Step 3 — Deploy the frontend (GitHub Pages)

1. In your repo → **Settings → Pages** → Source: **Deploy from a branch** → Branch: `main`, folder `/docs` → **Save**.
2. Wait ~1 minute, then your site is live at `https://<you>.github.io/<repo>/`. **This is the link you send your friends.**

## Step 4 — Wire the frontend to the backend

1. Edit `docs/config.js` in your repo (GitHub's web editor works fine — click the file, pencil icon):
   ```js
   window.SWING_TRADE_CONFIG = {
     API_URL: "https://tape-proxy.<your-subdomain>.workers.dev",
     APP_KEY: "the same random string you set as APP_KEY in Step 2",
     VAPID_PUBLIC_KEY: "the VAPID_PUBLIC_KEY value from VAPID_KEYS_PRIVATE.txt — leave blank to skip push",
   };
   ```
2. Commit directly to `main`. GitHub Pages redeploys automatically in under a minute.
3. If you set `ALLOWED_ORIGIN` on the Worker in Step 2, go back and set it now to your Pages URL (e.g. `https://<you>.github.io`).

## Step 5 — Test it

1. Open your GitHub Pages URL on your phone. You should land on the **Markets** tab with three index cards and a handful of headlines — if it's empty or errors, see **Troubleshooting the Markets tab** below.
2. Switch to **Analyze**, type a ticker (e.g. `NVDA`), and tap Analyze. Takes 15–60 seconds (a few Yahoo Finance fetches + one Gemini call — free-tier requests are occasionally slower than paid ones).
3. **Add to Home Screen**: iOS Safari — Share icon → Add to Home Screen. Android Chrome — menu (⋮) → Add to Home Screen / Install app. The app shows a one-time tip for iOS users automatically. **On iOS, push notifications only work after the app has been added to the Home Screen** (iOS 16.4+) — opening the site in a regular Safari tab won't offer them.
4. Try Paper Trading: switch tabs, tap **+ New paper trade**, buy something with a stop/target set, tap **Enable notifications**. You should get a "Test notification" almost immediately — that confirms the whole push pipeline (Worker crypto → push service → your phone) works end to end.
5. Send the GitHub Pages link to friends — as many as you want, at the same time, with no shared daily quota to worry about.

---

## Markets tab

The default landing view. Two independent pieces, cached separately:

- **Indices**: all six — S&P 500 (**^GSPC**), Nasdaq (**^IXIC**), Dow Jones (**^DJI**), Russell 2000 (**^RUT**), KOSPI (**^KS11**), and SSE Composite (**000001.SS**) — are sourced as the literal index level, not an ETF proxy, so each card shows the real index number rather than a `$` price. (Earlier versions tracked S&P/Nasdaq/Dow via SPY/QQQ/DIA instead; switched once it was clear people wanted the number they'd actually recognize from the news, not an ETF's dollar price.) Sourced from Yahoo Finance's public chart endpoint (6 months of daily closes per index), cached in KV for **15 minutes** — short enough that the pre/post-market read below (see next bullet) doesn't go stale for long between visits, while `force: true` (the Refresh button) always bypasses this and hits Yahoo live regardless.
- **Pre-market / after-hours**: daily-close bars alone never carry pre/post-market moves — a bar's close is fixed the moment the regular session ends. So each index also gets a second, lightweight fetch (`interval=1m&includePrePost=true`) whenever the market is currently in a pre- or post-market session; the session itself is derived from Yahoo's `currentTradingPeriod` window (its own `marketState` field comes back empty on this unofficial endpoint, so it can't be trusted directly). When there's a genuine extended tick, a "Pre-mkt"/"After hrs" line appears under the main price and change — on the card, in the enlarged chart's header, computed against the regular-session price, not the prior day's close. Silently absent during regular hours, when markets are fully closed, or for a raw index symbol (like S&P 500's ^GSPC) whose *level* simply isn't computed outside the regular session — Yahoo just echoes the closing print forever, so an unchanged extended price is treated as nothing to report rather than shown as a permanent "+0.00%".
- **Tap a card to enlarge its chart**: opens an interactive Chart.js line chart in a modal — real date (X) and price (Y) axes, and tap/hover any point for its exact date and value. Two fingers at once compares two points instead: each gets its own crosshair, connected by a line, with a header summary like "Aug 3 → Aug 17 · +$15.00 (+1.98%) · 14d apart" — ordered by which point is earlier in time, not which finger touched down first. Same 6-month history that's already fetched and cached for the sparkline, just rendered bigger — no extra request, no leaving the app to check Yahoo Finance.
- **News**: pulled from Yahoo Finance's public top-stories RSS feed (`finance.yahoo.com/news/rssindex`), parsed by the Worker, cached in KV for **20 minutes**. This is an unofficial, undocumented feed — Yahoo could change its shape or retire it without notice. The Worker's RSS parser is regex-based (Workers have no built-in XML DOM parser) and degrades gracefully: if the fetch or parse fails, the news list just renders empty rather than breaking the rest of the page. If headlines stop showing up, that feed is the first thing to check.
- Both endpoints use the same **read-through cache** pattern as the watch-check: whoever's request finds a stale/missing cache entry pays the live-fetch cost and refills it for everyone else. The Cron Trigger (Step 2.5) also refreshes both every cycle so the *first* visitor after a gap doesn't wait on a live fetch. A failed fetch (Yahoo hiccup, bad response) is never cached as if it were real data — it's retried on the next request instead of getting stuck for the full TTL.
- The **Refresh** button bypasses this cache on purpose — it sends `{ force: true }`, which skips the KV read (but still refills the cache with whatever comes back), so a tap always shows genuinely live index/news data instead of whatever was cached up to 6h/20m ago.

## Earnings calendar

The calendar icon (top right of the header, on every tab) opens a day-by-day earnings calendar — which companies are reporting, before/after market, with EPS and revenue estimates. Sourced from **EarningsWhispers'** public calendar API (`earningswhispers.com/api/caldata/<date>` — the same JSON endpoint their own `/calendar` page's frontend calls), which needs no key. Like the news RSS feed, it's unofficial and undocumented, so it's cached in KV per day for **3 hours** and degrades to an empty list (rather than breaking the modal) if the fetch fails. The list is capped to the day's ~30 most-watched tickers (by EarningsWhispers' own interest ranking) to keep the modal short. The Cron Trigger also pre-warms today's date every cycle, same as indices/news.

## Analyze tab

RSI(14) and MACD(12,26,9) are computed locally in the Worker from a year of Yahoo Finance daily price history — not fetched pre-computed from anywhere, so there's no external technical-indicators API to depend on. Company name/sector and ticker-specific headlines come from Yahoo Finance's search endpoint. There's no pre-scored sentiment feed; Gemini reads the raw headlines itself and writes the sentiment section directly from that (and says so plainly if no analyst-rating data is available, rather than guessing).

The 52-week chart is tappable, same as the Markets tab's index charts — both share one modal and interaction (`docs/chartmodal.js`), so it's built and tested once rather than twice. Tap it for the same interactive view: real date/price axes, single-finger crosshair, and a two-finger compare that connects the two points with a delta summary ("Jun 2 → Aug 3 · -$16.18 (-7.26%) · 62d apart").

## Paper trading

Practice mode with a virtual $100,000 starting balance, live prices, and long-only positions (buy, then close for a gain or loss — no shorting, matching the analysis skill's own long-only setups).

- **Storage**: entirely in the browser's `localStorage` — cash, open positions, and trade history never leave the device. Clearing browser data, switching phones, or using a different browser starts a fresh portfolio; there's no login and no cross-device sync.
- **Prices**: every trade open/close/refresh fetches a live quote via the Worker's `/quote` endpoint (sourced from Yahoo Finance) — never a stale or cached price.
- **From the dashboard**: after analyzing a ticker, a "Paper trade this setup" button prefills the trade form with that ticker (and, for a favourable verdict, the suggested stop/target).
- **Stop/target monitoring**: manual by default — tap "Refresh" on a position or "Refresh prices" to check. With notifications enabled (see below), the server also checks periodically and pushes an alert; tapping it re-fetches a fresh price and asks you to confirm the close (it never auto-closes on a possibly-stale push price).
- **Reset**: "Reset portfolio" at the bottom of the Paper Trading tab wipes everything and starts over from $100,000.

## Market Map

A sub-tab inside Analyze ("Single stock" / "Market Map") for screening a self-curated list of tickers instead of analyzing one at a time.

- **Your list**: add tickers via the same search-as-you-type box described below, capped at 25. Stored in `localStorage` (`tape_market_map_list`) — local to the device, like Paper Trading and Portfolio.
- **The Signal button**: greyed out and disabled while the list is empty; lights up green the moment it holds at least one ticker. Tapping it calls the Worker's `/scan` endpoint with the current list and re-scans on demand — nothing runs automatically or in the background.
- **Deterministic, not LLM-scored**: unlike Analyze, a scan never calls Gemini. The Worker fetches 6 months of daily price history per ticker and scores it locally — 50-day trend, a MACD cross, and RSI — into a 0–100 strength score and a favourable/neutral/unfavourable verdict, the same vocabulary Analyze uses. This is what keeps scanning a whole list fast (no 15–60s LLM wait per ticker) and free (no Gemini quota spent). It's intentionally shallower than Analyze — a triage pass, not the full dashboard.
- **Bridges to Analyze**: tapping any result row switches back to Single stock, fills in that ticker, and runs the real Analyze dashboard.
- **Scope limit**: `/scan` caps a single request at 25 tickers (matching the list cap) to keep one Worker invocation's Yahoo Finance fetches within Cloudflare's free-tier subrequest budget.

## Scenario

A third sub-tab inside Analyze ("Single stock" / "Market Map" / "Scenario") for backtesting: what a deposit made on a past date would be worth today, for 2–3 tickers compared side by side.

- **Each ticker runs independently**, not as a shared portfolio split across tickers — the same deposit amount goes into each one, so a $10,000 "Scenario" with 2 tickers compares two separate $10,000 what-ifs, not one $5,000-plus-$5,000 combined position.
- **Optional recurring investment**: a fixed $ amount added on the first trading day of every month from the investment date onward, tracked as additional share purchases at that day's price — a simple dollar-cost-averaging simulation, not full XIRR/money-weighted-return math.
- **Data**: the Worker's `/backtest` endpoint fetches exact-date-range daily history from Yahoo Finance (`period1`/`period2`, not the `range=` shorthand used elsewhere) for each ticker independently, buys at the first available trading day's close on/after the investment date, and sells (marks to market) at the last available close on/before the end date.
- **Results**: sorted best-to-worst by gain/loss %, each card showing invested vs. current value, start/end price, gain/loss $, and how many recurring buys were made — plus a combined chart of portfolio value over time for all 2–3 tickers on the same $ axis, since they started with the same deposit.
- **Scope limit**: 2–3 tickers per request, matching the "compare a few what-ifs side by side" scope — not a general-purpose multi-asset portfolio backtester.

## Ticker search

Every ticker field (Analyze, new paper trade, watchlist, holdings) has a search-as-you-type dropdown — type a symbol or a company name and pick from the list instead of typing a raw ticker.

- **Data**: `docs/tickers.json`, a flat `[symbol, name, exchange]` array covering NASDAQ/NYSE/AMEX common stocks, **US ETFs**, and TSX/TSXV (which already includes Canadian ETFs in the same directory) — about 15,700 tickers, ~830KB. Sourced from `api.nasdaq.com`'s stock screener, its separate ETF screener (the stock screener excludes ETFs entirely, regardless of query params — SPY/QQQ/DIA/etc. simply aren't in it), and `tsx.com`'s public company directory. Canadian symbols already carry the suffix Yahoo Finance expects (`.TO` for TSX, `.V` for TSX Venture), so picking one from the dropdown produces a ticker the Worker's `/analyze` and `/quote` endpoints can resolve directly.
- **Runs entirely client-side**: `docs/tickers.js` fetches that JSON once per page load and filters it in-browser on every keystroke — no per-keystroke network call, no Worker/KV involvement, works the moment the file is cached by the browser.
- **It's a snapshot, not a live feed.** New listings, delistings, and ticker changes won't show up until you regenerate it:
  ```bash
  python3 scripts/build_tickers.py
  ```
  This overwrites `docs/tickers.json` — commit it like any other frontend asset. Nothing regenerates it automatically.

## Portfolio tab

A real-holdings tracker — separate from Paper Trading's virtual $100,000 account. You enter stocks you actually own (ticker, shares, cost basis); it tracks live P&L against real prices. It never connects to a brokerage, moves money, or executes anything — it's a read-only tracker you update by hand.

- **Storage**: `localStorage`, same as Paper Trading — holdings and watchlist never leave the device, no login, no sync.
- **Holdings**: ticker, shares, and cost basis (entered as $/share or $ total — the app converts to $/share internally). Each entry is its own lot, so buying the same ticker at different times/prices doesn't get merged — add a second holding instead of editing the first if you want to track lots separately.
- **Watchlist**: tickers you're tracking but don't own — just live price and day change, no shares/cost. Lives in the same tab as Holdings, not a separate one.
- **Day change**: derived from the `/quote` endpoint's day-over-day % (same figure Markets/Analyze use) — the Worker doesn't return a $ figure, so the frontend backs into today's $ move per share from price and %.
- **Prices**: fetched live via `/quote` on add, edit, or "Refresh prices" — never cached client-side across page loads (a fresh page load shows "tap refresh" until you do).

## Costs

- **Yahoo Finance**: free, no key, no signup, no daily quota — covers indices, ticker quotes, price history, company info, and news.
- **Google Gemini API**: free tier on `gemini-3.6-flash` — no card, no dollar cost. Only the Analyze flow calls it — paper trading and quotes don't. The free tier caps requests per minute and per day rather than charging by token; check your exact numbers at **https://aistudio.google.com/rate-limit**. If you outgrow it, Gemini also has a cheap pay-as-you-go tier you can switch to by attaching billing in AI Studio — no code changes needed, same API key.
- **Cloudflare Workers**: free tier covers 100,000 requests/day and 1,000 Cron Trigger invocations/day — you won't come close.
- **Cloudflare KV**: free tier covers 100,000 reads/day and 1,000 writes/day — each watch registration is 1 write, each Cron cycle is roughly 1 read per active watch. Fine at friends-and-family scale.
- **GitHub Pages**: free for public repos.

## Security & privacy notes (read before sharing the link widely)

- `APP_KEY` is visible to anyone who opens your browser's dev tools — it's not a real secret, just a speed bump that stops casual scripted abuse and keeps your endpoint out of search-engine crawlers. It does **not** stop a motivated person from finding it and hammering your Worker (and burning through your Gemini free-tier quota for the day).
- For real protection against abuse: in the Cloudflare dashboard, go to **Security → WAF → Rate limiting rules** on your Worker's route and cap requests per IP per minute — this is a few clicks, no code.
- Monitor usage against your free-tier limits at **https://aistudio.google.com/rate-limit**.
- If you ever see unexpected usage, rotate the `APP_KEY` secret in Cloudflare (Settings → Variables) and update `docs/config.js` to match — this instantly cuts off anyone using the old key.
- **What leaves the device for push notifications**: only the ticker, stop/target prices, and a push subscription (an opaque endpoint URL + public key the browser generates — not personal info) are sent to your Worker and stored in KV, for exactly as long as the watch is active (deleted the moment it fires or the position is closed). Cash balance, other positions, and trade history never leave `localStorage`.
- **Never commit [`VAPID_KEYS_PRIVATE.txt`](VAPID_KEYS_PRIVATE.txt)** or paste its private key into anything under `docs/` — that folder is what gets pushed publicly to GitHub Pages.

## Troubleshooting push notifications

This is the most complex part of the app (hand-implemented Web Push encryption, since avoiding an npm build step meant not using the standard `web-push` library) — if it's not working:

1. **Use the built-in test first.** Paper Trading tab → Enable notifications. It sends a test push immediately and reports whether the send succeeded — this isolates "push doesn't work at all" from "push works but the watch-check cron isn't finding your position."
2. **Check you're on iOS 16.4+ and added to Home Screen.** Regular Safari tabs on iOS cannot receive push notifications at all — this is an Apple platform limitation, not a bug here.
3. **Check the Worker's real-time logs**: Cloudflare dashboard → your Worker → **Logs** → **Begin log stream**, then trigger a test notification. Look for the HTTP status the push service returned: `201` is success; `404`/`410` means the subscription expired (re-enable notifications); `401`/`403` usually means `VAPID_PRIVATE_KEY` / `VAPID_PUBLIC_KEY` don't match or are missing.
4. **Confirm the Cron Trigger is actually configured and the KV binding is named exactly `WATCHLIST`** — Worker → Triggers tab, and Settings → Bindings. A missing binding fails silently (the scheduled function just returns early).
5. Still stuck? The Worker's `/test-push` response includes the raw HTTP status and body from the push service — that detail is the most useful thing to include if you ask for help debugging it further.

## Troubleshooting the Markets/Analyze tabs

- **Empty or errors on first load**: normal the very first time — nothing's cached yet, so the Worker does a live fetch. If it still fails, check `GEMINI_API_KEY` is set (Step 2) — Analyze needs it; Markets doesn't.
- **Indices show but news doesn't (or vice versa)**: the two are fetched and cached independently, so one failing doesn't affect the other. Check Worker logs (see push troubleshooting above) for a fetch error on `finance.yahoo.com`.
- **Data feels stale**: indices only refresh every 6 hours by design (see **Markets tab** above) — that's not a bug. News refreshes every 20 minutes.
- **Without Step 2.5 (no KV bound)**: the Markets tab still works, just recomputes live on every load — fine for solo testing, just slower once more than one or two people are using the link.

## Local preview before deploying

You can preview the frontend locally without deploying anything:
```bash
python3 -m http.server 8791 --directory docs
```
Then open `http://localhost:8791`. It won't be able to call the backend until you've set `config.js` to a deployed Worker URL — you'll see a "not wired up" message otherwise.

## What's faithful to the original skill vs. simplified

- **Faithful**: the exact dashboard layout (beacon, entry/stop/target tiles, stats strip, 52-week chart, expandable technical/sentiment/year-story sections), the verdict logic (favourable/neutral/unfavourable with concrete levels or watch triggers), and the plain-English-first writing rules.
- **Different from the original skill**: the original skill sources data from Alpha Vantage. This web app sources the same categories of data (quote, price history, RSI, MACD, company info, news) from Yahoo Finance's public endpoints instead, with RSI/MACD computed locally rather than fetched pre-computed — Alpha Vantage's free tier turned out to rate-limit by the calling server's shared IP address rather than by API key, which made it unusable from a Cloudflare Worker (shared egress IPs across every Workers customer) regardless of whose key was used.
- **New in this app, not part of the original skill**: the Markets tab (index sparklines, market news), paper trading (virtual portfolio, live-price trade execution, trade history), and push-notification stop/target alerts. These exist to help someone practice acting on the analysis, not just read it, and to give the app something worth looking at before they've typed a ticker.
