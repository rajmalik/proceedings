#!/usr/bin/env python3
"""Acceptance tests for the STEM OPT unified-timeline feature.

Written BEFORE implementation (TDD), per features/stem-opt-timeline-9/. Scope is
STEM OPT only (`EAD → stem-opt-extension`).

State:
  A/B/C  — schema + vocab + pipeline INVARIANTS the plan relies on. They pass
           today and LOCK the canonical field set (plan §4): the `stem-opt-
           extension` timeline config, the tag-suggest vocab, and the cleaners
           must all keep the same keys, so a free-text posting and a timeline
           cohort can carry identical structured data.
  D      — the `ead_filed_date -> {filing_month, filing_year}` derivation that
           the posting->cohort cross-link needs. **RED until Phase 1** adds
           posting.filing_period().
  E      — LIVE recall bar: tag-suggest must extract the STEM OPT fields from the
           curated prose (curated/stem/*.txt). Runs only with `integration` +
           GCP; it is the target Phase 1 tightens toward.

NOT yet wired into the no-GCP CI gate — add it once D is green.
Run:  python tests/test_stem_opt_timeline.py [integration]
"""
import json
import os
import sys
from pathlib import Path

_BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_BACKEND))

import posting  # noqa: E402

_passed = 0
_failed = 0
_pending = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global _passed, _failed
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f" — {detail}" if detail else ""))
    if ok:
        _passed += 1
    else:
        _failed += 1


def pending(name: str, detail: str = "") -> None:
    """A contract not yet implemented — reported RED so it drives Phase 1, but
    tallied separately so the invariant count stays readable."""
    global _pending
    print(f"  TODO  {name}" + (f" — {detail}" if detail else ""))
    _pending += 1


# The canonical STEM OPT timeline field set (plan §4), split by bucket.
CANONICAL_STAGE_KEYS = [
    "filing_month", "filing_year", "application_status", "service_center",
    "premium_processing", "biometrics_requested", "noid_issued",
]
CANONICAL_DATE_KEYS = [
    "ead_filed_date", "biometrics_completed_date", "rfe_date",
    "ead_approved_date", "ead_card_produced_date", "ead_card_received_date",
]


def _stem_opt_config_keys() -> set:
    """Every key the stem-opt-extension timeline attribute config captures
    (period rows + post-join extras)."""
    cfg = json.loads((_BACKEND / "config" / "timeline_attributes.default.json").read_text())
    keys = {r["key"] for r in cfg.get("period_rows", [])}
    for r in cfg.get("post_join_row_extras", {}).get("stem-opt-extension", []):
        keys.add(r["key"])
    return keys


# ---------------------------------------------------------------------------
# A — schema lock: the stem-opt-extension config carries the canonical field set
# ---------------------------------------------------------------------------

def group_a() -> None:
    print("\nA — schema lock (stem-opt-extension timeline config)")
    cfg_keys = _stem_opt_config_keys()
    missing = [k for k in (CANONICAL_STAGE_KEYS + CANONICAL_DATE_KEYS) if k not in cfg_keys]
    check("A1 config captures every canonical STEM OPT field", not missing, f"missing: {missing}")
    check("A2 ead_filed_date is the required cohort anchor",
          "ead_filed_date" in cfg_keys)


# ---------------------------------------------------------------------------
# B — key parity: the SAME keys are valid tag-suggest vocab (so a free-text
#     posting can carry exactly what the timeline form captures)
# ---------------------------------------------------------------------------

def group_b() -> None:
    print("\nB — key parity (config keys ⊆ tag-suggest vocab)")
    v = posting.vocab_lists()
    date_keys = set(v.get("date_key") or [])
    stage_keys = set(v.get("stage_key") or [])
    d_missing = [k for k in CANONICAL_DATE_KEYS if k not in date_keys]
    s_missing = [k for k in CANONICAL_STAGE_KEYS if k not in stage_keys]
    check("B1 every canonical DATE key is in the 1.8 date_key vocab", not d_missing, f"missing: {d_missing}")
    check("B2 every canonical STAGE key is in the 1.7 stage_key vocab", not s_missing, f"missing: {s_missing}")


# ---------------------------------------------------------------------------
# C — pipeline preserves the keys: the cleaners keep canonical fields (a posting
#     that mentions them ends up carrying them, not dropping them as OOV)
# ---------------------------------------------------------------------------

def group_c() -> None:
    print("\nC — cleaners preserve the canonical fields")
    dates_in = {k: "2026-03-18" for k in CANONICAL_DATE_KEYS}
    dates_out = posting._clean_dates(dates_in)
    kept = [k for k in CANONICAL_DATE_KEYS if k in dates_out]
    check("C1 _clean_dates keeps every canonical date key", len(kept) == len(CANONICAL_DATE_KEYS),
          f"kept {len(kept)}/{len(CANONICAL_DATE_KEYS)}: dropped {sorted(set(CANONICAL_DATE_KEYS) - set(kept))}")
    # A malformed date is still rejected (regression guard on the cleaner).
    check("C2 _clean_dates still rejects a non-YYYY-MM-DD value",
          "ead_filed_date" not in posting._clean_dates({"ead_filed_date": "March 18"}))


# ---------------------------------------------------------------------------
# D — derivation contract (RED until Phase 1): ead_filed_date -> filing period
# ---------------------------------------------------------------------------

def group_d() -> None:
    print("\nD — filing-period derivation (posting.filing_period) [Phase 1]")
    fn = getattr(posting, "filing_period", None)
    if not callable(fn):
        pending("D1 posting.filing_period(ead_filed_date) exists",
                "implement in Phase 1: '2026-03-18' -> {'filing_month':'Mar','filing_year':'2026'}")
        pending("D2 derivation handles empty/invalid input -> {}")
        return
    check("D1 derives month + year from an ISO filed date",
          fn("2026-03-18") == {"filing_month": "Mar", "filing_year": "2026"}, str(fn("2026-03-18")))
    check("D1b another month (Aug)",
          fn("2026-08-31") == {"filing_month": "Aug", "filing_year": "2026"}, str(fn("2026-08-31")))
    check("D2 empty/invalid input -> {}", fn("") == {} and fn("not-a-date") == {})


# ---------------------------------------------------------------------------
# E — LIVE recall bar: tag-suggest extracts the STEM OPT fields from curated prose
# ---------------------------------------------------------------------------

_CURATED = Path("/Users/KW98T6E/Projects/krish/curated/stem")


def group_e() -> None:
    print("\nE — LIVE extraction recall (curated fixtures)")
    if not os.getenv("GCP_PROJECT_ID") and not os.getenv("GCP_PROJECT"):
        print("  SKIP: GCP not configured (live Gemini required)")
        return
    if not _CURATED.exists():
        print(f"  SKIP: curated fixtures not found at {_CURATED}")
        return
    # ss5.txt has an explicit, fully-dated STEM OPT extension timeline.
    f = _CURATED / "ss5.txt"
    if not f.exists():
        print(f"  SKIP: {f} not found")
        return
    lines = f.read_text().splitlines()
    title, description = lines[0], "\n".join(lines[2:])
    out = posting.suggest_tags(title, description)
    dates = out.get("key_dates", {})
    stages = out.get("key_stages_or_info", {})
    check("E1 extracts the EAD filed date", bool(dates.get("ead_filed_date")), str(dates))
    check("E2 extracts the approval date", bool(dates.get("ead_approved_date")), str(dates))
    check("E3 recognizes it as a stem-opt-extension / EAD posting",
          "stem-opt-extension" in (out.get("groups", {}).get("tags", []))
          or "EAD" in str(out.get("groups", {})), str(out.get("groups")))
    print(f"     extracted key_dates={dates} key_stages={stages}")


def main() -> None:
    scope = sys.argv[1] if len(sys.argv) > 1 else "unit"
    print("== test_stem_opt_timeline (STEM OPT unified timeline — acceptance) ==")
    group_a()
    group_b()
    group_c()
    group_d()
    if scope in ("integration", "all"):
        group_e()
    print(f"\nSUMMARY: {_passed}/{_passed + _failed} invariant checks passed; {_pending} contract(s) pending (Phase 1)")
    # Pending contracts are the TDD red bar — fail the run so they are visible,
    # but only once someone runs this suite intentionally (it is not yet gated).
    sys.exit(1 if (_failed or _pending) else 0)


if __name__ == "__main__":
    main()
