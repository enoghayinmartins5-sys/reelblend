'use strict';
/**
 * store.js — ReelBlend's persistence layer.
 *
 * A single JSON document with atomic writes and a debounced flusher. That is
 * deliberate: it needs no native modules, survives a hard kill, is trivially
 * inspectable (`data/store.json`) and moves to Postgres later without touching
 * any call sites — every read/write goes through this class.
 */
const fs = require('fs');
const path = require('path');
const { readJSON, writeJSONAtomic, hash32, now } = require('./util');

const MAX_EVENTS = 40000;      // raw event ring buffer (aggregates are separate)
const FLUSH_DEBOUNCE_MS = 800;

const DEFAULT_CONFIG = {
  mix: 50,                       // % of the feed that should be TikTok (0-100)
  autoplay: true,
  tapToPlay: false,
  algorithm: 'blend',            // blend | recent | top | fresh
  weights: {
    engagement: 1.0,
    freshness: 0.75,
    watch: 1.4,
    affinity: 1.1,
    explore: 0.22,               // epsilon: share of slate reserved for long-shots
  },
  halfLifeHours: 96,
  minAuthorGap: 2,               // slots between two videos from the same creator
  seenPenalty: 0.85,             // multiply score after N repeat impressions
  allowInject: true,
};

function emptyVideo() {
  return {
    ours: {
      impressions: 0, views: 0, watch_ms: 0, completions: 0,
      likes: 0, saves: 0, shares: 0, comments: 0, skips: 0, not_interested: 0,
    },
    comments: [],
  };
}

class Store {
  constructor({ seedPath, dataPath }) {
    this.seedPath = seedPath;
    this.dataPath = dataPath;
    this.state = {
      version: 1,
      config: JSON.parse(JSON.stringify(DEFAULT_CONFIG)),
      videos: {},
      events: [],
      sessions: {},
      createdAt: now(),
      updatedAt: now(),
    };
    this._flushTimer = null;
    this._dirty = false;
  }

  /* ------------------------------------------------------------------ boot */
  load() {
    const persisted = readJSON(this.dataPath, null);
    if (persisted && persisted.videos) {
      this.state = {
        ...this.state,
        ...persisted,
        config: { ...DEFAULT_CONFIG, ...(persisted.config || {}) },
        videos: persisted.videos || {},
        events: persisted.events || [],
        sessions: persisted.sessions || {},
      };
    }
    const added = this.importSeed();
    this.save();
    return { seeded: added, total: Object.keys(this.state.videos).length };
  }

  /** Import data/seed.json (built by tools/build_catalog.py) if present. */
  importSeed() {
    const seed = readJSON(this.seedPath, null);
    if (!seed || !Array.isArray(seed.videos)) return 0;
    let added = 0;
    const base = new Date(seed.generated_at || Date.now()).getTime();
    seed.videos.forEach((v, i) => {
      if (!v.id || this.state.videos[v.id]) return;
      this.state.videos[v.id] = {
        id: v.id,
        platform: v.platform,
        platform_id: v.platform_id,
        source_url: v.source_url,
        embed: v.embed,
        title: v.title || '',
        author: v.author || '',
        author_url: v.author_url || '',
        thumbnail: v.thumbnail || '',
        tags: Array.isArray(v.tags) ? v.tags : [],
        aspect: v.aspect || (v.platform === 'tiktok' ? '9:16' : '16:9'),
        status: 'live',
        origin: 'seed',
        metadata: v.metadata || (v.platform === 'tiktok' ? 'full' : 'embed-only'),
        verified: v.verified !== false,
        needs_caption: v.needs_caption === undefined ? !v.title : !!v.needs_caption,
        provenance: v.provenance || null,
        signal: v.signal || { views: 0, likes: 0, comments: 0, shares: 0, source: 'estimated' },
        // stagger seed timestamps over ~10 days so recency ranking has a curve
        created_at: base - i * 41 * 60 * 1000 - (hash32(v.id) % 9) * 36e5,
        verified_at: v.verified_at || null,
        last_served: 0,
        ...emptyVideo(),
      };
      added++;
    });
    return added;
  }

  /* --------------------------------------------------------------- write */
  markDirty() {
    this._dirty = true;
    if (this._flushTimer) return;
    this._flushTimer = setTimeout(() => {
      this._flushTimer = null;
      this.flush();
    }, FLUSH_DEBOUNCE_MS);
    if (this._flushTimer.unref) this._flushTimer.unref();
  }

  save() { this.flush(); }

  flush() {
    if (!this._dirty && fs.existsSync(this.dataPath)) return;
    this._dirty = false;
    this.state.updatedAt = now();
    try {
      writeJSONAtomic(this.dataPath, {
        version: this.state.version,
        config: this.state.config,
        videos: this.state.videos,
        events: this.state.events.slice(-MAX_EVENTS),
        sessions: this.state.sessions,
        createdAt: this.state.createdAt,
        updatedAt: this.state.updatedAt,
      });
    } catch (e) {
      console.error('[store] flush failed:', e.message);
    }
  }

  /* --------------------------------------------------------------- videos */
  allVideos() { return Object.values(this.state.videos); }
  getVideo(id) { return this.state.videos[id] || null; }
  count() { return Object.keys(this.state.videos).length; }

  upsertVideo(v) {
    const existing = this.state.videos[v.id];
    this.state.videos[v.id] = { ...emptyVideo(), ...existing, ...v };
    this.markDirty();
    return this.state.videos[v.id];
  }

  removeVideo(id) {
    if (!this.state.videos[id]) return false;
    delete this.state.videos[id];
    this.markDirty();
    return true;
  }

  /* ------------------------------------------------------------- config */
  get config() { return this.state.config; }

  updateConfig(patch = {}) {
    const c = this.state.config;
    if (patch.mix !== undefined) c.mix = Math.max(0, Math.min(100, Number(patch.mix) || 0));
    if (patch.autoplay !== undefined) c.autoplay = !!patch.autoplay;
    if (patch.tapToPlay !== undefined) c.tapToPlay = !!patch.tapToPlay;
    if (patch.algorithm && ['blend', 'recent', 'top', 'fresh'].includes(patch.algorithm)) c.algorithm = patch.algorithm;
    if (patch.halfLifeHours !== undefined) c.halfLifeHours = Math.max(1, Math.min(24 * 60, Number(patch.halfLifeHours) || 96));
    if (patch.minAuthorGap !== undefined) c.minAuthorGap = Math.max(0, Math.min(10, Number(patch.minAuthorGap) || 0));
    if (patch.seenPenalty !== undefined) c.seenPenalty = Math.max(0, Math.min(1, Number(patch.seenPenalty)));
    if (patch.weights && typeof patch.weights === 'object') {
      for (const k of Object.keys(DEFAULT_CONFIG.weights)) {
        if (patch.weights[k] !== undefined) {
          c.weights[k] = Math.max(0, Math.min(5, Number(patch.weights[k]) || 0));
        }
      }
    }
    this.markDirty();
    return c;
  }

  resetConfig() {
    this.state.config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    this.markDirty();
    return this.state.config;
  }

  /* ------------------------------------------------------------ sessions */
  session(id, mix) {
    let s = this.state.sessions[id];
    if (!s) {
      s = { id, created_at: now(), seen: {}, tags: {}, platforms: { tiktok: 0, facebook: 0 }, watch_ms: 0, actions: 0, mix: mix ?? this.state.config.mix };
      this.state.sessions[id] = s;
      this.markDirty();
    }
    if (mix !== undefined && mix !== null) s.mix = mix;
    s.last_seen = now();
    return s;
  }

  /* -------------------------------------------------------------- events */
  /**
   * Events are the feedback loop: they update per-video aggregates (fast to
   * rank over) and the session profile (personalisation + affinity).
   */
  recordEvent(ev) {
    const t = now();
    const event = {
      t, type: ev.type, video_id: ev.video_id || null,
      session: ev.session || 'anon', value: ev.value ?? null,
      platform: ev.platform || null,
    };
    this.state.events.push(event);
    if (this.state.events.length > MAX_EVENTS) this.state.events.splice(0, this.state.events.length - MAX_EVENTS);

    const v = event.video_id ? this.state.videos[event.video_id] : null;
    const s = ev.session ? this.session(ev.session) : null;

    if (v) {
      const o = v.ours;
      switch (event.type) {
        case 'impression': o.impressions++; v.last_served = t; break;
        case 'play': o.views++; break;
        case 'watch': {
          const ms = Math.max(0, Math.min(15 * 60 * 1000, Number(ev.value) || 0));
          o.watch_ms += ms;
          if (s) s.watch_ms += ms;
          break;
        }
        case 'complete': o.completions++; break;
        case 'skip': o.skips++; break;
        case 'like': o.likes++; break;
        case 'unlike': o.likes = Math.max(0, o.likes - 1); break;
        case 'save': o.saves++; break;
        case 'unsave': o.saves = Math.max(0, o.saves - 1); break;
        case 'share': o.shares++; break;
        case 'comment': {
          o.comments++;
          // keep the thread itself, capped, so the UI can render it
          if (typeof ev.value === 'string' && ev.value.trim()) {
            v.comments = (v.comments || []).slice(-99);
            v.comments.push({ t, text: String(ev.value).trim().slice(0, 400), session: event.session });
          }
          break;
        }
        case 'not_interested': o.not_interested++; break;
        default: break;
      }
    }

    if (s) {
      if (event.type === 'impression' && v) {
        s.seen[v.id] = (s.seen[v.id] || 0) + 1;
        s.platforms[v.platform] = (s.platforms[v.platform] || 0) + 1;
      }
      if (v && (event.type === 'like' || event.type === 'save' || event.type === 'complete' || event.type === 'share')) {
        // learning signal: boost the tags this viewer actually sticks with
        const bump = event.type === 'like' ? 1.6 : event.type === 'save' ? 1.8 : event.type === 'share' ? 2.0 : 1.0;
        for (const tag of v.tags || []) s.tags[tag] = (s.tags[tag] || 0) + bump;
        if (v.author) s.tags['@' + v.author.toLowerCase()] = (s.tags['@' + v.author.toLowerCase()] || 0) + 0.6;
      }
      if (v && event.type === 'not_interested') {
        for (const tag of v.tags || []) s.tags[tag] = (s.tags[tag] || 0) - 2.5;
        s.seen[v.id] = (s.seen[v.id] || 0) + 3;
      }
      if (event.type !== 'impression') s.actions++;
    }

    this.markDirty();
    return event;
  }

  /* --------------------------------------------------------------- stats */
  stats(rangeDays = 30) {
    const videos = this.allVideos();
    const since = now() - rangeDays * 864e5;
    const events = this.state.events.filter((e) => e.t >= since);
    const byType = {};
    for (const e of events) byType[e.type] = (byType[e.type] || 0) + 1;

    const platforms = { tiktok: { videos: 0, impressions: 0, views: 0, likes: 0, saves: 0, shares: 0, watch_ms: 0 },
                        facebook: { videos: 0, impressions: 0, views: 0, likes: 0, saves: 0, shares: 0, watch_ms: 0 } };
    let ours = { impressions: 0, views: 0, likes: 0, saves: 0, shares: 0, watch_ms: 0, completes: 0, skips: 0 };
    for (const v of videos) {
      const p = platforms[v.platform] || (platforms[v.platform] = { videos: 0, impressions: 0, views: 0, likes: 0, saves: 0, shares: 0, watch_ms: 0 });
      p.videos++;
      for (const k of ['impressions', 'views', 'likes', 'saves', 'shares', 'watch_ms']) {
        p[k] += v.ours[k] || 0;
        ours[k] += v.ours[k] || 0;
      }
      ours.completes += v.ours.completions || 0;
      ours.skips += v.ours.skips || 0;
    }

    const engagementRate = ours.views ? (ours.likes + ours.saves + ours.shares) / ours.views : 0;
    const avgWatchMs = ours.views ? ours.watch_ms / ours.views : 0;
    const sessions = Object.values(this.state.sessions);

    const top = videos
      .slice()
      .sort((a, b) => (b.ours.views * 2 + b.ours.likes * 5 + b.ours.saves * 4) - (a.ours.views * 2 + a.ours.likes * 5 + a.ours.saves * 4))
      .slice(0, 10)
      .filter((v) => v.ours.impressions > 0)
      .map((v) => ({ id: v.id, title: v.title || v.id, platform: v.platform, author: v.author, ours: v.ours }));

    // 14-day activity series for the dashboard chart
    const days = {};
    for (let d = rangeDays - 1; d >= 0; d--) {
      const key = new Date(now() - d * 864e5).toISOString().slice(0, 10);
      days[key] = { date: key, impressions: 0, plays: 0, likes: 0, sessions: 0 };
    }
    for (const e of events) {
      const key = new Date(e.t).toISOString().slice(0, 10);
      if (!days[key]) continue;
      if (e.type === 'impression') days[key].impressions++;
      if (e.type === 'play') days[key].plays++;
      if (e.type === 'like') days[key].likes++;
    }
    for (const s of sessions) {
      const key = new Date(s.created_at).toISOString().slice(0, 10);
      if (days[key]) days[key].sessions++;
    }

    const tagCounts = {};
    for (const v of videos) for (const t of v.tags || []) tagCounts[t] = (tagCounts[t] || 0) + 1;

    return {
      catalog: {
        total: videos.length,
        tiktok: videos.filter((v) => v.platform === 'tiktok').length,
        facebook: videos.filter((v) => v.platform === 'facebook').length,
        pending: videos.filter((v) => v.status === 'pending').length,
        tags: Object.keys(tagCounts).length,
        top_tags: Object.entries(tagCounts).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([tag, n]) => ({ tag, n })),
      },
      engagement: {
        ...ours,
        engagement_rate: Number(engagementRate.toFixed(4)),
        avg_watch_ms: Math.round(avgWatchMs),
        completion_rate: ours.views ? Number((ours.completes / ours.views).toFixed(4)) : 0,
        skip_rate: ours.views ? Number((ours.skips / ours.views).toFixed(4)) : 0,
      },
      platforms,
      sessions: { total: sessions.length, active_24h: sessions.filter((s) => (s.last_seen || 0) > now() - 864e5).length },
      events: { total: events.length, by_type: byType, range_days: rangeDays },
      series: Object.values(days),
      top,
      config: this.state.config,
    };
  }
}

module.exports = { Store, DEFAULT_CONFIG };
