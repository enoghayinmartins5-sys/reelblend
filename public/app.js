/* ==========================================================================
   ReelBlend — client
   Vanilla JS, no build step, no CDN. Talks to /api/* and renders two things:
   a reels player (vertical, autoplaying, with real feedback telemetry) and a
   curation console for the catalog.
   ========================================================================== */
(() => {
  'use strict';

  /* ------------------------------------------------------------ helpers */
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  /** h('div', {class:'x'}, 'html string', nodeOrArray, …) -> Element */
  function h(tag, props, ...kids) {
    const n = document.createElement(tag);
    if (props) for (const [k, v] of Object.entries(props)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'style') n.setAttribute('style', v);
      else if (k === 'dataset') Object.assign(n.dataset, v);
      else if (k.startsWith('on')) n.addEventListener(k.slice(2).toLowerCase(), v);
      else n.setAttribute(k, v === true ? '' : v);
    }
    const add = (kid) => {
      if (kid === null || kid === undefined || kid === false) return;
      if (Array.isArray(kid)) return kid.forEach(add);
      if (kid instanceof Node) return n.appendChild(kid);
      n.insertAdjacentHTML('beforeend', String(kid));
    };
    kids.forEach(add);
    return n;
  }

  const hash = (str) => {
    let x = 2166136261 >>> 0;
    for (let i = 0; i < String(str).length; i++) { x ^= String(str).charCodeAt(i); x = Math.imul(x, 16777619) >>> 0; }
    return x >>> 0;
  };
  const safeParse = (raw) => { try { return JSON.parse(raw || '[]'); } catch { return []; } };
  const fmt = (n) => {
    n = Number(n) || 0;
    const a = Math.abs(n);
    if (a >= 1e9) return (n / 1e9).toFixed(a >= 1e10 ? 0 : 1).replace(/\.0$/, '') + 'B';
    if (a >= 1e6) return (n / 1e6).toFixed(a >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M';
    if (a >= 1e3) return (n / 1e3).toFixed(a >= 1e4 ? 0 : 1).replace(/\.0$/, '') + 'K';
    return String(Math.round(n));
  };
  const secs = (ms) => { const s = Math.round((ms || 0) / 1000); return s < 60 ? s + 's' : Math.floor(s / 60) + 'm' + (s % 60) + 's'; };
  const ago = (ts) => {
    const d = (Date.now() - ts) / 1000;
    if (d < 60) return Math.round(d) + 's ago';
    if (d < 3600) return Math.round(d / 60) + 'm ago';
    if (d < 86400) return Math.round(d / 3600) + 'h ago';
    return Math.round(d / 86400) + 'd ago';
  };

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      headers: { 'content-type': 'application/json' },
      ...opts,
      body: opts.body && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body,
    });
    let data = null;
    try { data = await res.json(); } catch { /* empty */ }
    if (!res.ok) {
      const err = new Error((data && (data.error || data.detail)) || ('HTTP ' + res.status));
      err.status = res.status; err.data = data; throw err;
    }
    return data;
  }

  /**
   * Storage that cannot break the app. Inside a sandboxed iframe (opaque origin)
   * `localStorage` throws a SecurityError on *read* — so every access is guarded
   * and falls back to memory. Sessions, likes and saves still work; they just do
   * not survive a reload in that environment.
   */
  const mem = new Map();
  const store = {
    get(k) { try { return window.localStorage.getItem(k); } catch { return mem.has(k) ? mem.get(k) : null; } },
    set(k, v) { try { window.localStorage.setItem(k, v); } catch { mem.set(k, String(v)); } },
  };

  function toast(msg, isErr) {
    const t = $('#toast');
    t.hidden = false; t.textContent = msg; t.className = 'toast' + (isErr ? ' err' : '');
    clearTimeout(t._t);
    t._t = setTimeout(() => { t.hidden = true; }, 2600);
  }

  /* -------------------------------------------------------------- state */
  const SESSION_KEY = 'reelblend.session';
  const state = {
    view: 'reels',
    config: null,
    feed: [], idx: 0, cursor: null, feedCursor: null, loading: false,
    sort: 'blend', platform: 'all', tag: null,
    session: (() => {
      let s = store.get(SESSION_KEY);
      if (!s) { s = 's_' + Math.random().toString(36).slice(2, 10); store.set(SESSION_KEY, s); }
      return s;
    })(),
    liked: new Set(safeParse(store.get('reelblend.liked'))),
    saved: new Set(safeParse(store.get('reelblend.saved'))),
    noped: new Set(),
    autoAdvance: true, tapToPlay: false,
    explored: { offset: 0, limit: 48, total: 0 },
    dwell: { start: 0, raf: 0, accum: 0 },
    stats: { viewed: 0, liked: 0, watch: 0 },
    ingest: null,
  };
  const AUTO_ADVANCE_MS = 20000;

  /* ------------------------------------------------- event batching loop */
  const queue = [];
  function track(type, videoId, value, platform) {
    queue.push({ type, video_id: videoId || null, session: state.session, value: value ?? null, platform: platform || null });
  }
  async function flushEvents(force) {
    if (!queue.length) return;
    const batch = queue.splice(0, queue.length);
    try {
      await api('/api/events', { method: 'POST', body: { events: batch } });
    } catch (e) {
      if (force) console.warn('event flush failed', e.message);
    }
  }
  setInterval(flushEvents, 4000);
  window.addEventListener('visibilitychange', () => { if (document.hidden) { flushEvents(true); stopDwell(); } else startDwell(); });
  window.addEventListener('beforeunload', () => { navigator.sendBeacon && navigator.sendBeacon('/api/events', new Blob([JSON.stringify({ events: queue })], { type: 'application/json' })); });

  /* --------------------------------------------------------------- theme */
  function gradientFor(item) {
    const seed = hash(item.id);
    const hueA = item.platform === 'tiktok' ? 168 + (seed % 60) : 200 + (seed % 32);
    const hueB = item.platform === 'tiktok' ? 320 + (seed % 40) : 220 + (seed % 30);
    const a = `hsl(${hueA} 82% 42%)`, b = `hsl(${hueB} 78% 34%)`, c = `hsl(${(hueA + 20) % 360} 70% 12%)`;
    return `linear-gradient(155deg, ${a} 0%, ${b} 52%, ${c} 100%)`;
  }

  const GLYPH = {
    tiktok: `<svg viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,.9)" stroke-width="1.1">
      <path d="M9 17.5a3.5 3.5 0 1 1 3.5-3.5v-9" stroke-linecap="round"/>
      <path d="M12.5 5c.6 2.6 2.3 4.3 4.9 4.9" stroke-linecap="round"/></svg>`,
    facebook: `<svg viewBox="0 0 24 24" fill="rgba(255,255,255,.9)">
      <path d="M13.5 21v-8h2.8l.5-3.2h-3.3V7.7c0-.9.3-1.6 1.7-1.6h1.7V3.2C16.6 3.1 15.6 3 14.4 3c-2.4 0-4 1.4-4 4.1v2.7H7.7V13h2.7v8z"/></svg>`,
  };

  function posterHTML(item, big) {
    const badge = item.platform === 'tiktok'
      ? `<span class="badge tt">TikTok</span>` : `<span class="badge fb">Facebook</span>`;
    const extra = item.metadata === 'embed-only' ? `<span class="badge" style="border:1px solid var(--line-2)">caption by curator</span>` : '';
    const thumb = item.thumbnail
      ? `<div class="thumb" style="background-image:url('${esc(item.thumbnail)}')"></div>` : '';
    return `<div class="poster" style="background:${gradientFor(item)}">
      ${thumb}
      <div class="glyph">${GLYPH[item.platform] || ''}</div>
      <div class="pbadge">${badge}${extra}</div>
      <div class="ptext">
        <div class="ptitle">${esc(item.title || (item.author ? item.author : (item.platform === 'tiktok' ? 'TikTok video' : 'Facebook video')))}</div>
        <div class="pauthor">${item.author ? '@' + esc(item.author) : esc(item.platform)}${
          item.needs_caption ? ' · no caption published' : ' · ' + (item.aspect || '')}</div>
      </div>
    </div>`;
  }

  /* ------------------------------------------------------------- embeds */
  function embedURL(item, autoplay) {
    if (item.platform === 'tiktok') {
      const p = new URLSearchParams({
        autoplay: autoplay ? '1' : '0', loop: '1', controls: '1', progress_bar: '1',
        play_button: '1', volume_control: '1', fullscreen_button: '1', music_info: '1',
        description: '0', rel: '0', native_context_menu: '0', closed_caption: '1',
      });
      return `https://www.tiktok.com/player/v1/${encodeURIComponent(item.platform_id)}?${p}`;
    }
    const base = item.embed && item.embed.startsWith('https://www.facebook.com/plugins/video.php')
      ? item.embed
      : `https://www.facebook.com/plugins/video.php?href=${encodeURIComponent(item.source_url)}`;
    const u = new URL(base);
    u.searchParams.set('show_text', 'false');
    u.searchParams.set('autoplay', autoplay ? 'true' : 'false');
    u.searchParams.set('muted', 'true');
    return u.toString();
  }

  /* =====================================================================
     REELS VIEW
     ===================================================================== */
  async function loadFeed(reset = true) {
    if (state.loading) return;
    state.loading = true;
    if (reset) { state.feedCursor = null; }
    try {
      const qs = new URLSearchParams({
        limit: '10', session: state.session, sort: state.sort,
        platform: state.platform, mix: String(state.config ? state.config.mix : 50),
      });
      if (!reset && state.feedCursor) qs.set('cursor', state.feedCursor);
      const data = await api('/api/feed?' + qs);
      if (reset) { state.feed = data.items; state.idx = 0; }
      else state.feed = state.feed.concat(data.items);
      state.feedCursor = data.nextCursor;
      state.feedMeta = data.meta;
      renderStage();
      updateAlgoNote(data.meta);
      const empty = $('#stageEmpty');
      if (empty) empty.remove();
    } catch (e) {
      $('#stage').innerHTML = `<div class="stage-empty"><p>Could not load the feed: ${esc(e.message)}</p></div>`;
    } finally {
      state.loading = false;
    }
  }

  function currentItem() { return state.feed[state.idx] || null; }

  function renderStage() {
    const stage = $('#stage');
    const item = currentItem();
    if (!item) {
      stage.innerHTML = `<div class="stage-empty"><div class="spinner"></div><p>Pull up a mix…</p></div>`;
      return;
    }
    stage.innerHTML = '';
    stage.appendChild(h('div', { class: 'posterwrap', style: 'position:absolute;inset:0' }, posterHTML(item)));

    // live official embed, mounted only for the active reel
    const autoplay = state.autoAdvance && !state.tapToPlay;
    const box = h('div', { class: 'embedbox' + (item.platform === 'facebook' ? ' fb' : '') });
    const iframe = h('iframe', {
      src: embedURL(item, autoplay),
      allow: 'autoplay; encrypted-media; picture-in-picture; fullscreen; clipboard-write',
      allowfullscreen: true,
      referrerpolicy: 'strict-origin-when-cross-origin',
      title: item.title || 'video',
      loading: 'eager',
    });
    let loaded = false;
    iframe.addEventListener('load', () => { loaded = true; stopNote(); });
    box.appendChild(iframe);
    stage.appendChild(box);

    const note = h('div', { class: 'embed-note' }, 'Loading the official player…');
    stage.appendChild(note);
    function stopNote() { if (note.parentNode) note.remove(); }
    // if the platform's player cannot be framed here (offline preview, strict
    // privacy settings, region block) say so plainly instead of showing black
    setTimeout(() => {
      if (!loaded && note.parentNode) {
        note.innerHTML = `Player blocked here — <a href="${esc(item.source_url)}" target="_blank" rel="noopener" style="text-decoration:underline">open on ${item.platform === 'tiktok' ? 'TikTok' : 'Facebook'}</a>`;
      }
    }, 7000);

    if (state.tapToPlay) {
      stage.appendChild(h('button', {
        class: 'playveil', title: 'Play',
        onclick: (e) => { e.stopPropagation(); tapPlay(); },
      }, `<span class="ring"><svg viewBox="0 0 24 24"><path d="M8 5l11 7-11 7z" fill="#07070c"/></svg></span>`));
    }

    // right rail
    const liked = state.liked.has(item.id), saved = state.saved.has(item.id);
    const rail = h('div', { class: 'rail' });
    const mkBtn = (icon, label, on, handler, title) => h('div', { class: 'railwrap' },
      h('button', { class: 'railbtn' + (on ? ' on' : ''), title, onclick: handler }, icon),
      h('span', { class: 'cnt' }, label));
    rail.appendChild(mkBtn(heartIcon(), fmt((item.signal?.likes || 0) + (item.ours?.likes || 0) + (liked ? 1 : 0)), liked,
      () => toggle('like'), 'Like (L)'));
    rail.appendChild(mkBtn(`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/></svg>`,
      fmt((item.signal?.comments || 0) + (item.ours?.comments || 0)), false, () => openComments(item), 'Comments'));
    rail.appendChild(mkBtn(`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M6 3h12v18l-6-4.5L6 21z"/></svg>`,
      fmt(item.ours?.saves || 0), saved, () => toggle('save'), 'Save'));
    rail.appendChild(mkBtn(`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7"/><path d="M12 16V3m0 0L8 7m4-4l4 4"/></svg>`,
      'Share', false, () => openShare(item), 'Share the original link'));
    rail.appendChild(mkBtn(`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="9"/><path d="M8 8l8 8M16 8l-8 8"/></svg>`,
      'Not for me', state.noped.has(item.id), () => notInterested(item), 'Not interested'));
    stage.appendChild(rail);

    // meta overlay
    const meta = h('div', { class: 'stage-meta' });
    meta.appendChild(h('div', { class: 'meta-author' },
      `<span>${esc(item.author || item.platform)}</span><span class="meta-handle">· ${item.platform === 'tiktok' ? 'TikTok' : 'Facebook'} · ${ago(item.created_at)}</span>`));
    if (item.title) {
      meta.appendChild(h('div', { class: 'meta-title' }, esc(item.title)));
    } else {
      meta.appendChild(h('button', {
        class: 'chiptag', style: 'border-color:rgba(255,255,255,.35);font-weight:600',
        onclick: () => openCaptionEditor(item),
      }, '＋ Add a caption'));
    }
    if (item.provenance) {
      meta.appendChild(h('div', { style: 'font-size:11px;color:rgba(255,255,255,.5);margin-top:6px' }, esc(item.provenance)));
    }
    if (item.tags && item.tags.length) {
      const tl = h('div', { class: 'meta-tags' });
      item.tags.slice(0, 5).forEach((t) => tl.appendChild(
        h('span', { class: 'chiptag', onclick: () => { switchView('explore'); $('#exploreSearch').value = '#' + t; applyTagFilter(t); } }, '#' + esc(t))));
      meta.appendChild(tl);
    }
    meta.appendChild(h('div', { class: 'meta-stats' },
      `<span>▶ ${fmt(item.signal?.views || 0)} views</span>
       <span>♥ ${fmt(item.signal?.likes || 0)}</span>
       <span>↗ ${fmt(item.signal?.shares || 0)}</span>
       <span>here: ${fmt(item.ours?.views || 0)} plays · ${fmt(item.ours?.likes || 0)} likes</span>`));
    meta.appendChild(h('a', { class: 'meta-src', href: item.source_url, target: '_blank', rel: 'noopener' },
      `Open original on ${item.platform === 'tiktok' ? 'TikTok' : 'Facebook'} ↗`));
    stage.appendChild(meta);

    renderWhy(item);
    $('#posIndicator').textContent = `${state.idx + 1} / ${state.feed.length}`;
    startDwell();
    // prefetch the next page before the viewer reaches the end
    if (state.idx >= state.feed.length - 3 && state.feedCursor) loadFeed(false);
  }

  const heartIcon = () => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M12 20s-7-4.4-7-9.3A4.2 4.2 0 0 1 12 7.6a4.2 4.2 0 0 1 7 3.1C19 15.6 12 20 12 20z"/></svg>`;

  function tapPlay() {
    const item = currentItem(); if (!item) return;
    const box = $('.embedbox');
    if (!box) return;
    const iframe = box.querySelector('iframe');
    iframe.src = embedURL(item, true);
    const veil = $('.playveil'); if (veil) veil.remove();
    note('Playing the official embed.');
    setTimeout(() => { const n = $('.embed-note'); if (n) n.remove(); }, 2500);
  }
  function note(msg) {
    const stage = $('#stage');
    let n = $('.embed-note', stage);
    if (!n) { n = h('div', { class: 'embed-note' }); stage.appendChild(n); }
    n.textContent = msg;
  }

  /* --------------------------------------------------- dwell / watch time */
  function startDwell() {
    stopDwell();
    state.dwell.start = performance.now();
    state.dwell.accum = 0;
    const item = currentItem(); if (!item) return;
    track('impression', item.id, null, item.platform);
    track('play', item.id, null, item.platform);
    state.stats.viewed++;
    updateSessionStats();
    const tick = () => {
      const item2 = currentItem(); if (!item2) return;
      const t = state.dwell.accum + (performance.now() - state.dwell.start);
      const pct = Math.min(100, (t / AUTO_ADVANCE_MS) * 100);
      const bar = $('#dwellBar'); if (bar) bar.style.width = pct + '%';
      if (t >= AUTO_ADVANCE_MS * 0.92 && !state.dwell.completed) {
        state.dwell.completed = true;
        track('complete', item2.id, null, item2.platform);
      }
      if (state.autoAdvance && t >= AUTO_ADVANCE_MS) { state.dwell.completed = false; return advance(1, 'auto'); }
      state.dwell.raf = requestAnimationFrame(tick);
    };
    state.dwell.completed = false;
    state.dwell.raf = requestAnimationFrame(tick);
  }
  function stopDwell(record) {
    if (!state.dwell.raf) return;
    cancelAnimationFrame(state.dwell.raf);
    state.dwell.accum += performance.now() - state.dwell.start;
    state.dwell.raf = 0;
    const item = currentItem();
    if (item && state.dwell.accum > 400) {
      state.stats.watch += state.dwell.accum;
      track('watch', item.id, Math.round(state.dwell.accum), item.platform);
      updateSessionStats();
    }
  }

  function advance(dir, reason) {
    stopDwell();
    const next = state.idx + dir;
    if (next < 0) { toast('That is the start of the mix.'); startDwell(); return; }
    if (next >= state.feed.length) {
      if (state.feedCursor) {
        toast('Loading more…');
        loadFeed(false).then(() => { if (state.feed.length > next) { state.idx = next; renderStage(); } });
      } else {
        toast('That is the whole mix. Hit “New mix” for a fresh blend.');
        startDwell();
      }
      return;
    }
    if (reason !== 'auto' && dir > 0) {
      const item = currentItem();
      if (item && state.dwell.accum < AUTO_ADVANCE_MS * 0.45) track('skip', item.id, Math.round(state.dwell.accum), item.platform);
    }
    state.idx = next;
    renderStage();
  }

  function updateSessionStats() {
    $('#ssViewed').textContent = state.stats.viewed;
    $('#ssLiked').textContent = state.liked.size;
    $('#ssWatch').textContent = secs(state.stats.watch);
    const top = state.feedMeta && state.feedMeta.session && state.feedMeta.session.top_tags;
    $('#ssTag').textContent = top && top.length ? '#' + top[0].tag : '—';
  }

  async function toggle(kind) {
    const item = currentItem(); if (!item) return;
    const set = kind === 'like' ? state.liked : state.saved;
    const on = set.has(item.id);
    if (on) set.delete(item.id); else set.add(item.id);
    store.set('reelblend.' + kind + 'd', JSON.stringify(Array.from(set)));
    const type = on ? 'un' + kind : kind;
    if (kind === 'like') { if (on) state.stats.liked--; else state.stats.liked++; }
    try {
      const res = await api(`/api/videos/${encodeURIComponent(item.id)}/action`, {
        method: 'POST', body: { type, session: state.session },
      });
      item.ours = res.video.ours;
    } catch { /* keep the optimistic UI */ }
    toast(on ? `Removed ${kind}.` : kind === 'like' ? 'Liked — the blend will learn from this.' : 'Saved to your library.');
    renderStage();
  }

  async function notInterested(item) {
    if (!state.noped.has(item.id)) {
      try { await api(`/api/videos/${encodeURIComponent(item.id)}/action`, { method: 'POST', body: { type: 'not_interested', session: state.session } }); } catch {}
      state.noped.add(item.id);
    }
    toast('Got it — fewer reels like this.');
    state.feed.splice(state.idx, 1);
    if (state.idx >= state.feed.length) state.idx = Math.max(0, state.feed.length - 1);
    if (!state.feed.length) loadFeed(true); else renderStage();
  }

  function renderWhy(item) {
    const w = item.why || {};
    $('#whyLabel').textContent = w.label || (w.components ? 'scored' : '—');
    const ul = $('#whyList');
    ul.innerHTML = (w.reasons && w.reasons.length ? w.reasons : ['served as a sorted view']).map((r) => `<li>${esc(r)}</li>`).join('');
    const c = w.components || {};
    const rows = [
      ['engagement', c.engagement], ['freshness', c.freshness],
      ['watch-through', c.watch], ['your affinity', c.affinity],
    ].filter(([, v]) => typeof v === 'number');
    $('#whyBars').innerHTML = rows.map(([k, v]) => `<div class="bar"><span>${k}</span>
      <span class="track"><i class="fill" style="width:${Math.round((v || 0) * 100)}%"></i></span>
      <b>${(v || 0).toFixed(2)}</b></div>`).join('') +
      (typeof w.components?.seenCount === 'number' && w.components.seenCount
        ? `<div class="bar"><span>seen before</span><span class="track"><i class="fill" style="width:${Math.min(100, w.components.seenCount * 20)}%"></i></span><b>${w.components.seenCount}×</b></div>` : '') +
      `<div class="bar"><span>final score</span><span class="track"><i class="fill" style="width:${Math.round((item.score || 0) * 100)}%"></i></span><b>${(item.score || 0).toFixed(3)}</b></div>`;
  }

  function updateAlgoNote(meta) {
    if (!meta || !meta.weights) return;
    const w = meta.weights;
    $('#algoText').innerHTML =
      `Pool of <b>${fmt(meta.pool)}</b> videos · you have already seen ${meta.session_seen || 0} of them.<br>` +
      `Quota: holding <b>${meta.mix}% TikTok / ${100 - meta.mix}% Facebook</b>, with ${meta.exploreSlots} exploration slot(s) per page.<br>` +
      `Weights — engagement <b>${w.engagement}</b>, freshness <b>${w.freshness}</b>, ` +
      `watch-through <b>${w.watch}</b>, affinity <b>${w.affinity}</b>. Click any reel and press <b>i</b> to see its score.`;
  }

  /* --------------------------------------------------------- comments UI */
  function openComments(item) {
    const body = $('#modalBody');
    const count = (item.ours?.comments || 0);
    body.innerHTML = `<h3>Comments on this reel <span class="pill">${count} in your app</span></h3>
      <p class="hint">ReelBlend keeps its own comment thread on top of the embed — the original conversation stays on ${item.platform === 'tiktok' ? 'TikTok' : 'Facebook'}.</p>
      <div class="row" style="margin-top:14px">
        <input class="input grow" id="cmtInput" placeholder="Add a note for your curators…" />
        <button class="btn primary" id="cmtSend">Post</button>
      </div>
      <p class="hint">Native comments: <a href="${esc(item.source_url)}" target="_blank" rel="noopener" style="text-decoration:underline">open the post ↗</a></p>`;
    $('#modalBody').appendChild(h('div', { class: 'card', style: 'margin-top:12px' },
      elComments(item)));
    openModal();
    $('#cmtSend').onclick = async () => {
      const v = $('#cmtInput').value.trim(); if (!v) return;
      try {
        const res = await api(`/api/videos/${encodeURIComponent(item.id)}/action`, {
          method: 'POST', body: { type: 'comment', session: state.session, value: v },
        });
        item.ours = res.video.ours;
        item.comments = res.video.comments || [];
        $('#cmtInput').value = '';
        $('#modalBody').querySelector('.card').innerHTML = elComments(item);
        toast('Comment stored on the reel.');
      } catch (e) { toast(e.message, true); }
    };
  }
  function elComments(item) {
    const stored = (item.comments || []);
    return `<h3>Thread (${stored.length})</h3>` + (stored.length
      ? stored.map((c) => `<div class="pendrow" style="margin-bottom:8px"><div class="pb"><div class="pt">${esc(c.text)}</div><div class="pm">${esc(c.session)} · ${ago(c.t)}</div></div></div>`).join('')
      : `<p class="hint">No notes yet. Counted on the reel: ${item.ours?.comments || 0}.</p>`);
  }

  function openCaptionEditor(item) {
    $('#modalBody').innerHTML = `<h3>Caption this reel</h3>
      <p class="hint">${item.platform === 'facebook'
        ? 'Facebook’s public oEmbed does not expose captions, so this one is yours to write. It is stored against the reel in your own catalog — the original post is untouched.'
        : 'Write your own caption for this reel.'}</p>
      <div class="field" style="margin-top:12px"><span>Caption</span>
        <input class="input" id="capTitle" placeholder="A short, honest description…" value="${esc(item.title || '')}" /></div>
      <div class="field" style="margin-top:10px"><span>Tags (comma separated)</span>
        <input class="input" id="capTags" placeholder="archive, wrestling, 1990s" value="${esc((item.tags || []).join(', '))}" /></div>
      <div class="row" style="margin-top:14px">
        <button class="btn primary" id="capSave">Save caption</button>
        <a class="btn" href="${esc(item.source_url)}" target="_blank" rel="noopener">See the original ↗</a>
      </div>`;
    openModal();
    $('#capTitle').focus();
    $('#capSave').onclick = async () => {
      const title = $('#capTitle').value.trim();
      if (!title) return toast('A caption is required.', true);
      const tags = $('#capTags').value.split(',').map((t) => t.trim()).filter(Boolean);
      try {
        const r = await api(`/api/videos/${encodeURIComponent(item.id)}/publish`, { method: 'POST', body: { title, tags } });
        item.title = r.video.title; item.tags = r.video.tags; item.needs_caption = false;
        closeModal(); renderStage(); toast('Caption saved to your catalog.');
      } catch (e) { toast(e.message, true); }
    };
  }

  function openShare(item) {
    const url = item.source_url;
    const body = $('#modalBody');
    body.innerHTML = `<h3>Share this reel</h3>
      <p class="hint">ReelBlend shares the <b>original link</b> — the creator keeps the view and the credit.</p>
      <div class="row" style="margin-top:13px"><input class="input grow" id="shareUrl" value="${esc(url)}" readonly />
      <button class="btn primary" id="copyShare">Copy link</button></div>
      <p class="hint">Embed code for your own site:</p>
      <div class="log">&lt;iframe src="${esc(embedURL(item, false))}" width="325" height="578" frameborder="0" allow="autoplay; encrypted-media" allowfullscreen&gt;&lt;/iframe&gt;</div>`;
    openModal();
    $('#copyShare').onclick = async () => {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(url);
        else throw new Error('no clipboard');
        toast('Link copied.');
      } catch {
        const f = $('#shareUrl'); f.focus(); f.select();
        toast('Press ⌘/Ctrl+C to copy.');
      }
    };
    track('share', item.id, null, item.platform);
  }

  function openModal() { $('#modal').hidden = false; }
  function closeModal() { $('#modal').hidden = true; }

  /* =====================================================================
     EXPLORE
     ===================================================================== */
  async function loadExplore(reset = true) {
    if (reset) state.explored.offset = 0;
    const qs = new URLSearchParams({
      q: $('#exploreSearch').value.trim(),
      platform: state.platform,
      tag: state.tag || '',
      sort: $('#exploreSort').value,
      status: $('#exploreStatus').value,
      limit: String(state.explored.limit),
      offset: String(state.explored.offset),
    });
    const grid = $('#exploreGrid');
    if (reset) grid.innerHTML = `<div class="grid-empty"><div class="spinner" style="margin:0 auto 10px"></div>Loading catalog…</div>`;
    const data = await api('/api/videos?' + qs);
    state.explored.total = data.total;
    $('#exploreSub').textContent = `${data.total} videos match · ${data.facets.platforms.tiktok} TikTok · ${data.facets.platforms.facebook} Facebook`;
    if (reset) grid.innerHTML = '';
    if (!data.items.length && reset) {
      grid.innerHTML = `<div class="grid-empty">Nothing matches those filters yet. <br>Add videos in <b>Add videos</b>.</div>`;
      return;
    }
    const frag = document.createDocumentFragment();
    data.items.forEach((v) => frag.appendChild(cardFor(v)));
    grid.appendChild(frag);
    state.explored.offset += data.items.length;
    $('#exploreMore').hidden = state.explored.offset >= data.total;
  }

  function cardFor(v) {
    const liked = state.liked.has(v.id), saved = state.saved.has(v.id);
    const thumb = v.thumbnail
      ? `<img loading="lazy" src="${esc(v.thumbnail)}" alt="" onerror="this.style.display='none'">`
      : `<div class="fbposter" style="background:${gradientFor(v)}">
           <div class="glyph">${GLYPH[v.platform]}</div><div class="t">${esc(v.title || 'Facebook video')}</div></div>`;
    const card = h('div', { class: 'gcard' });
    card.innerHTML = `
      <div class="thumbwrap">
        ${thumb}
        <div class="corner"><span class="badge ${v.platform === 'tiktok' ? 'tt' : 'fb'}">${v.platform === 'tiktok' ? 'TikTok' : 'Facebook'}</span></div>
        <div class="dur">${v.signal_pretty ? v.signal_pretty.views : 0} views</div>
      </div>
      <div class="body">
        <div class="ct">${esc(v.title || '(no caption — add one)')}</div>
        <div class="ca"><span>${esc(v.author || v.platform)}</span><span>${ago(v.created_at)}</span></div>
        <div class="cstats"><span>♥ ${v.signal_pretty ? v.signal_pretty.likes : 0}</span><span>▶ ${v.ours.views}</span><span>⤓ ${v.ours.saves}</span></div>
        ${v.status === 'pending' ? '<div><span class="status pending">pending review</span></div>' : ''}
      </div>
      <div class="acts">
        <button class="minibtn" data-act="play">▶ Play</button>
        <button class="minibtn" data-act="feed">↻ To feed</button>
        <button class="minibtn" data-act="like">${liked ? '♥ Liked' : '♥ Like'}</button>
        <button class="minibtn" data-act="del">✕</button>
      </div>`;
    card.querySelector('[data-act=play]').onclick = () => openPlayerModal(v);
    card.querySelector('[data-act=feed]').onclick = () => {
      switchView('reels');
      state.feed.splice(state.idx + 1, 0, { ...v, why: { reasons: ['injected from the catalog by you'], components: {} } });
      toast('Queued right after the current reel.');
      renderStage();
    };
    card.querySelector('[data-act=like]').onclick = async (e) => {
      const on = state.liked.has(v.id);
      if (on) state.liked.delete(v.id); else state.liked.add(v.id);
      store.set('reelblend.liked', JSON.stringify(Array.from(state.liked)));
      e.target.textContent = on ? '♥ Like' : '♥ Liked';
      try { await api(`/api/videos/${encodeURIComponent(v.id)}/action`, { method: 'POST', body: { type: on ? 'unlike' : 'like', session: state.session } }); } catch {}
    };
    card.querySelector('[data-act=del]').onclick = async () => {
      if (!confirm('Remove this video from the catalog?')) return;
      await api('/api/videos/' + encodeURIComponent(v.id), { method: 'DELETE' });
      card.remove(); toast('Removed.');
    };
    return card;
  }

  function openPlayerModal(v) {
    $('#modalBody').innerHTML = `<h3>${esc(v.title || 'Reel')}</h3>
      <div class="row" style="align-items:flex-start;gap:18px">
        <div style="width:min(340px,45vw);aspect-ratio:9/16;border-radius:16px;overflow:hidden;background:#000;flex:none">
          <iframe src="${esc(embedURL(v, false))}" style="width:100%;height:100%;border:0"
            allow="autoplay; encrypted-media; fullscreen; picture-in-picture" allowfullscreen></iframe>
        </div>
        <div style="flex:1;min-width:220px">
          <div class="preview" style="border:0;padding:0;background:none">
            <div class="pv-body">
              <div class="pv-meta">${esc(v.platform)} · ${esc(v.source_url)}</div>
              <div class="pv-meta">author: ${esc(v.author || '—')}</div>
              <div class="pv-meta">metadata: ${esc(v.metadata || 'oembed')}</div>
              <div class="pv-meta">tags: ${(v.tags || []).map((t) => '#' + esc(t)).join(' ') || '—'}</div>
              <div class="pv-meta">your telemetry: ${v.ours.impressions} impressions · ${v.ours.views} plays · ${secs(v.ours.watch_ms)} watched</div>
            </div>
          </div>
          <p class="hint">Played through ${v.platform === 'tiktok' ? "TikTok's official player" : "Facebook's official video plugin"}. ReelBlend never downloads the file.</p>
          <div class="row" style="margin-top:12px">
            <a class="btn" href="${esc(v.source_url)}" target="_blank" rel="noopener">Open original ↗</a>
            <button class="btn" id="modalQueue">Queue in feed</button>
          </div>
        </div>
      </div>`;
    openModal();
    $('#modalQueue').onclick = () => {
      state.feed.splice(state.idx + 1, 0, { ...v, why: { reasons: ['injected from the catalog by you'], components: {} } });
      closeModal(); switchView('reels'); renderStage(); toast('Queued in your feed.');
    };
  }

  /* =====================================================================
     INGEST
     ===================================================================== */
  function logLine(cls, text) {
    const log = $('#ingestLog');
    if (log.querySelector('.muted')) log.innerHTML = '';
    log.appendChild(h('div', { class: cls }, esc(text)));
    log.scrollTop = log.scrollHeight;
  }

  async function verifyUrl() {
    const url = $('#ingestUrl').value.trim();
    if (!url) return toast('Paste a TikTok or Facebook link first.', true);
    $('#ingestVerify').disabled = true;
    $('#ingestResult').innerHTML = `<div class="hint">Contacting the platform…</div>`;
    logLine('', '$ POST /api/videos/ingest  { url: "' + url + '" }');
    try {
      const probe = await fetch('/api/videos/ingest', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url, publish: false }),
      });
      const data = await probe.json();
      if (!probe.ok) {
        logLine('err', '✕ ' + (data.error || 'verification failed'));
        if (data.hint) logLine('', '  ' + data.hint);
        $('#ingestResult').innerHTML = `<div class="preview" style="border-color:rgba(255,46,99,.4)">
          <div class="pv-body"><div class="pv-title">Could not verify that link</div>
          <div class="pv-meta">${esc(data.error || '')}</div>
          <p class="hint">${esc(data.hint || '')}</p></div></div>`;
        return;
      }
      state.ingest = data.video;
      logLine('ok', '✓ verified via ' + data.resolved.oembed_provider);
      logLine('', '  platform      ' + data.resolved.platform);
      logLine('', '  platform id   ' + data.resolved.platform_id);
      logLine('', '  metadata mode ' + data.resolved.metadata_mode);
      if (data.resolved.note) logLine('', '  note          ' + data.resolved.note);
      logLine('', '  embed         ' + data.video.embed);
      if (data.warning) logLine('err', '! ' + data.warning);
      showIngestPreview(data.video, data.resolved);
      if (!data.video.title && data.video.platform === 'facebook') {
        $('#ingestTitle').focus();
      }
    } catch (e) {
      logLine('err', '✕ ' + e.message);
      toast(e.message, true);
    } finally {
      $('#ingestVerify').disabled = false;
    }
  }

  function showIngestPreview(v, resolved) {
    const thumb = v.thumbnail ? `<img src="${esc(v.thumbnail)}" alt="">` : `<div class="glyph" style="opacity:.4">${GLYPH[v.platform]}</div>`;
    $('#ingestResult').innerHTML = '';
    const prev = h('div', { class: 'preview' });
    prev.innerHTML = `<div class="pv-thumb">${thumb}</div>
      <div class="pv-body">
        <div class="pv-title">${esc(v.title || '(no caption published — add one below)')}</div>
        <div class="pv-meta">${esc(v.author || v.platform)} · ${esc(v.source_url)}</div>
        <div class="pv-meta">${{
          full: 'caption + thumbnail verified',
          'embed-only': 'embed verified — no caption/thumbnail exposed by the API',
          deferred: 'metadata deferred — embed still live, retry later with /enrich',
        }[resolved.metadata_mode] || resolved.metadata_mode}</div>
        <div class="pv-actions">
          <a class="minibtn" style="text-decoration:none;text-align:center" href="${esc(v.source_url)}" target="_blank" rel="noopener">Open original ↗</a>
          <button class="minibtn" id="pvPlay">Preview embed</button>
        </div>
      </div>`;
    $('#ingestResult').appendChild(prev);
    prev.querySelector('#pvPlay').onclick = () => openPlayerModal(v);
    if (v.status === 'pending') {
      logLine('', '  stored as      pending review (not in the live feed yet)');
      loadPending();
    }
  }

  async function addToCatalog() {
    const url = $('#ingestUrl').value.trim();
    if (!url) return toast('Paste a link first.', true);
    const tags = $('#ingestTags').value.split(',').map((s) => s.trim()).filter(Boolean);
    const body = {
      url,
      title: $('#ingestTitle').value.trim() || undefined,
      tags,
      note: $('#ingestNote').value.trim() || undefined,
      publish: $('#ingestPublish').checked,
      force: true,
    };
    try {
      const data = await api('/api/videos/ingest', { method: 'POST', body });
      logLine('ok', '✓ saved to catalog as ' + data.video.id + ' (' + data.video.status + ')');
      toast('Added to your blend.');
      state.ingest = data.video;
      loadPending();
      if (data.video.status === 'live') {
        state.feed.splice(state.idx + 1, 0, { ...data.video, why: { reasons: ['you just added this'], components: {} } });
      }
    } catch (e) {
      logLine('err', '✕ ' + e.message);
      toast(e.message, true);
    }
  }

  async function loadPending() {
    const data = await api('/api/videos?status=pending&limit=60&sort=recent');
    $('#pendingCount').textContent = data.total;
    const list = $('#pendingList');
    list.innerHTML = '';
    if (!data.items.length) { list.innerHTML = '<p class="hint">Nothing waiting. Everything you verified was published straight into the feed.</p>'; return; }
    data.items.forEach((v) => {
      const row = h('div', { class: 'pendrow' });
      row.innerHTML = `<div class="pi">${v.thumbnail ? `<img src="${esc(v.thumbnail)}" alt="">` : ''}</div>
        <div class="pb"><div class="pt">${esc(v.title || '(no caption)')}</div>
        <div class="pm">${esc(v.platform)} · ${esc(v.id)} · ${ago(v.created_at)}</div></div>
        <div class="row">
          <button class="btn" data-a="edit">Edit & publish</button>
          <button class="btn ghost" data-a="pub">Publish</button>
          <button class="btn ghost" data-a="del">✕</button>
        </div>`;
      row.querySelector('[data-a=pub]').onclick = async () => {
        await api(`/api/videos/${encodeURIComponent(v.id)}/publish`, { method: 'POST', body: {} });
        toast('Published into the feed.'); loadPending();
      };
      row.querySelector('[data-a=edit]').onclick = () => {
        $('#ingestUrl').value = v.source_url;
        $('#ingestTitle').value = v.title || '';
        $('#ingestTags').value = (v.tags || []).join(', ');
        $('#ingestPublish').checked = true;
        window.scrollTo({ top: 0, behavior: 'smooth' });
        $('#ingestResult').innerHTML = `<p class="hint">Loaded ${esc(v.id)} into the editor — set the caption and press “Add to blend”.</p>`;
      };
      row.querySelector('[data-a=del]').onclick = async () => {
        await api('/api/videos/' + encodeURIComponent(v.id), { method: 'DELETE' });
        loadPending(); toast('Deleted.');
      };
      list.appendChild(row);
    });
  }

  /* =====================================================================
     ANALYTICS
     ===================================================================== */
  let rangeDays = 30;
  async function loadAnalytics() {
    const s = await api('/api/stats?days=' + rangeDays);
    const e = s.engagement;

    $('#kpis').innerHTML = [
      ['Catalog', fmt(s.catalog.total), `${s.catalog.tiktok} TikTok · ${s.catalog.facebook} Facebook`],
      ['Plays in your feed', fmt(e.views), `${fmt(e.impressions)} impressions`],
      ['Likes', fmt(e.likes), `${fmt(e.saves)} saves · ${fmt(e.shares)} shares`],
      ['Engagement rate', (e.engagement_rate * 100).toFixed(1) + '%', 'likes + saves + shares per play'],
      ['Avg watch', secs(e.avg_watch_ms), `completion ${(e.completion_rate * 100).toFixed(0)}% · skip ${(e.skip_rate * 100).toFixed(0)}%`],
      ['Sessions', fmt(s.sessions.total), `${s.sessions.active_24h} active in 24h`],
    ].map(([lab, val, sub]) => `<div class="kpi"><div class="lab">${lab}</div><div class="val">${val}</div><div class="sub2">${sub}</div></div>`).join('');

    drawChart(s.series);

    const total = Math.max(1, s.catalog.tiktok + s.catalog.facebook);
    const pct = (n) => (n / total) * 100;
    $('#platformSplit').innerHTML = `
      <div class="splitrow"><div class="sr-top"><span>TikTok in catalog</span><b>${s.catalog.tiktok} (${pct(s.catalog.tiktok).toFixed(0)}%)</b></div>
        <div class="sr-track"><i class="sr-fill" style="width:${pct(s.catalog.tiktok)}%;background:var(--tt-grad)"></i></div></div>
      <div class="splitrow"><div class="sr-top"><span>Facebook in catalog</span><b>${s.catalog.facebook} (${pct(s.catalog.facebook).toFixed(0)}%)</b></div>
        <div class="sr-track"><i class="sr-fill" style="width:${pct(s.catalog.facebook)}%;background:var(--fb-grad)"></i></div></div>
      <div class="splitrow"><div class="sr-top"><span>Plays served — TikTok</span><b>${fmt(s.platforms.tiktok.views)}</b></div>
        <div class="sr-track"><i class="sr-fill" style="width:${(s.platforms.tiktok.views / Math.max(1, s.platforms.tiktok.views + s.platforms.facebook.views)) * 100}%;background:var(--tt-grad)"></i></div></div>
      <div class="splitrow"><div class="sr-top"><span>Plays served — Facebook</span><b>${fmt(s.platforms.facebook.views)}</b></div>
        <div class="sr-track"><i class="sr-fill" style="width:${(s.platforms.facebook.views / Math.max(1, s.platforms.tiktok.views + s.platforms.facebook.views)) * 100}%;background:var(--fb-grad)"></i></div></div>
      <p class="hint">Blend target set in Reels: ${s.config.mix}% TikTok / ${100 - s.config.mix}% Facebook.</p>`;

    $('#topVideos').innerHTML = s.top.length ? s.top.map((v, i) => `
      <div class="toprow"><span class="num">${i + 1}</span>
        <span class="tt" title="${esc(v.title)}">${esc((v.title || v.id).slice(0, 58))}</span>
        <span class="st">${fmt(v.ours.views)} ▶ · ${fmt(v.ours.likes)} ♥</span></div>`).join('')
      : '<p class="hint">No impressions recorded yet — open Reels and watch a few.</p>';

    $('#tagCloud').innerHTML = s.catalog.top_tags.map((t) => `<span>#${esc(t.tag)}<b>${t.n}</b></span>`).join('');

    const w = s.config.weights;
    $('#weights').innerHTML = [
      ['engagement', w.engagement, 'How much platform likes/shares/comments move a reel up.'],
      ['freshness', w.freshness, 'Recency decay. Half-life is currently ' + s.config.halfLifeHours + 'h.'],
      ['watch', w.watch, 'First-party watch-through. Highest-value signal — it is the only one that measures your actual audience.'],
      ['affinity', w.affinity, 'Boost for tags and creators this viewer has liked, saved or finished before.'],
      ['explore', w.explore, 'Share of each slate reserved for long-shots, so the feed keeps finding new things.'],
    ].map(([k, v, d]) => `<div class="wrow"><div class="wl"><span>${k}</span><b>${Number(v).toFixed(2)}</b></div>
        <input type="range" min="0" max="3" step="0.05" value="${v}" data-w="${k}" />
        <div class="wd">${d}</div></div>`).join('');
    $$('#weights input[type=range]').forEach((r) => r.addEventListener('input', () => {
      r.previousElementSibling.querySelector('b').textContent = Number(r.value).toFixed(2);
    }));
  }

  function drawChart(series) {
    const w = 640, hgt = 190, pad = 26;
    const max = Math.max(1, ...series.map((d) => Math.max(d.impressions, d.plays, d.likes)));
    const x = (i) => pad + (i * (w - pad * 2)) / Math.max(1, series.length - 1);
    const y = (v) => hgt - pad - (v / max) * (hgt - pad * 2);
    const path = (key) => series.map((d, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(d[key]).toFixed(1)}`).join(' ');
    const area = (key) => `${path(key)} L${x(series.length - 1)},${hgt - pad} L${x(0)},${hgt - pad} Z`;
    $('#chart').innerHTML = `<svg viewBox="0 0 ${w} ${hgt}" preserveAspectRatio="none">
      <defs>
        <linearGradient id="a1" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#25f4ee" stop-opacity=".35"/><stop offset="1" stop-color="#25f4ee" stop-opacity="0"/></linearGradient>
      </defs>
      ${[0, 0.25, 0.5, 0.75, 1].map((f) => `<line x1="${pad}" x2="${w - pad}" y1="${y(max * f)}" y2="${y(max * f)}" stroke="rgba(255,255,255,.07)"/>`).join('')}
      <path d="${area('impressions')}" fill="url(#a1)"/>
      <path d="${path('impressions')}" fill="none" stroke="#25f4ee" stroke-width="2"/>
      <path d="${path('plays')}" fill="none" stroke="#ff2e63" stroke-width="2"/>
      <path d="${path('likes')}" fill="none" stroke="#4293ff" stroke-width="2"/>
      <text x="${pad}" y="14" fill="rgba(255,255,255,.4)" font-size="10" font-family="monospace">peak ${fmt(max)}</text>
      <text x="${w - pad}" y="${hgt - 6}" fill="rgba(255,255,255,.4)" font-size="10" text-anchor="end" font-family="monospace">${series.length} days</text>
    </svg>`;
  }

  async function saveWeights() {
    const weights = {};
    $$('#weights input[type=range]').forEach((r) => { weights[r.dataset.w] = Number(r.value); });
    const cfg = await api('/api/config', { method: 'PUT', body: { weights } });
    state.config = cfg.config;
    toast('Weights applied — the next feed request uses them.');
  }

  /* =====================================================================
     VIEW SWITCHING + WIRING
     ===================================================================== */
  function switchView(view) {
    state.view = view;
    $$('.view').forEach((v) => v.classList.toggle('is-active', v.id === 'view-' + view));
    $$('.tab').forEach((t) => t.classList.toggle('is-active', t.dataset.view === view));
    if (view === 'explore') { loadExplore(true); loadTags(); }
    if (view === 'ingest') loadPending();
    if (view === 'analytics') loadAnalytics();
    if (view === 'reels') { startDwell(); flushEvents(); }
    else stopDwell();
  }

  async function loadTags() {
    const data = await api('/api/tags');
    const strip = $('#tagStrip');
    strip.innerHTML = '';
    strip.appendChild(h('span', { class: 'chiptag' + (state.tag ? '' : ' is-on'), onclick: () => { state.tag = null; loadExplore(true); loadTags(); } }, 'All tags'));
    data.tags.slice(0, 18).forEach((t) => strip.appendChild(
      h('span', { class: 'chiptag', style: state.tag === t.tag ? 'background:rgba(37,244,238,.2)' : '', onclick: () => { state.tag = t.tag; loadExplore(true); loadTags(); } },
        `#${t.tag} <b style="opacity:.55;font-family:var(--mono);font-size:10px">${t.n}</b>`)));
  }
  function applyTagFilter(tag) { state.tag = tag; loadExplore(true); loadTags(); }

  function setMix(val) {
    const v = Math.max(0, Math.min(100, Number(val)));
    $('#mixSlime').value = v; $('#mixSlime2').value = v;
    $('#mixOut').textContent = `${v}/${100 - v}`;
    $('#mixOut2').textContent = `${v}% TikTok`;
    $('#mixOut3').textContent = `${100 - v}% Facebook`;
    if (state.config) state.config.mix = v;
    api('/api/config', { method: 'PUT', body: { mix: v } }).catch(() => {});
  }

  function wire() {
    $$('.tab, [data-view]').forEach((b) => b.addEventListener('click', (e) => {
      const v = b.dataset.view; if (!v) return;
      e.preventDefault(); switchView(v);
    }));
    $('#mixSlime').addEventListener('input', (e) => setMix(e.target.value));
    $('#mixSlime2').addEventListener('input', (e) => setMix(e.target.value));
    $('#reloadFeed').onclick = () => { toast('Rebuilding the blend…'); loadFeed(true); };
    $('#btnPrev').onclick = () => advance(-1, 'manual');
    $('#btnNext').onclick = () => advance(1, 'manual');
    $('#autoAdvance').addEventListener('change', (e) => { state.autoAdvance = e.target.checked; renderStage(); });
    $('#tapToPlay').addEventListener('change', (e) => { state.tapToPlay = e.target.checked; renderStage(); });
    $('#btnWhy').onclick = () => { const w = $('#whyCard'); w.scrollIntoView({ behavior: 'smooth', block: 'center' }); w.style.boxShadow = '0 0 0 2px var(--tt-cyan)'; setTimeout(() => (w.style.boxShadow = ''), 900); };
    $('#btnSound').onclick = () => toast('Each platform player owns its own audio control — use the speaker icon inside the frame.');

    $('#sortSeg').addEventListener('click', (e) => {
      const b = e.target.closest('.seg-btn'); if (!b) return;
      $$('#sortSeg .seg-btn').forEach((x) => x.classList.toggle('is-active', x === b));
      state.sort = b.dataset.sort; loadFeed(true); toast('Sort: ' + state.sort);
    });

    // explore
    $('#exploreSearch').addEventListener('input', debounce(() => loadExplore(true), 320));
    $('#platSeg').addEventListener('click', (e) => {
      const b = e.target.closest('.seg-btn'); if (!b) return;
      $$('#platSeg .seg-btn').forEach((x) => x.classList.toggle('is-active', x === b));
      state.platform = b.dataset.platform; loadExplore(true);
    });
    $('#exploreSort').addEventListener('change', () => loadExplore(true));
    $('#exploreStatus').addEventListener('change', () => loadExplore(true));
    $('#exploreMore').onclick = () => loadExplore(false);

    // ingest
    $('#ingestVerify').onclick = verifyUrl;
    $('#ingestAdd').onclick = addToCatalog;
    $('#ingestUrl').addEventListener('keydown', (e) => { if (e.key === 'Enter') verifyUrl(); });
    $('#ingestReset').onclick = () => {
      ['ingestUrl', 'ingestTitle', 'ingestTags', 'ingestNote'].forEach((id) => ($('#' + id).value = ''));
      $('#ingestResult').innerHTML = ''; toast('Cleared.');
    };
    // "Add to blend" also happens via Verify→preview→Add: bind a single primary action
    document.addEventListener('keydown', (e) => {
      const tgt = e.target;
      if (tgt && typeof tgt.matches === 'function' && tgt.matches('input, textarea, select')) {
        if (e.key === 'Enter' && e.target.id === 'ingestTitle') addToCatalog();
        return;
      }
      if (e.key === 'Escape') return closeModal();
      if (state.view !== 'reels') return;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === 'j' || e.key === ' ') { e.preventDefault(); advance(1, 'key'); }
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp' || e.key === 'k') { e.preventDefault(); advance(-1, 'key'); }
      else if (e.key === 'l') toggle('like');
      else if (e.key === 's') toggle('save');
      else if (e.key === 'i') $('#btnWhy').click();
      else if (e.key === 'r') $('#reloadFeed').click();
    });

    // analytics
    $('#rangeSeg').addEventListener('click', (e) => {
      const b = e.target.closest('.seg-btn'); if (!b) return;
      $$('#rangeSeg .seg-btn').forEach((x) => x.classList.toggle('is-active', x === b));
      rangeDays = Number(b.dataset.days); loadAnalytics();
    });
    $('#saveWeights').onclick = saveWeights;
    $('#resetConfig').onclick = async () => {
      const r = await api('/api/config/reset', { method: 'POST' });
      state.config = r.config; setMix(r.config.mix); loadAnalytics(); toast('Engine reset to defaults.');
    };

    // modal
    $('#modalClose').onclick = closeModal;
    $('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });

    // swipe + stage tap
    const stage = $('#stage');
    let y0 = null, x0 = null;
    stage.addEventListener('touchstart', (e) => { y0 = e.touches[0].clientY; x0 = e.touches[0].clientX; }, { passive: true });
    stage.addEventListener('touchend', (e) => {
      if (y0 === null) return;
      const dy = e.changedTouches[0].clientY - y0, dx = e.changedTouches[0].clientX - x0;
      if (Math.abs(dy) > 50 || Math.abs(dx) > 50) advance(dy < 0 || dx < 0 ? 1 : -1, 'swipe');
      y0 = null;
    }, { passive: true });
    stage.addEventListener('click', (e) => {
      if (e.target.closest('.rail') || e.target.closest('.stage-meta') || e.target.closest('.playveil')) return;
      advance(1, 'tap');
    });

    window.addEventListener('beforeunload', () => stopDwell(true));
  }

  function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

  /* ---------------------------------------------------------------- boot */
  async function boot() {
    wire();
    try {
      const health = await api('/api/health');
      $('#health').className = 'health ok';
      $('#healthText').textContent = `${health.videos} videos indexed`;
      $('#health').title = `${health.sources.tiktok} · ${health.sources.facebook} · ${health.policy}`;
    } catch {
      $('#health').className = 'health bad';
      $('#healthText').textContent = 'API offline';
    }
    try {
      state.config = await api('/api/config');
      setMix(state.config.mix);
      state.autoAdvance = state.config.autoplay !== false;
      $('#autoAdvance').checked = state.autoAdvance;
    } catch { setMix(50); }
    await loadFeed(true);
    setInterval(() => updateSessionStats(), 1500);
    track('session_start', null, null, null);
    // deep link: #reels/<id> jumps straight to a reel
    const m = location.hash.match(/^#reels\/(.+)$/);
    if (m) {
      const id = m[1];
      const found = state.feed.findIndex((x) => x.id === id);
      if (found >= 0) { state.idx = found; renderStage(); }
    }
  }

  document.addEventListener('DOMContentLoaded', boot);
  if (document.readyState !== 'loading') boot();
})();
