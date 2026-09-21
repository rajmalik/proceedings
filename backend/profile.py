"""
profile.py — user profile + AI onboarding (phase-I).

A PII-free profile of an applicant's US-immigration situation, stored in
Firestore `users/{id}` (D-035 / FINAL-ARCHITECTURE §6). Two capabilities:

  1. Profile CRUD + validation
       empty_profile(), clean_profile() (controlled-vocab gate, reusing the
       posting tagger's vocab), get_profile()/save_profile() against Firestore.

  2. AI onboarding (the "AI way", spec §Profile-setup-methods)
       onboard_turn(messages, draft) → next expert-bot message + an updated,
       validated structured profile draft + a `done` flag. Stateless: the
       client passes the running history + draft each turn.

Identity comes from the seed roster (seed_users.json) selected via the
X-User-Id header — no real auth yet (delayed per the agreed approach).

Deferred (NOT here): profile↔posting reconciliation, the reconcile agent,
and any consumption (draft pre-fill / search pre-filter).
"""

from __future__ import annotations

import csv
import functools
import json
import os
import re
from datetime import datetime, timezone

from google import genai

import posting  # reuse the tagger's vocab + cleaners (single source of truth)

_HERE = os.path.dirname(__file__)


# ---------------------------------------------------------------------------
# Seed roster (baked users)
# ---------------------------------------------------------------------------

@functools.lru_cache(maxsize=1)
def _seed_users_cached() -> tuple:
    """seed_users.json is static — loaded once per process (it used to be
    re-read from disk on nearly every request via the auth path's seed_ids())."""
    try:
        with open(os.path.join(_HERE, "seed_users.json"), encoding="utf-8") as f:
            return tuple(json.load(f))
    except (FileNotFoundError, json.JSONDecodeError) as e:
        print(f"profile: could not load seed_users.json ({e})")
        return ()


def seed_users() -> list[dict]:
    return list(_seed_users_cached())


@functools.lru_cache(maxsize=1)
def seed_ids() -> frozenset:
    return frozenset(u["id"] for u in seed_users())


def username_for(user_id: str) -> str:
    for u in seed_users():
        if u["id"] == user_id:
            return u.get("username", user_id)
    return user_id


def handle_for(db, user_id: str) -> str:
    """The user's real assigned handle when they're a registered (Firebase)
    user — checks Firestore `users/{uid}.username` first (the handle
    `random_username()` actually assigned at registration), falling back to
    the static seed-roster lookup, then finally the raw uid.

    `username_for()` alone only knows the seed roster and returns the raw
    uid unchanged for anyone else — the same gap `get_profile()` already
    works around inline (`data.get("username") or username_for(user_id)`,
    profile.py's own GET path) but that group code (matching.py,
    group_messages.py) bypassed by calling `username_for()` directly,
    displaying a raw uid as a member's "handle" instead of their real one."""
    if db is not None:
        try:
            snap = db.collection("users").document(user_id).get()
            if snap.exists:
                h = (snap.to_dict() or {}).get("username")
                if h:
                    return h
        except Exception as e:  # noqa: BLE001 — a lookup failure must not block the caller
            print(f"profile.handle_for error: {e}")
    return username_for(user_id)


@functools.lru_cache(maxsize=1)
def seed_usernames() -> frozenset:
    """The baked seed-roster handles (e.g. `arjun-h1b`) — never treated as a
    real-name leak by the anonymization migration."""
    return frozenset(u.get("username", "") for u in seed_users() if u.get("username"))


# ---------------------------------------------------------------------------
# Anonymous Reddit-style handles (real names never seed a username)
# ---------------------------------------------------------------------------

def is_anonymous_handle(handle: str) -> bool:
    """True if `handle` is already an anonymous handle — a generated
    `adj-noun-NNNN` (posting.HANDLE_RE) or a baked seed-roster username. Anything
    else is assumed to be a legacy real-name/email-seeded username to scrub."""
    h = (handle or "").strip()
    return bool(posting.HANDLE_RE.match(h)) or h in seed_usernames()


def _handle_taken(db, handle: str) -> bool:
    """True if some users/{uid} already holds this username (best-effort)."""
    if db is None or not handle:
        return False
    try:
        for _ in db.collection("users").where("username", "==", handle).limit(1).stream():
            return True
    except Exception as e:  # noqa: BLE001 — a lookup failure must not block registration
        print(f"profile._handle_taken error: {e}")
    return False


def random_username(db=None, *, attempts: int = 8) -> str:
    """A fresh anonymous handle (adj-noun-NNNN), retried against existing
    usernames to avoid collisions. Falls back to the last generated handle after
    `attempts` (the ~9k number space makes a real clash negligible)."""
    handle = posting.generate_handle()
    for _ in range(attempts):
        if not _handle_taken(db, handle):
            return handle
        handle = posting.generate_handle()
    return handle


def _clean_username(raw) -> str:
    """Sanitize a user-chosen handle. Returns "" on reject (the caller then keeps
    the prior handle). Rejects email-like values (`@`); caps length at 40."""
    u = str(raw or "").strip()
    if not u or "@" in u:
        return ""
    return u[:40]


# ---------------------------------------------------------------------------
# Profile shape + validation
# ---------------------------------------------------------------------------

# Country-of-* stage keys whose value must be a 1.4 *country* code (2-letter).
_COUNTRY_STAGE_KEYS = {"citizen_of_country", "resident_of_country", "born_in_country", "fiance_of_country"}


def _country_codes() -> set[str]:
    """ISO-2 country codes from 1.4-consulates.csv (Type == 'country')."""
    out: set[str] = set()
    path = os.path.join(_HERE, "tags-cleaned", "1.4-consulates.csv")
    try:
        with open(path, newline="", encoding="utf-8") as f:
            reader = csv.reader(f)
            next(reader, None)  # header: tag,Type,Country,City
            for row in reader:
                if len(row) >= 2 and row[1].strip().lower() == "country" and row[0].strip():
                    out.add(row[0].strip())
    except FileNotFoundError:
        pass
    return out


_COUNTRY_SET: set[str] = set()


def empty_profile() -> dict:
    return {
        "username": "",
        "current_visa_or_greencard_category": [],
        "visa_applying_for": [],
        "primary_consulate": "",
        "consulates": [],
        # General tags — forms / actions / outcomes / topics (1.3,1.5,1.6,1.9,1.10),
        # e.g. I-485, RFE, PERM, 221g. NOT visa categories (those are the fields above).
        "tags": [],
        "key_stages_or_info": {},
        "key_dates": {},
        "background_text": "",
        # Chronological log of the user's lived experience at each milestone/step.
        # Stored as free TEXT — NOT controlled tags, and NEVER drives current-state fields.
        "journey": [],   # [{milestone, date (YYYY-MM-DD or ""), experience}]
        "created_at": "",
        "updated_at": "",
    }


# Recommended milestone labels (the bot may use others; we slugify + accept).
MILESTONES = [
    "visa_interview", "visa_stamping", "port_of_entry", "h1b_registration", "h1b_lottery",
    "h1b_filing", "h1b_approval", "h1b_rfe", "opt_application", "stem_opt", "cap_gap",
    "perm_filing", "perm_approval", "i140_filing", "i140_approval", "priority_date_current",
    "i485_filing", "biometrics", "ead_approval", "advance_parole", "aos_interview", "green_card",
    "naturalization_interview", "oath_ceremony", "consular_221g", "nvc_processing", "other",
]


def _slug(s: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "_", (s or "").strip().lower()).strip("_")
    return s[:48]


# Light PII scrub for the free-text background field (emails, phones, long digit
# runs like A-numbers/SSNs). The spec forbids PII; we redact defensively.
_PII_PATTERNS = [
    (re.compile(r"\b[\w.+-]+@[\w-]+\.[\w.-]+\b"), "[email removed]"),
    # Phone numbers: require 10+ digits (US/intl length) so ISO dates like
    # 2024-03-10 (8 digits) and short counts ("in 2 minutes") are NOT redacted.
    (re.compile(r"(?<!\d)(?:\+?\d[\s().-]?){10,}(?!\d)"), "[number removed]"),
    (re.compile(r"\bA\d{8,9}\b", re.I), "[case-number removed]"),
]


def scrub_pii(text: str) -> str:
    t = text or ""
    for rx, repl in _PII_PATTERNS:
        t = rx.sub(repl, t)
    return t.strip()


_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def normalize_date(value: str) -> str:
    """Convert a user-entered date in ~any common format to YYYY-MM-DD.
    Accepts e.g. '03/15/2027', 'March 5 2026', '5 Mar 2026', '2027/03/15'.
    Returns '' if it cannot be parsed confidently."""
    s = (value or "").strip()
    if not s:
        return ""
    if _DATE_RE.match(s):
        return s
    try:
        from dateutil import parser as _dp
        dt = _dp.parse(s, dayfirst=False, yearfirst=True, fuzzy=False)
        return dt.strftime("%Y-%m-%d")
    except (ValueError, OverflowError, ImportError):
        return ""


def _norm_dates(value) -> dict:
    """Keep valid 1.8 keys, normalizing each value to YYYY-MM-DD (any input format)."""
    posting._Vocab.load()
    out: dict = {}
    if isinstance(value, dict):
        for k, v in value.items():
            k = str(k).strip()
            if k in posting._Vocab.date_keys:
                nd = normalize_date(str(v))
                if nd:
                    out[k] = nd
    return out


def _sort_journey(j: list) -> list:
    """Chronological order: dated entries ascending, undated appended at the end."""
    dated = [e for e in j if e.get("date")]
    undated = [e for e in j if not e.get("date")]
    dated.sort(key=lambda e: e["date"])
    return dated + undated


def _clean_journey(value) -> list:
    """Validate milestone-experience entries: slugified milestone + normalized
    optional date + PII-scrubbed experience text. Drops entries with no text."""
    out: list = []
    if isinstance(value, list):
        for it in value:
            if not isinstance(it, dict):
                continue
            ms = _slug(str(it.get("milestone") or ""))
            exp = scrub_pii(str(it.get("experience") or "")).strip()[:4000]
            if not ms or not exp:
                continue
            out.append({
                "milestone": ms,
                "date": normalize_date(str(it.get("date") or "")),
                "experience": exp,
                # phase-J: per-experience consent (default ON) + published doc id (if shared).
                "shared": bool(it.get("shared", True)),
                "experience_case_id": str(it.get("experience_case_id") or ""),
            })
    return _sort_journey(out)


def _merge_journey(base: list, inc: list) -> list:
    """Union journey entries keyed by (milestone, date); keep the richer experience text."""
    by_key: dict = {}
    for e in [*base, *inc]:
        k = (e["milestone"], e["date"])
        if k not in by_key or len(e["experience"]) > len(by_key[k]["experience"]):
            by_key[k] = e
    return _sort_journey(list(by_key.values()))


def clean_profile(p: dict) -> dict:
    """Coerce an incoming profile to valid controlled-vocabulary values."""
    global _COUNTRY_SET
    posting._Vocab.load()
    if not _COUNTRY_SET:
        _COUNTRY_SET = _country_codes()

    out = empty_profile()
    out["username"] = _clean_username(p.get("username"))
    out["current_visa_or_greencard_category"] = posting._clean_group(
        "current_visa_or_greencard_category", p.get("current_visa_or_greencard_category"))
    out["visa_applying_for"] = posting._clean_group("visa_applying_for", p.get("visa_applying_for"))
    out["consulates"] = posting._clean_group("consulates", p.get("consulates"))
    out["primary_consulate"] = posting._clean_group("primary_consulate", p.get("primary_consulate"))
    if out["primary_consulate"] and out["primary_consulate"] not in out["consulates"]:
        out["consulates"] = [out["primary_consulate"], *out["consulates"]]

    # Miscellaneous tags & topics ONLY (1.3 abbreviations + 1.10 topics). Forms/outcomes
    # live under key_stages_or_info; 1.6 visa-form-actions are excluded from profiles.
    out["tags"] = posting.clean_misc_tags(p.get("tags"))
    # key_stages: profile key (1.7/1.5/1.1/1.3, NO 1.6) + a value satisfying the key's
    # value-domain (form -> outcome; *_of_country -> country; etc.).
    out["key_stages_or_info"] = posting.clean_stages_profile(p.get("key_stages_or_info"))
    out["key_dates"] = _norm_dates(p.get("key_dates"))
    out["background_text"] = scrub_pii(str(p.get("background_text") or ""))[:2000]
    out["journey"] = _clean_journey(p.get("journey"))
    return out


def validate_profile(p: dict) -> list[str]:
    """Non-fatal hints about values that were dropped/invalid (UI can surface)."""
    errs: list[str] = []
    cleaned = clean_profile(p)
    raw_username = str(p.get("username") or "").strip()
    if raw_username and not cleaned["username"]:
        errs.append("username rejected (no email addresses / must be ≤40 chars)")
    for f in ("current_visa_or_greencard_category", "visa_applying_for", "consulates", "tags"):
        dropped = set(p.get(f) or []) - set(cleaned[f])
        if dropped:
            errs.append(f"{f}: dropped invalid {sorted(dropped)}")
    for k, v in (p.get("key_dates") or {}).items():
        if k not in cleaned["key_dates"]:
            errs.append(f"key_dates['{k}']='{v}' invalid (need 1.8 key + YYYY-MM-DD)")
    for k, v in (p.get("key_stages_or_info") or {}).items():
        if k not in cleaned["key_stages_or_info"]:
            errs.append(f"key_stages_or_info['{k}']='{v}' invalid (need 1.7 key; *_of_country needs ISO-2)")
    return errs


def merge_profile(base: dict, incoming: dict) -> dict:
    """Merge an onboarding draft onto an existing profile (incoming wins where set).
    Lists are unioned; scalars/text overwrite when the incoming value is non-empty."""
    base = clean_profile(base or {})
    inc = clean_profile(incoming or {})
    out = dict(base)
    for f in ("current_visa_or_greencard_category", "visa_applying_for", "consulates", "tags"):
        out[f] = list(dict.fromkeys([*base[f], *inc[f]]))
    if inc["primary_consulate"]:
        out["primary_consulate"] = inc["primary_consulate"]
    out["key_stages_or_info"] = {**base["key_stages_or_info"], **inc["key_stages_or_info"]}
    out["key_dates"] = {**base["key_dates"], **inc["key_dates"]}
    out["journey"] = _merge_journey(base["journey"], inc["journey"])
    if inc["background_text"]:
        out["background_text"] = inc["background_text"]
    if inc["username"]:
        out["username"] = inc["username"]
    if out["primary_consulate"] and out["primary_consulate"] not in out["consulates"]:
        out["consulates"] = [out["primary_consulate"], *out["consulates"]]
    return out


# ---------------------------------------------------------------------------
# Firestore persistence (users/{id})
# ---------------------------------------------------------------------------

def get_profile(db, user_id: str) -> dict:
    """Return the stored profile (or an empty one seeded with the username)."""
    prof = empty_profile()
    prof["username"] = username_for(user_id)
    if db is None:
        return prof
    try:
        snap = db.collection("users").document(user_id).get()
        if snap.exists:
            data = snap.to_dict() or {}
            merged = empty_profile()
            merged.update({k: data.get(k, merged[k]) for k in merged})
            merged["username"] = data.get("username") or username_for(user_id)
            for tk in ("created_at", "updated_at"):
                val = merged.get(tk)
                merged[tk] = val.isoformat() if hasattr(val, "isoformat") else (val or "")
            return merged
    except Exception as e:  # noqa: BLE001
        print(f"profile.get_profile error: {e}")
    return prof


def project_experiences(profile: dict) -> tuple[dict, list]:
    """Phase-J (D-041): publish newly-shared experiences as their own searchable
    DS-1 docs and delete newly-unshared ones. Mutates each journey entry's
    `experience_case_id` in place. The profile itself is NEVER indexed.
    Best-effort: a projection failure does not block the save."""
    import posting
    notes: list = []
    for e in profile.get("journey", []):
        shared = bool(e.get("shared"))
        cid = str(e.get("experience_case_id") or "")
        try:
            if shared and not cid:
                res = posting.publish_experience(profile, e)
                e["experience_case_id"] = res["case_id"]
                notes.append(("published", res["case_id"]))
            elif not shared and cid:
                posting.delete_content(cid)
                e["experience_case_id"] = ""
                notes.append(("unpublished", cid))
        except Exception as ex:  # noqa: BLE001
            notes.append(("error", f"{e.get('milestone')}: {ex}"))
    return profile, notes


def save_profile(db, user_id: str, p: dict) -> dict:
    """Validate + persist the profile. Returns the stored profile.
    Consented experiences are projected to searchable DS-1 docs (D-041)."""
    from google.cloud import firestore as _fs
    cleaned = clean_profile(p)
    # Username precedence: what the user submitted > the stored username (a PUT
    # without a username must not reset it — for registered Firebase uids the
    # roster fallback is just the raw uid) > the seed-roster fallback.
    prior: dict = {}
    if db is not None:
        snap = db.collection("users").document(user_id).get()
        prior = (snap.to_dict() or {}) if snap.exists else {}
    cleaned["username"] = cleaned["username"] or prior.get("username") or username_for(user_id)
    # Publish/withdraw consented experiences and capture their doc ids.
    cleaned, _proj = project_experiences(cleaned)
    if db is None:
        return cleaned
    doc = db.collection("users").document(user_id)
    payload = dict(cleaned)
    payload["updated_at"] = _fs.SERVER_TIMESTAMP
    # Preserve the original created_at; otherwise stamp it now.
    payload["created_at"] = prior.get("created_at") or _fs.SERVER_TIMESTAMP
    # Authoritative full overwrite (NOT merge=True): Firestore deep-merges maps, so
    # merge would leave removed key_stages_or_info / key_dates entries behind. The
    # saved profile must exactly reflect what the user submitted.
    doc.set(payload)
    return get_profile(db, user_id)


# ---------------------------------------------------------------------------
# AI onboarding conversation
# ---------------------------------------------------------------------------

# Stage 1 — BASICS: current status, journey dates, background. NO experiences here.
def _basics_system_prompt(draft: dict) -> str:
    posting._Vocab.load()
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    return f"""You are a friendly US immigration expert helping an applicant set up the BASIC part of their
PROFILE (Stage 1 of 2). Hold a short, natural conversation to capture their CURRENT situation, journey and
key dates. Ask ONE focused question at a time (you may group a few RELATED dates per message). Concise and warm.

Today's date is {today}. Resolve relative dates ("last month", "in 2022") against it; output exact YYYY-MM-DD.

# THIS STAGE CAPTURES BASICS ONLY — NOT experiences
Capture status, dates and background. Do NOT ask the user to recount their EXPERIENCE/story of any past step
(visa interview, port of entry, RFE, etc.) — that happens in a SEPARATE later stage, AFTER this profile is
saved. Keep this stage about facts, status and dates only. When the basics are reasonably complete, set
"done": true and tell them you'll then ask about their milestone experiences.

# CAPTURE (only what applies)
- If ALREADY IN the USA: current_visa_or_greencard_category (1.1/1.2 codes).
- If applying for a visa FROM ABROAD: primary_consulate + consulates (1.4) and visa_applying_for (1.1/1.2) if known.
- citizen_of_country and resident_of_country (ISO-2 country codes) under key_stages_or_info.
- A FORM the user is dealing with + its status -> key_stages_or_info as {{form: outcome}}, e.g. {{"I-485": "filed", "I-130": "approved", "I-129": "RFE"}}. KEY = a form (1.5); VALUE = an OUTCOME (1.9: filed, received, pending, in-progress, approved, denied, refused, RFE, issued, 221g, withdrawn, not-filed-yet…).
- Miscellaneous topics / abbreviations the user mentions -> tags (1.3 abbreviations + 1.10 topics ONLY), e.g. NIW, premium-processing, consular-processing. Do NOT put forms, outcomes, visa codes, or visa-form-action (1.6) tags in tags.
- Relevant key_dates (1.8 keys, YYYY-MM-DD). A short background_text in their own words.

# JOURNEY MAP — ask what's RELEVANT to THIS user's journey (don't force every step)
The F-1 → OPT/STEM OPT → H-1B → PERM+I-140 → I-485 AOS → Naturalization path is the MOST COMMON but NOT the
only one. FIRST identify the user's journey, THEN ask only milestones relevant to THAT path. Date keys:
- F-1 / OPT / H-1B:       f1_expire_date, opt_expire_date, ead_expire_date, cap_gap_expire_date,
                          h1b_filed_date, h1b_receipt_date, h1b_approved_date, h1b_expire_date
- Employment green card:  labor_cert_filed_date, perm_approved_date, priority_date, i140_approved_date,
                          i485_filed_date, aos_approved_date, green_card_received_date
- Family / marriage (I-130 / K-1): i130_filed_date, priority_date, nvc_received_date,
                          nvc_documentarily_qualified_date, visa_interview_date, visa_issued_date
- Consular immigrant (NVC): priority_date, nvc_case_creation_date, nvc_documentarily_qualified_date,
                          ds160_submitted_date, visa_interview_date, 221g_issued_date, visa_issued_date
- Nonimmigrant stamping abroad: ds160_submitted_date, slot_booked_date, visa_interview_date,
                          221g_issued_date, 221g_clearance_date, visa_stamp_date, visa_issued_date, visa_refused_date
- Naturalization:         naturalization_interview_date, oath_ceremony_date
Record status where natural with 1.7 keys (visa_status, case_status, petition_status, application_status,
priority_date_status, interview_status). Skip phases that don't apply.

# WHICH DATES MATTER MOST (don't make them enter everything)
Focus on HIGH-VALUE "bottleneck" dates where applicants WAIT or get STUCK or that fix their PLACE IN LINE,
e.g.: priority_date, h1b_filed_date, labor_cert_filed_date, i140_approved_date, i485_filed_date,
visa_interview_date, nvc_documentarily_qualified_date, 221g_issued_date. Never nag for a date they don't have.

# WHY — remind them (briefly, varied wording, every couple of turns)
The more specific their details/dates, the easier OTHER applicants in the SAME situation can find and CONNECT
with them on the platform (a feature coming soon). Keep it short and natural.

# PAST vs CURRENT — never let history pollute current state
A PAST visa refusal, or a status the user NO LONGER holds, must NOT appear in current_visa_or_greencard_category
or visa_applying_for — those reflect the user's CURRENT status and intent ONLY. (Past experiences are captured
in the next stage as text, never as tags.)

# SCOPE — PROFILE SETUP ONLY (NOT a Q&A)
- Say clearly this only captures their basic profile, not answers to immigration questions.
- If they ask a QUESTION or raise a CONCERN: do NOT answer or store it; say they can POST it as a message
  after their profile is set up, then steer back to basics.

# HARD RULES
- NEVER ask for or store PII (name, DOB, address, phone, email, passport/A-number, SSN).
- Use ONLY controlled-vocabulary tag strings; if unsure, leave the field out and put the idea in background_text. Do NOT invent tags.
- Country values for *_of_country MUST be ISO-2 codes (IN, CN, MX, AE).
- key_stages_or_info VALUES are constrained by key: a FORM key (1.5, e.g. I-485) -> an OUTCOME (1.9); *_of_country / travel_country -> ISO-2 country code; outcome_status -> an outcome (1.9); visa_type -> a visa code (1.1/1.2); consulate_assigned -> a 1.4 post code. Other stage values are free text.
- NEVER use visa-form-action (section 1.6) tags ANYWHERE in the profile (not as tags, not as stage keys).
- A DATE KEY MUST match the user's ACTUAL visa/status — never use an f1_*/h1b_* key for a different visa (e.g. a J-1 holder's status expiry is j1_expire_date, NOT f1_expire_date). If no visa-specific key fits, use the generic i94_expire_date or visa_expire_date.
- Do NOT invent a FORM the user did not name. "Applying for an extension" of the SAME status is INTENT — capture it via visa_applying_for and/or a status stage (e.g. application_status), NOT by guessing a specific form (e.g. I-539) the user never mentioned.

# CONTROLLED VOCABULARY (use exact strings)
{posting._master_tags_block()}

# OUTPUT — return ONE JSON object only (no prose, no fences):
{{
  "reply": string,
  "profile": {{
    "current_visa_or_greencard_category": string[],
    "visa_applying_for": string[],
    "primary_consulate": string,
    "consulates": string[],
    "tags": string[],
    "key_stages_or_info": object,
    "key_dates": object,
    "background_text": string
  }},
  "done": boolean
}}

# ALREADY-CAPTURED PROFILE — this is what you ALREADY KNOW (do NOT re-ask any of it)
This is the applicant's profile so far. Merge new findings into it and KEEP prior values. Crucially:
- NEVER ask the user for a field, date or status that is already filled in below (e.g. if i140_approved_date
  is already set, do NOT ask for it again). Acknowledge what you already know.
- Ask ONLY about what is MISSING, ambiguous, or that the user explicitly says they want to CHANGE.
- If the profile already looks reasonably complete, briefly confirm the key facts in ONE message and set
  "done": true instead of asking further questions.
{json.dumps({k: v for k, v in (draft or {}).items() if k != "journey"}, ensure_ascii=False)}
"""


# Stage 2 — EXPERIENCES: post-save. Infer crossed milestones from the saved profile; gather their stories.
def _experiences_system_prompt(profile: dict) -> str:
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    p = clean_profile(profile or {})
    signals = {
        "current_visa_or_greencard_category": p["current_visa_or_greencard_category"],
        "visa_applying_for": p["visa_applying_for"],
        "consulates": p["consulates"],
        "key_stages_or_info": p["key_stages_or_info"],
        "key_dates": p["key_dates"],
        "background_text": p["background_text"],
    }
    return f"""You are a US immigration expert. The user has ALREADY set up and SAVED their basic profile
(Stage 2 of 2). Your ONLY job now is to collect their lived EXPERIENCE of the milestones they have ALREADY
crossed. Today's date is {today}.

# THE USER'S SAVED PROFILE (use this to figure out which milestones they have passed)
{json.dumps(signals, ensure_ascii=False)}

# WHAT TO DO
From their saved status and dates, infer the milestones they have ALREADY been through, e.g.:
- visa_interview_date / 221g_issued_date -> they had a VISA INTERVIEW (and maybe a 221(g)).
- admission_date / i94 -> a PORT-OF-ENTRY / CBP officer interaction.
- h1b_approved_date / h1b_receipt_date -> an H-1B FILING / APPROVAL (and any RFE: rfe_date).
- biometrics_* -> BIOMETRICS. aos_* -> an AOS INTERVIEW. naturalization_interview_date -> the citizenship interview.
- perm/i140 -> the green-card labor/petition steps.
Go through these ONE AT A TIME and ask the user to describe WHAT HAPPENED, HOW IT WENT, and the TIMELINE.
Prioritise the big ones (visa interview, port-of-entry/CBP, H-1B approval, RFE). Record each as a "journey"
entry. Remind them (briefly) that others facing the same step will learn from their experience and can connect.
When you have offered every crossed milestone (capturing the ones they share) or they say they're done, set "done": true.

# HARD RULES
- This stage captures EXPERIENCE TEXT ONLY. NEVER change or output the current-state tag fields; NEVER tag
  these past experiences. A past refusal or a status no longer held stays as experience text only.
- NEVER ask for or store PII (name, DOB, address, phone, email, passport/A-number, SSN).
- NO QUESTIONS OR CONCERNS HERE. If the user asks a question or raises a concern (e.g. about timelines,
  eligibility, an RFE, re-entry): do NOT answer it and do NOT record it anywhere. Tell them to create a
  SEPARATE posting for that question/concern, then steer back to collecting their experiences. An experience
  is a past account only — it must never contain a question or concern.

# OUTPUT — return ONE JSON object only (no prose, no fences):
{{
  "reply": string,
  "journey": [
    {{ "milestone": string, "date": string (YYYY-MM-DD or ""), "experience": string }}
  ],
  "done": boolean
}}

# Journey collected so far (merge your new findings into this; keep prior entries):
{json.dumps(p.get("journey", []), ensure_ascii=False)}
"""


def _gen_json(contents: str) -> dict:
    client = posting.genai_client()  # shared, 60s timeout
    cfg = dict(temperature=0.4, max_output_tokens=2048, response_mime_type="application/json")
    try:
        cfg["thinking_config"] = genai.types.ThinkingConfig(thinking_budget=0)
    except Exception:  # noqa: BLE001
        pass
    resp = client.models.generate_content(
        model=posting._gemini_model(), contents=contents,
        config=genai.types.GenerateContentConfig(**cfg),
    )
    raw = re.sub(r"^```(?:json)?|```$", "", (resp.text or "").strip(), flags=re.MULTILINE).strip()
    return json.loads(raw)


def onboard_turn(messages: list[dict], draft: dict | None, stage: str = "basics") -> dict:
    """One conversational turn. stage='basics' (Stage 1, no experiences) or
    'experiences' (Stage 2, gather milestone stories into journey only).
    Returns {reply, profile (validated), done}."""
    draft = draft or empty_profile()
    convo = "\n".join(
        f"{str(m.get('role', 'user')).capitalize()}: {m.get('content', '')}"
        for m in (messages or [])[-12:]
    )

    if stage == "experiences":
        prompt = _experiences_system_prompt(draft)
        try:
            data = _gen_json(f"{prompt}\n\nConversation so far:\n{convo}\n\nReturn the JSON now.")
        except json.JSONDecodeError:
            return {"reply": "Sorry, could you say that another way?", "profile": clean_profile(draft), "done": False}
        merged = clean_profile(draft)  # basics stay exactly as saved
        merged["journey"] = _merge_journey(merged["journey"], _clean_journey(data.get("journey")))
        return {
            "reply": str(data.get("reply") or "").strip() or "Tell me about one of your milestones.",
            "profile": merged,
            "done": bool(data.get("done")),
        }

    # stage == "basics"
    prompt = _basics_system_prompt(draft)
    try:
        data = _gen_json(f"{prompt}\n\nConversation so far:\n{convo}\n\nReturn the JSON now.")
    except json.JSONDecodeError:
        return {"reply": "Sorry, could you say that another way?", "profile": clean_profile(draft), "done": False}
    incoming = data.get("profile") or {}
    incoming["journey"] = []  # Stage 1 NEVER captures experiences
    merged = merge_profile(draft, incoming)
    merged["journey"] = clean_profile(draft).get("journey", [])  # preserve any existing journey untouched
    return {
        "reply": str(data.get("reply") or "").strip() or "Tell me a bit about your immigration situation.",
        "profile": merged,
        "done": bool(data.get("done")),
    }
