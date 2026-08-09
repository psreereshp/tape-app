# Tape — hosted web app

A mobile-friendly web app version of the `swing-trade-analyst` skill, so friends without Claude Pro/Cowork can use it. Three tabs:

- **Markets** (the default landing view) — S&P 500 / Nasdaq / Dow sparkline cards and the day's market headlines, so the app opens to something populated instead of an empty search box.
- **Analyze** — type a ticker, get the same traffic-light dashboard (verdict, entry/stop/target, 52-week chart, expandable technical/sentiment detail) the skill produces.
- **Paper Trading** — practice swing trading with a virtual $100,000 portfolio and live prices, with optional push notifications when a position hits its stop or target.

Everything runs as a normal website friends can "Add to Home Screen."

## How it works

```
Friend's phone/browser
   │  types "NVDA", taps Analyze
   ▼
docs/  (static HTML/CSS/JS — hosted on GitHub Pages)
   │  POST { ticker: "NVDA" }
   ▼
worker/worker.js  (Cloudflare Worker — holds your API keys, nobody else sees them)
   │  fetches technicals, quote, history, news
   ▼
Alpha Vantage API
   │  raw market data
   ▼
worker/worker.js
   │  sends data + skill instructions to Claude, forces structured JSON output
   ▼
Anthropic API (claude-sonnet-5)
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
   │  checks live prices for every watched ticker
   │  if a stop/target was crossed → sends an encrypted Web Push notification
   ▼
Friend's phone — notification arrives even if the app/browser is closed
   │  tap it → app opens, fetches a fresh price, asks "close this position?"
   ▼
Position closes in their local portfolio, using the fresh price (not the stale push price)
```

The Markets tab works the same read-through-cache way: it asks the Worker for `/market`, the Worker serves whatever's in KV if it's fresh (indices ≤6h old, news ≤20min old), and only fetches live — from Alpha Vantage for indices, from Yahoo Finance's public RSS feed for news — when the cache is stale or empty. That's what keeps three friends refreshing the Markets tab all afternoon from burning through the daily Alpha Vantage quota.

Three pieces to deploy, all free:
1. **Cloudflare Worker** — the backend. Holds your Anthropic, Alpha Vantage, and Web Push (VAPID) keys server-side. Deployed by pasting one file into Cloudflare's web dashboard — no CLI, no npm.
2. **Cloudflare KV + Cron Trigger** — a tiny key-value store plus a scheduled job, both added as bindings/triggers in the same Worker's dashboard page. Powers push alerts *and* keeps the Markets tab cheap to serve. Skippable, but both features degrade without it — see Step 3.5.
3. **GitHub Pages** — the frontend. Static files, deployed by pushing to a GitHub repo. This is the URL you send your friends.

Nothing here talks to your local machine after deployment — all three pieces run in the cloud.

---

## Step 1 — Get an Alpha Vantage API key

1. Go to **https://www.alphavantage.co/support/#api-key** and request a free key (just an email, ~30 seconds).
2. Save the key somewhere — you'll paste it into Cloudflare in Step 3.

**Free tier: 25 calls/day.** Each analysis uses 6 calls (quote, overview, RSI, MACD, monthly history, news), so you get **~4 full runs per day** across everyone who uses the link. If you and your friends want to test more than that, Alpha Vantage has cheap paid tiers (or you can rotate keys — not recommended for anything but casual testing).

## Step 2 — Get an Anthropic API key

1. Go to **https://console.anthropic.com** → **API Keys** → create a key.
2. This is billed per token — see **Costs** below before sharing widely.

## Step 3 — Deploy the Worker (backend)

No install required — Cloudflare's dashboard has a built-in code editor.

1. Go to **https://dash.cloudflare.com** → sign up free if you don't have an account.
2. **Workers & Pages** → **Create** → **Create Worker**. Give it a name, e.g. `swing-trade-proxy`. Deploy the default "Hello World" first.
3. Click **Edit code** (Quick Edit). Delete everything in the editor and paste the entire contents of [`worker/worker.js`](worker/worker.js) from this repo.
4. Click **Deploy**.
5. Go to the Worker's **Settings → Variables and Secrets**. Add three **secret** variables (click "Encrypt"):
   - `ANTHROPIC_API_KEY` — your key from Step 2
   - `ALPHAVANTAGE_API_KEY` — your key from Step 1
   - `APP_KEY` — make up any random string (e.g. `openssl rand -hex 16`, or just mash the keyboard). This is a lightweight check so random people can't hit your endpoint and burn your API credits — see **Security notes** below for its real limits.
6. Optionally add `ALLOWED_ORIGIN` set to your future GitHub Pages URL (Step 4) to restrict CORS — you can add this after Step 4 once you know the URL, then redeploy.
7. Copy the Worker's URL from the top of the page — it looks like `https://swing-trade-proxy.<your-subdomain>.workers.dev`. You'll need this in Step 5.

**You can skip Step 3.5** — everything works without it, just less efficiently: push notifications won't be available, and the Markets tab falls back to a live Alpha Vantage fetch on every single page load instead of serving from cache (a few friends opening the app a few times will exhaust the daily quota fast). Worth doing even if you don't care about push, purely for the Markets tab's sake.

## Step 3.5 — KV, Cron Trigger, VAPID keys (recommended)

This powers two things: a phone notification the moment a paper position hits its stop or target (even with the app closed), and a shared cache so the Markets tab is cheap to serve no matter how many friends open it. All three parts are added on the same Worker's dashboard page — still no CLI.

1. **Create the KV namespace** (the cache — doubles as the "positions to watch" list and the market-data cache):
   - Cloudflare dashboard → **Storage & Databases → KV** → **Create namespace**. Name it e.g. `swing-trade-watchlist`.
   - Go back to your Worker → **Settings → Bindings** → **Add binding** → **KV Namespace**. Variable name: `WATCHLIST` (must match exactly). Namespace: the one you just created. Save.
2. **Add the Cron Trigger** (keeps both the watch-check and the market-data cache warm):
   - Your Worker → **Triggers** tab → **Cron Triggers** → **Add Cron Trigger**.
   - Use `0 */4 * * *` (every 4 hours) — see **Alpha Vantage budget** below before picking a tighter interval.
3. **Set the VAPID keys** (Web Push authentication — only needed for push notifications, not for the Markets tab — already generated for you):
   - Open [`VAPID_KEYS_PRIVATE.txt`](VAPID_KEYS_PRIVATE.txt) in this project. **Do not commit this file or paste it into `docs/`.**
   - Worker → **Settings → Variables and Secrets** → add:
     - `VAPID_PRIVATE_KEY` — the private key from that file, as a **secret**.
     - `VAPID_PUBLIC_KEY` — the public key from that file, as a **plain variable** (it's meant to be public — it also goes in `docs/config.js` in Step 5).
     - `VAPID_SUBJECT` — a plain variable, `mailto:` + your email. Push services use this to contact you if something's wrong with your server; it's not shown to end users.
   - Want your own keys instead of the generated ones? Any tool that outputs a P-256 EC keypair works, but the easiest is to ask Claude to regenerate them the same way this project's were made (Python `cryptography`, P-256, uncompressed-point + base64url encoding).
4. **Redeploy** the Worker (Edit code → Deploy) so it picks up the new bindings.

## Step 4 — Deploy the frontend (GitHub Pages)

1. Create a new **public** GitHub repository (needed for free GitHub Pages) — e.g. `swing-trade-demo`.
2. Push this project's `docs/` folder contents to the repo root (not the whole `Tape` project — just what's inside `docs/`). From this machine:
   ```bash
   cd docs
   git init
   git add .
   git commit -m "Tape — market pulse, swing trade analysis, paper trading"
   git branch -M main
   git remote add origin https://github.com/<you>/swing-trade-demo.git
   git push -u origin main
   ```
   (Or just drag-and-drop the files into the repo via the GitHub web UI if you'd rather not use git.)
3. In the repo → **Settings → Pages** → Source: **Deploy from a branch** → Branch: `main`, folder `/ (root)` → **Save**.
4. Wait ~1 minute, then your site is live at `https://<you>.github.io/swing-trade-demo/`. **This is the link you send your friends.**

## Step 5 — Wire the frontend to the backend

1. Edit `docs/config.js` in your repo (GitHub's web editor works fine — click the file, pencil icon):
   ```js
   window.SWING_TRADE_CONFIG = {
     API_URL: "https://swing-trade-proxy.<your-subdomain>.workers.dev",
     APP_KEY: "the same random string you set as APP_KEY in Step 3",
     VAPID_PUBLIC_KEY: "the VAPID_PUBLIC_KEY value from VAPID_KEYS_PRIVATE.txt — leave blank to skip push",
   };
   ```
2. Commit directly to `main`. GitHub Pages redeploys automatically in under a minute.
3. If you set `ALLOWED_ORIGIN` on the Worker in Step 3, go back and set it now to your Pages URL (e.g. `https://<you>.github.io`), then redeploy the Worker.

## Step 6 — Test it

1. Open your GitHub Pages URL on your phone. You should land on the **Markets** tab with three index cards and a handful of headlines — if it's empty or errors, see **Troubleshooting the Markets tab** below.
2. Switch to **Analyze**, type a ticker (e.g. `NVDA`), and tap Analyze. First run takes 15–30 seconds (6 Alpha Vantage calls + one Claude call).
3. **Add to Home Screen**: iOS Safari — Share icon → Add to Home Screen. Android Chrome — menu (⋮) → Add to Home Screen / Install app. The app shows a one-time tip for iOS users automatically. **On iOS, push notifications only work after the app has been added to the Home Screen** (iOS 16.4+) — opening the site in a regular Safari tab won't offer them.
4. Try Paper Trading: switch tabs, tap **+ New paper trade**, buy something with a stop/target set, tap **Enable notifications**. You should get a "Test notification" almost immediately — that confirms the whole push pipeline (Worker crypto → push service → your phone) works end to end.
5. Send the GitHub Pages link to friends.

---

## Markets tab

The default landing view. Two independent pieces, cached separately because they have very different costs:

- **Indices**: S&P 500, Nasdaq, and Dow Jones don't have direct tickers on Alpha Vantage's free tier, so each is tracked via a liquid ETF proxy — **SPY**, **QQQ**, and **DIA** respectively (labeled "via SPY" etc. on each card, not presented as the literal index level — the % change is what's accurate and what matters for a market-pulse glance). Backed by `TIME_SERIES_DAILY` (1 Alpha Vantage call per proxy, 3 total per refresh), cached in KV for **6 hours** — daily-close data doesn't need to refresh more often than that anyway.
- **News**: pulled from Yahoo Finance's public top-stories RSS feed (`finance.yahoo.com/news/rssindex`), parsed by the Worker, cached in KV for **20 minutes**. Costs nothing against your Alpha Vantage quota. This is an unofficial, undocumented feed — Yahoo could change its shape or retire it without notice. The Worker's RSS parser is regex-based (Workers have no built-in XML DOM parser) and degrades gracefully: if the fetch or parse fails, the news list just renders empty rather than breaking the rest of the page. If headlines stop showing up, that feed is the first thing to check.
- Both endpoints use the same **read-through cache** pattern as the watch-check: whoever's request finds a stale/missing cache entry pays the live-fetch cost and refills it for everyone else. The Cron Trigger (Step 3.5) also refreshes both every cycle so the *first* visitor after a gap doesn't wait on a live fetch.

## Paper trading

Practice mode with a virtual $100,000 starting balance, live prices, and long-only positions (buy, then close for a gain or loss — no shorting, matching the analysis skill's own long-only setups).

- **Storage**: entirely in the browser's `localStorage` — cash, open positions, and trade history never leave the device. Clearing browser data, switching phones, or using a different browser starts a fresh portfolio; there's no login and no cross-device sync.
- **Prices**: every trade open/close/refresh fetches a live quote via the Worker's `/quote` endpoint (1 Alpha Vantage call each) — never a stale or cached price.
- **From the dashboard**: after analyzing a ticker, a "Paper trade this setup" button prefills the trade form with that ticker (and, for a favourable verdict, the suggested stop/target).
- **Stop/target monitoring**: manual by default — tap "Refresh" on a position or "Refresh prices" to check. With notifications enabled (see below), the server also checks periodically and pushes an alert; tapping it re-fetches a fresh price and asks you to confirm the close (it never auto-closes on a possibly-stale push price).
- **Reset**: "Reset portfolio" at the bottom of the Paper Trading tab wipes everything and starts over from $100,000.

## Alpha Vantage budget: analysis vs. watching

Every capability that touches live prices shares the same 25-calls/day free key:

| Action | Alpha Vantage calls |
|---|---|
| One "Analyze" run | 6 |
| One "Paper trade" open/close/refresh | 1 |
| One Cron watch-check cycle | 1 per **unique** watched ticker (dedupes across all your friends' positions) |
| One Markets-tab indices refresh | 3 (SPY + QQQ + DIA) — at most once per 6h, regardless of how many people load the tab |

A `0 */4 * * *` Cron Trigger (every 4 hours = 6 cycles/day) watching 3 different tickers costs 18 calls/day on watch-checks alone. Because the cron fires more often than the indices' 6h cache TTL, only every other cycle actually re-fetches indices (the read-through cache skips a refresh that's still fresh) — so budget roughly **3 calls per 6 hours for indices** (~12/day) on top of the watch-check cost. Together that can eat most of the 25/day quota before anyone runs a single Analyze. If you want more headroom, widen the Cron interval (`0 */6 * * *` = 4 watch-check cycles/day, or `0 */8 * * *` = 3/day) — indices still refresh on their own 6h clock either way since that's enforced by the cache TTL, not the cron frequency. The Worker stops the watch-check loop early the moment Alpha Vantage returns a rate-limit response, so a busy day degrades gracefully (some tickers, or the indices refresh, just don't happen that cycle) rather than erroring out.

## Costs

- **Alpha Vantage**: free tier as described above (25 calls/day, shared across Analyze, paper trading, and watch-checks). No card required.
- **Anthropic API**: pay-per-token on `claude-sonnet-5` — **$2 / $10 per million input/output tokens** through 2026-08-31 (intro pricing; reverts to $3 / $15 after). Only the Analyze flow calls Claude — paper trading and quotes don't. A single Analyze run sends ~3,000–6,000 input tokens and gets back ~1,500–3,000 output tokens — roughly **$0.02–$0.05 per analysis** at intro pricing. Fine for casual testing with a few friends; set a spend limit in the Anthropic Console if you're worried about a runaway bill.
- **Cloudflare Workers**: free tier covers 100,000 requests/day and 1,000 Cron Trigger invocations/day — you won't come close.
- **Cloudflare KV**: free tier covers 100,000 reads/day and 1,000 writes/day — each watch registration is 1 write, each Cron cycle is roughly 1 read per active watch. Fine at friends-and-family scale.
- **GitHub Pages**: free for public repos.

## Security & privacy notes (read before sharing the link widely)

- `APP_KEY` is visible to anyone who opens your browser's dev tools — it's not a real secret, just a speed bump that stops casual scripted abuse and keeps your endpoint out of search-engine crawlers. It does **not** stop a motivated person from finding it and hammering your Worker (and your Anthropic bill).
- For real protection against abuse: in the Cloudflare dashboard, go to **Security → WAF → Rate limiting rules** on your Worker's route and cap requests per IP per minute — this is a few clicks, no code.
- Monitor spend in the **Anthropic Console** (usage limits can be set per-key) and Alpha Vantage's dashboard.
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

## Troubleshooting the Markets tab

- **Empty or errors on first load**: normal the very first time — nothing's cached yet, so the Worker does a live fetch (costs 3 Alpha Vantage calls). If it still fails, check `ANTHROPIC_API_KEY`/`ALPHAVANTAGE_API_KEY` are set (Step 3) the same way you would for Analyze.
- **Indices show but news doesn't**: the Yahoo RSS feed is unreachable or its format changed — this doesn't affect indices or anything else, since news failures are isolated. Check Worker logs (see push troubleshooting above) for a fetch error on `finance.yahoo.com`.
- **Data feels stale**: indices only refresh every 6 hours by design (see **Markets tab** above) — that's not a bug. News refreshes every 20 minutes.
- **Without Step 3.5 (no KV bound)**: the Markets tab still works, just recomputes live on every load — fine for solo testing, expensive once more than one or two people are using the link.

## Local preview before deploying

You can preview the frontend locally without deploying anything:
```bash
python3 -m http.server 8791 --directory docs
```
Then open `http://localhost:8791`. It won't be able to call the backend until you've set `config.js` to a deployed Worker URL — you'll see a "not wired up" message otherwise.

## What's faithful to the original skill vs. simplified

- **Faithful**: the exact dashboard layout (beacon, entry/stop/target tiles, stats strip, 52-week chart, expandable technical/sentiment/year-story sections), the verdict logic (favourable/neutral/unfavourable with concrete levels or watch triggers), the plain-English-first writing rules, and the Alpha Vantage function set (6 calls: quote, overview, RSI, MACD, monthly history, news sentiment).
- **Simplified**: the original skill falls back to public web search when no Alpha Vantage connector is present. This web app always requires Alpha Vantage (there's no web-search fallback wired up) — if the Alpha Vantage feed errors (usually the daily rate limit), the app shows an error instead of degrading to scraped data.
- **New in this app, not part of the original skill**: the Markets tab (index sparklines, market news), paper trading (virtual portfolio, live-price trade execution, trade history), and push-notification stop/target alerts. These exist to help someone practice acting on the analysis, not just read it, and to give the app something worth looking at before they've typed a ticker.
