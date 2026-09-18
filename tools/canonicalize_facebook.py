#!/usr/bin/env python3
"""
canonicalize_facebook.py — recover creator attribution for Facebook entries.

Facebook's public oEmbed returns no author and no caption, and a `watch/?v=`
link hides the Page that posted the video. But those links redirect to the
canonical `facebook.com/<Page>/videos/<id>/` URL. Following that redirect with a
plain HEAD request is standard URL canonicalisation — no HTML is fetched, no
page is parsed — and it turns "Facebook" into the actual creator.

Usage
  python3 tools/canonicalize_facebook.py [--delay 1.0] [--limit 0]
"""
import argparse
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SEED = os.path.join(ROOT, "data", "seed.json")
UA = "Mozilla/5.0 (compatible; ReelBlend canonicaliser)"

CANON = re.compile(r"^https?://(?:www\.|m\.|web\.)?facebook\.com/([\w.\-]+)/(?:videos|reel)/(\d+)")


def plugin_embed(url: str) -> str:
    p = urllib.parse.urlencode({
        "href": url, "show_text": "false", "autoplay": "true", "muted": "true", "max-width": "100%",
    })
    return "https://www.facebook.com/plugins/video.php?" + p


def canonical(url: str, timeout: int = 15):
    req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.url


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--delay", type=float, default=0.9, help="seconds between requests (be polite)")
    ap.add_argument("--limit", type=int, default=0, help="max entries to process (0 = all)")
    args = ap.parse_args()

    seed = json.load(open(SEED))
    todo = [v for v in seed["videos"]
            if v["platform"] == "facebook" and (not v.get("author") or v.get("author") == "Facebook")]
    if args.limit:
        todo = todo[: args.limit]
    print(f"[canon] {len(todo)} Facebook entries need attribution")

    renamed = failed = 0
    for i, v in enumerate(todo, 1):
        try:
            final = canonical(v["source_url"])
            m = CANON.match(final)
            if m:
                page, vid = m.group(1), m.group(2)
                v["author"] = page
                v["author_url"] = f"https://www.facebook.com/{page}"
                v["source_url"] = f"https://www.facebook.com/{page}/videos/{vid}/"
                v["embed"] = plugin_embed(v["source_url"])
                v["id"] = f"fa_{vid}"
                renamed += 1
                print(f"  {i:>3}/{len(todo)} {page}")
            else:
                failed += 1
                print(f"  {i:>3}/{len(todo)} ?  {final[:70]}")
        except urllib.error.HTTPError as e:
            if e.code in (403, 429):
                print(f"[canon] throttled (HTTP {e.code}) after {i - 1} — stopping, partial results kept")
                break
            failed += 1
        except Exception as e:
            failed += 1
            print(f"  {i:>3}/{len(todo)} !  {str(e)[:60]}")
        time.sleep(args.delay)

    seed["counts"] = {
        "total": len(seed["videos"]),
        "tiktok": sum(1 for v in seed["videos"] if v["platform"] == "tiktok"),
        "facebook": sum(1 for v in seed["videos"] if v["platform"] == "facebook"),
        "needs_caption": sum(1 for v in seed["videos"] if v.get("needs_caption")),
    }
    json.dump(seed, open(SEED, "w"), indent=1, ensure_ascii=False)
    print(f"[canon] attributed {renamed}, unresolved {failed} -> {seed['counts']}")


if __name__ == "__main__":
    main()
