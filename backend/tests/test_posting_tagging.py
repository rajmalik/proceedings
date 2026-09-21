"""
test_posting_tagging.py — phase-H "Post a new message" composer + tagging.

Covers the posting pipeline end to end:
  A  vocabulary loading + the consulate place-name options + 1.10 descriptions
  B  tag cleaning / cross-bucket dedup / stages+dates cleaning
  C  relevant-section selection (expert-curated; no primary_consulate; consulate gating)
  D  validation rules (visa required, dup buckets, bad dates, OOV tags)
  E  canonical sidecar build (primary derived, case_id, overrides, embedding_text)
  F  Gemini tagging EDGE CASES (the ones we hit by hand) — INTEGRATION, may be slow
  G  API endpoints via TestClient incl. a real publish + cleanup — INTEGRATION

Groups A–E are deterministic and need no network. F + G call Gemini / GCP (ADC).

Run:  .venv/bin/python tests/test_posting_tagging.py
"""

import json
import os
import sys

from dotenv import load_dotenv

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
load_dotenv()

PROJECT = os.getenv("GCP_PROJECT_ID") or os.getenv("GCP_PROJECT", "")

_results: list[tuple[str, bool, str]] = []


def check(name: str, passed: bool, detail: str = "") -> None:
    _results.append((name, passed, bool(detail)))
    print(f"  [{'PASS' if passed else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))


# ---------------------------------------------------------------------------
# A — Vocabulary, consulate options, 1.10 descriptions (UNIT)
# ---------------------------------------------------------------------------

def group_a_vocab() -> None:
    print("\nA — Vocabulary & prompt block (unit)")
    import posting as p
    v = p.vocab_lists()
    check("A1 vocab non-empty (visa/consulate/tag/stage/date)",
          all(len(v[k]) > 0 for k in ("visa", "consulate", "tag", "stage_key", "date_key")),
          {k: len(v[k]) for k in v})

    opts = {o["code"]: o["label"] for o in v["consulate_options"]}
    check("A2 consulate city label = 'City, Country (CODE)'",
          opts.get("BOM") == "Mumbai, India (BOM)", opts.get("BOM"))
    check("A3 consulate country label = 'Country (CODE)'",
          opts.get("IN") == "India (IN)", opts.get("IN"))

    block = p._master_tags_block()
    check("A4 1.10 descriptions are sent to the model",
          "open-for-attorney — " in block and "lawyer-recommendation — " in block,
          "has '— ' description lines")
    check("A5 forms/abbreviations stay names-only (no '—' for I-129)",
          "I-129 — " not in block and "I-129" in block, "I-129 present without desc")


# ---------------------------------------------------------------------------
# B — Cleaning / dedup / stages+dates (UNIT)
# ---------------------------------------------------------------------------

def group_b_clean() -> None:
    print("\nB — Cleaning, dedup, stages/dates (unit)")
    import posting as p

    check("B1 _clean_group drops out-of-vocab visa",
          p._clean_group("visa_applying_for", ["H-1B", "NOT-A-VISA"]) == ["H-1B"])

    check("B2 primary_consulate: list coerced to first valid code",
          p._clean_group("primary_consulate", ["BOM", "DEL"]) == "BOM")
    check("B3 primary_consulate: invalid -> ''",
          p._clean_group("primary_consulate", "NOPE") == "")

    # cross-bucket dedup: a tag in both tags and concerns stays only in concerns
    groups = {"current_visa_or_greencard_category": [], "consulates": [],
              "concerns_or_questions_tags": ["RFE"], "tags": ["RFE"]}
    p._dedup_buckets(groups)
    check("B4 dedup: RFE kept in concerns, removed from tags",
          groups["tags"] == [] and groups["concerns_or_questions_tags"] == ["RFE"], str(groups))

    norm = p._normalize_groups({"primary_consulate": "BOM", "consulates": [],
                                "current_visa_or_greencard_category": [], "tags": [],
                                "concerns_or_questions_tags": []})
    check("B5 normalize: primary added into consulates", norm["consulates"] == ["BOM"], str(norm.get("consulates")))

    st = p._clean_stages({"visa_status": "approved", "bogus_key": "x"})
    check("B6 _clean_stages keeps valid 1.7 key, drops unknown",
          st.get("visa_status") == "approved" and "bogus_key" not in st, str(st))

    dt = p._clean_dates({"visa_interview_date": "2026-05-20", "visa_interview_date_bad": "05/20/2026"})
    check("B7 _clean_dates keeps YYYY-MM-DD valid key, drops bad",
          dt.get("visa_interview_date") == "2026-05-20" and len(dt) == 1, str(dt))


# ---------------------------------------------------------------------------
# C — relevant_sections (UNIT)
# ---------------------------------------------------------------------------

def group_c_sections() -> None:
    print("\nC — relevant_sections selection (unit)")
    import posting as p

    base = {f: [] for f in p.GROUP_FIELDS}
    base["primary_consulate"] = ""

    # model says primary_consulate -> must be stripped from UI output
    g = dict(base); g["consulates"] = ["BOM"]; g["primary_consulate"] = "BOM"
    secs = p._relevant_sections({"relevant_sections": ["visa_applying_for", "primary_consulate", "consulates"]}, g)
    check("C1 primary_consulate never appears in UI sections", "primary_consulate" not in secs, str(secs))
    check("C2 consulates kept when a consulate is present", "consulates" in secs, str(secs))

    # consulate gating: no consulate present -> consulates section dropped
    g2 = dict(base)
    secs2 = p._relevant_sections({"relevant_sections": ["visa_applying_for", "consulates"]}, g2)
    check("C3 consulates dropped when no consulate present", "consulates" not in secs2, str(secs2))

    # fallback heuristic when model returns nothing
    g3 = dict(base); g3["visa_applying_for"] = ["H-1B"]
    secs3 = p._relevant_sections({}, g3)
    check("C4 fallback shows non-empty section + always tags",
          "visa_applying_for" in secs3 and "tags" in secs3, str(secs3))


# ---------------------------------------------------------------------------
# D — validation (UNIT)
# ---------------------------------------------------------------------------

def _doc(**over) -> dict:
    base = {
        "current_visa_or_greencard_category": ["H-1B"], "visa_applying_for": [],
        "primary_consulate": "", "consulates": [], "tags": [], "concerns_or_questions_tags": [],
        "employer_type": "unknown", "severity": "low", "resolution_status": "open",
        "key_dates": {}, "key_stages_or_info": {},
    }
    base.update(over)
    return base


def group_d_validate() -> None:
    print("\nD — validation rules (unit)")
    import posting as p

    check("D1 valid minimal doc passes", p.validate(_doc()) == [], str(p.validate(_doc())))

    no_visa = _doc(current_visa_or_greencard_category=[], visa_applying_for=[])
    check("D2 missing visa/category -> error",
          any("Capture a visa" in e for e in p.validate(no_visa)), str(p.validate(no_visa)))

    dup = _doc(tags=["RFE"], concerns_or_questions_tags=["RFE"])
    check("D3 same tag in two buckets -> error",
          any("both" in e for e in p.validate(dup)), str(p.validate(dup)))

    badd = _doc(key_dates={"visa_interview_date": "2026/05/20"})
    check("D4 bad date format -> error",
          any("YYYY-MM-DD" in e for e in p.validate(badd)), str(p.validate(badd)))

    oov = _doc(tags=["totally-made-up-tag"])
    check("D5 out-of-vocab tag -> error",
          any("not in tag vocab" in e for e in p.validate(oov)), str(p.validate(oov)))

    badcons = _doc(primary_consulate="BOM", consulates=["DEL"])
    check("D6 primary_consulate must be within consulates",
          any("within consulates" in e for e in p.validate(badcons)), str(p.validate(badcons)))

    # D7-D8: news-update bypasses the visa/status-required rule
    # (GOV-NEWS-INGESTION-PLAN.md §3.4) — general policy news doesn't
    # represent anyone's personal status claim.
    news = _doc(current_visa_or_greencard_category=[], visa_applying_for=[], tags=["news-update"])
    check("D7 news-update tag bypasses the visa/status-required rule (fully valid doc)",
          p.validate(news) == [], str(p.validate(news)))

    news_and_visa = _doc(current_visa_or_greencard_category=["H-1B"], tags=["news-update"])
    check("D8 news-update doesn't suppress other validation (still fully valid doc)",
          p.validate(news_and_visa) == [], str(p.validate(news_and_visa)))


# ---------------------------------------------------------------------------
# E — build_canonical (UNIT)
# ---------------------------------------------------------------------------

def group_e_build() -> None:
    print("\nE — canonical sidecar build (unit)")
    import re
    import posting as p

    tags = {"visa_applying_for": ["H-1B"], "current_visa_or_greencard_category": [],
            "primary_consulate": "", "consulates": ["BOM"], "tags": ["visa-stamping"],
            "concerns_or_questions_tags": []}
    c = p.build_canonical("H-1B stamping at Mumbai", "Body text here.", tags,
                          {"visa_status": "approved"}, {"visa_interview_date": "2026-05-20"},
                          {"background_summary": "bg", "severity": "high"})

    check("E1 primary_consulate derived from consulates[0]", c["primary_consulate"] == "BOM", c["primary_consulate"])
    check("E2 case_id format app-YYYY-MM-DD-xxxx",
          bool(re.match(r"^app-\d{4}-\d{2}-\d{2}-[0-9a-f]{8}$", c["case_id"])), c["case_id"])
    check("E3 channel=app, source_system=meridianjourney",
          c["channel"] == "app" and c["source_system"] == "meridianjourney")
    check("E4 synthetic author_handle present", bool(c["author_handle"]), c["author_handle"])
    check("E5 user stages/dates carried through",
          c["key_stages_or_info"] == {"visa_status": "approved"} and c["key_dates"] == {"visa_interview_date": "2026-05-20"})
    check("E6 embedding_text includes title + a tag",
          "H-1B stamping at Mumbai" in c["embedding_text"] and "visa-stamping" in c["embedding_text"])
    check("E7 extracted context used (severity=high)", c["severity"] == "high", c["severity"])

    # E8-E12: _derive_visa_from_tags() / visa backfill in build_canonical() —
    # tips/advice content (e.g. "Tips for Tracking Your H-1B Petition") often
    # has no personal visa claim but does reference process tags like
    # h1b-petition; validate() requires a visa/status, so build_canonical()
    # deterministically backfills one from the post's own tags when possible.
    tips_tags = {"visa_applying_for": [], "current_visa_or_greencard_category": [],
                 "primary_consulate": "", "consulates": [],
                 "tags": ["I-797", "USCIS", "RFE", "h1b-petition", "processing-time", "tips"],
                 "concerns_or_questions_tags": []}
    c8 = p.build_canonical("Tips for Tracking Your H-1B Petition", "Body text here.", tips_tags)
    check("E8 visa backfilled from process tag (h1b-petition -> H-1B)",
          c8["visa_applying_for"] == ["H-1B"], c8["visa_applying_for"])
    check("E9 backfilled doc passes validation", p.validate(c8) == [], str(p.validate(c8)))

    explicit_tags = {"visa_applying_for": ["L-1"], "current_visa_or_greencard_category": [],
                      "primary_consulate": "", "consulates": [], "tags": ["h1b-petition"],
                      "concerns_or_questions_tags": []}
    c10 = p.build_canonical("My L-1 experience", "Some L-1 story.", explicit_tags)
    check("E10 explicit visa never overridden by backfill",
          c10["visa_applying_for"] == ["L-1"], c10["visa_applying_for"])

    ambiguous_tags = {"visa_applying_for": [], "current_visa_or_greencard_category": [],
                       "primary_consulate": "", "consulates": [], "tags": ["l1-to-h1b"],
                       "concerns_or_questions_tags": []}
    c11 = p.build_canonical("Status change question", "Thinking about changing status.", ambiguous_tags)
    check("E11 ambiguous multi-value mapping (L-1 / H-1B) not backfilled",
          c11["visa_applying_for"] == [], c11["visa_applying_for"])

    form_only_tags = {"visa_applying_for": [], "current_visa_or_greencard_category": [],
                       "primary_consulate": "", "consulates": [], "tags": ["i129-filing"],
                       "concerns_or_questions_tags": []}
    c12 = p.build_canonical("Filing question", "About my I-129 filing.", form_only_tags)
    check("E12 form-number tag not treated as a visa code",
          c12["visa_applying_for"] == [], c12["visa_applying_for"])

    # E12a-E12c: a "/"-joined 1.6 mapping isn't automatically ambiguous —
    # only when MORE THAN ONE side is itself a real 1.1/1.2 code. Found
    # live (docs/tagging/VISA-VOCAB-GAPS-AND-CURATION-BLOCKERS.md): a real
    # curated post about Initial OPT failed validate() because the old
    # strict "no '/' at all" check discarded 'OPT / F-1' even though 'OPT'
    # isn't a selectable vocab code at all — no real ambiguity, since
    # OPT/CPT are F-1-only benefits.
    opt_tags = {"visa_applying_for": [], "current_visa_or_greencard_category": [],
                "primary_consulate": "", "consulates": [], "tags": ["opt-application"],
                "concerns_or_questions_tags": []}
    c12a = p.build_canonical("Travel on Initial OPT?", "Waiting for my EAD card.", opt_tags)
    check("E12a one-valid-side mapping backfills (opt-application -> 'OPT / F-1' -> F-1)",
          c12a["visa_applying_for"] == ["F-1"], c12a["visa_applying_for"])

    niw_tags = {"visa_applying_for": [], "current_visa_or_greencard_category": [],
                "primary_consulate": "", "consulates": [], "tags": ["niw-petition"],
                "concerns_or_questions_tags": []}
    c12b = p.build_canonical("NIW question", "About my NIW petition.", niw_tags)
    check("E12b one-valid-side mapping backfills (niw-petition -> 'NIW / EB-2' -> EB-2)",
          c12b["visa_applying_for"] == ["EB-2"], c12b["visa_applying_for"])

    three_way_tags = {"visa_applying_for": [], "current_visa_or_greencard_category": [],
                       "primary_consulate": "", "consulates": [], "tags": ["b1b2-to-h1b"],
                       "concerns_or_questions_tags": []}
    c12c = p.build_canonical("Status change question", "Thinking about changing status.", three_way_tags)
    check("E12c genuinely multi-valid mapping (b1b2-to-h1b -> 'B-1/B-2 / H-1B', 3 valid sides) not backfilled",
          c12c["visa_applying_for"] == [], c12c["visa_applying_for"])

    zero_valid_tags = {"visa_applying_for": [], "current_visa_or_greencard_category": [],
                        "primary_consulate": "", "consulates": [], "tags": ["aos-filing"],
                        "concerns_or_questions_tags": []}
    c12d = p.build_canonical("AOS filing question", "About my AOS filing.", zero_valid_tags)
    check("E12d zero-valid-side mapping (aos-filing -> 'AOS / I-485', neither a vocab code) not backfilled",
          c12d["visa_applying_for"] == [], c12d["visa_applying_for"])

    # E13-E16: I-130 -> family-based-immigration (deterministic, tags-only —
    # I-130 alone can't tell us the SPECIFIC greencard category, so it never
    # picks one). E14/E15 changed from their original assertions: this used
    # to be where the story ended (category left blank, validate() still
    # failed) — found live (docs/tagging/VISA-VOCAB-GAPS-AND-CURATION-BLOCKERS.md)
    # that a real batch of curated posts hit exactly this shape (a general
    # I-130/I-485 discussion with no stated relationship) and had no way to
    # publish at all. _apply_visa_backfill() now takes the next, more
    # conservative step: since I-130 already guarantees the
    # family-based-immigration TAG is present, fall back to the generic
    # family-immigration CODE rather than leaving both visa fields empty.
    gc_tags = {"visa_applying_for": [], "current_visa_or_greencard_category": [],
               "primary_consulate": "", "consulates": [],
               "tags": ["I-130", "I-485", "aos-filing", "aos-approval"],
               "concerns_or_questions_tags": []}
    c13 = p.build_canonical("Got my green card 9 days after interview", "Body text.", gc_tags)
    check("E13 I-130 -> family-based-immigration tag added",
          "family-based-immigration" in c13["tags"], c13["tags"])
    check("E14 category backfilled to the generic fallback (I-130 doesn't imply a SPECIFIC code, but now guarantees a generic one)",
          c13["current_visa_or_greencard_category"] == ["family-immigration"], c13["current_visa_or_greencard_category"])
    check("E15 validate() now passes — the generic fallback satisfies the visa-required rule",
          p.validate(c13) == [], str(p.validate(c13)))

    c16 = p.build_canonical("t", "d", {"tags": ["i130-approval", "family-based-immigration"]})
    check("E16 no duplicate when family-based-immigration already present",
          c16["tags"].count("family-based-immigration") == 1, c16["tags"])

    # E16a-E16m: _apply_visa_backfill() — the generic last-resort fallback
    # (family-immigration / employment-immigration), gated behind a real
    # family/employment-based-immigration TAG signal, and only ever as a
    # last resort behind _derive_visa_from_tags()'s more specific answer.
    def _backfilled(tags: list[str]) -> dict:
        groups = {"visa_applying_for": [], "current_visa_or_greencard_category": [],
                  "primary_consulate": "", "consulates": [], "tags": tags,
                  "concerns_or_questions_tags": []}
        p._apply_visa_backfill(groups)
        return groups

    g_fam = _backfilled(["family-based-immigration"])
    check("E16a family-based-immigration tag alone -> family-immigration",
          g_fam["current_visa_or_greencard_category"] == ["family-immigration"], g_fam)

    g_emp = _backfilled(["employment-based-immigration"])
    check("E16b employment-based-immigration tag alone -> employment-immigration",
          g_emp["current_visa_or_greencard_category"] == ["employment-immigration"], g_emp)

    # dont-know-what-to-think.txt's real shape (I-485 pending, employment-based
    # tag present, no EB level stated) — this exact file failed validate()
    # in the 072826 batch; confirms it now resolves.
    g_real_emp = _backfilled(["I-485", "biometrics", "RFE", "pending",
                              "employment-based-immigration", "AOS"])
    check("E16c real dont-know-what-to-think.txt shape resolves to employment-immigration",
          g_real_emp["current_visa_or_greencard_category"] == ["employment-immigration"], g_real_emp)

    g_specific_wins = _backfilled(["employment-based-immigration", "h1b-petition"])
    check("E16d a specific derivable code (h1b-petition -> H-1B) wins over the generic employment fallback",
          g_specific_wins["visa_applying_for"] == ["H-1B"]
          and g_specific_wins["current_visa_or_greencard_category"] == [], g_specific_wins)

    g_no_signal = _backfilled(["USCIS", "timeline"])
    check("E16e no family/employment signal at all -> stays empty (duplicate-status-updates.txt shape; still needs a human, not silently satisfied)",
          g_no_signal["visa_applying_for"] == [] and g_no_signal["current_visa_or_greencard_category"] == [], g_no_signal)

    g_never_overrides_cat = {"visa_applying_for": [], "current_visa_or_greencard_category": ["IR-1"],
                             "primary_consulate": "", "consulates": [],
                             "tags": ["family-based-immigration"], "concerns_or_questions_tags": []}
    p._apply_visa_backfill(g_never_overrides_cat)
    check("E16f never overrides an already-populated current_visa_or_greencard_category",
          g_never_overrides_cat["current_visa_or_greencard_category"] == ["IR-1"], g_never_overrides_cat)

    g_never_overrides_visa = {"visa_applying_for": ["EB-2"], "current_visa_or_greencard_category": [],
                              "primary_consulate": "", "consulates": [],
                              "tags": ["family-based-immigration"], "concerns_or_questions_tags": []}
    p._apply_visa_backfill(g_never_overrides_visa)
    check("E16g never fires at all when visa_applying_for is already populated (even if category is still empty)",
          g_never_overrides_visa["current_visa_or_greencard_category"] == [], g_never_overrides_visa)

    g_both = _backfilled(["family-based-immigration", "employment-based-immigration"])
    check("E16h both signals present -> exactly one fallback applied, not both/duplicated",
          len(g_both["current_visa_or_greencard_category"]) == 1, g_both["current_visa_or_greencard_category"])

    # End-to-end through build_canonical() (not just the bare helper) —
    # confirms the I-130-tag-add-then-backfill ordering (§ comment above
    # E13) actually holds when called the same way suggest_tags()/publish
    # paths do, not just when the tags dict is hand-constructed already
    # containing the tag.
    c_i130_only = p.build_canonical("t", "d", {"tags": ["I-130"]})
    check("E16i build_canonical(): bare I-130 tag alone (deterministic add) still resolves to family-immigration end-to-end",
          c_i130_only["current_visa_or_greencard_category"] == ["family-immigration"], c_i130_only)
    check("E16j build_canonical(): bare I-130 case passes validate()",
          p.validate(c_i130_only) == [], str(p.validate(c_i130_only)))

    # suggest_tags() applies the same ordering (I-130 tag added before the
    # backfill runs) via _extract() + the same code path — verified with a
    # live Gemini call in group F/H; here we confirm the pure helper
    # ordering directly, which is what actually matters for correctness.
    g_order = {"visa_applying_for": [], "current_visa_or_greencard_category": [],
               "primary_consulate": "", "consulates": [], "tags": ["I-130"],
               "concerns_or_questions_tags": []}
    if p._I130_TAGS & set(g_order["tags"]):
        p._add_tag_once(g_order, "family-based-immigration")
    p._apply_visa_backfill(g_order)
    check("E16k I-130-tag-add-then-backfill ordering resolves to family-immigration (mirrors suggest_tags()'s call order)",
          g_order["current_visa_or_greencard_category"] == ["family-immigration"], g_order)

    g_vocab = {"visa_applying_for": [], "current_visa_or_greencard_category": [],
               "primary_consulate": "", "consulates": [], "tags": ["family-based-immigration"],
               "concerns_or_questions_tags": []}
    p._apply_visa_backfill(g_vocab)
    c_vocab = p.build_canonical("t", "d", g_vocab)
    check("E16l family-immigration is itself a valid 1.2 vocab entry (validate() doesn't reject it as OOV)",
          not any("not in visa vocab" in e for e in p.validate(c_vocab)), str(p.validate(c_vocab)))

    g_vocab2 = {"visa_applying_for": [], "current_visa_or_greencard_category": [],
                "primary_consulate": "", "consulates": [], "tags": ["employment-based-immigration"],
                "concerns_or_questions_tags": []}
    p._apply_visa_backfill(g_vocab2)
    c_vocab2 = p.build_canonical("t", "d", g_vocab2)
    check("E16m employment-immigration is itself a valid 1.2 vocab entry (validate() doesn't reject it as OOV)",
          not any("not in visa vocab" in e for e in p.validate(c_vocab2)), str(p.validate(c_vocab2)))

    # E17-E18: cross-bucket duplicate regression (1862-notice.txt case) — a
    # post ASKING about timeline puts "timeline" in concerns_or_questions_tags
    # only; the deterministic timeline rule must not also add it to tags,
    # since validate() rejects a tag appearing in more than one bucket.
    asking_tags = {"visa_applying_for": [], "current_visa_or_greencard_category": [],
                    "primary_consulate": "", "consulates": [], "tags": ["EAD", "asylum"],
                    "concerns_or_questions_tags": ["processing-delay", "timeline"]}
    c17 = p.build_canonical("1862 notice", "Body text.", asking_tags,
                            key_dates={"ead_approved_date": "2025-03-01"})
    check("E17 timeline not duplicated into tags when already in concerns_or_questions_tags",
          "timeline" not in c17["tags"], c17["tags"])
    check("E18 no cross-bucket-duplicate validation error",
          not any("both" in e for e in p.validate(c17)), str(p.validate(c17)))

    # E19-E27: Path B provenance overrides (docs/ingestion/PATH-B-PROVENANCE-PLAN.md)
    # — build_canonical()'s new keyword-only params, and the client_platform
    # allowlist clamp. All app-composer defaults (no kwargs passed) must stay
    # byte-for-byte identical to E1-E18 above; only explicit overrides change.
    reddit_tags = {"visa_applying_for": ["H-1B"], "current_visa_or_greencard_category": [],
                   "primary_consulate": "", "consulates": [], "tags": ["h1b-rfe"],
                   "concerns_or_questions_tags": []}
    cr = p.build_canonical(
        "H-1B RFE approved", "Body text.", reddit_tags,
        channel="reddit", ingestion_method="manual_curation", source_system="reddit",
        subreddit="h1b", reddit_post_id="1abc2de",
        full_url="https://www.reddit.com/r/h1b/comments/1abc2de/x/",
        posting_date="2026-06-15",
    )
    check("E19 channel override applied", cr["channel"] == "reddit", cr["channel"])
    check("E20 ingestion_method override applied",
          cr["ingestion_method"] == "manual_curation", cr["ingestion_method"])
    check("E21 source_system override applied", cr["source_system"] == "reddit", cr["source_system"])
    check("E22 deterministic reddit case_id (channel-date-subreddit-postid)",
          cr["case_id"] == "reddit-2026-06-15-h1b-1abc2de", cr["case_id"])
    check("E23 posting_date override applied (not today)",
          cr["posting_date"] == "2026-06-15", cr["posting_date"])
    check("E24 gcs_path uses the overridden channel, not the app default",
          cr["gcs_path"] == "gs://imm-postings-ingestion/2026-06-15/reddit/", cr["gcs_path"])
    check("E25 full_url override applied (real reddit permalink, not APP_BASE_URL)",
          cr["full_url"] == "https://www.reddit.com/r/h1b/comments/1abc2de/x/", cr["full_url"])
    check("E26 subreddit/reddit_post_id round-trip",
          cr["subreddit"] == "h1b" and cr["reddit_post_id"] == "1abc2de",
          (cr["subreddit"], cr["reddit_post_id"]))

    c_default = p.build_canonical("App post", "Body text.", reddit_tags)
    check("E27 no-kwargs default still produces channel=app, random case_id (E2's format)",
          c_default["channel"] == "app" and c_default["case_id"].startswith("app-"),
          c_default["case_id"])

    cp_web = p.build_canonical("t", "d", reddit_tags, client_platform="web")
    cp_bad = p.build_canonical("t", "d", reddit_tags, client_platform="not-a-real-platform")
    cp_default = p.build_canonical("t", "d", reddit_tags)
    check("E28 client_platform: valid value passes through", cp_web["client_platform"] == "web")
    check("E29 client_platform: invalid value clamps to ''", cp_bad["client_platform"] == "")
    check("E30 client_platform: omitted defaults to ''", cp_default["client_platform"] == "")

    # E31-E38: gov-news provenance (docs/ingestion/GOV-NEWS-INGESTION-PLAN.md)
    # — content_hash, the gov-news case_id scheme, and author_handle/
    # source_item_id overrides.
    check("E31 content_hash_for is deterministic for identical input",
          p.content_hash_for("t", "d") == p.content_hash_for("t", "d"))
    check("E32 content_hash_for differs when content differs",
          p.content_hash_for("t", "d1") != p.content_hash_for("t", "d2"))

    news_tags = {"visa_applying_for": [], "current_visa_or_greencard_category": [],
                 "primary_consulate": "", "consulates": [], "tags": ["news-update"],
                 "concerns_or_questions_tags": []}
    gc = p.build_canonical(
        "USCIS Reaches Fiscal Year 2027 H-1B Cap", "Body text.", news_tags,
        channel="gov_news", ingestion_method="rss_feed", source_system="uscis",
        full_url="https://www.uscis.gov/newsroom/alerts/uscis-reaches-fiscal-year-2027-h-1b-cap",
        posting_date="2026-07-17", author_handle="USCIS",
        source_item_id="8d0937a2-6564-412c-8b12-7db83e9fbb39",
    )
    import hashlib
    expected_short = hashlib.sha256(b"8d0937a2-6564-412c-8b12-7db83e9fbb39").hexdigest()[:8]
    check("E33 gov-news case_id format channel-source-date-hash",
          gc["case_id"] == f"gov_news-uscis-2026-07-17-{expected_short}", gc["case_id"])
    check("E34 case_id leading segment matches channel exactly (delete_content() convention)",
          gc["case_id"].split("-", 1)[0] == "gov_news", gc["case_id"])
    check("E35 author_handle override applied (fixed source handle, not synthetic)",
          gc["author_handle"] == "USCIS", gc["author_handle"])
    check("E36 source_item_id round-trips into the canonical dict",
          gc["source_item_id"] == "8d0937a2-6564-412c-8b12-7db83e9fbb39", gc["source_item_id"])
    check("E37 content_hash present and matches content_hash_for(title, description)",
          gc["content_hash"] == p.content_hash_for("USCIS Reaches Fiscal Year 2027 H-1B Cap", "Body text."),
          gc["content_hash"])
    check("E38 gov-news doc passes validation (news-update bypasses visa requirement)",
          p.validate(gc) == [], str(p.validate(gc)))

    # E39a-E39c: backdated ingestion (GOV-NEWS-INGESTION-PLAN.md — gov-news
    # content is routinely months old by the time it's ingested). Confirms
    # posting_date carries the real historical source date while
    # ingestion_timestamp stays "when WE actually processed it" regardless —
    # the two must never be conflated, which is exactly what the
    # _write_bigquery() delete-guard bug (fixed alongside this test) would
    # have gotten wrong for backdated content specifically.
    from datetime import datetime, timezone
    today_str = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    old = p.build_canonical(
        "Old backdated article", "Body text.", news_tags,
        channel="gov_news", source_system="uscis", posting_date="2020-01-01",
        source_item_id="old-item-1",
    )
    check("E39 backdated posting_date carries the real historical date, not today",
          old["posting_date"] == "2020-01-01", old["posting_date"])
    check("E40 ingestion_timestamp is today regardless of how backdated posting_date is",
          old["ingestion_timestamp"].startswith(today_str), old["ingestion_timestamp"])
    check("E41 backdated case_id uses the historical date, not today",
          old["case_id"].startswith("gov_news-uscis-2020-01-01-"), old["case_id"])

    c_no_override = p.build_canonical("t", "d", reddit_tags)
    check("E42 author_handle omitted still defaults to a synthetic handle",
          bool(c_no_override["author_handle"]) and c_no_override["author_handle"] != "USCIS",
          c_no_override["author_handle"])

    # E43-E46: _gov_news_tags() — the news-update tag is gated on
    # content_type explicitly (GOV-NEWS-MULTI-SOURCE-CONFIG.md §5), not
    # implicitly assumed from "this function only gets called for news
    # sources today". A forum_posting-type call must never get news-update.
    check("E43 content_type='news' adds news-update",
          "news-update" in p._gov_news_tags(["USCIS", "fraud"], "news"),
          p._gov_news_tags(["USCIS", "fraud"], "news"))
    check("E44 content_type='forum_posting' does NOT add news-update",
          "news-update" not in p._gov_news_tags(["USCIS", "fraud"], "forum_posting"),
          p._gov_news_tags(["USCIS", "fraud"], "forum_posting"))
    check("E45 unrecognized content_type also does NOT add news-update (fail closed, not open)",
          "news-update" not in p._gov_news_tags(["tag1"], "something-unexpected"),
          p._gov_news_tags(["tag1"], "something-unexpected"))
    check("E46 no duplicate news-update if the model already produced one",
          p._gov_news_tags(["a", "news-update", "b"], "news").count("news-update") == 1,
          p._gov_news_tags(["a", "news-update", "b"], "news"))
    # E45a — regression: news-update is a real, LLM-selectable vocab entry
    # (tags-cleaned/1.10-common-misc.csv), so _extract() can choose it on
    # its own for policy/news-shaped content regardless of content_type.
    # Found live: a real immihelp (forum_posting) posting about a visa fee
    # change came back from _extract() with news-update already in its
    # tags, and the pre-fix implementation only ever ADDED the tag for
    # content_type=="news" — it never stripped one the model had already
    # chosen for anything else, so it passed straight through.
    check("E45a content_type='forum_posting' STRIPS a model-chosen news-update, not just avoids adding one",
          "news-update" not in p._gov_news_tags(["h1b-petition", "news-update"], "forum_posting"),
          p._gov_news_tags(["h1b-petition", "news-update"], "forum_posting"))
    check("E45b unrecognized content_type also strips a pre-existing news-update (fail closed)",
          "news-update" not in p._gov_news_tags(["news-update"], "something-unexpected"),
          p._gov_news_tags(["news-update"], "something-unexpected"))

    # E47-E52: _apply_discussion_backfill() — a genuinely non-personal
    # policy/process discussion has no visa to capture and shouldn't be
    # rejected by publish for lacking one (evaluated live: real generic
    # content — "USCIS processing times ballooned this year, anyone else
    # seeing this?" — has both visa fields correctly empty but the model
    # doesn't reliably self-select the "discussion" tag over more specific
    # competing 1.10 tags like "processing-delay"; validate() then rejected
    # legitimate general-discussion content). Gated on is_personal_case
    # (model-classified) rather than trusting the model to also remember to
    # tag "discussion" itself — same "single boolean judgment beats a
    # specific-tag expectation" reasoning as the timeline/family-based rules
    # above.
    def _discussion_backfilled(is_personal_case) -> dict:
        groups = {"visa_applying_for": [], "current_visa_or_greencard_category": [],
                  "primary_consulate": "", "consulates": [], "tags": ["USCIS", "backlog"],
                  "concerns_or_questions_tags": []}
        p._apply_discussion_backfill(groups, is_personal_case)
        return groups

    g47 = _discussion_backfilled(False)
    check("E47 is_personal_case=False, no visa signal -> discussion tag added",
          "discussion" in g47["tags"], g47["tags"])

    g48 = _discussion_backfilled(True)
    check("E48 is_personal_case=True -> discussion NOT added (still needs a human to add a status)",
          "discussion" not in g48["tags"], g48["tags"])

    g49 = _discussion_backfilled(None)
    check("E49 is_personal_case missing/None -> fail-closed default, discussion NOT added",
          "discussion" not in g49["tags"], g49["tags"])

    g50 = {"visa_applying_for": ["H-1B"], "current_visa_or_greencard_category": [],
           "primary_consulate": "", "consulates": [], "tags": ["USCIS"],
           "concerns_or_questions_tags": []}
    p._apply_discussion_backfill(g50, False)
    check("E50 never fires when a visa field is already populated, even if is_personal_case is False",
          "discussion" not in g50["tags"], g50["tags"])

    g51 = {"visa_applying_for": [], "current_visa_or_greencard_category": [],
           "primary_consulate": "", "consulates": [], "tags": ["USCIS"],
           "concerns_or_questions_tags": ["discussion"]}
    p._apply_discussion_backfill(g51, False)
    check("E51 no cross-bucket duplicate: discussion already in concerns_or_questions_tags -> not re-added to tags",
          g51["tags"] == ["USCIS"], g51["tags"])

    c52 = p.build_canonical("t", "d", {"tags": ["USCIS", "discussion"]})
    check("E52 validate() accepts a discussion-tagged, visa-less posting (same exemption as news-update)",
          p.validate(c52) == [], str(p.validate(c52)))

    c52b = p.build_canonical("t", "d", {"tags": ["USCIS"], "concerns_or_questions_tags": ["discussion"]})
    check("E52b validate()'s discussion exemption also checks concerns_or_questions_tags, not just tags",
          p.validate(c52b) == [], str(p.validate(c52b)))

    c52c = p.build_canonical("t", "d", {"tags": ["USCIS"]})
    check("E52c control: no discussion/news-update anywhere, no visa -> validate() still correctly rejects",
          any("visa" in e.lower() or "status" in e.lower() for e in p.validate(c52c)), str(p.validate(c52c)))

    # E53-E59: adjustment-of-status — I-485 (the form) and "AOS"/"adjustment
    # of status" (the process) are used interchangeably by posters for the
    # same real-world action, but neither is itself a visa/GC category (AOS
    # can be filed on a family, employment, diversity, or asylum basis) —
    # the third, even-broader sibling of family-immigration/
    # employment-immigration in _apply_visa_backfill()'s ordering.
    def _aos_backfilled(tags: list[str]) -> dict:
        groups = {"visa_applying_for": [], "current_visa_or_greencard_category": [],
                  "primary_consulate": "", "consulates": [], "tags": tags,
                  "concerns_or_questions_tags": []}
        p._apply_visa_backfill(groups)
        return groups

    g53 = _aos_backfilled(["I-485", "aos-filing"])
    check("E53 I-485 + aos-filing, no other basis -> adjustment-of-status",
          g53["current_visa_or_greencard_category"] == ["adjustment-of-status"], g53)

    g54 = _aos_backfilled(["AOS"])
    check("E54 the bare 'AOS' abbreviation alone also triggers the fallback "
          "(adjustment-of-status-AOS 1.10 duplicate retired in favor of this — see "
          "features/timeline-notifications-3/timeline-notifications-485.md)",
          g54["current_visa_or_greencard_category"] == ["adjustment-of-status"], g54)

    g55 = _aos_backfilled(["i485-filing", "family-based-immigration"])
    check("E55 a family/employment signal present alongside AOS wins over the more generic adjustment-of-status",
          g55["current_visa_or_greencard_category"] == ["family-immigration"], g55)

    g56 = _aos_backfilled(["aos-filing", "h1b-petition"])
    check("E56 a specific derivable code (h1b-petition -> H-1B) wins over adjustment-of-status too",
          g56["visa_applying_for"] == ["H-1B"]
          and g56["current_visa_or_greencard_category"] == [], g56)

    g57 = {"visa_applying_for": [], "current_visa_or_greencard_category": ["adjustment-of-status"],
           "primary_consulate": "", "consulates": [], "tags": ["aos-filing", "family-based-immigration"],
           "concerns_or_questions_tags": []}
    p._apply_visa_backfill(g57)
    check("E57 re-derivation: a last-resort code the MODEL already chose gets re-evaluated, not trusted blindly "
          "(found live: the model sometimes picks adjustment-of-status even when a family/employment signal "
          "is also present, bypassing the ordering below since that only runs when both fields start empty)",
          g57["current_visa_or_greencard_category"] == ["family-immigration"], g57)

    g58 = {"visa_applying_for": [], "current_visa_or_greencard_category": ["IR-1"],
           "primary_consulate": "", "consulates": [], "tags": ["aos-filing"],
           "concerns_or_questions_tags": []}
    p._apply_visa_backfill(g58)
    check("E58 never re-derives over a REAL (non-last-resort) code already present, even with an AOS tag alongside",
          g58["current_visa_or_greencard_category"] == ["IR-1"], g58)

    c59 = p.build_canonical("t", "d", {"tags": ["I-485", "aos-filing"]})
    check("E59a build_canonical(): bare I-485/aos-filing tags alone resolve to adjustment-of-status end-to-end",
          c59["current_visa_or_greencard_category"] == ["adjustment-of-status"], c59)
    check("E59b adjustment-of-status is itself a valid 1.2 vocab entry (validate() doesn't reject it as OOV)",
          not any("not in visa vocab" in e for e in p.validate(c59)), str(p.validate(c59)))
    check("E59c validate() passes overall for the bare-AOS case",
          p.validate(c59) == [], str(p.validate(c59)))

    # E60-E62: _apply_visa_backfill()'s is_personal_case gate. Found live: a
    # link-share post with no personal status claim ("For those who think
    # this is the law: a USC's spouse's overstay is forgiven...") still got
    # backfilled to family-immigration, because the model tagged
    # "family-based-immigration" as the ARTICLE's topic, not the poster's
    # own case — which then suppressed "discussion" entirely, since
    # _apply_discussion_backfill() only fires when both visa fields are
    # still empty. Gating the whole backfill on is_personal_case fixes both
    # symptoms at once (same root cause).
    def _visa_backfilled(tags: list[str], is_personal_case) -> dict:
        groups = {"visa_applying_for": [], "current_visa_or_greencard_category": [],
                  "primary_consulate": "", "consulates": [], "tags": tags,
                  "concerns_or_questions_tags": []}
        p._apply_visa_backfill(groups, is_personal_case)
        return groups

    g60 = _visa_backfilled(["family-based-immigration", "news-update"], False)
    check("E60 is_personal_case=False: family-based-immigration tag does NOT get promoted to a personal category",
          g60["current_visa_or_greencard_category"] == [] and g60["visa_applying_for"] == [], g60)

    g61 = _visa_backfilled(["family-based-immigration"], True)
    check("E61 is_personal_case=True (or omitted): the existing fallback behavior is unchanged",
          g61["current_visa_or_greencard_category"] == ["family-immigration"], g61)

    g62 = _visa_backfilled(["h1b-petition"], None)
    check("E62 is_personal_case missing/None: fails open toward the existing (personal) behavior, not toward skipping",
          g62["visa_applying_for"] == ["H-1B"], g62)

    # E63-E65: "blog" — a standalone informational/educational write-up, not
    # the poster's own case and not primarily reactive (that's
    # "discussion"). Same validate() exemption mechanism as news-update/
    # discussion — checked directly here since suggest_tags() only
    # deterministically guarantees "discussion" (the safety net), not
    # "blog" itself (that's model-selected; see F14 for live coverage).
    c63 = p.build_canonical("t", "d", {"tags": ["h1b-lottery", "tips", "blog"]})
    check("E63 validate() accepts a blog-tagged, visa-less posting (same exemption as news-update/discussion)",
          p.validate(c63) == [], str(p.validate(c63)))

    c64 = p.build_canonical("t", "d", {"tags": ["h1b-lottery"], "concerns_or_questions_tags": ["blog"]})
    check("E64 blog exemption also checks concerns_or_questions_tags, not just tags",
          p.validate(c64) == [], str(p.validate(c64)))

    c65 = p.build_canonical("t", "d", {"tags": ["tips"]})
    check("E65 control: no blog/discussion/news-update anywhere, no visa -> validate() still correctly rejects",
          any("visa" in e.lower() or "status" in e.lower() for e in p.validate(c65)), str(p.validate(c65)))

    # E66-E70: I-140 -> employment-based-immigration, the employment-side
    # mirror of I-130 -> family-based-immigration (E13-E16k above). Found
    # while adding this coverage: no such promotion existed for I-140 at
    # all (only the family side was wired up), even though the AOS-ordering
    # comment on _AOS_TAGS already claimed "no I-130/I-140 signal either" as
    # if both were handled symmetrically — a real gap, now fixed by adding
    # _I140_TAGS and mirroring the _I130_TAGS promotion in both
    # suggest_tags() and build_canonical().
    c66 = p.build_canonical("t", "d", {"tags": ["I-140", "I-485", "aos-filing"]})
    check("E66 I-140 -> employment-based-immigration tag added",
          "employment-based-immigration" in c66["tags"], c66["tags"])
    check("E67 category backfilled to the generic fallback (I-140 doesn't imply a SPECIFIC EB code, but now "
          "guarantees a generic one)",
          c66["current_visa_or_greencard_category"] == ["employment-immigration"], c66)

    c68 = p.build_canonical("t", "d", {"tags": ["i140-approval", "employment-based-immigration"]})
    check("E68 no duplicate when employment-based-immigration already present",
          c68["tags"].count("employment-based-immigration") == 1, c68["tags"])

    c69 = p.build_canonical("t", "d", {"tags": ["i140-portability", "aos-filing"]})
    check("E69 i140-portability (the AC21 portability tag, not just filing/approval) also triggers the promotion, "
          "and wins over the more generic adjustment-of-status (mirrors E55's family-side case)",
          c69["current_visa_or_greencard_category"] == ["employment-immigration"], c69)

    # E70: suggest_tags() applies the same tag-add-then-backfill ordering as
    # build_canonical() above (mirrors E16k for the family side) — the
    # promoted tag needs to exist before _apply_visa_backfill runs, not after.
    g_order_emp = {"visa_applying_for": [], "current_visa_or_greencard_category": [],
                   "primary_consulate": "", "consulates": [], "tags": ["I-140"],
                   "concerns_or_questions_tags": []}
    if p._I140_TAGS & set(g_order_emp["tags"]):
        p._add_tag_once(g_order_emp, "employment-based-immigration")
    p._apply_visa_backfill(g_order_emp)
    check("E70 I-140-tag-add-then-backfill ordering resolves to employment-immigration (mirrors suggest_tags()'s "
          "call order)",
          g_order_emp["current_visa_or_greencard_category"] == ["employment-immigration"], g_order_emp)

    # E71-E73: _apply_visa_backfill()'s "trust whichever field already holds
    # a REAL answer" guard, exercised with BOTH fields populated at once —
    # current_visa_or_greencard_category and visa_applying_for are
    # independent concepts (current status vs. what's being applied for),
    # so a real posting can legitimately have one real and one last-resort/
    # premature value, or two last-resort values, simultaneously. Not
    # covered by E57/E58 above, which only ever populate ONE field at a time.
    def _dual_field_backfilled(current: list[str], applying: list[str], tags: list[str]) -> dict:
        groups = {"visa_applying_for": applying, "current_visa_or_greencard_category": current,
                  "primary_consulate": "", "consulates": [], "tags": tags,
                  "concerns_or_questions_tags": []}
        p._apply_visa_backfill(groups)
        return groups

    g71 = _dual_field_backfilled(["adjustment-of-status"], ["H-1B"], ["aos-filing"])
    check("E71 current=last-resort + applying=REAL: the whole function no-ops (a real value in EITHER field is "
          "trusted) — the stale adjustment-of-status is left untouched rather than re-derived, since only ONE "
          "field is ever cleared/re-derived at a time today",
          g71["current_visa_or_greencard_category"] == ["adjustment-of-status"] and g71["visa_applying_for"] == ["H-1B"],
          g71)

    g72 = _dual_field_backfilled(["IR-1"], ["employment-immigration"], ["employment-based-immigration"])
    check("E72 symmetric case: current=REAL + applying=last-resort also no-ops, both fields preserved as-is",
          g72["current_visa_or_greencard_category"] == ["IR-1"] and g72["visa_applying_for"] == ["employment-immigration"],
          g72)

    g73 = _dual_field_backfilled(["family-immigration"], ["adjustment-of-status"],
                                 ["i130-approval", "family-based-immigration", "aos-filing"])
    check("E73 BOTH fields last-resort (neither is real) -> the guard does NOT short-circuit; both are cleared "
          "and re-derived together from tags, landing on the more specific family-immigration signal "
          "(not left as two different stale last-resort codes)",
          g73["current_visa_or_greencard_category"] == ["family-immigration"] and g73["visa_applying_for"] == [],
          g73)

    # E74-E75: blog and discussion together on the same posting — the two
    # aren't mutually exclusive (a shared how-to article can also invite
    # discussion), so validate()'s exemption must accept the combination in
    # either tag bucket, not just each alone (E52/E63 above only test one
    # exemption tag at a time).
    c74 = p.build_canonical("t", "d", {"tags": ["h1b-lottery", "blog", "discussion"]})
    check("E74 blog + discussion together (same bucket) -> validate() still accepts, no visa needed",
          p.validate(c74) == [], str(p.validate(c74)))

    c75 = p.build_canonical("t", "d", {"tags": ["h1b-lottery", "blog"], "concerns_or_questions_tags": ["discussion"]})
    check("E75 blog + discussion split across tags/concerns_or_questions_tags -> validate() still accepts",
          p.validate(c75) == [], str(p.validate(c75)))

    # E76-E84: regression coverage for the i765/ead + adjustment-of-status-AOS
    # tag retirements (features/timeline-notifications-3/timeline-notifications-{ead,485}.md).
    # Positive cases confirm the surviving tag/mapping still works exactly as
    # before; negative cases confirm the retired name is truly gone end-to-end
    # (dropped as out-of-vocab, not just absent from the CSV) and doesn't
    # silently keep triggering old behavior via some other code path.

    # -- EAD/I-765 --
    check("E76 (positive) _MILESTONE_DATE_KEY['opt_application'] renamed to 'ead_filed_date'",
          p._MILESTONE_DATE_KEY.get("opt_application") == "ead_filed_date",
          str(p._MILESTONE_DATE_KEY.get("opt_application")))
    check("E77 (negative) _MILESTONE_DATE_KEY no longer maps anything to the retired 'i765_filed_date'",
          "i765_filed_date" not in p._MILESTONE_DATE_KEY.values(), str(p._MILESTONE_DATE_KEY))

    c78 = p.build_canonical("t", "d", {"tags": ["i765-filing", "i765-approval", "ead-filing"]})
    check("E78 (negative) retired 'i765-filing'/'i765-approval' don't survive build_canonical() (OOV-dropped)",
          "i765-filing" not in c78["tags"] and "i765-approval" not in c78["tags"], str(c78["tags"]))
    check("E79 (positive) 'ead-filing' survives build_canonical() unaffected",
          "ead-filing" in c78["tags"], str(c78["tags"]))

    # -- I-485 / AOS --
    check("E80 (positive) 'AOS' is in _AOS_TAGS (added as the retired duplicate's replacement)",
          "AOS" in p._AOS_TAGS)
    check("E81 (negative) retired 'adjustment-of-status-AOS' is no longer in _AOS_TAGS",
          "adjustment-of-status-AOS" not in p._AOS_TAGS, str(p._AOS_TAGS))

    c82 = p.build_canonical("t", "d", {"tags": ["adjustment-of-status-AOS"]})
    check("E82 (negative) a posting tagged ONLY with the retired string doesn't backfill to "
          "adjustment-of-status anymore (dropped as OOV before _apply_visa_backfill ever sees it)",
          c82["current_visa_or_greencard_category"] == [], str(c82))
    check("E82b (negative) the retired tag itself doesn't survive into the stored tags list either",
          "adjustment-of-status-AOS" not in c82["tags"], str(c82["tags"]))

    c83 = p.build_canonical("t", "d", {"tags": ["AOS"]})
    check("E83 (positive) a posting tagged with the bare 'AOS' abbreviation alone DOES backfill to "
          "adjustment-of-status end-to-end (contrast with E82's negative case)",
          c83["current_visa_or_greencard_category"] == ["adjustment-of-status"], str(c83))

    c84 = p.build_canonical("t", "d", {"tags": ["I-485", "aos-filing"]})
    check("E84 (positive) the pre-existing I-485 + aos-filing combo still backfills correctly, "
          "unaffected by the AOS retirement (regression guard)",
          c84["current_visa_or_greencard_category"] == ["adjustment-of-status"], str(c84))

    # E85-E86: COE retirement (features/timeline-notifications-3/timeline-notifications-coe.md)
    # — the opposite direction from AOS: 'COE' (1.3) retired, 'change-of-employer-COE'
    # (1.10) survives as canonical, per live evidence the abbreviation was
    # never actually selected by the model.
    c85 = p.build_canonical("t", "d", {"tags": ["COE", "change-of-employer-COE"]})
    check("E85 (negative) retired 'COE' doesn't survive build_canonical() (OOV-dropped)",
          "COE" not in c85["tags"], str(c85["tags"]))
    check("E86 (positive) 'change-of-employer-COE' survives build_canonical() unaffected",
          "change-of-employer-COE" in c85["tags"], str(c85["tags"]))


# ---------------------------------------------------------------------------
# F — Gemini tagging EDGE CASES (INTEGRATION, network, may be slightly flaky)
# ---------------------------------------------------------------------------

def group_f_llm() -> None:
    print("\nF — Gemini tagging edge cases (integration)")
    import posting as p

    def allt(out):  # all tag strings across the two free-tag buckets
        return set(out["groups"]["tags"]) | set(out["groups"]["concerns_or_questions_tags"])

    # F1 attorney-to-answer question
    o1 = p.suggest_tags("Need an attorney to answer: H-1B transfer while I-485 pending?",
                        "I'm on H-1B with an I-485 pending. Can an immigration attorney advise whether I can "
                        "transfer my H-1B without disturbing the pending green card? Looking for an attorney to answer.")
    check("F1 attorney question -> open-for-attorney (not lawyer-recommendation)",
          "open-for-attorney" in allt(o1) and "lawyer-recommendation" not in allt(o1), str(sorted(allt(o1))))

    # F2 referral request
    o2 = p.suggest_tags("Recommendations for a good H-1B attorney in the Bay Area?",
                        "Can anyone recommend a reliable immigration attorney or law firm for H-1B work in the SF Bay Area? "
                        "Looking for names and who you had a good experience with.")
    check("F2 referral request -> lawyer-recommendation",
          "lawyer-recommendation" in allt(o2), str(sorted(allt(o2))))

    # F3 consular experience share -> consulate section, NO concerns section
    o3 = p.suggest_tags("B1/B2 interview experience at Mumbai consulate",
                        "Sharing my experience: my B1/B2 visa interview at the Mumbai consulate was smooth, approved on the spot, no 221g. Posting to help others.")
    check("F3 consular experience: 'consulates' in sections, 'concerns_or_questions_tags' not",
          "consulates" in o3["relevant_sections"] and "concerns_or_questions_tags" not in o3["relevant_sections"],
          str(o3["relevant_sections"]))

    # F4 in-US question -> concerns section, NO consulate section
    o4 = p.suggest_tags("Can I work past my H-1B I-94 while extension is pending?",
                        "I'm in the US on H-1B. My employer filed an extension before my I-94 expired but it's still pending. "
                        "Can I keep working under the 240-day rule? Worried about falling out of status.")
    check("F4 in-US question: 'concerns_or_questions_tags' in sections, 'consulates' not",
          "concerns_or_questions_tags" in o4["relevant_sections"] and "consulates" not in o4["relevant_sections"],
          str(o4["relevant_sections"]))

    # F5 visa-abroad with outcome + date -> key_stages + key_dates populated
    o5 = p.suggest_tags("H-1B visa stamping APPROVED at Mumbai on 2026-05-20",
                        "Went for H-1B visa stamping at the Mumbai consulate, interview on 2026-05-20, approved, passport back in 5 days, no 221g.")
    check("F5 outcome -> key_stages_or_info populated", len(o5["key_stages_or_info"]) > 0, str(o5["key_stages_or_info"]))
    check("F6 date -> key_dates populated", len(o5["key_dates"]) > 0, str(o5["key_dates"]))

    # F7 green-card CATEGORY posting -> an EB/family code captured (label = "visa/category").
    # The model is occasionally non-deterministic here; a real user re-previews, so we
    # allow up to 3 attempts before declaring a miss.
    visas: set = set()
    for _ in range(3):
        o7 = p.suggest_tags("EB-2 to EB-3 downgrade for faster priority date?",
                            "I have an approved I-140 in EB-2 (India). Considering an EB-3 downgrade because the EB-3 "
                            "priority date is current. Is the EB-3 downgrade worth it for my green card category?")
        visas = set(o7["groups"]["visa_applying_for"]) | set(o7["groups"]["current_visa_or_greencard_category"])
        if any(x in visas for x in ("EB-2", "EB-3")):
            break
    check("F7 green-card category captured (EB-2/EB-3, <=3 tries)",
          any(x in visas for x in ("EB-2", "EB-3")), str(sorted(visas)))

    # F8-F9: live end-to-end through suggest_tags() (real Gemini call, not
    # the pure _apply_discussion_backfill() helper tested in E47-E52) —
    # confirms is_personal_case classification + the deterministic backfill
    # actually work together on real content, not just the helper in
    # isolation. <=3 tries for the same LLM-non-determinism tolerance F7
    # already uses.
    discussion_ok = False
    o8 = {}
    for _ in range(3):
        o8 = p.suggest_tags(
            "USCIS processing times keep getting worse",
            "Anyone else notice USCIS processing times have ballooned this year across the board? "
            "Feels like every category is backed up. Curious if others are seeing the same trend or "
            "if it varies by service center.")
        both_empty = not o8["groups"]["visa_applying_for"] and not o8["groups"]["current_visa_or_greencard_category"]
        exempt = "discussion" in o8["groups"]["tags"] or "discussion" in o8["groups"]["concerns_or_questions_tags"]
        if both_empty and exempt:
            discussion_ok = True
            break
    check("F8 genuinely generic policy/process content: no visa, discussion exemption applies, publish would succeed (<=3 tries)",
          discussion_ok, o8.get("groups"))

    o9 = p.suggest_tags(
        "Is it too late for my priority date",
        "Is it too late for my priority date to still lock in this year? I have been waiting a while "
        "and got nervous seeing the new visa bulletin.")
    still_blocked = not o9["groups"]["visa_applying_for"] and not o9["groups"]["current_visa_or_greencard_category"]
    not_exempted = ("discussion" not in o9["groups"]["tags"]
                    and "discussion" not in o9["groups"]["concerns_or_questions_tags"])
    check("F9 vague-but-personal content: still correctly requires a visa/status, NOT waved through as discussion",
          still_blocked and not_exempted, o9["groups"])

    # F10-F12: adjustment-of-status live end-to-end, mirroring F7's retry
    # tolerance for the same LLM-non-determinism reasons.
    def _has_category(groups: dict, code: str) -> bool:
        return code in groups["current_visa_or_greencard_category"] or code in groups["visa_applying_for"]

    aos_ok, o10 = False, {}
    for _ in range(3):
        o10 = p.suggest_tags(
            "Filed my I-485 last week",
            "Just filed my I-485 to adjust status. Fingers crossed for a quick approval. Anyone else "
            "currently going through AOS?")
        if _has_category(o10["groups"], "adjustment-of-status"):
            aos_ok = True
            break
    check("F10 I-485/AOS mentioned with no other basis -> adjustment-of-status captured (<=3 tries)",
          aos_ok, o10.get("groups"))

    specific_ok, o11 = False, {}
    for _ in range(3):
        o11 = p.suggest_tags(
            "EB-2 to EB-3 downgrade timing",
            "Filed my I-485 based on my approved I-140 in EB-2. Considering an EB-3 downgrade for faster "
            "priority date. How long did others wait?")
        cats = set(o11["groups"]["visa_applying_for"]) | set(o11["groups"]["current_visa_or_greencard_category"])
        if cats & {"EB-2", "EB-3"} and "adjustment-of-status" not in cats:
            specific_ok = True
            break
    check("F11 AOS + a specific EB basis: the specific code wins, generic adjustment-of-status not used (<=3 tries)",
          specific_ok, o11.get("groups"))

    family_ok, o12 = False, {}
    for _ in range(3):
        o12 = p.suggest_tags(
            "AOS interview experience",
            "Had my AOS interview yesterday based on my approved I-130 (spouse petition). Went smoothly!")
        cats = set(o12["groups"]["visa_applying_for"]) | set(o12["groups"]["current_visa_or_greencard_category"])
        if (cats & {"IR-1", "family-immigration"}) and "adjustment-of-status" not in cats:
            family_ok = True
            break
    check("F12 AOS + I-130 spouse: family signal wins over generic adjustment-of-status, "
          "even when the model picks the generic code on its own first (<=3 tries)",
          family_ok, o12.get("groups"))

    # F13: the real example that surfaced the is_personal_case-gating bug —
    # a link-share post with a one-line reaction, no personal status claim.
    # Must consistently get BOTH news-update and discussion, with no visa
    # category incorrectly backfilled from the article's topic tags.
    link_share_title = "For those who think this is the law"
    link_share_desc = (
        "For those who think this is the law: a USC's spouse's overstay and unauthorized work is "
        "forgiven by law. This is getting more and more insane.\n\n"
        "https://www.nytimes.com/2026/07/28/us/ice-arrests-airports-visa-overstay.html")
    link_share_ok, o13 = False, {}
    for _ in range(3):
        o13 = p.suggest_tags(link_share_title, link_share_desc)
        g = o13["groups"]
        no_visa = not g["visa_applying_for"] and not g["current_visa_or_greencard_category"]
        both = "news-update" in g["tags"] and "discussion" in g["tags"]
        if no_visa and both:
            link_share_ok = True
            break
    check("F13 link-share post: both news-update and discussion applied, no visa incorrectly backfilled (<=3 tries)",
          link_share_ok, o13.get("groups"))

    # F14: the real example that surfaced the "model puts a topic's visa
    # term directly into visa_applying_for despite is_personal_case=False"
    # bug — a general H-1B lottery guide, not the poster's own application.
    guide_title = "A Complete Guide to the H-1B Lottery Timeline"
    guide_desc = (
        "Here is a full breakdown of the H-1B lottery process for anyone new to it: registration "
        "typically opens in March, selection results come a few weeks later, and if selected you then "
        "have roughly 90 days to file the full petition. Employers should prepare LCA filings early "
        "since USCIS wont accept petitions without one. Hope this helps people planning ahead for "
        "next years cycle.")
    guide_ok, o14 = False, {}
    for _ in range(3):
        o14 = p.suggest_tags(guide_title, guide_desc)
        g = o14["groups"]
        no_visa = not g["visa_applying_for"] and not g["current_visa_or_greencard_category"]
        exempted = "discussion" in g["tags"] or "blog" in g["tags"]
        if no_visa and exempted:
            guide_ok = True
            break
    check("F14 general how-to guide: no personal visa claim despite H-1B being discernible in the text, "
          "exempted via discussion and/or blog (<=3 tries)",
          guide_ok, o14.get("groups"))

    # F15: I-140/AOS end-to-end live, the employment-side mirror of F12 —
    # confirms the new I-140 -> employment-based-immigration promotion
    # (E66-E70) actually kicks in through the full suggest_tags() pipeline,
    # not just the isolated helper functions.
    emp_ok, o15 = False, {}
    for _ in range(3):
        o15 = p.suggest_tags(
            "AOS pending after I-140 approval",
            "My I-140 was approved last month and my I-485 to adjust status is now pending. Employer-"
            "sponsored the whole way. No idea on the specific EB category since HR handled that part.")
        cats = set(o15["groups"]["visa_applying_for"]) | set(o15["groups"]["current_visa_or_greencard_category"])
        if ("employment-immigration" in cats or cats & {"EB-1", "EB-1A", "EB-1B", "EB-1C", "EB-2", "EB-3"}) \
                and "adjustment-of-status" not in cats:
            emp_ok = True
            break
    check("F15 I-140 approved + AOS pending, no specific EB stated: an employment signal (specific EB code or "
          "the employment-immigration fallback) wins over the generic adjustment-of-status (<=3 tries)",
          emp_ok, o15.get("groups"))

    # F16-F17: visa-bulletin (backend/tags-cleaned/1.10-common-misc.csv) —
    # a plain misc tag, no special exemption/deterministic logic like
    # news-update/discussion/blog, so this is a live model-selection check
    # (same <=3-try tolerance as F7/F10-F15) rather than a helper-isolation
    # test. Confirms the tag is actually reachable end-to-end, not just
    # present in the CSV.
    bulletin_ok, o16 = False, {}
    for _ in range(3):
        o16 = p.suggest_tags(
            "EB-2 India priority date finally current!",
            "Checked the September Visa Bulletin and my EB-2 India priority date of Jan 2013 is finally "
            "current under the Final Action Date chart. Filing I-485 next week.")
        if "visa-bulletin" in allt(o16):
            bulletin_ok = True
            break
    check("F16 explicit visa-bulletin content -> 'visa-bulletin' tag applied (<=3 tries)",
          bulletin_ok, o16.get("groups"))

    # F17: same concept without the literal phrase "visa bulletin" — a
    # generic priority-date question — to confirm the tag isn't only
    # reachable when the user names the document explicitly.
    bulletin_implicit_ok, o17 = False, {}
    for _ in range(3):
        o17 = p.suggest_tags(
            "When will my priority date be current",
            "My priority date is Dec 2020 for EB-2, wondering how many more months until it becomes "
            "current based on recent bulletin trends.")
        if "visa-bulletin" in allt(o17) or "priority-date-current" in allt(o17):
            bulletin_implicit_ok = True
            break
    check("F17 implicit priority-date-movement question -> visa-bulletin or priority-date-current applied "
          "(<=3 tries)", bulletin_implicit_ok, o17.get("groups"))


# ---------------------------------------------------------------------------
# G — API endpoints + real publish/cleanup (INTEGRATION)
# ---------------------------------------------------------------------------

def _cleanup(case_id: str, gcs_path: str) -> str:
    """Delete the just-published doc from the datastore + GCS sidecars."""
    notes = []
    try:
        from google.cloud import discoveryengine_v1 as de
        from google.api_core.client_options import ClientOptions
        from google.api_core.exceptions import NotFound
        import posting as p
        proj, loc, ds = p._project(), p._ds_location(), p._datastore()
        c = de.DocumentServiceClient(client_options=ClientOptions(quota_project_id=proj))
        name = (f"projects/{proj}/locations/{loc}/collections/default_collection"
                f"/dataStores/{ds}/branches/default_branch/documents/{case_id}")
        try:
            c.delete_document(name=name); notes.append("datastore deleted")
        except NotFound:
            notes.append("datastore not found")
    except Exception as e:  # noqa: BLE001
        notes.append(f"datastore cleanup err: {e}")
    try:
        from google.cloud import storage
        import posting as p
        prefix = gcs_path[len("gs://"):]
        bucket_name, base = prefix.split("/", 1)
        bkt = storage.Client(project=p._project()).bucket(bucket_name)
        for ext in (".md", ".json"):
            bkt.blob(f"{base}{case_id}{ext}").delete()
        notes.append("gcs deleted")
    except Exception as e:  # noqa: BLE001
        notes.append(f"gcs cleanup err: {e}")
    return "; ".join(notes)


def group_g_api() -> None:
    print("\nG — API endpoints + publish/cleanup (integration)")
    # Mark every BQ row this run writes so it's identifiable + purgeable.
    os.environ["POSTING_PIPELINE_RUN_ID"] = "test-e2e"
    import posting as p
    p.purge_test_bq_rows()  # sweep prior runs' markers (date < today; buffer-safe)
    from fastapi.testclient import TestClient
    import api
    api.RATE_LIMIT_MAX = 100000
    # /api/postings now requires a signed-in author (an earlier auth-hardening
    # change). Impersonate a fresh, PROFILE-LESS uid via X-User-Id (dev/test
    # path) — deterministic: it has no visa/status, so a personal post hits the
    # profile gate (422) while a discussion is exempt and publishes.
    api.ALLOW_USER_IMPERSONATION = True
    AUTH = {"X-User-Id": f"new-e2e-{os.urandom(4).hex()}"}

    with TestClient(api.app) as client:
        vocab = client.get("/api/tag-vocab").json()
        check("G1 /api/tag-vocab has consulate_options + all keys",
              all(k in vocab for k in ("visa", "consulate", "consulate_options", "tag", "stage_key", "date_key"))
              and len(vocab["consulate_options"]) > 0, str(list(vocab.keys())))

        sug = client.post("/api/tag-suggest", json={
            "title": "B1/B2 interview in Mumbai",
            "description": "I have my B1/B2 visa interview at the Mumbai consulate next month and want to know what to bring.",
        })
        sj = sug.json()
        check("G2 /api/tag-suggest shape (groups/sections/type/stages/dates)",
              sug.status_code == 200 and all(k in sj for k in
              ("groups", "relevant_sections", "posting_type", "key_stages_or_info", "key_dates")),
              f"status={sug.status_code}")

        # A personal-case post from a profile-less author is gated (422).
        noviza = client.post("/api/postings", headers=AUTH, json={
            "title": "[E2E] no visa case",
            "description": "Deliberately omits any visa/status to exercise the required-visa validation path.",
            "tags": {"tags": ["general-inquiry"]},
        })
        check("G3 profile-less personal post -> 422", noviza.status_code == 422,
              f"status={noviza.status_code} detail={noviza.json().get('detail','')[:60]}")

        # A discussion is exempt from BOTH the author-profile gate and the
        # content visa-required rule (validate()'s _NO_PERSONAL_STATUS_TAGS), so
        # it publishes end to end even from a profile-less author.
        pub = client.post("/api/postings", headers=AUTH, json={
            "title": "[E2E] How premium processing works",
            "description": "A general explainer on premium processing across form types — not my own case.",
            "tags": {"tags": ["discussion"]},
        })
        pj = pub.json()
        ok_pub = pub.status_code == 200 and pj.get("case_id", "").startswith("app-")
        check("G4 discussion post (exempt) -> 200 + app case_id", ok_pub,
              f"status={pub.status_code} case_id={pj.get('case_id')} detail={pj.get('detail','')}")

        if ok_pub:
            cid = pj["case_id"]
            detail = client.get(f"/api/postings/{cid}").json()
            check("G5 published discussion retrievable from datastore",
                  detail.get("title", "").startswith("[E2E]") and detail.get("channel") == "app",
                  f"title={detail.get('title')}")
            check("G5b published doc carries the discussion tag",
                  "discussion" in (detail.get("tags", []) or []), str(detail.get("tags")))
            notes = _cleanup(cid, pj["gcs_path"])
            check("G6 cleanup of E2E test doc", "deleted" in notes, notes)


def group_h_immihelp() -> None:
    print("\nH — publish_immihelp_posting() (integration, docs/ingestion/IMMIHELP-SEED-PLAN.md)")
    import posting as p

    try:
        result = p.publish_immihelp_posting(
            title="[E2E] H-1B approved after RFE",
            description=(
                "Filed H-1B extension in January, got an RFE on specialty occupation in "
                "February, responded with expert letter, approved in April 2026. "
                "Contact me at throwaway@example.com if you have questions."
            ),
            source_item_id="e2e-test-999999",
            full_url="https://www.immihelp.com/experiences/post/e2e-test-999999/",
            posting_date="2026-04-10",
        )
    except Exception as e:  # noqa: BLE001
        check("H1 publish_immihelp_posting() succeeds for a taggable sample", False, f"{type(e).__name__}: {e}")
        return
    check("H1 publish_immihelp_posting() succeeds for a taggable sample", True, str(result))

    cid = result["case_id"]
    check("H2 case_id carries the immihelp channel prefix (delete_content() convention)",
          cid.startswith("immihelp-"), cid)

    detail = None
    try:
        from google.cloud import discoveryengine_v1 as de
        from google.api_core.client_options import ClientOptions
        proj, loc, ds = p._project(), p._ds_location(), p._datastore()
        c = de.DocumentServiceClient(client_options=ClientOptions(quota_project_id=proj))
        name = (f"projects/{proj}/locations/{loc}/collections/default_collection"
                f"/dataStores/{ds}/branches/default_branch/documents/{cid}")
        doc = c.get_document(name=name)
        detail = json.loads(type(doc).to_json(doc)).get("structData", {})
    except Exception as e:  # noqa: BLE001
        check("H3 published doc retrievable from datastore with correct provenance", False, f"{type(e).__name__}: {e}")
    if detail is not None:
        check("H3 published doc retrievable from datastore with correct provenance",
              detail.get("channel") == "immihelp" and detail.get("source_system") == "immihelp"
              and detail.get("ingestion_method") == "automated_scrape" and detail.get("posting_date") == "2026-04-10",
              {k: detail.get(k) for k in ("channel", "source_system", "ingestion_method", "posting_date")})
        check("H4 content_type='forum_posting' means news-update was never applied",
              "news-update" not in (detail.get("tags") or []), detail.get("tags"))
        check("H5 scrub_pii() ran — the pasted email never made it into the stored text",
              "throwaway@example.com" not in json.dumps(detail), "checked structData for the raw email")
        check("H6 no real author identity carried through (synthetic handle, not empty/None)",
              bool(detail.get("author_handle")) and detail.get("author_handle") != "e2e-test-999999",
              detail.get("author_handle"))

    notes = _cleanup(cid, result["gcs_path"])
    check("H7 cleanup of E2E immihelp test doc", "deleted" in notes, notes)


def main() -> int:
    if not PROJECT:
        print("GCP_PROJECT_ID must be set")
        return 2
    only = sys.argv[1] if len(sys.argv) > 1 else "all"
    print(f"Posting/tagging tests — project={PROJECT}  (scope={only})")

    group_a_vocab()
    group_b_clean()
    group_c_sections()
    group_d_validate()
    group_e_build()
    if only in ("all", "llm"):
        group_f_llm()
    if only in ("all", "api"):
        group_g_api()
    if only in ("all", "api", "immihelp"):
        group_h_immihelp()

    print("\n" + "=" * 60)
    passed = sum(1 for _, ok, _ in _results if ok)
    failed = [n for n, ok, _ in _results if not ok]
    print(f"SUMMARY: {passed}/{len(_results)} checks passed")
    if failed:
        print("FAILED: " + "; ".join(failed))
        return 1
    print("All posting/tagging checks passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
