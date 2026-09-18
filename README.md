# ReelBlend

**A TikTok × Facebook reels system.** It indexes public videos from both platforms and
blends them into one ranked, vertical, auto-playing feed — with its own feed engine,
its own telemetry, its own curation console and its own analytics.

## Open it

### 🌍 Live on the public internet

## → **https://identity-oakland-preparation-expression.trycloudflare.com**

Backup tunnel (independent path): **https://unlock-navigation-favorite-positions.trycloudflare.com**

Both serve the same app. Public HTTPS, no token, no login — open it on a phone, send it to
anyone. Video playback works fully here (real domain + HTTPS), unlike inside a sandboxed
preview frame. The current address is always written to `PUBLIC_URL.txt`.

| | |
|---|---|
| **Live — primary** | **https://identity-oakland-preparation-expression.trycloudflare.com** |
| **Live — backup** | **https://unlock-navigation-favorite-positions.trycloudflare.com** |
| **Local** | `node server/index.js` → **http://localhost:8787** |
| **Sandbox preview (token-gated)** | the preview panel in the chat — 403 in a bare tab by design |

### Restarting the public URL

```bash
bash tools/serve-public.sh        # starts the app if needed + a self-healing tunnel
```

It runs HTTP/2 over TCP rather than QUIC (QUIC idle-times-out when the host pauses),
targets `127.0.0.1` explicitly (never dials IPv6 localhost), restarts cloudflared if it
dies, and rewrites `PUBLIC_URL.txt` with whatever address is live.

### If you see "Error 1033" (Cloudflare Tunnel error)

That is Cloudflare saying *"the tunnel is not connected"* — the app itself is fine. It
happened once during this build: the QUIC tunnel hit `timeout: no recent network activity`
and dropped for ~90 seconds before re-registering. Two fixes went in: the primary tunnel
now runs HTTP/2-over-TCP, and `serve-public.sh` restarts a dead tunnel automatically.

Check it in one line:

```bash
curl -s https://<your-tunnel>.trycloudflare.com/api/health   # anything but 200 = tunnel down
bash tools/serve-public.sh                                    # bring it back (new hostname)
```

**Quick tunnels are ephemeral and carry no uptime guarantee.** For a link you can rely on —
or put on a business card — deploy to a real host (see below). It is a 60-second job
because the app has zero dependencies.

> Requirements: **Node 18+** and nothing else. No `npm install` — there are no dependencies,
> including the dev dependencies. `npm run smoke` runs a 29-check end-to-end API test.

---

## The one design decision that shapes everything

ReelBlend is **embed-first**. It does not download, transcode, re-host or mirror a single
frame of anyone's video, and it does not scrape platform HTML.

Every video plays through the platform's **own official player**:

| | Metadata (official oEmbed) | Playback (official player) |
|---|---|---|
| **TikTok** | `tiktok.com/oembed?url=…` — caption, creator, thumbnail | `tiktok.com/player/v1/<id>` |
| **Facebook** | `graph.facebook.com/v21.0/oembed_video` | `facebook.com/plugins/video.php?href=…` |

Why it's built this way:

* **It's the only version that can be operated legally.** Downloading and re-serving
  other people's videos breaches both platforms' terms *and* copyright — and every
  "downloader" that does it is one DMCA notice from being shut down.
* **The creator keeps the view, the credit and the revenue.** The embed is the
  mechanism the platforms themselves publish for exactly this purpose.
* **It's robust.** Playback needs no API key, no token and no metadata call — so a
  platform outage degrades the *caption*, never the *video*.

What ReelBlend actually owns is the interesting part: **the blend engine, the catalog,
the telemetry and the curation workflow.** That is the product.

---

## What's in the box

```
reelblend/
├── server/
│   ├── index.js              HTTP server, static hosting, graceful shutdown
│   └── lib/
│       ├── platforms.js      URL shape parsing, short-link resolution, oEmbed enrichment
│       ├── store.js          atomic JSON persistence, event aggregation, stats
│       ├── rank.js           the blend engine (score → quota → diversify → explore)
│       └── api.js            REST API, zero-dependency router
├── public/
│   ├── index.html            app shell (Reels · Explore · Add videos · Insights)
│   ├── styles.css            design system (two brand accents that resolve into one gradient)
│   └── app.js                the whole client: reels player, curation console, dashboards
├── data/
│   ├── seed.json             239 verified public videos (145 TikTok · 94 Facebook)
│   └── store.json            runtime state — created on first boot
└── tools/
    ├── build_catalog.py      harvest public video URLs + verify via oEmbed
    ├── canonicalize_facebook.py  recover real Facebook creator attribution
    ├── refresh_seed_meta.py  in-place seed metadata cleanup (no network)
    └── enrich.js             retry deferred metadata when a platform un-throttles us
```

---

## The blend engine (`server/lib/rank.js`)

Each slate is assembled in four passes.

**1 · Score** — five signals, each normalised by *percentile rank* inside the current
pool (robust against the enormous outliers that social video produces):

| signal | what it measures |
|---|---|
| `engagement` | platform likes/comments/shares/views **+** your own first-party likes, saves, shares, comments |
| `freshness` | exponential recency decay (`halfLifeHours`, default 96h) |
| `watch` | first-party watch-through per play — the only signal that measures *your* audience |
| `affinity` | tags and creators this session has liked, saved, shared or completed |
| `fatigue` | repeat-impression penalty, `seenPenalty ^ (impressions × 3)` |

**2 · Quota** — the mix slider is a soft quota. Set it to 40 and roughly 40% of every
page is TikTok; set it to 0 or 100 and the feed is a single platform. If a platform runs
out, the engine top-ups from the other rather than returning a short page.

**3 · Diversify** — a minimum gap between two reels from the same creator, plus a hard
exclusion for anything a viewer marked *not for me*.

**4 · Explore** — a reserved slice of every slate goes to long-shots, so the feed can't
collapse into an echo chamber after a few likes.

Every returned reel carries a `why` block — the component scores and plain-English
reasons that put it there. Press **Why this?** (or `i`) in the reels view. *Feeds you
can't inspect are feeds you can't tune.*

---

## The reels player

* Vertical 9:16 stage, autoplay, **one live iframe at a time** (mount/unmount on navigate — a feed of 50 players will melt a phone).
* Deterministic **poster layer** behind every embed: a gradient and typography derived from the video id, so there is never a black box, even offline or while the player loads.
* Right rail: like · comment · save · share · not-for-me — all wired to real telemetry.
* Every impression, play, watch-millisecond, completion, skip and dismissal is posted to `/api/events` (batched every 4s, `sendBeacon` on unload) and feeds straight back into ranking.
* Keyboard: `←/→` or `↑/↓` navigate · `l` like · `s` save · `i` why · `r` new mix · `Esc` close.
* Touch: swipe up/down.
* `Autoplay next` dwell timer also drives a progress bar and emits `complete` at 92% of the dwell window.

## The curation console (**Add videos**)

Paste a link → ReelBlend normalises the URL shape, resolves short links
(`vm.tiktok.com`, `fb.watch`), verifies it through the official oEmbed endpoint, and
shows you exactly which endpoint resolved it. Then you caption it, tag it, and either
publish it into the feed immediately or park it in **Pending review**.

Three metadata modes, all labelled honestly in the UI:

| mode | meaning |
|---|---|
| `full` | TikTok — caption, creator, thumbnail verified |
| `embed-only` | Facebook's public oEmbed exposes **no caption and no thumbnail**; the caption is yours to write, the embed is fully live |
| `deferred` | the platform is throttling us (403/429). The video still embeds — `POST /api/videos/:id/enrich` retries the metadata later |

That last row is real: during development Facebook's oEmbed returned `403` after a
burst of calls. The engine treats oEmbed as *enrichment, not a gate*, so a rate-limit
costs you a caption, never a video.

---

## API

| method | path | purpose |
|---|---|---|
| GET | `/api/health` | status, catalog size, active sources |
| GET | `/api/feed?cursor&limit&platform&sort&mix&session` | ranked slate + `why` per item |
| GET | `/api/videos?q&platform&tag&sort&status&limit&offset` | search & filter the catalog |
| GET | `/api/videos/:id` | one video with first-party telemetry |
| POST | `/api/videos/ingest` | `{url, title?, tags?, note?, publish?}` → verify + store |
| POST | `/api/videos/:id/publish` | set caption/tags, move pending → live |
| POST | `/api/videos/:id/enrich` | retry deferred oEmbed metadata |
| POST | `/api/videos/:id/action` | `like\|unlike\|save\|unsave\|share\|comment\|not_interested\|play\|complete\|skip\|watch\|impression` |
| POST | `/api/events` | batched telemetry |
| GET | `/api/stats?days=30` | KPIs, platform split, series, top reels, top tags |
| GET/PUT | `/api/config` | mix, weights, half-life, creator gap |
| GET | `/api/tags` | tag facets |

```bash
# rank a 50/50 page of 8 and inspect the reasoning
curl -s "localhost:8787/api/feed?limit=8&mix=50&session=demo" | jq '.items[] | {author, platform, score, why}'

# verify + publish a video
curl -s -X POST localhost:8787/api/videos/ingest -H 'content-type: application/json' \
  -d '{"url":"https://www.tiktok.com/@tiktok/video/7106594312292453675","tags":["demo"],"publish":true}'
```

---

## Rebuilding the catalog

`data/seed.json` holds 239 unique public videos (145 TikTok · 94 Facebook), every one
verified live through an official endpoint.

```bash
python3 tools/build_catalog.py --limit 150   # harvest + verify (Wikipedia citation graph → oEmbed)
python3 tools/canonicalize_facebook.py       # recover Facebook creator attribution
python3 tools/refresh_seed_meta.py           # in-place cleanup, no network
node    tools/enrich.js                      # retry deferred metadata
```

Where the candidate URLs come from matters: `build_catalog.py` harvests from
**Wikipedia's public citation graph** (the MediaWiki `insource:` search API — a large,
curated, fully public index of links that human editors already vetted), then verifies
every candidate against the platforms' own oEmbed endpoints. It never scrapes TikTok or
Facebook, and it *never deletes a verified entry* just because the platform refused to
re-confirm it today.

**Thumbnails:** TikTok's thumbnail URLs are signed and expire after a few days.
Re-run `node tools/enrich.js` to refresh them; if they lapse, the poster gradient
takes over automatically and nothing looks broken.

---

## Configuration

Loopback-agnostic and container-friendly: binds `0.0.0.0`, honours `PORT`.

```bash
PORT=9000 node server/index.js        # different port
REELBLEND_RESET=1 node server/index.js  # rebuild catalog from seed.json, discard runtime state
```

## Making the numbers real (optional)

Platform view/like counts ship as deterministic **estimates** and are labelled
`source: "estimated"` everywhere they appear. To replace them with real values you need
an authorised key:

* **TikTok** — Display API (`video.list`) after OAuth with the creator. Set
  `TIKTOK_CLIENT_KEY` / `TIKTOK_CLIENT_SECRET` and swap `fetchMetadata()` in
  `server/lib/platforms.js`; the `signal.source` field becomes `"api"` and the UI
  relabels itself.
* **Facebook** — Graph API with a page access token: `/{page-id}/videos?fields=title,description,picture`.

The engine treats `source: "api"` as authoritative and `"estimated"` as a prior, so
wiring a key is additive — no ranking code changes.

## What ReelBlend will not do

* Download, store or re-transcode TikTok/Facebook video files.
* Scrape platform HTML or bypass bot protection.
* Embed private, friends-only or login-gated videos (they are rejected with a clear message).
* Display a platform's engagement numbers as if they were first-party data — they are labelled estimated until an official key is wired.

If you want *download-and-republish* functionality, that is a different product with a
different legal posture, and it should be built on licensed or owned content.

## Running in public

Exposing this to the open internet changed the requirements, so three things were added:

**Write rate limiting.** GETs are free; writes cost credits per client per minute
(ingest 6, delete 4, other writes 2, telemetry 1, budget 120/min). A crawler or a runaway
script gets `429` with a `Retry-After` instead of hammering the catalog or spamming
outbound oEmbed calls. Reads are never throttled.

**Request-level isolation.** Every request is wrapped, socket errors are absorbed
(`req/res.on('error')`), malformed requests are answered with a 400 by the
`clientError` handler, and the fallback 404 checks `headersSent` before writing.

**Process guards.** `uncaughtException` / `unhandledRejection` are logged loudly and the
service keeps serving — unless errors start cascading (>20/minute), in which case it exits
cleanly after flushing state so a supervisor can restart it.

That first point is not theoretical. The first public deployment **crashed within a minute**
of going live: a bug in the new 429 path returned `undefined` from the API dispatcher, the
server treated that as "route not handled" and tried to send a second response, and
`ERR_HTTP_HEADERS_SENT` took the process down — every subsequent request was a `502` from
the tunnel. The abuse test that caught it (40 rapid writes, 25 rapid reads, dropped sockets
mid-request) is now part of the verification story, and the service survives all three.

## Verification

Two test suites ship with the project.

```bash
npm run smoke          # 29 end-to-end API assertions against a running server
```

`tools/smoke.js` checks the real contracts, not just status codes: that every feed item
carries a `why` block, that every item's embed target is an official player URL, that
`mix=100` really returns only TikTok and `mix=0` only Facebook, that creator spacing
holds across a 20-item page, that telemetry actually persists onto the video record,
that comment text is stored, that config writes are clamped, and that junk links are
rejected with a 422.

The client is verified the same way — booted in a headless DOM against the live API and
driven through every view, including a run with `localStorage` forced to throw, the
clipboard deleted and `sendBeacon` removed, which is what a sandboxed preview frame looks
like. The app boots and works in that environment with zero console errors (sessions,
likes and saves fall back to memory).

## Deploying it publicly

The app is dependency-free, binds `0.0.0.0` and reads `$PORT`, so every platform works:

```bash
# Render / Railway / Heroku  →  start command:
node server/index.js          # package.json "start" already does this

# Fly.io
fly launch --now

# Docker (anything: Cloud Run, ECS, a VPS)
docker build -t reelblend . && docker run -p 8080:8080 reelblend

# Plain VPS
PORT=80 node server/index.js
```

A `render.yaml` blueprint is included for one-click Render deploys. Set
`REELBLEND_RESET=1` once if you want a deploy to rebuild the catalog from
`data/seed.json` and discard runtime state.

**Note on hosting:** `data/store.json` is a file, so on a platform with an ephemeral
filesystem (most free tiers) the catalog re-seeds on every restart and runtime
telemetry resets. Mount a volume, or swap in the Postgres adapter — every read and write
already goes through the `Store` class, so no call sites change.

## Roadmap

* Postgres adapter behind the same `Store` interface (the call sites don't change).
* Scheduled `enrich.js` as a cron for metadata refresh + dead-link pruning.
* Session-level A/B harness for weight configs (the engine already takes weights per request).
* Playlist/"channels" built from a tag or creator, rendered through the same slate builder.
