#!/usr/bin/env python3
"""Offline unit tests for the AI-Assist **Phase 5** timeline -> /find handoff
(features/ai-assist-8/ai-assist-implementation-plan-8.md §Phase 5).

Offline / no-GCP: resolve_timeline_criteria uses the shipped timeline config
(posting.PROCESSING_TYPES / timeline_scope_rows / vocab_lists — all local, no
network); _timeline_handoff's matching.search_groups / preview_timeline_group
are monkeypatched.

Covers:
  A  resolve_timeline_criteria — maps a router decision to the exact Timeline
     criteria shape /find's panel produces (correct tags-vs-visa field per value;
     month/year into key_stages_or_info), month normalization, sufficiency.
  B  _timeline_handoff — found (public search hit) / not_found (preview name) /
     unresolved (insufficient criteria -> generic /find), search skipped when
     unresolved.

Run:  python tests/test_assist_timeline.py
Wired into the no-GCP CI gate.
"""
import sys
from pathlib import Path

_BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_BACKEND))  # backend/ on path

import assist  # noqa: E402
import matching  # noqa: E402
import posting  # noqa: E402

_passed = 0
_failed = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global _passed, _failed
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f" — {detail}" if detail else ""))
    if ok:
        _passed += 1
    else:
        _failed += 1


def _dec(**over):
    d = {
        "timeline_processing_type": "", "timeline_eligibility": "",
        "timeline_filing_month": "", "timeline_filing_year": "",
    }
    d.update(over)
    return d


# ---------------------------------------------------------------------------
# A — resolve_timeline_criteria
# ---------------------------------------------------------------------------

def group_a() -> None:
    print("\nA — resolve_timeline_criteria")

    # EAD + stem-opt-extension: both are TAG-vocab -> go into `tags`.
    r = assist.resolve_timeline_criteria(_dec(
        timeline_processing_type="EAD", timeline_eligibility="stem-opt-extension",
        timeline_filing_month="Aug", timeline_filing_year="2026"))
    c = r["criteria"]
    check("A1 EAD -> tags (tag vocab)", "EAD" in c["tags"])
    check("A2 stem-opt-extension -> tags", "stem-opt-extension" in c["tags"])
    check("A3 month/year -> key_stages_or_info",
          c["key_stages_or_info"].get("filing_month") == "Aug"
          and c["key_stages_or_info"].get("filing_year") == "2026", str(c["key_stages_or_info"]))
    check("A4 sufficient", r["sufficient"] is True)

    # H-1B is VISA vocab -> current_visa_or_greencard_category; app-type is a tag.
    r = assist.resolve_timeline_criteria(_dec(
        timeline_processing_type="H-1B", timeline_eligibility="change-of-status-COS",
        timeline_filing_month="Mar", timeline_filing_year="2026"))
    c = r["criteria"]
    check("A5 H-1B -> current_visa_or_greencard_category (visa vocab)",
          "H-1B" in c["current_visa_or_greencard_category"], str(c))
    check("A6 change-of-status-COS -> tags", "change-of-status-COS" in c["tags"])

    # adjustment-of-status is VISA vocab even though it's an EAD eligibility.
    r = assist.resolve_timeline_criteria(_dec(
        timeline_processing_type="EAD", timeline_eligibility="adjustment-of-status",
        timeline_filing_month="Jan", timeline_filing_year="2025"))
    check("A7 adjustment-of-status -> current_visa_or_greencard_category",
          "adjustment-of-status" in r["criteria"]["current_visa_or_greencard_category"])

    # Month normalization: numeric + full name + short all -> the 3-letter option.
    for raw in ("08", "8", "August", "aug", "Aug"):
        r = assist.resolve_timeline_criteria(_dec(
            timeline_processing_type="EAD", timeline_eligibility="stem-opt-extension",
            timeline_filing_month=raw, timeline_filing_year="2026"))
        check(f"A8 month '{raw}' -> Aug",
              r["criteria"]["key_stages_or_info"].get("filing_month") == "Aug")

    # Invalid processing type -> dropped, not sufficient.
    r = assist.resolve_timeline_criteria(_dec(
        timeline_processing_type="NOT-A-TYPE", timeline_eligibility="x",
        timeline_filing_month="Aug", timeline_filing_year="2026"))
    check("A9 invalid processing type dropped", r["processing_type"] == "")
    check("A9b invalid type -> not sufficient", r["sufficient"] is False)

    # Missing eligibility (type has categories) -> not sufficient.
    r = assist.resolve_timeline_criteria(_dec(
        timeline_processing_type="EAD", timeline_filing_month="Aug", timeline_filing_year="2026"))
    check("A10 missing eligibility -> not sufficient", r["sufficient"] is False)

    # Eligibility not valid for the type -> dropped, not sufficient.
    r = assist.resolve_timeline_criteria(_dec(
        timeline_processing_type="EAD", timeline_eligibility="change-of-status-COS",
        timeline_filing_month="Aug", timeline_filing_year="2026"))
    check("A11 wrong-type eligibility dropped", r["eligibility"] == "")
    check("A11b -> not sufficient", r["sufficient"] is False)

    # Missing year -> not sufficient.
    r = assist.resolve_timeline_criteria(_dec(
        timeline_processing_type="EAD", timeline_eligibility="stem-opt-extension",
        timeline_filing_month="Aug"))
    check("A12 missing year -> not sufficient", r["sufficient"] is False)

    # Bad month (13) -> normalized away -> not sufficient.
    r = assist.resolve_timeline_criteria(_dec(
        timeline_processing_type="EAD", timeline_eligibility="stem-opt-extension",
        timeline_filing_month="13", timeline_filing_year="2026"))
    check("A13 invalid month -> not sufficient", r["sufficient"] is False)


# ---------------------------------------------------------------------------
# B — _timeline_handoff
# ---------------------------------------------------------------------------

_SUFFICIENT = _dec(timeline_processing_type="EAD", timeline_eligibility="stem-opt-extension",
                   timeline_filing_month="Aug", timeline_filing_year="2026")


def _install(search_result, preview_name="EAD-stem-opt-extension-Aug-2026"):
    calls = {"search": 0, "preview": 0}
    orig_s, orig_p = matching.search_groups, matching.preview_timeline_group

    def fake_search(db, criteria, group_type="", precision="balanced", max_age_days=0, top_n=20):
        calls["search"] += 1
        assert group_type == "timeline", group_type
        return search_result

    def fake_preview(criteria, group_type="timeline"):
        calls["preview"] += 1
        return {"name": preview_name, "description": "desc"}

    matching.search_groups = fake_search
    matching.preview_timeline_group = fake_preview
    return (orig_s, orig_p), calls


def group_b() -> None:
    print("\nB — _timeline_handoff")

    # found: search returns a cohort -> its group_id/name.
    (os_, op_), calls = _install([{"group_id": "g-123", "name": "EAD-stem-opt-extension-Aug-2026"}])
    try:
        h = assist._timeline_handoff(_SUFFICIENT, db=object())
    finally:
        matching.search_groups, matching.preview_timeline_group = os_, op_
    check("B1 found status", h["status"] == "found", str(h))
    check("B1b found group_id", h["group_id"] == "g-123")
    check("B1c found group_name", h["group_name"] == "EAD-stem-opt-extension-Aug-2026")
    check("B1d preview not called on a hit", calls["preview"] == 0)

    # not_found: empty search -> the would-be name from preview_timeline_group.
    (os_, op_), calls = _install([])
    try:
        h = assist._timeline_handoff(_SUFFICIENT, db=object())
    finally:
        matching.search_groups, matching.preview_timeline_group = os_, op_
    check("B2 not_found status", h["status"] == "not_found", str(h))
    check("B2b not_found carries the would-be name", h["group_name"] == "EAD-stem-opt-extension-Aug-2026")
    check("B2c not_found has no group_id", h["group_id"] == "")
    check("B2d search + preview both called", calls["search"] == 1 and calls["preview"] == 1)

    # unresolved: insufficient criteria -> generic /find, search NEVER called.
    (os_, op_), calls = _install([{"group_id": "x", "name": "y"}])
    try:
        h = assist._timeline_handoff(_dec(timeline_processing_type="EAD"), db=object())
    finally:
        matching.search_groups, matching.preview_timeline_group = os_, op_
    check("B3 unresolved status", h["status"] == "unresolved", str(h))
    check("B3b unresolved skips search", calls["search"] == 0)
    check("B3c unresolved has no group_id", h["group_id"] == "")

    # every handoff carries the resolved criteria + a status + a /find deep-link.
    check("B4 handoff always has criteria + status + find_url",
          {"status", "group_id", "group_name", "criteria", "find_url"} <= set(h.keys()))

    # find_url is a Timeline-mode /find deep-link, prefilled with whatever was
    # resolved. Sufficient criteria -> all four params.
    (os_, op_), _ = _install([])
    try:
        h = assist._timeline_handoff(_SUFFICIENT, db=object())
    finally:
        matching.search_groups, matching.preview_timeline_group = os_, op_
    u = h["find_url"]
    check("B5 find_url is a timeline /find deep-link", u.startswith("/find?type=timeline"), u)
    check("B5b find_url carries processing_type", "processing_type=EAD" in u, u)
    check("B5c find_url carries eligibility", "eligibility=stem-opt-extension" in u, u)
    check("B5d find_url carries filing month + year",
          "filing_month=Aug" in u and "filing_year=2026" in u, u)

    # Partial (unresolved) -> only the params that resolved; no blank keys.
    partial = assist._timeline_find_url(assist.resolve_timeline_criteria(_dec(timeline_processing_type="EAD")))
    check("B6 partial find_url keeps processing_type only",
          partial == "/find?type=timeline&processing_type=EAD", partial)
    check("B6b no empty eligibility/month/year params", "eligibility=" not in partial and "filing_" not in partial, partial)


def main() -> None:
    print("== test_assist_timeline (AI-Assist Phase 5 — timeline -> /find) ==")
    group_a()
    group_b()
    print(f"\nSUMMARY: {_passed}/{_passed + _failed} checks passed")
    sys.exit(1 if _failed else 0)


if __name__ == "__main__":
    main()
