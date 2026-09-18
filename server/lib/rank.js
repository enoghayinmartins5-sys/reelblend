'use strict';
/**
 * rank.js — the ReelBlend blend engine.
 *
 * A slate is built in four passes:
 *   1. SCORE     every eligible video on 5 signals, each normalised by
 *                percentile rank inside the current pool (robust to the huge
 *                outlier numbers that come with social video).
 *   2. QUOTA     respect the TikTok/Facebook mix slider as a soft quota.
 *   3. DIVERSIFY enforce a minimum gap between two videos by the same creator
 *                and thin out anything the viewer has already seen.
 *   4. EXPLORE   reserve a slice of the slate for long-shots so the feed does
 *                not collapse into an echo chamber after a few likes.
 *
 * Every item comes back with a `why` block: the exact components and the reason
 * strings that put it there. Feeds you cannot inspect are feeds you cannot tune.
 */
const { clamp, hash32, prng, now } = require('./util');

const WATCH_TARGET_MS = 12000;   // "a full watch" for short-form, for normalisation

function log1p(n) { return Math.log1p(Math.max(0, n || 0)); }

/** Percentile-rank normalisation: value -> 0..1 position within the pool. */
function percentile(values) {
  const idx = values.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const out = new Array(values.length).fill(0.5);
  const n = idx.length;
  if (n <= 1) return out.map(() => 1);
  for (let r = 0; r < n; r++) out[idx[r][1]] = r / (n - 1);
  return out;
}

/** Raw component values for one video (un-normalised). */
function components(v, session, cfg) {
  const eng = v.signal || {};
  const ours = v.ours || {};
  // blended engagement: platform signal (as given/estimated) + our own telemetry,
  // with our telemetry weighted heavily because it is the only first-party data.
  const engagementRaw =
    log1p((eng.likes || 0) * 0.6 + (eng.comments || 0) * 1.2 + (eng.shares || 0) * 1.8 + (eng.views || 0) * 0.05) +
    1.35 * log1p((ours.likes || 0) * 6 + (ours.saves || 0) * 7 + (ours.shares || 0) * 8 + (ours.comments || 0) * 3 + (ours.views || 0));

  const ageH = Math.max(0, (now() - (v.created_at || now())) / 36e5);
  const freshnessRaw = Math.pow(0.5, ageH / (cfg.halfLifeHours || 96));

  const watchRaw = ours.views ? clamp((ours.watch_ms / ours.views) / WATCH_TARGET_MS, 0, 1.6) : 0;

  let affinityRaw = 0;
  if (session) {
    for (const t of v.tags || []) affinityRaw += session.tags?.[t] || 0;
    const at = '@' + String(v.author || '').toLowerCase();
    affinityRaw += (session.tags?.[at] || 0) * 1.5;
    affinityRaw = log1p(affinityRaw * 3);
  }

  const seenCount = session?.seen?.[v.id] || 0;
  const fatigueRaw = seenCount ? Math.pow(cfg.seenPenalty ?? 0.85, seenCount * 3) : 1;
  const nopeRaw = ours.not_interested ? 1 : 0;

  return { engagementRaw, freshnessRaw, watchRaw, affinityRaw, fatigueRaw, nopeRaw, ageH, seenCount };
}

function reasonStrings(v, c, cfg, comps, session) {
  const r = [];
  if (comps.watch >= 0.7 && (v.ours.views || 0) >= 2) {
    r.push(`${Math.round((v.ours.watch_ms / Math.max(1, v.ours.views)) / 1000)}s average watch — holds attention`);
  }
  if (comps.freshness >= 0.75) {
    r.push(`fresh — ${c.ageH < 1 ? Math.round(c.ageH * 60) + 'm' : Math.round(c.ageH) + 'h'} old`);
  }
  if (comps.engagement >= 0.8) {
    r.push(v.signal?.source === 'api' ? 'top performer on ' + v.platform : 'strong platform engagement');
  }
  if (comps.affinity > 0.5) {
    const weights = session?.tags || {};
    const topTag = (v.tags || []).slice().sort((a, b) => (weights[b] || 0) - (weights[a] || 0))[0];
    if (topTag && (weights[topTag] || 0) > 0) r.push(`matches your #${topTag} signal`);
  }
  if (comps.seenCount) r.push(`seen ${comps.seenCount}x — down-ranked for repeat`);
  if (!r.length) r.push('discovery pick — outside your usual signals');
  return r;
}

/**
 * Build one slate.
 * @param {object} args
 *  videos   : array of video records
 *  session  : session object (seen/tags) or null
 *  config   : store config
 *  options  : { limit, offset, platform: 'all'|'tiktok'|'facebook', seed }
 */
function buildSlate({ videos, session, config, options = {} }) {
  const cfg = config;
  const limit = clamp(Number(options.limit) || 12, 1, 50);
  const offset = Math.max(0, Number(options.offset) || 0);
  const platformFilter = options.platform || 'all';
  const seed = Number(options.seed) || hash32((options.sessionId || 'anon') + ':' + offset);
  const rand = prng(seed);

  let pool = videos.filter((v) => v.status !== 'removed');
  if (options.status) pool = pool.filter((v) => v.status === options.status);
  if (platformFilter !== 'all') pool = pool.filter((v) => v.platform === platformFilter);

  // Hard filters: explicitly dismissed content never returns.
  pool = pool.filter((v) => !(v.ours && v.ours.not_interested > 0));

  const mode = options.sort || cfg.algorithm || 'blend';

  if (mode === 'recent') {
    pool.sort((a, b) => b.created_at - a.created_at);
    return finalize(pool.slice(offset, offset + limit).map(plainItem), pool.length, offset, limit, mode);
  }
  if (mode === 'top') {
    pool.sort((a, b) => scoreEngagementOnly(b) - scoreEngagementOnly(a));
    return finalize(pool.slice(offset, offset + limit).map(plainItem), pool.length, offset, limit, mode);
  }
  if (mode === 'fresh') {
    pool.sort((a, b) => (b.verified_at || '').localeCompare(a.verified_at || '') || b.created_at - a.created_at);
    return finalize(pool.slice(offset, offset + limit).map(plainItem), pool.length, offset, limit, mode);
  }

  /* -------- 1. score ---------------------------------------------------- */
  const raw = pool.map((v) => ({ v, c: components(v, session, cfg) }));
  const compsArr = {
    engagement: percentile(raw.map((r) => r.c.engagementRaw)),
    freshness: percentile(raw.map((r) => r.c.freshnessRaw)),
    watch: percentile(raw.map((r) => r.c.watchRaw)),
    affinity: percentile(raw.map((r) => r.c.affinityRaw)),
  };
  const w = cfg.weights || {};
  raw.forEach((r, i) => {
    const c = {
      engagement: compsArr.engagement[i],
      freshness: compsArr.freshness[i],
      watch: compsArr.watch[i],
      affinity: compsArr.affinity[i],
    };
    const wsum = (w.engagement || 0) + (w.freshness || 0) + (w.watch || 0) + (w.affinity || 0) || 1;
    let score = (
      (w.engagement || 0) * c.engagement +
      (w.freshness || 0) * c.freshness +
      (w.watch || 0) * c.watch +
      (w.affinity || 0) * c.affinity
    ) / wsum;
    score *= r.c.fatigueRaw;                 // repeat-impression fatigue
    score *= (1 - 0.9 * r.c.nopeRaw);        // dismissed
    r.score = score;
    r.comps = { ...c, seenCount: r.c.seenCount, ageH: r.c.ageH };
    r.reasons = reasonStrings(r.v, r.c, cfg, c, session);
  });

  /* -------- 2/3/4. quota + diversity + exploration ---------------------- */
  const ttPool = raw.filter((r) => r.v.platform === 'tiktok').sort((a, b) => b.score - a.score);
  const fbPool = raw.filter((r) => r.v.platform === 'facebook').sort((a, b) => b.score - a.score);

  const mix = clamp(Number(options.mix ?? cfg.mix ?? 50), 0, 100);
  const wantTT = Math.round((limit * mix) / 100);
  const wantFB = limit - wantTT;
  const exploreSlots = Math.round(limit * clamp(Number(w.explore ?? 0.2), 0, 0.5));

  const slate = [];
  const usedIds = new Set();
  const authorHistory = [];
  const longShots = [];

  const takeFrom = (arr, n, label) => {
    let taken = 0;
    for (const r of arr) {
      if (taken >= n) break;
      if (usedIds.has(r.v.id)) continue;
      const authorKey = (r.v.author || r.v.id).toLowerCase();
      const recentIdx = authorHistory.lastIndexOf(authorKey);
      const tooClose = recentIdx >= 0 && slate.length - recentIdx <= (cfg.minAuthorGap ?? 2);
      const isLongShot = r.score < 0.34;
      if (isLongShot && exploreSlots > 0) { longShots.push({ r, label }); continue; }
      if (tooClose) continue;                       // defer to the diversity pass
      slate.push({ r, label });
      usedIds.add(r.v.id);
      authorHistory.push(authorKey);
      taken++;
    }
    return taken;
  };

  if (platformFilter === 'all') {
    takeFrom(ttPool, wantTT, 'tiktok');
    takeFrom(fbPool, wantFB, 'facebook');
  } else {
    takeFrom(raw.sort((a, b) => b.score - a.score), limit, platformFilter);
  }

  // exploration: swap in long-shots for the weakest slots
  if (exploreSlots > 0 && longShots.length) {
    for (let i = 0; i < exploreSlots && longShots.length && slate.length; i++) {
      const pick = longShots.splice(Math.floor(rand() * longShots.length), 1)[0];
      if (usedIds.has(pick.r.v.id)) continue;
      // replace the lowest-scoring slot near the end of the slate
      let weakest = -1;
      for (let j = slate.length - 1; j >= Math.max(0, slate.length - Math.floor(limit / 2)); j--) {
        if (weakest === -1 || slate[j].r.score < slate[weakest].r.score) weakest = j;
      }
      if (weakest === -1) break;
      usedIds.delete(slate[weakest].r.v.id);
      slate[weakest] = pick;
      usedIds.add(pick.r.v.id);
      pick.r.reasons = ['exploration slot — keeping the feed from collapsing into an echo chamber'];
    }
  }

  // top-up: if a quota could not be met (e.g. one platform is exhausted), fill
  // from whatever is left rather than returning a short feed
  if (slate.length < limit) {
    const rest = raw.filter((r) => !usedIds.has(r.v.id)).sort((a, b) => b.score - a.score);
    const fill = [];
    for (const r of rest) {
      if (slate.length + fill.length >= limit) break;
      const authorKey = (r.v.author || r.v.id).toLowerCase();
      const recentIdx = authorHistory.lastIndexOf(authorKey);
      if (recentIdx >= 0 && slate.length + fill.length - recentIdx <= (cfg.minAuthorGap ?? 2)) continue;
      fill.push({ r, label: 'top-up' });
      usedIds.add(r.v.id);
      authorHistory.push(authorKey);
    }
    slate.push(...fill);
  }

  // diversity pass: break up same-creator runs that survived the quota passes
  const gap = cfg.minAuthorGap ?? 2;
  if (gap > 0) {
    for (let i = 1; i < slate.length; i++) {
      const a = (slate[i].r.v.author || slate[i].r.v.id).toLowerCase();
      for (let j = Math.max(0, i - gap); j < i; j++) {
        const b = (slate[j].r.v.author || slate[j].r.v.id).toLowerCase();
        if (a === b) {
          const swapIdx = slate.findIndex((s, k) => k > i && (s.r.v.author || s.r.v.id).toLowerCase() !== a
            && (slate[i - 1] ? (s.r.v.author || s.r.v.id).toLowerCase() !== (slate[i - 1].r.v.author || '').toLowerCase() : true));
          if (swapIdx > i) {
            const t = slate[i]; slate[i] = slate[swapIdx]; slate[swapIdx] = t;
          }
          break;
        }
      }
    }
  }

  // apply pagination over the assembled slate, extending until the page is full
  const needed = offset + limit;
  let ordered = slate;

  // If the slate is too small for the requested offset (deep scroll), top up
  // from the remaining ranked pool.
  if (ordered.length < needed) {
    const rest = raw.filter((r) => !usedIds.has(r.v.id)).sort((a, b) => b.score - a.score);
    for (const r of rest) {
      if (ordered.length >= needed) break;
      ordered.push({ r, label: 'deep-scroll' });
    }
  }

  const page = ordered.slice(offset, offset + limit).map(({ r, label }) => {
    const comps = { ...r.comps };
    return item(r.v, r.score, comps, r.reasons, label === 'tiktok' || label === 'facebook' ? mixReason(label, mix) : label);
  });

  return finalize(page, pool.length, offset, limit, 'blend', {
    mix, weights: w, exploreSlots, session_seen: session ? Object.keys(session.seen || {}).length : 0,
  });
}

function mixReason(label, mix) {
  return `${label} slot — holding the ${mix}% TikTok / ${100 - mix}% Facebook blend`;
}

function scoreEngagementOnly(v) {
  const eng = v.signal || {}; const o = v.ours || {};
  return log1p((eng.likes || 0) + (eng.views || 0) * 0.05) + log1p((o.likes || 0) * 6 + (o.views || 0));
}

function item(v, score, comps, reasons, label) {
  return {
    id: v.id,
    platform: v.platform,
    platform_id: v.platform_id,
    source_url: v.source_url,
    embed: v.embed,
    title: v.title,
    author: v.author,
    author_url: v.author_url,
    thumbnail: v.thumbnail,
    tags: v.tags || [],
    aspect: v.aspect,
    status: v.status,
    origin: v.origin,
    metadata: v.metadata,
    verified: v.verified !== false,
    needs_caption: !!v.needs_caption,
    provenance: v.provenance || null,
    created_at: v.created_at,
    signal: v.signal,
    ours: v.ours,
    comments: v.comments || [],
    score: Number((score || 0).toFixed(4)),
    why: { reasons: reasons || [], components: comps || {}, label: label || null },
  };
}

function plainItem(v) {
  return item(v, 0, {}, ['sorted view'], null);
}

function finalize(items, poolSize, offset, limit, mode, meta = {}) {
  const nextOffset = offset + items.length;
  return {
    items,
    nextCursor: items.length === limit && nextOffset < poolSize ? Buffer.from(JSON.stringify({ o: nextOffset })).toString('base64url') : null,
    meta: {
      mode,
      pool: poolSize,
      offset,
      limit,
      returned: items.length,
      generated_at: new Date().toISOString(),
      ...meta,
    },
  };
}

function parseCursor(cursor) {
  if (!cursor) return { offset: 0 };
  try {
    return JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
  } catch {
    return { offset: Number(cursor) || 0 };
  }
}

module.exports = { buildSlate, parseCursor, WATCH_TARGET_MS };
