"""
backfill_grandfather_member_attributes.py — one-time migration: exempt every
CURRENT member of every existing Timeline group from the new mandatory
post-join attribute requirement.

Background
----------
Joining a Timeline group whose processing type has a registered
POST_JOIN_ATTRIBUTE_TEMPLATES entry (currently only "stem-opt-extension")
now requires the member to submit at least the required attribute
(matching.py's `_validate_attribute_values()` — row 0 of the template).
`matching.compute_needs_attributes()` decides whether a member still needs
to fill this in purely by checking whether a
`groups/{id}/member_attributes/{user_id}` doc already exists for them —
there's no "joined before this feature shipped" timestamp anywhere to check
instead.

Per this feature's confirmed scope, the requirement applies GOING FORWARD
ONLY: members who joined before this rollout must never be gated or
blocked. This script writes an empty, `grandfathered: true` placeholder doc
for every current member of every Timeline group whose criteria match a
registered processing type, so `compute_needs_attributes()` reports `False`
for all of them from the moment this script runs.

Idempotent: a member who already has a `member_attributes` doc (submitted
for real, or already grandfathered by a previous run) is left untouched, so
re-running is a no-op / safe. Run this ONCE against each environment right
after deploying this feature — including the local dev Firestore before
manual testing, since demo/seed data predates the feature too.

RUN (from backend/):
    python scripts/backfill_grandfather_member_attributes.py --dry-run    # log planned writes only
    python scripts/backfill_grandfather_member_attributes.py              # apply
"""
from __future__ import annotations

import argparse
import os
import sys

_BACKEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _BACKEND)

from dotenv import load_dotenv  # noqa: E402

load_dotenv()

import matching  # noqa: E402
import posting  # noqa: E402
from google.cloud import firestore  # noqa: E402


def _safe(fn, label: str, counters: dict):
    try:
        fn()
        counters[label] = counters.get(label, 0) + 1
    except Exception as e:  # noqa: BLE001 — a single-doc failure must not abort the sweep
        counters[f"{label}_fail"] = counters.get(f"{label}_fail", 0) + 1
        print(f"     ! {label} failed: {e}")


def main() -> int:
    ap = argparse.ArgumentParser(description="Grandfather existing Timeline group members out of the mandatory attributes gate.")
    ap.add_argument("--dry-run", action="store_true", help="log planned writes; write nothing")
    args = ap.parse_args()
    dry = args.dry_run

    project = posting._project()
    db = firestore.Client(project=project)
    counters: dict = {}
    now = matching._now_iso()

    mode = "DRY-RUN (no writes)" if dry else "APPLY"
    print(f"backfill_grandfather_member_attributes — {mode} — project={project}\n")

    for group in db.collection("groups").stream():
        data = group.to_dict() or {}
        if (data.get("group_type") or "") != "timeline":
            continue
        if matching._effective_status(data) == "deleted":
            continue
        matched = matching._matched_post_join_type(data)
        if not matched:
            continue
        members = data.get("members") or []
        for m in members:
            uid = str(m.get("user_id") or "")
            if not uid:
                continue
            ref = matching._member_attributes_ref(db, group.id).document(uid)
            if ref.get().exists:
                counters["already_present"] = counters.get("already_present", 0) + 1
                continue
            print(f"  group {group.id} ({data.get('name')!r}): grandfathering member {uid}")
            if not dry:
                doc = {
                    "user_id": uid, "username": str(m.get("username") or ""),
                    "processing_type": matched, "values": {}, "notes": "",
                    "grandfathered": True, "submitted_at": now, "updated_at": now,
                }
                _safe(lambda r=ref, d=doc: r.set(d), "grandfathered_write", counters)
            else:
                counters["grandfathered_write"] = counters.get("grandfathered_write", 0) + 1

    print("\nSummary:")
    for k in sorted(counters):
        print(f"  {k}: {counters[k]}")
    if dry:
        print("\n(dry-run — nothing was written)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
