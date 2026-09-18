#!/usr/bin/env node
'use strict';
/**
 * tools/enrich.js — fill in metadata that was deferred when a platform throttled us.
 *
 *   node tools/enrich.js               # enrich everything flagged 'deferred'
 *   node tools/enrich.js --limit 20    # small batch
 *   node tools/enrich.js --id ti_123   # one video
 *
 * Runs against data/store.json directly (no server needed). Stops the moment a
 * platform starts refusing requests, so it is always safe to re-run later.
 */
const fs = require('fs');
const path = require('path');
const platforms = require('../server/lib/platforms');

const ROOT = path.resolve(__dirname, '..');
const STORE = path.join(ROOT, 'data', 'store.json');

const args = process.argv.slice(2);
const limitArg = args.indexOf('--limit');
const limit = limitArg > -1 ? Number(args[limitArg + 1]) : Infinity;
const idArg = args.indexOf('--id');
const onlyId = idArg > -1 ? args[idArg + 1] : null;

(async () => {
  if (!fs.existsSync(STORE)) {
    console.error('No data/store.json yet — start the server once so it can seed the catalog.');
    process.exit(1);
  }
  const store = JSON.parse(fs.readFileSync(STORE, 'utf8'));
  let todo = Object.values(store.videos).filter((v) => v.metadata === 'deferred' || !v.verified);
  if (onlyId) todo = todo.filter((v) => v.id === onlyId);
  // Facebook never returns captions, so only chase entries that are still unverified
  todo = todo.slice(0, limit === Infinity ? undefined : limit);

  console.log(`[enrich] ${todo.length} videos need metadata`);
  let done = 0, failed = 0, throttled = false;

  for (const v of todo) {
    if (throttled) break;
    try {
      const r = await platforms.inspect(v.source_url);
      if (r.error) { failed++; console.log(`  ! ${v.id}: ${r.error}`); continue; }
      const m = r.meta;
      if (m.verified) {
        v.title = v.title || m.title;
        v.author = m.author || v.author;
        v.author_url = m.author_url || v.author_url;
        v.thumbnail = m.thumbnail || v.thumbnail;
        v.metadata = m.metadata;
        v.verified = true;
        v.needs_caption = !v.title;
        v.verified_at = new Date().toISOString();
        done++;
        console.log(`  ✓ ${v.id}  ${v.platform}  ${(v.title || '(no caption)').slice(0, 52)}`);
      } else {
        failed++;
        if (m.rate_limited) { throttled = true; console.log('  ⏸ throttled — stopping, re-run later'); }
        else console.log(`  ~ ${v.id} unverified`);
      }
      await new Promise((r2) => setTimeout(r2, 400));   // be polite
    } catch (e) {
      failed++;
      console.log(`  ! ${v.id}: ${e.message}`);
    }
  }

  const tmp = STORE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store, null, 1));
  fs.renameSync(tmp, STORE);
  console.log(`[enrich] enriched ${done}, unresolved ${failed}${throttled ? ', stopped early (throttled)' : ''}`);
})();
