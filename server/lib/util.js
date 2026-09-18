'use strict';
/**
 * util.js — tiny helpers shared across the ReelBlend server.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const now = () => Date.now();

function rid(prefix = '') {
  return prefix + crypto.randomBytes(8).toString('hex');
}

/** Deterministic 32-bit hash -> used for stable poster gradients & shuffles. */
function hash32(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < String(str).length; i++) {
    h ^= String(str).charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/** Seeded PRNG (mulberry32) so a session's exploration is reproducible. */
function prng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Exponential recency decay. halfLifeHours is the age at which weight = 0.5 */
function freshness(ts, halfLifeHours = 96) {
  const ageH = Math.max(0, (now() - ts) / 36e5);
  return Math.pow(0.5, ageH / halfLifeHours);
}

function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** Atomic write: tmp file + rename, so a crash can never truncate the store. */
function writeJSONAtomic(file, data) {
  const tmp = file + '.tmp';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
  fs.renameSync(tmp, file);
}

function shortNum(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '0';
  const a = Math.abs(n);
  if (a >= 1e9) return (n / 1e9).toFixed(a >= 1e10 ? 0 : 1).replace(/\.0$/, '') + 'B';
  if (a >= 1e6) return (n / 1e6).toFixed(a >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M';
  if (a >= 1e3) return (n / 1e3).toFixed(a >= 1e4 ? 0 : 1).replace(/\.0$/, '') + 'K';
  return String(n);
}

function iso(ts) { return new Date(ts).toISOString(); }

module.exports = { clamp, now, rid, hash32, prng, freshness, readJSON, writeJSONAtomic, shortNum, iso };
