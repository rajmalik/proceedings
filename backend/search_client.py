"""
search_client.py — Vertex AI Search (Discovery Engine) grounded-answer client
=============================================================================
Replaces the self-managed Vertex AI Vector Search retrieval path with the
managed Discovery Engine **Search + Answer API** over `imm-postings-datastore`
(engine `imm-postings-search-app`).

WHY THIS EXISTS:
The prototype grounded answers on a self-managed Vector Search index that held
only crawled gov/law-firm content (zero Reddit) — so Reddit postings never
surfaced. The 81 Reddit docs (and future app/web posts) live in the Discovery
Engine datastore. This module grounds on that datastore via the managed Answer
API, returning a grounded answer + citations.

Decision basis: D-016 (single managed Vertex AI Search sink), D-034 (BFF uses
the Search/Answer API), D-039 (3-tier grounding). See docs/app/
FINAL-ARCHITECTURE.md.

The returned dict matches the existing `query()` contract exactly so api.py and
both clients are unchanged:
  {
    "answer": str,
    "chunks": [{"chunk_id": str, "text": str, "source": str, "labels": list, "score": float}],
    "is_fallback": bool,
  }
"""

import csv
import os
import re
import time

from google.api_core.client_options import ClientOptions
from google.api_core.exceptions import DeadlineExceeded, InternalServerError, ServiceUnavailable
from google.cloud import discoveryengine_v1 as de
from google.cloud import storage

# Transient gRPC/network errors worth a quick retry (e.g. stale channel after idle).
_RETRYABLE = (ServiceUnavailable, DeadlineExceeded, InternalServerError)


def _retry(fn, attempts: int = 3, base_delay: float = 0.5):
    """Call fn(), retrying transient GCP errors with exponential backoff."""
    last = None
    for i in range(attempts):
        try:
            return fn()
        except _RETRYABLE as e:  # noqa: PERF203
            last = e
            if i < attempts - 1:
                time.sleep(base_delay * (2 ** i))
    raise last

# Fallback message when the datastore yields no grounded answer. Self-service
# product (not a firm intake): nudge the user to rephrase / browse, never imply
# legal advice or a firm to contact.
FALLBACK_MESSAGE = (
    "I couldn't find a grounded answer to that in our sources. Try rephrasing your "
    "question, or browse related community postings."
)

# Precedence boost (D-039): rank app posts above reddit above the rest. Disabled
# by default until the `channel` facet + app-channel posts exist in the datastore
# (the current corpus is all reddit, so the boost is a no-op / could error if the
# field is unregistered). Enable with VERTEX_SEARCH_BOOST=1 once app posts land.
_BOOST_ENABLED = os.getenv("VERTEX_SEARCH_BOOST", "0") == "1"


def _serving_config(project_id: str, location: str, engine_id: str) -> str:
    return (
        f"projects/{project_id}/locations/{location}"
        f"/collections/default_collection/engines/{engine_id}"
        f"/servingConfigs/default_search"
    )


def _client(project_id: str, location: str) -> de.ConversationalSearchServiceClient:
    # ADC needs an explicit quota project for discoveryengine.googleapis.com.
    opts = ClientOptions(quota_project_id=project_id)
    if location != "global":
        opts = ClientOptions(
            api_endpoint=f"{location}-discoveryengine.googleapis.com",
            quota_project_id=project_id,
        )
    return de.ConversationalSearchServiceClient(client_options=opts)


def _boost_spec():
    if not _BOOST_ENABLED:
        return None
    Cond = de.SearchRequest.BoostSpec.ConditionBoostSpec
    return de.SearchRequest.BoostSpec(
        condition_boost_specs=[
            Cond(condition='channel: ANY("app")', boost=0.5),
            Cond(condition='channel: ANY("reddit")', boost=0.3),
        ]
    )


def _to_native(v):
    """Recursively coerce proto-plus MapComposite/RepeatedComposite to dict/list."""
    if hasattr(v, "items"):  # MapComposite / dict-like
        return {k: _to_native(x) for k, x in v.items()}
    if not isinstance(v, (str, bytes)) and hasattr(v, "__iter__"):  # RepeatedComposite / list
        return [_to_native(x) for x in v]
    return v


def _struct_to_dict(struct_data) -> dict:
    """Coerce a proto Struct (struct_data) into a plain python dict of native types,
    recursing into nested maps/lists (e.g. key_stages_or_info)."""
    if not struct_data:
        return {}
    try:
        return {k: _to_native(v) for k, v in dict(struct_data).items()}
    except Exception:
        return {}


def _labels_from(meta: dict) -> list[str]:
    for key in ("tags", "concerns_or_questions_tags", "derived_topic_cluster"):
        val = meta.get(key)
        if isinstance(val, list) and val:
            return [str(v) for v in val]
    return []


def _reference_to_chunk(ref) -> dict | None:
    """Map one Answer.Reference (any of the 3 sub-types) into the chunk shape."""
    # Structured sidecar docs (our datastore mode) carry struct_data + title/uri.
    sdi = ref.structured_document_info
    if sdi and sdi.document:
        meta = _struct_to_dict(sdi.struct_data)
        case_id = sdi.document.split("/")[-1]
        uri = str(meta.get("full_url") or meta.get("source_uri") or sdi.uri or "")
        # Prefer a human-readable case_id over an internal gs:// path for display.
        source = uri if uri and not uri.startswith("gs://") else case_id
        return {
            "chunk_id": case_id,
            "text": str(meta.get("post_title") or meta.get("background_summary") or sdi.title or "")[:500],
            "source": source,
            "labels": _labels_from(meta),
            "score": 0.0,  # structured refs carry no relevance score
            "as_of": str(meta.get("posting_date") or ""),
            "channel": str(meta.get("channel") or ""),
        }
    # Chunked content (advanced/website mode).
    ci = ref.chunk_info
    if ci and (ci.content or ci.chunk):
        dm = ci.document_metadata
        meta = _struct_to_dict(getattr(dm, "struct_data", {})) if dm else {}
        return {
            "chunk_id": (getattr(dm, "document", "") or ci.chunk or "").split("/")[-1],
            "text": str(ci.content or "")[:500],
            "source": str(getattr(dm, "uri", "") or getattr(dm, "title", "") or meta.get("post_title", "")),
            "labels": _labels_from(meta),
            "score": float(ci.relevance_score or 0.0),
            "as_of": str(meta.get("posting_date") or ""),
            "channel": str(meta.get("channel") or ""),
        }
    # Unstructured docs.
    udi = ref.unstructured_document_info
    if udi and udi.document:
        meta = _struct_to_dict(udi.struct_data)
        text = ""
        if udi.chunk_contents:
            text = " ".join(c.content for c in udi.chunk_contents if c.content)[:500]
        return {
            "chunk_id": udi.document.split("/")[-1],
            "text": text or str(udi.title or "")[:500],
            "source": str(udi.uri or udi.title or udi.document.split("/")[-1]),
            "labels": _labels_from(meta),
            "score": 0.0,
            "as_of": str(meta.get("posting_date") or ""),
            "channel": str(meta.get("channel") or ""),
        }
    return None


def answer_query(question: str, project_id: str, location: str, engine_id: str,
                 max_results: int = 5, filter_expr: str = "") -> dict:
    """
    Ground `question` against the Discovery Engine datastore via the Answer API.

    `filter_expr`, when given, is a Discovery Engine filter applied to retrieval
    (e.g. 'doc_kind: ANY("gov_news","official_reference")'). Filter only on
    indexed/filterable fields such as `doc_kind` — never `channel` (unregistered
    facet → 400). Empty string (default) preserves the pre-existing unfiltered
    behavior for /api/ask and /api/chat.

    Returns the same dict shape as query() in query.py.
    """
    fallback = {"answer": FALLBACK_MESSAGE, "chunks": [], "is_fallback": True}

    client = _client(project_id, location)

    search_params = de.AnswerQueryRequest.SearchSpec.SearchParams(max_return_results=max_results)
    boost = _boost_spec()
    if boost is not None:
        search_params.boost_spec = boost
    if filter_expr:
        search_params.filter = filter_expr

    request = de.AnswerQueryRequest(
        serving_config=_serving_config(project_id, location, engine_id),
        query=de.Query(text=question),
        search_spec=de.AnswerQueryRequest.SearchSpec(search_params=search_params),
        answer_generation_spec=de.AnswerQueryRequest.AnswerGenerationSpec(
            include_citations=True,
            # Do NOT let the API skip queries via its adversarial / non-answer-
            # seeking / low-relevance classifiers: they are non-deterministic and
            # intermittently drop legitimate questions (e.g. imperative phrasings
            # like "Tell me about ...") to 0 references. We ground purely on
            # whether the datastore returned references (see below).
            ignore_adversarial_query=False,
            ignore_non_answer_seeking_query=False,
            ignore_low_relevant_content=False,
        ),
        grounding_spec=de.AnswerQueryRequest.GroundingSpec(include_grounding_supports=True),
    )

    response = _retry(lambda: client.answer_query(request))
    answer = response.answer

    answer_text = (answer.answer_text or "").strip()
    succeeded = answer.state == de.Answer.State.SUCCEEDED

    # The Answer API emits one reference per grounding support, so the same doc
    # recurs — dedupe by chunk_id (keep first), then cap to max_results.
    chunks = []
    seen = set()
    for ref in answer.references:
        mapped = _reference_to_chunk(ref)
        if mapped and mapped["chunk_id"] not in seen:
            seen.add(mapped["chunk_id"])
            chunks.append(mapped)
        if len(chunks) >= max_results:
            break

    # Grounded iff the datastore actually returned citable references. No
    # references (off-topic, or nothing relevant) => fallback. This is the
    # deterministic grounding signal, replacing the flaky skip-reason check.
    if not succeeded or not answer_text or not chunks:
        return fallback

    return {
        "answer": answer_text,
        "chunks": chunks,
        "is_fallback": False,
    }


# ---------------------------------------------------------------------------
# Search mode — ranked posting cards (the ":search" method, not ":answer")
# ---------------------------------------------------------------------------

def _search_client(project_id: str, location: str) -> de.SearchServiceClient:
    opts = ClientOptions(quota_project_id=project_id)
    if location != "global":
        opts = ClientOptions(
            api_endpoint=f"{location}-discoveryengine.googleapis.com",
            quota_project_id=project_id,
        )
    return de.SearchServiceClient(client_options=opts)


def _as_list(val) -> list[str]:
    if val is None:
        return []
    if isinstance(val, str):
        return [val] if val else []
    try:
        return [str(v) for v in val if v not in (None, "")]
    except TypeError:
        return [str(val)]


def _card_from_struct(case_id: str, meta: dict) -> dict:
    """Build a result-card dict from a posting's structData."""
    stages = meta.get("key_stages_or_info") or {}
    if not isinstance(stages, dict):
        stages = {}
    visa = _as_list(meta.get("visa_applying_for")) or _as_list(meta.get("current_visa_or_greencard_category"))
    consulates = _as_list(meta.get("consulates")) or _as_list(meta.get("primary_consulate"))
    tags = (
        _as_list(meta.get("concerns_or_questions_tags"))
        or _as_list(meta.get("tags"))
        or _as_list(meta.get("derived_topic_cluster"))
    )
    # "news-update"/"discussion"/"blog" must always survive into the card's
    # (capped) tags, regardless of which source array won the fallback chain
    # above (posting.py deterministically guarantees "discussion" — and the
    # model may pick "blog" — in the raw "tags" field, but
    # concerns_or_questions_tags could still win the chain instead) or of
    # the 8-item cap below silently dropping them.
    #
    # Checking mere membership (`guaranteed not in tags`) isn't enough —
    # found live: a real posting with 20 raw tags, no concerns_or_questions_tags
    # (so raw "tags" itself wins the chain unmodified), had "discussion"/
    # "news-update" sitting at positions 10/11 — well past the 8-item cap
    # applied below. `guaranteed not in tags` was True->False (already
    # "present"), so nothing moved them forward, and the cap silently cut
    # both. Must check `not in tags[:8]` (will it survive the cap as-is?),
    # not just `not in tags` (does it exist anywhere?) — and remove any
    # existing occurrence before prepending so it isn't duplicated.
    for guaranteed in ("news-update", "discussion", "blog"):
        if guaranteed in _as_list(meta.get("tags")) and guaranteed not in tags[:8]:
            tags = [guaranteed] + [t for t in tags if t != guaranteed]
    return {
        "case_id": case_id,
        "title": str(meta.get("post_title") or "").strip() or case_id,
        "description": str(meta.get("background_summary") or meta.get("concerns_or_questions_summary") or "")[:400],
        "visa": visa,
        "consulates": consulates,
        "outcome": str(meta.get("outcome_status") or stages.get("outcome_status") or ""),
        "subreddit": str(meta.get("subreddit") or meta.get("source_container") or ""),
        # `channel` is present in every doc's struct_data, but — verified
        # live — the Discovery Engine schema has it registered as a bare
        # {"type": "string"} (not `retrievable`), so Search API result
        # snippets omit it entirely (get_posting()'s single-document fetch
        # isn't affected — that returns full struct_data regardless).
        # Fallback to deriving it from case_id's leading segment, which is
        # always accurate by construction — same convention
        # delete_content() already relies on. Fixes blank "Source" labels
        # on every list-view card (Search *and* News tabs), not just
        # gov-news — this was a pre-existing gap, not one introduced here.
        "channel": str(meta.get("channel") or "").strip() or case_id.split("-", 1)[0],
        "tags": tags[:8],
        "url": str(meta.get("full_url") or meta.get("source_uri") or ""),
        "date": str(meta.get("posting_date") or ""),
        # Full ingestion timestamp — when WE processed it, not when the
        # content was originally published. Kept for any existing caller
        # still relying on it; `event_timestamp` below is what the News tab
        # (and anything else caring about "when did this actually happen")
        # should display/sort by instead — see search_postings()'s
        # _SORT_FIELDS docstring for why these routinely diverge for
        # backend-ingested (gov-news/immihelp/reddit) content.
        "timestamp": str(meta.get("ingestion_timestamp") or meta.get("posting_date") or ""),
        # The original event date — when the content was actually posted/
        # published at its source, per posting_date (day-granularity; no
        # source in this pipeline currently captures original time-of-day
        # more precisely than that). Never ingestion_timestamp.
        "event_timestamp": str(meta.get("posting_date") or ""),
        # First-party/source author identity — a synthetic per-item handle for
        # app postings, or a fixed per-source handle (e.g. "USCIS") for
        # gov-news content (GOV-NEWS-INGESTION-PLAN.md §3.6). Single point of
        # truth here so both search-result cards and the detail view
        # (get_posting(), which builds on this) carry it consistently.
        "author_handle": str(meta.get("author_handle") or "").strip(),
    }


# --- Generic NL -> tagged-facet extraction (applies to ANY tag, not just consulate) --
#
# The strictness mechanism (filter / boost / semantic) is field-agnostic. This
# registry is the SINGLE place facets are enumerated: each entry maps a controlled
# tag vocabulary (tags-cleaned/*.csv) to the datastore field(s) it filters. Adding
# coverage for a new tag = adding one entry here — nothing else changes.

# Informal names not in the official consulate vocabulary's City column.
_CONSULATE_ALIASES = {"delhi": "DEL", "bombay": "BOM", "madras": "MAA", "calcutta": "CCU"}

_FACET_SPECS = [
    # key, label, datastore field(s) it filters, vocab CSV, match kind, boost, min_len
    {"key": "consulate", "label": "Consulate", "fields": ["consulates"],
     "csv": "1.4-consulates.csv", "kind": "name", "boost": 0.5, "min_len": 4},
    {"key": "visa", "label": "Visa",
     "fields": ["visa_applying_for", "current_visa_or_greencard_category"],
     "csv": "1.1-non-immigration-visas.csv", "kind": "code", "boost": 0.4, "min_len": 2},
    {"key": "category", "label": "Category",
     "fields": ["current_visa_or_greencard_category", "visa_applying_for"],
     "csv": "1.2-greencard-categories.csv", "kind": "code", "boost": 0.4, "min_len": 3},
    # min_len lowered from 5 to 3: matching is exact-code (not substring), so a
    # 3-char token still has to equal a real 1.9 code ("RFE", etc.) — this only
    # stops rejecting short-but-valid codes before the exact-match check runs.
    # Also now checked against tags/concerns_or_questions_tags, not just
    # key_stages_or_info.outcome_status — _master_tags_block() feeds 1.9 into
    # the same tags/concerns_or_questions_tags union the model tags from, so an
    # outcome code can land in either place.
    {"key": "outcome", "label": "Outcome",
     "fields": ["key_stages_or_info.outcome_status", "tags", "concerns_or_questions_tags"],
     "csv": "1.9-outcomes.csv", "kind": "code", "boost": 0.3, "min_len": 3},
    # New: abbreviations (POE, RFE, NVC, ...) were never registered as a facet
    # at all, so terms like "POE" were silently dropped from every strictness
    # level's filter/boost. Same fields as "tag" below — _master_tags_block()
    # feeds 1.3 into the same tags/concerns_or_questions_tags union.
    {"key": "abbreviation", "label": "Term",
     "fields": ["tags", "concerns_or_questions_tags"],
     "csv": "1.3-abbreviations.csv", "kind": "code", "boost": 0.3, "min_len": 3},
    {"key": "tag", "label": "Tag",
     "fields": ["tags", "concerns_or_questions_tags", "derived_topic_cluster"],
     "csv": "1.10-common-misc.csv", "kind": "tag", "boost": 0.2, "min_len": 6},
]

_REGISTRY: list | None = None


def _csv_path(name: str) -> str:
    return os.path.join(os.path.dirname(__file__), "tags-cleaned", name)


def _code_variants(code: str) -> set:
    low = code.strip().lower()
    # Includes a space->hyphen variant (not just hyphen->space) so a spaced-out
    # full name like "Port of Entry" also matches hyphenated query text like
    # "port-of-entry" — see _facet_registry()'s abbreviation Full Name indexing.
    return {v for v in {low, low.replace("-", ""), low.replace("-", " "), low.replace(" ", "-")} if v}


def _facet_registry() -> list:
    """Lazy-build the facet registry: each entry has terms {variant -> code}."""
    global _REGISTRY
    if _REGISTRY is not None:
        return _REGISTRY
    reg = []
    for spec in _FACET_SPECS:
        terms: dict[str, str] = {}
        try:
            with open(_csv_path(spec["csv"]), newline="", encoding="utf-8") as f:
                reader = csv.reader(f)
                next(reader, None)  # header
                for row in reader:
                    if not row or not row[0].strip():
                        continue
                    code = row[0].strip()
                    if spec["kind"] == "name":  # consulates: tag,Type,Country,City
                        country = row[2].strip() if len(row) > 2 else ""
                        city = row[3].strip() if len(row) > 3 else ""
                        if city:
                            terms[city.lower()] = code
                        elif country and (len(row) > 1 and row[1].strip() == "country"):
                            terms[country.lower()] = code
                    elif spec["kind"] == "code":
                        for v in _code_variants(code):
                            terms[v] = code
                        # Abbreviations (1.3-abbreviations.csv: tag,alternate_tag,
                        # Full Name,Description) carry a human-readable Full Name
                        # and sometimes an alternate_tag — index those too so a
                        # query using the spelled-out phrase ("Port of Entry")
                        # matches the same code as the abbreviation itself
                        # ("POE"). setdefault: never let an alias shadow a
                        # primary code's own term.
                        if spec["key"] == "abbreviation":
                            for extra in (row[1] if len(row) > 1 else "", row[2] if len(row) > 2 else ""):
                                extra = extra.strip()
                                if extra:
                                    for v in _code_variants(extra):
                                        terms.setdefault(v, code)
                    elif spec["kind"] == "tag":  # only multi-segment tags (avoid common-word FPs)
                        if "-" in code:
                            terms[code.lower()] = code
                            terms[code.lower().replace("-", " ")] = code
        except Exception as e:  # noqa: BLE001
            print(f"facet vocab load failed for {spec['csv']}: {e}")
        if spec["key"] == "consulate":
            terms.update(_CONSULATE_ALIASES)
        reg.append({**spec, "terms": terms})
    _REGISTRY = reg
    return reg


def extract_filters(query: str) -> dict:
    """Map a natural-language query to tagged facet values across ALL registered
    facets. Returns a rich dict: { key: {label, fields, codes[], boost} }."""
    q = query.lower()
    facets: dict = {}
    for spec in _facet_registry():
        found: list[str] = []
        for term in sorted(spec["terms"], key=len, reverse=True):  # specific (longer) first
            if len(term) < spec["min_len"]:
                continue
            if re.search(r"\b" + re.escape(term) + r"\b", q):
                code = spec["terms"][term]
                if code not in found:
                    found.append(code)
        if found:
            facets[spec["key"]] = {
                "label": spec["label"], "fields": spec["fields"],
                "codes": found, "boost": spec["boost"],
            }
    return facets


def applied_codes(facets: dict) -> dict:
    """Flatten the rich facet dict to { key: [codes] } for API/UI."""
    return {k: v["codes"] for k, v in facets.items()}


def _facet_condition(facet: dict) -> str:
    """OR across the facet's fields x codes — e.g. (visa_applying_for: ANY("B-1") OR ...)."""
    ors = [f'{field}: ANY("{code}")' for field in facet["fields"] for code in facet["codes"]]
    return "(" + " OR ".join(ors) + ")" if ors else ""


def _filter_expr_from_facets(facets: dict) -> str:
    """AND across facet keys (each key is an OR of its fields x codes)."""
    clauses = [c for c in (_facet_condition(f) for f in facets.values()) if c]
    return " AND ".join(clauses)


def _boost_from_facets(facets: dict):
    Cond = de.SearchRequest.BoostSpec.ConditionBoostSpec
    specs = [Cond(condition=_facet_condition(f), boost=f["boost"])
             for f in facets.values() if _facet_condition(f)]
    return de.SearchRequest.BoostSpec(condition_boost_specs=specs) if specs else None


# Discovery Engine field each `sort` value orders by — both are registered
# identically in the live schema (retrievable+indexable, type "datetime";
# confirmed live via SchemaService.GetSchema), so either sorts correctly.
# "event" (posting_date, the source's own original publish date) is now the
# default everywhere — ingestion can lag days behind a source's actual
# publish date, so "most recent" should mean recent-at-the-source, not
# recent-in-our-pipeline. "recent" (ingestion_timestamp) remains available
# for any caller that specifically wants ingestion order. "relevance" (no
# order_by at all — Discovery Engine's own text-relevance ranking governs)
# is a third option: forcing posting_date-desc on every free-text query
# used to bury a strongly-matching-but-older posting under unrelated recent
# ones within the same facet-filtered set — see search_with_strictness().
_SORT_FIELDS = {"recent": "ingestion_timestamp", "event": "posting_date"}


def search_postings(
    query: str,
    project_id: str,
    location: str,
    engine_id: str,
    page_size: int = 10,
    page_token: str = "",
    filter_expr: str = "",
    boost=None,
    sort: str = "event",
) -> dict:
    """
    Ranked posting search (Google-results style) via the Discovery Engine
    :search method. Returns result cards (no synthesized answer).

      { "results": [ {card}, ... ], "next_page_token": str, "total": int }
    """
    client = _search_client(project_id, location)
    serving_config = _serving_config(project_id, location, engine_id)

    request_kwargs = dict(
        serving_config=serving_config,
        query=query,
        page_size=page_size,
        page_token=page_token or "",
        filter=filter_expr or "",
        content_search_spec=de.SearchRequest.ContentSearchSpec(
            snippet_spec=de.SearchRequest.ContentSearchSpec.SnippetSpec(return_snippet=True),
        ),
    )
    if sort != "relevance":
        # Most-recent-first by whichever timestamp `sort` selects (see
        # _SORT_FIELDS) — always descending, so the freshest content leads.
        # sort="relevance" omits this entirely, letting Discovery Engine's own
        # text-relevance ranking govern order instead.
        order_field = _SORT_FIELDS.get(sort, _SORT_FIELDS["recent"])
        request_kwargs["order_by"] = f"{order_field} desc"
    request = de.SearchRequest(**request_kwargs)
    if boost is not None:
        request.boost_spec = boost
    elif _BOOST_ENABLED:
        request.boost_spec = _boost_spec()

    response = _retry(lambda: client.search(request))
    results = []
    for r in response.results:
        meta = _struct_to_dict(r.document.struct_data)
        results.append(_card_from_struct(r.document.id, meta))

    return {
        "results": results,
        "next_page_token": response.next_page_token or "",
        "total": int(getattr(response, "total_size", 0) or 0),
    }


def search_with_strictness(
    query: str,
    project_id: str,
    location: str,
    engine_id: str,
    page_size: int = 10,
    page_token: str = "",
    strictness: str = "balanced",
    extra_filter: str = "",
    sort: str = "event",
) -> dict:
    """
    Search with a user-chosen precision level:
      - 'strict'   : hard filter on every extracted facet (exact matches only;
                     relaxes to 'balanced' if that yields nothing).
      - 'balanced' : boost matching facets (relevant ones rank first, others kept).
      - 'broad'    : pure semantic search (no facet constraints).
    `extra_filter` (explicitly selected facet chips) is ALWAYS applied as a hard
    filter regardless of strictness. `sort` — see search_postings()'s
    _SORT_FIELDS — passes straight through. Adds `applied_filters`, `relaxed`,
    `effective_strictness`.
    """
    facets = extract_filters(query)

    def _and(*exprs) -> str:
        return " AND ".join(e for e in exprs if e)

    def _wrap(data, eff, relaxed):
        data["applied_filters"] = applied_codes(facets)
        data["effective_strictness"] = eff
        data["relaxed"] = relaxed
        return data

    if strictness == "strict" and facets:
        data = search_postings(query, project_id, location, engine_id, page_size, page_token,
                               filter_expr=_and(_filter_expr_from_facets(facets), extra_filter), sort=sort)
        if not data["results"] and not page_token:
            # No exact matches — fall back to a boosted (balanced) search (keeping
            # any explicitly-selected facets as a hard filter).
            data = search_postings(query, project_id, location, engine_id, page_size, "",
                                   filter_expr=extra_filter, boost=_boost_from_facets(facets), sort=sort)
            return _wrap(data, "balanced", True)
        return _wrap(data, "strict", False)

    if strictness == "broad":
        data = search_postings(query, project_id, location, engine_id, page_size, page_token,
                               filter_expr=extra_filter, sort=sort)
        return _wrap(data, "broad", False)

    # balanced (default)
    data = search_postings(query, project_id, location, engine_id, page_size, page_token,
                           filter_expr=extra_filter, boost=_boost_from_facets(facets), sort=sort)
    return _wrap(data, "balanced", False)


# Tag categories surfaced on the posting-detail page, in display order. Each is
# a distinct facet group; the card's `visa`/`consulates`/`tags` collapse them.
_TAG_SECTION_FIELDS = [
    ("Current status", "current_visa_or_greencard_category"),
    ("Applying for", "visa_applying_for"),
    ("Consulates", "consulates"),
    ("Concerns & questions", "concerns_or_questions_tags"),
    ("Topics", "tags"),
    ("Related topics", "derived_topic_cluster"),
]


def _tag_sections_from_meta(meta: dict) -> list[dict]:
    """Distinct, labeled tag groups for the detail view: non-empty groups only,
    de-duplicated within each group, display order preserved. Kept separate from
    the card's collapsed `tags`/`visa`/`consulates` fields."""
    sections: list[dict] = []
    for label, field in _TAG_SECTION_FIELDS:
        vals = _as_list(meta.get(field))
        if field == "consulates":
            primary = str(meta.get("primary_consulate") or "").strip()
            if primary and primary not in vals:
                vals = [primary, *vals]
        seen: set[str] = set()
        uniq = [v for v in vals if v and not (v in seen or seen.add(v))]
        if uniq:
            sections.append({"label": label, "tags": uniq})
    return sections


def get_posting(case_id: str, project_id: str, location: str, datastore_id: str) -> dict | None:
    """
    Fetch one posting's full detail: structData card fields + the Markdown body
    (read from the GCS sidecar referenced by the document's content URI).
    Returns None if the document does not exist.
    """
    from google.api_core.exceptions import NotFound

    doc_client = de.DocumentServiceClient(client_options=ClientOptions(quota_project_id=project_id))
    name = (
        f"projects/{project_id}/locations/{location}/collections/default_collection"
        f"/dataStores/{datastore_id}/branches/default_branch/documents/{case_id}"
    )
    try:
        doc = doc_client.get_document(name=name)
    except NotFound:
        return None

    meta = _struct_to_dict(doc.struct_data)
    card = _card_from_struct(case_id, meta)  # author_handle already included
    card["tag_sections"] = _tag_sections_from_meta(meta)

    # Body lives in the GCS sidecar (.md), referenced by content.uri / gcs_path.
    body = ""
    gcs_uri = doc.content.uri or meta.get("gcs_path") or ""
    if gcs_uri.startswith("gs://"):
        try:
            bucket_name, blob_path = gcs_uri[len("gs://"):].split("/", 1)
            blob = storage.Client(project=project_id).bucket(bucket_name).blob(blob_path)
            body = blob.download_as_text()
        except Exception as e:  # noqa: BLE001 - best-effort body fetch
            print(f"get_posting: could not read body from {gcs_uri}: {e}")

    card["body"] = body
    return card


# ---------------------------------------------------------------------------
# Postings by author handle (first-party authorship)
#
# `author_handle` is NOT a filterable datastore field, so we can't query it via
# search. Instead we enumerate the branch's documents once and build a
# handle → [cards] index, cached briefly (the datastore is small — ~hundreds of
# docs, sub-2s to list). This powers the public "author by handle" page, which
# works for EVERY first-party posting (seeded/imported or app-authored) since
# they all carry an author_handle in structData.
# ---------------------------------------------------------------------------

_HANDLE_INDEX_TTL = 120.0  # seconds
_handle_index: dict = {"built_at": 0.0, "map": {}}


def _build_handle_index(project_id: str, location: str, datastore_id: str) -> dict:
    dc = de.DocumentServiceClient(client_options=ClientOptions(quota_project_id=project_id))
    parent = (
        f"projects/{project_id}/locations/{location}/collections/default_collection"
        f"/dataStores/{datastore_id}/branches/default_branch"
    )
    idx: dict[str, list[dict]] = {}
    for doc in dc.list_documents(request=de.ListDocumentsRequest(parent=parent, page_size=100)):
        meta = _struct_to_dict(doc.struct_data)
        handle = str(meta.get("author_handle") or "").strip()
        if not handle:
            continue
        idx.setdefault(handle, []).append(_card_from_struct(doc.id, meta))
    for cards in idx.values():  # newest first within each handle
        cards.sort(key=lambda c: c.get("date") or "", reverse=True)
    return idx


def postings_by_handle(handle: str, project_id: str, location: str, datastore_id: str) -> list[dict]:
    """All postings authored under `handle` (newest first). Empty for unknown or
    blank handles. Backed by a short-lived in-process index of the datastore."""
    handle = (handle or "").strip()
    if not handle:
        return []
    now = time.time()
    if not _handle_index["map"] or now - _handle_index["built_at"] > _HANDLE_INDEX_TTL:
        try:
            _handle_index["map"] = _build_handle_index(project_id, location, datastore_id)
            _handle_index["built_at"] = now
        except Exception as e:  # noqa: BLE001 - best-effort; serve stale/empty on failure
            print(f"postings_by_handle: index build failed: {e}")
    return list(_handle_index["map"].get(handle, []))


# --- Context-aware dynamic filter suggestions (tag hierarchy + live counts) --
#
# Driven by (a) the situation extracted from the conversation, (b) the tag
# hierarchy (1.6 "Associated Visa/Form" links concern/action tags to a parent
# visa), and (c) live Discovery Engine facet counts scoped to the situation.

_TAG_HIERARCHY: dict | None = None
_ACRONYMS = {
    "rfe", "aos", "cos", "opt", "cpt", "ead", "gc", "lca", "perm", "uscis",
    "ac21", "221g", "i-94", "i94", "stem", "h1b", "h-1b", "h4", "f1", "b1", "b2",
    "l1", "o1", "eb", "eb1", "eb2", "eb3", "ir", "us", "usa",
}


def _tag_hierarchy() -> dict:
    """Lazy-build {visa_code(upper) -> set(related action/concern tags)} from
    1.6-visa-form-actions.csv ('tag, Associated Visa/Form, Description')."""
    global _TAG_HIERARCHY
    if _TAG_HIERARCHY is None:
        h: dict[str, set] = {}
        try:
            with open(_csv_path("1.6-visa-form-actions.csv"), newline="", encoding="utf-8") as f:
                reader = csv.reader(f)
                next(reader, None)
                for row in reader:
                    if len(row) < 2 or not row[0].strip():
                        continue
                    tag, visa = row[0].strip(), row[1].strip().upper()
                    if visa:
                        h.setdefault(visa, set()).add(tag)
        except Exception as e:  # noqa: BLE001
            print(f"tag hierarchy load failed: {e}")
        _TAG_HIERARCHY = h
    return _TAG_HIERARCHY


def _hierarchy_related(code: str) -> set:
    return _tag_hierarchy().get((code or "").upper(), set())


def _humanize(code: str) -> str:
    parts = [p for p in re.split(r"[-_ ]", code) if p]
    return " ".join(p.upper() if p.lower() in _ACRONYMS else p.capitalize() for p in parts)


_CONSULATE_LABELS: dict | None = None


def _consulate_label(code: str) -> str:
    """Map a consulate code (BOM) back to a readable name (Mumbai)."""
    global _CONSULATE_LABELS
    if _CONSULATE_LABELS is None:
        m: dict[str, str] = {}
        for spec in _facet_registry():
            if spec["key"] == "consulate":
                for name, c in spec["terms"].items():
                    if c not in m or len(name) > len(m[c]):  # prefer the fuller name
                        m[c] = name
        _CONSULATE_LABELS = {c: n.title() for c, n in m.items()}
    return _CONSULATE_LABELS.get(code.upper(), code.upper())


def _value_label(field: str, code: str) -> str:
    return _consulate_label(code) if field == "consulates" else _humanize(code)


# (key, label, datastore facet field) — the refinement dimensions to surface.
_SUGGEST_FIELDS = [
    ("concern", "Concern", "concerns_or_questions_tags"),
    ("topic", "Topic", "tags"),
    ("outcome", "Outcome", "key_stages_or_info.outcome_status"),
    ("consulate", "Consulate", "consulates"),
]


def suggested_filters(
    query: str,
    project_id: str,
    location: str,
    engine_id: str,
    max_per_facet: int = 6,
) -> list:
    """Return situation-relevant refinement facets with live counts:
      [ {key, label, field, values: [{code, label, count}]}, ... ]
    Anchored on the extracted visa/category, scoped to that subset, ranked
    hierarchy-related-first by count, excluding already-applied values."""
    facets = extract_filters(query)
    anchor = facets.get("visa") or facets.get("category")
    related: set = set()
    if anchor:
        for c in anchor["codes"]:
            related |= _hierarchy_related(c)
    applied = {c for f in facets.values() for c in f["codes"]}

    client = _search_client(project_id, location)
    serving_config = _serving_config(project_id, location, engine_id)
    FK = de.SearchRequest.FacetSpec.FacetKey
    specs = [de.SearchRequest.FacetSpec(facet_key=FK(key=field), limit=50)
             for _k, _l, field in _SUGGEST_FIELDS]

    def _run(filter_expr: str):
        req = de.SearchRequest(serving_config=serving_config, query=query, page_size=1,
                               filter=filter_expr or "", facet_specs=specs)
        return {f.key: f for f in client.search(req).facets}

    scope = _facet_condition(anchor) if anchor else ""
    fcts = _run(scope)
    if scope and not any(f.values for f in fcts.values()):
        fcts = _run("")  # anchor too narrow — fall back to unscoped counts

    out = []
    for key, label, field in _SUGGEST_FIELDS:
        fct = fcts.get(field)
        if not fct:
            continue
        vals = [(v.value, int(v.count)) for v in fct.values if v.count and v.value not in applied]
        if not vals:
            continue
        vals.sort(key=lambda vc: (0 if vc[0] in related else 1, -vc[1]))
        out.append({
            "key": key, "label": label, "field": field,
            "values": [{"code": c, "label": _value_label(field, c), "count": n} for c, n in vals[:max_per_facet]],
        })
    return out


if __name__ == "__main__":
    # Standalone smoke test: python search_client.py "your question"
    import sys

    from dotenv import load_dotenv

    load_dotenv()
    proj = os.getenv("GCP_PROJECT_ID") or os.getenv("GCP_PROJECT", "")
    loc = os.getenv("GCP_VERTEX_DATASTORE_LOCATION", "global")
    engine = os.getenv("GCP_VERTEX_SEARCH_APP_ID", "imm-postings-search-app")
    q = sys.argv[1] if len(sys.argv) > 1 else "B1/B2 visa interview experience in Mumbai"
    res = answer_query(q, proj, loc, engine)
    print(f"is_fallback: {res['is_fallback']}")
    print(f"answer: {res['answer'][:500]}")
    print(f"sources ({len(res['chunks'])}):")
    for c in res["chunks"]:
        print(f"  - {c['chunk_id']} | {c['source'][:60]} | labels={c['labels'][:4]}")
