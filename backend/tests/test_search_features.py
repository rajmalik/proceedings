"""
test_search_features.py — Phase B + precision features (search mode, chat
routing, generic facet extraction, strictness, posting detail, pagination).

Complements tests/test_grounding_e2e.py. Mixes fast deterministic UNIT checks
(facet extraction, filter/boost builders, heuristic intent — no GCP) with live
INTEGRATION checks through FastAPI's TestClient.

Run:  .venv/bin/python tests/test_search_features.py
"""

import os
import sys

from dotenv import load_dotenv

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
load_dotenv()

PROJECT = os.getenv("GCP_PROJECT_ID") or os.getenv("GCP_PROJECT", "")
LOCATION = os.getenv("GCP_VERTEX_DATASTORE_LOCATION", "global")
ENGINE = os.getenv("GCP_VERTEX_SEARCH_APP_ID", "imm-postings-search-app")
KNOWN_CASE_ID = "reddit-2026-04-11-USVisas-1socshn"  # the Australia B1/B2 post
# The exact posting from the changes-2-.md item 3 bug report — its title is
# literally "POE - Boston"; used to verify the relevance-sort fix surfaces it
# near the top of a free-text search instead of being buried by recency sort.
KNOWN_POE_BOSTON_CASE_ID = "app-2026-07-29-890d259a"

_results: list[tuple[str, bool, str]] = []


def check(name: str, passed: bool, detail: str = "") -> None:
    _results.append((name, passed, detail))
    print(f"  [{'PASS' if passed else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))


# ---------------------------------------------------------------------------
# F — Generic facet extraction (UNIT, deterministic, no GCP)
# ---------------------------------------------------------------------------

def group_f_extraction() -> None:
    print("\nF — Generic facet extraction (unit)")
    import search_client as s

    codes = lambda q: s.applied_codes(s.extract_filters(q))  # noqa: E731

    f1 = codes("approved B1/B2 in Mumbai")
    check("F1 multi-facet: consulate+visa+outcome",
          f1.get("consulate") == ["BOM"] and set(f1.get("visa", [])) == {"B-1", "B-2"}
          and f1.get("outcome") == ["approved"], str(f1))

    f2 = codes("my bombay interview")
    check("F2 consulate alias bombay -> BOM", f2.get("consulate") == ["BOM"], str(f2))

    f3 = codes("EB-2 green card consular processing")
    check("F3 green-card category + topical tag",
          f3.get("category") == ["EB-2"] and "consular-processing" in f3.get("tag", []), str(f3))

    f4 = codes("hello how is the weather today")
    check("F4 no facets for an off-topic sentence", f4 == {}, str(f4))

    f5 = codes("F-1 student visa denied in Hyderabad")
    check("F5 visa + outcome + consulate across fields",
          f5.get("visa") == ["F-1"] and f5.get("consulate") == ["HYD"]
          and f5.get("outcome") == ["denied"], str(f5))

    # features/ui-changes-1/changes-2-.md item 3: "H1B RFE POE Boston" under
    # strict precision returned many unrelated postings because RFE (outcome
    # min_len was 5, RFE is 3 chars) and POE (abbreviations/1.3 was never
    # registered as a facet at all) were both silently dropped.
    f6 = codes("H1B RFE POE Boston")
    check("F6 RFE now matches (outcome min_len 5->3, exact-code match unchanged)",
          "RFE" in f6.get("outcome", []), str(f6))
    check("F7 POE now matches via new 'abbreviation' facet (1.3-abbreviations.csv)",
          "POE" in f6.get("abbreviation", []), str(f6))

    # Follow-up bug found by live user verification: "Port-of-entry Boston"
    # and "POE Boston" did NOT extract the same facet — the abbreviation
    # facet only indexed the code column (row[0]), never the CSV's own
    # "Full Name"/alternate_tag columns (row[1]/row[2]), so the spelled-out
    # phrase extracted zero facets. That silently made strict precision fall
    # through to balanced (search_with_strictness's `if strictness ==
    # "strict" and facets:` is False when facets == {}) without ever
    # setting `relaxed`, so the two spellings behaved completely differently
    # under strict — not just a slightly different result count.
    f8 = codes("Port-of-entry Boston")
    f9 = codes("port of entry Boston")
    f10 = codes("POE Boston")
    check("F8 hyphenated full name 'Port-of-entry' resolves to the POE code",
          f8.get("abbreviation") == ["POE"], str(f8))
    check("F9 spaced-out full name 'port of entry' resolves to the POE code",
          f9.get("abbreviation") == ["POE"], str(f9))
    check("F10 all three spellings extract the identical facet dict",
          f8 == f9 == f10, f"f8={f8} f9={f9} f10={f10}")


# ---------------------------------------------------------------------------
# G — Filter / boost builders + heuristic intent (UNIT)
# ---------------------------------------------------------------------------

def group_g_builders() -> None:
    print("\nG — Filter/boost builders + heuristic intent (unit)")
    import search_client as s

    facets = s.extract_filters("approved B1/B2 in Mumbai")
    expr = s._filter_expr_from_facets(facets)
    check("G1 filter expr ANDs facets + ORs fields/values",
          " AND " in expr and 'consulates: ANY("BOM")' in expr
          and 'visa_applying_for: ANY("B-1")' in expr
          and 'key_stages_or_info.outcome_status: ANY("approved")' in expr, expr[:120])

    boost = s._boost_from_facets(facets)
    check("G2 boost spec built from facets", boost is not None and len(boost.condition_boost_specs) == 3,
          f"conditions={len(boost.condition_boost_specs) if boost else 0}")

    check("G3 empty facets -> empty filter / no boost",
          s._filter_expr_from_facets({}) == "" and s._boost_from_facets({}) is None)

    import query
    check("G4 heuristic intent: 'show me ...' -> search",
          query._heuristic_intent("show me B1/B2 experiences in Delhi") == "search")
    check("G5 heuristic intent: 'what is ...' -> ask",
          query._heuristic_intent("what is the H-1B grace period") == "ask")


# ---------------------------------------------------------------------------
# H — /api/search endpoint (INTEGRATION)
# ---------------------------------------------------------------------------

def group_h_search_endpoint() -> None:
    print("\nH — /api/search endpoint (integration)")
    from fastapi.testclient import TestClient
    import api

    with TestClient(api.app) as client:
        api._db = None

        r = client.get("/api/search", params={"q": "B1/B2 interview", "consulate": "BOM"}).json()
        check("H1 explicit consulate=BOM -> only BOM postings",
              len(r["results"]) >= 1 and all("BOM" in c["consulates"] for c in r["results"]),
              f'{len(r["results"])} results')

        p1 = client.get("/api/search", params={"q": "visa experience", "page_size": 3, "strictness": "broad"}).json()
        ids1 = [c["case_id"] for c in p1["results"]]
        check("H2a page 1 returns a next_page_token", bool(p1["next_page_token"]), f"{len(ids1)} results")
        if p1["next_page_token"]:
            p2 = client.get("/api/search", params={"q": "visa experience", "page_size": 3,
                                                   "strictness": "broad", "page_token": p1["next_page_token"]}).json()
            ids2 = [c["case_id"] for c in p2["results"]]
            check("H2b page 2 is disjoint from page 1", set(ids1).isdisjoint(ids2), f"p2={ids2}")

        strict = client.get("/api/search", params={"q": "B1/B2 in Mumbai", "strictness": "strict"}).json()
        broad = client.get("/api/search", params={"q": "B1/B2 in Mumbai", "strictness": "broad"}).json()
        check("H3 strict total <= broad total", 1 <= strict["total"] <= broad["total"],
              f'strict={strict["total"]} broad={broad["total"]}')

        # features/ui-changes-1/changes-2-.md item 3, second half: forcing
        # posting_date-desc on every free-text query buried a
        # strongly-matching-but-older posting under unrelated recent ones.
        # Default sort is now relevance for free-text queries; this exact
        # posting (title literally "POE - Boston") should rank near the top
        # for a query naming its own content, not wherever recency put it.
        poe = client.get("/api/search", params={"q": "H1B RFE POE Boston", "strictness": "broad"}).json()
        top_ids = [c["case_id"] for c in poe["results"][:5]]
        check("H4 relevance-sorted free-text search ranks the matching posting in the top 5",
              KNOWN_POE_BOSTON_CASE_ID in top_ids, f"top5={top_ids}")

        # Live-verification follow-up: before the abbreviation Full Name fix,
        # "Port-of-entry Boston" extracted zero facets, which made
        # search_with_strictness silently fall through to balanced under
        # strictness="strict" (effective_strictness would read "balanced",
        # not "strict") — a much bigger discrepancy than a raw count
        # difference. The two spellings must now both genuinely run strict.
        phrase = client.get("/api/search", params={"q": "Port-of-entry Boston", "strictness": "strict"}).json()
        abbrev = client.get("/api/search", params={"q": "POE Boston", "strictness": "strict"}).json()
        check("H5 spelled-out phrase under strict precision actually runs strict (not silently balanced)",
              phrase.get("effective_strictness") == "strict" and phrase.get("relaxed") is False,
              f'effective={phrase.get("effective_strictness")} relaxed={phrase.get("relaxed")}')
        check("H6 both POE spellings run the same strict code path, matching posting present in both",
              abbrev.get("effective_strictness") == "strict"
              and KNOWN_POE_BOSTON_CASE_ID in {c["case_id"] for c in phrase["results"]}
              and KNOWN_POE_BOSTON_CASE_ID in {c["case_id"] for c in abbrev["results"]},
              f'phrase_total={phrase.get("total")} abbrev_total={abbrev.get("total")}')


# ---------------------------------------------------------------------------
# I — /api/postings/{id} detail (INTEGRATION)
# ---------------------------------------------------------------------------

def group_i_posting_detail() -> None:
    print("\nI — /api/postings/{id} detail (integration)")
    from fastapi.testclient import TestClient
    import api

    with TestClient(api.app) as client:
        r = client.get(f"/api/postings/{KNOWN_CASE_ID}")
        ok = r.status_code == 200
        body = r.json() if ok else {}
        check("I1 known posting returns 200 with body + title",
              ok and len(body.get("body", "")) > 100 and bool(body.get("title")),
              f'status={r.status_code} body_chars={len(body.get("body", ""))}')
        check("I1b detail carries facets (visa/consulate)",
              bool(body.get("visa")) or bool(body.get("consulates")),
              f'visa={body.get("visa")} consulates={body.get("consulates")}')

        r404 = client.get("/api/postings/does-not-exist-xyz")
        check("I2 missing posting returns 404", r404.status_code == 404, f"status={r404.status_code}")


# ---------------------------------------------------------------------------
# J — /api/chat strictness + relax fallback (INTEGRATION)
# ---------------------------------------------------------------------------

def group_j_chat_strictness() -> None:
    print("\nJ — /api/chat strictness + relax (integration)")
    from fastapi.testclient import TestClient
    import api

    with TestClient(api.app) as client:
        api._db = None

        strict = client.post("/api/chat", json={"question": "Show me B1/B2 experiences in Mumbai",
                                                "strictness": "strict"}).json()
        broad = client.post("/api/chat", json={"question": "Show me B1/B2 experiences in Mumbai",
                                               "strictness": "broad"}).json()
        check("J1 strict search returns fewer cards than broad",
              strict["mode"] == "search" and broad["mode"] == "search"
              and len(strict["results"]) <= len(broad["results"]),
              f'strict={len(strict["results"])} broad={len(broad["results"])}')
        check("J2 strict applies extracted facets (consulate=BOM)",
              "BOM" in strict.get("applied_filters", {}).get("consulate", []),
              str(strict.get("applied_filters")))

        # H-1B has no Mumbai posting -> strict finds nothing -> relaxes to balanced.
        relaxed = client.post("/api/chat", json={"question": "Show me H-1B experiences in Mumbai",
                                                "strictness": "strict"}).json()
        check("J3 over-narrow strict relaxes (relaxed flag set)",
              relaxed.get("relaxed") is True and relaxed.get("effective_strictness") == "balanced",
              f'relaxed={relaxed.get("relaxed")} eff={relaxed.get("effective_strictness")}')


def group_k_context_filters() -> None:
    print("\nK — Context-aware dynamic filters (hierarchy + live counts)")
    import search_client as s

    groups = s.suggested_filters("I am on H-1B applying for extension with a question on RFE",
                                 PROJECT, LOCATION, ENGINE)
    by_key = {g["key"]: g for g in groups}
    check("K1 returns facet groups (concern/outcome/...)", len(groups) >= 2, str(list(by_key)))
    concern = by_key.get("concern", {}).get("values", [])
    check("K2 H-1B concerns are hierarchy-related (h1b-*) and counted",
          any(v["code"].startswith("h1b-") for v in concern) and all("count" in v for v in concern),
          str([v["code"] for v in concern[:4]]))

    from fastapi.testclient import TestClient
    import api
    with TestClient(api.app) as client:
        api._db = None
        base = client.get("/api/search", params={"q": "H-1B experiences", "strictness": "broad"}).json()
        sel = client.get("/api/search", params={"q": "H-1B experiences", "strictness": "broad",
                                                "facet": "concerns_or_questions_tags:h1b-rfe"}).json()
        check("K3 selecting a facet chip narrows results exactly",
              0 < sel["total"] < base["total"], f'base={base["total"]} selected={sel["total"]}')
        chat = client.post("/api/chat", json={"question": "Show me H-1B experiences", "strictness": "broad",
                                              "facets": ["concerns_or_questions_tags:h1b-rfe"]}).json()
        check("K4 /api/chat honors selected facets",
              chat["mode"] == "search" and 0 < len(chat["results"]) <= sel["total"],
              f'cards={len(chat["results"])}')


# ---------------------------------------------------------------------------
# L — News-update tag survival + 7-day gov-news recency filter (changes-2-.md
#     items 1 & 5). Mixes a deterministic UNIT check (no GCP) with live
#     INTEGRATION checks against the real datastore.
# ---------------------------------------------------------------------------

def group_l_news_filtering() -> None:
    print("\nL — news-update tag survival + 7-day gov-news filter")
    import search_client as s

    # L1 (unit, no GCP): "news-update" must survive into the card even when a
    # different array wins the tags fallback chain (concerns_or_questions_tags
    # here) and even when the raw tags array is at/over the 8-item cap.
    meta = {
        "post_title": "Synthetic gov-news doc",
        "concerns_or_questions_tags": ["a-different-array-won"],
        "tags": ["t1", "t2", "t3", "t4", "t5", "t6", "t7", "news-update"],
    }
    card = s._card_from_struct("synthetic-case-id", meta)
    check("L1 news-update survives into card.tags despite a different fallback array winning",
          "news-update" in card["tags"], str(card["tags"]))

    meta_no_news = {"post_title": "x", "tags": ["a", "b"]}
    card_no_news = s._card_from_struct("synthetic-case-id-2", meta_no_news)
    check("L2 no false positive: news-update NOT injected when absent from raw tags",
          "news-update" not in card_no_news["tags"], str(card_no_news["tags"]))

    # L1b/L2b: Phase D's Discussions tab filters on `tags: ANY("discussion")`/
    # `tags: ANY("blog")` (the raw structData field) — so the same
    # fallback-array-wins gap that could've silently hidden news-update
    # would silently hide the Discussion/Blog pill on a matched card too.
    meta_disc = {
        "post_title": "Synthetic discussion doc",
        "concerns_or_questions_tags": ["a-different-array-won"],
        "tags": ["t1", "t2", "t3", "t4", "t5", "t6", "t7", "discussion"],
    }
    card_disc = s._card_from_struct("synthetic-case-id-3", meta_disc)
    check("L1b discussion survives into card.tags despite a different fallback array winning",
          "discussion" in card_disc["tags"], str(card_disc["tags"]))

    meta_blog = {
        "post_title": "Synthetic blog doc",
        "concerns_or_questions_tags": ["a-different-array-won"],
        "tags": ["t1", "t2", "t3", "t4", "t5", "t6", "t7", "blog"],
    }
    card_blog = s._card_from_struct("synthetic-case-id-4", meta_blog)
    check("L2b blog survives into card.tags despite a different fallback array winning",
          "blog" in card_blog["tags"], str(card_blog["tags"]))

    # L1c: all three guaranteed tags at once — news-update, discussion, and
    # blog aren't mutually exclusive (a link-share reacting to news can also
    # invite discussion; see Phase B), so a doc could legitimately carry all
    # three in its raw "tags" while a DIFFERENT array still wins the
    # fallback chain. Each must survive independently — the loop shouldn't
    # clobber an earlier guaranteed tag while re-injecting a later one.
    meta_triple = {
        "post_title": "Synthetic triple-tag doc",
        "concerns_or_questions_tags": ["a-different-array-won"],
        "tags": ["news-update", "discussion", "blog", "t1"],
    }
    card_triple = s._card_from_struct("synthetic-case-id-5", meta_triple)
    check("L1c news-update, discussion, AND blog all survive together, none clobbering the others",
          {"news-update", "discussion", "blog"} <= set(card_triple["tags"]), str(card_triple["tags"]))

    # L1d: no duplicate re-injection when the guaranteed tag is already
    # present in whichever array won the fallback chain (as opposed to
    # L1/L1b/L2b, where a DIFFERENT array won and didn't have it at all).
    meta_already_won = {
        "post_title": "Synthetic already-present doc",
        "concerns_or_questions_tags": ["discussion", "other"],
        "tags": ["discussion", "random"],
    }
    card_already_won = s._card_from_struct("synthetic-case-id-6", meta_already_won)
    check("L1d discussion not duplicated when the winning array already contains it",
          card_already_won["tags"].count("discussion") == 1, str(card_already_won["tags"]))

    # L1e: the guaranteed tags survive the 8-item cap even when the winning
    # array is already AT the cap on its own (8 unrelated items) — the
    # prepend-not-append ordering (search_client.py) means the cap always
    # trims from the END, never dropping a just-injected guaranteed tag.
    meta_at_cap = {
        "post_title": "Synthetic at-cap doc",
        "concerns_or_questions_tags": [f"c{i}" for i in range(8)],
        "tags": ["discussion", "blog"] + [f"c{i}" for i in range(8)],
    }
    card_at_cap = s._card_from_struct("synthetic-case-id-7", meta_at_cap)
    check("L1e discussion AND blog both survive the 8-item cap even when the winning array was already full",
          "discussion" in card_at_cap["tags"] and "blog" in card_at_cap["tags"]
          and len(card_at_cap["tags"]) == 8,
          str(card_at_cap["tags"]))

    # L1f: the exact live bug this coverage pass found (case_id
    # app-2026-08-01-38046506) — concerns_or_questions_tags is EMPTY, so the
    # raw "tags" array itself wins the fallback chain unmodified (no
    # "different array won"), but it has 20+ items and "discussion"/
    # "news-update" sit past index 8. The ORIGINAL guarantee check
    # (`guaranteed not in tags`) saw them as "already present" and did
    # nothing, so the cap silently cut both — a real Discussions-tab match
    # whose card carried neither pill. Must check survival past the cap
    # (`not in tags[:8]`), not mere membership.
    meta_buried = {
        "post_title": "Synthetic buried-past-cap doc",
        "concerns_or_questions_tags": [],
        "tags": ["a", "b", "c", "d", "e", "f", "g", "h", "discussion", "news-update", "i", "j"],
    }
    card_buried = s._card_from_struct("synthetic-case-id-8", meta_buried)
    check("L1f discussion AND news-update both survive even when they're buried past index 8 in the SAME "
          "array that won the fallback chain (not a different, losing array)",
          "discussion" in card_buried["tags"] and "news-update" in card_buried["tags"]
          and len(card_buried["tags"]) == 8,
          str(card_buried["tags"]))

    # L3/L4 (integration): a broad free-text query that surfaces gov_news
    # content should only include gov_news items within the last 7 days
    # (by posting_date, i.e. event/source date) — older gov_news should be
    # excluded from ordinary keyword search entirely.
    from fastapi.testclient import TestClient
    import api
    from datetime import datetime, timedelta, timezone

    cutoff = (datetime.now(timezone.utc) - timedelta(days=7)).strftime("%Y-%m-%d")
    with TestClient(api.app) as client:
        api._db = None
        r = client.get("/api/search", params={"q": "USCIS policy update", "strictness": "broad",
                                               "page_size": 50}).json()
        gov_news_results = [c for c in r["results"] if c["channel"] == "gov_news"]
        stale = [c["case_id"] for c in gov_news_results if c["date"] and c["date"] <= cutoff]
        check("L3 free-text search excludes gov_news older than 7 days",
              not stale, f"stale={stale}")
        check("L4 gov_news results (if any) that DO appear carry the news-update tag",
              all("news-update" in c["tags"] for c in gov_news_results),
              str([(c["case_id"], c["tags"]) for c in gov_news_results if "news-update" not in c["tags"]]))

        # News tab's own path (explicit doc_kind:gov_news facet chip) must stay
        # unaffected by the 7-day carve-out — it's a different branch (hard
        # filter, not free-text) specifically so old news stays reachable there.
        news_tab = client.get("/api/search", params={"q": "", "facet": "doc_kind:gov_news",
                                                      "page_size": 50}).json()
        news_tab_old = [c for c in news_tab["results"] if c["date"] and c["date"] <= cutoff]
        check("L5 News tab's explicit facet path still returns old gov_news (unaffected by the carve-out)",
              len(news_tab_old) > 0, f"{len(news_tab_old)} old items via News tab path")

        # L6/L7 (integration): Phase D's Discussions tab — two facet chips on
        # the SAME field ("tags") OR together server-side (_facets_filter),
        # exactly like doc_kind:gov_news powers the News tab above, just on a
        # different field. Every result must carry discussion and/or blog in
        # its displayed tags — the L1b/L2b fix guarantees this survives
        # whichever fallback array wins.
        discussions_tab = client.get("/api/search", params={"q": "", "page_size": 50,
                                                             "facet": ["tags:discussion", "tags:blog"]}).json()
        check("L6 Discussions tab (tags:discussion OR tags:blog) returns results",
              len(discussions_tab["results"]) > 0, f"{len(discussions_tab['results'])} results")
        check("L7 every Discussions tab result carries discussion and/or blog in its tags",
              all("discussion" in c["tags"] or "blog" in c["tags"] for c in discussions_tab["results"]),
              str([(c["case_id"], c["tags"]) for c in discussions_tab["results"]
                   if "discussion" not in c["tags"] and "blog" not in c["tags"]]))


# ---------------------------------------------------------------------------
# M — Query-derived tags (changes-2-.md item 4)
# ---------------------------------------------------------------------------

def group_m_query_tags() -> None:
    print("\nM — query-derived tags (posting.suggest_query_tags)")
    import posting

    # The model is occasionally non-deterministic on a short 4-word fragment
    # (unlike a real posting's full title+description); allow up to 3
    # attempts before declaring a miss — same tolerance test_posting_tagging.py's
    # F7 already applies to Gemini-based tagging checks.
    tags: list = []
    codes: set = set()
    for _ in range(3):
        tags = posting.suggest_query_tags("H1B RFE POE Boston")
        codes = {t["code"] for t in tags}
        if codes & {"RFE", "POE"}:
            break
    check("M1 suggest_query_tags surfaces RFE and/or POE from the query text (<=3 tries)",
          bool(codes & {"RFE", "POE"}), str(tags))
    check("M2 every returned tag has the {field, code, label} shape",
          all({"field", "code", "label"} <= set(t) for t in tags), str(tags))

    check("M3 empty query returns no tags (no wasted Gemini call)",
          posting.suggest_query_tags("") == [] and posting.suggest_query_tags("   ") == [])

    from fastapi.testclient import TestClient
    import api
    with TestClient(api.app) as client:
        r = client.post("/api/search/query-tags", json={"q": "H1B RFE POE Boston"})
        check("M4 /api/search/query-tags returns 200 with a tags list",
              r.status_code == 200 and isinstance(r.json().get("tags"), list),
              f"status={r.status_code}")


# ---------------------------------------------------------------------------
# N — Advanced Search's News/Cutoff controls (include_news, max_age_days)
# ---------------------------------------------------------------------------

def group_n_advanced_search_recency_news() -> None:
    print("\nN — Advanced Search's News/Cutoff controls (include_news, max_age_days)")
    import api as api_module
    from datetime import datetime, timedelta, timezone

    # N1 (unit, no GCP): the composition helper itself — the source of
    # truth for exactly what clause each control combination produces.
    check("N1a defaults (None, 0) produce no clause",
          api_module._recency_news_clause(None, 0) == "")
    check("N1b include_news=False alone excludes gov_news",
          api_module._recency_news_clause(False, 0) == '(NOT doc_kind: ANY("gov_news"))')
    check("N1c include_news=True alone still produces no clause (nothing to restrict)",
          api_module._recency_news_clause(True, 0) == "")
    cutoff90 = (datetime.now(timezone.utc) - timedelta(days=90)).strftime("%Y-%m-%d")
    check("N1d max_age_days alone adds a posting_date clause",
          api_module._recency_news_clause(None, 90) == f'posting_date > "{cutoff90}"')
    check("N1e both together AND them",
          api_module._recency_news_clause(False, 90) ==
          f'(NOT doc_kind: ANY("gov_news")) AND posting_date > "{cutoff90}"')

    from fastapi.testclient import TestClient
    with TestClient(api_module.app) as client:
        api_module._db = None

        # N2/N3 (integration, hard-filter branch — Advanced Search's tag
        # search): "asylum" is carried by both app postings and gov_news
        # articles, so it's a good real-world case for the exclude toggle.
        tagged = client.get("/api/search", params={"facet": "tags:asylum", "page_size": 50}).json()
        check("N2 baseline: tags:asylum returns both app and gov_news channels",
              {"app", "gov_news"} <= {c["channel"] for c in tagged["results"]},
              str({c["channel"] for c in tagged["results"]}))

        excl = client.get("/api/search", params={"facet": "tags:asylum", "include_news": "false",
                                                  "page_size": 50}).json()
        check("N3 include_news=false drops every gov_news result from the same tag filter",
              excl["total"] < tagged["total"] and all(c["channel"] != "gov_news" for c in excl["results"]),
              f"total {tagged['total']} -> {excl['total']}")

        # N4: max_age_days restricts to the window, on the same tag filter —
        # a general recency window, not a news-only one.
        cutoff30 = (datetime.now(timezone.utc) - timedelta(days=30)).strftime("%Y-%m-%d")
        aged = client.get("/api/search", params={"facet": "tags:asylum", "max_age_days": 30,
                                                  "page_size": 50}).json()
        check("N4 max_age_days=30 restricts every result to within the last 30 days",
              aged["total"] > 0 and all(c["date"] >= cutoff30 for c in aged["results"] if c["date"]),
              str([(c["case_id"], c["date"]) for c in aged["results"] if c["date"] and c["date"] < cutoff30]))

        # N5/N6 (integration, free-text branch): the explicit include_news
        # control REPLACES the legacy 7-day-old-news carve-out entirely —
        # but ONLY for a caller that opts in; Home never sends these params
        # at all, so its behavior must stay byte-for-byte unchanged.
        legacy = client.get("/api/search", params={"q": "USCIS policy update",
                                                    "strictness": "broad", "page_size": 50}).json()
        opened = client.get("/api/search", params={"q": "USCIS policy update", "strictness": "broad",
                                                    "include_news": "true", "page_size": 50}).json()
        legacy_gov_news = sum(1 for c in legacy["results"] if c["channel"] == "gov_news")
        opened_gov_news = sum(1 for c in opened["results"] if c["channel"] == "gov_news")
        check("N5 include_news=true on a free-text search surfaces at least as much gov_news as the "
              "legacy 7-day default (it removes a restriction, never adds one)",
              opened_gov_news >= legacy_gov_news,
              f"legacy gov_news={legacy_gov_news}, opened gov_news={opened_gov_news}")

        cutoff7 = (datetime.now(timezone.utc) - timedelta(days=7)).strftime("%Y-%m-%d")
        stale = [c["case_id"] for c in legacy["results"]
                 if c["channel"] == "gov_news" and c["date"] and c["date"] <= cutoff7]
        check("N6 omitting include_news/max_age_days entirely still excludes gov_news older than 7 days "
              "— Home's search is unaffected by this feature",
              not stale, f"stale={stale}")

        # N7 (integration, browse branch): an otherwise-empty Advanced
        # Search click with include_news=true should surface gov_news in
        # the plain browse feed too, not just tag/text searches.
        browse_default = client.get("/api/search", params={"page_size": 5}).json()
        browse_opened = client.get("/api/search", params={"include_news": "true", "page_size": 5}).json()
        check("N7 include_news=true on an otherwise-empty search widens the browse feed's total",
              browse_opened["total"] > browse_default["total"],
              f"{browse_default['total']} -> {browse_opened['total']}")

        # N8 (integration, hard-filter branch): both controls combined on
        # the same request — include_news=false AND max_age_days together,
        # not just each in isolation (N3/N4 test them separately).
        combo = client.get("/api/search", params={"facet": "tags:asylum", "include_news": "false",
                                                   "max_age_days": 365, "page_size": 50}).json()
        cutoff365 = (datetime.now(timezone.utc) - timedelta(days=365)).strftime("%Y-%m-%d")
        check("N8 include_news=false + max_age_days=365 together: no gov_news AND every result within "
              "the window",
              combo["total"] > 0
              and all(c["channel"] != "gov_news" for c in combo["results"])
              and all(c["date"] >= cutoff365 for c in combo["results"] if c["date"]),
              str([(c["case_id"], c["channel"], c["date"]) for c in combo["results"]
                   if c["channel"] == "gov_news" or (c["date"] and c["date"] < cutoff365)]))

        # N9 (integration, browse branch, negative direction): an
        # otherwise-empty search with include_news=FALSE explicitly must
        # match the legacy default exactly (browse already excludes news by
        # default — explicitly asking to exclude it changes nothing).
        browse_excluded = client.get("/api/search", params={"include_news": "false", "page_size": 5}).json()
        check("N9 include_news=false on an otherwise-empty search matches the legacy default total "
              "(browse already excludes news)",
              browse_excluded["total"] == browse_default["total"],
              f"default={browse_default['total']}, explicit-false={browse_excluded['total']}")

        # N10 (integration, free-text branch, negative direction):
        # include_news=false excludes gov_news entirely, even articles from
        # today — a stronger restriction than the legacy 7-day carve-out,
        # which would still let very recent news through.
        text_excluded = client.get("/api/search", params={"q": "USCIS policy update", "strictness": "broad",
                                                           "include_news": "false", "page_size": 50}).json()
        check("N10 include_news=false on a free-text search excludes gov_news entirely, including "
              "articles from within the last 7 days",
              all(c["channel"] != "gov_news" for c in text_excluded["results"]),
              str([c["case_id"] for c in text_excluded["results"] if c["channel"] == "gov_news"]))

        # N11 (integration, monotonicity): a wider cutoff window can only
        # return as many or more results than a narrower one, same filter.
        narrow = client.get("/api/search", params={"facet": "tags:asylum", "max_age_days": 7,
                                                    "page_size": 50}).json()
        wide = client.get("/api/search", params={"facet": "tags:asylum", "max_age_days": 3650,
                                                  "page_size": 50}).json()
        check("N11 a wider max_age_days window returns at least as many results as a narrower one",
              wide["total"] >= narrow["total"], f"7d={narrow['total']}, 3650d={wide['total']}")

        # N12 (negative, HTTP-level): max_age_days=0 passed explicitly is
        # identical to omitting it entirely — 0 is the "no restriction"
        # sentinel, not a 0-day (impossible) window.
        explicit_zero = client.get("/api/search", params={"facet": "tags:asylum", "max_age_days": 0,
                                                           "page_size": 50}).json()
        check("N12 max_age_days=0 explicitly is identical to omitting it",
              explicit_zero["total"] == tagged["total"],
              f"omitted={tagged['total']}, explicit-zero={explicit_zero['total']}")

        # N13 (negative, HTTP-level): a negative max_age_days doesn't crash
        # and doesn't restrict anything (treated the same as 0/omitted, per
        # _recency_news_clause's `> 0` guard) — a malformed/adversarial
        # value must degrade safely, not 500 or silently return zero results.
        negative_age = client.get("/api/search", params={"facet": "tags:asylum", "max_age_days": -5,
                                                          "page_size": 50})
        check("N13 a negative max_age_days doesn't error and doesn't restrict results",
              negative_age.status_code == 200 and negative_age.json()["total"] == tagged["total"],
              f"status={negative_age.status_code}, total={negative_age.json().get('total')}")

        # N14 (negative, HTTP-level): a non-boolean include_news value is
        # rejected with a clean 422 (FastAPI's own bool coercion), not a 500
        # — confirms the endpoint signature's type stays enforced.
        bad_bool = client.get("/api/search", params={"facet": "tags:asylum", "include_news": "not-a-bool",
                                                      "page_size": 5})
        check("N14 a non-boolean include_news value is rejected with 422, not a server error",
              bad_bool.status_code == 422, f"status={bad_bool.status_code}")

        # N15 (integration, pagination): max_age_days must keep restricting
        # page 2, not just the first page — a caller paginating through
        # Advanced Search results shouldn't see the window silently widen.
        page1 = client.get("/api/search", params={"facet": "tags:asylum", "max_age_days": 365,
                                                   "page_size": 2}).json()
        if page1.get("next_page_token"):
            page2 = client.get("/api/search", params={"facet": "tags:asylum", "max_age_days": 365,
                                                       "page_size": 2,
                                                       "page_token": page1["next_page_token"]}).json()
            check("N15 max_age_days still restricts page 2 of a paginated tag search",
                  all(c["date"] >= cutoff365 for c in page2["results"] if c["date"]),
                  str([(c["case_id"], c["date"]) for c in page2["results"]
                       if c["date"] and c["date"] < cutoff365]))
        else:
            check("N15 max_age_days still restricts page 2 of a paginated tag search", True,
                  "skipped — only one page of results at this cutoff")


def main() -> int:
    if not PROJECT:
        print("GCP_PROJECT_ID must be set")
        return 2
    # This suite makes many TestClient calls from one IP; lift the API rate limit.
    import api
    api.RATE_LIMIT_MAX = 100000
    print(f"Search-feature tests — project={PROJECT}, engine={ENGINE}")
    group_f_extraction()
    group_g_builders()
    group_h_search_endpoint()
    group_i_posting_detail()
    group_j_chat_strictness()
    group_k_context_filters()
    group_l_news_filtering()
    group_m_query_tags()
    group_n_advanced_search_recency_news()

    print("\n" + "=" * 60)
    passed = sum(1 for _, ok, _ in _results if ok)
    failed = [n for n, ok, _ in _results if not ok]
    print(f"SUMMARY: {passed}/{len(_results)} checks passed")
    if failed:
        print("FAILED: " + "; ".join(failed))
        return 1
    print("All search-feature checks passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
