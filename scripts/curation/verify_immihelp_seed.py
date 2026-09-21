#!/usr/bin/env python3
"""
verify_immihelp_seed.py — post-hoc spot-check for a completed
scripts/curation/seed_immihelp.py run. See docs/ingestion/IMMIHELP-SEED-PLAN.md
§8 for the run this was used to verify.

Reads the local manifest (scripts/curation/immihelp-seed-manifest.json,
gitignored local run state — never committed, same as
backend/scripts/seed_manifest.json), picks a sample of published case_ids,
and re-fetches each directly from the live Discovery Engine datastore to
confirm the provenance fields actually landed correctly: channel/
source_system="immihelp", ingestion_method="automated_scrape",
posting_date matches what the manifest recorded (the original source
date), no `news-update` tag, and author_handle is a synthetic handle, not
a real immihelp username.

This formalizes the ad-hoc spot-check done manually right after the real
seed run — a real, reusable check, not just a one-off.

Usage:
  cd backend && ../.venv/bin/python ../scripts/curation/verify_immihelp_seed.py
  cd backend && ../.venv/bin/python ../scripts/curation/verify_immihelp_seed.py --sample 20
  cd backend && ../.venv/bin/python ../scripts/curation/verify_immihelp_seed.py --all
"""

from __future__ import annotations

import argparse
import json
import os
import sys

DEFAULT_MANIFEST = os.path.join(os.path.dirname(os.path.abspath(__file__)), "immihelp-seed-manifest.json")


def _sample(items: list[tuple[str, dict]], n: int) -> list[tuple[str, dict]]:
    if n <= 0 or n >= len(items):
        return items
    step = max(1, len(items) // n)
    return items[::step][:n]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--manifest", default=DEFAULT_MANIFEST)
    ap.add_argument("--sample", type=int, default=10, help="how many published items to spot-check")
    ap.add_argument("--all", action="store_true", help="check every published item, not just a sample")
    args = ap.parse_args()

    if not os.path.isfile(args.manifest):
        print(f"Error: manifest not found at {args.manifest} — nothing to verify", file=sys.stderr)
        return 1

    with open(args.manifest, encoding="utf-8") as f:
        manifest = json.load(f)
    published = list(manifest.get("published", {}).items())
    if not published:
        print("Manifest has no published items — nothing to verify")
        return 0

    to_check = published if args.all else _sample(published, args.sample)
    print(f"Verifying {len(to_check)}/{len(published)} published items against the live datastore...\n")

    sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "backend"))
    from dotenv import load_dotenv
    load_dotenv()
    import posting as p  # noqa: E402
    from google.cloud import discoveryengine_v1 as de  # noqa: E402
    from google.api_core.client_options import ClientOptions  # noqa: E402
    from google.api_core.exceptions import NotFound  # noqa: E402

    proj, loc, ds = p._project(), p._ds_location(), p._datastore()
    client = de.DocumentServiceClient(client_options=ClientOptions(quota_project_id=proj))

    ok = 0
    problems = []
    for source_item_id, entry in to_check:
        cid = entry["case_id"]
        name = (f"projects/{proj}/locations/{loc}/collections/default_collection"
                f"/dataStores/{ds}/branches/default_branch/documents/{cid}")
        try:
            doc = client.get_document(name=name)
        except NotFound:
            problems.append(f"{cid}: NOT FOUND in datastore")
            continue
        except Exception as e:  # noqa: BLE001 - report and keep checking the rest
            problems.append(f"{cid}: fetch error {type(e).__name__}: {e}")
            continue

        sd = json.loads(type(doc).to_json(doc)).get("structData", {})
        item_problems = []
        if sd.get("channel") != "immihelp":
            item_problems.append(f"channel={sd.get('channel')!r}")
        if sd.get("source_system") != "immihelp":
            item_problems.append(f"source_system={sd.get('source_system')!r}")
        if sd.get("ingestion_method") != "automated_scrape":
            item_problems.append(f"ingestion_method={sd.get('ingestion_method')!r}")
        if sd.get("posting_date") != entry.get("posting_date"):
            item_problems.append(f"posting_date={sd.get('posting_date')!r} (manifest said {entry.get('posting_date')!r})")
        if "news-update" in (sd.get("tags") or []):
            item_problems.append("news-update tag present (should never apply to forum_posting content)")
        if not sd.get("author_handle"):
            item_problems.append("author_handle missing")

        if item_problems:
            problems.append(f"{cid} ({entry['title']!r}): " + "; ".join(item_problems))
        else:
            ok += 1
            print(f"  [OK] {cid} — {entry['title']!r}")

    print(f"\n{ok}/{len(to_check)} verified clean")
    if problems:
        print(f"\n{len(problems)} PROBLEM(S):")
        for p_ in problems:
            print(f"  - {p_}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
