"""
matching.py — "Find users in same boat" (phase-M, D-051).

Capture an applicant's matching CRITERIA via a US-immigration-expert chat, then
rank OTHER registered users (Firestore `users/{id}` profiles) by tag-overlap
similarity so the user can pick whom to include and form a group. This phase
only finds matches + forms the group; communication is a later phase.

Reuses, rather than re-implements:
  - chat plumbing + Gemini JSON  → profile._gen_json
  - controlled vocabulary        → posting._master_tags_block / clean helpers
  - profile validation + merge   → profile.clean_profile / merge_profile
  - validate-vs-profile + offer-to-update → the existing reconcile feature
    (reconcile.reconcile_profile_message + /api/reconcile + PUT /api/profile);
    matching itself always uses the ENTERED criteria.

The CRITERIA carry the same controlled-vocab fields as a profile/message (so
they double as the reconcile `message`), minus the journey/PII bits:
  current_visa_or_greencard_category, visa_applying_for, primary_consulate,
  consulates, key_stages_or_info, key_dates, background_text.

New Firestore collection:
  groups/{auto_id} = {name, signature, criteria_text, criteria_tags,
                      members:[{user_id, username}], created_by, description,
                      status, created_at, updated_at, last_activity_at}

  group_invitations/{group_id}__{user_id} = {group_id, group_name, user_id,
                      username, invited_by, invited_by_username, status,
                      cancel_reason, declined_count, created_at, updated_at,
                      responded_at}
    Nobody is ever added to a group without agreeing: every add-path
    (invite_member / add_members / find_or_create_group's peers) creates a
    PENDING invitation, and only accept_invitation() writes into
    groups/{id}.members. A pending invitee is therefore invisible to every
    existing membership read (is_member, group chat, member_attributes,
    needs_attributes) with no changes to any of them. See _invitations_ref()
    for why this is a top-level collection rather than a subcollection.
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

import posting
import profile

CRITERIA_FIELDS = [
    "current_visa_or_greencard_category",
    "visa_applying_for",
    "primary_consulate",
    "consulates",
    "tags",
    "key_stages_or_info",
    "key_dates",
    "background_text",
]

# Group validity → expiration_date, chosen at creation time. Timeline groups
# offer the short-lived options only (a processing cohort ages out); Regular
# groups add the long-lived options too (a "same boat" support group is
# meant to persist).
_VALIDITY_DAYS = {
    "1_month": 30, "3_months": 91, "6_months": 182, "1_year": 365,
    "3_years": 1095, "5_years": 1826, "10_years": 3653,
}
TIMELINE_VALIDITY_OPTIONS = ["1_month", "3_months", "6_months", "1_year"]
REGULAR_VALIDITY_OPTIONS = TIMELINE_VALIDITY_OPTIONS + ["3_years", "5_years", "10_years"]

# Similarity weights — visa/category dominates "same boat", then consulate, then
# a shared status fact (same key AND value), then a shared misc tag, then a
# shared milestone date.
W_VISA, W_CONSULATE, W_STAGE, W_TAG = 3.0, 1.5, 1.0, 0.75
MIN_SCORE = 1.0  # at least one shared visa | consulate | status fact | exact date

# Match Precision (group search only) — the score threshold a regular-group
# candidate must clear to surface. "balanced" reuses MIN_SCORE unchanged, so
# a request that omits `precision` behaves exactly as before this feature.
PRECISION_MIN_SCORE = {"broad": 0.5, "balanced": MIN_SCORE, "strict": 2.5}

# Date proximity ("same place in line"): for the SAME milestone key, credit by
# how close the two YYYY-MM-DD values are. The **±30-day** bucket is the
# "approximate match" boundary — it scores exactly MIN_SCORE, so two users whose
# milestone dates are within a month count as a match even with no other shared
# facet. Exact scores higher; wider windows give graduated bonus; a shared key
# with far/blank dates keeps a small floor (same milestone, different timing).
_DATE_EXACT = 1.5
_DATE_BUCKETS = [(30, 1.0), (90, 0.6), (180, 0.3)]  # (max_days_inclusive, weight)
_DATE_FLOOR = 0.1


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _as_set(v) -> set[str]:
    if isinstance(v, list):
        return {str(x) for x in v if x}
    return {str(v)} if v else set()


def _parse_ymd(s):
    """Parse a YYYY-MM-DD string to a datetime, or None if blank/malformed.
    Criteria/profile dates are normalized to YYYY-MM-DD upstream (clean_profile)."""
    try:
        return datetime.strptime(str(s), "%Y-%m-%d")
    except (ValueError, TypeError):
        return None


def _date_proximity(a, b) -> float:
    """0..1 closeness of two YYYY-MM-DD dates: exact ⇒ 1.0; within a bucket ⇒
    graduated; far apart or unparseable ⇒ 0.0 (the 'approximate match' rule)."""
    da, db = _parse_ymd(a), _parse_ymd(b)
    if da is None or db is None:
        return 0.0
    days = abs((da - db).days)
    if days == 0:
        return _DATE_EXACT
    for max_days, weight in _DATE_BUCKETS:
        if days <= max_days:
            return weight
    return 0.0


def _date_key_score(a, b) -> float:
    """Score for a shared milestone key: proximity if close, else a small floor
    (the two users track the same milestone, just at different times)."""
    return max(_date_proximity(a, b), _DATE_FLOOR)


def _date_label(key: str, a, b) -> str:
    p = _date_proximity(a, b)
    tag = "exact" if p >= _DATE_EXACT else ("~" if p > 0 else "≠")
    return f"{key}({tag})"


# ---------------------------------------------------------------------------
# Criteria cleaning + merge (reuse the profile validators)
# ---------------------------------------------------------------------------

def _clean_criteria(d: dict | None) -> dict:
    """Validate criteria against the controlled vocab via profile.clean_profile
    (drop journey/identity), returning only the matchable tag fields.

    profile.clean_profile()'s `tags` cleaning (clean_misc_tags) is 1.3+1.10
    ONLY — 1.6 visa-form-action tags are deliberately excluded from personal
    PROFILES (they belong in key_stages_or_info there). But a Timeline
    group's "Processing type" (e.g. stem-opt-extension) IS a 1.6 tag stored
    in criteria `tags` (see find/page.tsx's selectProcessingType()) — group
    CRITERIA are allowed to carry it even though a profile isn't, so re-admit
    any 1.6-vocab tags the caller actually supplied. Without this, a
    Timeline group's stored criteria_tags.tags would always come back empty
    for its Processing type, breaking search, dedup, and the browse-list tag
    summary alike."""
    p = profile.clean_profile({**(d or {}), "journey": []})
    extra = [t for t in ((d or {}).get("tags") or [])
             if t in posting._Vocab.visa_form_map and t not in p["tags"]]
    if extra:
        p = {**p, "tags": [*p["tags"], *extra]}
    return {f: p[f] for f in CRITERIA_FIELDS}


def _merge_criteria(base: dict, incoming: dict) -> dict:
    """Union lists / overlay maps / keep prior — reuse profile.merge_profile."""
    m = profile.merge_profile({**base, "journey": []}, {**incoming, "journey": []})
    return {f: m[f] for f in CRITERIA_FIELDS}


# ---------------------------------------------------------------------------
# Expert chat turn (single stage; mirrors profile.onboard_turn)
# ---------------------------------------------------------------------------

def _find_system_prompt(draft: dict) -> str:
    posting._Vocab.load()
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    return f"""You are a friendly US immigration expert helping the user find OTHER applicants in the SAME
situation ("same boat") so they can connect. Hold a short, natural conversation to capture the CRITERIA that
define who they want to find — essentially their own immigration situation: current status, what they are
applying for, the consulate(s) involved, key status facts, and the dates that fix their place in line. Ask
ONE focused question at a time (you may group a few RELATED dates). Concise and warm.

Today is {today}. Resolve relative dates against it; output exact YYYY-MM-DD.

# CAPTURE (only what applies) — controlled-vocabulary strings only
- current_visa_or_greencard_category (1.1/1.2) and/or visa_applying_for (1.1/1.2)
- primary_consulate + consulates (1.4) when relevant
- citizen_of_country / resident_of_country (ISO-2) and other 1.7 status facts under key_stages_or_info
- the key_dates (1.8) that matter most (priority_date, *_filed_date, visa_interview_date, ...)
- a short background_text in their own words
When the criteria are reasonably specific, set "done": true and tell them you'll find their matches now.

# SCOPE — this finds peers, it is NOT a Q&A
If they ask an immigration QUESTION, briefly say this page only builds their match criteria and steer back.

# HARD RULES
- NEVER ask for or store PII (name, DOB, address, phone, email, passport/A-number, SSN).
- Use ONLY controlled-vocabulary strings; if unsure, leave the field out and put the idea in background_text. Do NOT invent tags.
- Country values for *_of_country MUST be ISO-2 codes (IN, CN, MX, AE).

# CONTROLLED VOCABULARY (use exact strings)
{posting._master_tags_block()}

# OUTPUT — return ONE JSON object only (no prose, no fences):
{{
  "reply": string,
  "criteria": {{
    "current_visa_or_greencard_category": string[],
    "visa_applying_for": string[],
    "primary_consulate": string,
    "consulates": string[],
    "key_stages_or_info": object,
    "key_dates": object,
    "background_text": string
  }},
  "done": boolean
}}

# Criteria so far (merge your new findings into this; keep prior values):
{json.dumps(draft, ensure_ascii=False)}
"""


def find_turn(messages: list[dict], draft: dict | None) -> dict:
    """One conversational turn capturing match criteria. Returns
    {reply, criteria (validated), done}. Stateless — client passes history+draft."""
    base = _clean_criteria(draft)
    convo = "\n".join(
        f"{str(m.get('role', 'user')).capitalize()}: {m.get('content', '')}"
        for m in (messages or [])[-12:]
    )
    prompt = _find_system_prompt(base)
    try:
        data = profile._gen_json(f"{prompt}\n\nConversation so far:\n{convo}\n\nReturn the JSON now.")
    except json.JSONDecodeError:
        return {"reply": "Sorry, could you say that another way?", "criteria": base, "done": False}
    merged = _merge_criteria(base, _clean_criteria(data.get("criteria") or {}))
    return {
        "reply": str(data.get("reply") or "").strip() or "Tell me about your immigration situation.",
        "criteria": merged,
        "done": bool(data.get("done")),
    }


# ---------------------------------------------------------------------------
# Similarity scoring (pure) + matching
# ---------------------------------------------------------------------------

def _score(criteria: dict, prof: dict) -> dict:
    """Weighted tag-overlap between criteria and a candidate profile. Pure.
    Returns {score, shared (human strings), shared_detail}."""
    c_visa = _as_set(criteria.get("current_visa_or_greencard_category")) | _as_set(criteria.get("visa_applying_for"))
    p_visa = _as_set(prof.get("current_visa_or_greencard_category")) | _as_set(prof.get("visa_applying_for"))
    visa = sorted(c_visa & p_visa)

    c_cons = _as_set(criteria.get("consulates")) | _as_set(criteria.get("primary_consulate"))
    p_cons = _as_set(prof.get("consulates")) | _as_set(prof.get("primary_consulate"))
    cons = sorted(c_cons & p_cons)

    c_tags = _as_set(criteria.get("tags"))
    p_tags = _as_set(prof.get("tags"))
    tags = sorted(c_tags & p_tags)

    c_st = criteria.get("key_stages_or_info") or {}
    p_st = prof.get("key_stages_or_info") or {}
    stages = sorted(k for k in c_st if k in p_st and str(c_st[k]) == str(p_st[k]))

    c_dt = criteria.get("key_dates") or {}
    p_dt = prof.get("key_dates") or {}
    dt_keys = sorted(set(c_dt) & set(p_dt))
    date_score = sum(_date_key_score(c_dt[k], p_dt[k]) for k in dt_keys)
    # A shared key whose dates are far apart still scores the _DATE_FLOOR
    # (they track the same milestone), but it is NOT a "shared" thing to show
    # the user — surfacing a "≠" chip under a heading that means overlap
    # reads as a match when it's the opposite. Score keeps it; the UI doesn't.
    near_dt_keys = [k for k in dt_keys if _date_proximity(c_dt[k], p_dt[k]) > 0]

    # Timeline processing type: the group's DEFINING criterion is a 1.6 tag
    # (e.g. stem-opt-extension) that _clean_criteria() deliberately re-admits
    # into criteria — but candidate profiles are cleaned by clean_misc_tags(),
    # which keeps only 1.3/1.10, so that tag could never intersect p_tags and
    # silently contributed ZERO to every candidate. The signal does exist in
    # profiles, just under a different name: the template's own keys
    # (ead_filed_date, service_center, …) are real 1.7/1.8 profile
    # vocabulary. Score whichever of them the candidate has populated.
    #
    # Each row is looked up in the profile field IT declares — a template is
    # no longer dates-only, and matching a stage key against p_dt would score
    # zero for exactly the same reason this block exists.
    proc_keys: list[str] = []
    for t in sorted(c_tags):
        rows = posting.POST_JOIN_ATTRIBUTE_TEMPLATES.get(t) or []
        if not rows:
            continue
        proc_keys = sorted(
            r["key"] for r in rows
            if r["key"] in ((p_st if (r.get("field") == "key_stages_or_info") else p_dt))
            and r["key"] not in dt_keys and r["key"] not in stages
        )
        break
    proc_score = W_STAGE * len(proc_keys)

    score = (W_VISA * len(visa) + W_CONSULATE * len(cons) + W_TAG * len(tags)
             + W_STAGE * len(stages) + date_score + proc_score)
    shared = [*visa, *cons, *tags, *[f"{k}={c_st[k]}" for k in stages],
              *[_date_label(k, c_dt[k], p_dt[k]) for k in near_dt_keys],
              *proc_keys]
    return {
        "score": round(score, 2),
        "shared": shared,
        "shared_detail": {"visa": visa, "consulates": cons, "tags": tags,
                          "stages": stages, "dates": near_dt_keys, "processing": proc_keys},
    }


def _match_reason(detail: dict) -> str:
    """One human sentence explaining WHY this candidate surfaced, built from
    the shared_detail that _score() already computes and used to throw away.
    Reuses search_client's humanizers rather than inventing new formatting."""
    try:
        from search_client import _consulate_label, _humanize
    except Exception:  # noqa: BLE001 — never let display formatting break matching
        _consulate_label = _humanize = lambda x: str(x)  # noqa: E731
    bits: list[str] = []
    if detail.get("visa"):
        bits.append("both " + " / ".join(detail["visa"][:2]))
    if detail.get("consulates"):
        bits.append("at " + " / ".join(_consulate_label(c) for c in detail["consulates"][:2]))
    if detail.get("dates"):
        bits.append("similar timing on " + _humanize(detail["dates"][0]))
    if detail.get("processing"):
        bits.append("same process (" + _humanize(detail["processing"][0]) + ")")
    if detail.get("stages"):
        bits.append(_humanize(detail["stages"][0]))
    if not bits and detail.get("tags"):
        bits.append("shared " + " / ".join(detail["tags"][:2]))
    s = " · ".join(bits[:3])
    # Upper-case the first letter only — str.capitalize() would lower-case the
    # rest and turn "H-1B" into "h-1b".
    return s[:1].upper() + s[1:]


def _summary(prof: dict) -> str:
    visa = (prof.get("current_visa_or_greencard_category") or prof.get("visa_applying_for") or [])[:2]
    cons = (prof.get("consulates") or ([prof["primary_consulate"]] if prof.get("primary_consulate") else []))[:2]
    bits = [*visa, *cons]
    return " · ".join(bits) if bits else "immigration"


def list_candidate_profiles(db, exclude_id: str = "") -> list[dict]:
    """All saved user profiles (Firestore `users`), cleaned, excluding `exclude_id`."""
    if db is None:
        return []
    out: list[dict] = []
    for snap in db.collection("users").stream():
        if snap.id == exclude_id:
            continue
        data = snap.to_dict() or {}
        p = profile.clean_profile(data)
        p["user_id"] = snap.id
        p["username"] = data.get("username") or profile.username_for(snap.id)
        out.append(p)
    return out


def find_matches(db, user_id: str, criteria: dict, top_n: int = 20,
                 min_score: float = MIN_SCORE, exclude_ids: set[str] | None = None) -> list[dict]:
    """Rank other users by similarity to `criteria`. Excludes self; drops
    below-threshold/zero-overlap candidates; returns the top-N.

    `exclude_ids` is applied INSIDE the loop, before the top_n cap. That
    ordering is load-bearing: find-candidates used to cap at 20 and only then
    let the route filter out existing members, so a group with 15 members
    could show 5 candidates (or none) while plenty of good ones existed. The
    cap has to apply to the ELIGIBLE pool, which means the caller's exclusions
    have to be known here."""
    crit = _clean_criteria(criteria)
    skip = set(exclude_ids or ())
    matches: list[dict] = []
    for p in list_candidate_profiles(db, exclude_id=user_id):
        if p["user_id"] in skip:
            continue
        s = _score(crit, p)
        if s["shared"] and s["score"] >= min_score:
            matches.append({
                "user_id": p["user_id"], "username": p["username"],
                "score": s["score"], "shared": s["shared"], "summary": _summary(p),
                "background": (p.get("background_text") or "")[:280],
                "reason": _match_reason(s["shared_detail"]),
            })
    matches.sort(key=lambda m: (m["score"], m["username"]), reverse=True)
    return matches[:top_n]


# ---------------------------------------------------------------------------
# Groups — criteria-defined, joinable communities
# ---------------------------------------------------------------------------
# A group is identified by the SIGNATURE of its distinctive criteria facets
# (visa/category ∪, consulates ∪, citizen/resident country). Same signature ⇒
# same group, so users in the same boat converge into one group (join existing
# rather than duplicate). Members accumulate; a generated `name` + the criteria
# metadata are stored. Users can also browse all groups and join directly.

_COUNTRY_KEYS = profile._COUNTRY_STAGE_KEYS


def _signature(criteria: dict) -> str:
    """Stable identity from the distinctive facets (dates/free-text excluded)."""
    c = _clean_criteria(criteria)
    visa = sorted(_as_set(c["current_visa_or_greencard_category"]) | _as_set(c["visa_applying_for"]))
    cons = sorted(_as_set(c["consulates"]) | _as_set(c["primary_consulate"]))
    country = sorted({v for k, v in (c["key_stages_or_info"] or {}).items() if k in _COUNTRY_KEYS})
    return f"v:{','.join(visa)}|c:{','.join(cons)}|n:{','.join(country)}"


def _group_name(criteria: dict) -> str:
    """A human-readable name generated from the criteria, e.g. 'H-1B → EB-2 at BOM (IN)'."""
    c = _clean_criteria(criteria)
    cur, nxt = ", ".join(c["current_visa_or_greencard_category"]), ", ".join(c["visa_applying_for"])
    name = " → ".join([p for p in (cur, nxt) if p]) or "Immigration"
    cons = c["consulates"] or ([c["primary_consulate"]] if c["primary_consulate"] else [])
    if cons:
        name += " at " + "/".join(cons[:2])
    country = [v for k, v in (c["key_stages_or_info"] or {}).items() if k == "citizen_of_country"]
    if country:
        name += f" ({country[0]})"
    return name


def _resolve_scope_pair(clean_criteria: dict) -> tuple[str, str, str]:
    """(processing type, eligibility/application tag, attribute-template key)
    for a Timeline scope. Shared by the name and the description so the two
    can never disagree about what the group IS."""
    known = {*(clean_criteria.get("tags") or []),
             *(clean_criteria.get("current_visa_or_greencard_category") or [])}
    ptype = next((t["value"] for t in posting.PROCESSING_TYPES if t["value"] in known), "")
    # Every type's categories, not just EAD's: H-1B's three application types
    # must each name their own cohort, or a change-of-employer group and a
    # change-of-status group filed the same month dedup into one.
    eligibility = next((c["tag"] for c in posting.ALL_ELIGIBILITY_CATEGORIES if c["tag"] in known), "")
    tmpl_key = next((t for t in (eligibility, ptype) if t in posting.TAG_ATTRIBUTE_TEMPLATES), "")
    return ptype, eligibility, tmpl_key


def _scope_segments(clean_criteria: dict, ptype: str, eligibility: str) -> list[str]:
    """The scope rows that actually carry a value, as display segments —
    `["Mar", "2026"]`, or `["Mar", "2026", "PD", "2021-03-15"]` when a category
    scopes by priority date too. The name joins these with "-"; the description
    joins them with a space."""
    values = {"key_stages_or_info": clean_criteria.get("key_stages_or_info") or {},
              "key_dates": clean_criteria.get("key_dates") or {}}
    out: list[str] = []
    for row in posting.timeline_scope_rows(ptype, eligibility):
        val = values.get(row.get("field", "key_stages_or_info"), {}).get(row["key"], "")
        if val:
            out += [p for p in (row.get("name_prefix", ""), val) if p]
    return out


def _timeline_group_description(clean_criteria: dict) -> str:
    """A description generated from the same parameters that generate the name,
    so a creator never has to write one:

        'H-1B · Change of Status (initial, in the U.S.), filed Mar 2026.
         Members share their own petition timeline — Receipt Date (petition
         submitted), Premium Processing, Service Center and 9 more.'

    Deliberately deterministic rather than model-written: it is shown to
    everyone browsing before they join, it must be identical for two people
    creating the same cohort, and it costs nothing to produce. The labels all
    come from the live config, so a config edit rewrites the copy too.

    Returns "" for a scope that names no processing type — the caller leaves
    the field empty rather than inventing something.
    """
    ptype, eligibility, tmpl_key = _resolve_scope_pair(clean_criteria)
    if not ptype and not tmpl_key:
        return ""

    type_row = next((t for t in posting.PROCESSING_TYPES if t["value"] == ptype), None)
    head = (type_row or {}).get("label") or ptype or tmpl_key
    if eligibility and eligibility != ptype:
        cat = next((c for c in (type_row or {}).get("eligibility_categories") or []
                    if c["tag"] == eligibility), None)
        head += f" · {(cat or {}).get('label') or eligibility}"

    period = " ".join(_scope_segments(clean_criteria, ptype, eligibility))
    first = f"{head}, filed {period}." if period else f"{head}."

    # The join form's own resolver, not a guess: for H-1B the scope rows are
    # keyed by the application type while the post-join rows sit on the type,
    # so tmpl_key is the wrong key to ask with.
    rows = posting.POST_JOIN_ATTRIBUTE_TEMPLATES.get(
        _matched_post_join_type({"group_type": "timeline", "criteria_tags": clean_criteria})) or []
    if not rows:
        return f"{first} A timeline cohort — everyone here filed at the same point."
    shown = [r["label"] for r in rows[:3]]
    rest = len(rows) - len(shown)
    fields = ", ".join(shown) + (f" and {rest} more" if rest > 0 else "")
    return (f"{first} Everyone here filed at the same point, and members share "
            f"their own progress — {fields}.")


def preview_timeline_group(criteria: dict, group_type: str = "timeline") -> dict:
    """{"name", "description"} for criteria that have not been saved yet.

    Exists so the create screen can show the name the group WILL get before
    committing to it, using the very function that will name it — a client
    reimplementation would drift, and the name is load-bearing (Timeline dedup
    is name-based, so two people who see different previews for the same
    criteria would expect two groups and get one)."""
    clean = _clean_criteria(criteria)
    if group_type == "timeline":
        return {"name": _timeline_group_name(clean) or _group_name(criteria),
                "description": _timeline_group_description(clean)}
    return {"name": _group_name(criteria), "description": ""}


def _timeline_group_name(clean_criteria: dict) -> str:
    """'<processing-type>-<eligibility>-<scope values…>', e.g.
    'EAD-stem-opt-extension-Aug-2026' or, for an I-485 cohort that also scopes
    by priority date, 'EAD-adjustment-of-status-Aug-2026-PD-2021-03-15'.

    Nothing here is hardcoded per type. The two leading segments come from
    posting.PROCESSING_TYPES / EAD_ELIGIBILITY_CATEGORIES, and the trailing
    ones from posting.timeline_scope_rows() for that pair — so a category that
    configures an extra scope row automatically gets it in the name, which is
    what keeps name-based dedup honest: two AOS groups filed the same month
    with different priority dates must not collapse into one.

    A row contributes a segment only when the criteria actually carry a value
    for it, and a row's optional "name_prefix" labels that segment so adjacent
    dates stay legible. Any missing segment is simply omitted, which is what
    keeps this backwards compatible: a group created before the processing
    type was a separate concept has only the eligibility tag in its criteria
    and keeps its original name.

    Returns "" (caller falls back to _group_name()) when the criteria name
    neither a processing type nor a registered attribute template."""
    ptype, eligibility, tmpl_key = _resolve_scope_pair(clean_criteria)
    if not ptype and not tmpl_key:
        return ""

    # Don't repeat a segment when the processing type IS the template key
    # (H-1B), and don't repeat the eligibility tag if it equals the type.
    parts = [ptype, eligibility if eligibility and eligibility != ptype else ""]
    if not ptype:
        parts[1] = parts[1] or tmpl_key

    parts += _scope_segments(clean_criteria, ptype, eligibility)
    return "-".join(p for p in parts if p)


def _member_attributes_ref(db, group_id: str):
    """groups/{id}/member_attributes/{user_id} — one doc per (group, member),
    mirroring group_messages.py's groups/{id}/messages subcollection pattern.
    Shared with the group (any member can read every member's doc, see
    list_member_attributes()) and structured for future cross-member
    analysis: group_id is the parent, user_id is the doc id, so pulling
    every member's data for one group or one member's data across groups
    are both simple queries."""
    return db.collection("groups").document(group_id).collection("member_attributes")


def _matched_post_join_type(data: dict) -> str:
    """Which registered POST_JOIN_ATTRIBUTE_TEMPLATES processing type (if
    any) this Timeline group's own criteria matches — "" for Regular groups
    or a Timeline group whose processing type has no registered template
    (e.g. H-1B today). `data` may be a raw Firestore doc or a _group_view()
    dict — both carry group_type/criteria_tags in compatible shapes."""
    if (data.get("group_type") or "") != "timeline":
        return ""
    criteria = data.get("criteria_tags") or {}
    candidates = [*(criteria.get("tags") or []), *(criteria.get("current_visa_or_greencard_category") or [])]
    return next((t for t in candidates if t in posting.POST_JOIN_ATTRIBUTE_TEMPLATES), "")


def _has_submitted_attributes(db, group_id: str, user_id: str) -> bool:
    return _member_attributes_ref(db, group_id).document(user_id).get().exists


def _validate_attribute_values(matched_type: str, values: dict | None, require: bool = True) -> dict:
    """Strips `values` down to the matched type's registered keys, coerces
    each by its row "kind", and raises ValueError naming any required field
    left empty. Which rows are required is configuration — see
    posting.required_keys(), which honours an explicit "required": True and
    otherwise falls back to row 0. Every other row is optional.

    `require=False` skips only that last check — used by the CREATE path,
    where the attributes are collected on the group page afterwards via the
    needs_attributes gate rather than up front. Coercion and the select-option
    check still run, so a bad value is still a 422 wherever it comes from.

    Per kind:
      select   — anything outside the row's `options` is REJECTED (a 422, not
                 a silent drop: a value the UI shouldn't have been able to
                 produce means the client and the template have diverged, and
                 dropping it would look like a save that quietly did nothing).
      checkbox — any truthy submission normalises to CHECKBOX_ON; anything
                 falsy is omitted entirely, so unticked and never-answered are
                 the same absent key.
      date     — free-form, unchanged.
    """
    rows = posting.POST_JOIN_ATTRIBUTE_TEMPLATES.get(matched_type, [])
    by_key = {r["key"]: r for r in rows}
    _FALSY = {"", "no", "false", "0", "off", "none"}
    clean: dict = {}
    for k, v in (values or {}).items():
        row = by_key.get(k)
        if not row:
            continue
        sv = str(v if v is not None else "").strip()
        kind = row.get("kind", "date")
        if kind == "checkbox":
            if sv.lower() not in _FALSY:
                clean[k] = posting.CHECKBOX_ON
            continue
        if not sv:
            continue
        if kind == "select" and sv not in (row.get("options") or []):
            raise ValueError(f'"{sv}" is not a valid {row["label"]}.')
        clean[k] = sv
    if require:
        for key in posting.required_keys(rows):
            if not clean.get(key):
                raise ValueError(f'"{by_key[key]["label"]}" is required to join this group.')
    return clean


def _write_member_attributes(db, group_id: str, user_id: str, username: str,
                             matched_type: str, clean_values: dict, notes: str) -> None:
    """Upserts groups/{id}/member_attributes/{user_id} (shared with the
    group) and merges the values into the user's own profile (personal
    record; profile.tags deliberately excludes 1.6 vocab like the
    processing-type tag itself and that boundary isn't reopened here).

    Each value goes to the profile field its TEMPLATE ROW declares — dates to
    key_dates, everything else (status, service center, the checkboxes) to
    key_stages_or_info. This used to post the whole dict to key_dates, which
    was correct only while every row was a date; once selects and checkboxes
    were added, clean_stages_profile()/clean_dates_profile() would have
    silently dropped the misfiled half on save."""
    now = _now_iso()
    ref = _member_attributes_ref(db, group_id).document(user_id)
    existed = ref.get().exists
    doc = {
        "user_id": user_id, "username": username, "processing_type": matched_type,
        "values": clean_values, "notes": str(notes or "")[:1000], "updated_at": now,
    }
    if not existed:
        doc["submitted_at"] = now
    ref.set(doc, merge=True)
    if not clean_values:
        return
    by_field: dict[str, dict] = {}
    for row in posting.POST_JOIN_ATTRIBUTE_TEMPLATES.get(matched_type, []):
        if row["key"] in clean_values:
            by_field.setdefault(row.get("field") or "key_dates", {})[row["key"]] = clean_values[row["key"]]
    if not by_field:
        return
    current = profile.get_profile(db, user_id)
    patch = {**current}
    for field, vals in by_field.items():
        patch[field] = {**(current.get(field) or {}), **vals}
    profile.save_profile(db, user_id, profile.merge_profile(current, patch))


def compute_needs_attributes(db, group_id: str, data: dict, viewer_id: str) -> bool:
    """True only when: Timeline group, a registered processing-type template
    matches the group's own criteria, the viewer is a member, and they have
    no submitted (or grandfathered) attributes doc yet. Computed fresh on
    every read — not an event-driven flag — so it correctly reflects a
    member added via invite (who never clicks Join) just as much as one who
    joined themselves."""
    if not viewer_id:
        return False
    matched = _matched_post_join_type(data)
    if not matched:
        return False
    if not any(m.get("user_id") == viewer_id for m in (data.get("members") or [])):
        return False
    return not _has_submitted_attributes(db, group_id, viewer_id)


def save_member_attributes(db, group_id: str, user_id: str, values: dict | None, notes: str = "") -> dict:
    """A current member submits (or updates) their post-join attributes —
    the path for someone added via invite (or anyone revisiting to fill the
    mandatory gate in). PermissionError if not a member, ValueError if the
    group has no registered template (shouldn't be reachable from the UI,
    keeps this safe standalone), KeyError if the group doesn't exist."""
    if db is None:
        raise RuntimeError("Firestore unavailable")
    ref = db.collection("groups").document(group_id)
    snap = ref.get()
    if not snap.exists:
        raise KeyError("Group not found.")
    data = snap.to_dict() or {}
    members = data.get("members") or []
    if user_id not in {m.get("user_id") for m in members}:
        raise PermissionError("Only group members can submit attributes.")
    matched = _matched_post_join_type(data)
    if not matched:
        raise ValueError("This group has no registered attribute template.")
    clean_values = _validate_attribute_values(matched, values)
    username = next((m.get("username", "") for m in members if m.get("user_id") == user_id), "")
    _write_member_attributes(db, group_id, user_id, username, matched, clean_values, notes)
    return _group_view(group_id, data, user_id)


def list_member_attributes(db, group_id: str, viewer_id: str) -> list[dict]:
    """Members-only — every member's submitted attributes. This is the
    "shared with the group" surface: any member can see the whole cohort's
    timelines, not just their own."""
    if db is None:
        return []
    ref = db.collection("groups").document(group_id)
    snap = ref.get()
    if not snap.exists:
        raise KeyError("Group not found.")
    data = snap.to_dict() or {}
    if viewer_id not in {m.get("user_id") for m in (data.get("members") or [])}:
        raise PermissionError("Only group members can view shared attributes.")
    return [d.to_dict() or {} for d in _member_attributes_ref(db, group_id).stream()]


# ---------------------------------------------------------------------------
# Invitations — nobody joins a group without agreeing to
# ---------------------------------------------------------------------------

INVITATION_STATUSES = ("pending", "accepted", "declined", "cancelled")

# Cheap breadth ceiling so one member can't spray a whole userbase. Note this
# bounds how MANY people a group can have outstanding, not how often one
# person can be re-invited after declining — declined_count is on the doc if
# a repetition guard is ever wanted.
MAX_PENDING_INVITES_PER_GROUP = 100


def _invitation_id(group_id: str, user_id: str) -> str:
    """Composite doc id — mirrors interactions._vote_id()'s
    votes/{content_id}__{user_id}. Deterministic so that (a) "does this user
    have an invite to this group?" is an O(1) point read with no query, and
    (b) two members inviting the same person concurrently converge on ONE doc
    via set(merge=True) instead of racing to create duplicates — no
    transaction needed."""
    return f"{group_id}__{user_id}"


def _invitations_ref(db):
    """The top-level group_invitations collection.

    Top-level rather than a groups/{id}/invitations subcollection because BOTH
    reads are needed — "every invite for this group" (list_pending_invitations
    _for_group) and "every invite addressed to me, across groups"
    (list_pending_invitations_for_user, which feeds the Groups tab). The
    per-user read from a subcollection needs a collection-group query, which
    requires a COLLECTION_GROUP-scoped Firestore index; this repo has no
    index config and no step that would deploy one, so that would fail at
    runtime as an opaque 503. A top-level collection filtered on one equality
    field is served by Firestore's automatic single-field index.

    Status is filtered in Python, matching list_all_groups()'s convention."""
    return db.collection("group_invitations")


def _reinvite_action(existing: dict | None, is_member: bool) -> str:
    """PURE decision table for what an invite attempt should do — extracted so
    the trickiest semantics are unit-testable without Firestore (same spirit
    as _validate_attribute_values / _effective_status).

      "block_member" — already in members            → caller raises ValueError
      "noop_pending" — a pending invite already exists → idempotent refresh
      "revive"       — declined/cancelled, or accepted-then-left → back to pending
      "create"       — no doc yet
    """
    if is_member:
        return "block_member"
    if not existing:
        return "create"
    return "noop_pending" if (existing.get("status") or "") == "pending" else "revive"


def _invitation_view(doc_id: str, data: dict, requires_attributes: bool = False) -> dict:
    """Client-facing invitation shape. Exposes nothing the group card doesn't
    already expose. `requires_attributes` means "accepting will demand the
    post-join form" — NOT the same as GroupCard.needs_attributes, which is
    member-scoped and so always False for someone who hasn't accepted yet."""
    return {
        "invitation_id": doc_id,
        "group_id": data.get("group_id") or "",
        "group_name": data.get("group_name") or "",
        "user_id": data.get("user_id") or "",
        "username": data.get("username") or "",
        "invited_by": data.get("invited_by") or "",
        "invited_by_username": data.get("invited_by_username") or "",
        "status": data.get("status") or "pending",
        "requires_attributes": bool(requires_attributes),
        "created_at": data.get("created_at") or "",
        "responded_at": data.get("responded_at") or "",
    }


def create_invitation(db, group_id: str, inviter_id: str, invitee_id: str,
                      username: str = "") -> dict:
    """Create (or revive) a PENDING invitation. The single primitive behind
    every add-path — invite_member(), add_members() and find_or_create_group()'s
    peers all funnel through here, so the guards below can't be bypassed by
    picking a different door.

    Raises, in order:
      KeyError        — group not found
      ValueError      — group isn't active. This closes a real pre-existing
                        gap: join_group() has always refused archived/expired
                        groups but invite_member() never did, so you could be
                        added to a dead group.
      PermissionError — inviter isn't a member
      ValueError      — self-invite / unknown invitee / already a member /
                        the group is at MAX_PENDING_INVITES_PER_GROUP

    Idempotent: an existing pending invite is refreshed (created_at
    preserved), not duplicated or rejected. A declined/cancelled one — or an
    accepted one for someone who has since left — is revived to pending with
    declined_count carried forward.

    Never touches groups/{id}.members; that only happens on accept."""
    if db is None:
        raise RuntimeError("Firestore unavailable")
    ref = db.collection("groups").document(group_id)
    snap = ref.get()
    if not snap.exists:
        raise KeyError("Group not found.")
    data = snap.to_dict() or {}
    if _effective_status(data) != "active":
        raise ValueError("This group is no longer accepting new members.")
    members = data.get("members") or []
    member_ids = {m.get("user_id") for m in members}
    if inviter_id not in member_ids:
        raise PermissionError("Only group members can invite others.")
    if not invitee_id:
        raise ValueError("A user is required to invite.")
    if invitee_id == inviter_id:
        raise ValueError("You're already in this group.")
    if not db.collection("users").document(invitee_id).get().exists:
        raise ValueError("That user doesn't exist.")

    inv_ref = _invitations_ref(db).document(_invitation_id(group_id, invitee_id))
    existing_snap = inv_ref.get()
    existing = existing_snap.to_dict() if existing_snap.exists else None
    action = _reinvite_action(existing, invitee_id in member_ids)
    if action == "block_member":
        raise ValueError("That person is already in this group.")
    if action == "create" and len(pending_invitee_ids(db, group_id)) >= MAX_PENDING_INVITES_PER_GROUP:
        raise ValueError("This group has too many outstanding invitations.")

    now = _now_iso()
    doc = {
        "group_id": group_id,
        "group_name": data.get("name") or "",
        "user_id": invitee_id,
        "username": username or profile.handle_for(db, invitee_id),
        "invited_by": inviter_id,
        "invited_by_username": next((m.get("username", "") for m in members
                                     if m.get("user_id") == inviter_id), ""),
        "status": "pending",
        "cancel_reason": "",
        "declined_count": int((existing or {}).get("declined_count") or 0),
        "created_at": (existing or {}).get("created_at") or now,
        "updated_at": now,
        "responded_at": "",
    }
    inv_ref.set(doc, merge=True)
    ref.update({"last_activity_at": now})
    return _invitation_view(inv_ref.id, doc)


def accept_invitation(db, group_id: str, user_id: str,
                      values: dict | None = None, notes: str = "") -> dict:
    """Accept a pending invitation → actually become a member.

    DELEGATES to join_group(), deliberately: join_group already encapsulates
    the active-status check, the matched-template lookup, the
    _has_submitted_attributes short-circuit, _validate_attribute_values BEFORE
    any mutation, the _dedupe_members write, the last_activity_at bump and
    _write_member_attributes (including the profile.key_dates merge).
    Re-implementing that ordering here would duplicate subtle sequencing and
    guarantee drift. It also means accepting runs the SAME post-join attribute
    gate as joining — which is how an invited user finally gets to enter their
    own details instead of being silently added.

    Raises KeyError (no invitation), ValueError (already declined/cancelled,
    dead group, or the required attribute is missing — the last is retryable).

    NOTE: on a group that died after the invite was sent, this MUTATES (marks
    the invitation cancelled) and THEN raises. That's intentional and
    self-healing — don't "fix" it. Checking _effective_status here rather than
    sniffing join_group's error string is what lets a permanently-dead group
    be told apart from a merely-incomplete form, since both are ValueError."""
    if db is None:
        raise RuntimeError("Firestore unavailable")
    inv_ref = _invitations_ref(db).document(_invitation_id(group_id, user_id))
    inv_snap = inv_ref.get()
    if not inv_snap.exists:
        raise KeyError("Invitation not found.")
    inv = inv_snap.to_dict() or {}
    status = inv.get("status") or "pending"

    group_snap = db.collection("groups").document(group_id).get()
    if not group_snap.exists:
        raise KeyError("Group not found.")
    group_data = group_snap.to_dict() or {}

    if status == "accepted":
        # Double-tap safety: if they really are a member, this is a no-op.
        if user_id in {m.get("user_id") for m in (group_data.get("members") or [])}:
            return _group_view(group_id, group_data, user_id)
    elif status in ("declined", "cancelled"):
        raise ValueError("This invitation is no longer available.")

    if _effective_status(group_data) != "active":
        now = _now_iso()
        inv_ref.set({"status": "cancelled", "cancel_reason": "group_inactive",
                     "updated_at": now, "responded_at": now}, merge=True)
        raise ValueError("This group is no longer accepting new members.")

    g = join_group(db, group_id, user_id, values, notes)  # ValueError → 422, retryable
    now = _now_iso()
    inv_ref.set({"status": "accepted", "updated_at": now, "responded_at": now}, merge=True)
    return g


def decline_invitation(db, group_id: str, user_id: str) -> dict:
    """Decline a pending invitation.

    NEVER touches groups/{id}.members and NEVER calls leave_group(). The
    invitee was never a member so there is nothing to remove — and routing a
    decline through leave_group() would hit its last-member branch and
    SOFT-DELETE the group. A one-member group whose only invitee declines has
    to stay alive.

    Idempotent on an already-declined invitation. Raises KeyError (not found)
    or ValueError (already accepted — leave the group instead; or cancelled)."""
    if db is None:
        raise RuntimeError("Firestore unavailable")
    inv_ref = _invitations_ref(db).document(_invitation_id(group_id, user_id))
    snap = inv_ref.get()
    if not snap.exists:
        raise KeyError("Invitation not found.")
    inv = snap.to_dict() or {}
    status = inv.get("status") or "pending"
    if status == "declined":
        return _invitation_view(inv_ref.id, inv)
    if status == "accepted":
        raise ValueError("You've already joined this group. Leave the group instead.")
    if status == "cancelled":
        raise ValueError("This invitation is no longer available.")
    now = _now_iso()
    updates = {"status": "declined", "updated_at": now, "responded_at": now,
               "declined_count": int(inv.get("declined_count") or 0) + 1}
    inv_ref.set(updates, merge=True)
    return _invitation_view(inv_ref.id, {**inv, **updates})


def pending_invitee_ids(db, group_id: str) -> set[str]:
    """Just the uids with a pending invite to this group — the cheap set used
    to exclude them from find-candidates so the UI stops re-offering someone
    whose invitation is already outstanding. Permission-free (internal); the
    caller has already authorized."""
    if db is None:
        return set()
    from google.cloud.firestore_v1.base_query import FieldFilter
    docs = _invitations_ref(db).where(filter=FieldFilter("group_id", "==", group_id)).stream()
    return {d.get("user_id") for doc in docs
            if (d := doc.to_dict() or {}).get("status") == "pending" and d.get("user_id")}


def list_pending_invitations_for_group(db, group_id: str, viewer_id: str) -> list[dict]:
    """Every pending invitation for one group, newest first. Members-only —
    same contract as list_member_attributes(): KeyError → 404,
    PermissionError → 403. Any member can see it because any member can invite.

    Display only: "don't re-invite" is enforced server-side by
    create_invitation()'s idempotency, not by the client reading this.

    Members are DROPPED at read time, mirroring
    list_pending_invitations_for_user(). An invitee who joins via the join
    preview or a shared link never goes through accept_invitation(), so their
    invitation stays `pending` forever — without this filter the sidebar would
    list the same person under both "Members" and "Invited · awaiting reply"."""
    if db is None:
        return []
    snap = db.collection("groups").document(group_id).get()
    if not snap.exists:
        raise KeyError("Group not found.")
    data = snap.to_dict() or {}
    member_ids = {m.get("user_id") for m in (data.get("members") or [])}
    if viewer_id not in member_ids:
        raise PermissionError("Only group members can view invitations.")
    from google.cloud.firestore_v1.base_query import FieldFilter
    out = [_invitation_view(doc.id, d) for doc in
           _invitations_ref(db).where(filter=FieldFilter("group_id", "==", group_id)).stream()
           if (d := doc.to_dict() or {}).get("status") == "pending"
           and d.get("user_id") not in member_ids]
    out.sort(key=lambda i: i.get("created_at", ""), reverse=True)
    return out


def list_pending_invitations_for_user(db, user_id: str) -> list[dict]:
    """Every pending invitation addressed to this user, across all groups,
    newest first — the Groups-tab "pending invitations" section. Returns
    [{"invitation": ..., "group": <viewer-scoped _group_view>}].

    The group is hydrated LIVE with a single batched db.get_all() over the
    distinct refs (the interactions.py:127 pattern), and an entry is DROPPED
    when the group is gone, isn't active, or the user is somehow already a
    member. That read-time filter is what makes this correct with no cron and
    no cleanup job — the same philosophy as _effective_status() computing
    expiry on read — and it self-heals the two non-atomic windows in this
    design (invite-vs-join, and a crash between join_group() and the accept
    status flip)."""
    if db is None:
        return []
    from google.cloud.firestore_v1.base_query import FieldFilter
    invites = [(doc.id, d) for doc in
               _invitations_ref(db).where(filter=FieldFilter("user_id", "==", user_id)).stream()
               if (d := doc.to_dict() or {}).get("status") == "pending"]
    if not invites:
        return []
    group_ids = list(dict.fromkeys(d.get("group_id") for _, d in invites if d.get("group_id")))
    refs = [db.collection("groups").document(gid) for gid in group_ids]
    groups = {s.id: (s.to_dict() or {}) for s in db.get_all(refs) if s.exists}

    out: list[dict] = []
    for doc_id, inv in invites:
        data = groups.get(inv.get("group_id") or "")
        if not data or _effective_status(data) != "active":
            continue
        if user_id in {m.get("user_id") for m in (data.get("members") or [])}:
            continue
        matched = _matched_post_join_type(data)
        requires = bool(matched) and not _has_submitted_attributes(db, inv["group_id"], user_id)
        out.append({
            "invitation": _invitation_view(doc_id, inv, requires_attributes=requires),
            "group": _group_view(inv["group_id"], data, user_id),
        })
    out.sort(key=lambda e: e["invitation"].get("created_at", ""), reverse=True)
    return out


def _cancel_group_invitations(db, group_id: str, reason: str) -> int:
    """Best-effort: flip every pending invitation for a group to "cancelled".
    Called when a group is deleted (directly, or by its last member leaving).
    Not strictly required — list_pending_invitations_for_user()'s read-time
    filter already hides them — but it keeps the collection honest and the
    group-scoped list correct.

    Deliberately NOT called from archive_group(): archiving is reversible, so
    cancelling there would be an unrecoverable side effect of a recoverable
    action. Archived groups' invitations are hidden by the read filter and
    come back if the group is un-archived."""
    if db is None:
        return 0
    from google.cloud.firestore_v1.base_query import FieldFilter
    now = _now_iso()
    n = 0
    for doc in _invitations_ref(db).where(filter=FieldFilter("group_id", "==", group_id)).stream():
        if (doc.to_dict() or {}).get("status") != "pending":
            continue
        doc.reference.set({"status": "cancelled", "cancel_reason": reason,
                           "updated_at": now, "responded_at": now}, merge=True)
        n += 1
    return n


def _member(db, user_id: str, username: str = "") -> dict:
    return {"user_id": str(user_id), "username": username or profile.handle_for(db, user_id)}


def _dedupe_members(db, members: list[dict]) -> list[dict]:
    seen: set[str] = set()
    out: list[dict] = []
    for m in members:
        uid = str(m.get("user_id") or "")
        if uid and uid not in seen:
            seen.add(uid)
            out.append({"user_id": uid, "username": str(m.get("username") or profile.handle_for(db, uid))})
    return out


def _find_by_signature(db, sig: str, group_type: str = ""):
    """group_type is part of the lookup key, not just `signature` — two
    groups of DIFFERENT types can share the same (often empty) coarse
    signature (e.g. a tags-only Regular group and a Timeline group with no
    Cycle/Year picked yet both compute "v:|c:|n:"), and must never be
    treated as the same group just because their signatures coincide."""
    from google.cloud.firestore_v1.base_query import FieldFilter
    docs = list(db.collection("groups")
                .where(filter=FieldFilter("signature", "==", sig))
                .where(filter=FieldFilter("group_type", "==", group_type or ""))
                .limit(1).stream())
    return docs[0] if docs else None


def _find_group_by_name(db, name: str, group_type: str):
    """Create-time dedup by name (indexed group_type+name equality query).
    A Timeline group's name is auto-generated as <processing-type>-<cycle>-
    <year> (_timeline_group_name()) and, per this feature, can never be
    renamed — so it's a stable, authoritative identity: two creates with the
    same processing type/cycle/year always produce the same name and
    correctly collide, even if one of them also carries some incidental
    unrelated tag the old full-criteria comparison would have treated as a
    difference. Timeline-only — Regular groups keep the coarser
    _find_by_signature() path, unaffected.

    No `.limit(1)` here deliberately: Firestore's equality-query result order
    is unspecified, so once ANY dead (archived/deleted) group ever existed
    under this name, a naive limit(1) could keep returning that dead doc
    forever and silently defeat dedup for every later create — an active
    match must be preferred over whichever doc happens to sort first."""
    from google.cloud.firestore_v1.base_query import FieldFilter
    docs = list(db.collection("groups")
                .where(filter=FieldFilter("group_type", "==", group_type))
                .where(filter=FieldFilter("name", "==", name))
                .stream())
    active = [d for d in docs if _effective_status(d.to_dict() or {}) == "active"]
    docs = active or docs
    return docs[0] if docs else None


def _effective_status(data: dict) -> str:
    """The stored status, except an "active" group whose expiration_date has
    already passed is reported as "archived" — computed on read, not written
    (no cron/scheduled-job infra in this repo for group lifecycle). Groups
    created before this lifecycle field existed have the old hardcoded
    "formed" status — normalized to "active" here so pre-existing groups
    aren't silently excluded from search/join or shown a meaningless raw
    "formed" badge."""
    status = data.get("status") or "active"
    if status == "formed":
        status = "active"
    expiration_date = data.get("expiration_date") or ""
    if status == "active" and expiration_date and expiration_date < _now_iso():
        return "archived"
    return status


def _group_view(doc_id: str, data: dict, viewer_id: str, joined: bool = False) -> dict:
    members = data.get("members") or []
    created_by = data.get("created_by") or ""
    created_by_username = next((m.get("username", "") for m in members if m.get("user_id") == created_by), "")
    return {
        "group_id": doc_id,
        "name": data.get("name") or "",
        "description": data.get("description") or "",
        "group_type": data.get("group_type") or "",
        "criteria_text": data.get("criteria_text") or "",
        "criteria_tags": data.get("criteria_tags") or {},
        "members": members,
        "created_by": created_by,
        "created_by_username": created_by_username,
        "is_admin": bool(viewer_id) and viewer_id == created_by,
        "status": _effective_status(data),
        "expiration_date": data.get("expiration_date") or "",
        "created_at": data.get("created_at") or "",
        "last_activity_at": data.get("last_activity_at") or data.get("created_at") or "",
        "is_member": any(m.get("user_id") == viewer_id for m in members),
        "joined": joined,
    }


def _exact_match(criteria: dict, group_criteria: dict) -> bool:
    """Timeline-group matching: every category the searcher actually filled in
    must equal (as a set) the group's stored value for that category. A
    category the searcher left empty imposes no constraint. One-directional
    by design (used by search_groups(), where the searcher's asks are what
    matters); _find_timeline_duplicate() calls this in both directions for
    full-equality create-time dedup. Regular-group create-time dedup still
    uses the coarser _signature()/_find_by_signature() — unaffected."""
    checks = [
        (_as_set(criteria.get("current_visa_or_greencard_category")) | _as_set(criteria.get("visa_applying_for")),
         _as_set(group_criteria.get("current_visa_or_greencard_category")) | _as_set(group_criteria.get("visa_applying_for"))),
        (_as_set(criteria.get("consulates")) | _as_set(criteria.get("primary_consulate")),
         _as_set(group_criteria.get("consulates")) | _as_set(group_criteria.get("primary_consulate"))),
        (_as_set(criteria.get("tags")), _as_set(group_criteria.get("tags"))),
    ]
    if not all(c_set == g_set for c_set, g_set in checks if c_set):  # only compare non-empty asks
        return False
    # key_stages_or_info / key_dates: exact per-key equality, only for keys
    # the searcher actually specified — same "no constraint if unspecified"
    # rule as the set-based checks above.
    c_st = criteria.get("key_stages_or_info") or {}
    g_st = group_criteria.get("key_stages_or_info") or {}
    if c_st and not all(g_st.get(k) == v for k, v in c_st.items()):
        return False
    c_dt = criteria.get("key_dates") or {}
    g_dt = group_criteria.get("key_dates") or {}
    if c_dt and not all(g_dt.get(k) == v for k, v in c_dt.items()):
        return False
    return True


def _parse_iso(s) -> datetime | None:
    """Parse an ISO-8601 timestamp string (as stored by _now_iso()) to an
    aware datetime, or None if blank/malformed."""
    try:
        return datetime.fromisoformat(str(s))
    except (ValueError, TypeError):
        return None


def _within_age(created_at, max_age_days: int) -> bool:
    """True if `created_at` (ISO string) is within max_age_days of now, or if
    max_age_days is 0 ("All time" — no restriction)."""
    if max_age_days <= 0:
        return True
    dt = _parse_iso(created_at)
    if dt is None:
        return False
    return (datetime.now(timezone.utc) - dt).days <= max_age_days


def search_groups(db, criteria: dict, group_type: str = "", precision: str = "balanced",
                   max_age_days: int = 0, top_n: int = 20) -> list[dict]:
    """Search existing groups by criteria — the counterpart to find_matches()
    but over `groups`, not user profiles. Regular groups (group_type=""): a
    ranked tag-overlap score, thresholded by `precision`. Timeline groups
    (group_type="timeline"): _exact_match() only — `precision` is ignored,
    since an exact match has no gradation. max_age_days (0 = all time)
    filters both by the group's own creation recency."""
    if db is None:
        return []
    crit = _clean_criteria(criteria)
    min_score = PRECISION_MIN_SCORE.get(precision, MIN_SCORE)
    out: list[dict] = []
    for snap in db.collection("groups").stream():
        data = snap.to_dict() or {}
        if (data.get("group_type") or "") != (group_type or ""):
            continue
        if _effective_status(data) != "active":
            continue
        if not _within_age(data.get("created_at"), max_age_days):
            continue
        group_criteria = data.get("criteria_tags") or {}
        if group_type == "timeline":
            if not _exact_match(crit, group_criteria):
                continue
            view = _group_view(snap.id, data, "")
        else:
            s = _score(crit, group_criteria)
            if not (s["shared"] and s["score"] >= min_score):
                continue
            view = {**_group_view(snap.id, data, ""), "score": s["score"], "shared": s["shared"]}
        out.append(view)
    if group_type == "timeline":
        out.sort(key=lambda g: g.get("created_at", ""), reverse=True)
    else:
        out.sort(key=lambda g: (g.get("score", 0), g.get("name", "")), reverse=True)
    return out[:top_n]


def find_or_create_group(db, user_id: str, criteria_text: str, criteria: dict,
                         members: list[dict] | None = None, group_type: str = "",
                         description: str = "", validity: str = "",
                         values: dict | None = None, notes: str = "") -> dict:
    """Join the existing group for this criteria signature, or create it. The
    acting user is always added; provided peers are added too. `joined`=True when
    an existing group was joined rather than created. `group_type` ("" = regular,
    "timeline" = Timeline Group), `description` and `validity` are only used
    when creating — joining an existing group keeps its own type/description/
    expiration.

    Dedup lookup: Regular groups use _signature() (coarse visa/consulate/
    country overlap — by design, a Regular group is about "same boat", not
    "identical facts"). Timeline groups use _find_group_by_name() — a
    Timeline group's name is auto-generated from processing type/cycle/year
    and can never be renamed, so it's the authoritative identity (see that
    function's docstring). Either way, a match that's archived or deleted is
    treated as not found — dead groups are never silently rejoined; a fresh
    group is created instead.

    `validity` selects the expiration_date: one of TIMELINE_VALIDITY_OPTIONS
    for Timeline groups, or REGULAR_VALIDITY_OPTIONS for Regular groups
    (which is a superset). Defaults to "1_year" if omitted. Raises ValueError
    for a validity string that isn't offered for this group_type.

    `values`/`notes`: if the resulting group (new or matched) is a Timeline
    group with a registered post-join attribute template and the acting user
    hasn't already submitted attributes for it, the required field (see
    POST_JOIN_ATTRIBUTE_TEMPLATES's docstring) must be present in `values` —
    raises ValueError otherwise. This applies to the creator of a brand new
    group too (they become its first member) as much as to someone whose
    criteria happened to match an existing group — "create" and "join" are
    the same membership action from this requirement's point of view."""
    if db is None:
        raise RuntimeError("Firestore unavailable")
    sig = _signature(criteria)
    clean_criteria = _clean_criteria(criteria)
    # Only the ACTING user becomes a member — creating (or joining) is
    # consenting. Any peers passed in are INVITED instead, below, once the
    # group exists and the acting user is in it (create_invitation requires a
    # member inviter, so the ordering is load-bearing).
    to_add = _dedupe_members(db, [_member(db, user_id)])
    peer_ids = [m.get("user_id") for m in _dedupe_members(db, members or [])
                if m.get("user_id") and m.get("user_id") != user_id]

    if group_type == "timeline":
        name = _timeline_group_name(clean_criteria) or _group_name(criteria)
        existing = _find_group_by_name(db, name, "timeline")
    else:
        name = _group_name(criteria)
        existing = _find_by_signature(db, sig, group_type)
    if existing is not None and _effective_status(existing.to_dict() or {}) != "active":
        existing = None
    if existing is not None:
        data = existing.to_dict() or {}
        matched = _matched_post_join_type(data)
        clean_values: dict = {}
        if matched and not _has_submitted_attributes(db, existing.id, user_id):
            clean_values = _validate_attribute_values(matched, values)
        merged = _dedupe_members(db, [*(data.get("members") or []), *to_add])
        now = _now_iso()
        existing.reference.update({"members": merged, "updated_at": now, "last_activity_at": now})
        if matched and clean_values:
            username = next((m.get("username", "") for m in merged if m.get("user_id") == user_id), "")
            _write_member_attributes(db, existing.id, user_id, username, matched, clean_values, notes)
        view = _group_view(existing.id, {**data, "members": merged, "last_activity_at": now}, user_id, joined=True)
        view["invited"] = _invite_peers(db, existing.id, user_id, peer_ids)
        return view

    validity = validity or "1_year"
    allowed_validity = TIMELINE_VALIDITY_OPTIONS if group_type == "timeline" else REGULAR_VALIDITY_OPTIONS
    if validity not in allowed_validity:
        raise ValueError(f'Invalid group validity "{validity}" for this group type.')
    expiration_date = (datetime.now(timezone.utc) + timedelta(days=_VALIDITY_DAYS[validity])).isoformat()

    now = _now_iso()
    doc = {
        "name": name,
        "description": str(description or "")[:500],
        "group_type": group_type or "",
        "signature": sig,
        "criteria_text": str(criteria_text or "")[:2000],
        "criteria_tags": clean_criteria,
        "members": to_add,
        "created_by": user_id,
        "status": "active",
        "expiration_date": expiration_date,
        "created_at": now,
        "updated_at": now,
        "last_activity_at": now,
    }
    # Creating a brand-new group does NOT demand the attributes up front.
    #
    # It used to: the creator went through the same _validate_attribute_values()
    # gate as a joiner, so Create was disabled until they'd filled the required
    # field on the find/create panel. Those fields have moved off that panel
    # entirely — they belong to JOINING, not to defining a cohort — so the
    # creator is instead gated the moment they land on the group page, by the
    # `needs_attributes` flag that already exists for exactly this purpose
    # (compute_needs_attributes returns True for a member with no attributes
    # doc, which a fresh creator is). Nothing is lost: the same required field
    # is still collected before they can use the group, just one screen later.
    #
    # Anything the caller DOES send is still validated and stored, so a client
    # that collects them early keeps working.
    matched = _matched_post_join_type(doc)
    clean_values = _validate_attribute_values(matched, values, require=False) if matched else {}
    ref = db.collection("groups").document()
    ref.set(doc)
    if matched and clean_values:
        username = next((m.get("username", "") for m in to_add if m.get("user_id") == user_id), "")
        _write_member_attributes(db, ref.id, user_id, username, matched, clean_values, notes)
    view = _group_view(ref.id, doc, user_id, joined=False)
    view["invited"] = _invite_peers(db, ref.id, user_id, peer_ids)
    return view


def _invite_peers(db, group_id: str, inviter_id: str, peer_ids: list[str]) -> list[dict]:
    """Invite the peers passed to find_or_create_group(). Best-effort per
    peer — one bad uid must not fail the whole group creation, which has
    already succeeded by the time this runs."""
    out: list[dict] = []
    for uid in peer_ids:
        try:
            out.append(create_invitation(db, group_id, inviter_id, uid))
        except (ValueError, PermissionError, KeyError):
            continue
    return out


def join_group(db, group_id: str, user_id: str, values: dict | None = None, notes: str = "") -> dict:
    """Add the user to an existing group (browse → join). Raises ValueError
    if the group is archived (manually or by expiration) or deleted —
    neither accepts new members. If this is a Timeline group with a
    registered post-join attribute template and the user hasn't already
    submitted attributes for it, the required field must be present in
    `values` — raised as ValueError (→ 422) BEFORE the member is added, a
    real join-time gate, not a post-hoc nag."""
    if db is None:
        raise RuntimeError("Firestore unavailable")
    ref = db.collection("groups").document(group_id)
    snap = ref.get()
    if not snap.exists:
        raise KeyError("Group not found.")
    data = snap.to_dict() or {}
    if _effective_status(data) != "active":
        raise ValueError("This group is no longer accepting new members.")
    matched = _matched_post_join_type(data)
    clean_values: dict = {}
    if matched and not _has_submitted_attributes(db, group_id, user_id):
        clean_values = _validate_attribute_values(matched, values)
    members = _dedupe_members(db, [*(data.get("members") or []), _member(db, user_id)])
    now = _now_iso()
    ref.update({"members": members, "updated_at": now, "last_activity_at": now})
    if matched and clean_values:
        username = next((m.get("username", "") for m in members if m.get("user_id") == user_id), "")
        _write_member_attributes(db, group_id, user_id, username, matched, clean_values, notes)
    return _group_view(group_id, {**data, "members": members, "last_activity_at": now}, user_id, joined=True)


_MAX_NAME_LEN = 100
_MAX_DESCRIPTION_LEN = 500


def rename_group(db, group_id: str, user_id: str, name: str | None = None,
                 description: str | None = None) -> dict:
    """Update a group's name and/or description. Creator-only — raises
    PermissionError otherwise (→ 403 at the route), KeyError if the group
    doesn't exist (→ 404). Only the field(s) actually provided are changed.
    A Timeline group's name is auto-generated from processing type/cycle/
    year and is now the authoritative identity for dedup
    (_find_group_by_name()) — renaming it is rejected (ValueError → 422);
    its description remains editable."""
    if db is None:
        raise RuntimeError("Firestore unavailable")
    ref = db.collection("groups").document(group_id)
    snap = ref.get()
    if not snap.exists:
        raise KeyError("Group not found.")
    data = snap.to_dict() or {}
    if user_id != (data.get("created_by") or ""):
        raise PermissionError("Only the group's creator can rename it.")
    if name is not None and (data.get("group_type") or "") == "timeline":
        raise ValueError("Timeline group names are set automatically and can't be changed.")
    updates: dict = {"updated_at": _now_iso()}
    if name is not None:
        clean_name = name.strip()[:_MAX_NAME_LEN]
        if not clean_name:
            raise ValueError("Name cannot be empty.")
        updates["name"] = clean_name
    if description is not None:
        updates["description"] = description.strip()[:_MAX_DESCRIPTION_LEN]
    ref.update(updates)
    return _group_view(group_id, {**data, **updates}, user_id)


def archive_group(db, group_id: str, user_id: str, archived: bool) -> dict:
    """Toggle a group between "active" and "archived". Creator-only — raises
    PermissionError otherwise (→ 403), KeyError if the group doesn't exist
    (→ 404), ValueError if it's already deleted (→ 422). Archiving stops new
    joins/search visibility but doesn't affect existing members. Note:
    unarchiving a group whose expiration_date has already passed is a no-op
    from the caller's point of view — _effective_status() still reports
    "archived" until expiration_date itself changes, and there's no "edit
    expiration" UI in this pass."""
    if db is None:
        raise RuntimeError("Firestore unavailable")
    ref = db.collection("groups").document(group_id)
    snap = ref.get()
    if not snap.exists:
        raise KeyError("Group not found.")
    data = snap.to_dict() or {}
    if user_id != (data.get("created_by") or ""):
        raise PermissionError("Only the group's creator can archive it.")
    if (data.get("status") or "active") == "deleted":
        raise ValueError("This group has been deleted.")
    updates = {"status": "archived" if archived else "active", "updated_at": _now_iso()}
    ref.update(updates)
    return _group_view(group_id, {**data, **updates}, user_id)


def invite_member(db, group_id: str, user_id: str, handle: str) -> dict:
    """A current member invites someone they know by handle. Creates a PENDING
    invitation — the invitee has to accept before they become a member.

    Returns the INVITATION, not a group card: the group provably hasn't
    changed, and returning a group card from an operation that didn't change
    the group is exactly what produces optimistic-UI bugs (a member rendered
    who isn't one).

    KeyError (group missing) → 404; PermissionError (not a member) → 403;
    ValueError (unknown handle, inactive group, already a member, self) → 422."""
    if db is None:
        raise RuntimeError("Firestore unavailable")
    from google.cloud.firestore_v1.base_query import FieldFilter
    clean_handle = (handle or "").strip()
    matches = list(db.collection("users").where(filter=FieldFilter("username", "==", clean_handle)).limit(1).stream())
    if not matches:
        raise ValueError(f'No user with the handle "{clean_handle}".')
    # create_invitation does the group / membership / status / self checks.
    return create_invitation(db, group_id, user_id, matches[0].id, clean_handle)


def get_group(db, group_id: str) -> dict:
    """Raw group doc (+ its id), or raises KeyError if not found. Internal
    helper for routes that need direct group access outside the usual
    _group_view() shaping (find-candidates' membership check + criteria_tags)."""
    if db is None:
        raise RuntimeError("Firestore unavailable")
    snap = db.collection("groups").document(group_id).get()
    if not snap.exists:
        raise KeyError("Group not found.")
    return {"group_id": snap.id, **(snap.to_dict() or {})}


def add_members(db, group_id: str, user_id: str, candidate_ids: list[str]) -> dict:
    """A current member INVITES one or more found candidates (by user_id) —
    the "Find candidates" counterpart to invite_member() (which invites by
    typed handle). Members are unchanged until each candidate accepts.

    Bulk semantics: a problem with one candidate never aborts the batch.
    Returns {"group": <_group_view>, "invited": [...], "skipped": [...]} where
    each skip carries a reason ("already_member" | "already_pending" | "self" |
    "unknown_user"). Only whole-request problems raise: KeyError (group
    missing → 404), PermissionError (requester not a member → 403), ValueError
    (group not active → 422). An empty list is a no-op, not an error."""
    if db is None:
        raise RuntimeError("Firestore unavailable")
    ref = db.collection("groups").document(group_id)
    snap = ref.get()
    if not snap.exists:
        raise KeyError("Group not found.")
    data = snap.to_dict() or {}
    if user_id not in {m.get("user_id") for m in (data.get("members") or [])}:
        raise PermissionError("Only group members can add candidates.")
    if _effective_status(data) != "active":
        raise ValueError("This group is no longer accepting new members.")

    already_pending = pending_invitee_ids(db, group_id)
    member_ids = {m.get("user_id") for m in (data.get("members") or [])}
    invited: list[dict] = []
    skipped: list[dict] = []
    for uid in dict.fromkeys(str(c) for c in candidate_ids if c):
        if uid in member_ids:
            skipped.append({"user_id": uid, "reason": "already_member"})
            continue
        if uid in already_pending:
            skipped.append({"user_id": uid, "reason": "already_pending"})
            continue
        if uid == user_id:
            skipped.append({"user_id": uid, "reason": "self"})
            continue
        try:
            invited.append(create_invitation(db, group_id, user_id, uid))
        except ValueError:
            skipped.append({"user_id": uid, "reason": "unknown_user"})
    fresh = db.collection("groups").document(group_id).get().to_dict() or data
    return {"group": _group_view(group_id, fresh, user_id), "invited": invited, "skipped": skipped}


def leave_group(db, group_id: str, user_id: str) -> dict:
    """Remove the user from a group's members. If they were the creator/admin,
    reassign admin to the next remaining member so the group is never left
    without one. If the last member leaves, the group is soft-deleted (same
    as delete_group()) rather than left behind as an orphaned, empty,
    admin-less doc. KeyError if the group doesn't exist (→ 404)."""
    if db is None:
        raise RuntimeError("Firestore unavailable")
    ref = db.collection("groups").document(group_id)
    snap = ref.get()
    if not snap.exists:
        raise KeyError("Group not found.")
    data = snap.to_dict() or {}
    members = [m for m in (data.get("members") or []) if m.get("user_id") != user_id]
    if not members:
        updates = {"members": [], "status": "deleted", "updated_at": _now_iso()}
        ref.update(updates)
        _cancel_group_invitations(db, group_id, "group_deleted")
        return _group_view(group_id, {**data, **updates}, user_id)
    updates: dict = {"members": members, "updated_at": _now_iso()}
    if data.get("created_by") == user_id:
        updates["created_by"] = members[0].get("user_id", "")
    ref.update(updates)
    return _group_view(group_id, {**data, **updates}, user_id)


def delete_group(db, group_id: str, user_id: str) -> None:
    """Soft-delete: sets status="deleted" — the data (including messages) is
    retained, but the group is hidden from every list/lookup from then on
    (list_all_groups() filters "deleted" out, and my_groups()/GET /{id} are
    both built on top of it). Creator-only — raises PermissionError otherwise
    (→ 403 at the route), KeyError if the group doesn't exist (→ 404). Unlike
    leaving, this works regardless of how many other members remain — the
    admin can end the group for everyone."""
    if db is None:
        raise RuntimeError("Firestore unavailable")
    ref = db.collection("groups").document(group_id)
    snap = ref.get()
    if not snap.exists:
        raise KeyError("Group not found.")
    data = snap.to_dict() or {}
    if user_id != (data.get("created_by") or ""):
        raise PermissionError("Only the group's creator can delete it.")
    ref.update({"status": "deleted", "updated_at": _now_iso()})
    _cancel_group_invitations(db, group_id, "group_deleted")


def list_all_groups(db, viewer_id: str = "", include_invited: bool = True) -> list[dict]:
    """All non-deleted groups (for browsing), newest first, flagged with the
    viewer's membership. A soft-deleted group never appears here, which is
    what makes it disappear from my_groups() and GET /api/groups/{id} too
    (both are built on this).

    `is_invited` marks a group the viewer has a PENDING invitation to, so the
    browse list can show "Invited" instead of a Join button. It costs ONE
    extra query for the whole list (not one per group), which is why it lives
    here rather than being attached per-route the way needs_attributes is."""
    if db is None:
        return []
    out = [_group_view(d.id, data, viewer_id) for d in db.collection("groups").stream()
           if (data := d.to_dict() or {}).get("status") != "deleted"]
    if viewer_id and include_invited:
        from google.cloud.firestore_v1.base_query import FieldFilter
        invited = {d.get("group_id") for doc in
                   _invitations_ref(db).where(filter=FieldFilter("user_id", "==", viewer_id)).stream()
                   if (d := doc.to_dict() or {}).get("status") == "pending"}
        for g in out:
            g["is_invited"] = g["group_id"] in invited
    out.sort(key=lambda g: g.get("created_at", ""), reverse=True)
    return out


def my_groups(db, user_id: str) -> list[dict]:
    """Groups the user is a member of, newest first. Skips the is_invited
    query — a member can never have a pending invite to their own group, so
    it would be pure waste."""
    return [g for g in list_all_groups(db, user_id, include_invited=False) if g["is_member"]]
