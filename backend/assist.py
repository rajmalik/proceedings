"""
assist.py — AI-Assist router core (Phase 2)
===========================================================================
The per-turn intent router for the "AI Assist" conversational surface
(features/ai-assist-8/ai-assist-specs-8.md §5 build contract). It classifies a
user turn into one of five intents and extracts the fields the downstream tools
need — using the repo's proven JSON-structured-output Gemini idiom
(`posting._extract` template), NOT native function-calling.

This module is deliberately pure orchestration logic with **no FastAPI import**
(same layering as reconcile.py / matching.py): `api.py` maps the returned dict
onto the `AssistResponse` model.

Phase 2 ships only the classification brain:
  - route_turn()             — one Gemini call -> a typed, normalized decision.
  - _trailing_clarify_streak — how many consecutive clarify rounds have happened.

The answer cascade (Phase 3), /post handoff (Phase 4), timeline/find flow
(Phase 5) and the HTTP route + rate limiter (Phase 6) build on this.
"""
import json
import os
import re

from google import genai

import posting  # shared genai_client() + _retry()
import query  # generate_direct_answer (ungrounded fallback)
import search_client  # answer_query (grounded retrieval)
import matching  # timeline group search + preview (Phase 5)

# Five-way taxonomy (§5.1). A tuple (not an Enum) so a future "ask-attorney" is a
# prompt + branch change, no schema migration (Q6 — extensible enum).
INTENTS = ("answer-gov", "answer-community", "post", "timeline-find", "find-similar", "clarify")

# Probe result (2026-09-19, proceedings-490601/us-central1): only gemini-2.5-flash
# and -flash-lite are GA here; Gemini-3 Flash 404s. Ship on 2.5-flash; the
# dedicated env var makes the eventual bump a one-line flip, zero code (Q11).
def _assist_model() -> str:
    return os.getenv("GCP_GEMINI_ASSIST_MODEL", "gemini-2.5-flash")


# The legal-advice sentence is reused VERBATIM from query.generate_direct_answer's
# prompt (query.py) so the router and the answerer enforce the same boundary (E2).
_LEGAL_ADVICE_LINE = (
    "Do NOT provide case-specific legal advice or assess whether a specific person qualifies."
)

ASSIST_SYSTEM_PROMPT = f"""You are the routing agent for meridianjourney.ai, a self-service U.S. \
immigration community platform. For each user turn you output ONE JSON object that decides how the \
turn is handled. You do NOT write the user-facing answer here — you only classify the turn and \
extract fields.

Choose exactly one `intent`:
- "answer-gov": a general / informational U.S. immigration question answerable from government or \
official authoritative sources (rules, eligibility criteria, processes, fees, processing timelines, \
legal definitions).
- "answer-community": a question best answered from the lived experiences of other applicants (what \
others saw or did), answerable from community postings on this platform.
- "post": the user's OWN case-specific situation that they want to share with or ask the community — \
route to the /post composer.
- "timeline-find": the user is asking about the PROCESSING TIMELINE of an EAD or an H-1B (how long \
it is taking, when it will be approved, current processing times). This PRE-EMPTS "post": these are \
routed to the /find groups page so the user can find, join, or create the relevant timeline group \
and post there.
- "find-similar": the user wants to FIND OTHER PEOPLE in the same situation as them \
(same visa/status, consulate, or stage) to connect with or compare notes — e.g. "anyone else on an \
H-1B who filed at Mumbai?", "find people in my situation", "who else is in the same boat". This is \
NOT a processing-time question (that is "timeline-find") and NOT their own message to post (that is \
"post"): route them to the /find REGULAR groups page with the criteria pre-filled.
- "clarify": there is not enough information to classify the turn or to act on it. Ask at most 3 \
short, targeted questions. Prioritise establishing at least ONE of: the user's current immigration \
status, their intended status, or the process / stage they are in. Never exceed 3 clarifying \
questions across the whole conversation.

Guardrails:
- {_LEGAL_ADVICE_LINE}
- The `rationale` field is shown to the user; it must state only WHY you routed this turn (one short \
sentence) and must NEVER assess eligibility, a specific person's case, or give legal advice.

Field extraction:
- Always set `rewritten_question` to a cleaned, PII-free version of the user's question.
- For "post" turns, best-effort fill `post_title` and `post_summary`.
- For "timeline-find" turns, best-effort fill `timeline_processing_type` (e.g. "EAD" or "H-1B"), \
`timeline_eligibility`, `timeline_filing_month`, `timeline_filing_year`.
- For "find-similar" turns, best-effort fill `find_visa` with the user's visa/status if stated \
(e.g. "H-1B", "F-1").
- For "clarify" turns, fill `clarify_questions` (an array of at most 3 short strings).

Output ONLY a JSON object with EXACTLY these keys:
{{"intent", "confidence" (a number 0..1), "rationale", "rewritten_question", "clarify_questions" (array), \
"post_title", "post_summary", "timeline_processing_type", "timeline_eligibility", \
"timeline_filing_month", "timeline_filing_year", "find_visa"}}
"""

# String fields carried on every decision (besides intent/confidence/clarify_questions).
_STR_FIELDS = (
    "rationale", "rewritten_question", "post_title", "post_summary",
    "timeline_processing_type", "timeline_eligibility",
    "timeline_filing_month", "timeline_filing_year", "find_visa",
)


def _turn_field(turn, key):
    """Read a history-turn field, tolerating dicts or objects (AssistTurn)."""
    if isinstance(turn, dict):
        return turn.get(key)
    return getattr(turn, key, None)


def _fallback_decision(message: str) -> dict:
    """The deterministic decision used on any router failure: send it down the
    answer path (which itself degrades to the labelled ungrounded answer in
    Phase 3). Mirrors classify_intent's never-500 heuristic fallback."""
    return {
        "intent": "answer-gov",
        "confidence": 0.0,
        "rationale": "",
        "rewritten_question": message,
        "clarify_questions": [],
        "post_title": "",
        "post_summary": "",
        "timeline_processing_type": "",
        "timeline_eligibility": "",
        "timeline_filing_month": "",
        "timeline_filing_year": "",
        "find_visa": "",
    }


def _normalize(data, message: str) -> dict:
    """Coerce a raw model dict into the full, typed decision schema. Unknown/absent
    intent -> answer-gov (safe default); missing fields defaulted."""
    if not isinstance(data, dict):
        return _fallback_decision(message)
    out = _fallback_decision(message)

    if data.get("intent") in INTENTS:
        out["intent"] = data["intent"]

    try:
        out["confidence"] = float(data.get("confidence", 0.0))
    except (TypeError, ValueError):
        out["confidence"] = 0.0

    for k in _STR_FIELDS:
        v = data.get(k)
        if isinstance(v, str) and v.strip():
            out[k] = v.strip()

    if not out["rewritten_question"]:
        out["rewritten_question"] = message

    cq = data.get("clarify_questions")
    if isinstance(cq, list):
        out["clarify_questions"] = [str(x) for x in cq if str(x).strip()][:3]

    return out


def _format_conversation(message: str, history) -> str:
    """Render the capped recent thread (Q8) + the new turn as a transcript."""
    lines = []
    for t in list(history)[-8:]:
        role = (_turn_field(t, "role") or "user")
        content = _turn_field(t, "content") or ""
        lines.append(f"{str(role).upper()}: {content}")
    lines.append(f"USER: {message}")
    return "CONVERSATION:\n" + "\n".join(lines) + "\n\nReturn the JSON object now."


def route_turn(message: str, history=None) -> dict:
    """Classify one user turn -> a normalized decision dict (the full schema).

    One structured-output Gemini call (response_mime_type=application/json,
    thinking disabled, transient-error retry). Never raises: any failure or
    unparseable output returns the deterministic answer-gov fallback.
    """
    history = history or []
    try:
        client = posting.genai_client()  # shared, 60s timeout
        contents = ASSIST_SYSTEM_PROMPT + "\n\n" + _format_conversation(message, history)
        cfg_kwargs = dict(temperature=0.1, max_output_tokens=1024,
                          response_mime_type="application/json")
        try:  # keep the whole budget on JSON (2.5-flash otherwise truncates)
            cfg_kwargs["thinking_config"] = genai.types.ThinkingConfig(thinking_budget=0)
        except Exception:  # noqa: BLE001 - older SDK without ThinkingConfig
            pass
        resp = posting._retry(lambda: client.models.generate_content(
            model=_assist_model(),
            contents=contents,
            config=genai.types.GenerateContentConfig(**cfg_kwargs),
        ), attempts=2)
        raw = (resp.text or "").strip()
        raw = re.sub(r"^```(?:json)?|```$", "", raw, flags=re.MULTILINE).strip()
        return _normalize(json.loads(raw), message)
    except Exception as e:  # noqa: BLE001 - router must never 500
        print(f"assist.route_turn: fallback ({type(e).__name__}: {e})")
        return _fallback_decision(message)


def _trailing_clarify_streak(history) -> int:
    """Count the trailing run of consecutive AI turns whose intent was 'clarify'
    (interleaved user turns are skipped). Drives the 'after 3 clarifies, default
    to the labelled answer' rule (Q17) — history-derived, no server session."""
    streak = 0
    for t in reversed(list(history)):
        if (str(_turn_field(t, "role") or "").lower()) != "ai":
            continue  # skip user turns
        if (_turn_field(t, "intent") or "") == "clarify":
            streak += 1
        else:
            break
    return streak


# ===========================================================================
# Phase 3 — answer path (grounded cascade: gov -> community -> ungrounded)
# ===========================================================================
# Filter only on the indexed/filterable `doc_kind` field — NEVER `channel`
# (unregistered facet -> 400). See search_client.answer_query.
_GOV_FILTER = 'doc_kind: ANY("gov_news","official_reference")'
_COMMUNITY_FILTER = '(NOT doc_kind: ANY("gov_news","official_reference"))'

# Every ungrounded answer is prefixed with this label (B2/E1): the reader must
# know it is not grounded in our sources and is not legal advice.
_UNGROUNDED_LABEL = "**General information — not from our sources, not legal advice.**"

# Steers the managed Answer API away from verbose, over-inferred answers — the
# root cause of the "wrong form" hallucination (it synthesized a long answer from
# loosely-related gov_news instead of the specific form). Grounded answers are
# short and form-first; when the sources DON'T actually contain the answer the
# model emits a sentinel so the cascade can fall through to the model-knowledge
# tier instead of returning a confident non-answer.
_DECLINE_SENTINEL = "NO_GROUNDED_ANSWER"
_ANSWER_PREAMBLE = (
    "You are a concise U.S. immigration assistant. Answer the question directly and briefly using the "
    "provided sources (one or two short paragraphs). If the user asks which form to file, name the "
    "specific USCIS form (title and number) first. Answer whenever the sources address the question's "
    "TOPIC — you do NOT need the exact scenario spelled out (e.g. a general change-of-address page "
    "answers 'which form for a change of address'). Reply with EXACTLY the token "
    f"{_DECLINE_SENTINEL} and nothing else ONLY when the sources are UNRELATED to the question; never "
    "stretch or invent an answer from loosely related content."
)


def _is_decline(answer: str) -> bool:
    """True when a grounded answer is really a non-answer (the sentinel, or empty)
    — so the cascade treats it as a miss and falls through to the next tier."""
    a = (answer or "").strip()
    return (not a) or (_DECLINE_SENTINEL.lower() in a.lower())


def _answer_shape(answer: str, source_tier: str, *, citations=None,
                  community_cards=None, is_fallback: bool = False,
                  search_suggestions_html: str = "") -> dict:
    """The uniform answer dict every tier returns (also the keys api.py maps).
    `search_suggestions_html` is only populated by the web-search tier (Google's
    Search-Suggestion chips, which its terms require the UI to render)."""
    return {
        "answer": answer,
        "source_tier": source_tier,
        "citations": citations or [],
        "community_cards": community_cards or [],
        "is_fallback": is_fallback,
        "search_suggestions_html": search_suggestions_html,
    }


def _citations_from_chunks(chunks) -> list:
    """Gov/official citations: source link + human title + as-of date (B3)."""
    out = []
    for c in chunks:
        out.append({
            "source": c.get("source", ""),
            "title": str(c.get("text", ""))[:120],
            "as_of": c.get("as_of", ""),
        })
    return out


def _community_cards_from_chunks(chunks) -> list:
    """Community post cards (Q9). Every card must link back to the original
    posting: an external permalink when the chunk carries one, else the app's
    own /case/{case_id} permalink."""
    out = []
    for c in chunks:
        cid = c.get("chunk_id", "")
        src = str(c.get("source", ""))
        if src.startswith("http"):
            url = src
        elif cid:
            url = f"/case/{cid}"
        else:
            url = ""
        text = str(c.get("text", ""))
        out.append({
            "case_id": cid,
            "title": text[:120],
            "snippet": text[:300],
            "url": url,
            "channel": c.get("channel", ""),
        })
    return out


def _gov_answer(question: str, *, project_id: str, location: str, engine_id: str):
    """Grounded answer over gov/official docs. Returns the answer shape, or None
    on a miss (is_fallback) so the cascade can fall through."""
    res = search_client.answer_query(question, project_id, location, engine_id,
                                     filter_expr=_GOV_FILTER, preamble=_ANSWER_PREAMBLE)
    if res.get("is_fallback") or _is_decline(res.get("answer", "")):
        return None  # no reference, or a sentinel decline -> fall through
    return _answer_shape(res["answer"], "gov",
                         citations=_citations_from_chunks(res["chunks"]))


def _community_answer(question: str, *, project_id: str, location: str, engine_id: str):
    """Grounded summary + linked cards over community postings. Returns the answer
    shape, or None on a miss."""
    res = search_client.answer_query(question, project_id, location, engine_id,
                                     filter_expr=_COMMUNITY_FILTER, preamble=_ANSWER_PREAMBLE)
    if res.get("is_fallback") or _is_decline(res.get("answer", "")):
        return None  # no reference, or a sentinel decline -> fall through
    return _answer_shape(res["answer"], "community",
                         community_cards=_community_cards_from_chunks(res["chunks"]))


def _ungrounded_answer(question: str) -> dict:
    """Ungrounded Gemini answer, labelled as general information / not legal
    advice (B2). Marked is_fallback since it is not grounded in our sources."""
    body = query.generate_direct_answer(question)
    return _answer_shape(f"{_UNGROUNDED_LABEL}\n\n{body}", "ungrounded", is_fallback=True)


# ---------------------------------------------------------------------------
# Web-search tier (Option B) — Gemini "Grounding with Google Search".
# Phase 1: the tier function only; wired into answer_cascade in a later phase,
# behind AI_ASSIST_WEB_SEARCH (default off — grounding-with-search is priced).
# ---------------------------------------------------------------------------
_WEB_SEARCH_ENABLED = os.getenv("AI_ASSIST_WEB_SEARCH", "0") == "1"

_WEB_SEARCH_PROMPT = (
    "You are a concise U.S. immigration assistant. Answer the question directly and briefly, "
    "using ONLY authoritative official U.S. government sources (prefer uscis.gov, travel.state.gov, "
    "dhs.gov). If those sources do not cover it, say you don't have that information. "
    "Question: {q}"
)

# The grounding model sometimes leaks inline citation markers like "[cite: 1, 3]"
# or "[citation:2]" into the answer text — strip them before returning.
_CITE_MARKER = re.compile(r"\s*\[(?:cite|citation)s?:[^\]]*\]", re.IGNORECASE)


def _strip_cite_markers(text: str) -> str:
    return _CITE_MARKER.sub("", text or "").strip()


def _is_official_source(title: str) -> bool:
    """A citation is authoritative only if its domain is a U.S. government one.
    Google grounding puts the source domain in the chunk `title` (e.g. "uscis.gov",
    "cilawgroup.com"); federal sites are all `.gov`, so we keep those and drop
    commercial/law-firm results (the prompt's "official sources" is only a soft
    preference — this enforces it)."""
    t = (title or "").strip().lower().rstrip("/")
    return t == "gov" or t.endswith(".gov")


def _web_tool():
    """The Google-Search grounding tool (newer models want `google_search`; older
    ones `google_search_retrieval`)."""
    try:
        return genai.types.Tool(google_search=genai.types.GoogleSearch())
    except Exception:  # noqa: BLE001 - older SDK shape
        return genai.types.Tool(google_search_retrieval=genai.types.GoogleSearchRetrieval())


def _web_search_answer(question: str):
    """Live-web answer grounded via Gemini + Google Search, restricted (by prompt)
    to official U.S. government sources. Returns the answer shape with
    source_tier="web" (citations = the grounded web sources; the redirect URI is
    kept per Google's terms, the real domain is the title) and the Search-
    Suggestion chips HTML. Returns None on an empty answer or any failure so the
    cascade falls through to the ungrounded tier. Never raises."""
    try:
        client = posting.genai_client()
        resp = posting._retry(lambda: client.models.generate_content(
            model=_assist_model(),
            contents=_WEB_SEARCH_PROMPT.format(q=question),
            config=genai.types.GenerateContentConfig(
                tools=[_web_tool()], temperature=0.1, max_output_tokens=1024),
        ), attempts=2)
        answer = _strip_cite_markers(resp.text or "")
        if not answer:
            return None

        citations, chips = [], ""
        try:
            gm = resp.candidates[0].grounding_metadata
            for ch in (getattr(gm, "grounding_chunks", None) or []):
                web = getattr(ch, "web", None)
                uri = getattr(web, "uri", "") if web else ""
                if uri:
                    citations.append({"source": uri, "title": (getattr(web, "title", "") or ""), "as_of": ""})
            sep = getattr(gm, "search_entry_point", None)
            chips = getattr(sep, "rendered_content", "") if sep else ""
        except Exception:  # noqa: BLE001 - metadata is best-effort
            pass

        # Enforce official-source grounding: keep only .gov citations. If none
        # remain, the answer wasn't grounded on authoritative sources — treat as a
        # miss and fall through to the labelled ungrounded tier.
        citations = [c for c in citations if _is_official_source(c.get("title", ""))]
        if not citations:
            return None

        return _answer_shape(answer, "web", citations=citations, is_fallback=False,
                             search_suggestions_html=chips)
    except Exception as e:  # noqa: BLE001 - best-effort tier, never break the turn
        print(f"assist._web_search_answer: fallback ({type(e).__name__}: {e})")
        return None


def answer_cascade(question: str, *, project_id: str, location: str, engine_id: str) -> dict:
    """Resolve an answer: gov (DS-1) -> community -> [web search] -> ungrounded.
    The miss signal at each grounded tier is answer_query's is_fallback (Q3): a
    genuinely experiential question naturally misses gov and falls to community.
    The web-search tier (Option B, flag-gated by AI_ASSIST_WEB_SEARCH) is the broad
    live fallback before giving up to uncited model knowledge; it needs no Search
    engine, so it still runs when none is configured."""
    if project_id and engine_id:
        gov = _gov_answer(question, project_id=project_id, location=location, engine_id=engine_id)
        if gov is not None:
            return gov
        community = _community_answer(question, project_id=project_id, location=location, engine_id=engine_id)
        if community is not None:
            return community
    if _WEB_SEARCH_ENABLED:
        web = _web_search_answer(question)
        if web is not None:
            return web
    return _ungrounded_answer(question)


# ===========================================================================
# Phase 4 — post handoff (chat -> the /post composer draft)
# ===========================================================================

def _post_draft(decision: dict, message: str) -> dict:
    """Build the /post pre-fill draft from a router decision.

    C3: PII is scrubbed BEFORE Gemini (suggest_tags calls Gemini) AND the
    returned draft fields are already scrubbed (so nothing unscrubbed reaches the
    /post composer). Falls back to the (scrubbed) raw message when the router
    didn't produce a title/summary. Returns the shape /post pre-fills from
    (title, description, groups, key_stages_or_info, key_dates)."""
    from profile import scrub_pii  # local import to avoid a posting<->profile cycle

    title = scrub_pii((decision.get("post_title") or "").strip())
    summary = scrub_pii((decision.get("post_summary") or "").strip() or (message or "").strip())
    if not title:
        title = summary[:80]

    tags = posting.suggest_tags(title or summary[:80], summary)
    return {
        "title": title,
        "description": summary,
        "groups": tags.get("groups", {}),
        "key_stages_or_info": tags.get("key_stages_or_info", {}),
        "key_dates": tags.get("key_dates", {}),
    }


# ===========================================================================
# Phase 5 — timeline -> /find handoff (EAD/H-1B processing cohorts)
# ===========================================================================
_MONTHS = ("Jan", "Feb", "Mar", "Apr", "May", "Jun",
           "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")


def _normalize_month(raw: str) -> str:
    """Coerce a month to the 3-letter option Timeline scope rows use
    ('08'/'8'/'August'/'aug' -> 'Aug'); '' when it can't be resolved."""
    m = (raw or "").strip()
    if not m:
        return ""
    if m.isdigit():
        i = int(m)
        return _MONTHS[i - 1] if 1 <= i <= 12 else ""
    m3 = m[:3].title()
    return m3 if m3 in _MONTHS else ""


def _normalize_year(raw: str) -> str:
    y = (raw or "").strip()
    return y if (y.isdigit() and len(y) == 4) else ""


def resolve_timeline_criteria(decision: dict) -> dict:
    """Map a router decision's timeline_* fields into the exact Timeline criteria
    shape /find's panel produces (so a server-side search matches groups the UI
    created). Each processing-type / eligibility value lands in
    `current_visa_or_greencard_category` when it is in the visa vocab, else in
    `tags` (mirrors /find's processingTypeField); month/year go into
    key_stages_or_info per timeline_scope_rows.

    Returns {criteria, processing_type, eligibility, filing_month, filing_year,
    sufficient}. `sufficient` (Q13) means enough to search a cohort: a valid
    processing type + filing month + year, and an eligibility when the type has
    categories."""
    valid_types = {t["value"] for t in posting.PROCESSING_TYPES}
    ptype = (decision.get("timeline_processing_type") or "").strip()
    if ptype not in valid_types:
        ptype = ""

    type_row = next((t for t in posting.PROCESSING_TYPES if t["value"] == ptype), None)
    cats = {c["tag"] for c in (type_row or {}).get("eligibility_categories", []) or []}
    elig = (decision.get("timeline_eligibility") or "").strip()
    if elig not in cats:
        elig = ""

    month = _normalize_month(decision.get("timeline_filing_month"))
    year = _normalize_year(decision.get("timeline_filing_year"))

    visa = set(posting.vocab_lists().get("visa") or [])
    criteria: dict = {
        "tags": [], "current_visa_or_greencard_category": [],
        "key_stages_or_info": {}, "key_dates": {},
    }
    for val in (ptype, elig):
        if not val:
            continue
        field = "current_visa_or_greencard_category" if val in visa else "tags"
        criteria[field].append(val)

    by_key = {r["key"]: r for r in posting.timeline_scope_rows(ptype, elig)}
    for key, value in (("filing_month", month), ("filing_year", year)):
        row = by_key.get(key)
        if row and value:
            criteria.setdefault(row.get("field", "key_stages_or_info"), {})[key] = value

    type_has_cats = bool(cats)
    sufficient = bool(ptype and month and year and (elig or not type_has_cats))
    return {
        "criteria": criteria,
        "processing_type": ptype,
        "eligibility": elig,
        "filing_month": month,
        "filing_year": year,
        "sufficient": sufficient,
    }


def _timeline_find_url(r: dict) -> str:
    """A /find deep-link (Timeline mode) pre-filled with whatever timeline
    criteria the router resolved — processing type, eligibility category, and
    filing month/year. Partial is fine: the /find panel prefills whatever is
    present and the user completes the rest. Mirrors _find_handoff for the
    Regular case. Values are the vocab-validated ones from
    resolve_timeline_criteria (processing_type = a PROCESSING_TYPES value,
    eligibility = an eligibility-category tag)."""
    from urllib.parse import urlencode

    params = [("type", "timeline")]
    for key in ("processing_type", "eligibility", "filing_month", "filing_year"):
        val = (r.get(key) or "").strip()
        if val:
            params.append((key, val))
    return "/find?" + urlencode(params)


def _timeline_handoff(decision: dict, db) -> dict:
    """Route an EAD/H-1B timeline turn to a group (Q12). Uses the PUBLIC group
    search (no auth) to find the cohort; hands a /groups/{id} deep-link when one
    exists, else the would-be group name for the /find create tab. Insufficient
    criteria (Q13) -> 'unresolved' (send the user to /find generically). Returns
    {status, group_id, group_name, criteria, find_url}. `find_url` is a
    Timeline-mode /find deep-link pre-filled with the resolved criteria, so the
    user lands on a filled-in panel rather than a blank one."""
    r = resolve_timeline_criteria(decision)
    criteria = r["criteria"]
    find_url = _timeline_find_url(r)
    if not r["sufficient"]:
        return {"status": "unresolved", "group_id": "", "group_name": "",
                "criteria": criteria, "find_url": find_url}

    groups = matching.search_groups(db, criteria, "timeline", "balanced", 0) if db is not None else []
    if groups:
        g = groups[0]
        return {"status": "found", "group_id": g.get("group_id", ""),
                "group_name": g.get("name", ""), "criteria": criteria, "find_url": find_url}

    preview = matching.preview_timeline_group(criteria, "timeline")
    return {"status": "not_found", "group_id": "",
            "group_name": preview.get("name", ""), "criteria": criteria, "find_url": find_url}


# ===========================================================================
# find-similar -> /find (Regular groups: connect with others in the same boat)
# ===========================================================================

def _find_handoff(decision: dict) -> str:
    """Build a /find deep-link (Regular mode) pre-filled with the user's situation
    and, when stated + vocab-valid, their visa/status. The rest of the criteria
    the user refines on the /find panel."""
    from urllib.parse import urlencode

    params = [("type", "regular")]
    q = (decision.get("rewritten_question") or "").strip()
    if q:
        params.append(("q", q))
    visa = (decision.get("find_visa") or "").strip()
    if visa and visa in set(posting.vocab_lists().get("visa") or []):
        params.append(("visa", visa))
    return "/find?" + urlencode(params)


# ===========================================================================
# Phase 6 — orchestration (handle_turn)
# ===========================================================================
_DISCLAIMER = "This is general information about U.S. immigration, not legal advice."

_MAX_CLARIFY = 3  # after this many clarify rounds, stop clarifying (Q17)


def disclaimer_for(source_tier: str = "") -> str:
    """The inline per-answer disclaimer (E1). One line today; kept a function so
    a per-tier variant (e.g. a stronger note on the ungrounded tier) is a
    one-place change later."""
    return _DISCLAIMER


def _scrub(text: str) -> str:
    from profile import scrub_pii  # local import to avoid a posting<->profile cycle
    return scrub_pii(text or "")


def _scrub_history(history) -> list:
    out = []
    for t in history:
        out.append({
            "role": _turn_field(t, "role") or "user",
            "content": _scrub(_turn_field(t, "content") or ""),
            "intent": _turn_field(t, "intent") or "",
        })
    return out


def _has_timeline_signal(decision: dict) -> bool:
    valid = {t["value"] for t in posting.PROCESSING_TYPES}
    return (decision.get("timeline_processing_type") or "").strip() in valid


# The shown routing explanation (A5) must never read as an eligibility / case-
# outcome assessment (E2 — a new surface the query.py answer prompt doesn't
# cover). Blank a rationale that trips these, rather than show it. Best-effort
# keyword guard, in the spirit of moderation.check_text.
_RATIONALE_BLOCK = (
    re.compile(r"\byou\b[^.]{0,25}\b(qualif\w*|eligib\w*|ineligible|approv\w*|denied|deny)\b", re.I),
    re.compile(r"\byour\s+(case|petition|application|visa|green\s*card|eligibility)\b[^.]{0,25}\b(will|would|should|likely|approv\w*|denied)\b", re.I),
    re.compile(r"\b(ineligible|not eligible|guaranteed|approval is likely)\b", re.I),
)


def _clean_rationale(text) -> str:
    t = (text or "").strip()
    if not t:
        return ""
    return "" if any(p.search(t) for p in _RATIONALE_BLOCK) else t


def handle_turn(message: str, history=None, *, force_intent: str = "",
                project_id: str = "", location: str = "global", engine_id: str = "",
                db=None) -> dict:
    """Route one turn and produce the full AssistResponse-shaped dict.

    PII is scrubbed before the turn ever reaches Gemini (C3). `force_intent`
    (A5 override: "post" / "timeline-find") wins over the router. After
    _MAX_CLARIFY clarify rounds the turn defaults to the labelled answer path
    instead of clarifying again (Q17). Every result carries the disclaimer (E1)
    and the "post" affordance; the "find your group" affordance shows whenever
    the turn carried an EAD/H-1B signal (Q16)."""
    history = history or []
    scrubbed_message = _scrub(message)  # C3 — before Gemini
    decision = route_turn(scrubbed_message, _scrub_history(history))

    intent = force_intent if force_intent in INTENTS else decision["intent"]
    if intent == "clarify" and _trailing_clarify_streak(history) >= _MAX_CLARIFY:
        intent = "answer-gov"  # cascade -> ungrounded if nothing grounds

    result = {
        "intent": intent,
        "confidence": decision.get("confidence", 0.0),
        "answer": "",
        "source_tier": "",
        "citations": [],
        "community_cards": [],
        "clarify_questions": [],
        "post_draft": None,
        "timeline": None,
        "find_url": "",
        "search_suggestions_html": "",
        "disclaimer": disclaimer_for(""),
        "can_post": True,
        "can_find_timeline": (intent == "timeline-find") or _has_timeline_signal(decision),
        "can_find_similar": intent == "find-similar",
        "rationale": _clean_rationale(decision.get("rationale", "")),
        "is_fallback": False,
    }

    if intent == "clarify":
        result["clarify_questions"] = decision.get("clarify_questions", [])
    elif intent == "post":
        result["post_draft"] = _post_draft(decision, scrubbed_message)
    elif intent == "timeline-find":
        result["timeline"] = _timeline_handoff(decision, db)
    elif intent == "find-similar":
        result["find_url"] = _find_handoff(decision)
    else:  # answer-gov / answer-community (and the coerced default)
        q = decision.get("rewritten_question") or scrubbed_message
        ans = answer_cascade(q, project_id=project_id, location=location, engine_id=engine_id)
        result["answer"] = ans["answer"]
        result["source_tier"] = ans["source_tier"]
        result["citations"] = ans["citations"]
        result["community_cards"] = ans["community_cards"]
        result["is_fallback"] = ans["is_fallback"]
        result["search_suggestions_html"] = ans.get("search_suggestions_html", "")
        result["disclaimer"] = disclaimer_for(ans["source_tier"])

    return result
