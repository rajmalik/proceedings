"""
backfill_checkbox_from_dates.py — one-time migration: preserve "this event
happened" when two STEM-OPT date fields became checkboxes.

Background
----------
"Biometrics Requested" and "Notice of Intent to Deny" used to be `kind:
"date"` rows in POST_JOIN_ATTRIBUTE_TEMPLATES, storing
`biometrics_appointment_date` / `noid_date`. They are now `kind: "checkbox"`
rows on new key_stages_or_info keys (`biometrics_requested` /
`noid_issued`).

The old keys are no longer in the template, so `_validate_attribute_values()`
strips them from every future save and no UI reads them — a member who had
recorded a biometrics date would silently appear never to have had
biometrics requested. This script ticks the new checkbox wherever the old
date exists, in BOTH places the value lives:

  * groups/{gid}/member_attributes/{uid}.values  — the group-shared record
    the members table and hover card read
  * users/{uid}.key_stages_or_info               — the member's own profile

The old date values are LEFT IN PLACE (harmless, and the only record of
*when*). Nothing is deleted.

Idempotent: a doc that already carries the new key is left untouched, so
re-running is a no-op. Run ONCE per environment after deploying, including
the local dev Firestore.

RUN (from backend/):
    python scripts/backfill_checkbox_from_dates.py --dry-run   # log planned writes only
    python scripts/backfill_checkbox_from_dates.py             # apply
"""
from __future__ import annotations

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import posting  # noqa: E402

# old date key -> new checkbox key. Both new keys are key_stages_or_info.
MIGRATIONS = {
    "biometrics_appointment_date": "biometrics_requested",
    "noid_date": "noid_issued",
}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dry-run", action="store_true", help="log planned writes without applying them")
    args = ap.parse_args()

    from google.cloud import firestore

    db = firestore.Client(project=os.getenv("GCP_PROJECT_ID") or None)
    on = posting.CHECKBOX_ON
    attr_writes = prof_writes = 0

    # 1) every group's member_attributes docs
    for group in db.collection("groups").stream():
        for doc in group.reference.collection("member_attributes").stream():
            data = doc.to_dict() or {}
            values = dict(data.get("values") or {})
            add = {new: on for old, new in MIGRATIONS.items()
                   if values.get(old) and not values.get(new)}
            if not add:
                continue
            attr_writes += 1
            print(f"  member_attributes {group.id}/{doc.id}: +{add}")
            if not args.dry_run:
                doc.reference.set({"values": {**values, **add}}, merge=True)

    # 2) every user profile
    for user in db.collection("users").stream():
        data = user.to_dict() or {}
        dates = data.get("key_dates") or {}
        stages = data.get("key_stages_or_info") or {}
        add = {new: on for old, new in MIGRATIONS.items()
               if dates.get(old) and not stages.get(new)}
        if not add:
            continue
        prof_writes += 1
        print(f"  profile {user.id}: +{add}")
        if not args.dry_run:
            user.reference.set({"key_stages_or_info": {**stages, **add}}, merge=True)

    verb = "would update" if args.dry_run else "updated"
    print(f"\n{verb} {attr_writes} member_attributes doc(s) and {prof_writes} profile(s)")
    if args.dry_run:
        print("dry run — nothing written. Re-run without --dry-run to apply.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
