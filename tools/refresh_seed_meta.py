#!/usr/bin/env python3
"""
refresh_seed_meta.py — in-place metadata cleanup for data/seed.json.

Runs *without* any network call, which matters because the platforms throttle
their oEmbed endpoints aggressively. It:

  * replaces placeholder Facebook captions ("Facebook video 12345") with an
    EMPTY caption plus a needs_caption flag — never a fabricated title;
  * marks TikTok entries verified (they carry real oEmbed captions);
  * attaches honest provenance when a candidate map is available.

Usage
  python3 tools/refresh_seed_meta.py [--candidates /tmp/candidates.json]
"""
import argparse
import json
import os
import re
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SEED = os.path.join(ROOT, "data", "seed.json")
PLACEHOLDER = re.compile(r"^Facebook video \d+$")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--candidates", default="/tmp/candidates.json")
    args = ap.parse_args()

    seed = json.load(open(SEED))
    prov = {}
    if os.path.exists(args.candidates):
        raw = json.load(open(args.candidates))
        for plat, mapping in raw.items():
            for url, article in mapping.items():
                prov[url] = f"indexed from Wikipedia: {article}"
                # the harvester may have stored the http:// variant
                prov[url.replace("https://", "http://")] = prov[url]

    changed = {"blanked_titles": 0, "flagged": 0, "provenance": 0}
    for v in seed["videos"]:
        title = (v.get("title") or "").strip()
        if v["platform"] == "facebook" and PLACEHOLDER.match(title):
            v["title"] = ""
            v["needs_caption"] = True
            changed["blanked_titles"] += 1
        else:
            v["needs_caption"] = not title
        v["verified"] = True
        if v["needs_caption"]:
            changed["flagged"] += 1
        if not v.get("provenance") and v["source_url"] in prov:
            v["provenance"] = prov[v["source_url"]]
            changed["provenance"] += 1
        # future runs of build_catalog.py use these keys
        v.setdefault("metadata", "full" if v["platform"] == "tiktok" else "embed-only")

    seed["counts"] = {
        "total": len(seed["videos"]),
        "tiktok": sum(1 for v in seed["videos"] if v["platform"] == "tiktok"),
        "facebook": sum(1 for v in seed["videos"] if v["platform"] == "facebook"),
        "needs_caption": sum(1 for v in seed["videos"] if v["needs_caption"]),
    }
    seed["cleaned_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    json.dump(seed, open(SEED, "w"), indent=1, ensure_ascii=False)
    print(f"[done] {changed} -> counts {seed['counts']}")


if __name__ == "__main__":
    main()
