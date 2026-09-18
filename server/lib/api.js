'use strict';
/**
 * api.js — ReelBlend REST API.
 *
 *   GET    /api/health
 *   GET    /api/feed            ?cursor&limit&platform&sort&mix&session
 *   GET    /api/videos          ?q&platform&tag&sort&limit&offset&status
 *   GET    /api/videos/:id
 *   POST   /api/videos/ingest   { url, title?, tags?[], publish? }
 *   DELETE /api/videos/:id
 *   POST   /api/videos/:id/action  { type, session, value? }
 *   POST   /api/events          { type, video_id, session, value }
 *   GET    /api/stats           ?days
 *   GET    /api/config
 *   PUT    /api/config          { mix, weights, algorithm, ... }
 *   GET    /api/tags
 *
 * Everything is JSON in / JSON out. No framework, no dependencies.
 */
const platforms = require('./platforms');
const { buildSlate, parseCursor } = require('./rank');
const { rid, shortNum, iso } = require('./util');

function send(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('payload too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function publicVideo(v) {
  return {
    id: v.id, platform: v.platform, platform_id: v.platform_id,
    source_url: v.source_url, embed: v.embed,
    title: v.title, author: v.author, author_url: v.author_url,
    thumbnail: v.thumbnail, tags: v.tags, aspect: v.aspect,
    status: v.status, origin: v.origin, metadata: v.metadata,
    verified: v.verified !== false, needs_caption: !!v.needs_caption, provenance: v.provenance || null,
    created_at: v.created_at, verified_at: v.verified_at,
    signal: v.signal, ours: v.ours,
    comments: v.comments || [],
    signal_pretty: {
      views: shortNum((v.signal || {}).views),
      likes: shortNum((v.signal || {}).likes),
      comments: shortNum((v.signal || {}).comments),
      shares: shortNum((v.signal || {}).shares),
      source: (v.signal || {}).source,
    },
  };
}

/* ── write rate limiting ─────────────────────────────────────────────────
   A public deployment is world-writable by default: GETs are free, but every
   POST/PUT/DELETE costs "credits" per client per minute. Costly routes that
   trigger outbound calls (ingest) or destroy data (delete) cost more. This
   keeps a stray crawler or a runaway script from hammering the catalog without
   getting in the way of a human clicking around.
   ──────────────────────────────────────────────────────────────────────── */
const WINDOW_MS = 60_000;
const CREDIT_LIMIT = 120;
const buckets = new Map();

function clientKey(req) {
  const h = req.headers || {};
  return (h['cf-connecting-ip']
    || (h['x-forwarded-for'] || '').split(',')[0].trim()
    || (req.socket && req.socket.remoteAddress)
    || 'unknown').slice(0, 64);
}

function routeCost(method, pathname) {
  if (method === 'GET' || method === 'OPTIONS') return 0;
  if (/\/ingest$/.test(pathname)) return 6;      // outbound oEmbed calls
  if (method === 'DELETE') return 4;              // destroys catalog rows
  if (/\/api\/events$/.test(pathname)) return 1;  // normal telemetry firehose
  return 2;
}

function spend(req, cost) {
  if (!cost) return { ok: true };
  const now = Date.now();
  const key = clientKey(req);
  let b = buckets.get(key);
  if (!b || now - b.start > WINDOW_MS) { b = { start: now, used: 0 }; buckets.set(key, b); }
  if (buckets.size > 5000) {
    for (const [k, v] of buckets) if (now - v.start > WINDOW_MS) buckets.delete(k);
  }
  b.used += cost;
  if (b.used > CREDIT_LIMIT) {
    return { ok: false, retry_after: Math.ceil((b.start + WINDOW_MS - now) / 1000) };
  }
  return { ok: true, remaining: CREDIT_LIMIT - b.used };
}

function createApi(store) {
  const routes = [];

  const route = (method, pattern, handler) => routes.push({ method, pattern, handler });

  /* ------------------------------------------------------------- health */
  route('GET', /^\/api\/health$/, async (req, res) => {
    send(res, 200, {
      ok: true,
      service: 'reelblend',
      version: '1.0.0',
      videos: store.count(),
      uptime_s: Math.round(process.uptime()),
      time: iso(Date.now()),
      sources: {
        tiktok: 'oembed + player v1',
        facebook: 'graph oembed_video + video plugin',
      },
      policy: 'embed-first: no download, no re-host, no scraping',
      write_limit: { credits_per_minute: CREDIT_LIMIT, scope: 'per client ip' },
    });
  });

  /* --------------------------------------------------------------- feed */
  route('GET', /^\/api\/feed$/, async (req, res) => {
    const q = new URL(req.url, 'http://x').searchParams;
    const sessionId = q.get('session') || 'anon';
    const mix = q.get('mix') !== null ? Number(q.get('mix')) : undefined;
    const session = store.session(sessionId, mix);
    const { offset } = parseCursor(q.get('cursor'));
    const result = buildSlate({
      videos: store.allVideos(),
      session,
      config: store.config,
      options: {
        limit: q.get('limit') || 12,
        offset,
        platform: q.get('platform') || 'all',
        sort: q.get('sort') || undefined,
        mix,
        sessionId,
        seed: sessionId + ':' + offset + ':' + Math.floor(Date.now() / 30000),
      },
    });
    result.items = result.items.map((it) => ({
      ...it,
      signal_pretty: {
        views: shortNum((it.signal || {}).views),
        likes: shortNum((it.signal || {}).likes),
        comments: shortNum((it.signal || {}).comments),
        shares: shortNum((it.signal || {}).shares),
        source: (it.signal || {}).source,
      },
      liked: false,
    }));
    result.meta.session = {
      id: sessionId,
      seen: Object.keys(session.seen || {}).length,
      top_tags: Object.entries(session.tags || {}).sort((a, b) => b[1] - a[1]).slice(0, 6)
        .map(([tag, w]) => ({ tag, weight: Number(w.toFixed(1)) })),
    };
    send(res, 200, result);
  });

  /* ------------------------------------------------------------- videos */
  route('GET', /^\/api\/videos$/, async (req, res) => {
    const q = new URL(req.url, 'http://x').searchParams;
    const term = (q.get('q') || '').trim().toLowerCase();
    const platform = q.get('platform') || 'all';
    const tag = (q.get('tag') || '').trim().toLowerCase();
    const status = q.get('status') || 'live';
    const sort = q.get('sort') || 'recent';
    const limit = Math.min(120, Number(q.get('limit')) || 48);
    const offset = Math.max(0, Number(q.get('offset')) || 0);

    let list = store.allVideos();
    if (status !== 'all') list = list.filter((v) => v.status === status);
    if (platform !== 'all') list = list.filter((v) => v.platform === platform);
    if (tag) list = list.filter((v) => (v.tags || []).includes(tag));
    if (term) {
      list = list.filter((v) =>
        (v.title || '').toLowerCase().includes(term) ||
        (v.author || '').toLowerCase().includes(term) ||
        (v.tags || []).some((t) => t.includes(term)) ||
        v.platform_id.includes(term));
    }

    const sorters = {
      recent: (a, b) => b.created_at - a.created_at,
      oldest: (a, b) => a.created_at - b.created_at,
      top: (a, b) => ((b.signal?.views || 0) + (b.ours?.views || 0) * 100) - ((a.signal?.views || 0) + (a.ours?.views || 0) * 100),
      likes: (a, b) => (b.signal?.likes || 0) - (a.signal?.likes || 0),
      watched: (a, b) => (b.ours?.watch_ms || 0) - (a.ours?.watch_ms || 0),
      az: (a, b) => (a.title || '').localeCompare(b.title || ''),
    };
    list.sort(sorters[sort] || sorters.recent);

    const total = list.length;
    send(res, 200, {
      total,
      offset,
      limit,
      items: list.slice(offset, offset + limit).map(publicVideo),
      facets: {
        platforms: { all: total, tiktok: list.filter((v) => v.platform === 'tiktok').length, facebook: list.filter((v) => v.platform === 'facebook').length },
      },
    });
  });

  route('GET', /^\/api\/videos\/([\w\-]+)$/, async (req, res, m) => {
    const v = store.getVideo(m[1]);
    if (!v) return send(res, 404, { error: 'not found' });
    send(res, 200, { video: publicVideo(v) });
  });

  /* -------------------------------------------------------------- ingest */
  route('POST', /^\/api\/videos\/ingest$/, async (req, res) => {
    const body = await readBody(req);
    if (!body.url) return send(res, 400, { error: 'Paste a TikTok or Facebook video URL.' });

    const result = await platforms.inspect(body.url);
    if (result.error) {
      return send(res, 422, {
        error: result.error,
        hint: 'ReelBlend indexes public videos only. Private, friends-only or login-gated posts cannot be embedded.',
      });
    }
    const { norm, meta } = result;
    const id = `${norm.platform.slice(0, 2)}_${norm.platform_id}`;
    if (store.getVideo(id) && !body.force) {
      return send(res, 409, { error: 'That video is already in the catalog.', video: publicVideo(store.getVideo(id)) });
    }

    const tags = Array.isArray(body.tags)
      ? body.tags.map((t) => String(t).toLowerCase().replace(/^#/, '').trim()).filter(Boolean).slice(0, 8)
      : [];
    const inlineTags = [...String(body.title || '').matchAll(/#(\w+)/g)].map((m2) => m2[1].toLowerCase());
    const autoTags = [...new Set([...inlineTags, ...extractKeywords(meta.title)])];

    const video = store.upsertVideo({
      id,
      platform: norm.platform,
      platform_id: norm.platform_id,
      source_url: norm.source_url,
      embed: norm.embed,
      title: body.title || meta.title || '',
      author: meta.author || norm.page || '',
      author_url: meta.author_url || '',
      thumbnail: meta.thumbnail || '',
      tags: [...new Set([...tags, ...autoTags])].slice(0, 8),
      aspect: meta.aspect,
      status: body.publish === false ? 'pending' : 'live',
      origin: 'curated',
      metadata: meta.metadata,
      verified: !!meta.verified,
      needs_caption: !(body.title || meta.title),
      oembed_provider: meta.oembed_provider,
      signal: { views: 0, likes: 0, comments: 0, shares: 0, source: 'none' },
      created_at: Date.now(),
      verified_at: iso(Date.now()),
      published_at: body.publish === false ? null : iso(Date.now()),
      curator_note: body.note || null,
    });

    const notes = {
      full: 'Caption, author and thumbnail verified through TikTok’s official oEmbed endpoint.',
      'embed-only':
        'Facebook’s public oEmbed exposes no caption or thumbnail, so the caption is yours to write — the embed itself is fully live.',
      deferred:
        'Metadata is deferred (the platform’s metadata API is throttling or unavailable). The video still plays through the official player.',
    };
    send(res, 201, {
      ok: true,
      warning: result.warning || null,
      video: publicVideo(video),
      resolved: {
        platform: norm.platform,
        platform_id: norm.platform_id,
        oembed_provider: meta.oembed_provider || 'embed-only (no metadata call needed)',
        metadata_mode: meta.metadata,
        verified: !!meta.verified,
        note: notes[meta.metadata] || notes.deferred,
      },
    });
  });

  route('POST', /^\/api\/videos\/([\w\-]+)\/publish$/, async (req, res, m) => {
    const v = store.getVideo(m[1]);
    if (!v) return send(res, 404, { error: 'not found' });
    const body = await readBody(req);
    if (body.title !== undefined) v.title = String(body.title).slice(0, 300);
    if (Array.isArray(body.tags)) v.tags = body.tags.map((t) => String(t).toLowerCase().replace(/^#/, '')).slice(0, 8);
    if (body.status === 'pending' || body.status === 'live') v.status = body.status;
    else v.status = 'live';
    v.needs_caption = !v.title;
    v.published_at = iso(Date.now());
    store.markDirty();
    send(res, 200, { ok: true, video: publicVideo(v) });
  });

  /** Re-run oEmbed enrichment for a video whose metadata was deferred. */
  route('POST', /^\/api\/videos\/([\w\-]+)\/enrich$/, async (req, res, m) => {
    const v = store.getVideo(m[1]);
    if (!v) return send(res, 404, { error: 'not found' });
    const result = await platforms.inspect(v.source_url);
    if (result.error) return send(res, 422, { error: result.error });
    const meta = result.meta;
    if (meta.title) v.title = v.title || meta.title;
    if (meta.author) v.author = meta.author;
    if (meta.thumbnail) v.thumbnail = meta.thumbnail;
    if (meta.author_url) v.author_url = meta.author_url;
    v.metadata = meta.metadata;
    v.verified = !!meta.verified;
    v.needs_caption = !v.title;
    if (meta.verified) v.verified_at = iso(Date.now());
    store.markDirty();
    send(res, 200, {
      ok: !!meta.verified,
      warning: result.warning || null,
      video: publicVideo(v),
    });
  });

  route('DELETE', /^\/api\/videos\/([\w\-]+)$/, async (req, res, m) => {
    const ok = store.removeVideo(m[1]);
    send(res, ok ? 200 : 404, { ok });
  });

  /* --------------------------------------------------------- interaction */
  route('POST', /^\/api\/videos\/([\w\-]+)\/action$/, async (req, res, m) => {
    const v = store.getVideo(m[1]);
    if (!v) return send(res, 404, { error: 'not found' });
    const body = await readBody(req);
    const allowed = ['like', 'unlike', 'save', 'unsave', 'share', 'comment', 'not_interested', 'play', 'complete', 'skip', 'watch', 'impression'];
    if (!allowed.includes(body.type)) return send(res, 400, { error: 'unknown action type' });
    store.recordEvent({ type: body.type, video_id: v.id, session: body.session || 'anon', value: body.value, platform: v.platform });
    send(res, 200, { ok: true, video: publicVideo(store.getVideo(v.id)) });
  });

  /* -------------------------------------------------------------- events */
  route('POST', /^\/api\/events$/, async (req, res) => {
    const body = await readBody(req);
    const events = Array.isArray(body.events) ? body.events : [body];
    const allowed = new Set(['impression', 'play', 'watch', 'complete', 'skip', 'like', 'unlike', 'save', 'unsave',
      'share', 'comment', 'not_interested', 'session_start', 'session_end', 'mix_change', 'filter_change']);
    let accepted = 0;
    for (const e of events.slice(0, 200)) {
      if (!e || !allowed.has(e.type)) continue;
      store.recordEvent({
        type: e.type, video_id: e.video_id || null, session: e.session || 'anon',
        value: e.value ?? null, platform: e.platform || null,
      });
      accepted++;
    }
    send(res, 202, { ok: true, accepted });
  });

  /* --------------------------------------------------------------- stats */
  route('GET', /^\/api\/stats$/, async (req, res) => {
    const q = new URL(req.url, 'http://x').searchParams;
    const days = Math.max(1, Math.min(90, Number(q.get('days')) || 30));
    send(res, 200, store.stats(days));
  });

  /* -------------------------------------------------------------- config */
  route('GET', /^\/api\/config$/, async (req, res) => send(res, 200, store.config));
  route('PUT', /^\/api\/config$/, async (req, res) => {
    const body = await readBody(req);
    send(res, 200, { ok: true, config: store.updateConfig(body) });
  });
  route('POST', /^\/api\/config\/reset$/, async (req, res) => send(res, 200, { ok: true, config: store.resetConfig() }));

  /* ---------------------------------------------------------------- tags */
  route('GET', /^\/api\/tags$/, async (req, res) => {
    const counts = {};
    for (const v of store.allVideos()) for (const t of v.tags || []) counts[t] = (counts[t] || 0) + 1;
    send(res, 200, {
      tags: Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 60).map(([tag, n]) => ({ tag, n })),
    });
  });

  /* -------------------------------------------------------- dispatch ---- */
  return async function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    if (!url.pathname.startsWith('/api/')) return false;

    const cost = routeCost(req.method, url.pathname);
    const quota = spend(req, cost);
    if (!quota.ok) {
      send(res, 429, {
        error: 'Too many write requests from this client — slow down.',
        retry_after_seconds: quota.retry_after,
      }, { 'retry-after': String(quota.retry_after) });
      return true;   // contract: true means "this request is fully handled"
    }
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = url.pathname.match(r.pattern);
      if (!m) continue;
      try {
        await r.handler(req, res, m);
      } catch (e) {
        console.error('[api]', req.method, url.pathname, e);
        if (!res.headersSent) send(res, 500, { error: 'internal error', detail: String(e.message || e) });
      }
      return true;
    }
    send(res, 404, { error: 'no such endpoint', path: url.pathname });
    return true;
  };
}

/** Naive keyword extraction used to give ingested videos starter tags. */
function extractKeywords(title) {
  const stop = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'your', 'you', 'are', 'was', 'his', 'her',
    'but', 'not', 'all', 'new', 'out', 'how', 'why', 'what', 'when', 'its', 'it\'s', 'our', 'has', 'have', 'will',
    'video', 'watch', 'like', 'tiktok', 'facebook', 'reels', 'fyp', 'foryou', 'foryoupage', 'viral', 'trending']);
  return String(title || '')
    .toLowerCase()
    .replace(/[#@]\w+/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 3 && !stop.has(w))
    .slice(0, 4);
}

module.exports = { createApi, publicVideo, rid };
