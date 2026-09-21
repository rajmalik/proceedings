"""
publish_attribute_config.py — validate and publish the Timeline attribute spec
to Firestore (app_config/timeline_attributes).

This is the ONLY write path. The API deliberately has no config-write endpoint,
so a malformed spec cannot arrive over HTTP; it has to come through here, and
here validates before it writes.

WORKFLOW
--------
    # 1. see what is live vs what the image ships with
    python scripts/publish_attribute_config.py --show
    python scripts/publish_attribute_config.py --diff

    # 2. export the current spec, edit it, check it BEFORE publishing
    python scripts/publish_attribute_config.py --export spec.json
    $EDITOR spec.json
    python scripts/publish_attribute_config.py --file spec.json --validate-only

    # 3. publish (prints the diff and asks, unless --yes)
    python scripts/publish_attribute_config.py --file spec.json

    # seed a fresh environment from the shipped base JSON
    python scripts/publish_attribute_config.py --from-default

    # emergency: drop the document, reverting every instance to the shipped
    # base JSON within one TTL
    python scripts/publish_attribute_config.py --delete

The version field is bumped automatically on publish so `GET
/api/config/attributes` can tell you which edit an instance is serving.
"""

from __future__ import annotations

import argparse
import json
import os
import sys

_BACKEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _BACKEND)

from dotenv import load_dotenv  # noqa: E402

load_dotenv(os.path.join(_BACKEND, ".env"))

import attribute_config  # noqa: E402
import posting  # noqa: E402


def _live_raw() -> dict | None:
    """The published document exactly as stored — not the resolved/fallback
    view get() would hand you, which is what --diff needs to be honest."""
    try:
        return attribute_config._read_firestore()
    except Exception as e:
        print(f"! could not read Firestore: {type(e).__name__}: {e}")
        return None


def _comparable(spec: dict | None) -> str:
    """Stable JSON for diffing, minus fields the publisher owns."""
    if spec is None:
        return "(nothing published)\n"
    body = {k: v for k, v in spec.items() if k not in ("updated_at", "version")}
    return json.dumps(body, indent=2, sort_keys=True, default=str) + "\n"


def _print_diff(old: dict | None, new: dict) -> bool:
    import difflib
    a, b = _comparable(old).splitlines(True), _comparable(new).splitlines(True)
    delta = list(difflib.unified_diff(a, b, fromfile="live", tofile="proposed"))
    if not delta:
        print("No change — the proposed spec matches what is already live.")
        return False
    sys.stdout.writelines(delta)
    return True


def main() -> int:
    ap = argparse.ArgumentParser(description="Validate/publish the Timeline attribute spec.")
    src = ap.add_mutually_exclusive_group()
    src.add_argument("--file", help="publish this JSON file")
    src.add_argument("--from-default", action="store_true",
                     help="publish config/timeline_attributes.default.json (seeds a fresh environment)")
    ap.add_argument("--show", action="store_true", help="print the live spec and exit")
    ap.add_argument("--export", metavar="PATH", help="write the live spec (or the default) to PATH and exit")
    ap.add_argument("--diff", action="store_true", help="show live vs proposed and exit")
    ap.add_argument("--validate-only", action="store_true", help="validate the proposed spec and exit")
    ap.add_argument("--delete", action="store_true",
                    help="delete the document — every instance reverts to the shipped base JSON")
    ap.add_argument("--yes", action="store_true", help="skip the confirmation prompt")
    args = ap.parse_args()

    if args.show:
        live = _live_raw()
        print(json.dumps(live, indent=2, sort_keys=True, default=str) if live
              else "(nothing published — instances are serving config/timeline_attributes.default.json)")
        return 0

    if args.export:
        live = _live_raw() or posting.DEFAULT_ATTRIBUTE_SPEC
        with open(args.export, "w") as fh:
            json.dump({k: v for k, v in live.items() if k != "updated_at"},
                      fh, indent=2, sort_keys=True, default=str)
            fh.write("\n")
        print(f"wrote {args.export} ({'live document' if _live_raw() else 'shipped base JSON'})")
        return 0

    if args.delete:
        if not args.yes:
            print("This deletes app_config/timeline_attributes. Every instance reverts to the")
            print("shipped base JSON within one TTL. Re-run with --yes to confirm.")
            return 1
        from google.cloud import firestore
        firestore.Client().collection(attribute_config.COLLECTION) \
            .document(attribute_config.DOCUMENT).delete()
        print("deleted — instances will fall back to config/timeline_attributes.default.json")
        return 0

    # ---- assemble the proposed spec -------------------------------------
    if args.file:
        with open(args.file) as fh:
            proposed = json.load(fh)
    elif args.from_default:
        proposed = json.loads(json.dumps(posting.DEFAULT_ATTRIBUTE_SPEC))
    else:
        ap.error("nothing to do: pass --file, --from-default, --show, --export, --diff or --delete")

    errs = attribute_config.validate(proposed)
    if errs:
        print(f"INVALID — {len(errs)} problem(s), nothing was written:\n")
        for e in errs:
            print(f"  • {e}")
        return 1
    print("valid ✓")
    if args.validate_only:
        return 0

    live = _live_raw()
    if not _print_diff(live, proposed) and not args.from_default:
        return 0
    if args.diff:
        return 0

    # Bump so an operator can tell which edit an instance is serving.
    proposed["version"] = int((live or {}).get("version") or 0) + 1

    if not args.yes:
        print(f"\nPublish as version {proposed['version']}? Re-run with --yes to confirm.")
        return 1

    errs = attribute_config.publish(proposed)
    if errs:  # belt and braces — publish() validates again
        print("INVALID at write time, nothing written:")
        for e in errs:
            print(f"  • {e}")
        return 1
    print(f"published version {proposed['version']} — live within one TTL "
          f"({attribute_config._ttl_seconds():.0f}s), or immediately via "
          f"POST /api/config/attributes/refresh")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
