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

# Five-way taxonomy (§5.1). A tuple (not an Enum) so a future "ask-attorney" is a
# prompt + branch change, no schema migration (Q6 — extensible enum).
INTENTS = ("answer-gov", "answer-community", "post", "timeline-find", "clarify")

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
- For "clarify" turns, fill `clarify_questions` (an array of at most 3 short strings).

Output ONLY a JSON object with EXACTLY these keys:
{{"intent", "confidence" (a number 0..1), "rationale", "rewritten_question", "clarify_questions" (array), \
"post_title", "post_summary", "timeline_processing_type", "timeline_eligibility", \
"timeline_filing_month", "timeline_filing_year"}}
"""

# String fields carried on every decision (besides intent/confidence/clarify_questions).
_STR_FIELDS = (
    "rationale", "rewritten_question", "post_title", "post_summary",
    "timeline_processing_type", "timeline_eligibility",
    "timeline_filing_month", "timeline_filing_year",
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
