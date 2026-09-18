#!/usr/bin/env node
'use strict';
/**
 * tools/smoke.js — end-to-end API check against a running ReelBlend.
 * Zero dependencies. Start the server first, then:
 *
 *   node server/index.js &
 *   node tools/smoke.js [baseUrl]
 *
 * Exits non-zero on the first failure, so it works as a deploy gate.
 */
const BASE = process.argv[2] || process.env.REELBLEND_URL || 'http://127.0.0.1:8787';

let pass = 0, fail = 0;
const results = [];

function ok(name, cond, detail) {
  (cond ? pass++ : fail++);
  results.push(`${cond ? '  ✓' : '  ✕'} ${name}${detail ? '  — ' + detail : ''}`);
  return cond;
}

async function req(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, data };
}

(async () => {
  console.log(`\nReelBlend smoke test → ${BASE}\n`);

  /* ---------- health + catalog ---------- */
  const health = await req('GET', '/api/health');
  ok('GET /api/health', health.status === 200 && health.data.ok === true);
  ok('catalog is populated', health.data.videos > 0, `${health.data.videos} videos`);

  /* ---------- static client ---------- */
  for (const [path, needle] of [['/', '<title>ReelBlend'], ['/app.js', 'ReelBlend'], ['/styles.css', '--blend']]) {
    const res = await fetch(BASE + path);
    const text = await res.text();
    ok(`static ${path}`, res.status === 200 && text.includes(needle), `${text.length} bytes`);
  }

  /* ---------- feed + blend quotas ---------- */
  const feed = await req('GET', '/api/feed?limit=10&session=smoke&mix=50');
  ok('GET /api/feed', feed.status === 200 && Array.isArray(feed.data.items) && feed.data.items.length === 10);
  ok('every item carries a why block', feed.data.items.every((i) => i.why && Array.isArray(i.why.reasons) && i.why.reasons.length));
  ok('every item has an official embed target', feed.data.items.every((i) =>
    i.platform === 'tiktok' ? i.embed.includes('tiktok.com/player/v1') : i.embed.includes('facebook.com/plugins/video.php')));

  const tt = await req('GET', '/api/feed?limit=8&session=smoke&mix=100');
  ok('mix=100 serves only TikTok', tt.data.items.every((i) => i.platform === 'tiktok'),
    tt.data.items.map((i) => i.platform[0]).join(''));
  const fb = await req('GET', '/api/feed?limit=8&session=smoke&mix=0');
  ok('mix=0 serves only Facebook', fb.data.items.every((i) => i.platform === 'facebook'),
    fb.data.items.map((i) => i.platform[0]).join(''));
  const mixed = await req('GET', '/api/feed?limit=10&session=smoke&mix=50');
  const mixedCount = mixed.data.items.filter((i) => i.platform === 'tiktok').length;
  ok('mix=50 actually blends', mixedCount > 0 && mixedCount < 10, `${mixedCount}/10 TikTok`);

  const sorted = await req('GET', '/api/feed?limit=6&session=smoke&sort=top');
  ok('sort=top works', sorted.status === 200 && sorted.data.items.length === 6);

  /* ---------- creator diversity ---------- */
  const big = await req('GET', '/api/feed?limit=20&session=smoke&mix=50');
  let worstRun = 1, run = 1;
  for (let i = 1; i < big.data.items.length; i++) {
    if (big.data.items[i].author && big.data.items[i].author === big.data.items[i - 1].author) { run++; worstRun = Math.max(worstRun, run); }
    else run = 1;
  }
  ok('creator spacing respected', worstRun <= 3, `longest same-creator run: ${worstRun}`);

  /* ---------- search & facets ---------- */
  const search = await req('GET', '/api/videos?limit=5&sort=recent');
  ok('GET /api/videos', search.status === 200 && search.data.items.length === 5, `${search.data.total} in catalog`);
  const tagged = await req('GET', '/api/videos?tag=' + (search.data.items[0].tags[0] || 'reels'));
  ok('tag filter', tagged.status === 200 && tagged.data.total > 0, `${tagged.data.total} tagged`);
  const tags = await req('GET', '/api/tags');
  ok('GET /api/tags', tags.status === 200 && tags.data.tags.length > 0, `${tags.data.tags.length} tags`);

  /* ---------- telemetry round-trip feed back into ranking ---------- */
  const target = feed.data.items[0];
  for (const type of ['impression', 'play', 'like', 'save', 'share']) {
    await req('POST', `/api/videos/${encodeURIComponent(target.id)}/action`, { type, session: 'smoke' });
  }
  const ev = await req('POST', '/api/events', {
    events: [
      { type: 'watch', video_id: target.id, session: 'smoke', value: 8000 },
      { type: 'complete', video_id: target.id, session: 'smoke' },
    ],
  });
  ok('POST /api/events', ev.status === 202 && ev.data.accepted === 2);

  const one = await req('GET', '/api/videos/' + encodeURIComponent(target.id));
  ok('telemetry persisted on the video', one.data.video.ours.likes > 0 && one.data.video.ours.watch_ms >= 8000,
    `likes=${one.data.video.ours.likes} watch=${one.data.video.ours.watch_ms}ms`);

  /* ---------- comments are stored, not just counted ---------- */
  await req('POST', `/api/videos/${encodeURIComponent(target.id)}/action`,
    { type: 'comment', session: 'smoke', value: 'smoke-test comment' });
  const withComment = await req('GET', '/api/videos/' + encodeURIComponent(target.id));
  ok('comment text stored', Array.isArray(withComment.data.video.comments) &&
    withComment.data.video.comments.some((c) => c.text === 'smoke-test comment'));

  /* ---------- stats ---------- */
  const stats = await req('GET', '/api/stats?days=7');
  ok('GET /api/stats', stats.status === 200 && stats.data.catalog.total > 0);
  ok('engagement aggregates computed', stats.data.engagement.likes > 0 && stats.data.engagement.watch_ms > 0);
  ok('14+ day series returned', stats.data.series.length >= 7, `${stats.data.series.length} points`);

  /* ---------- config ---------- */
  const put = await req('PUT', '/api/config', { mix: 60, weights: { watch: 2.0 }, halfLifeHours: 72 });
  ok('PUT /api/config', put.status === 200 && put.data.config.mix === 60 && put.data.config.weights.watch === 2.0);
  const clamped = await req('PUT', '/api/config', { mix: 999 });
  ok('config is clamped', clamped.data.config.mix === 100);
  await req('POST', '/api/config/reset');
  const reset = await req('GET', '/api/config');
  ok('config reset to defaults', reset.data.mix === 50 && reset.data.weights.watch === 1.4);

  /* ---------- ingest rejection paths ---------- */
  const bad = await req('POST', '/api/videos/ingest', { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' });
  ok('non-TikTok/Facebook link rejected', bad.status === 422 && /Unsupported source/.test(bad.data.error));
  const junk = await req('POST', '/api/videos/ingest', { url: 'not a url at all' });
  ok('garbage input rejected', junk.status === 422);

  /* ---------- 404s ---------- */
  const missing = await req('GET', '/api/videos/does_not_exist');
  ok('unknown video → 404', missing.status === 404);
  const noRoute = await req('GET', '/api/nope');
  ok('unknown endpoint → 404', noRoute.status === 404);

  console.log(results.join('\n'));
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('\nsmoke test crashed:', e.message);
  console.error('is the server running at ' + BASE + '?');
  process.exit(1);
});
