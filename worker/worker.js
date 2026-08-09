// Swing Trade Analyst — backend proxy (Cloudflare Worker)
//
// Secrets/vars to set in the Worker's Settings > Variables and Secrets
// (never put these in this file):
//   ANTHROPIC_API_KEY     — secret — your Anthropic API key
//   ALPHAVANTAGE_API_KEY  — secret — your free/paid Alpha Vantage key
//   APP_KEY                — secret — a shared token the frontend sends, so this
//                             endpoint isn't wide open to anyone on the internet
//   VAPID_PRIVATE_KEY      — secret — see VAPID_KEYS_PRIVATE.txt / README
//   VAPID_PUBLIC_KEY       — plain var (not secret, it's public) — same file
//   VAPID_SUBJECT           — plain var — e.g. "mailto:you@example.com"
//
// Bindings to add in Settings > Bindings:
//   WATCHLIST — a KV namespace (create one, bind it under this name)
//
// Trigger to add in the Triggers tab:
//   Cron Trigger, e.g. "0 star/4 * * *" (see README) — fires scheduled()
//   below, which checks watched positions against live prices and sends
//   push notifications when a stop or target is hit.
//
// Paste this whole file into Cloudflare's Workers "Quick edit" editor —
// no build step, no npm, no wrangler required.

const ANTHROPIC_MODEL = "claude-sonnet-5";
const ANTHROPIC_VERSION = "2023-06-01";
const TICKER_RE = /^[A-Z.\-]{1,10}$/;

const DASHBOARD_TOOL = {
  name: "render_dashboard",
  description: "Render the swing-trade dashboard for the given ticker.",
  input_schema: {
    type: "object",
    properties: {
      ticker: { type: "string" },
      companyName: { type: "string" },
      price: { type: "string", description: "Current price, formatted e.g. \"$142.53\"" },
      changePercent: { type: "string", description: "e.g. \"+1.8% today\"" },
      asOf: { type: "string", description: "Freshness label, e.g. \"as of Aug 7 close\"" },
      verdict: { type: "string", enum: ["favourable", "neutral", "unfavourable"] },
      verdictHeadline: { type: "string", description: "One plain-English sentence, zero jargon." },
      entry: {
        type: "object",
        properties: { label: { type: "string" }, value: { type: "string" } },
        required: ["label", "value"],
      },
      stop: {
        type: "object",
        properties: { label: { type: "string" }, value: { type: "string" } },
        required: ["label", "value"],
      },
      target: {
        type: "object",
        properties: { label: { type: "string" }, value: { type: "string" } },
        required: ["label", "value"],
      },
      riskReward: { type: ["string", "null"] },
      stats: {
        type: "object",
        properties: {
          high52: { type: "string" },
          low52: { type: "string" },
          pctFromHigh: { type: "string" },
          pctFromLow: { type: "string" },
          oneYearReturn: { type: "string" },
          volatility: { type: "string" },
          bigMoveDays: { type: "string" },
        },
      },
      chartPoints: {
        type: "array",
        items: {
          type: "object",
          properties: { date: { type: "string" }, price: { type: "number" } },
          required: ["date", "price"],
        },
      },
      chartApproximate: { type: "boolean" },
      keyRisk: { type: "string" },
      provenance: { type: "string", description: "e.g. \"Live data via Alpha Vantage, as of Aug 7 close\"" },
      technical: {
        type: "object",
        properties: {
          trendTakeaway: { type: "string" },
          trendDetail: { type: "string" },
          momentumTakeaway: { type: "string" },
          momentumDetail: { type: "string" },
          volatilityTakeaway: { type: "string" },
          volatilityDetail: { type: "string" },
          patternTakeaway: { type: "string" },
        },
      },
      sentiment: {
        type: "object",
        properties: {
          newsTakeaway: { type: "string" },
          newsDetail: { type: "string" },
          analystTakeaway: { type: "string" },
          analystDetail: { type: "string" },
          crowdTakeaway: { type: ["string", "null"] },
        },
      },
      yearStory: {
        type: "object",
        properties: {
          narrative: { type: "string" },
          earningsReactions: { type: "string" },
        },
      },
      disclaimer: { type: "string" },
    },
    required: [
      "ticker", "companyName", "price", "changePercent", "asOf",
      "verdict", "verdictHeadline", "entry", "stop", "target",
      "stats", "chartPoints", "keyRisk", "provenance",
      "technical", "sentiment", "yearStory", "disclaimer",
    ],
  },
};

const SYSTEM_PROMPT = `You are the "Swing Trade Analyst" skill. Given raw Alpha Vantage market data for one ticker, produce a swing-trade dashboard by calling the render_dashboard tool.

Swing trade = holding days to weeks, riding a technical move. Focus on price action, momentum, near-term catalysts — not deep fundamentals.

Precision is required: never fabricate a number. If a data point is missing from the provided JSON, say so in the relevant text field rather than inventing one. Only use the real chart points given to you — never synthesize intermediate points; if fewer than ~8 points are available, set chartApproximate to true.

Write for a non-expert:
- Every "*Takeaway" field must be a plain-English sentence a beginner understands — no jargon.
- Every "*Detail" field is the technical reading underneath ("The technicals: ...") for readers who want specifics, indicator names and numbers included.
- The first time a technical term appears anywhere, define it briefly in parentheses.
- Prefer everyday phrasing: "may have climbed too far too fast" over "overbought", "buyers are gaining strength" over "bullish momentum crossover", "a price floor where buying tends to appear" over "support".
- verdictHeadline must be understandable with zero finance background.

Verdict logic — weigh technicals, the 52-week behaviour, and sentiment together; note where they agree or conflict; land on exactly one verdict:
- favourable: charts and mood line up now. entry/stop/target must all be concrete levels; compute riskReward as a ratio string like "1:2.4".
- neutral: mixed or waiting. entry.label/value should describe the specific watch trigger (e.g. "Close above $X on strong volume"); stop and target should read "—" / "set once triggered".
- unfavourable: setup works against a swing trade now. entry.value should read "No entry"; entry.label should state briefly what would need to change.

Always state data provenance and freshness in the provenance field (the feed's latest trading day / "as of <date> close").
The disclaimer field must state this is informational analysis, not personalized financial advice, and that near-term price moves are inherently uncertain — briefly, once.

Call render_dashboard exactly once with the complete dashboard. Do not include any other text.`;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function corsHeaders(origin, allowedOrigin) {
  const allow = !allowedOrigin || allowedOrigin === "*" || origin === allowedOrigin ? (origin || "*") : allowedOrigin;
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "POST, OPTIONS, DELETE",
    "Access-Control-Allow-Headers": "Content-Type, X-App-Key, X-AV-Key",
    "Access-Control-Max-Age": "86400",
  };
}

function jsonResponse(status, obj, headers) {
  return new Response(JSON.stringify(obj), { status, headers: { ...headers, "content-type": "application/json" } });
}

function errorResponse(status, message, headers) {
  return jsonResponse(status, { error: message }, headers);
}

function isValidTicker(ticker) {
  return typeof ticker === "string" && TICKER_RE.test(ticker);
}

async function fetchAV(fn, params, apiKey) {
  const url = new URL("https://www.alphavantage.co/query");
  url.searchParams.set("function", fn);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("apikey", apiKey);
  const res = await fetch(url.toString());
  if (!res.ok) return { __error: `HTTP ${res.status}` };
  const json = await res.json();
  if (json.Note || json.Information) return { __error: json.Note || json.Information };
  return json;
}

function extractQuote(json) {
  if (!json || json.__error) return null;
  const q = json["Global Quote"] || json["Global Quote "];
  if (!q || !q["05. price"]) return null;
  return {
    price: q["05. price"],
    changePercent: q["10. change percent"],
    asOf: q["07. latest trading day"],
  };
}

function trimTimeSeries(json, maxPoints = 14) {
  const seriesKey = Object.keys(json || {}).find((k) => k.toLowerCase().includes("time series"));
  if (!seriesKey) return json;
  const entries = Object.entries(json[seriesKey]).slice(0, maxPoints);
  return { ...json, [seriesKey]: Object.fromEntries(entries) };
}

function trimNews(json, maxArticles = 8) {
  if (!json || !Array.isArray(json.feed)) return json;
  return {
    ...json,
    feed: json.feed.slice(0, maxArticles).map((a) => ({
      title: a.title,
      time_published: a.time_published,
      summary: a.summary,
      overall_sentiment_label: a.overall_sentiment_label,
      overall_sentiment_score: a.overall_sentiment_score,
    })),
  };
}

async function gatherMarketData(ticker, avKey) {
  const [quote, overview, rsi, macd, monthly, news] = await Promise.all([
    fetchAV("GLOBAL_QUOTE", { symbol: ticker }, avKey),
    fetchAV("OVERVIEW", { symbol: ticker }, avKey),
    fetchAV("RSI", { symbol: ticker, interval: "daily", time_period: "14", series_type: "close" }, avKey),
    fetchAV("MACD", { symbol: ticker, interval: "daily", series_type: "close" }, avKey),
    fetchAV("TIME_SERIES_MONTHLY_ADJUSTED", { symbol: ticker }, avKey),
    fetchAV("NEWS_SENTIMENT", { tickers: ticker }, avKey),
  ]);

  return {
    globalQuote: quote,
    companyOverview: overview,
    rsi: trimTimeSeries(rsi, 5),
    macd: trimTimeSeries(macd, 5),
    monthlyPriceHistory: trimTimeSeries(monthly, 13),
    newsSentiment: trimNews(news, 8),
  };
}

async function callClaude(ticker, marketData, anthropicKey) {
  const body = {
    model: ANTHROPIC_MODEL,
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    tools: [DASHBOARD_TOOL],
    tool_choice: { type: "tool", name: "render_dashboard" },
    messages: [
      {
        role: "user",
        content: `Ticker: ${ticker}\n\nRaw Alpha Vantage data (JSON):\n${JSON.stringify(marketData)}`,
      },
    ],
  };

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": anthropicKey,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Anthropic API error ${res.status}: ${text.slice(0, 500)}`);
  }

  const json = await res.json();
  const toolUse = (json.content || []).find((b) => b.type === "tool_use");
  if (!toolUse) throw new Error("Claude did not return a dashboard.");
  return toolUse.input;
}

// ---------------------------------------------------------------------------
// Market overview (index proxies + news) — KV read-through cache so page
// loads never directly spend the Alpha Vantage daily budget.
// ---------------------------------------------------------------------------

const INDEX_PROXIES = [
  { key: "sp500", label: "S&P 500", symbol: "SPY" },
  { key: "nasdaq", label: "Nasdaq", symbol: "QQQ" },
  { key: "dow", label: "Dow Jones", symbol: "DIA" },
];

const INDICES_TTL_MS = 6 * 60 * 60 * 1000; // 6h — daily-close data doesn't need to refresh often
const NEWS_TTL_MS = 20 * 60 * 1000; // 20m — free to refresh (no Alpha Vantage cost)
const YAHOO_NEWS_RSS_URL = "https://finance.yahoo.com/news/rssindex";

async function fetchIndexProxy(proxy, avKey) {
  const json = await fetchAV("TIME_SERIES_DAILY", { symbol: proxy.symbol, outputsize: "compact" }, avKey);
  const series = json["Time Series (Daily)"];
  if (!series) return { ...proxy, error: json.__error || "No data returned." };

  const dates = Object.keys(series).sort(); // oldest -> newest
  const recent = dates.slice(-15);
  const points = recent.map((d) => ({ date: d, close: parseFloat(series[d]["4. close"]) }));
  const latest = points[points.length - 1];
  const prev = points[points.length - 2];
  const changePercent = latest && prev ? ((latest.close - prev.close) / prev.close) * 100 : null;

  return { ...proxy, price: latest ? latest.close : null, changePercent, asOf: latest ? latest.date : null, points };
}

async function fetchIndices(avKey) {
  const indices = [];
  for (const proxy of INDEX_PROXIES) {
    indices.push(await fetchIndexProxy(proxy, avKey));
  }
  return { indices, updatedAt: Date.now() };
}

function xmlDecode(s) {
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

function extractXmlTag(block, tag) {
  const m = block.match(new RegExp(`<${tag}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`));
  return m ? xmlDecode(m[1].trim()) : null;
}

function parseYahooRss(xmlText, maxItems) {
  const items = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRe.exec(xmlText)) && items.length < maxItems) {
    const block = m[1];
    const title = extractXmlTag(block, "title");
    const link = extractXmlTag(block, "link");
    const pubDate = extractXmlTag(block, "pubDate");
    const sourceMatch = block.match(/<source[^>]*>([\s\S]*?)<\/source>/);
    const source = sourceMatch ? xmlDecode(sourceMatch[1].trim()) : null;
    if (title && link) items.push({ title, link, pubDate, source });
  }
  return items;
}

async function fetchNews() {
  try {
    const res = await fetch(YAHOO_NEWS_RSS_URL, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) return { items: [], updatedAt: Date.now() };
    const text = await res.text();
    return { items: parseYahooRss(text, 8), updatedAt: Date.now() };
  } catch {
    return { items: [], updatedAt: Date.now() };
  }
}

async function getCached(env, key, ttlMs, refresh) {
  if (env.WATCHLIST) {
    try {
      const raw = await env.WATCHLIST.get(key);
      if (raw) {
        const cached = JSON.parse(raw);
        if (Date.now() - cached.updatedAt < ttlMs) return cached;
      }
    } catch {
      // fall through to a live refresh
    }
  }
  const fresh = await refresh();
  if (env.WATCHLIST) {
    try {
      await env.WATCHLIST.put(key, JSON.stringify(fresh));
    } catch {
      // caching is best-effort — still return the fresh data
    }
  }
  return fresh;
}

async function getIndices(env, avKey) {
  return getCached(env, "market:indices", INDICES_TTL_MS, () => fetchIndices(avKey));
}

async function getNews(env) {
  return getCached(env, "market:news", NEWS_TTL_MS, fetchNews);
}

// ---------------------------------------------------------------------------
// Web Push (RFC 8291 message encryption + RFC 8292 VAPID), Web Crypto only —
// no npm dependency, so this still pastes straight into the dashboard editor.
// ---------------------------------------------------------------------------

function b64urlEncode(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (let i = 0; i < arr.length; i++) binary += String.fromCharCode(arr[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(str) {
  let s = String(str).replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const binary = atob(s);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function concatBytes(...arrays) {
  const total = arrays.reduce((sum, a) => sum + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) { out.set(a, offset); offset += a.length; }
  return out;
}

async function hmacSha256(keyBytes, dataBytes) {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, dataBytes);
  return new Uint8Array(sig);
}

// Single-block HKDF-Expand (valid because we never need more than 32 bytes).
async function hkdfExpand(prk, infoBytes, length) {
  const t = await hmacSha256(prk, concatBytes(infoBytes, new Uint8Array([1])));
  return t.slice(0, length);
}

async function importVapidPrivateKey(privB64url, pubB64url) {
  const pubRaw = b64urlDecode(pubB64url); // 0x04 || X(32) || Y(32)
  const x = pubRaw.slice(1, 33);
  const y = pubRaw.slice(33, 65);
  const d = b64urlDecode(privB64url);
  const jwk = { kty: "EC", crv: "P-256", x: b64urlEncode(x), y: b64urlEncode(y), d: b64urlEncode(d), ext: true };
  return crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
}

async function signVapidJWT(privateKey, audience, subject) {
  const header = { typ: "JWT", alg: "ES256" };
  const now = Math.floor(Date.now() / 1000);
  const claims = { aud: audience, exp: now + 12 * 3600, sub: subject };
  const encHeader = b64urlEncode(new TextEncoder().encode(JSON.stringify(header)));
  const encClaims = b64urlEncode(new TextEncoder().encode(JSON.stringify(claims)));
  const signingInput = `${encHeader}.${encClaims}`;
  // Web Crypto's ECDSA sign() for a P-256 key returns raw (r||s), which is
  // exactly the format JWS ES256 needs — no DER decoding required.
  const sigBits = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, new TextEncoder().encode(signingInput));
  return `${signingInput}.${b64urlEncode(new Uint8Array(sigBits))}`;
}

// RFC 8291 §3.4: derive the content-encryption key and nonce for one message.
async function deriveWebPushKeys(subscription, saltBytes, asKeyPair) {
  const uaPublicRaw = b64urlDecode(subscription.keys.p256dh); // 65 bytes
  const authSecret = b64urlDecode(subscription.keys.auth); // 16 bytes

  const uaPublicKey = await crypto.subtle.importKey("raw", uaPublicRaw, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const sharedSecretBits = await crypto.subtle.deriveBits({ name: "ECDH", public: uaPublicKey }, asKeyPair.privateKey, 256);
  const sharedSecret = new Uint8Array(sharedSecretBits);
  const asPublicRaw = new Uint8Array(await crypto.subtle.exportKey("raw", asKeyPair.publicKey));

  // Stage 1: combine the ECDH secret with the subscription's auth secret.
  const prkKey = await hmacSha256(authSecret, sharedSecret);
  const keyInfo = concatBytes(new TextEncoder().encode("WebPush: info"), new Uint8Array([0]), uaPublicRaw, asPublicRaw);
  const ikm = await hkdfExpand(prkKey, keyInfo, 32);

  // Stage 2: standard HKDF over the message-specific salt.
  const prk = await hmacSha256(saltBytes, ikm);
  const cekInfo = concatBytes(new TextEncoder().encode("Content-Encoding: aes128gcm"), new Uint8Array([0]));
  const nonceInfo = concatBytes(new TextEncoder().encode("Content-Encoding: nonce"), new Uint8Array([0]));
  const cek = await hkdfExpand(prk, cekInfo, 16);
  const nonce = await hkdfExpand(prk, nonceInfo, 12);

  return { cek, nonce, asPublicRaw };
}

function buildAes128gcmBody(saltBytes, recordSize, asPublicRaw, ciphertext) {
  const rsBytes = new Uint8Array(4);
  new DataView(rsBytes.buffer).setUint32(0, recordSize, false);
  const idlen = new Uint8Array([asPublicRaw.length]);
  return concatBytes(saltBytes, rsBytes, idlen, asPublicRaw, ciphertext);
}

async function sendWebPush(env, subscription, payloadObj) {
  if (!subscription || !subscription.endpoint || !subscription.keys) {
    throw new Error("Malformed push subscription.");
  }
  const vapidPrivateKey = await importVapidPrivateKey(env.VAPID_PRIVATE_KEY, env.VAPID_PUBLIC_KEY);
  const endpointUrl = new URL(subscription.endpoint);
  const audience = `${endpointUrl.protocol}//${endpointUrl.host}`;
  const jwt = await signVapidJWT(vapidPrivateKey, audience, env.VAPID_SUBJECT || "mailto:example@example.com");

  const asKeyPair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const saltBytes = crypto.getRandomValues(new Uint8Array(16));
  const { cek, nonce, asPublicRaw } = await deriveWebPushKeys(subscription, saltBytes, asKeyPair);

  const plaintext = new TextEncoder().encode(JSON.stringify(payloadObj));
  const padded = concatBytes(plaintext, new Uint8Array([0x02])); // single-record delimiter
  const cekKey = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["encrypt"]);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, cekKey, padded));

  const body = buildAes128gcmBody(saltBytes, 4096, asPublicRaw, ciphertext);

  return fetch(subscription.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Encoding": "aes128gcm",
      "TTL": "86400",
      "Authorization": `vapid t=${jwt}, k=${env.VAPID_PUBLIC_KEY}`,
    },
    body,
  });
}

// ---------------------------------------------------------------------------
// Scheduled watch check (runs on the Cron Trigger)
// ---------------------------------------------------------------------------

async function runWatchCheck(env) {
  if (!env.WATCHLIST || !env.ALPHAVANTAGE_API_KEY || !env.VAPID_PRIVATE_KEY) return;

  const list = await env.WATCHLIST.list({ prefix: "watch:" });
  if (list.keys.length === 0) return;

  const watches = [];
  for (const k of list.keys) {
    const raw = await env.WATCHLIST.get(k.name);
    if (!raw) continue;
    try {
      watches.push({ key: k.name, ...JSON.parse(raw) });
    } catch {
      // corrupt entry — ignore
    }
  }
  if (watches.length === 0) return;

  const uniqueTickers = [...new Set(watches.map((w) => w.ticker))];
  const quotes = {};
  for (const ticker of uniqueTickers) {
    const q = extractQuote(await fetchAV("GLOBAL_QUOTE", { symbol: ticker }, env.ALPHAVANTAGE_API_KEY));
    if (!q) break; // most likely rate-limited — stop spending the remaining daily budget
    quotes[ticker] = q;
  }

  for (const w of watches) {
    const q = quotes[w.ticker];
    if (!q) continue;
    const price = parseFloat(q.price);
    if (Number.isNaN(price)) continue;

    let triggeredType = null;
    if (w.target != null && price >= w.target) triggeredType = "target";
    else if (w.stop != null && price <= w.stop) triggeredType = "stop";

    if (!triggeredType) continue;

    const label = triggeredType === "target" ? "hit your target" : "hit your stop";
    try {
      const res = await sendWebPush(env, w.subscription, {
        title: `${w.ticker} ${label}`,
        body: `${w.ticker} is at $${price.toFixed(2)} — open the app to review and close the position.`,
        data: { type: "watch-trigger", ticker: w.ticker, triggeredType, price },
      });
      if (res.ok || res.status === 404 || res.status === 410) {
        // Delivered, or the subscription is gone — either way, stop watching.
        await env.WATCHLIST.delete(w.key);
      }
      // Any other failure: leave the watch in place and retry next run.
    } catch {
      // Leave in place and retry next run.
    }
  }
}

// ---------------------------------------------------------------------------
// HTTP routing
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const headers = corsHeaders(origin, env.ALLOWED_ORIGIN);
    const url = new URL(request.url);
    const path = url.pathname === "/" || url.pathname === "" ? "/analyze" : url.pathname;

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers });
    }
    if (request.method !== "POST") {
      return errorResponse(405, "Use POST.", headers);
    }
    if (env.APP_KEY && request.headers.get("X-App-Key") !== env.APP_KEY) {
      return errorResponse(401, "Unauthorized.", headers);
    }

    // A caller may bring their own Alpha Vantage key (X-AV-Key) to use their own
    // 25-requests/day quota instead of sharing the server's key across everyone.
    const ownAvKey = (request.headers.get("X-AV-Key") || "").trim();
    const avKey = ownAvKey || env.ALPHAVANTAGE_API_KEY;

    let payload;
    try {
      payload = await request.json();
    } catch {
      return errorResponse(400, "Invalid request body.", headers);
    }

    if (path === "/analyze") {
      if (!env.ANTHROPIC_API_KEY || !avKey) {
        return errorResponse(500, "Server is missing API keys. Set ANTHROPIC_API_KEY and ALPHAVANTAGE_API_KEY in the Worker's Settings > Variables.", headers);
      }
      const ticker = String(payload.ticker || "").trim().toUpperCase();
      if (!isValidTicker(ticker)) {
        return errorResponse(400, "Enter a valid ticker symbol, e.g. NVDA.", headers);
      }
      try {
        const marketData = await gatherMarketData(ticker, avKey);
        if (marketData.globalQuote && marketData.globalQuote.__error) {
          const whoseLimit = ownAvKey ? "your personal key's" : "the shared group key's";
          return errorResponse(429, `Market-data feed error: ${marketData.globalQuote.__error}. This usually means ${whoseLimit} free-tier daily limit (25 calls/day) has been hit — try again tomorrow, or use your own key in Settings.`, headers);
        }
        const dashboard = await callClaude(ticker, marketData, env.ANTHROPIC_API_KEY);
        return jsonResponse(200, dashboard, headers);
      } catch (err) {
        return errorResponse(500, err.message || "Something went wrong.", headers);
      }
    }

    if (path === "/quote") {
      if (!avKey) {
        return errorResponse(500, "Server is missing ALPHAVANTAGE_API_KEY.", headers);
      }
      const ticker = String(payload.ticker || "").trim().toUpperCase();
      if (!isValidTicker(ticker)) {
        return errorResponse(400, "Enter a valid ticker symbol, e.g. NVDA.", headers);
      }
      const q = extractQuote(await fetchAV("GLOBAL_QUOTE", { symbol: ticker }, avKey));
      if (!q) {
        const whoseLimit = ownAvKey ? "your personal key's" : "the shared group key's";
        return errorResponse(429, `Market-data feed error — likely ${whoseLimit} Alpha Vantage daily limit (25 calls/day). Try again later.`, headers);
      }
      return jsonResponse(200, { ticker, ...q }, headers);
    }

    if (path === "/market") {
      try {
        const [indices, news] = await Promise.all([getIndices(env, avKey), getNews(env)]);
        return jsonResponse(200, { indices: indices.indices, indicesUpdatedAt: indices.updatedAt, news: news.items, newsUpdatedAt: news.updatedAt }, headers);
      } catch (err) {
        return errorResponse(500, err.message || "Couldn't load market data.", headers);
      }
    }

    if (path === "/watch") {
      if (!env.WATCHLIST) return errorResponse(500, "Server is missing the WATCHLIST KV binding.", headers);
      const ticker = String(payload.ticker || "").trim().toUpperCase();
      const stop = payload.stop == null ? null : Number(payload.stop);
      const target = payload.target == null ? null : Number(payload.target);
      const subscription = payload.subscription;
      if (!isValidTicker(ticker)) return errorResponse(400, "Invalid ticker.", headers);
      if ((stop == null || Number.isNaN(stop)) && (target == null || Number.isNaN(target))) {
        return errorResponse(400, "Provide at least a stop or a target price.", headers);
      }
      if (!subscription || !subscription.endpoint || !subscription.keys || !subscription.keys.p256dh || !subscription.keys.auth) {
        return errorResponse(400, "Missing or malformed push subscription.", headers);
      }
      const watchId = crypto.randomUUID();
      await env.WATCHLIST.put(`watch:${watchId}`, JSON.stringify({
        ticker, stop, target, subscription, createdAt: Date.now(),
      }));
      return jsonResponse(200, { watchId }, headers);
    }

    if (path === "/unwatch") {
      if (!env.WATCHLIST) return errorResponse(500, "Server is missing the WATCHLIST KV binding.", headers);
      const watchId = String(payload.watchId || "");
      if (!watchId) return errorResponse(400, "Missing watchId.", headers);
      await env.WATCHLIST.delete(`watch:${watchId}`);
      return jsonResponse(200, { ok: true }, headers);
    }

    if (path === "/test-push") {
      if (!env.VAPID_PRIVATE_KEY || !env.VAPID_PUBLIC_KEY) {
        return errorResponse(500, "Server is missing VAPID_PRIVATE_KEY / VAPID_PUBLIC_KEY.", headers);
      }
      const subscription = payload.subscription;
      if (!subscription) return errorResponse(400, "Missing subscription.", headers);
      try {
        const res = await sendWebPush(env, subscription, {
          title: "Test notification",
          body: "If you see this, push notifications are working.",
          data: { type: "test" },
        });
        const bodyText = res.ok ? null : await res.text().catch(() => null);
        return jsonResponse(res.ok ? 200 : 502, { ok: res.ok, status: res.status, detail: bodyText }, headers);
      } catch (err) {
        return errorResponse(500, `Push send failed: ${err.message}`, headers);
      }
    }

    return errorResponse(404, "Not found.", headers);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runWatchCheck(env));
    ctx.waitUntil(getCached(env, "market:indices", 0, () => fetchIndices(env.ALPHAVANTAGE_API_KEY)).catch(() => {}));
    ctx.waitUntil(getCached(env, "market:news", 0, fetchNews).catch(() => {}));
  },
};
