"""
attribute_config.py — the Timeline attribute spec, read from Firestore at
runtime instead of being frozen into a deploy.

WHAT THIS IS FOR
----------------
Which fields a Timeline group is scoped by, and which it collects from each
member on join, used to be Python literals in posting.py. Adding a field to
one eligibility category — a one-line data change — therefore needed a code
review and a Cloud Run rollout. This module makes that spec a document:

    Firestore  app_config/timeline_attributes

Edit the document, and every instance picks it up within one TTL (default
60s) with no deploy. `POST /api/config/attributes/refresh` makes it immediate.

THE SPEC SHAPE (config/timeline_attributes.default.json is a full example,
and config/README.md explains the reasoning behind it)
------------------------------------------------------------------------
    {
      "version": 3,                       # advisory; bumped by the publisher
      "processing_types": [               # the FIRST dropdown
        {"value": "EAD", "label": "EAD",
         "eligibility_categories": [      # the SECOND dropdown, per type
            {"code": "(c)(9)", "label": "...", "tag": "adjustment-of-status"}
         ]}
      ],
      "period_rows":     [row, ...],      # base scope rows every group gets
      "scope_row_extras":     {tag: [row, ...]},   # extra create-time rows
      "post_join_row_extras": {tag: [row, ...]},   # per-member join rows
    }

    row = {"kind": "date"|"select"|"year"|"checkbox",
           "label": str, "key": str,
           "field": "key_dates"|"key_stages_or_info",
           "options": [...],          # select only
           "required": bool,          # post-join only
           "name_prefix": str}        # scope only

SAFETY — THE PART THAT MATTERS MOST
-----------------------------------
A malformed config must never break joining a group, so a load passes through
three gates before it is believed:

  1. VALIDATE BEFORE SWAP. Schema, kinds, and every `key` checked against the
     controlled vocabulary CSVs. profile.py's cleaners silently drop a key
     that isn't real vocabulary, so an unvalidated typo would look like a save
     that did nothing.
  2. KEEP LAST-GOOD. A read error, or a document that fails validation, leaves
     the previously-serving config in place. A bad edit degrades to "stale",
     never to "broken".
  3. FALL BACK TO THE SHIPPED BASE. If nothing good has ever loaded — first
     boot with an empty/missing document, or Firestore unreachable —
     posting.DEFAULT_ATTRIBUTE_SPEC serves, which is
     config/timeline_attributes.default.json read from the image. The app
     always has a working config.

`source` on the returned metadata says which of these you are looking at, so
"is this live or is it silently on the default?" is answerable in prod.

PERFORMANCE
-----------
Reads are served from an in-process dict. Firestore is touched at most once
per TTL per instance — with a 60s TTL and N warm instances that is N reads a
minute, against a quota measured in tens of thousands. The refresh is
synchronous on the first request after expiry (one ~5-15ms document read); it
is deliberately not a background thread, because Cloud Run freezes idle
instances and a timer there is unreliable.

The TTL is the staleness bound, not a correctness bound: two instances can
briefly serve different versions. That is fine for form definitions, and is
the reason group NAMES are built from stored criteria rather than recomputed
from config.
"""

from __future__ import annotations

import os
import threading
import time
from typing import Any

# Firestore collection/document holding the live spec.
COLLECTION = "app_config"
DOCUMENT = "timeline_attributes"

# How long a loaded spec is served before the next read re-checks Firestore.
# 0 disables caching entirely (every call reads) — useful in a test or when
# debugging a rollout, ruinous under real traffic.
def _ttl_seconds() -> float:
    try:
        return float(os.getenv("ATTR_CONFIG_TTL_SECONDS", "60"))
    except ValueError:
        return 60.0


_VALID_KINDS = {"date", "select", "year", "checkbox"}
_VALID_FIELDS = {"key_dates", "key_stages_or_info"}

# Guards the cache triple below. Two requests racing an expiry would otherwise
# both read Firestore and could interleave a partial swap.
_lock = threading.Lock()
_cached: dict | None = None       # last spec we successfully validated
_cached_at: float = 0.0           # monotonic stamp of that load
_source: str = "default"          # "firestore" | "last-good" | "default"
_last_error: str = ""


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------
def validate(spec: Any) -> list[str]:
    """Return a list of problems with `spec`; empty means it is safe to serve.

    Deliberately strict about the things that fail SILENTLY at runtime — an
    unknown `field`, or a `key` outside the controlled vocabulary, produces a
    form that accepts input and then drops it on save. Better a rejected
    config than a lying one."""
    import posting  # late: posting imports this module

    errs: list[str] = []
    if not isinstance(spec, dict):
        return ["spec must be an object"]

    def check_rows(rows: Any, where: str, scope_side: bool) -> None:
        if not isinstance(rows, list):
            errs.append(f"{where}: must be a list of rows")
            return
        seen: set[str] = set()
        for i, row in enumerate(rows):
            at = f"{where}[{i}]"
            if not isinstance(row, dict):
                errs.append(f"{at}: must be an object")
                continue
            key, kind = row.get("key"), row.get("kind", "date")
            field = row.get("field")
            if not key or not isinstance(key, str):
                errs.append(f"{at}: missing 'key'")
                continue
            if key in seen:
                errs.append(f"{at}: duplicate key '{key}' in the same list")
            seen.add(key)
            if not row.get("label"):
                errs.append(f"{at} ({key}): missing 'label'")
            if kind not in _VALID_KINDS:
                errs.append(f"{at} ({key}): kind '{kind}' is not one of {sorted(_VALID_KINDS)}")
            if field not in _VALID_FIELDS:
                errs.append(f"{at} ({key}): field '{field}' is not one of {sorted(_VALID_FIELDS)}")
            if kind == "select" and not row.get("options"):
                errs.append(f"{at} ({key}): a select row needs non-empty 'options'")
            if kind != "select" and row.get("options"):
                errs.append(f"{at} ({key}): 'options' only applies to a select row")
            if scope_side and "required" in row:
                errs.append(f"{at} ({key}): 'required' is post-join only — scope rows are never required")
            if not scope_side and "name_prefix" in row:
                errs.append(f"{at} ({key}): 'name_prefix' is scope-only — it names a group-name segment")
            # The check that catches the silent failure: a key the profile
            # cleaners don't recognise is accepted by the form and dropped
            # on save.
            if field in _VALID_FIELDS:
                known = (posting._Vocab.date_keys if field == "key_dates"
                         else posting._Vocab.profile_stage_keys)
                if key not in known:
                    errs.append(f"{at}: '{key}' is not a known {field} vocabulary key "
                                f"(add it to the matching tags-cleaned CSV first)")

            # A SECOND silent-drop path, one layer deeper than the key check:
            # some stage keys constrain their VALUE to a sub-vocabulary
            # (outcome_status -> 1.9 outcomes, *_of_country -> 1.4 countries).
            # profile.py drops a value outside that domain on save, so a
            # select offering options the domain doesn't contain renders fine,
            # submits fine, passes _validate_attribute_values — and then loses
            # the answer. Catch it here, where the options are declared.
            if kind == "select" and isinstance(row.get("options"), list):
                domain = posting.stage_value_domain(key)
                if domain:
                    bad = [o for o in row["options"] if not posting.stage_value_ok(key, o)]
                    if bad:
                        errs.append(f"{at} ({key}): option(s) {bad} are outside the "
                                    f"'{domain}' value domain this key enforces — they would "
                                    f"be dropped on save")

    posting._Vocab.load()

    # The period pair is load-bearing, not decorative: Timeline dedup is
    # name-based, and the name is built from the scope rows. Strip the period
    # and every group of a given category resolves to the same name, so
    # _find_timeline_duplicate collapses them all into one cohort. A missing
    # key means "use the default"; an explicit empty list is a config that
    # would quietly destroy dedup, so it is refused.
    if "period_rows" in spec and isinstance(spec["period_rows"], list) and not spec["period_rows"]:
        errs.append("period_rows: must not be empty — the filing period is what makes two "
                    "groups of the same category distinguishable (omit the key to use the default)")
    check_rows(spec.get("period_rows", []), "period_rows", scope_side=True)
    for name, scope_side in (("scope_row_extras", True), ("post_join_row_extras", False)):
        block = spec.get(name, {})
        if not isinstance(block, dict):
            errs.append(f"{name}: must be an object keyed by tag")
            continue
        for tag, rows in block.items():
            check_rows(rows, f"{name}.{tag}", scope_side)

    # Eligibility tags and type values come from five CSVs: 1.1/1.2 land in
    # `visa`, 1.3/1.6/1.10 in `tag`.
    vocab = posting._Vocab.visa | posting._Vocab.tag

    types = spec.get("processing_types", [])
    if not isinstance(types, list) or not types:
        errs.append("processing_types: must be a non-empty list")
    else:
        seen_types: set[str] = set()
        for i, t in enumerate(types):
            at = f"processing_types[{i}]"
            if not isinstance(t, dict) or not t.get("value"):
                errs.append(f"{at}: missing 'value'")
                continue
            if t["value"] in seen_types:
                errs.append(f"{at}: duplicate processing type '{t['value']}'")
            seen_types.add(t["value"])
            # A type's value is written into the group's criteria, where
            # _clean_criteria drops anything out of vocabulary. Offering a
            # type nobody can actually be tagged with produces groups that
            # lose their defining criterion on save — silently.
            if t["value"] not in vocab:
                errs.append(f"{at}: processing type '{t['value']}' is not in the controlled "
                            f"vocabulary — a group created with it would lose the tag on save")
            # Optional heading for the second dropdown. EAD's list really is
            # 8 CFR eligibility categories; H-1B's is application types. A
            # blank or non-string here would render an unlabelled control, so
            # it is checked rather than silently defaulted client-side.
            if "category_label" in t and not (isinstance(t["category_label"], str)
                                              and t["category_label"].strip()):
                errs.append(f"{at}.category_label: must be a non-empty string when present")
            cats = t.get("eligibility_categories", [])
            if not isinstance(cats, list):
                errs.append(f"{at}.eligibility_categories: must be a list")
                continue
            for j, c in enumerate(cats):
                cat_at = f"{at}.eligibility_categories[{j}]"
                if not isinstance(c, dict) or not c.get("tag"):
                    errs.append(f"{cat_at}: missing 'tag'")
                    continue
                # A category whose tag isn't real vocabulary produces a group
                # nobody can find by tag — the exact rule the EAD evaluation
                # locked in. The union is needed because eligibility tags come
                # from five CSVs: 1.1/1.2 land in `visa`, 1.3/1.6/1.10 in `tag`.
                if c["tag"] not in (posting._Vocab.visa | posting._Vocab.tag):
                    errs.append(f"{cat_at}: tag '{c['tag']}' is not in the controlled vocabulary")
    return errs


# ---------------------------------------------------------------------------
# Loading
# ---------------------------------------------------------------------------
def _default() -> dict:
    import posting
    return posting.DEFAULT_ATTRIBUTE_SPEC


def _read_firestore() -> dict | None:
    """The raw document, or None when it is missing/empty. Raises on transport
    failure so the caller can distinguish "nothing published yet" (fall back
    to code, quietly) from "Firestore is down" (keep last-good, note it)."""
    from google.cloud import firestore
    snap = firestore.Client().collection(COLLECTION).document(DOCUMENT).get()
    if not snap.exists:
        return None
    data = snap.to_dict() or {}
    return data or None


def refresh(force: bool = False) -> dict:
    """Re-read the document if the TTL has expired (or `force`), and return
    the spec now being served. Never raises: every failure path degrades to
    last-good, then to the code default."""
    global _cached, _cached_at, _source, _last_error
    with _lock:
        fresh_enough = (
            _cached is not None
            and (time.monotonic() - _cached_at) < _ttl_seconds()
        )
        if fresh_enough and not force:
            return _cached

        try:
            doc = _read_firestore()
        except Exception as e:  # transport/permission/quota — keep serving
            _last_error = f"{type(e).__name__}: {e}"
            if _cached is not None:
                _source = "last-good"
                _cached_at = time.monotonic()  # don't hammer a dead backend
                return _cached
            _source = "default"
            _cached, _cached_at = _default(), time.monotonic()
            return _cached

        if doc is None:  # nothing published — the code default IS the config
            _last_error = ""
            _source = "default"
            _cached, _cached_at = _default(), time.monotonic()
            return _cached

        errs = validate(doc)
        if errs:
            # A published config that doesn't validate is the dangerous case:
            # loud in the log, invisible to users, and NOT swapped in.
            _last_error = "; ".join(errs[:5]) + (f" (+{len(errs) - 5} more)" if len(errs) > 5 else "")
            print(f"[attribute_config] REJECTED published config: {_last_error}")
            _source = "last-good" if _cached is not None else "default"
            if _cached is None:
                _cached = _default()
            _cached_at = time.monotonic()
            return _cached

        _last_error = ""
        _source = "firestore"
        _cached, _cached_at = doc, time.monotonic()
        return _cached


def get() -> dict:
    """The spec to serve right now. Hot path — usually a dict return with no
    I/O at all; reads Firestore only when the TTL has expired."""
    return refresh(force=False)


def meta() -> dict:
    """Where the current config came from, for the ops endpoint. Answers
    "is prod actually running my edit, or silently on the default?"."""
    spec = get()
    age = time.monotonic() - _cached_at if _cached_at else None
    return {
        "source": _source,
        "version": spec.get("version"),
        "updated_at": spec.get("updated_at"),
        "ttl_seconds": _ttl_seconds(),
        "age_seconds": round(age, 1) if age is not None else None,
        "last_error": _last_error,
    }


def publish(spec: dict, *, validate_first: bool = True) -> list[str]:
    """Write a new spec to Firestore. Returns validation problems (and writes
    nothing) when there are any. Used by scripts/publish_attribute_config.py
    — the API never writes, so a bad config can't arrive over HTTP."""
    if validate_first:
        errs = validate(spec)
        if errs:
            return errs
    from google.cloud import firestore
    db = firestore.Client()
    payload = {**spec, "updated_at": firestore.SERVER_TIMESTAMP}
    db.collection(COLLECTION).document(DOCUMENT).set(payload)
    refresh(force=True)
    return []


def _reset_for_tests() -> None:
    """Drop the cache so a test can control what the next get() sees."""
    global _cached, _cached_at, _source, _last_error
    with _lock:
        _cached, _cached_at, _source, _last_error = None, 0.0, "default", ""


def _set_for_tests(spec: dict | None) -> None:
    """Install `spec` as the served config without touching Firestore, or
    clear the override with None.

    This is how a test exercises "a published config changes behaviour" —
    the same code path production takes after a load, minus the network. The
    cache stamp is pushed far into the future so the TTL can't expire mid-test
    and silently swap the spec back."""
    global _cached, _cached_at, _source
    with _lock:
        if spec is None:
            _cached, _cached_at, _source = None, 0.0, "default"
            return
        _cached, _cached_at, _source = spec, time.monotonic() + 10_000, "firestore"
