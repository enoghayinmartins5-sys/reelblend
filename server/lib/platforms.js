'use strict';
/**
 * platforms.js — URL normalisation + metadata resolution for TikTok & Facebook.
 *
 * DESIGN RULE: ReelBlend never downloads, transcodes or re-hosts a video, and it
 * never parses platform HTML to work around a missing API. Every piece of
 * metadata here comes from a documented public oEmbed endpoint, and every frame
 * played in the app comes from the platform's own official embed player. The
 * creator keeps the view, the credit and the monetisation; we keep the index.
 *
 *   TikTok   -> https://www.tiktok.com/oembed?url=...            (no key needed)
 *               https://www.tiktok.com/player/v1/<id>            (official player)
 *   Facebook -> https://graph.facebook.com/v21.0/oembed_video    (no key needed)
 *               https://www.facebook.com/plugins/video.php?...  (official plugin)
 *
 * If a platform ever changes these, only this file needs to change.
 */

const UA = 'ReelBlend/1.0 (+embed aggregator; oembed-only)';
const OEMBED_TIMEOUT_MS = 9000;

const SHORT_HOSTS = {
  'vm.tiktok.com': 'tiktok',
  'vt.tiktok.com': 'tiktok',
  'fb.watch': 'facebook',
  'fb.me': 'facebook',
};

const TT_ID = /\/video\/(\d{6,})/;
const TT_SHORT_PATH = /^\/(?:t\/)?([A-Za-z0-9]{6,})\/?$/;

function safeUrl(input) {
  let raw = String(input || '').trim();
  if (!raw) return null;
  if (!/^https?:\/\//i.test(raw)) raw = 'https://' + raw;
  try {
    const u = new URL(raw);
    if (!/^https?:$/.test(u.protocol)) return null;
    return u;
  } catch {
    return null;
  }
}

function detectPlatform(input) {
  const u = safeUrl(input);
  if (!u) return null;
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  if (host.endsWith('tiktok.com')) return 'tiktok';
  if (host.endsWith('facebook.com') || host.endsWith('fb.watch') || host.endsWith('fb.me')) return 'facebook';
  return null;
}

/**
 * Canonicalise any public video URL shape into the fields we store.
 * Returns { platform, platform_id, source_url, embed, needs_resolve, kind }.
 */
function normalize(input) {
  const u = safeUrl(input);
  if (!u) return { error: 'That does not look like a URL.' };
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const platform = detectPlatform(input);
  if (!platform) {
    return { error: 'Unsupported source. ReelBlend indexes TikTok and Facebook videos.' };
  }

  const isShort = Object.prototype.hasOwnProperty.call(SHORT_HOSTS, host);

  if (platform === 'tiktok') {
    const m = u.pathname.match(TT_ID);
    if (m) {
      const id = m[1];
      return {
        platform, platform_id: id, kind: 'video',
        source_url: `https://www.tiktok.com/@${(u.pathname.split('/@')[1] || '').split('/')[0] || 'i'}/video/${id}`,
        embed: `https://www.tiktok.com/player/v1/${id}`,
      };
    }
    if (isShort || TT_SHORT_PATH.test(u.pathname)) {
      return { platform, needs_resolve: true, source_url: u.href, embed: null, kind: 'short' };
    }
    return { error: 'Could not find a video id in that TikTok link. Use the “Share → Copy link” URL.' };
  }

  // facebook
  let id = null;
  let page = '';
  const q = u.searchParams;
  if (q.get('v') && /^\d+$/.test(q.get('v'))) id = q.get('v');
  const vm = u.pathname.match(/\/(?:videos|reel|video)\/(\d+)/);
  if (!id && vm) id = vm[1];
  const pm = u.pathname.match(/^\/([\w.\-]+)\/(?:videos|reel)\//);
  if (pm) page = pm[1];
  const watchPath = /\/(?:watch|video|reel)/.test(u.pathname) || q.has('v');

  if (id && watchPath) {
    const source = page
      ? `https://www.facebook.com/${page}/videos/${id}/`
      : `https://www.facebook.com/watch/?v=${id}`;
    return {
      platform, platform_id: id, kind: 'video',
      page: page || null,
      source_url: source,
      embed: pluginEmbed(source),
    };
  }
  if (isShort || /^\/[\w.\-]+\/?$/.test(u.pathname) && host === 'fb.watch') {
    return { platform, needs_resolve: true, source_url: u.href, embed: null, kind: 'short' };
  }
  return {
    platform: 'facebook', platform_id: null, needs_resolve: true, source_url: u.href, embed: null,
    kind: 'unknown',
  };
}

function pluginEmbed(url, opts = {}) {
  // Official Facebook video plugin. autoplay/muted only apply when we render it
  // inside the reels player; the grid uses a click-to-load iframe.
  const p = new URLSearchParams({
    href: url,
    show_text: String(opts.showText === true),
    autoplay: String(opts.autoplay === true),
    muted: String(opts.muted !== false),
    'max-width': '100%',
  });
  return 'https://www.facebook.com/plugins/video.php?' + p.toString();
}

/** Follow vm.tiktok.com / fb.watch short links to their canonical destination. */
async function resolveShort(url) {
  const ctl = AbortSignal.timeout(OEMBED_TIMEOUT_MS);
  try {
    const res = await fetch(url, { redirect: 'follow', headers: { 'user-agent': UA }, signal: ctl });
    const finalUrl = res.url || url;
    return normalize(finalUrl);
  } catch {
    return { error: 'That short link could not be resolved (it may be private or expired).' };
  }
}

async function getJSON(url) {
  const ctl = AbortSignal.timeout(OEMBED_TIMEOUT_MS);
  const res = await fetch(url, {
    headers: { 'user-agent': UA, accept: 'application/json' },
    signal: ctl,
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

/**
 * Resolve public metadata through the platform's official oEmbed endpoint.
 *
 * IMPORTANT: oEmbed is *enrichment*, not a gate. A video's playback depends only
 * on its URL shape and the official player, which needs no API call at all. So a
 * platform outage, a rate-limit (403/429) or a region block degrades gracefully
 * to `metadata: 'deferred'` instead of rejecting a perfectly embeddable video.
 *
 *   mode 'full'       TikTok: caption, author, thumbnail, aspect
 *   mode 'embed-only' Facebook: the public API exposes no caption/thumbnail
 *   mode 'deferred'   the metadata API refused us right now — retry later
 */
class RateLimited extends Error {}
class VideoUnavailable extends Error {}

async function getJSON(url) {
  const ctl = AbortSignal.timeout(OEMBED_TIMEOUT_MS);
  const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: ctl });

  // 403/429 means "we are not talking to you right now" — the video itself may be
  // perfectly fine, so the caller degrades to deferred metadata.
  if (res.status === 403 || res.status === 429) {
    const e = new RateLimited('metadata endpoint returned HTTP ' + res.status);
    e.status = res.status;
    throw e;
  }
  // 400/404 from an oEmbed endpoint means the *video* is not there — deleted,
  // private, region-locked or simply not a real id. That is a real rejection.
  if (res.status === 400 || res.status === 404) {
    const e = new VideoUnavailable('HTTP ' + res.status);
    e.status = res.status;
    throw e;
  }
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

async function fetchMetadata(norm) {
  if (norm.platform === 'tiktok') {
    const d = await getJSON('https://www.tiktok.com/oembed?url=' + encodeURIComponent(norm.source_url));
    return {
      verified: true,
      metadata: 'full',
      oembed_provider: 'tiktok.com/oembed',
      title: (d.title || '').trim(),
      author: (d.author_name || '').trim(),
      author_url: d.author_url || '',
      thumbnail: d.thumbnail_url || '',
      aspect: '9:16',
    };
  }
  const d = await getJSON(
    'https://graph.facebook.com/v21.0/oembed_video?url=' + encodeURIComponent(norm.source_url)
  );
  return {
    verified: true,
    metadata: 'embed-only',
    oembed_provider: 'graph.facebook.com/oembed_video',
    title: (d.title || '').trim(),
    author: (d.author_name || '').trim() || (norm.page ? norm.page : ''),
    author_url: d.author_url || '',
    thumbnail: d.thumbnail_url || '',
    aspect: '16:9',
  };
}

/**
 * Full pipeline: normalise -> (resolve short link) -> enrich via oEmbed.
 * Never returns a hard error for a video we can legitimately embed.
 */
async function inspect(rawUrl) {
  let norm = normalize(rawUrl);
  if (norm.error) return { error: norm.error };
  if (norm.needs_resolve) {
    const resolved = await resolveShort(norm.source_url);
    if (resolved.error) return { error: resolved.error };
    if (!resolved.platform_id) {
      return { error: 'That link resolved to a page, not a single video. Open the video and copy its direct link.' };
    }
    norm = resolved;
  }

  const base = {
    verified: false,
    metadata: 'deferred',
    oembed_provider: null,
    title: '',
    author: norm.page || '',
    author_url: '',
    thumbnail: '',
    aspect: norm.platform === 'tiktok' ? '9:16' : '16:9',
  };

  try {
    return { norm, meta: { ...base, ...(await fetchMetadata(norm)) } };
  } catch (e) {
    if (e instanceof VideoUnavailable) {
      return {
        error:
          'That video is not available for embedding (the platform returned HTTP ' + e.status +
          '). It may be deleted, private, friends-only or region-locked.',
        norm,
      };
    }
    if (e instanceof RateLimited) {
      return {
        norm,
        meta: { ...base, rate_limited: true },
        warning:
          'The platform metadata API is rate-limiting right now (HTTP ' + e.status + '). ' +
          'The video is still embeddable through the official player — add a caption and it will play normally. ' +
          'Metadata can be re-fetched later with POST /api/videos/<id>/enrich.',
      };
    }
    return {
      norm,
      meta: base,
      warning:
        'Metadata could not be confirmed (' + e.message + '). The video will still be embedded through the ' +
        'platform\'s official player if it is public. Private, friends-only or region-locked videos will not play.',
    };
  }
}

module.exports = { detectPlatform, normalize, resolveShort, fetchMetadata, inspect, pluginEmbed, safeUrl, RateLimited, VideoUnavailable };
