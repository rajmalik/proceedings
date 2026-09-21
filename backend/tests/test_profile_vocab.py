"""
test_profile_vocab.py — regression tests for the profile vocabulary changes on the
`change-profile-enhancements` branch. All deterministic (no network / GCP calls —
only the controlled-vocab CSVs are read).

Covers:
  T  profile `tags` = miscellaneous (1.3 abbreviations + 1.10 topics) ONLY
  S  key_stages_or_info value-domains: forms(1.5)->outcome(1.9), country, etc.; 1.6 excluded
  D  stage_value_domain / stage_value_ok helpers + 'filed' is a valid outcome
  V  /api/tag-vocab payload exposes misc / misc_options / profile_stage_key / domains
  P  onboarding prompts RENDER (guards the f-string `{{form: outcome}}` escaping bug)
  M  merge_profile unions the tags list

Run:  .venv/bin/python tests/test_profile_vocab.py
"""

import os
import sys

from dotenv import load_dotenv

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
load_dotenv()

_results: list[tuple[str, bool]] = []


def check(name: str, passed: bool, detail: str = "") -> None:
    _results.append((name, passed))
    print(f"  [{'PASS' if passed else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))


# ---------------------------------------------------------------------------
# T — profile.tags is "miscellaneous tags & topics" (1.3 + 1.10) ONLY
# ---------------------------------------------------------------------------
def group_tags() -> None:
    print("\nT — profile tags = miscellaneous (1.3 + 1.10) only")
    import posting
    import profile as pr
    posting._Vocab.load()
    misc_code = next(iter(posting._Vocab.misc))  # a real 1.3/1.10 code
    c = pr.clean_profile({"tags": [misc_code, "I-485", "approved", "h1b-petition", "NOT-A-TAG"]})
    check("T1 valid miscellaneous tag kept", misc_code in c["tags"], str(c["tags"]))
    check("T2 form (1.5 'I-485') dropped from tags", "I-485" not in c["tags"])
    check("T3 outcome (1.9 'approved') dropped from tags", "approved" not in c["tags"])
    check("T4 visa-form-action (1.6 'h1b-petition') dropped from tags", "h1b-petition" not in c["tags"])
    check("T5 garbage dropped from tags", "NOT-A-TAG" not in c["tags"])

    # T6-T7 — regression coverage for the adjustment-of-status-AOS retirement
    # (features/timeline-notifications-3/timeline-notifications-485.md), scoped
    # to profile.tags' actual domain (1.3 abbreviations + 1.10 topics only —
    # per T4 above, 1.6 action tags like ead-filing/i765-filing were NEVER
    # valid here regardless of the retirement, so they're not re-tested in
    # this file; that coverage lives in test_posting_tagging.py's E78/E79,
    # which exercise build_canonical()'s tags-field cleaning instead).
    c2 = pr.clean_profile({"tags": ["EAD", "AOS", "adjustment-of-status-AOS"]})
    check("T6 (positive) 'EAD' abbreviation still valid, kept (unaffected sanity check)",
          "EAD" in c2["tags"], str(c2["tags"]))
    check("T7 (positive) 'AOS' abbreviation still valid, kept", "AOS" in c2["tags"], str(c2["tags"]))
    check("T8 (negative) retired 'adjustment-of-status-AOS' (1.10) dropped as OOV",
          "adjustment-of-status-AOS" not in c2["tags"], str(c2["tags"]))

    # T9-T10 — regression coverage for the COE retirement
    # (features/timeline-notifications-3/timeline-notifications-coe.md) — the
    # OPPOSITE direction from AOS: here the 1.3 abbreviation was retired and
    # the 1.10 compound tag survives, since live evidence showed the model
    # never selected bare 'COE' even when the query text used the literal
    # acronym.
    c3 = pr.clean_profile({"tags": ["change-of-employer-COE", "COE"]})
    check("T9 (positive) 'change-of-employer-COE' (1.10) still valid, kept",
          "change-of-employer-COE" in c3["tags"], str(c3["tags"]))
    check("T10 (negative) retired 'COE' (1.3) dropped as OOV",
          "COE" not in c3["tags"], str(c3["tags"]))


# ---------------------------------------------------------------------------
# S — key_stages_or_info value-domains (forms->outcome, country, 1.6 excluded)
# ---------------------------------------------------------------------------
def group_stages() -> None:
    print("\nS — key_stages value-domains")
    import profile as pr
    c = pr.clean_profile({"key_stages_or_info": {
        "I-485": "filed",            # form key -> outcome value ('filed' is valid)
        "I-130": "approved",         # form key -> outcome value
        "I-129": "banana",           # form key -> invalid outcome -> dropped
        "citizen_of_country": "IN",  # country domain
        "born_in_country": "ZZ",     # invalid country -> dropped
        "outcome_status": "RFE",     # outcome domain
        "h1b-petition": "x",         # 1.6 key -> not a profile stage key -> dropped
    }})
    ks = c["key_stages_or_info"]
    check("S1 form key + valid outcome 'filed' kept", ks.get("I-485") == "filed", str(ks))
    check("S2 form key + valid outcome 'approved' kept", ks.get("I-130") == "approved")
    check("S3 form key + invalid value dropped", "I-129" not in ks)
    check("S4 country stage valid kept", ks.get("citizen_of_country") == "IN")
    check("S5 country stage invalid dropped", "born_in_country" not in ks)
    check("S6 outcome_status valid outcome kept", ks.get("outcome_status") == "RFE")
    check("S7 1.6 action key dropped from profile stages", "h1b-petition" not in ks)


# ---------------------------------------------------------------------------
# D — domain helpers + 'filed' outcome + profile stage-key set
# ---------------------------------------------------------------------------
def group_domains() -> None:
    print("\nD — stage_value_domain / stage_value_ok / 'filed'")
    import posting
    posting._Vocab.load()
    check("D1 form key domain == outcome", posting.stage_value_domain("I-485") == "outcome")
    check("D2 citizen_of_country domain == country", posting.stage_value_domain("citizen_of_country") == "country")
    check("D3 unconstrained stage key domain is None", posting.stage_value_domain("visa_status") is None,
          str(posting.stage_value_domain("visa_status")))
    check("D4 'filed' is a valid 1.9 outcome", "filed" in posting._Vocab.outcomes)
    check("D5 stage_value_ok(form, 'filed') True", posting.stage_value_ok("I-485", "filed"))
    check("D6 stage_value_ok(form, 'banana') False", not posting.stage_value_ok("I-485", "banana"))
    check("D7 1.6 action NOT in profile_stage_keys", "h1b-petition" not in posting._Vocab.profile_stage_keys)
    check("D8 form IS in profile_stage_keys", "I-485" in posting._Vocab.profile_stage_keys)

    # D9-D10 — i765_filed_date -> ead_filed_date rename
    # (features/timeline-notifications-3/timeline-notifications-ead.md §3/§6)
    check("D9 (positive) 'ead_filed_date' is a valid 1.8 key_dates key",
          "ead_filed_date" in posting._Vocab.date_keys)
    check("D10 (negative) retired 'i765_filed_date' is no longer a valid key_dates key",
          "i765_filed_date" not in posting._Vocab.date_keys)

    # D11-D12 — profile-side clean_profile() key_dates cleaning honors the rename
    # (mirrors T6-T9's tags-side coverage, but for the key_dates field).
    import profile as pr
    cd = pr.clean_profile({"key_dates": {"ead_filed_date": "2026-03-01",
                                          "i765_filed_date": "2026-03-01"}})
    check("D11 (positive) clean_profile keeps 'ead_filed_date'",
          cd["key_dates"].get("ead_filed_date") == "2026-03-01", str(cd["key_dates"]))
    check("D12 (negative) clean_profile drops retired 'i765_filed_date' as OOV",
          "i765_filed_date" not in cd["key_dates"], str(cd["key_dates"]))

    # D12a-D12c — stem_opt_cycle/stem_opt_year (1.7) for the stem-opt-extension
    # Cycle/Year dropdowns (features/timeline-notifications-3/timeline-posting-stem-opt.md)
    for k in ("stem_opt_cycle", "stem_opt_year"):
        check(f"D12a (positive) '{k}' is a valid 1.7 profile_stage_key", k in posting._Vocab.profile_stage_keys)
    cks = pr.clean_profile({"key_stages_or_info": {"stem_opt_cycle": "Fall", "stem_opt_year": "2026"}})
    check("D12b (positive) clean_profile keeps stem_opt_cycle/stem_opt_year",
          cks["key_stages_or_info"].get("stem_opt_cycle") == "Fall"
          and cks["key_stages_or_info"].get("stem_opt_year") == "2026", str(cks["key_stages_or_info"]))
    check("D12c stem_opt_cycle/stem_opt_year are unconstrained (no value-domain restriction)",
          posting.stage_value_domain("stem_opt_cycle") is None and posting.stage_value_domain("stem_opt_year") is None)

    # D13-D16 — new key_dates entries for the stem-opt attribute template
    # (features/timeline-notifications-3/timeline-posting-stem-opt.md)
    for i, k in enumerate(("noid_date", "ead_card_produced_date", "ead_card_received_date"), start=1):
        check(f"D13.{i} (positive) '{k}' is a valid 1.8 key_dates key", k in posting._Vocab.date_keys)
    cd2 = pr.clean_profile({"key_dates": {
        "noid_date": "2026-05-01", "ead_card_produced_date": "2026-05-02",
        "ead_card_received_date": "2026-05-03", "not-a-real-key": "2026-05-04",
    }})
    check("D14 (positive) clean_profile keeps all 3 new date keys",
          all(cd2["key_dates"].get(k) for k in
              ("noid_date", "ead_card_produced_date", "ead_card_received_date")), str(cd2["key_dates"]))
    check("D15 (negative) an out-of-vocab date key is still dropped",
          "not-a-real-key" not in cd2["key_dates"])


# ---------------------------------------------------------------------------
# V — /api/tag-vocab payload shape (drives the profile UI dropdowns)
# ---------------------------------------------------------------------------
def group_vocab_api() -> None:
    print("\nV — vocab_lists() payload")
    import posting
    v = posting.vocab_lists()
    for key in ("misc", "misc_options", "profile_stage_key", "outcome", "country", "stage_value_domains"):
        check(f"V:{key} present + non-empty", bool(v.get(key)), str(type(v.get(key))))
    check("V misc_options carry code+label", all("code" in o and "label" in o for o in v["misc_options"][:5]))
    check("V misc_option label shows the description ('CODE — meaning')",
          any(" — " in o["label"] for o in v["misc_options"][:30]))
    check("V stage_value_domains maps a form -> outcome", v["stage_value_domains"].get("I-485") == "outcome")
    check("V profile_stage_key excludes 1.6", "h1b-petition" not in set(v["profile_stage_key"]))
    check("V 'filed' present in outcome list", "filed" in v["outcome"])
    check("V J-1 expiry date key present (j1_expire_date)", "j1_expire_date" in v["date_key"])
    # consulate_tree: grouped country -> cities for the two-part picker
    tree = v.get("consulate_tree") or []
    check("V consulate_tree present + non-empty", bool(tree), str(len(tree)))
    tree_by_country = {c["country"]: c for c in tree}
    india = tree_by_country.get("India")
    check("V consulate_tree India has country_code IN", bool(india) and india["country_code"] == "IN")
    check("V consulate_tree India cities include Mumbai/BOM",
          bool(india) and any(x["code"] == "BOM" and x["city"] == "Mumbai" for x in india["cities"]))
    check("V consulate_tree comma-country grouped correctly (Congo, Dem. Rep. of -> CD)",
          tree_by_country.get("Congo, Dem. Rep. of", {}).get("country_code") == "CD")
    check("V consulate_tree every city-bearing country has a country_code",
          all(c["country_code"] for c in tree if c["cities"]))
    check("V consulate_tree country codes are valid consulate values",
          all(c["country_code"] in posting._Vocab.consulate for c in tree if c["country_code"]))

    # tag_attribute_templates — the SCOPE rows of the Timeline find/create
    # panel, resolved per processing type / eligibility category from
    # posting.py's declarative spec. Every scope leads with the same period
    # pair (Month + Year); a category may configure extra rows after them
    # (I-485 adds a Priority Date). The per-member date rows live in
    # post_join_attribute_templates instead, shown after a user joins.
    templates = v.get("tag_attribute_templates") or {}
    check("V tag_attribute_templates has both 'stem-opt-extension' and 'H-1B' entries",
          "stem-opt-extension" in templates and "H-1B" in templates)
    for key, label in (("stem-opt-extension", "stem-opt-extension"), ("H-1B", "H-1B"),
                       ("adjustment-of-status", "adjustment-of-status")):
        rows = templates[key]
        period, extras = rows[:2], rows[2:]
        check(f"V {label}: leads with 1 select row (Month) + 1 year row (Year)",
              [r.get("kind") for r in period] == ["select", "year"],
              str([r.get("kind") for r in rows]))
        check(f"V {label}: the Month select row offers the 12 calendar months",
              period[0]["options"] == ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                                       "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
              str(period[0]["options"]))
        check(f"V {label}: Month/Year keys are real 1.7 profile_stage_key vocab entries",
              period[0]["key"] in posting._Vocab.profile_stage_keys
              and period[1]["key"] in posting._Vocab.profile_stage_keys,
              f"month={period[0]['key']} year={period[1]['key']}")
        # Whatever a category adds still has to be storable — every row's key
        # must exist in the CSV its `field` names, or profile.py drops it.
        check(f"V {label}: every extra scope row targets real vocabulary",
              all(r["key"] in (posting._Vocab.date_keys if r["field"] == "key_dates"
                               else posting._Vocab.profile_stage_keys) for r in extras),
              str([(r["key"], r["field"]) for r in extras]))
    check("V no scope configures an extra row today — every scope is its period",
          [k for k, rows in templates.items() if len(rows) > 2] == [],
          str({k: len(rows) for k, rows in templates.items()}))
    # I-485's priority date belongs to the member, not the cohort.
    aos_pj = (v.get("post_join_attribute_templates") or {}).get("adjustment-of-status", [])
    check("V I-485 collects a Priority Date per member, and never blocks the join",
          [r["key"] for r in aos_pj] == ["priority_date"]
          and posting.required_keys(aos_pj) == [], str(aos_pj))
    check("V 'stem-opt-extension' is a real 1.6 visa-form-action tag (Processing type option, non-visa branch)",
          "stem-opt-extension" in posting._Vocab.visa_form_map)
    check("V 'H-1B' is a real 1.1 visa vocab entry (Processing type option, visa branch)",
          "H-1B" in posting._Vocab.visa)

    # post_join_attribute_templates — the per-member rows, shown on a group's
    # own page right after a user JOINS (not on the find/create panel). Mixed
    # kinds: dates into key_dates, selects/checkboxes into key_stages_or_info.
    post_join = v.get("post_join_attribute_templates") or {}
    check("V post_join_attribute_templates has 'stem-opt-extension' and 'H-1B' entries",
          {"stem-opt-extension", "H-1B"} <= set(post_join), str(list(post_join)))
    pj_rows = post_join["stem-opt-extension"]
    check("V post_join rows carry dates, selects and checkboxes",
          {r.get("kind") for r in pj_rows} == {"date", "select", "checkbox"},
          str(sorted({r.get("kind") for r in pj_rows})))
    pj_keys = [r["key"] for r in pj_rows]
    check("V post_join keys are unique", len(pj_keys) == len(set(pj_keys)), str(pj_keys))
    check("V every post_join key is real vocabulary for the field it targets",
          all(r["key"] in (posting._Vocab.date_keys if r["field"] == "key_dates"
                           else posting._Vocab.profile_stage_keys) for r in pj_rows),
          str([(r["key"], r["field"]) for r in pj_rows]))
    check("V post_join covers the full EAD lifecycle through card received",
          {"ead_filed_date", "ead_approved_date",
           "ead_card_produced_date", "ead_card_received_date"} <= set(pj_keys), str(pj_keys))
    check("V exactly one post_join row is required, and it is the filing date",
          posting.required_keys(pj_rows) == ["ead_filed_date"],
          str(posting.required_keys(pj_rows)))

    # H-1B — the petition lifecycle, collected per member at join time.
    h1b_rows = post_join["H-1B"]
    h1b_keys = [r["key"] for r in h1b_rows]
    check("V H-1B post_join keys are unique", len(h1b_keys) == len(set(h1b_keys)), str(h1b_keys))
    check("V every H-1B post_join key is real vocabulary for the field it targets",
          all(r["key"] in (posting._Vocab.date_keys if r["field"] == "key_dates"
                           else posting._Vocab.profile_stage_keys) for r in h1b_rows),
          str([(r["key"], r["field"]) for r in h1b_rows]))
    check("V H-1B covers the petition lifecycle from receipt through final decision",
          {"h1b_receipt_date", "h1b_review_started_date", "h1b_approved_date",
           "final_decision_date"} <= set(h1b_keys), str(h1b_keys))
    check("V H-1B collects premium processing and admin processing as checkboxes",
          [r["kind"] for r in h1b_rows if r["key"] in ("premium_processing", "admin_processing")]
          == ["checkbox", "checkbox"],
          str([(r["key"], r["kind"]) for r in h1b_rows]))
    status_row = next(r for r in h1b_rows if r["key"] == "application_status")
    check("V H-1B 'Intermediate Status' offers the RFE/NOID family",
          {"NOID", "RFE", "NOIR", "NOIRescind"} == set(status_row["options"]))
    # "Current Status" read as the case's final state; these are the states a
    # petition passes THROUGH on the way to one.
    check("V …and it is labelled 'Intermediate Status', not 'Current Status'",
          status_row["label"] == "Intermediate Status", status_row["label"])
    check("V H-1B 'Final Decision' offers approved/denied/rejected",
          {"approved", "denied", "rejected"} ==
          set(next(r for r in h1b_rows if r["key"] == "outcome_status")["options"]))
    check("V no H-1B select offers a value profile.py would silently drop",
          all(posting.stage_value_ok(r["key"], o)
              for r in h1b_rows if r["kind"] == "select" for o in r["options"]),
          str([(r["key"], r["options"]) for r in h1b_rows if r["kind"] == "select"]))
    check("V H-1B never blocks the join — every petition field is optional",
          posting.required_keys(h1b_rows) == [], str(posting.required_keys(h1b_rows)))
    # Join-time resolution is by tag, so rows on the TYPE and rows on one of its
    # CATEGORIES would shadow each other (TIMELINE-ATTRIBUTE-CONFIG.md §8). The
    # 12 rows sit on the type precisely so all three application types share them.
    h1b_type = next(t for t in v["processing_types"] if t["value"] == "H-1B")
    check("V H-1B's three application types carry no post_join rows of their own",
          all(c["tag"] not in post_join for c in h1b_type["eligibility_categories"]),
          str([c["tag"] for c in h1b_type["eligibility_categories"]]))
    # The clients read the second dropdown's heading off the payload; if it
    # didn't survive vocab_lists() they'd silently fall back to EAD's wording.
    check("V the payload carries H-1B's own category_label",
          h1b_type.get("category_label") == "Application type", str(h1b_type.get("category_label")))
    check("V …and EAD omits it, so the client default is what's exercised there",
          "category_label" not in next(t for t in v["processing_types"] if t["value"] == "EAD"))


# ---------------------------------------------------------------------------
# P — onboarding prompts must RENDER (regression for the f-string escaping bug)
# ---------------------------------------------------------------------------
def group_prompts() -> None:
    print("\nP — onboarding prompts render")
    import profile as pr
    b = pr._basics_system_prompt({
        "current_visa_or_greencard_category": ["H-1B"],
        "key_dates": {"i140_filed_date": "2026-02-15"},
    })
    check("P1 basics prompt renders to a string", isinstance(b, str) and len(b) > 500, f"len={len(b) if isinstance(b, str) else 'n/a'}")
    check("P2 basics prompt has LITERAL '{form: outcome}' (braces escaped, not evaluated)", "{form: outcome}" in b)
    check("P3 basics prompt carries the no-re-ask instruction", "re-ask" in b.lower())
    check("P5 basics prompt has the date-key↔visa guardrail", "j1_expire_date" in b and "f1_expire_date" in b)
    e = pr._experiences_system_prompt({"current_visa_or_greencard_category": ["H-1B"], "journey": []})
    check("P4 experiences prompt renders to a string", isinstance(e, str) and len(e) > 200)


# ---------------------------------------------------------------------------
# M — merge_profile unions the tags list
# ---------------------------------------------------------------------------
def group_merge() -> None:
    print("\nM — merge_profile unions tags")
    import posting
    import profile as pr
    posting._Vocab.load()
    codes = list(posting._Vocab.misc)
    m1, m2 = codes[0], codes[1] if len(codes) > 1 else codes[0]
    merged = pr.merge_profile({"tags": [m1]}, {"tags": [m2]})
    check("M1 tags are unioned on merge", m1 in merged["tags"] and m2 in merged["tags"], str(merged["tags"]))


def main() -> int:
    print("Profile vocab regression (deterministic; no network)")
    group_tags()
    group_stages()
    group_domains()
    group_vocab_api()
    group_prompts()
    group_merge()
    print("\n" + "=" * 60)
    passed = sum(1 for _, ok in _results if ok)
    failed = [n for n, ok in _results if not ok]
    print(f"SUMMARY: {passed}/{len(_results)} checks passed")
    if failed:
        print("FAILED: " + "; ".join(failed))
        return 1
    print("All profile-vocab regression checks passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
