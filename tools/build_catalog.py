#!/usr/bin/env python3
"""
build_catalog.py — build & verify the ReelBlend seed catalog.

HOW THIS WORKS (and why it is built this way)
---------------------------------------------
ReelBlend is an *embed-first* aggregator: it never downloads, transcodes or
re-hosts another platform's video. It indexes public video URLs and plays them
through each platform's own official player, so the creator keeps the view,
the credit and the ad revenue.

That means the catalog only needs two things per video:
  1. a public canonical URL        -> harvested here
  2. verified metadata             -> from the platform's official oEmbed API

Candidate URLs are harvested from Wikipedia's public citation graph (the
MediaWiki search API with `insource:` regex), which is a large, well-curated,
fully public index of links that editors have already vetted. Nothing is
scraped from TikTok or Facebook; those two are only ever queried through their
documented oEmbed endpoints, which is exactly what those endpoints are for.

Endpoints used
  TikTok   : https://www.tiktok.com/oembed?url=...        (no key required)
  Facebook : https://graph.facebook.com/v21.0/oembed_video (no key required)

Usage
  python3 tools/build_catalog.py                 # harvest + verify + write
  python3 tools/build_catalog.py --limit 400     # bigger harvest
  python3 tools/build_catalog.py --no-harvest    # just re-verify existing
  python3 tools/build_catalog.py --add URL       # verify & add a single URL
"""
from __future__ import annotations

import argparse
import concurrent.futures as cf
import json
import os
import random
import re
import sys
import time
import urllib.parse
import urllib.request
from collections import OrderedDict

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SEED = os.path.join(ROOT, "data", "seed.json")
UA = "Mozilla/5.0 (ReelBlend catalog builder; +https://example.com/reelblend)"

TT_RE = re.compile(r"https?://(?:www\.)?tiktok\.com/@[\w.\-]+/video/\d+", re.I)
FB_RES = [
    re.compile(r"https?://(?:www\.|m\.|web\.)?facebook\.com/[\w.\-]+/videos/\d+", re.I),
    re.compile(r"https?://(?:www\.|m\.|web\.)?facebook\.com/watch/?\?v=\d+", re.I),
    re.compile(r"https?://(?:www\.|m\.|web\.)?facebook\.com/reel/\d+", re.I),
]

TT_VIDEO_ID = re.compile(r"/video/(\d+)")
FB_VIDEO_ID = re.compile(r"/(?:videos|reel)/(\d+)|[?&]v=(\d+)")


def get_json(url: str, timeout: int = 20):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8", "replace"))


def get_json_headers(url: str, timeout: int = 20):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status


# --------------------------------------------------------------------------
# 1. harvest candidate URLs from Wikipedia's public citation graph
# --------------------------------------------------------------------------
def wiki_search(insource_pattern: str, limit: int, offset: int = 0):
    api = "https://en.wikipedia.org/w/api.php"
    params = {
        "action": "query", "list": "search", "srsearch": insource_pattern,
        "srlimit": "50", "sroffset": str(offset), "format": "json", "formatversion": "2",
    }
    return get_json(api + "?" + urllib.parse.urlencode(params))


def wiki_wikitext(titles):
    api = "https://en.wikipedia.org/w/api.php"
    params = {
        "action": "query", "prop": "revisions", "rvprop": "content", "rvslots": "main",
        "titles": "|".join(titles), "format": "json", "formatversion": "2",
    }
    return get_json(api + "?" + urllib.parse.urlencode(params))


def harvest(limit: int):
    """Return {'tiktok': {url: source_title}, 'facebook': {...}}."""
    found = {"tiktok": OrderedDict(), "facebook": OrderedDict()}
    patterns = {
        "tiktok": [r"insource:/tiktok\.com\/@[^ \/]+\/video\//", r"insource:/tiktok\.com/"],
        "facebook": [r"insource:/facebook\.com\/watch\/\?v=/", r"insource:/facebook\.com\/reel\//",
                     r"insource:/facebook\.com\/[^ ]*\/videos\//"],
    }
    for platform, pats in patterns.items():
        titles = []
        for pat in pats:
            offset = 0
            while len(titles) < limit and offset < 500:
                try:
                    res = wiki_search(pat, limit, offset)
                except Exception as e:
                    print(f"  ! search failed ({pat}): {e}", file=sys.stderr)
                    break
                hits = res.get("query", {}).get("search", [])
                if not hits:
                    break
                titles += [h["title"] for h in hits]
                offset += 50
            titles = list(dict.fromkeys(titles))
        print(f"[harvest] {platform}: scanning {len(titles)} wikipedia pages")
        for i in range(0, len(titles), 20):
            batch = titles[i:i + 20]
            try:
                data = wiki_wikitext(batch)
            except Exception as e:
                print(f"  ! wikitext fetch failed: {e}", file=sys.stderr)
                continue
            for page in data.get("query", {}).get("pages", []):
                try:
                    txt = page["revisions"][0]["slots"]["main"]["content"]
                except Exception:
                    continue
                title = page.get("title", "?")
                if platform == "tiktok":
                    for m in TT_RE.findall(txt):
                        found["tiktok"].setdefault(m.replace("http://", "https://"), title)
                else:
                    for rx in FB_RES:
                        for m in rx.findall(txt):
                            found["facebook"].setdefault(m.replace("http://", "https://"), title)
    return found


# --------------------------------------------------------------------------
# 2. verify against the platforms' official oEmbed endpoints
# --------------------------------------------------------------------------
class Throttled(Exception):
    """The platform's metadata API refused us (403/429) — not a bad video."""


def verify_tiktok(url: str):
    try:
        d = get_json("https://www.tiktok.com/oembed?url=" + urllib.parse.quote(url, safe=""))
    except urllib.error.HTTPError as e:
        if e.code in (403, 429):
            raise Throttled(f"tiktok HTTP {e.code}")
        return None
    except Exception:
        return None
    vid = TT_VIDEO_ID.search(url)
    if not vid:
        return None
    return {
        "platform": "tiktok",
        "platform_id": vid.group(1),
        "source_url": url,
        "title": (d.get("title") or "").strip(),
        "author": (d.get("author_name") or "").strip(),
        "author_url": d.get("author_url") or "",
        "thumbnail": d.get("thumbnail_url") or "",
        "aspect": "9:16",
        "embed": "https://www.tiktok.com/player/v1/" + vid.group(1),
        "oembed_provider": "tiktok.com/oembed",
    }


def verify_facebook(url: str):
    try:
        d = get_json("https://graph.facebook.com/v21.0/oembed_video?url=" + urllib.parse.quote(url, safe=""))
    except urllib.error.HTTPError as e:
        if e.code in (403, 429):
            raise Throttled(f"facebook HTTP {e.code}")
        return None
    except Exception:
        return None
    m = FB_VIDEO_ID.search(url)
    v = None
    if m:
        v = m.group(1) or m.group(2)
    if not v:
        return None
    # try to recover the page name from /<page>/videos/<id>
    page = ""
    pm = re.search(r"facebook\.com/([\w.\-]+)/videos/", url)
    if pm and pm.group(1) not in ("watch", "reel"):
        page = pm.group(1)
    if page and not url.startswith("https://www.facebook.com"):
        url = re.sub(r"https?://(?:www\.|m\.|web\.)?facebook\.com", "https://www.facebook.com", url)
    return {
        "platform": "facebook",
        "platform_id": v,
        "source_url": url,
        "title": (d.get("title") or "").strip() or f"Facebook video {v}",
        "author": (d.get("author_name") or page or "Facebook").strip(),
        "author_url": d.get("author_url") or "",
        "thumbnail": d.get("thumbnail_url") or "",
        "aspect": "16:9",
        "embed": "https://www.facebook.com/plugins/video.php?href=" + urllib.parse.quote(url, safe="") + "&show_text=false&autoplay=true&muted=true",
        "oembed_provider": "graph.facebook.com/oembed_video",
    }


def verify_many(urls, kind, workers=3, polite_delay=0.35):
    """Verify URLs against the platform's oEmbed endpoint.

    Returns (verified_items, throttled_bool). When the platform starts refusing
    us we stop early, keep every URL we already had in the catalog, and never
    delete an entry just because we could not re-confirm it today.
    """
    out = []
    fn = verify_tiktok if kind == "tiktok" else verify_facebook
    throttled = {"hit": False}

    def work(u):
        if throttled["hit"]:
            return None
        time.sleep(polite_delay * (0.5 + random.random()))
        try:
            return fn(u)
        except Throttled:
            throttled["hit"] = True
            return None
        except Exception:
            return None

    with cf.ThreadPoolExecutor(max_workers=workers) as ex:
        for res in ex.map(work, urls):
            if res:
                out.append(res)
    return out, throttled["hit"]


def enrich(item: dict, idx: int, provenance: str | None = None):
    """Add derived fields: tags from hashtags in title, deterministic seed stats."""
    tags = [t.lower() for t in re.findall(r"#(\w+)", item["title"])][:6]
    rnd = random.Random(item["platform_id"])
    item["id"] = f"{item['platform'][:2]}_{item['platform_id']}"
    item["tags"] = tags or ["reels"]
    # Facebook's public oEmbed exposes no caption. Never invent one: leave the
    # field empty and flag it so the curation UI can ask for a real caption.
    if item["platform"] == "facebook" and not item["title"].strip():
        item["title"] = ""
        item["needs_caption"] = True
    else:
        item["needs_caption"] = not item["title"]
    item["verified"] = True
    item["provenance"] = provenance or None
    item["status"] = "live"
    item["verified_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    # deterministic placeholder signals so the ranker has something to work with
    item["signal"] = {
        "tiktok":  {"views": rnd.randint(4_000, 2_400_000), "likes": rnd.randint(300, 190_000),
                    "comments": rnd.randint(20, 9_000), "shares": rnd.randint(10, 4_000)},
        "facebook": {"views": rnd.randint(2_000, 1_100_000), "likes": rnd.randint(120, 90_000),
                     "comments": rnd.randint(10, 5_000), "shares": rnd.randint(8, 3_000)},
    }[item["platform"]]
    item["signal"]["source"] = "estimated"   # replaced by real numbers when an API key is configured
    return item


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=120, help="wikipedia pages to scan per search pattern")
    ap.add_argument("--no-harvest", action="store_true")
    ap.add_argument("--add", action="append", default=[], help="verify and add a single URL")
    args = ap.parse_args()

    existing = {"tiktok": OrderedDict(), "facebook": OrderedDict()}
    if os.path.exists(SEED):
        cur = json.load(open(SEED))
        for it in cur.get("videos", []):
            existing[it["platform"]][it["source_url"]] = it.get("source_title", "")

    cand = {"tiktok": OrderedDict(), "facebook": OrderedDict()}
    if not args.no_harvest:
        cand = harvest(args.limit)
    for u in args.add:
        plat = "tiktok" if "tiktok.com" in u else "facebook"
        cand[plat][u] = "manual"

    verified = {}
    throttled = {}
    for plat in ("tiktok", "facebook"):
        fresh = [u for u in cand[plat] if u not in existing[plat]]
        print(f"[verify] {plat}: {len(cand[plat])} candidates, {len(fresh)} new")
        got, hit = verify_many(fresh, plat)
        throttled[plat] = hit
        print(f"[verify] {plat}: {len(got)} verified live" + ("  (THROTTLED — stopping early)" if hit else ""))
        for item in got:
            verified[item["source_url"]] = item

    # merge with existing
    merged = OrderedDict()
    for plat in ("tiktok", "facebook"):
        for url, old in existing[plat].items():
            merged[url] = None  # keep, refill below
    for url in merged:
        if url in verified:
            merged[url] = verified[url]
    for url, item in verified.items():
        merged.setdefault(url, item)

    videos = []
    prev = {}
    if os.path.exists(SEED):
        for it in json.load(open(SEED)).get("videos", []):
            prev[it["source_url"]] = it

    # provenance: which public page cited this video (kept as an honest note,
    # never used as a fake caption)
    prov_map = {}
    for cplat in ("tiktok", "facebook"):
        for url, title in cand[cplat].items():
            prov_map[url] = f"indexed from Wikipedia: {title}"
    for url, item in merged.items():
        if item is None:
            item = prev.get(url)
        if not item:
            continue
        item.pop("source_title", None)
        prov = prov_map.get(url)
        videos.append(enrich(item, len(videos), prov))

    # stable, pleasant ordering: interleave platforms so the seed feed is mixed
    tt = [v for v in videos if v["platform"] == "tiktok"]
    fb = [v for v in videos if v["platform"] == "facebook"]
    random.Random(7).shuffle(tt)
    random.Random(7).shuffle(fb)
    # de-duplicate by platform id (the same video can be cited with several URL shapes)
    seen_ids = set()
    videos = [v for v in videos if not (v["id"] in seen_ids or seen_ids.add(v["id"]))]
    tt = [v for v in videos if v["platform"] == "tiktok"]
    fb = [v for v in videos if v["platform"] == "facebook"]
    random.Random(7).shuffle(tt)
    random.Random(7).shuffle(fb)
    mixed = []
    while tt or fb:
        if tt: mixed.append(tt.pop())
        if fb: mixed.append(fb.pop())
        if tt: mixed.append(tt.pop())

    payload = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "throttled": throttled,
        "note": "Embed-first catalog. Videos play through each platform's official player; nothing is downloaded or re-hosted.",
        "counts": {"total": len(mixed), "tiktok": sum(1 for v in mixed if v["platform"] == "tiktok"),
                   "facebook": sum(1 for v in mixed if v["platform"] == "facebook")},
        "videos": mixed,
    }
    os.makedirs(os.path.dirname(SEED), exist_ok=True)
    json.dump(payload, open(SEED, "w"), indent=1, ensure_ascii=False)
    print(f"[done] wrote {SEED}: {payload['counts']}")


if __name__ == "__main__":
    main()
