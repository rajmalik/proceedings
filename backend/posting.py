"""
posting.py — user-submitted posting: auto-tagging + publish to the grounding sink
=================================================================================
Implements the "Post a new message" flow (posting-specs.md). Two capabilities:

  1. suggest_tags(title, description)
       → run the Gemini tagging engine (LLM-EXTRACTION-PROMPT) over the text and
         return controlled-vocabulary tags grouped by schema section, for the
         composer's right-hand panel. Pure read, no side effects.

  2. publish_posting(title, description, tags, ...)
       → build the canonical sidecar JSON (JSON-SCHEMA-FIELD-DICTIONARY), validate
         it against the master vocab, then (a) write <case_id>.md + .json to
         gs://imm-postings-ingestion/<date>/app/, (b) documents.import it
         into DS-1 (imm-postings-datastore) so it's searchable in minutes, and
         (c) append a row to BigQuery postings.postings_metadata.

Decisions: channel = "app" (D-036/D-038 canonical — the controlled pathway token the
search boost/filters key on; the domain never goes here). The website's provenance
identity (source_system + URLs) is env-driven (APP_SOURCE_SYSTEM / APP_BASE_URL), so
registering a domain later is a config flip, not a code change. Anonymous author
(synthetic handle); direct documents.import; BigQuery row written.
"""

from __future__ import annotations

import csv
import hashlib
import json
import os
import re
import secrets
import time
from collections.abc import Mapping, Sequence
from datetime import datetime, timezone

from google import genai
from google.api_core.client_options import ClientOptions
from google.api_core.exceptions import (
    Aborted,
    DeadlineExceeded,
    InternalServerError,
    ResourceExhausted,
    ServiceUnavailable,
)
from google.cloud import discoveryengine_v1 as de
from google.cloud import storage

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

CHANNEL = "app"  # controlled pathway token (channel field + case_id prefix + GCS segment) — the domain NEVER goes here
# The website's provenance identity. Env-driven so registering a domain later is a
# config flip (set APP_SOURCE_SYSTEM=<domain>, APP_BASE_URL=https://<domain>) — no code/redeploy of logic.
SOURCE_SYSTEM = os.getenv("APP_SOURCE_SYSTEM", "meridianjourney")
APP_BASE_URL = os.getenv("APP_BASE_URL", "https://meridianjourney.ai").rstrip("/")
_TAGS_DIR = os.path.join(os.path.dirname(__file__), "tags-cleaned")


def _project() -> str:
    return os.getenv("GCP_PROJECT_ID") or os.getenv("GCP_PROJECT", "")


def _region() -> str:
    return os.getenv("GCP_REGION") or os.getenv("GCP_GEMINI_LOCATION", "us-central1")


def _bucket_name() -> str:
    return os.getenv("GCP_BUCKET_NAME") or os.getenv("GCP_BUCKET", "imm-postings-ingestion")


def _datastore() -> str:
    return os.getenv("GCP_VERTEX_DATASTORE_ID", "imm-postings-datastore")


def _ds_location() -> str:
    return os.getenv("GCP_VERTEX_DATASTORE_LOCATION", "global")


def _gemini_model() -> str:
    return os.getenv("GCP_GEMINI_MODEL", "gemini-2.5-flash")


# One shared Gemini client per process (channel/auth setup is not free — the
# old per-call `genai.Client(...)` construction added latency to every tag /
# moderation / answer request). 60s request timeout so a hung Gemini call can
# never wedge a worker indefinitely.
_GENAI_CLIENT = None


def genai_client():
    global _GENAI_CLIENT
    if _GENAI_CLIENT is None:
        _GENAI_CLIENT = genai.Client(
            vertexai=True, project=_project(), location=_region(),
            http_options={"timeout": 60_000},  # ms
        )
    return _GENAI_CLIENT


# ---------------------------------------------------------------------------
# Master tag vocabulary (loaded once)
# ---------------------------------------------------------------------------

def _load_col(filename: str, col: int = 0) -> list[str]:
    """Return the values of one column of a tags-cleaned CSV (header skipped)."""
    path = os.path.join(_TAGS_DIR, filename)
    out: list[str] = []
    try:
        with open(path, newline="", encoding="utf-8") as f:
            reader = csv.reader(f)
            next(reader, None)  # header
            for row in reader:
                if len(row) > col and row[col].strip():
                    out.append(row[col].strip())
    except FileNotFoundError:
        print(f"posting: vocab CSV missing: {filename}")
    return out


def _load_consulate_options() -> list[dict]:
    """Return [{code, label}] for consulates, label = 'City, Country (CODE)' or
    'Country (CODE)' so users can search by place name, not just the code."""
    path = os.path.join(_TAGS_DIR, "1.4-consulates.csv")
    out: list[dict] = []
    try:
        with open(path, newline="", encoding="utf-8") as f:
            reader = csv.reader(f)
            next(reader, None)  # header: tag,Type,Country,City
            for row in reader:
                if not row or not row[0].strip():
                    continue
                code = row[0].strip()
                country = row[2].strip() if len(row) > 2 else ""
                city = row[3].strip() if len(row) > 3 else ""
                if city:
                    label = f"{city}, {country} ({code})"
                elif country:
                    label = f"{country} ({code})"
                else:
                    label = code
                out.append({"code": code, "label": label})
    except FileNotFoundError:
        print("posting: vocab CSV missing: 1.4-consulates.csv")
    return out


def _load_consulate_tree() -> list[dict]:
    """Grouped consulates for a two-part (country → city) picker.

    Returns ``[{country, country_code, cities: [{code, city}]}]`` sorted by
    country, cities sorted by name. `country_code` is the 1.4 country-type code
    (storable on its own when the user picks a country but no specific city);
    each city `code` is the consulate code. Built from the structured CSV columns
    so it is robust to country names that contain commas."""
    path = os.path.join(_TAGS_DIR, "1.4-consulates.csv")
    country_code: dict[str, str] = {}
    cities: dict[str, list[dict]] = {}
    try:
        with open(path, newline="", encoding="utf-8") as f:
            reader = csv.reader(f)
            next(reader, None)  # header: tag,Type,Country,City
            for row in reader:
                if not row or not row[0].strip():
                    continue
                code = row[0].strip()
                typ = row[1].strip() if len(row) > 1 else ""
                country = row[2].strip() if len(row) > 2 else ""
                city = row[3].strip() if len(row) > 3 else ""
                if not country:
                    continue
                if typ == "country":
                    country_code.setdefault(country, code)
                elif typ == "city" and city:
                    cities.setdefault(country, []).append({"code": code, "city": city})
    except FileNotFoundError:
        print("posting: vocab CSV missing: 1.4-consulates.csv")
        return []
    out: list[dict] = []
    for country in sorted(set(country_code) | set(cities)):
        out.append({
            "country": country,
            "country_code": country_code.get(country, ""),
            "cities": sorted(cities.get(country, []), key=lambda c: c["city"]),
        })
    return out


def _load_pairs(filename: str, desc_col: int = 1) -> list[tuple[str, str]]:
    """Return [(tag, description)] for a tags-cleaned CSV (header skipped)."""
    path = os.path.join(_TAGS_DIR, filename)
    out: list[tuple[str, str]] = []
    try:
        with open(path, newline="", encoding="utf-8") as f:
            reader = csv.reader(f)
            next(reader, None)  # header
            for row in reader:
                if row and row[0].strip():
                    desc = row[desc_col].strip() if len(row) > desc_col else ""
                    out.append((row[0].strip(), desc))
    except FileNotFoundError:
        print(f"posting: vocab CSV missing: {filename}")
    return out


def _load_misc_options() -> list[dict]:
    """[{code, label}] for the profile 'Miscellaneous tags & topics' picker:
    1.3 abbreviations (label shows the Full Name) + 1.10 common-misc (Description).
    label = 'CODE — meaning' so the dropdown shows the description alongside the code."""
    out: list[dict] = []
    seen: set[str] = set()
    pairs = _load_pairs("1.3-abbreviations.csv", 2) + _load_pairs("1.10-common-misc.csv", 1)
    for code, desc in pairs:
        if code and code not in seen:
            seen.add(code)
            out.append({"code": code, "label": (f"{code} — {desc}" if desc else code)})
    return out


def _load_country_codes() -> list[str]:
    """1.4 codes whose Type column == 'country' (ISO-2 country codes)."""
    path = os.path.join(_TAGS_DIR, "1.4-consulates.csv")
    out: list[str] = []
    try:
        with open(path, newline="", encoding="utf-8") as f:
            reader = csv.reader(f)
            next(reader, None)
            for row in reader:
                if len(row) >= 2 and row[1].strip().lower() == "country" and row[0].strip():
                    out.append(row[0].strip())
    except FileNotFoundError:
        print("posting: vocab CSV missing: 1.4-consulates.csv")
    return out


class _Vocab:
    """Master vocabulary sets + ordered lists, lazily loaded and cached."""

    _loaded = False
    visa: set[str] = set()
    consulate: set[str] = set()
    tag: set[str] = set()           # union of 1.3,1.5,1.6,1.9,1.10
    stage_keys: set[str] = set()
    date_keys: set[str] = set()
    outcomes: set[str] = set()        # 1.9 outcomes (value domain for outcome_status / form keys)
    country: set[str] = set()         # 1.4 country-type codes (value domain for *_of_country / travel_country)
    form: set[str] = set()            # 1.5 forms (profile key_stages KEYS; value domain = outcome)
    misc: set[str] = set()            # 1.3 + 1.10 (profile 'miscellaneous tags & topics')
    profile_stage_keys: set[str] = set()  # 1.7 + 1.5 + 1.1 + 1.3 (NO 1.6) — profile key_stages keys
    visa_form_map: dict[str, str] = {}    # 1.6 tag -> its "Associated Visa/Form" column value
    # ordered lists for compact prompt blocks
    _visa_list: list[str] = []
    _consulate_list: list[str] = []
    _tag_list: list[str] = []
    _stage_list: list[str] = []
    _date_list: list[str] = []
    _outcome_list: list[str] = []
    _country_list: list[str] = []
    _form_list: list[str] = []
    _misc_list: list[str] = []
    _misc_options: list[dict] = []
    _profile_stage_list: list[str] = []
    _tag_plain_list: list[str] = []          # 1.3,1.5,1.6,1.9 names (self-explanatory)
    _misc_pairs: list[tuple[str, str]] = []   # 1.10 (tag, description) — ambiguous, needs meaning
    _consulate_opts: list[dict] = []          # [{code, label}] for the place-name dropdown
    _consulate_tree: list[dict] = []          # [{country, country_code, cities:[{code, city}]}]

    @classmethod
    def load(cls) -> None:
        if cls._loaded:
            return
        cls._visa_list = _load_col("1.1-non-immigration-visas.csv") + _load_col("1.2-greencard-categories.csv")
        cls._consulate_list = _load_col("1.4-consulates.csv")
        cls._consulate_opts = _load_consulate_options()
        cls._consulate_tree = _load_consulate_tree()
        cls._tag_plain_list = (
            _load_col("1.3-abbreviations.csv")
            + _load_col("1.5-forms.csv")
            + _load_col("1.6-visa-form-actions.csv")
            + _load_col("1.9-outcomes.csv")
        )
        cls.visa_form_map = dict(_load_pairs("1.6-visa-form-actions.csv", desc_col=1))
        cls._misc_pairs = _load_pairs("1.10-common-misc.csv")
        cls._tag_list = cls._tag_plain_list + [t for t, _ in cls._misc_pairs]
        cls._stage_list = (
            _load_col("1.7-key-stages.csv")
            + _load_col("1.1-non-immigration-visas.csv")
            + _load_col("1.3-abbreviations.csv")
            + _load_col("1.5-forms.csv")
            + _load_col("1.6-visa-form-actions.csv")
        )
        cls._date_list = _load_col("1.8-key-dates.csv")
        cls._outcome_list = _load_col("1.9-outcomes.csv")
        cls._country_list = _load_country_codes()
        cls._form_list = _load_col("1.5-forms.csv")
        cls._misc_list = _load_col("1.3-abbreviations.csv") + _load_col("1.10-common-misc.csv")
        cls._misc_options = _load_misc_options()
        # profile key_stages keys: 1.7 + visas + abbreviations + forms — NO 1.6 actions
        cls._profile_stage_list = (
            _load_col("1.7-key-stages.csv") + _load_col("1.1-non-immigration-visas.csv")
            + _load_col("1.3-abbreviations.csv") + _load_col("1.5-forms.csv")
        )
        cls.visa = set(cls._visa_list)
        cls.consulate = set(cls._consulate_list)
        cls.tag = set(cls._tag_list)
        cls.stage_keys = set(cls._stage_list)
        cls.date_keys = set(cls._date_list)
        cls.outcomes = set(cls._outcome_list)
        cls.country = set(cls._country_list)
        cls.form = set(cls._form_list)
        cls.misc = set(cls._misc_list)
        cls.profile_stage_keys = set(cls._profile_stage_list)
        cls._loaded = True


# The six tag-group fields shown in the composer's right panel, in display order.
GROUP_FIELDS = [
    "visa_applying_for",
    "current_visa_or_greencard_category",
    "primary_consulate",
    "consulates",
    "tags",
    "concerns_or_questions_tags",
]


_VOCAB_LISTS_CACHE: dict | None = None


# ─────────────────────────── the attribute framework ───────────────────────
#
# A Timeline group's fields are CONFIGURATION, not code. Two dropdowns select
# a scope — Processing type (first) and Eligibility category (second) — and
# that pair decides two independent sets of rows:
#
#   SCOPE rows      what the group is scoped BY. Entered on the find/create
#                   panel, stored in the GROUP's criteria, part of its name,
#                   and compared by _exact_match() when searching or deduping.
#                   Every member of the group shares these values.
#   POST-JOIN rows  personal per-member facts. Entered on the group's own page
#                   right after joining, written into the MEMBER'S OWN profile.
#
# THE BASE SPEC IS DATA, NOT CODE: config/timeline_attributes.default.json.
# Firestore overrides it at runtime (attribute_config.py); the file is what
# serves until something is published there, and what
# `scripts/publish_attribute_config.py --from-default` seeds a fresh
# environment with. There is exactly one base — editing the JSON changes the
# shipped default, and nothing here needs touching.
#
# The reasoning that used to live in comments around these literals — why only
# 8 CFR 274a.12(c) classes are offered, why an I-485 priority date is
# post-join and optional, what each row field means and how `required`
# resolves — moved to config/README.md, because JSON has nowhere to put it.
# Read that before editing the spec.
CHECKBOX_ON = "yes"

_BASE_CONFIG_PATH = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "config", "timeline_attributes.default.json")

# Structurally valid, but offers nothing. Used ONLY when the base JSON is
# missing or unparseable — a packaging accident, which tests/test_packaging.py
# exists to catch before a deploy. Degrading rather than raising is deliberate:
# /api/tag-vocab also carries the CSV vocabulary the post composer and search
# depend on, and neither has anything to do with Timeline groups.
_EMPTY_SPEC: dict = {"version": 0, "processing_types": [], "period_rows": [],
                     "scope_row_extras": {}, "post_join_row_extras": {}}


def _load_base_config() -> dict:
    """Read the shipped base spec. Called once, at import."""
    try:
        with open(_BASE_CONFIG_PATH, encoding="utf-8") as fh:
            spec = json.load(fh)
        if not isinstance(spec, dict):
            raise ValueError("base config is not a JSON object")
        return spec
    except Exception as e:  # noqa: BLE001 — packaging must not break the API
        print(f"[posting] WARNING: could not load {_BASE_CONFIG_PATH} "
              f"({type(e).__name__}: {e}) — Timeline attributes will be empty "
              f"until a config is published to Firestore")
        return json.loads(json.dumps(_EMPTY_SPEC))


# The spec that ships with the code: the fallback when nothing is published
# and Firestore is unreachable, and the payload the publish CLI seeds with.
DEFAULT_ATTRIBUTE_SPEC: dict = _load_base_config()


def _period_rows() -> list[dict]:
    """The base scope every Timeline group gets — a 3-letter calendar Month
    plus a Year, per the config's `period_rows`.

    ONE shape for every processing type and every eligibility category; there
    is deliberately no "Cycle" anywhere (config/README.md explains why).

    A MISSING `period_rows` means "not configured, use the shipped base"; an
    explicitly EMPTY one means "no period rows". `or` would conflate the two
    and silently reinstate the base against the operator's wishes — hence the
    `is None`. (Publishing an empty period is separately rejected by
    attribute_config.validate; see there for why.)"""
    rows = _spec().get("period_rows")
    if rows is None:
        rows = DEFAULT_ATTRIBUTE_SPEC.get("period_rows") or []
    return [dict(r) for r in rows]


def _layer_rows(*layers: list[dict]) -> list[dict]:
    """Concatenate row layers, a later layer replacing an earlier row with the
    same `key` in place rather than appending a duplicate control."""
    out: list[dict] = []
    at: dict[str, int] = {}
    for layer in layers:
        for row in layer:
            row = dict(row)
            if row["key"] in at:
                out[at[row["key"]]] = row
            else:
                at[row["key"]] = len(out)
                out.append(row)
    return out


def timeline_scope_rows(processing_type: str = "", eligibility: str = "") -> list[dict]:
    """The scope controls the find/create panel shows for a dropdown pair.

    Either argument may be empty — a type with no eligibility categories
    (H-1B) resolves off the type alone, and a bare tag resolves off itself,
    which is what lets tag-only callers (group naming, the group page) reuse
    this without knowing which dropdown a tag came from."""
    extras = _spec().get("scope_row_extras") or {}
    return _layer_rows(_period_rows(),
                       extras.get(processing_type, []),
                       extras.get(eligibility, []))


def timeline_post_join_rows(processing_type: str = "", eligibility: str = "") -> list[dict]:
    """The per-member controls shown after joining, for a dropdown pair.
    Empty list => that scope collects nothing and joining is ungated."""
    extras = _spec().get("post_join_row_extras") or {}
    return _layer_rows(extras.get(processing_type, []),
                       extras.get(eligibility, []))


def required_keys(rows: list[dict]) -> list[str]:
    """Which of `rows` a member must fill in.

    If ANY row declares "required" the declarations are taken literally —
    which is the only way to say "nothing here is mandatory" (a template whose
    single row is `"required": False` collects an entirely optional fact).
    A template that declares nothing falls back to row 0, the convention every
    template predating the flag was written to."""
    if any("required" in r for r in rows):
        return [r["key"] for r in rows if r.get("required")]
    return [rows[0]["key"]] if rows else []


def _resolve_templates() -> tuple[dict[str, list[dict]], dict[str, list[dict]], list[dict]]:
    """Flatten the live spec into the two tag-keyed registries the rest of the
    system reads, and return the processing types enriched with the
    `scope_rows`/`post_join_rows` each dropdown option implies — no second
    lookup for a client, and correct even once a type and a category both
    contribute rows.

    The flat dicts stay keyed by a single tag because their callers (group
    naming, the group page, attribute validation) only ever have a stored tag
    to go on, never the dropdown pair that produced it.

    Builds fresh from `_spec()` on every call — cheap dict work over a handful
    of rows, and it is what lets a config edit take effect without a restart.
    Callers that want it memoised go through the module-level views below."""
    scope: dict[str, list[dict]] = {}
    post_join: dict[str, list[dict]] = {}
    types: list[dict] = []
    for raw in _spec().get("processing_types") or DEFAULT_ATTRIBUTE_SPEC.get("processing_types") or []:
        ptype = {**raw, "eligibility_categories": []}
        pv = ptype["value"]
        ptype["scope_rows"] = scope[pv] = timeline_scope_rows(pv)
        ptype["post_join_rows"] = timeline_post_join_rows(pv)
        # Only tags that actually collect something get a POST_JOIN entry —
        # presence in that dict is what gates joining, so an empty list would
        # gate a group behind a form with no fields in it.
        if ptype["post_join_rows"]:
            post_join[pv] = ptype["post_join_rows"]
        for raw_cat in raw.get("eligibility_categories") or []:
            cat = {**raw_cat}
            tag = cat["tag"]
            cat["scope_rows"] = timeline_scope_rows(pv, tag)
            cat["post_join_rows"] = timeline_post_join_rows(pv, tag)
            # The tag-keyed entry can't know which type it was reached
            # through, so it resolves off the tag alone.
            scope[tag] = timeline_scope_rows(eligibility=tag)
            pj = timeline_post_join_rows(eligibility=tag)
            if pj:
                post_join[tag] = pj
            ptype["eligibility_categories"].append(cat)
        types.append(ptype)
    return scope, post_join, types


class _LiveMapping(Mapping):
    """A read-only dict view that re-resolves from the live config on access.

    Exists so externalising the config didn't have to touch the ~15 call sites
    (and every test) that read these registries as plain dicts — `in`, `[k]`,
    `.get()`, `.items()` and iteration all behave as before, they just see the
    current config instead of whatever was frozen at import."""

    def __init__(self, index: int):
        self._index = index

    def _d(self) -> dict:
        return _resolve_templates()[self._index]

    def __getitem__(self, k): return self._d()[k]
    def __iter__(self): return iter(self._d())
    def __len__(self): return len(self._d())
    def __repr__(self): return repr(self._d())


class _LiveSequence(Sequence):
    """The same idea for PROCESSING_TYPES / EAD_ELIGIBILITY_CATEGORIES, which
    callers index and iterate as lists."""

    def __init__(self, pick):
        self._pick = pick

    def _l(self) -> list:
        return self._pick(_resolve_templates()[2])

    def __getitem__(self, i): return self._l()[i]
    def __len__(self): return len(self._l())
    def __repr__(self): return repr(self._l())


# Tag -> rows. TAG_ATTRIBUTE_TEMPLATES holds the scope rows (find/create
# panel), POST_JOIN_ATTRIBUTE_TEMPLATES the per-member ones (group page); a
# tag absent from the latter means joining that group is ungated.
TAG_ATTRIBUTE_TEMPLATES = _LiveMapping(0)
POST_JOIN_ATTRIBUTE_TEMPLATES = _LiveMapping(1)

# The two dropdowns.
PROCESSING_TYPES = _LiveSequence(lambda types: types)

# EAD's own second-dropdown list. Narrow by construction — use it only when
# you specifically mean EAD's 8 CFR categories. Anything resolving "which
# category is this group scoped to" must use ALL_ELIGIBILITY_CATEGORIES:
# more than one type has a list now, and reading EAD's alone made every H-1B
# application type resolve to nothing, which collapsed three distinct cohorts
# onto one generated name (Timeline dedup is name-based).
EAD_ELIGIBILITY_CATEGORIES = _LiveSequence(
    lambda types: next((t["eligibility_categories"] for t in types if t["value"] == "EAD"), []))

# Every type's categories, in dropdown order.
ALL_ELIGIBILITY_CATEGORIES = _LiveSequence(
    lambda types: [c for t in types for c in (t.get("eligibility_categories") or [])])


def _spec() -> dict:
    """The live attribute spec — Firestore-backed, TTL-cached, falling back to
    DEFAULT_ATTRIBUTE_SPEC. Imported lazily because attribute_config validates
    against this module's vocabulary."""
    import attribute_config
    return attribute_config.get()


def vocab_lists() -> dict:
    """The controlled vocabularies for the composer's add-tag autocomplete,
    plus the Timeline attribute templates both clients render from.

    The CSV-derived half is assembled once per process — those files are
    static at runtime, and rebuilding the uniq passes and domain map on every
    request was measurable. The ATTRIBUTE half is spliced in fresh on each
    call, because it comes from the externalised config: caching it here for
    the process lifetime is exactly what used to make a config change require
    a restart. The splice is four dict lookups over already-resolved data."""
    global _VOCAB_LISTS_CACHE
    if _VOCAB_LISTS_CACHE is not None:
        return {**_VOCAB_LISTS_CACHE, **_attribute_vocab()}
    _Vocab.load()
    # de-dupe while preserving order
    def _uniq(xs: list[str]) -> list[str]:
        seen, out = set(), []
        for x in xs:
            if x not in seen:
                seen.add(x); out.append(x)
        return out
    _VOCAB_LISTS_CACHE = {
        "visa": _uniq(_Vocab._visa_list),
        "consulate": _uniq(_Vocab._consulate_list),
        "consulate_options": _Vocab._consulate_opts,
        "consulate_tree": _Vocab._consulate_tree,  # grouped country → cities (two-part picker)
        "tag": _uniq(_Vocab._tag_list),
        "stage_key": _uniq(_Vocab._stage_list),
        "date_key": _uniq(_Vocab._date_list),
        "outcome": _uniq(_Vocab._outcome_list),
        "country": _uniq(_Vocab._country_list),
        # profile-only vocabularies
        "misc": _uniq(_Vocab._misc_list),                 # 1.3 + 1.10 codes
        "misc_options": _Vocab._misc_options,             # [{code, label='CODE — meaning'}]
        "profile_stage_key": _uniq(_Vocab._profile_stage_list),  # stage keys w/o 1.6
        # key -> value-domain (incl. every form -> 'outcome')
        "stage_value_domains": stage_value_domains_map(),
    }
    return {**_VOCAB_LISTS_CACHE, **_attribute_vocab()}


def _attribute_vocab() -> dict:
    """The config-derived half of the vocab payload, resolved fresh so an
    edit to the Firestore spec reaches both clients within one TTL."""
    scope, post_join, types = _resolve_templates()
    return {
        "tag_attribute_templates": scope,
        "post_join_attribute_templates": post_join,
        "processing_types": types,
        "ead_eligibility_categories": next(
            (t["eligibility_categories"] for t in types if t["value"] == "EAD"), []),
    }


# key_stages_or_info keys whose VALUE must come from a sub-vocabulary (not free text).
# Forms (1.5) used as keys also constrain their value -> outcome (see stage_value_domain).
STAGE_VALUE_DOMAINS = {
    "citizen_of_country": "country", "born_in_country": "country",
    "resident_of_country": "country", "fiance_of_country": "country",
    "travel_country": "country",
    "consulate_assigned": "consulate",
    "outcome_status": "outcome",
    "visa_type": "visa",
}


def _domain_set(domain: str) -> set[str]:
    _Vocab.load()
    return {
        "country": _Vocab.country, "consulate": _Vocab.consulate,
        "visa": _Vocab.visa, "outcome": _Vocab.outcomes,
    }.get(domain, set())


def stage_value_domain(key: str) -> str | None:
    """Value-domain for a stage key, or None for free text. A FORM key (1.5) -> 'outcome'."""
    if key in STAGE_VALUE_DOMAINS:
        return STAGE_VALUE_DOMAINS[key]
    _Vocab.load()
    return "outcome" if key in _Vocab.form else None


def stage_value_ok(key: str, val: str) -> bool:
    """True if `val` is allowed for stage `key` (free text when key is unconstrained)."""
    domain = stage_value_domain(key)
    return True if not domain else (val in _domain_set(domain))


def stage_value_domains_map() -> dict:
    """Full key -> domain map (incl. every form 1.5 -> 'outcome') for the profile UI."""
    _Vocab.load()
    return {**STAGE_VALUE_DOMAINS, **{f: "outcome" for f in _Vocab._form_list}}


def clean_stages_profile(value) -> dict:
    """Profile key_stages: key in profile_stage_keys (1.7/1.5/1.1/1.3 — NO 1.6) and the
    value satisfies the key's domain (forms -> outcome; *_of_country -> country; ...)."""
    _Vocab.load()
    out: dict = {}
    if isinstance(value, dict):
        for k, v in value.items():
            k, sv = str(k).strip(), str(v).strip()
            if k in _Vocab.profile_stage_keys and sv and stage_value_ok(k, sv):
                out[k] = sv
    return out


def clean_misc_tags(value) -> list[str]:
    """Profile 'miscellaneous tags & topics' — keep only valid 1.3/1.10 codes."""
    _Vocab.load()
    out, seen = [], set()
    if isinstance(value, list):
        for t in value:
            t = str(t).strip()
            if t in _Vocab.misc and t not in seen:
                seen.add(t); out.append(t)
    return out


def _vocab_for(field: str) -> set[str]:
    _Vocab.load()
    if field in ("visa_applying_for", "current_visa_or_greencard_category"):
        return _Vocab.visa
    if field in ("primary_consulate", "consulates"):
        return _Vocab.consulate
    return _Vocab.tag  # tags, concerns_or_questions_tags


# ---------------------------------------------------------------------------
# Gemini tagging engine
# ---------------------------------------------------------------------------

def _master_tags_block() -> str:
    _Vocab.load()
    return (
        "## current_visa_or_greencard_category, visa_applying_for (sections 1.1 + 1.2)\n"
        + ", ".join(_Vocab._visa_list)
        + "\n\n## consulates, primary_consulate (section 1.4)\n"
        + ", ".join(_Vocab._consulate_list)
        + "\n\n## tags, concerns_or_questions_tags (union 1.3,1.5,1.6,1.9,1.10)\n"
        + "# Forms / abbreviations / actions / outcomes (self-explanatory — use exactly as written):\n"
        + ", ".join(_Vocab._tag_plain_list)
        + "\n# Topical / layman concerns (1.10) — pick the tag whose MEANING (after the dash) matches the poster's intent:\n"
        + "\n".join(f"{t} — {d}" if d else t for t, d in _Vocab._misc_pairs)
        + "\n\n## key_stages_or_info keys (section 1.7 + visa/abbr/form/action names)\n"
        + ", ".join(sorted(_Vocab.stage_keys))
        + "\n\n## key_dates keys (section 1.8)\n"
        + ", ".join(_Vocab._date_list)
    )


_SYSTEM_PROMPT = """You are an Immigration Tagging Engine. Read a single candidate posting \
(title + description) about U.S. immigration and return ONE JSON object following the schema. \
Use ONLY tags from the master tag list supplied. NEVER invent new tag strings.

Return ONLY a single JSON object — no prose, no Markdown fences.

# JSON keys to return (all required)
{
  "background_summary": string,                 // 1-3 sentences, factual paraphrase
  "concerns_or_questions_summary": string,      // 1-3 sentences, what is being asked
  "current_visa_or_greencard_category": string[], // present status (1.1/1.2 only)
  "visa_applying_for": string[],                // intended next status (1.1/1.2 only)
  "primary_consulate": string,                  // one 1.4 code or ""
  "consulates": string[],                       // 1.4 codes (includes primary first)
  "tags": string[],                             // background tags (1.3,1.5,1.6,1.9,1.10)
  "concerns_or_questions_tags": string[],       // the active questions (same vocab)
  "principal_country_of_chargeability": string, // ISO-2 or ""
  "employer_type": string,                      // bigtech|consulting|startup|academic|healthcare|government|nonprofit|other|unknown
  "severity": string,                           // critical|high|medium|low
  "resolution_status": string,                  // open|answered|resolved|unknown (default open)
  "derived_topic_cluster": string[],            // 1-3 kebab-case cluster labels
  "key_stages_or_info": object,                 // keys from 1.7; short string values
  "key_dates": object,                          // keys from 1.8; values YYYY-MM-DD
  "language": string,                           // ISO-639-1, default "en"
  "tagging_confidence": number,                 // 0.0..1.0
  "posting_type": string,                       // consular_visa|in_us_status|experience|general_question
  "relevant_sections": string[],                // which tag sections genuinely apply (see below)
  "is_personal_case": boolean                   // true if this describes/asks about the POSTER'S OWN situation, even vaguely or without a specific visa code; false ONLY for a general policy/process/industry discussion not tied to their own case (see "discussion" below)
}

# RULES
- Visa/GC codes (H-1B, F-1, EB-2, ...) go ONLY in current_visa_or_greencard_category / visa_applying_for, NEVER in tags.
- Country/city codes (IN, DEL, MX, ...) go ONLY in consulates / primary_consulate, NEVER in tags.
- A tag string appears in at most ONE of: current_visa_or_greencard_category, consulates, tags, concerns_or_questions_tags. (visa_applying_for may share with current_visa_or_greencard_category.)
- A tag goes in concerns_or_questions_tags only if removing it would change what the user is ASKING.
- If a concept has no matching master tag, omit it from the arrays (surface only in the summaries). Do not invent tags.
- For topical/layman (1.10) tags, choose the tag whose description (the text after "—") best matches the poster's intent — not merely a tag whose NAME looks similar. e.g. use "open-for-attorney" when the poster is asking a question they want an attorney to answer; use "lawyer-recommendation" ONLY when they are asking for attorney names/referrals.
- key_dates values MUST be YYYY-MM-DD.

# RELEVANT SECTIONS (act as the immigration expert: decide which tag sections genuinely apply)
Set "posting_type" to the best fit:
  - consular_visa    : applying for / interviewing for a U.S. visa from a consulate abroad
  - in_us_status     : someone already in the USA dealing with their status/benefits
  - experience       : sharing an experience/outcome, NOT asking anything
  - general_question : a general informational question
Set "relevant_sections" to ONLY the sections that apply to THIS posting. Choose from:
  - "visa_applying_for"                     : include when applying for / seeking a visa or status
  - "consulates"                            : include ONLY when a consulate/embassy abroad is involved (consular_visa)
  - "current_visa_or_greencard_category"    : include when the person currently holds a U.S. status / is inside the USA
  - "tags"                                  : include when there are background facts/forms worth tagging
  - "concerns_or_questions_tags"            : include ONLY when the posting ASKS a question or raises a concern — NEVER for a pure experience share
Return ONLY the sections that truly apply (omit the rest). Example: a consular B1/B2 experience share → ["visa_applying_for","consulates","tags"] (no concerns); an in-US H-1B question → ["current_visa_or_greencard_category","tags","concerns_or_questions_tags"] (no consulate sections).

Always capture the applicant's visa/status in current_visa_or_greencard_category and/or visa_applying_for whenever one is discernible.
Populate key_stages_or_info with discrete outcomes/state facts (e.g. visa_status: approved, I-140: approved) and key_dates with any dates mentioned — these become their own UI sections when present.

family-immigration, employment-immigration, and adjustment-of-status are LAST-RESORT category codes — use them ONLY when the posting is clearly family-based, employment-based, or (for adjustment-of-status) an I-485/AOS filing of unstated basis, but truly gives no way to determine a specific code (IR-1, F2A-FAMILY, EB-2, ...). I-485 and "AOS"/"adjustment of status" are used interchangeably by posters for the same real-world action (filing to become a permanent resident) — treat a mention of either the same way. Never use these as a shortcut when a specific code IS determinable from the text — e.g. an explicit "my wife"/"my husband" mention with a U.S.-citizen petitioner means IR-1, not family-immigration; "filed my I-485 based on my approved I-140 in EB-2" means EB-2, not adjustment-of-status.

Set "is_personal_case" to false ONLY for a general question or discussion about immigration policy, process, or industry-wide news that is NOT tied to the poster's own situation — e.g. "what does everyone think about the new $100k H-1B fee", "why does every category feel backed up this year". Set it to true for EVERYTHING else, including a vague personal question with no specific visa code named — e.g. "is it too late for my priority date to still lock in this year" is personal (uses "my", asks about their own timeline) even though no visa is named. When genuinely unsure, default to true — a posting incorrectly treated as personal just asks the poster to clarify their status; a personal posting incorrectly treated as general discussion loses its personal-status signal entirely. (The system deterministically tags "discussion" when is_personal_case is false and no visa/status was captured — do not tag "discussion" yourself.)

A posting that is mainly a LINK/reference to a news article, with a short reaction or invitation to discuss (not the poster's own case) — e.g. a one-line comment plus a URL — should be tagged with BOTH "news-update" AND "discussion": "news-update" because it's reporting/sharing real news, "discussion" because it's inviting conversation about it, not stating the poster's own status. These two are not mutually exclusive.

"blog" (1.10) is for a standalone informational or educational write-up about U.S. immigration (tips, how-to guides, explainers) that is NOT the poster's own case and NOT primarily a reaction to one specific news item — that distinction is what separates it from "discussion" (which is conversational/reactive) and from "experience-posting" (which is the poster's own lived account). A shared link to someone else's blog/explainer article also gets "blog". Like "discussion", a "blog"-tagged posting with no personal visa/status claim does not need one — do not force a visa/status field to satisfy validation.
"""


def _extract(title: str, description: str) -> dict:
    """Call Gemini → canonical (untrusted) tag JSON. Raises on hard failure."""
    user = (
        f"MASTER_TAGS:\n{_master_tags_block()}\n\n"
        f"POSTING TITLE: {title}\n\nPOSTING DESCRIPTION:\n{description}\n\n"
        "Return the JSON object now."
    )
    client = genai_client()  # shared, 60s timeout
    cfg_kwargs = dict(
        temperature=0.1,
        max_output_tokens=4096,
        response_mime_type="application/json",
    )
    # Disable "thinking" so the whole output budget goes to the JSON (2.5-flash
    # otherwise spends tokens on reasoning and can truncate the JSON mid-string).
    try:
        cfg_kwargs["thinking_config"] = genai.types.ThinkingConfig(thinking_budget=0)
    except Exception:  # noqa: BLE001 - older SDK without ThinkingConfig
        pass
    # Retry transient GCP errors (same backoff policy as documents.import) —
    # tag extraction was previously a single unguarded attempt.
    resp = _retry(lambda: client.models.generate_content(
        model=_gemini_model(),
        contents=f"{_SYSTEM_PROMPT}\n\n{user}",
        config=genai.types.GenerateContentConfig(**cfg_kwargs),
    ), attempts=2)
    raw = (resp.text or "").strip()
    # tolerate accidental fences
    raw = re.sub(r"^```(?:json)?|```$", "", raw, flags=re.MULTILINE).strip()
    return json.loads(raw)


def _clean_group(field: str, value) -> list[str] | str:
    """Coerce a model/user value to the field's shape and drop out-of-vocab entries."""
    vocab = _vocab_for(field)
    if field == "primary_consulate":
        v = (value or "")
        if isinstance(v, list):
            v = v[0] if v else ""
        v = str(v).strip()
        return v if v in vocab else ""
    items = value if isinstance(value, list) else ([value] if value else [])
    seen: list[str] = []
    for it in items:
        s = str(it).strip()
        if s and s in vocab and s not in seen:
            seen.append(s)
    return seen


def _dedup_buckets(groups: dict) -> dict:
    """Enforce the 5-field rule: a tag appears in at most one of
    current_visa_or_greencard_category | consulates | concerns_or_questions_tags | tags.
    (visa_applying_for may share with current_visa_or_greencard_category.) Earlier
    buckets in this priority order win; the tag is removed from later ones."""
    priority = ["current_visa_or_greencard_category", "consulates",
                "concerns_or_questions_tags", "tags"]
    claimed: set[str] = set()
    for field in priority:
        kept = []
        for t in groups.get(field, []):
            if t not in claimed:
                claimed.add(t); kept.append(t)
        groups[field] = kept
    return groups


def _normalize_groups(groups: dict) -> dict:
    """primary_consulate ∈ consulates, then de-duplicate across buckets."""
    if groups.get("primary_consulate") and groups["primary_consulate"] not in groups.get("consulates", []):
        groups["consulates"] = [groups["primary_consulate"], *groups.get("consulates", [])]
    return _dedup_buckets(groups)


_POSTING_TYPES = {"consular_visa", "in_us_status", "experience", "general_question"}

# Form I-130 ("Petition for Alien Relative") has exactly one use: family-based
# immigrant petitions — no employment/diversity/investor/asylum path ever
# touches it. Unlike I-130 -> a specific greencard category (8 possible
# codes: IR-1/IR-2/IR-5/F1/F2A/F2B/F3/F4, indistinguishable from the form
# alone), I-130 -> "this is family-based" is a safe, unambiguous inference.
_I130_TAGS = {"I-130", "i130-filing", "i130-approval"}

# Symmetric to _I130_TAGS above, for the employment side: Form I-140
# ("Immigrant Petition for Alien Worker") has exactly one use — employment-
# based immigrant petitions — no family/diversity/investor/asylum path ever
# touches it, so I-140 -> "this is employment-based" is equally safe and
# unambiguous, even though it can't pin down which specific EB category
# (EB-1/EB-1A/EB-1B/EB-1C/EB-2/EB-3 all file I-140).
_I140_TAGS = {"I-140", "i140-filing", "i140-approval", "i140-portability"}

# Last-resort generic categories (tags-cleaned/1.2-greencard-categories.csv)
# for when a posting is clearly family- or employment-based (the model
# tagged it, or the deterministic _I130_TAGS rule above did) but neither
# the model nor _derive_visa_from_tags() could pin down a specific code —
# e.g. a general discussion post about "filing I-130 and I-485" with no
# stated relationship (spouse/parent/child/sibling all map to different
# codes). Found live: docs/tagging/VISA-VOCAB-GAPS-AND-CURATION-BLOCKERS.md
# Category C/D. Deliberately narrow — only fires when a *tag-level* signal
# already exists; a posting with no family/employment signal at all still
# correctly fails validate() and needs a human to supply real information,
# not a generic label. See _apply_visa_backfill()'s ordering: this only
# ever runs after _derive_visa_from_tags() has already had its chance, so
# a real, specific, derivable code always wins over the generic fallback.
_GENERIC_CATEGORY_FALLBACK = {
    "family-based-immigration": "family-immigration",
    "employment-based-immigration": "employment-immigration",
}

# I-485 (the form) and AOS (the process it's filed for) aren't duplicates —
# they're two names for the same real-world action, used interchangeably by
# posters — but neither is itself a visa/GC CATEGORY: AOS can be filed on a
# family, employment, diversity, or asylum basis, so mentioning it alone
# doesn't tell us which. Every tag below (both the i485-* and aos-* action
# families in 1.6, plus the bare form/abbreviation) represents the same
# "filed for a green card, basis unstated" signal. adjustment-of-status is
# the even-more-generic sibling of family-immigration/employment-immigration
# below it in _apply_visa_backfill()'s ordering — it only fires when even
# THOSE couldn't narrow things down (e.g. no I-130/I-140 signal either).
_AOS_TAGS = {"I-485", "AOS", "i485-filing", "i485-approval", "i485-rfe",
             "aos-filing", "aos-interview", "aos-approval"}

# All three last-resort codes are now valid entries in the model's own visa
# vocab list (they're 1.2 CSV rows like any other), so the model CAN pick one
# directly instead of leaving both fields empty for this function to fill in
# — found live: given "based on my approved I-130 (spouse petition)" (a
# clearly family-based signal), the model still sometimes picks the more
# generic adjustment-of-status on its own, bypassing the specificity
# ordering below entirely (that ordering is only ever consulted when BOTH
# fields start empty). The prompt's "never use these as a shortcut" guidance
# alone isn't reliable enough — same lesson as _apply_discussion_backfill().
_LAST_RESORT_CODES = {"family-immigration", "employment-immigration", "adjustment-of-status"}


def _apply_visa_backfill(groups: dict, is_personal_case=True) -> None:
    """Deterministically fill visa_applying_for/current_visa_or_greencard_category
    in place, trying the more specific signal first:
      1. _derive_visa_from_tags() — a single unambiguous process-tag mapping
         (e.g. h1b-petition -> H-1B, opt-application -> F-1).
      2. _GENERIC_CATEGORY_FALLBACK — a broad family/employment signal
         without enough detail for a specific code.
      3. _AOS_TAGS -> adjustment-of-status — an even broader "filing for a
         green card, basis unknown" signal. Last resort of the last resorts:
         only reached when neither of the above found anything more
         specific, so a real family/employment signal (e.g. an I-130 tag
         alongside the AOS filing) always wins first.
    No-op if either field already holds a REAL (non-last-resort) answer —
    never overrides one, by the model or a human curator's edit. But if the
    ONLY thing present is itself a last-resort code (the model's own,
    possibly premature, choice), that's cleared and re-derived — see
    _LAST_RESORT_CODES above for why this re-derivation is necessary.

    No-op entirely when is_personal_case is False — a background/topic tag
    like "family-based-immigration" or a process tag like "h1b-petition" can
    legitimately appear on content that's just discussing that topic (e.g. a
    news link about H-1B policy, or commentary on family-based overstay
    forgiveness), not the poster's own case. Found live: a link-share post
    with no personal status claim at all still got backfilled to
    family-immigration because the model tagged "family-based-immigration"
    as the ARTICLE's topic — which then suppressed the "discussion" tag
    entirely, since _apply_discussion_backfill() only fires when both visa
    fields are still empty. is_personal_case defaults to True so
    build_canonical()'s call site (no fresh extraction available, operates
    on already client-submitted groups) keeps its existing behavior
    unchanged — only suggest_tags() passes the real classification through."""
    if is_personal_case is False:
        return
    current, applying = groups["current_visa_or_greencard_category"], groups["visa_applying_for"]
    if (current and current[0] not in _LAST_RESORT_CODES) or (applying and applying[0] not in _LAST_RESORT_CODES):
        return
    groups["current_visa_or_greencard_category"] = []
    groups["visa_applying_for"] = []
    derived = _derive_visa_from_tags(groups["tags"])
    if derived:
        groups["visa_applying_for"] = [derived]
        return
    for trigger_tag, fallback in _GENERIC_CATEGORY_FALLBACK.items():
        if trigger_tag in groups["tags"]:
            groups["current_visa_or_greencard_category"] = [fallback]
            return
    if _AOS_TAGS & set(groups["tags"]):
        groups["current_visa_or_greencard_category"] = ["adjustment-of-status"]
        return


def _apply_discussion_backfill(groups: dict, is_personal_case) -> None:
    """Deterministically add the "discussion" tag when a posting has no visa
    signal at all (after _apply_visa_backfill() has already had its chance)
    AND the model classified it as NOT the poster's own case
    (is_personal_case is False). validate() treats "discussion" as an
    exemption from the visa-required rule, same as "news-update" —
    a genuine policy/process/industry discussion has no personal status to
    capture, and shouldn't be rejected for lacking one.

    `is_personal_case` defaults to True (personal) for anything other than
    the literal boolean False — fail closed: a missing/malformed field from
    the model, or an old cached extraction from before this field existed,
    must never accidentally wave a personal posting through unflagged.
    No-op if either visa field is already populated, mirroring
    _apply_visa_backfill()'s own guard."""
    if groups["visa_applying_for"] or groups["current_visa_or_greencard_category"]:
        return
    if is_personal_case is False:
        _add_tag_once(groups, "discussion")


# UI tag sections (primary_consulate is omitted from the UI — it's derived from
# consulates[0] at submit; consulates is the single consulate section).
_UI_TAG_SECTIONS = [f for f in GROUP_FIELDS if f != "primary_consulate"]


def _clean_stages(value) -> dict:
    """Keep only key_stages_or_info entries with a valid 1.7 key AND a value that
    satisfies the key's value-domain (country/outcome/visa/consulate; free text otherwise)."""
    _Vocab.load()
    out: dict = {}
    if isinstance(value, dict):
        for k, v in value.items():
            k, sv = str(k).strip(), str(v).strip()
            if k in _Vocab.stage_keys and sv and stage_value_ok(k, sv):
                out[k] = sv
    return out


def _clean_dates(value) -> dict:
    """Keep only key_dates entries with a valid 1.8 key and a YYYY-MM-DD value."""
    _Vocab.load()
    out: dict = {}
    if isinstance(value, dict):
        for k, v in value.items():
            k, sv = str(k).strip(), str(v).strip()
            if k in _Vocab.date_keys and _DATE_RE.match(sv):
                out[k] = sv
    return out


def _add_tag_once(groups: dict, tag: str) -> None:
    """Append `tag` to groups['tags'] unless it's already there OR already in
    concerns_or_questions_tags. validate() rejects a tag appearing in more
    than one bucket, so every deterministic auto-tag rule (timeline,
    family-based-immigration, ...) must go through this rather than
    checking groups['tags'] alone — the model may have legitimately put the
    same tag in concerns_or_questions_tags instead (e.g. a post that ASKS
    about a case timeline, not just states one)."""
    if tag not in groups["tags"] and tag not in groups["concerns_or_questions_tags"]:
        groups["tags"].append(tag)


def _derive_visa_from_tags(tags: list[str]) -> str:
    """Deterministically infer a single visa/GC code from process tags already
    applied (e.g. 'h1b-petition' -> 'H-1B'), for posts that reference a
    specific visa's process without a personal status claim (tips/advice/
    discussion content that would otherwise fail validate()'s visa-required
    rule). Only backfills when the 1.6 "Associated Visa/Form" mapping is
    unambiguous and that code is itself a valid 1.1/1.2 vocab entry — skips
    form numbers ('I-129') and generic values ('Any visa') automatically,
    since those aren't in _Vocab.visa.

    A "/"-joined mapping (e.g. 'L-1 / H-1B', 'OPT / F-1') isn't automatically
    ambiguous — it's only a real either/or when MORE THAN ONE side is itself
    a selectable 1.1/1.2 code. 'L-1 / H-1B' (a change-of-status pair) has two
    valid codes on either side — genuinely ambiguous, correctly skipped.
    'OPT / F-1' has exactly one ('OPT' is a benefit name, not a visa type,
    so it's never in _Vocab.visa) — no real ambiguity, since OPT/CPT are
    F-1-only benefits. Found live: a real curated post about Initial OPT
    (opt-application -> 'OPT / F-1') failed validate() because the old
    strict 'no "/" at all' check discarded this unambiguous case along with
    the genuinely ambiguous ones — see
    docs/tagging/VISA-VOCAB-GAPS-AND-CURATION-BLOCKERS.md."""
    _Vocab.load()
    for t in tags:
        mapped = _Vocab.visa_form_map.get(t, "")
        if not mapped:
            continue
        if mapped in _Vocab.visa:
            return mapped
        if "/" in mapped:
            candidates = [c.strip() for c in mapped.split("/")]
            valid = [c for c in candidates if c in _Vocab.visa]
            if len(valid) == 1:
                return valid[0]
    return ""


def _relevant_sections(extracted: dict, groups: dict) -> list[str]:
    """The model decides which tag sections apply; fall back to a sensible heuristic."""
    raw = extracted.get("relevant_sections")
    sections = [s for s in raw if s in _UI_TAG_SECTIONS] if isinstance(raw, list) else []
    if not sections:
        # Heuristic fallback: show any non-empty section; always allow background tags.
        sections = [f for f in _UI_TAG_SECTIONS if groups.get(f)]
        if "tags" not in sections:
            sections.append("tags")
    # consulate section only makes sense when a consulate is present
    if not groups.get("consulates"):
        sections = [s for s in sections if s != "consulates"]
    # keep canonical display order
    return [f for f in _UI_TAG_SECTIONS if f in sections]


def suggest_tags(title: str, description: str) -> dict:
    """Return controlled-vocab tags grouped by section, plus which sections are
    relevant to THIS posting (expert-curated), the posting type, and the
    detected stages/outcomes and key dates."""
    extracted = _extract(title, description)
    groups: dict = {f: _clean_group(f, extracted.get(f)) for f in GROUP_FIELDS}
    groups = _normalize_groups(groups)
    is_personal_case = extracted.get("is_personal_case")
    # A posting the model itself classified as NOT the poster's own case
    # must never carry a personal visa/status claim, even if a visa term is
    # literally discernible in the text. Found live: a general H-1B lottery
    # guide correctly got is_personal_case=False and the "blog" tag, but the
    # model still put "H-1B" into visa_applying_for — the RULES section's
    # "always capture... whenever discernible" doesn't reliably distinguish
    # "this is the applicant's own status" from "this term appears in a
    # general-topic post." Force-clear rather than trust the model to also
    # correctly apply that distinction — same "enforce in code, not just in
    # the prompt" reasoning as _apply_visa_backfill()'s is_personal_case gate.
    if is_personal_case is False:
        groups["current_visa_or_greencard_category"] = []
        groups["visa_applying_for"] = []
    ptype = extracted.get("posting_type")
    if ptype not in _POSTING_TYPES:
        ptype = ""
    key_dates = _clean_dates(extracted.get("key_dates"))
    # Any posting with dated milestones gets `timeline` deterministically —
    # the model's own judgment on this thin/generic tag is inconsistent, so
    # don't leave it to chance (same rule build_experience_canonical() already
    # applies for phase-J experiences).
    if key_dates:
        _add_tag_once(groups, "timeline")
    # I-130 in any form -> family-based-immigration, I-140 -> employment-
    # based-immigration, deterministically (see _I130_TAGS/_I140_TAGS).
    # Doesn't touch current_visa_or_greencard_category — neither form alone
    # can tell us the specific category (I-130: spouse/parent/sibling/etc.;
    # I-140: EB-1/EB-1A/EB-1B/EB-1C/EB-2/EB-3). Runs BEFORE the visa
    # backfill below, not after — _apply_visa_backfill's generic-fallback
    # step keys off these exact tags, so they need to already be present by
    # the time that runs (matters when the model itself didn't
    # independently emit the topic tag and only this deterministic rule
    # adds it).
    if _I130_TAGS & set(groups["tags"]):
        _add_tag_once(groups, "family-based-immigration")
    if _I140_TAGS & set(groups["tags"]):
        _add_tag_once(groups, "employment-based-immigration")
    # Tips/advice/discussion content often references a specific visa's
    # process tags (e.g. h1b-petition) without a personal status claim, or
    # a family/employment-based post that never states enough detail for a
    # specific code — both would otherwise fail validate()'s visa-required
    # rule. Backfill deterministically from the post's own tags rather than
    # requiring a human to notice and hand-add it every time — see
    # _apply_visa_backfill(). Gated on is_personal_case: a background/topic
    # tag can legitimately describe what a NON-personal post is ABOUT (e.g.
    # a news link commenting on family-based overstay policy), not the
    # poster's own status.
    _apply_visa_backfill(groups, is_personal_case)
    # Last resort, after every visa-derivation attempt above has come up
    # empty: see _apply_discussion_backfill().
    _apply_discussion_backfill(groups, is_personal_case)
    return {
        "groups": groups,
        "relevant_sections": _relevant_sections(extracted, groups),
        "posting_type": ptype,
        "key_stages_or_info": _clean_stages(extracted.get("key_stages_or_info")),
        "key_dates": key_dates,
    }


# Fields returned by suggest_query_tags(), in the same names search_client's
# suggested_filters()/_facets_filter() already use for facet field ids — so a
# toggled query-tag chip's "field:code" id plugs directly into the frontend's
# existing selectedFacets mechanism with no translation layer.
_QUERY_TAG_FIELDS = ["visa_applying_for", "current_visa_or_greencard_category", "consulates", "tags"]


def suggest_query_tags(query: str) -> list[dict]:
    """Run the same Gemini-based extraction used for postings, scoped to a
    search query string, and return matches as [{field, code, label}, ...] —
    the same shape suggested_filters() already uses for facet chips, so a
    toggled query-tag chip plugs directly into the frontend's existing
    facet-filter state (field:code ids), no new mechanism needed on either
    client (features/ui-changes-1/changes-2-.md item 4).

    Deliberately NOT a thin wrapper around suggest_tags(): that function
    requires separate title/description (Pydantic-gated to min_length 3/10
    on its own endpoint, /api/tag-suggest) and returns a much larger shape
    (relevant_sections, posting_type, key_stages_or_info, key_dates) that's
    meaningless for a bare search string. Here the query stands in for the
    "title" with an empty description; the only guard is non-empty input.
    This is a real Gemini call, not free — callers should trigger it on
    search submit, not per keystroke."""
    q = (query or "").strip()
    if not q:
        return []
    extracted = _extract(q, "")
    groups = {f: _clean_group(f, extracted.get(f)) for f in GROUP_FIELDS}
    groups = _normalize_groups(groups)
    out: list[dict] = []
    for field in _QUERY_TAG_FIELDS:
        for code in groups.get(field) or []:
            out.append({"field": field, "code": code, "label": code})
    return out


# ---------------------------------------------------------------------------
# Validation (subset of JSON-SCHEMA-FIELD-DICTIONARY §3)
# ---------------------------------------------------------------------------

_ENUM_EMPLOYER = {"bigtech", "consulting", "startup", "academic", "healthcare",
                  "government", "nonprofit", "other", "unknown"}
_ENUM_SEVERITY = {"critical", "high", "medium", "low"}
_ENUM_RESOLUTION = {"open", "answered", "resolved", "unknown"}
_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def validate(c: dict) -> list[str]:
    _Vocab.load()
    errs: list[str] = []
    # A visa/status MUST be captured in at least one of the two visa fields —
    # except for content with nothing personal to require a status for:
    # (1) `news-update` — general policy/news content (deterministic, see
    # build_canonical() callers like publish_gov_news_item()) — see
    # docs/ingestion/GOV-NEWS-INGESTION-PLAN.md §3.4; (2) `discussion` — a
    # genuine general discussion/question about policy, process, or industry
    # news, not the poster's own case (deterministically tagged by
    # suggest_tags() when is_personal_case is false); (3) `blog` — a
    # standalone informational/educational write-up, same reasoning as
    # discussion but for non-reactive content (see _SYSTEM_PROMPT). A
    # posting that DOES also tie to a specific visa still gets tagged with
    # it normally under any of these, so no signal is lost either way.
    # Checked in both buckets — _add_tag_once() is itself bucket-agnostic
    # (won't double-add if the tag already landed in
    # concerns_or_questions_tags some other way), so validate() must be too.
    exempt_tags = set(c.get("tags", [])) | set(c.get("concerns_or_questions_tags", []))
    _NO_PERSONAL_STATUS_TAGS = {"news-update", "discussion", "blog"}
    if (not c.get("current_visa_or_greencard_category") and not c.get("visa_applying_for")
            and not (_NO_PERSONAL_STATUS_TAGS & exempt_tags)):
        errs.append("Capture a visa/status in 'Current status' or 'Visa applying for' before submitting")
    for f in ("current_visa_or_greencard_category", "visa_applying_for"):
        for t in c.get(f, []):
            if t not in _Vocab.visa:
                errs.append(f"{f}: '{t}' not in visa vocab")
    for t in c.get("consulates", []):
        if t not in _Vocab.consulate:
            errs.append(f"consulates: '{t}' not in consulate vocab")
    pc = c.get("primary_consulate", "")
    if pc and pc not in c.get("consulates", []):
        errs.append("primary_consulate must be within consulates")
    for f in ("tags", "concerns_or_questions_tags"):
        for t in c.get(f, []):
            if t not in _Vocab.tag:
                errs.append(f"{f}: '{t}' not in tag vocab")
    # no tag in more than one of these arrays
    buckets = ["current_visa_or_greencard_category", "consulates", "tags", "concerns_or_questions_tags"]
    seen: dict[str, str] = {}
    for f in buckets:
        for t in c.get(f, []):
            if t in seen:
                errs.append(f"tag '{t}' appears in both {seen[t]} and {f}")
            seen[t] = f
    if c.get("employer_type") not in _ENUM_EMPLOYER:
        errs.append("employer_type invalid")
    if c.get("severity") not in _ENUM_SEVERITY:
        errs.append("severity invalid")
    if c.get("resolution_status") not in _ENUM_RESOLUTION:
        errs.append("resolution_status invalid")
    for k, v in (c.get("key_dates") or {}).items():
        if not _DATE_RE.match(str(v)):
            errs.append(f"key_dates['{k}'] not YYYY-MM-DD")
    return errs


# ---------------------------------------------------------------------------
# Build canonical sidecar JSON
# ---------------------------------------------------------------------------

_ADJ = ["calm", "bright", "swift", "lucky", "brave", "quiet", "eager", "kind", "bold", "wise"]
_NOUN = ["falcon", "harbor", "maple", "comet", "river", "cedar", "lark", "delta", "ember", "ridge"]


def _synthetic_handle() -> str:
    return f"{secrets.choice(_ADJ)}-{secrets.choice(_NOUN)}-{secrets.randbelow(9000) + 1000}"


# Strict shape of a generated handle. Used to tell an anonymous handle apart from
# a legacy real-name/email-seeded username (profile.is_anonymous_handle / the
# anonymize_usernames migration).
HANDLE_RE = re.compile(r"^[a-z]+-[a-z]+-\d{4}$")


def generate_handle() -> str:
    """Public alias for the anonymous Reddit-style handle generator (adj-noun-NNNN).
    Single source of truth for BOTH per-posting author handles AND profile
    usernames — real names never seed either."""
    return _synthetic_handle()


# Valid client_platform values — a soft analytics field, not content-integrity
# critical (see docs/ingestion/PATH-B-PROVENANCE-PLAN.md), so an invalid/unknown
# value clamps to "" rather than raising.
_CLIENT_PLATFORMS = {"web", "ios", "android"}


def content_hash_for(title: str, description: str) -> str:
    """Deterministic fingerprint of a doc's content, used by build_canonical()
    and by scripts/curation/poll_gov_news.py to classify a source item as
    new/unchanged/edited BEFORE deciding whether to publish — must be a
    shared function, not two copies of the same formula, so the two can
    never drift out of sync."""
    return hashlib.sha256(f"{title}\n{description}".encode()).hexdigest()


def build_canonical(title: str, description: str, tags: dict,
                    key_stages: dict | None = None, key_dates: dict | None = None,
                    extracted: dict | None = None,
                    *,
                    channel: str = CHANNEL,
                    ingestion_method: str = "user_post",
                    source_system: str = "",
                    subreddit: str = "",
                    reddit_post_id: str = "",
                    full_url: str = "",
                    posting_date: str = "",
                    client_platform: str = "",
                    author_handle: str = "",
                    source_item_id: str = "") -> dict:
    """Assemble the full sidecar JSON. `tags`/`key_stages`/`key_dates` (user-edited)
    override the model; remaining context fields come from `extracted`.

    The keyword-only params exist for backend-ingested (Reddit, gov-news) content —
    see docs/ingestion/PATH-B-PROVENANCE-PLAN.md and
    docs/ingestion/GOV-NEWS-INGESTION-PLAN.md. Every default reproduces today's
    exact app-composer behavior; only `publish_reddit_posting()`/
    `publish_gov_news_item()` (neither wired to a public route) ever pass
    them explicitly."""
    ex = extracted or {}
    now = datetime.now(timezone.utc)
    # posting_date: the ORIGINAL posting date (overridable for backend-ingested
    # content) — defaults to today for a live app submission, where posting IS
    # the ingestion moment. ingestion_timestamp (below) is ALWAYS "now",
    # regardless — "when WE processed it" is a separate concept from "when it
    # was originally posted." See PATH-B-PROVENANCE-PLAN.md's field table.
    date_str = posting_date or now.strftime("%Y-%m-%d")
    ts = now.strftime("%Y-%m-%dT%H:%M:%SZ")
    if subreddit and reddit_post_id:
        # Deterministic ID (doubles as a dedup key) for backend-ingested
        # content with a real source post — matches the scheme from the
        # original ingestion pipeline spec, rather than a random suffix.
        case_id = f"{channel}-{date_str}-{subreddit}-{reddit_post_id}"
    elif source_item_id:
        # Gov-news scheme (GOV-NEWS-INGESTION-PLAN.md §3.1): deterministic
        # from the source's stable item id (e.g. an RSS guid), keyed by
        # source_system so it doubles as the poll pipeline's dedup key.
        # Leading segment is `channel` exactly, matching the reddit scheme
        # above and delete_content()'s case_id.split("-", 1)[0] convention.
        short = hashlib.sha256(source_item_id.encode()).hexdigest()[:8]
        case_id = f"{channel}-{source_system}-{date_str}-{short}"
    else:
        short = secrets.token_hex(4)
        case_id = f"{channel}-{date_str}-{short}"
    prefix = f"gs://{_bucket_name()}/{date_str}/{channel}/"
    if client_platform not in _CLIENT_PLATFORMS:
        client_platform = ""
    # Content fingerprint (title+description) — cheap to compute for every
    # doc kind, but exists specifically so a polling ingestion pipeline
    # (gov-news) can detect an edited source item without diffing full text
    # on every poll. See GOV-NEWS-INGESTION-PLAN.md §5.2/§5.3. A shared
    # helper (not inlined) so the poll script's pre-publish classification
    # hash can never drift from what actually gets stored.
    content_hash = content_hash_for(title, description)

    groups = {f: _clean_group(f, tags.get(f)) for f in GROUP_FIELDS}
    groups = _normalize_groups(groups)
    # primary_consulate is no longer collected in the UI — derive it from the
    # first consulate so the schema/validator stay satisfied.
    if not groups["primary_consulate"] and groups["consulates"]:
        groups["primary_consulate"] = groups["consulates"][0]

    bg = str(ex.get("background_summary") or "").strip() or "<summary_pending_llm>"
    cq = str(ex.get("concerns_or_questions_summary") or "").strip() or title
    # Prefer the user-edited stages/dates; fall back to the model's extraction.
    stages = _clean_stages(key_stages) or _clean_stages(ex.get("key_stages_or_info"))
    dates = _clean_dates(key_dates) or _clean_dates(ex.get("key_dates"))
    # Any document with dated milestones gets `timeline` deterministically —
    # single point of truth for every caller (suggest_tags already adds it too,
    # so this is normally a no-op there; it also covers callers that build
    # `tags` directly, e.g. build_experience_canonical()'s own duplicate check).
    if dates:
        _add_tag_once(groups, "timeline")

    # I-130 -> family-based-immigration, I-140 -> employment-based-
    # immigration, deterministically — single point of truth for every
    # caller, same reasoning as the timeline rule above. Runs BEFORE the
    # visa backfill below — see the matching comment in suggest_tags() for
    # why the order matters.
    if _I130_TAGS & set(groups["tags"]):
        _add_tag_once(groups, "family-based-immigration")
    if _I140_TAGS & set(groups["tags"]):
        _add_tag_once(groups, "employment-based-immigration")

    # Tips/advice/discussion content often references a specific visa's
    # process tags (e.g. h1b-petition) without a personal status claim, or
    # a family/employment-based post with no stated detail for a specific
    # code — both otherwise fail validate()'s visa-required rule. Backfill
    # deterministically from the post's own tags — single point of truth
    # for every caller, same reasoning as the timeline rule above. See
    # _apply_visa_backfill().
    _apply_visa_backfill(groups)

    all_tags = (
        groups["current_visa_or_greencard_category"]
        + groups["visa_applying_for"]
        + groups["consulates"]
        + groups["tags"]
        + groups["concerns_or_questions_tags"]
    )
    embedding_text = (
        f"{title}. {bg}. {cq}. Tags: {', '.join(all_tags)}. "
        f"Stages: {', '.join(f'{k}:{v}' for k, v in stages.items())}. "
        f"Dates: {', '.join(f'{k}:{v}' for k, v in dates.items())}."
    )

    return {
        "case_id": case_id,
        # provenance
        "ingestion_method": ingestion_method,
        "source_system": source_system or SOURCE_SYSTEM,
        "channel": channel,
        "source_url": APP_BASE_URL,
        "source_uri": f"{APP_BASE_URL}/case/{case_id}",
        "subreddit": subreddit,
        # A fixed per-source handle (e.g. "USCIS") overrides the synthetic
        # per-item handle for backend-ingested content with a real source
        # identity — see GOV-NEWS-INGESTION-PLAN.md §3.6. Never generated
        # per-item for that content: there's no "user" behind it to vary.
        "author_handle": author_handle or _synthetic_handle(),
        "full_url": full_url or f"{APP_BASE_URL}/case/{case_id}",
        "post_title": title,
        "language": str(ex.get("language") or "en"),
        "client_platform": client_platform,
        "source_item_id": source_item_id,
        "content_hash": content_hash,
        # timestamps
        "posting_date": date_str,
        "ingestion_timestamp": ts,
        "last_updated_timestamp": ts,
        # quality
        "tagging_confidence": float(ex.get("tagging_confidence") or 0.9),
        "source_metadata": (
            f"Manually curated from r/{subreddit}" if subreddit
            else "Submitted via meridianjourney.ai web composer"
        ),
        "gcs_path": prefix,
        # summaries
        "background_summary": bg,
        "concerns_or_questions_summary": cq,
        # 5 sibling tag fields (user-edited)
        "current_visa_or_greencard_category": groups["current_visa_or_greencard_category"],
        "visa_applying_for": groups["visa_applying_for"],
        "primary_consulate": groups["primary_consulate"],
        "consulates": groups["consulates"],
        "tags": groups["tags"],
        "concerns_or_questions_tags": groups["concerns_or_questions_tags"],
        # case context
        "principal_country_of_chargeability": str(ex.get("principal_country_of_chargeability") or ""),
        "employer_type": str(ex.get("employer_type") or "unknown"),
        "severity": str(ex.get("severity") or "low"),
        "resolution_status": str(ex.get("resolution_status") or "open"),
        "derived_topic_cluster": ex.get("derived_topic_cluster") if isinstance(ex.get("derived_topic_cluster"), list) else [],
        # structured kv
        "key_stages_or_info": stages,
        "key_dates": dates,
        # embedding
        "embedding_text": embedding_text,
        # provenance for analytics
        "doc_kind": "post",
        "parent_case_id": "",
        "reddit_post_id": reddit_post_id,
    }


def _markdown_body(title: str, description: str) -> str:
    return f"# {title}\n\n{description}\n"


# ---------------------------------------------------------------------------
# Persist: GCS sidecar → documents.import → BigQuery
# ---------------------------------------------------------------------------

def _write_gcs(canonical: dict, md_body: str) -> tuple[str, str]:
    """Write .md (first) then .json (last) to the date/channel prefix. Returns (md_uri, json_uri)."""
    bucket_name = _bucket_name()
    case_id = canonical["case_id"]
    date_str = canonical["posting_date"]
    # Bug fixed: this used to reference the module-level CHANNEL constant
    # ("app") unconditionally, so backend-ingested (channel="reddit") content
    # would land under an "app/" GCS prefix regardless of its real channel.
    base = f"{date_str}/{canonical['channel']}/{case_id}"
    client = storage.Client(project=_project())
    bucket = client.bucket(bucket_name)
    bucket.blob(f"{base}.md").upload_from_string(md_body, content_type="text/markdown")
    bucket.blob(f"{base}.json").upload_from_string(
        json.dumps(canonical, ensure_ascii=False, indent=2), content_type="application/json"
    )
    return f"gs://{bucket_name}/{base}.md", f"gs://{bucket_name}/{base}.json"


# Transient GCP errors worth retrying on the import critical path. App postings
# reach Vertex AI Search ONLY via this inline documents.import (the datastore's
# daily GCS auto-sync is scoped to the reddit/ prefix), so a transient blip must
# not silently drop a user's post — retry with exponential backoff, then surface.
_IMPORT_RETRYABLE = (ServiceUnavailable, DeadlineExceeded, InternalServerError, ResourceExhausted, Aborted)


def _retry(fn, attempts: int = 4, base_delay: float = 1.0):
    """Call fn(), retrying transient GCP errors with exponential backoff."""
    last: Exception | None = None
    for i in range(attempts):
        try:
            return fn()
        except _IMPORT_RETRYABLE as e:  # noqa: PERF203
            last = e
            if i < attempts - 1:
                wait = base_delay * (2 ** i)
                print(f"posting: transient import error ({type(e).__name__}); "
                      f"retry {i + 1}/{attempts - 1} in {wait:.1f}s")
                time.sleep(wait)
    print(f"posting: datastore import failed after {attempts} attempts: {last}")
    raise last  # type: ignore[misc]


def _import_to_datastore(canonical: dict, md_uri: str) -> None:
    """Upsert one document (struct_data + .md content) into DS-1 via documents.import.

    Retries transient GCP errors with backoff: this inline import is the ONLY path
    app postings take into Vertex AI Search, so a momentary blip must not silently
    drop the post. The upsert is idempotent (INCREMENTAL reconciliation, keyed by
    case_id), so re-issuing is safe; a persistent failure still raises so the
    publish call surfaces the error rather than reporting a false `indexed: True`."""
    project, location, datastore = _project(), _ds_location(), _datastore()
    doc_client = de.DocumentServiceClient(client_options=ClientOptions(quota_project_id=project))
    parent = (
        f"projects/{project}/locations/{location}/collections/default_collection"
        f"/dataStores/{datastore}/branches/default_branch"
    )
    document = de.Document(
        id=canonical["case_id"],
        struct_data=canonical,
        content=de.Document.Content(mime_type="text/plain", uri=md_uri),
    )
    request = de.ImportDocumentsRequest(
        parent=parent,
        inline_source=de.ImportDocumentsRequest.InlineSource(documents=[document]),
        reconciliation_mode=de.ImportDocumentsRequest.ReconciliationMode.INCREMENTAL,
    )

    def _do_import():
        return doc_client.import_documents(request=request).result(timeout=120)

    _retry(_do_import)


_BQ_SCHEMA_FIELDS = [
    ("case_id", "STRING"), ("channel", "STRING"), ("ingestion_method", "STRING"),
    ("client_platform", "STRING"),
    ("source_system", "STRING"), ("source_uri", "STRING"),
    ("subreddit", "STRING"), ("full_url", "STRING"), ("post_title", "STRING"),
    ("language", "STRING"), ("posting_date", "DATE"), ("ingestion_timestamp", "TIMESTAMP"),
    ("last_updated_timestamp", "TIMESTAMP"), ("tagging_confidence", "FLOAT64"),
    ("gcs_path", "STRING"), ("background_summary", "STRING"),
    ("concerns_or_questions_summary", "STRING"),
    ("current_visa_or_greencard_category", "STRING", "REPEATED"),
    ("visa_applying_for", "STRING", "REPEATED"), ("primary_consulate", "STRING"),
    ("consulates", "STRING", "REPEATED"), ("tags", "STRING", "REPEATED"),
    ("concerns_or_questions_tags", "STRING", "REPEATED"),
    ("principal_country_of_chargeability", "STRING"), ("employer_type", "STRING"),
    ("severity", "STRING"), ("resolution_status", "STRING"),
    ("derived_topic_cluster", "STRING", "REPEATED"), ("key_stages_or_info", "JSON"),
    ("key_dates", "JSON"), ("embedding_text", "STRING"), ("doc_kind", "STRING"),
    ("parent_case_id", "STRING"), ("reddit_post_id", "STRING"), ("pipeline_run_id", "STRING"),
    ("source_item_id", "STRING"), ("content_hash", "STRING"),
]


def _ensure_bq_table(client, dataset_id: str, table_id: str):
    """Create the postings dataset + postings_metadata table if they don't exist;
    if the table already exists, add any _BQ_SCHEMA_FIELDS columns it's missing
    (BigQuery allows adding NULLABLE columns to a live table with no downtime).
    Without this, adding a new field here + to the row dict in _write_bigquery
    would silently break every future insert against an already-existing table
    — insert_rows_json rejects rows with fields the live schema doesn't have."""
    from google.cloud import bigquery
    from google.api_core.exceptions import NotFound

    try:
        client.get_dataset(dataset_id)
    except NotFound:
        ds = bigquery.Dataset(f"{client.project}.{dataset_id}")
        ds.location = "US"
        client.create_dataset(ds, exists_ok=True)

    schema = [bigquery.SchemaField(f[0], f[1], mode=(f[2] if len(f) > 2 else "NULLABLE"))
              for f in _BQ_SCHEMA_FIELDS]
    try:
        table = client.get_table(table_id)
    except NotFound:
        table = bigquery.Table(table_id, schema=schema)
        table.time_partitioning = bigquery.TimePartitioning(field="posting_date")
        return client.create_table(table, exists_ok=True)

    existing_names = {f.name for f in table.schema}
    missing = [f for f in schema if f.name not in existing_names]
    if missing:
        table.schema = list(table.schema) + missing
        table = client.update_table(table, ["schema"])
        print(f"posting: added BQ column(s): {[f.name for f in missing]}")
    return table


def _pipeline_run_id() -> str:
    """Provenance marker stamped on each BQ row. Defaults to the live web
    composer. Integration tests set POSTING_PIPELINE_RUN_ID=test-e2e so their
    rows are identifiable and bulk-purgeable (see purge_test_bq_rows)."""
    return os.getenv("POSTING_PIPELINE_RUN_ID", "web-composer")


def purge_test_bq_rows(marker_prefix: str = "test-") -> int:
    """Delete BQ rows whose pipeline_run_id starts with `marker_prefix`.

    The `posting_date < CURRENT_DATE()` guard avoids BigQuery's "UPDATE/DELETE
    on recently streamed rows is not allowed" error (insert_rows_json lands rows
    in a streaming buffer for up to ~90 min): same-day test rows are purged on
    the next day's run, so the table never accrues more than one day of markers.
    Returns the affected row count (0 if BQ is unavailable / table absent)."""
    try:
        from google.cloud import bigquery
    except ImportError:
        return 0
    client = bigquery.Client(project=_project())
    table_id = f"{_project()}.postings.postings_metadata"
    sql = (f"DELETE FROM `{table_id}` "
           f"WHERE STARTS_WITH(pipeline_run_id, @marker) "
           f"AND posting_date < CURRENT_DATE()")
    cfg = bigquery.QueryJobConfig(query_parameters=[
        bigquery.ScalarQueryParameter("marker", "STRING", marker_prefix)])
    try:
        job = client.query(sql, job_config=cfg)
        job.result()
        n = job.num_dml_affected_rows or 0
        print(f"posting.purge_test_bq_rows: deleted {n} row(s) (marker={marker_prefix!r})")
        return n
    except Exception as e:  # noqa: BLE001 - cleanup is best-effort
        print(f"posting.purge_test_bq_rows: skipped ({type(e).__name__}: {e})")
        return 0


def _write_bigquery(canonical: dict, pipeline_run_id: str = "", delete_existing: bool = False) -> None:
    """Append a row to postings.postings_metadata (self-provisions dataset+table;
    non-blocking for the user if BQ is unavailable). `pipeline_run_id` lets a
    caller other than the live web/mobile route (e.g. a Reddit curation script)
    stamp its own marker instead of the _pipeline_run_id() env-var default.

    `delete_existing=True` (gov-news re-publishes of an edited source item,
    GOV-NEWS-INGESTION-PLAN.md §5.3) deletes any prior row for this case_id
    before inserting, so an edit updates in place instead of appending a
    duplicate — insert_rows_json alone only ever appends.

    The guard is on `ingestion_timestamp`, NOT `posting_date` — deliberately
    different from purge_test_bq_rows()'s `posting_date < CURRENT_DATE()`
    pattern, even though the underlying BigQuery constraint (rows sit in a
    streaming buffer for up to ~90 min and can't be DELETEd during that
    window) is the same one both guards exist for. purge_test_bq_rows()'s
    rows are never backdated, so `posting_date` and "when the row was
    inserted" are always the same day there — but gov-news content IS
    backdated (posting_date is the source's real, possibly months-old,
    original publish date; see build_canonical()'s date_str). Guarding on
    posting_date here would evaluate "before today" for a historical article
    inserted moments ago during a backfill, letting a DELETE through against
    a row still genuinely in the streaming buffer — the exact error this
    guard exists to avoid. Guarding on `ingestion_timestamp` instead checks
    actual insert recency, which is what the streaming-buffer restriction
    actually depends on, regardless of the content's own date. A same-day
    (recent-ingestion) edit's DELETE is therefore a safe no-op (0 rows
    affected, not an error) that leaves a temporary duplicate resolved by a
    later edit or the dedup map's latest-by-ingestion_timestamp read — never
    called for a brand-new item, where there's nothing to delete either
    way."""
    try:
        from google.cloud import bigquery  # noqa: F401
    except ImportError:
        print("posting: google-cloud-bigquery not installed; skipping BQ row")
        return
    from google.cloud import bigquery
    client = bigquery.Client(project=_project())
    table_id = f"{_project()}.postings.postings_metadata"
    row = {
        "case_id": canonical["case_id"],
        "channel": canonical["channel"],
        "ingestion_method": canonical["ingestion_method"],
        "client_platform": canonical.get("client_platform", ""),
        "source_system": canonical["source_system"],
        "source_uri": canonical["source_uri"],
        "subreddit": canonical["subreddit"],
        "full_url": canonical["full_url"],
        "post_title": canonical["post_title"],
        "language": canonical["language"],
        "posting_date": canonical["posting_date"],
        "ingestion_timestamp": canonical["ingestion_timestamp"],
        "last_updated_timestamp": canonical["last_updated_timestamp"],
        "tagging_confidence": canonical["tagging_confidence"],
        "gcs_path": canonical["gcs_path"],
        "background_summary": canonical["background_summary"],
        "concerns_or_questions_summary": canonical["concerns_or_questions_summary"],
        "current_visa_or_greencard_category": canonical["current_visa_or_greencard_category"],
        "visa_applying_for": canonical["visa_applying_for"],
        "primary_consulate": canonical["primary_consulate"],
        "consulates": canonical["consulates"],
        "tags": canonical["tags"],
        "concerns_or_questions_tags": canonical["concerns_or_questions_tags"],
        "principal_country_of_chargeability": canonical["principal_country_of_chargeability"],
        "employer_type": canonical["employer_type"],
        "severity": canonical["severity"],
        "resolution_status": canonical["resolution_status"],
        "derived_topic_cluster": canonical["derived_topic_cluster"],
        "key_stages_or_info": json.dumps(canonical["key_stages_or_info"]),
        "key_dates": json.dumps(canonical["key_dates"]),
        "embedding_text": canonical["embedding_text"],
        "doc_kind": canonical["doc_kind"],
        "parent_case_id": canonical["parent_case_id"],
        "reddit_post_id": canonical["reddit_post_id"],
        "pipeline_run_id": pipeline_run_id or _pipeline_run_id(),
        "source_item_id": canonical.get("source_item_id", ""),
        "content_hash": canonical.get("content_hash", ""),
    }
    try:
        _ensure_bq_table(client, "postings", table_id)
        if delete_existing:
            sql = (f"DELETE FROM `{table_id}` "
                   f"WHERE case_id = @case_id "
                   f"AND ingestion_timestamp < TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 90 MINUTE)")
            cfg = bigquery.QueryJobConfig(query_parameters=[
                bigquery.ScalarQueryParameter("case_id", "STRING", canonical["case_id"])])
            client.query(sql, job_config=cfg).result()
        errors = client.insert_rows_json(table_id, [row])
        if errors:
            print(f"posting: BQ insert errors: {errors}")
    except Exception as e:  # noqa: BLE001 - BQ is non-blocking for the user
        print(f"posting: BQ write skipped ({type(e).__name__}: {e})")


def publish_posting(title: str, description: str, tags: dict,
                    key_stages: dict | None = None, key_dates: dict | None = None,
                    client_platform: str = "") -> dict:
    """Full publish path. Returns {case_id, gcs_path, indexed, author_handle}.
    `client_platform` ("web"/"ios"/"android") is a soft analytics field the
    caller (the composer UI) reports about itself — see
    docs/ingestion/PATH-B-PROVENANCE-PLAN.md. Invalid/unknown values are
    clamped to "" inside build_canonical(), never rejected."""
    # Redact PII (email / phone / A-number) before anything is tagged, written to
    # GCS, indexed, or sent to BigQuery — postings are read by other users, so
    # contact info must never survive into the stored content. Local import
    # avoids a module-load cycle (profile imports posting at top level).
    from profile import scrub_pii
    title = scrub_pii(title or "")
    description = scrub_pii(description or "")

    # Content moderation (App Store Guideline 1.2): reject objectionable content
    # before it is tagged/stored. Raises ValueError → mapped to HTTP 422 by the
    # /api/postings route. Runs after PII scrub so the classifier sees clean text.
    import moderation
    moderation.check_text(f"{title}\n\n{description}")

    extracted = None
    try:
        extracted = _extract(title, description)  # for summaries/severity/context
    except Exception as e:  # noqa: BLE001 - fall back to placeholders if the tagger fails
        print(f"posting: extraction for context failed ({e}); using placeholders")

    canonical = build_canonical(title, description, tags, key_stages, key_dates, extracted,
                                client_platform=client_platform)
    errs = validate(canonical)
    if errs:
        raise ValueError("; ".join(errs))

    md_uri, _json_uri = _write_gcs(canonical, _markdown_body(title, description))
    _import_to_datastore(canonical, md_uri)
    _write_bigquery(canonical)
    return {
        "case_id": canonical["case_id"],
        "gcs_path": canonical["gcs_path"],
        "indexed": True,
        "author_handle": canonical["author_handle"],
    }


def publish_reddit_posting(title: str, description: str, tags: dict,
                           subreddit: str, reddit_post_id: str, full_url: str,
                           posting_date: str, key_stages: dict | None = None,
                           key_dates: dict | None = None,
                           extracted: dict | None = None) -> dict:
    """Publish path for backend-ingested (Reddit) content — Path B, see
    docs/ingestion/PATH-B-PROVENANCE-PLAN.md. Deliberately NOT wired to any
    FastAPI route: channel/ingestion_method/source_system/posting_date are
    trust-sensitive (a public route accepting them would let any user spoof
    Reddit provenance or backdate a post), so this is only ever called from
    a local script with direct repo/GCP access, never over HTTP.

    Unlike publish_posting(), this does NOT call profile.scrub_pii() or
    moderation.check_text() — Reddit content is already public (D-017: not
    treated as containing sensitive PII the way a live user's private
    submission is) and is expected to have already passed human curator
    review before this is called. Returns the same shape as
    publish_posting()."""
    canonical = build_canonical(
        title, description, tags, key_stages, key_dates, extracted,
        channel="reddit", ingestion_method="manual_curation", source_system="reddit",
        subreddit=subreddit, reddit_post_id=reddit_post_id, full_url=full_url,
        posting_date=posting_date,
    )
    errs = validate(canonical)
    if errs:
        raise ValueError("; ".join(errs))

    md_uri, _json_uri = _write_gcs(canonical, _markdown_body(title, description))
    _import_to_datastore(canonical, md_uri)
    _write_bigquery(canonical, pipeline_run_id="reddit-manual-curation")
    return {
        "case_id": canonical["case_id"],
        "gcs_path": canonical["gcs_path"],
        "indexed": True,
        "author_handle": canonical["author_handle"],
    }


def _gov_news_tags(extracted_tags: list[str], content_type: str) -> list[str]:
    """Deterministically add `news-update` when — and only when —
    content_type == "news"; STRIP it otherwise, even if already present.
    Pure/no-network on purpose: this is the exact decision
    docs/ingestion/GOV-NEWS-MULTI-SOURCE-CONFIG.md §5 documents (a news
    source's content gets tagged as a news update; a forum posting's
    content does not, since it isn't one), pulled out of
    publish_gov_news_item() so it's unit-testable without GCP — see
    tests/test_posting_tagging.py.

    The strip half matters because `news-update` is a real, LLM-selectable
    vocabulary entry (tags-cleaned/1.10-common-misc.csv) — _extract() can
    legitimately choose it on its own for content that reads like
    policy/news (e.g. a forum post about a visa fee change), independent
    of this function. A version that only ever ADDED the tag for
    content_type=="news" left that model-chosen tag untouched for every
    other content_type, which is exactly backwards from "can never be
    applied" — confirmed live: a real immihelp (content_type=
    'forum_posting') posting titled 'US visa fees going up...' came back
    from _extract() with `news-update` already in its tags, and the old
    implementation passed it straight through. See E45a in
    tests/test_posting_tagging.py."""
    tags = list(dict.fromkeys(extracted_tags))
    if content_type == "news":
        if "news-update" not in tags:
            tags.append("news-update")
        return tags
    return [t for t in tags if t != "news-update"]


def publish_gov_news_item(title: str, description: str, source_system: str,
                          author_handle: str, source_item_id: str, full_url: str,
                          posting_date: str, channel: str = "gov_news",
                          content_type: str = "news",
                          is_edit: bool = False) -> dict:
    """Publish path for automated government-agency news ingestion — see
    docs/ingestion/GOV-NEWS-INGESTION-PLAN.md. Deliberately NOT wired to any
    FastAPI route, same reasoning as publish_reddit_posting(): only ever
    called from the scheduled poll script (scripts/curation/poll_gov_news.py),
    never over HTTP.

    Unlike publish_reddit_posting(), tagging is fully automated — no human
    curator review step, which is the whole point of this source (§2: no
    curation bottleneck) — so this runs _extract() itself rather than
    accepting caller-supplied tags. Also skips scrub_pii()/
    moderation.check_text() like publish_reddit_posting() (official
    government content, not a live user submission).

    `content_type` — the caller's `news_sources` registry entry's field
    (GOV-NEWS-MULTI-SOURCE-CONFIG.md §5) — gates the deterministic
    `news-update` tag explicitly, not implicitly: this function only ever
    gets *called* for a `content_type="news"` source today, because
    `news_sources.get_enabled_sources()` already excludes anything else
    (§5.2 of that doc) — but that's an upstream filter, not a check *in*
    this function. Requiring the caller to state `content_type` here too,
    and only tagging `news-update` when it's `"news"`, means a future
    change to the dispatch logic (a bug, a refactor, a new caller) can't
    silently start tagging forum/user-posting content as an official news
    update — the guarantee holds at the point of tagging, not just at the
    point of dispatch.

    `is_edit=True` (the poll script detected a changed content_hash for an
    already-known source_item_id) triggers a delete-before-insert in
    BigQuery so the edit updates in place instead of duplicating — see
    _write_bigquery()'s `delete_existing` param and GOV-NEWS-INGESTION-PLAN.md
    §5.3. Returns the same shape as publish_posting()."""
    try:
        extracted = _extract(title, description)
    except Exception as e:  # noqa: BLE001 - publish with minimal tags rather than fail the whole poll run
        print(f"posting: extraction for gov-news item failed ({e}); publishing with minimal tags")
        extracted = {}

    tags = dict(extracted)
    tags["tags"] = _gov_news_tags(extracted.get("tags") or [], content_type)

    canonical = build_canonical(
        title, description, tags,
        extracted.get("key_stages_or_info"), extracted.get("key_dates"), extracted,
        channel=channel, ingestion_method="rss_feed", source_system=source_system,
        full_url=full_url, posting_date=posting_date,
        author_handle=author_handle, source_item_id=source_item_id,
    )
    # Same post-hoc override pattern as build_experience_canonical()/
    # publish_connect_card() (doc_kind isn't a build_canonical() param).
    # doc_kind, not channel, is what the datastore actually has registered
    # as an indexable/filterable field today (confirmed live: `channel` is
    # present in the schema but as a bare {"type": "string"} — not
    # indexable/searchable/dynamicFacetable — so `channel: ANY(...)` filter
    # expressions 400. `doc_kind` is fully indexed, same as "post"/
    # "experience"/"connect_card" already rely on.). This is what the News
    # tab's search facet actually filters on — see GOV-NEWS-INGESTION-PLAN.md §7.
    canonical["doc_kind"] = "gov_news"
    errs = validate(canonical)
    if errs:
        raise ValueError("; ".join(errs))

    md_uri, _json_uri = _write_gcs(canonical, _markdown_body(title, description))
    _import_to_datastore(canonical, md_uri)
    _write_bigquery(canonical, pipeline_run_id="gov-news-poll", delete_existing=is_edit)
    return {
        "case_id": canonical["case_id"],
        "gcs_path": canonical["gcs_path"],
        "indexed": True,
        "author_handle": canonical["author_handle"],
    }


def _bq_content_hash(source_system: str, source_item_id: str) -> str | None:
    """Latest stored content_hash for one (source_system, source_item_id) pair —
    the dedup guardrail so an UNCHANGED official-reference page is not re-ingested
    on a repeat run. Mirrors gov_news_poll._existing_hashes()' content-hash check,
    scoped to a single item. Returns None if never ingested, or on any BigQuery
    error (fail-open: a lookup failure must not block a legitimate publish)."""
    try:
        from google.cloud import bigquery
        client = bigquery.Client(project=_project())
        sql = (
            f"SELECT content_hash FROM `{_project()}.postings.postings_metadata` "
            "WHERE source_system=@ss AND source_item_id=@sid "
            "ORDER BY ingestion_timestamp DESC LIMIT 1"
        )
        cfg = bigquery.QueryJobConfig(query_parameters=[
            bigquery.ScalarQueryParameter("ss", "STRING", source_system),
            bigquery.ScalarQueryParameter("sid", "STRING", source_item_id),
        ])
        for row in client.query(sql, job_config=cfg).result():
            return row["content_hash"]
    except Exception as e:  # noqa: BLE001 - fail-open on lookup error
        print(f"posting: official-reference dedup lookup failed ({e}); proceeding with publish")
    return None


def publish_official_reference_item(
    title: str, body_text: str, source_system: str, full_url: str,
    as_of_date: str, author_handle: str = "", dry_run: bool = False,
    skip_if_unchanged: bool = True,
) -> dict:
    """Publish an authoritative, static official-reference page (e.g. ICE SEVIS,
    a USCIS policy page, a Visa Bulletin narrative) into DS-1 for grounding —
    the Phase-2 "authoritative official data" path in
    docs/ingestion/GROUNDING-INGESTION-PLAN.md. NOT wired to any HTTP route.

    Like publish_gov_news_item() (fully-automated _extract() tagging; skips
    scrub_pii()/moderation.check_text() — official government content, not a
    live user submission), but:
      - doc_kind = "official_reference" — evergreen reference, NOT "gov_news",
        so it is deliberately NOT carved out of free-text search by the News
        tab's 7-day recency rule (GROUNDING-INGESTION-PLAN.md); it should always
        be groundable.
      - channel = "official", ingestion_method = "official_fetch".
      - never tagged "news-update" (it isn't news) — the strip half of
        _gov_news_tags() guarantees this even if _extract() self-selects it.

    Idempotency: case_id = official-{source_system}-{as_of_date}-{sha8(full_url)}
    (build_canonical's stable-id scheme, source_item_id=full_url). Re-ingesting
    the SAME page with the SAME `as_of_date` upserts in place (INCREMENTAL
    import keyed by case_id); bumping `as_of_date` publishes the next version.
    `as_of_date` is REQUIRED and must be STABLE (the page's effective / "last
    updated" date) — defaulting it to "today" would mint a new doc on every
    re-fetch, so an empty value is rejected.

    `skip_if_unchanged=True` (the default) is the dedup guardrail: before doing
    any work, it compares this page's content_hash to the last-stored hash for
    (source_system, full_url) and SKIPS the whole publish — no _extract(), no
    GCS/datastore/BigQuery write — when identical. So a repeat run over an
    unchanged page is a no-op; a changed page re-publishes (and INCREMENTAL
    import upserts the same case_id). Skipped for `dry_run`.

    `dry_run=True` builds + validates the canonical and returns it (under the
    "canonical" key) WITHOUT any GCS/datastore/BigQuery write — for tests and a
    safe driver default."""
    if not as_of_date:
        raise ValueError(
            "as_of_date is required (a stable effective date) for official_reference idempotency"
        )

    # Dedup guardrail: same content fingerprint the gov-news poll uses. Skip a
    # real publish entirely when this source's last-stored content_hash matches
    # — no re-run of _extract() (Gemini) or re-write of GCS/datastore/BigQuery.
    content_hash = content_hash_for(title, body_text)
    if skip_if_unchanged and not dry_run:
        prior = _bq_content_hash(source_system, full_url)
        if prior is not None and prior == content_hash:
            print(f"posting: official-reference {full_url} unchanged (content_hash match) — skipping")
            return {
                "skipped": True,
                "reason": "unchanged",
                "indexed": False,
                "content_hash": content_hash,
                "full_url": full_url,
            }

    try:
        extracted = _extract(title, body_text)
    except Exception as e:  # noqa: BLE001 - publish with minimal tags rather than fail
        print(f"posting: extraction for official-reference item failed ({e}); publishing with minimal tags")
        extracted = {}

    tags = dict(extracted)
    # Official reference is NOT news — strip any model-chosen `news-update`
    # (reuses the deterministic strip half of _gov_news_tags for a non-"news"
    # content_type).
    tags["tags"] = _gov_news_tags(extracted.get("tags") or [], "official_reference")

    canonical = build_canonical(
        title, body_text, tags,
        extracted.get("key_stages_or_info"), extracted.get("key_dates"), extracted,
        channel="official", ingestion_method="official_fetch",
        source_system=source_system, full_url=full_url,
        posting_date=as_of_date, author_handle=author_handle,
        source_item_id=full_url,
    )
    # Post-hoc override, same pattern as publish_gov_news_item(): doc_kind (not
    # channel) is the indexable/filterable field.
    canonical["doc_kind"] = "official_reference"
    errs = validate(canonical)
    if errs:
        raise ValueError("; ".join(errs))

    result = {
        "case_id": canonical["case_id"],
        "gcs_path": canonical["gcs_path"],
        "author_handle": canonical["author_handle"],
    }
    if dry_run:
        result["indexed"] = False
        result["dry_run"] = True
        result["canonical"] = canonical
        return result

    md_uri, _json_uri = _write_gcs(canonical, _markdown_body(title, body_text))
    _import_to_datastore(canonical, md_uri)
    _write_bigquery(canonical, pipeline_run_id="official-reference", delete_existing=False)
    result["indexed"] = True
    return result


def publish_immihelp_posting(title: str, description: str, source_item_id: str,
                             full_url: str, posting_date: str, dry_run: bool = False) -> dict:
    """One-time, bounded sample-seed publish path for immihelp.com/experiences/
    postings — see docs/ingestion/IMMIHELP-SEED-PLAN.md. Deliberately NOT
    wired to any FastAPI route, same reasoning as publish_reddit_posting()/
    publish_gov_news_item(): source_system/posting_date/channel are
    trust-sensitive. Deliberately NOT part of the Firestore news_sources/
    Cloud Scheduler framework (GOV-NEWS-MULTI-SOURCE-CONFIG.md) either —
    immihelp's Terms of Use §12 reserves all rights and requires prior
    written consent for reproduction/commercial use, which this project
    doesn't have, so this is only ever invoked from
    scripts/curation/seed_immihelp.py's bounded one-time run, never on a
    recurring schedule.

    Unlike publish_reddit_posting() (which treats already-public,
    human-curator-reviewed Reddit content as pre-vetted and skips PII/
    moderation checks), this DOES call scrub_pii()/moderation.check_text() —
    there's no per-item human review step here (tagging is fully automated
    via _extract(), same as publish_gov_news_item() and the live API's own
    path, per explicit request), and real immihelp postings have been
    observed containing pasted emails/personal details that a review step
    would normally catch.

    Deliberately does NOT accept or forward a real author identity: no
    consent exists to attribute a real, identifiable immihelp user's handle
    on this commercial product, so — like the Reddit/gov-news paths —
    author_handle is left to build_canonical()'s synthetic default. Same
    reasoning is why backend/immihelp_seed.py's parser drops `username`/
    `postedBy`/`ipAddress` from the source payload before this function
    ever sees a candidate.

    content_type is always "forum_posting" (never "news") — reuses
    _gov_news_tags() so the deterministic `news-update` tag (meaning
    "official policy/news, not a personal experience") can never be
    applied here, same explicit-not-implicit guarantee as
    GOV-NEWS-MULTI-SOURCE-CONFIG.md §5.2a. An _extract() failure is left to
    propagate (unlike publish_gov_news_item(), which falls back to minimal
    tags) — the whole point of this path is "only what's genuinely
    publishable," so the caller (seed_immihelp.py) treats a failed/rejected
    item as a skip, not a degraded publish. Returns the same shape as
    publish_posting().

    `dry_run=True` runs the full pipeline through tagging + validate() —
    the real signal of "would this be published" — but stops short of the
    GCS/Discovery Engine/BigQuery writes, returning
    {"case_id", "would_publish": True, "tags": [...], "author_handle"}
    instead. Lets scripts/curation/seed_immihelp.py --dry-run report real
    would-publish/would-skip counts (spending the same Gemini calls a real
    run would) without writing anything to production."""
    from profile import scrub_pii
    title = scrub_pii(title or "")
    description = scrub_pii(description or "")

    import moderation
    moderation.check_text(f"{title}\n\n{description}")

    extracted = _extract(title, description)

    tags = dict(extracted)
    tags["tags"] = _gov_news_tags(extracted.get("tags") or [], "forum_posting")

    canonical = build_canonical(
        title, description, tags,
        extracted.get("key_stages_or_info"), extracted.get("key_dates"), extracted,
        channel="immihelp", ingestion_method="automated_scrape", source_system="immihelp",
        full_url=full_url, posting_date=posting_date, source_item_id=source_item_id,
    )
    errs = validate(canonical)
    if errs:
        raise ValueError("; ".join(errs))

    if dry_run:
        return {
            "case_id": canonical["case_id"],
            "would_publish": True,
            "tags": canonical.get("tags", []),
            "author_handle": canonical["author_handle"],
        }

    md_uri, _json_uri = _write_gcs(canonical, _markdown_body(title, description))
    _import_to_datastore(canonical, md_uri)
    _write_bigquery(canonical, pipeline_run_id="immihelp-one-time-seed")
    return {
        "case_id": canonical["case_id"],
        "gcs_path": canonical["gcs_path"],
        "indexed": True,
        "author_handle": canonical["author_handle"],
    }


# ---------------------------------------------------------------------------
# Phase-J: experience / connect-card documents (multi-view content; D-041)
#
# A consented profile experience is projected to its OWN searchable DS-1 sidecar
# (doc_kind="experience"), carrying facets ABOUT THE EXPERIENCE (a past event) —
# never the user's current-state tags. The live profile is NEVER imported.
# ---------------------------------------------------------------------------

# milestone label -> the 1.8 date key its date belongs under.
_MILESTONE_DATE_KEY = {
    "visa_interview": "visa_interview_date", "visa_stamping": "visa_stamp_date",
    "port_of_entry": "admission_date", "h1b_filing": "h1b_filed_date",
    "h1b_approval": "h1b_approved_date", "h1b_rfe": "rfe_date",
    "opt_application": "ead_filed_date", "perm_filing": "labor_cert_filed_date",
    "perm_approval": "perm_approved_date", "i140_approval": "i140_approved_date",
    "i485_filing": "i485_filed_date", "biometrics": "biometrics_appointment_date",
    "aos_interview": "aos_appointment_date", "ead_approval": "ead_approved_date",
    "green_card": "green_card_received_date",
    "naturalization_interview": "naturalization_interview_date",
    "oath_ceremony": "oath_ceremony_date", "consular_221g": "221g_issued_date",
}


def _slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", (s or "").strip().lower()).strip("_")[:48]


# Interview milestones (consular OR domestic) that earn `visa-interview-experience`.
_INTERVIEW_MILESTONES = {"visa_interview", "aos_interview", "naturalization_interview"}


def _pretty_milestone(m: str) -> str:
    return (m or "milestone").replace("_", " ").strip().title()


def build_experience_canonical(profile: dict, entry: dict, extracted: dict | None = None) -> dict:
    """Build a sidecar canonical for ONE profile experience (doc_kind=experience).
    Facets are extracted from the experience TEXT (about that past event), NOT from
    the user's current profile state."""
    text = str(entry.get("experience") or "").strip()
    milestone = _slug(str(entry.get("milestone") or "milestone"))
    date = normalize_date_safe(str(entry.get("date") or ""))
    title = f"{_pretty_milestone(milestone)} experience"
    if extracted is None:
        try:
            extracted = _extract(title, text)
        except Exception as e:  # noqa: BLE001
            print(f"posting: experience extraction failed ({e}); minimal facets")
            extracted = {}

    key_stages = extracted.get("key_stages_or_info")
    key_dates = dict(_clean_dates(extracted.get("key_dates")))
    dk = _MILESTONE_DATE_KEY.get(milestone)
    if dk and date:
        key_dates[dk] = date

    # Experience tagging rules (phase-J):
    #  1) every experience is tagged `past-experience` (universal) + `experience-posting`;
    #  2) add `timeline` when the experience has any date(s);
    #  3) `visa-interview-experience` for an interview milestone (consular OR domestic);
    #  4) an experience NEVER carries concerns/questions tags.
    tags = {f: extracted.get(f) for f in GROUP_FIELDS}
    tags["concerns_or_questions_tags"] = []                                  # rule 4
    base_tags = list(dict.fromkeys([*(tags.get("tags") or []),
                                    "past-experience", "experience-posting"]))  # rule 1
    if key_dates and "timeline" not in base_tags:                            # rule 2
        base_tags.append("timeline")
    if milestone in _INTERVIEW_MILESTONES and "visa-interview-experience" not in base_tags:  # rule 3
        base_tags.append("visa-interview-experience")
    tags["tags"] = base_tags

    c = build_canonical(title, text, tags, key_stages, key_dates, extracted)
    c["concerns_or_questions_tags"] = []  # belt-and-suspenders for rule 3
    # Re-key as an experience document.
    short = secrets.token_hex(4)
    c["doc_kind"] = "experience"
    c["case_id"] = f"{CHANNEL}-exp-{c['posting_date']}-{short}"
    c["full_url"] = f"{APP_BASE_URL}/case/{c['case_id']}"
    c["post_title"] = title
    c["ingestion_method"] = "user_experience"
    c["source_metadata"] = "User milestone experience (phase-J), consent-shared"
    # Link all of an author's experiences via their synthetic handle (no PII).
    handle = str(profile.get("username") or "").strip() or c["author_handle"]
    c["author_handle"] = handle
    c["parent_case_id"] = handle
    c["derived_topic_cluster"] = list(dict.fromkeys([*(c.get("derived_topic_cluster") or []), milestone]))
    return c


def publish_experience(profile: dict, entry: dict) -> dict:
    """Project one consented experience to a searchable DS-1 sidecar. Returns its id."""
    text = str(entry.get("experience") or "").strip()
    if not text:
        raise ValueError("experience has no text")
    c = build_experience_canonical(profile, entry)
    md_uri, _ = _write_gcs(c, _markdown_body(c["post_title"], text))
    _import_to_datastore(c, md_uri)
    _write_bigquery(c)
    return {"case_id": c["case_id"], "doc_kind": "experience",
            "milestone": entry.get("milestone", ""), "gcs_path": c["gcs_path"], "indexed": True}


def publish_connect_card(profile: dict, note: str = "") -> dict:
    """Publish an explicit 'looking to connect' card (doc_kind=connect_card) from
    the user's CURRENT profile state. The user publishes it deliberately, so its
    facets are the profile's current status (this is content, not the profile doc)."""
    handle = str(profile.get("username") or "").strip() or _synthetic_handle()
    tags = {f: profile.get(f) for f in GROUP_FIELDS}
    state = ", ".join(profile.get("current_visa_or_greencard_category")
                      or profile.get("visa_applying_for") or ["immigration"])
    title = f"Looking to connect — {state}"
    body = str(note or "").strip() or f"{handle} is looking to connect with others on a similar journey ({state})."
    extracted = {
        "background_summary": str(profile.get("background_text") or "")[:400] or "User looking to connect.",
        "concerns_or_questions_summary": "Looking to connect with others in the same situation.",
        "key_stages_or_info": profile.get("key_stages_or_info") or {},
        "key_dates": profile.get("key_dates") or {},
    }
    c = build_canonical(title, body, tags, profile.get("key_stages_or_info"),
                        profile.get("key_dates"), extracted)
    short = secrets.token_hex(4)
    c["doc_kind"] = "connect_card"
    c["case_id"] = f"{CHANNEL}-connect-{c['posting_date']}-{short}"
    c["full_url"] = f"{APP_BASE_URL}/case/{c['case_id']}"
    c["post_title"] = title
    c["ingestion_method"] = "user_connect_card"
    c["source_metadata"] = "Connect card (phase-J), user-published"
    c["author_handle"] = handle
    c["parent_case_id"] = handle
    md_uri, _ = _write_gcs(c, _markdown_body(title, body))
    _import_to_datastore(c, md_uri)
    _write_bigquery(c)
    return {"case_id": c["case_id"], "doc_kind": "connect_card", "gcs_path": c["gcs_path"], "indexed": True}


def delete_content(case_id: str) -> None:
    """Delete a published content doc (experience/connect-card/post) from the
    datastore + its GCS sidecars. Best-effort; safe to call if already gone."""
    from google.api_core.exceptions import NotFound
    project, loc, ds = _project(), _ds_location(), _datastore()
    try:
        doc_client = de.DocumentServiceClient(client_options=ClientOptions(quota_project_id=project))
        name = (f"projects/{project}/locations/{loc}/collections/default_collection"
                f"/dataStores/{ds}/branches/default_branch/documents/{case_id}")
        doc_client.delete_document(name=name)
    except NotFound:
        pass
    except Exception as e:  # noqa: BLE001
        print(f"posting.delete_content: datastore delete failed ({e})")
    m = re.search(r"(\d{4}-\d{2}-\d{2})", case_id)
    if m:
        # Bug fixed: this used to hardcode CHANNEL ("app"), so deleting a
        # channel="reddit" doc's GCS sidecars would silently look in the
        # wrong prefix and leave them orphaned. case_id always starts with
        # "<channel>-" (app-, app-exp-, app-connect-, reddit-, ...), so its
        # own leading segment is the correct channel regardless of shape.
        channel_prefix = case_id.split("-", 1)[0] or CHANNEL
        base = f"{m.group(1)}/{channel_prefix}/{case_id}"
        try:
            bkt = storage.Client(project=project).bucket(_bucket_name())
            for ext in (".md", ".json"):
                bkt.blob(f"{base}{ext}").delete()
        except Exception as e:  # noqa: BLE001
            print(f"posting.delete_content: gcs delete best-effort ({e})")


def normalize_date_safe(value: str) -> str:
    """Best-effort YYYY-MM-DD (delegates to profile.normalize_date if importable)."""
    v = (value or "").strip()
    if _DATE_RE.match(v):
        return v
    try:
        import profile as _p
        return _p.normalize_date(v)
    except Exception:  # noqa: BLE001
        return ""
