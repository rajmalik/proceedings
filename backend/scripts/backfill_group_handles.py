"""
backfill_group_handles.py — one-time migration: correct group member/message
handles that were stored as a raw uid instead of the user's real handle.

Background
----------
`matching._member()` and `group_messages.post_message()` used to call
`profile.username_for(uid)` directly — a lookup that only knows the static
seed-persona roster and falls back to returning the raw uid unchanged for
any real (Firebase-registered) user. `profile.handle_for(db, uid)` fixes
this going forward (checks `users/{uid}.username` first), but records
already written before the fix still carry the raw uid as their stored
"handle". This is a DIFFERENT bug than the one `anonymize_usernames.py`
fixes (a real name/email leaked into `username` at signup) — that script
never touches `groups/*.members[]` at all, and this script doesn't touch
legitimate seed/anonymous handles.

Detection is precise, not heuristic: a member/message record is corrected
only when its stored handle exactly equals the stored uid
(`members[].username == members[].user_id`,
`messages/*.author_handle == messages/*.author_uid`) — exactly the
signature of the old `username_for()` fallback, so this can't misfire on a
genuinely-coincidental handle.

Idempotent: already-correct records (handle != uid) are left untouched, so
re-running is a no-op / safe.

RUN (from backend/):
    python scripts/backfill_group_handles.py --dry-run    # log planned changes only
    python scripts/backfill_group_handles.py              # apply
"""
from __future__ import annotations

import argparse
import os
import sys

_BACKEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _BACKEND)

from dotenv import load_dotenv  # noqa: E402

load_dotenv(os.path.join(_BACKEND, ".env"))

import posting  # noqa: E402
import profile as profile_mod  # noqa: E402
from google.cloud import firestore  # noqa: E402


def _safe(fn, label: str, counters: dict):
    try:
        fn()
        counters[label] = counters.get(label, 0) + 1
    except Exception as e:  # noqa: BLE001 — a single-doc failure must not abort the sweep
        counters[f"{label}_fail"] = counters.get(f"{label}_fail", 0) + 1
        print(f"     ! {label} failed: {e}")


def main() -> int:
    ap = argparse.ArgumentParser(description="Backfill group member/message handles stored as a raw uid.")
    ap.add_argument("--dry-run", action="store_true", help="log planned changes; write nothing")
    args = ap.parse_args()
    dry = args.dry_run

    project = posting._project()
    db = firestore.Client(project=project)
    counters: dict = {}

    mode = "DRY-RUN (no writes)" if dry else "APPLY"
    print(f"backfill_group_handles — {mode} — project={project}\n")

    for group in db.collection("groups").stream():
        data = group.to_dict() or {}
        members = data.get("members") or []
        changed = False
        new_members = []
        for m in members:
            uid = str(m.get("user_id") or "")
            handle = str(m.get("username") or "")
            if uid and handle == uid:
                real = profile_mod.handle_for(db, uid)
                if real != uid:
                    print(f"  group {group.id}: member {uid} — {handle!r} -> {real!r}")
                    m = {**m, "username": real}
                    changed = True
                    counters["member"] = counters.get("member", 0) + 1
                else:
                    counters["member_no_real_handle"] = counters.get("member_no_real_handle", 0) + 1
            new_members.append(m)
        if changed and not dry:
            _safe(lambda ref=group.reference, ms=new_members: ref.update({"members": ms}), "group_write", counters)

        for msg in group.reference.collection("messages").stream():
            mdata = msg.to_dict() or {}
            uid = str(mdata.get("author_uid") or "")
            handle = str(mdata.get("author_handle") or "")
            if not uid or handle != uid:
                continue
            real = profile_mod.handle_for(db, uid)
            if real == uid:
                counters["message_no_real_handle"] = counters.get("message_no_real_handle", 0) + 1
                continue
            print(f"  group {group.id} message {msg.id}: author {uid} — {handle!r} -> {real!r}")
            counters["message"] = counters.get("message", 0) + 1
            if not dry:
                _safe(lambda ref=msg.reference, h=real: ref.update({"author_handle": h}), "message_write", counters)

    print("\nSummary:")
    for k in sorted(counters):
        print(f"  {k}: {counters[k]}")
    if dry:
        print("\n(dry-run — nothing was written)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
