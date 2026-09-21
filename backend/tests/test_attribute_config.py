"""
test_attribute_config.py — the externalised Timeline attribute config.

Groups (all pure unless noted — no GCP calls; Firestore is stubbed):
  V  validate() accepts the shipped default and rejects every malformed shape
  F  fallback ladder: firestore -> last-good -> in-code default
  C  caching: TTL hit/miss, force refresh, and what a slow backend costs
  P  the posting.py views resolve from the live config, not from imports
  S  SYNTHETIC configs: the (type x category x extras) matrix, resolved
  L  layering precedence when several levels touch the same row
  R  the required-key matrix, and the join gate agreeing with it
  N  group naming across configs that add scope rows
  E  edge cases: orphans, collisions, empty period, scale, unicode
  X  further negatives, incl. a key declared under the wrong field

The bias throughout is toward the NEGATIVE cases. A config loader that serves
the happy path is easy; the whole reason this one is worth testing is that a
bad document must degrade to "stale", never to "broken" — nobody should be
locked out of joining a group because someone fat-fingered a JSON edit.

Run:  ALLOW_USER_IMPERSONATION=1 .venv/bin/python tests/test_attribute_config.py
"""

import copy
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from dotenv import load_dotenv  # noqa: E402

load_dotenv()

import attribute_config as ac  # noqa: E402
import posting  # noqa: E402

_results: list[tuple[str, bool]] = []


def check(name: str, passed: bool, detail: str = "") -> None:
    _results.append((name, passed))
    print(f"  [{'PASS' if passed else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))


def default_spec() -> dict:
    return copy.deepcopy(posting.DEFAULT_ATTRIBUTE_SPEC)


class _StubFirestore:
    """Stands in for _read_firestore. `payload` may be a dict (the document),
    None (nothing published), or an Exception instance (transport failure)."""

    def __init__(self, payload):
        self.payload = payload
        self.reads = 0

    def __call__(self):
        self.reads += 1
        if isinstance(self.payload, Exception):
            raise self.payload
        return self.payload


def _install(payload):
    """Point the loader at a stub and clear the cache. Returns the stub so a
    test can count how many times Firestore was actually hit."""
    stub = _StubFirestore(payload)
    ac._read_firestore = stub
    ac._reset_for_tests()
    return stub


# ---------------------------------------------------------------------------
# V — validation
# ---------------------------------------------------------------------------
def group_validation() -> None:
    print("\nV — validate()")
    check("V1 the spec shipped in the code validates",
          ac.validate(default_spec()) == [], str(ac.validate(default_spec())[:2]))

    check("V2 a non-object spec is rejected", ac.validate([]) != [])
    check("V3 processing_types cannot be empty — that empties the first dropdown",
          any("processing_types" in e for e in ac.validate({**default_spec(), "processing_types": []})))

    def rejects(mutate, name, needle=""):
        spec = default_spec()
        mutate(spec)
        errs = ac.validate(spec)
        ok = bool(errs) and (not needle or any(needle in e for e in errs))
        check(name, ok, str(errs[:2]) if errs else "accepted!")

    # The two that fail SILENTLY at runtime if they get through: a key the
    # profile cleaners don't know, and a field that isn't a real profile map.
    rejects(lambda s: s["post_join_row_extras"]["stem-opt-extension"].append(
        {"kind": "date", "label": "Made Up", "field": "key_dates", "key": "not_a_vocab_key"}),
        "V4 a key outside the controlled vocabulary is rejected", "not_a_vocab_key")
    rejects(lambda s: s["post_join_row_extras"]["stem-opt-extension"].append(
        {"kind": "date", "label": "X", "field": "nowhere", "key": "rfe_date"}),
        "V5 a field that is not a profile map is rejected", "field")

    rejects(lambda s: s["post_join_row_extras"]["stem-opt-extension"].append(
        {"kind": "wormhole", "label": "X", "field": "key_dates", "key": "rfe_date"}),
        "V6 an unknown kind is rejected — the clients can only render four", "kind")
    rejects(lambda s: s["post_join_row_extras"]["stem-opt-extension"].append(
        {"kind": "select", "label": "X", "field": "key_stages_or_info", "key": "service_center"}),
        "V7 a select with no options is rejected — an unpickable dropdown", "options")
    rejects(lambda s: s["post_join_row_extras"]["stem-opt-extension"].append(
        {"kind": "date", "label": "X", "field": "key_dates", "key": "rfe_date", "options": ["a"]}),
        "V8 options on a non-select is rejected as a likely mistake", "options")
    rejects(lambda s: s["post_join_row_extras"]["stem-opt-extension"].append(
        {"kind": "date", "label": "", "field": "key_dates", "key": "rfe_date"}),
        "V9 a row with no label is rejected — it would render blank", "label")
    rejects(lambda s: s["post_join_row_extras"]["stem-opt-extension"].append(
        {"kind": "date", "label": "Dup", "field": "key_dates", "key": "ead_filed_date"}),
        "V10 a duplicate key in one list is rejected", "duplicate")

    # Side confusion: `required` is meaningless on a scope row, `name_prefix`
    # on a post-join row. Both silently do nothing, so both are caught here.
    rejects(lambda s: s["scope_row_extras"].update({"h4-ead": [
        {"kind": "date", "label": "X", "field": "key_dates", "key": "rfe_date", "required": True}]}),
        "V11 'required' on a SCOPE row is rejected — scope rows are never required", "required")
    rejects(lambda s: s["post_join_row_extras"]["stem-opt-extension"].append(
        {"kind": "date", "label": "X", "field": "key_dates", "key": "rfe_date", "name_prefix": "X"}),
        "V12 'name_prefix' on a POST-JOIN row is rejected — it names a group-name segment", "name_prefix")

    rejects(lambda s: s["processing_types"][0]["eligibility_categories"].append(
        {"code": "(x)", "label": "Bogus", "tag": "not-a-real-tag"}),
        "V13 a category tag outside the vocabulary is rejected", "not-a-real-tag")
    rejects(lambda s: s["processing_types"].append({"value": "EAD", "label": "dupe",
                                                    "eligibility_categories": []}),
        "V14 a duplicate processing type is rejected", "duplicate")
    rejects(lambda s: s.update({"period_rows": "nope"}),
            "V15 period_rows must be a list")

    # A valid ADDITION must still pass — validation that rejects everything is
    # just an outage with extra steps.
    spec = default_spec()
    spec["post_join_row_extras"]["h4-ead"] = [
        {"kind": "date", "label": "Receipt Date", "field": "key_dates",
         "key": "ead_card_received_date", "required": False}]
    check("V16 (positive) a legitimate new category template is accepted",
          ac.validate(spec) == [], str(ac.validate(spec)[:2]))


# ---------------------------------------------------------------------------
# F — the fallback ladder
# ---------------------------------------------------------------------------
def group_fallback() -> None:
    print("\nF — fallback: firestore -> last-good -> default")
    published = default_spec()
    published["version"] = 42

    _install(published)
    check("F1 a published document is served, and says so",
          ac.get().get("version") == 42 and ac.meta()["source"] == "firestore",
          ac.meta()["source"])

    _install(None)
    check("F2 nothing published falls back to the in-code default",
          ac.get()["processing_types"][0]["value"] == "EAD" and ac.meta()["source"] == "default",
          ac.meta()["source"])

    _install(RuntimeError("firestore unreachable"))
    check("F3 an unreachable Firestore on a cold process still serves the default",
          ac.get()["processing_types"][0]["value"] == "EAD" and ac.meta()["source"] == "default")
    check("F3b …and records why, so it isn't silent",
          "firestore unreachable" in ac.meta()["last_error"], ac.meta()["last_error"])

    # The important one: a WARM process must not lose a good config because
    # the next read failed.
    stub = _install(published)
    ac.get()
    stub.payload = RuntimeError("transient 503")
    ac.refresh(force=True)
    check("F4 a read failure keeps serving the LAST-GOOD config, not the default",
          ac.get().get("version") == 42 and ac.meta()["source"] == "last-good",
          f"{ac.meta()['source']} v{ac.get().get('version')}")

    # Equally important: a published-but-invalid document must not be served.
    stub = _install(published)
    ac.get()
    bad = default_spec()
    bad["version"] = 43
    bad["post_join_row_extras"]["stem-opt-extension"] = [
        {"kind": "date", "label": "X", "field": "key_dates", "key": "not_a_vocab_key"}]
    stub.payload = bad
    ac.refresh(force=True)
    check("F5 an INVALID published config is rejected and last-good is kept",
          ac.get().get("version") == 42 and ac.meta()["source"] == "last-good",
          f"{ac.meta()['source']} v{ac.get().get('version')}")
    check("F5b …and the validation problem is reported in the metadata",
          "not_a_vocab_key" in ac.meta()["last_error"], ac.meta()["last_error"])

    # Invalid on a COLD process — nothing good to fall back to.
    _install(bad)
    check("F6 an invalid config on a cold process falls back to the default",
          ac.meta()["source"] == "default" and ac.get()["processing_types"][0]["value"] == "EAD",
          ac.meta()["source"])

    _install({})
    check("F7 an empty document is treated as 'nothing published', not as an empty config",
          ac.meta()["source"] == "default")


# ---------------------------------------------------------------------------
# C — caching
# ---------------------------------------------------------------------------
def group_caching() -> None:
    print("\nC — caching")
    spec = default_spec()

    os.environ["ATTR_CONFIG_TTL_SECONDS"] = "60"
    stub = _install(spec)
    for _ in range(50):
        ac.get()
    check("C1 fifty reads inside the TTL hit Firestore exactly once",
          stub.reads == 1, f"{stub.reads} reads")

    ac.refresh(force=True)
    check("C2 force=True re-reads even though the TTL is nowhere near expiry",
          stub.reads == 2, f"{stub.reads} reads")

    os.environ["ATTR_CONFIG_TTL_SECONDS"] = "0.2"
    stub = _install(spec)
    ac.get()
    time.sleep(0.25)
    ac.get()
    check("C3 a read after the TTL expires goes back to Firestore",
          stub.reads == 2, f"{stub.reads} reads")

    # A dead backend must not turn into a read storm — the failure path
    # re-stamps the cache so the next call waits out a full TTL.
    os.environ["ATTR_CONFIG_TTL_SECONDS"] = "60"
    stub = _install(RuntimeError("down"))
    for _ in range(20):
        ac.get()
    check("C4 a failing backend is retried once per TTL, not on every request",
          stub.reads == 1, f"{stub.reads} reads")

    os.environ["ATTR_CONFIG_TTL_SECONDS"] = "0"
    stub = _install(spec)
    ac.get(); ac.get()
    check("C5 TTL=0 disables caching entirely (an escape hatch for debugging)",
          stub.reads == 2, f"{stub.reads} reads")
    os.environ["ATTR_CONFIG_TTL_SECONDS"] = "60"

    os.environ["ATTR_CONFIG_TTL_SECONDS"] = "not-a-number"
    check("C6 a garbled TTL env var falls back to the default rather than crashing",
          ac._ttl_seconds() == 60.0, str(ac._ttl_seconds()))
    os.environ["ATTR_CONFIG_TTL_SECONDS"] = "60"


# ---------------------------------------------------------------------------
# P — posting.py resolves from the live config
# ---------------------------------------------------------------------------
def group_posting_views() -> None:
    print("\nP — posting.py views follow the config")
    _install(default_spec())

    check("P1 the tag-keyed registries match the shipped default",
          "stem-opt-extension" in posting.POST_JOIN_ATTRIBUTE_TEMPLATES
          and "adjustment-of-status" in posting.POST_JOIN_ATTRIBUTE_TEMPLATES,
          str(sorted(posting.POST_JOIN_ATTRIBUTE_TEMPLATES)))
    check("P2 the views behave as plain dicts for existing call sites",
          posting.TAG_ATTRIBUTE_TEMPLATES.get("nope", "sentinel") == "sentinel"
          and len(posting.TAG_ATTRIBUTE_TEMPLATES) > 0
          and isinstance(dict(posting.TAG_ATTRIBUTE_TEMPLATES), dict))
    check("P3 PROCESSING_TYPES indexes and iterates like a list",
          posting.PROCESSING_TYPES[0]["value"] == "EAD"
          and [t["value"] for t in posting.PROCESSING_TYPES] == ["EAD", "H-1B"])

    # The whole point: publish a change, see it WITHOUT reimporting anything.
    spec = default_spec()
    spec["post_join_row_extras"]["h4-ead"] = [
        {"kind": "date", "label": "Card Received", "field": "key_dates", "key": "ead_card_received_date"}]
    _install(spec)
    check("P4 a config edit adds a join field with no restart and no reimport",
          [r["key"] for r in posting.POST_JOIN_ATTRIBUTE_TEMPLATES["h4-ead"]] == ["ead_card_received_date"],
          str(posting.POST_JOIN_ATTRIBUTE_TEMPLATES.get("h4-ead")))
    check("P5 …and it reaches the dropdown option the client reads",
          any(c["tag"] == "h4-ead" and [r["key"] for r in c["post_join_rows"]] == ["ead_card_received_date"]
              for c in posting.EAD_ELIGIBILITY_CATEGORIES))
    check("P6 …and the /api/tag-vocab payload, which is what both apps fetch",
          "h4-ead" in posting.vocab_lists()["post_join_attribute_templates"])
    check("P7 …and the row is validated on submit, so config and 422s agree",
          __import__("matching")._validate_attribute_values(
              "h4-ead", {"ead_card_received_date": "2026-08-20"}) == {"ead_card_received_date": "2026-08-20"})

    _install(default_spec())
    check("P8 reverting the config removes the field again — no deploy either way",
          "h4-ead" not in posting.POST_JOIN_ATTRIBUTE_TEMPLATES)

    # A new processing type is config too, not just new rows on an old one.
    spec = default_spec()
    spec["processing_types"].append(
        {"value": "TPS", "label": "TPS", "eligibility_categories": []})
    _install(spec)
    check("P9 a whole new processing type appears from config alone",
          [t["value"] for t in posting.PROCESSING_TYPES] == ["EAD", "H-1B", "TPS"],
          str([t["value"] for t in posting.PROCESSING_TYPES]))
    check("P10 …and it gets the base period rows without configuring them",
          [r["key"] for r in posting.TAG_ATTRIBUTE_TEMPLATES["TPS"]]
          == ["filing_month", "filing_year"])
    _install(default_spec())


# ---------------------------------------------------------------------------
# Synthetic-config builders
# ---------------------------------------------------------------------------
# Real vocabulary only — validate() rejects anything else, and a test fixture
# the validator would refuse to publish is a fixture testing nothing.
DATE_KEYS = ["ead_filed_date", "rfe_date", "ead_approved_date",
             "ead_card_produced_date", "ead_card_received_date", "priority_date"]
STAGE_KEYS = ["application_status", "service_center", "premium_processing",
              "biometrics_requested", "noid_issued"]
# Tags that are real vocabulary, usable as either a type value or a category.
TAGS = ["stem-opt-extension", "opt-application", "adjustment-of-status", "h4-ead",
        "J-2", "asylum", "TPS", "DACA", "refugee", "humanitarian-parole"]
TYPE_VALUES = ["EAD", "H-1B", "L-1", "O-1", "TN"]


def row(key, kind="date", **kw):
    field = "key_dates" if key in DATE_KEYS else "key_stages_or_info"
    r = {"kind": kind, "label": key.replace("_", " ").title(), "field": field, "key": key}
    if kind == "select" and "options" not in kw:
        r["options"] = ["a", "b"]
    r.update(kw)
    return r


def spec(types, *, period=None, scope=None, post_join=None):
    """A whole synthetic config. `types` is [(value, [category tags])]."""
    return {
        "version": 1,
        "processing_types": [
            {"value": v, "label": v,
             "eligibility_categories": [{"code": f"({t})", "label": t, "tag": t} for t in cats]}
            for v, cats in types
        ],
        "period_rows": [row("filing_month", "select", options=["Jan", "Feb"]),
                        row("filing_year", "year")] if period is None else period,
        "scope_row_extras": scope or {},
        "post_join_row_extras": post_join or {},
    }


def keys_of(rows):
    return [r["key"] for r in rows]


# ---------------------------------------------------------------------------
# S — the (type x category x extras) matrix
# ---------------------------------------------------------------------------
def group_synthetic_structures() -> None:
    print("\nS — synthetic (type x category x extras) combinations")

    # --- shape of the dropdowns themselves -------------------------------
    cases = [
        ("one type, no categories", [("EAD", [])], ["EAD"], {"EAD": 0}),
        ("one type, one category", [("EAD", ["h4-ead"])], ["EAD"], {"EAD": 1}),
        ("one type, many categories", [("EAD", TAGS[:5])], ["EAD"], {"EAD": 5}),
        ("two types, one with categories",
         [("EAD", ["h4-ead", "asylum"]), ("H-1B", [])], ["EAD", "H-1B"], {"EAD": 2, "H-1B": 0}),
        ("three types, each with its own categories",
         [("EAD", ["h4-ead"]), ("H-1B", ["TPS"]), ("L-1", ["DACA", "refugee"])],
         ["EAD", "H-1B", "L-1"], {"EAD": 1, "H-1B": 1, "L-1": 2}),
    ]
    for name, types, want_types, want_counts in cases:
        s = spec(types)
        errs = ac.validate(s)
        _install(s)
        got_types = [t["value"] for t in posting.PROCESSING_TYPES]
        got_counts = {t["value"]: len(t["eligibility_categories"]) for t in posting.PROCESSING_TYPES}
        check(f"S1 {name}", not errs and got_types == want_types and got_counts == want_counts,
              f"errs={errs[:1]} types={got_types} counts={got_counts}")

    # --- where the extras hang, for one fixed (type, category) pair -------
    T, C = "EAD", "h4-ead"
    matrix = [
        ("no extras anywhere", {}, {}, ["filing_month", "filing_year"], []),
        ("scope extra on the TYPE", {T: [row("priority_date")]}, {},
         ["filing_month", "filing_year", "priority_date"], []),
        ("scope extra on the CATEGORY", {C: [row("priority_date")]}, {},
         ["filing_month", "filing_year", "priority_date"], []),
        ("scope extras on BOTH, distinct keys",
         {T: [row("priority_date")], C: [row("rfe_date")]}, {},
         ["filing_month", "filing_year", "priority_date", "rfe_date"], []),
        ("post-join on the TYPE", {}, {T: [row("ead_filed_date")]},
         ["filing_month", "filing_year"], ["ead_filed_date"]),
        ("post-join on the CATEGORY", {}, {C: [row("ead_filed_date")]},
         ["filing_month", "filing_year"], ["ead_filed_date"]),
        ("post-join on BOTH, distinct keys", {},
         {T: [row("ead_filed_date")], C: [row("rfe_date")]},
         ["filing_month", "filing_year"], ["ead_filed_date", "rfe_date"]),
        ("scope AND post-join together",
         {C: [row("priority_date")]}, {C: [row("ead_filed_date")]},
         ["filing_month", "filing_year", "priority_date"], ["ead_filed_date"]),
    ]
    for name, sc, pj, want_scope, want_pj in matrix:
        s = spec([(T, [C])], scope=sc, post_join=pj)
        errs = ac.validate(s)
        _install(s)
        got_scope = keys_of(posting.timeline_scope_rows(T, C))
        got_pj = keys_of(posting.timeline_post_join_rows(T, C))
        check(f"S2 {name}", not errs and got_scope == want_scope and got_pj == want_pj,
              f"errs={errs[:1]} scope={got_scope} post_join={got_pj}")

    # The pair resolver MERGES type+category; the tag-keyed registry (what the
    # join path uses) resolves off the tag alone and therefore cannot.
    s = spec([(T, [C])], post_join={T: [row("ead_filed_date")], C: [row("rfe_date")]})
    _install(s)
    check("S3 the pair resolver merges type + category post-join rows",
          keys_of(posting.timeline_post_join_rows(T, C)) == ["ead_filed_date", "rfe_date"])
    check("S3b …but the TAG-keyed registry sees only the category's — the documented gap",
          keys_of(posting.POST_JOIN_ATTRIBUTE_TEMPLATES[C]) == ["rfe_date"],
          str(keys_of(posting.POST_JOIN_ATTRIBUTE_TEMPLATES.get(C, []))))
    check("S3c …and the type keeps its own entry alongside",
          keys_of(posting.POST_JOIN_ATTRIBUTE_TEMPLATES[T]) == ["ead_filed_date"])

    # Every kind, in both row sets.
    s = spec([(T, [C])],
             scope={C: [row("priority_date", "date")]},
             post_join={C: [row("ead_filed_date", "date"),
                            row("application_status", "select", options=["x", "y"]),
                            row("premium_processing", "checkbox"),
                            row("filing_year", "year")]})
    check("S4 all four kinds validate in a synthetic config", ac.validate(s) == [], str(ac.validate(s)[:2]))
    _install(s)
    check("S4b …and every one survives resolution with its kind intact",
          [r["kind"] for r in posting.timeline_post_join_rows(T, C)]
          == ["date", "select", "checkbox", "year"])


# ---------------------------------------------------------------------------
# L — layering precedence
# ---------------------------------------------------------------------------
def group_layering() -> None:
    print("\nL — layering precedence (period < type < category)")
    T, C = "EAD", "h4-ead"

    s = spec([(T, [C])],
             scope={T: [row("priority_date", label="From type")],
                    C: [row("priority_date", label="From category")]})
    _install(s)
    rows = posting.timeline_scope_rows(T, C)
    check("L1 category wins over type on the same key",
          [r["label"] for r in rows if r["key"] == "priority_date"] == ["From category"],
          str([(r["key"], r["label"]) for r in rows]))
    check("L1b …and the override happens IN PLACE, not appended",
          keys_of(rows) == ["filing_month", "filing_year", "priority_date"], str(keys_of(rows)))

    # A category may override a BASE period row — e.g. a narrower month list.
    s = spec([(T, [C])],
             scope={C: [row("filing_month", "select", options=["Oct"], label="Filing Month")]})
    _install(s)
    rows = posting.timeline_scope_rows(T, C)
    check("L2 a category can override a base period row",
          rows[0]["options"] == ["Oct"], str(rows[0]))
    check("L2b …and the override keeps position 0, so the period still leads",
          keys_of(rows) == ["filing_month", "filing_year"], str(keys_of(rows)))

    # Resolving off the type alone must NOT see the category's override.
    check("L3 the type alone is unaffected by a category-level override",
          posting.timeline_scope_rows(T)[0]["options"] == ["Jan", "Feb"],
          str(posting.timeline_scope_rows(T)[0]["options"]))

    s = spec([(T, [C])],
             post_join={T: [row("ead_filed_date", required=True), row("rfe_date")],
                        C: [row("rfe_date", required=True, label="Cat RFE")]})
    _install(s)
    rows = posting.timeline_post_join_rows(T, C)
    check("L4 post-join layering overrides in place and preserves order",
          keys_of(rows) == ["ead_filed_date", "rfe_date"]
          and rows[1]["label"] == "Cat RFE", str([(r["key"], r["label"]) for r in rows]))
    check("L4b …and the override's own required flag is what counts",
          posting.required_keys(rows) == ["ead_filed_date", "rfe_date"],
          str(posting.required_keys(rows)))


# ---------------------------------------------------------------------------
# R — the required matrix
# ---------------------------------------------------------------------------
def group_required_matrix() -> None:
    print("\nR — required-key combinations, and the join gate agreeing")
    import matching as M
    T, C = "EAD", "h4-ead"

    combos = [
        ("nothing declared -> row 0",
         [row("ead_filed_date"), row("rfe_date")], ["ead_filed_date"]),
        ("one declared true -> only that",
         [row("ead_filed_date"), row("rfe_date", required=True)], ["rfe_date"]),
        ("several declared true -> all of them",
         [row("ead_filed_date", required=True), row("rfe_date"),
          row("ead_approved_date", required=True)], ["ead_filed_date", "ead_approved_date"]),
        ("all declared false -> nothing mandatory",
         [row("ead_filed_date", required=False), row("rfe_date", required=False)], []),
        ("a single optional row -> nothing mandatory (the I-485 shape)",
         [row("priority_date", required=False)], []),
        ("mixed declarations -> undeclared rows are NOT required",
         [row("ead_filed_date"), row("rfe_date", required=False),
          row("ead_approved_date", required=True)], ["ead_approved_date"]),
    ]
    for name, rows, want in combos:
        s = spec([(T, [C])], post_join={C: rows})
        errs = ac.validate(s)
        _install(s)
        got = posting.required_keys(posting.POST_JOIN_ATTRIBUTE_TEMPLATES[C])
        check(f"R1 {name}", not errs and got == want, f"errs={errs[:1]} got={got}")

        # …and the server-side gate must agree with the config, or the form
        # and the 422s disagree.
        try:
            M._validate_attribute_values(C, {}, require=True)
            gate_blocks = False
        except ValueError:
            gate_blocks = True
        check(f"R2 {name} — the join gate blocks iff something is required",
              gate_blocks == bool(want), f"blocks={gate_blocks} required={want}")

    # An empty post-join list must not gate at all — presence in the registry
    # is what makes a group "needs attributes".
    s = spec([(T, [C])], post_join={C: []})
    _install(s)
    check("R3 a category configured with an EMPTY row list does not gate joining",
          C not in posting.POST_JOIN_ATTRIBUTE_TEMPLATES,
          str(sorted(posting.POST_JOIN_ATTRIBUTE_TEMPLATES)))


# ---------------------------------------------------------------------------
# N — naming across configs
# ---------------------------------------------------------------------------
def group_naming() -> None:
    print("\nN — group naming follows the configured scope rows")
    import matching as M
    T, C = "EAD", "h4-ead"
    base_crit = {"tags": [T, C],
                 "key_stages_or_info": {"filing_month": "Aug", "filing_year": "2026"}}

    _install(spec([(T, [C])]))
    check("N1 with no extras the name is type-category-month-year",
          M._timeline_group_name(base_crit) == "EAD-h4-ead-Aug-2026",
          M._timeline_group_name(base_crit))

    _install(spec([(T, [C])], scope={C: [row("priority_date", name_prefix="PD")]}))
    named = M._timeline_group_name({**base_crit, "key_dates": {"priority_date": "2021-03-15"}})
    check("N2 a prefixed scope row appends 'PREFIX-value'",
          named == "EAD-h4-ead-Aug-2026-PD-2021-03-15", named)

    _install(spec([(T, [C])], scope={C: [row("priority_date")]}))
    named = M._timeline_group_name({**base_crit, "key_dates": {"priority_date": "2021-03-15"}})
    check("N3 without a prefix the bare value is appended",
          named == "EAD-h4-ead-Aug-2026-2021-03-15", named)

    _install(spec([(T, [C])],
                  scope={C: [row("priority_date", name_prefix="PD"),
                             row("rfe_date", name_prefix="RFE")]}))
    named = M._timeline_group_name({**base_crit,
                                    "key_dates": {"priority_date": "2021-03-15",
                                                  "rfe_date": "2026-01-02"}})
    check("N4 two extra scope rows appear in configured order",
          named == "EAD-h4-ead-Aug-2026-PD-2021-03-15-RFE-2026-01-02", named)
    partial = M._timeline_group_name({**base_crit, "key_dates": {"rfe_date": "2026-01-02"}})
    check("N4b …and a row with no value is skipped, prefix and all",
          partial == "EAD-h4-ead-Aug-2026-RFE-2026-01-02", partial)

    # An empty period is refused at publish time (it would collapse dedup),
    # but the NAMER must still behave if one ever reaches it — a group whose
    # criteria simply carry no period values names itself by its tags.
    _install(spec([(T, [C])]))
    check("N5 a group carrying no period VALUES names itself by its tags alone",
          M._timeline_group_name({"tags": [T, C]}) == "EAD-h4-ead",
          M._timeline_group_name({"tags": [T, C]}))


# ---------------------------------------------------------------------------
# E — edge cases
# ---------------------------------------------------------------------------
def group_edge_cases() -> None:
    print("\nE — edge cases")
    T, C = "EAD", "h4-ead"

    # Extras for a tag no type or category mentions: harmless, and NOT
    # promoted into the registries by accident.
    s = spec([(T, [C])], scope={"DACA": [row("priority_date")]},
             post_join={"TPS": [row("ead_filed_date")]})
    check("E1 orphan extras (tags no dropdown offers) still validate", ac.validate(s) == [],
          str(ac.validate(s)[:1]))
    _install(s)
    check("E1b …and do not leak into the resolved registries",
          "DACA" not in posting.TAG_ATTRIBUTE_TEMPLATES
          and "TPS" not in posting.POST_JOIN_ATTRIBUTE_TEMPLATES,
          str(sorted(posting.TAG_ATTRIBUTE_TEMPLATES)))
    check("E1c …but are still reachable by an explicit pair lookup",
          keys_of(posting.timeline_scope_rows(eligibility="DACA"))
          == ["filing_month", "filing_year", "priority_date"])

    # A category tag identical to its own type's value: the layering applies
    # the same extras twice, which must not duplicate a row.
    s = spec([("TPS", ["TPS"])], scope={"TPS": [row("priority_date")]})
    _install(s)
    check("E2 a category tag equal to its type value does not duplicate rows",
          keys_of(posting.timeline_scope_rows("TPS", "TPS"))
          == ["filing_month", "filing_year", "priority_date"],
          str(keys_of(posting.timeline_scope_rows("TPS", "TPS"))))

    # An explicitly EMPTY period is refused: the name is built from the scope
    # rows and dedup is name-based, so stripping the period would collapse
    # every group of a category into one. A MISSING key still means "default".
    s = spec([(T, [C])], period=[], scope={C: [row("priority_date")]})
    check("E3 an explicitly empty period_rows is rejected — it would destroy dedup",
          any("period_rows" in e for e in ac.validate(s)), str(ac.validate(s)[:1]))
    missing = spec([(T, [C])])
    del missing["period_rows"]
    check("E3b …while OMITTING the key means 'use the default', and validates",
          ac.validate(missing) == [], str(ac.validate(missing)[:1]))
    _install(missing)
    check("E3c …and resolves to the default period pair",
          keys_of(posting.timeline_scope_rows(T, C)) == ["filing_month", "filing_year"],
          str(keys_of(posting.timeline_scope_rows(T, C))))
    # _install() goes THROUGH validation, so the empty period above never
    # reaches the resolver — it is rejected and the default serves. To prove
    # the resolver itself distinguishes "empty" from "missing", install the
    # spec directly, bypassing validation the way only a test can.
    _install(default_spec())
    check("E3d …so an empty period never reaches the resolver: the default serves",
          keys_of(posting.timeline_scope_rows(T, C)) == ["filing_month", "filing_year"])
    ac._set_for_tests(spec([(T, [C])], period=[], scope={C: [row("priority_date")]}))
    check("E3e and the resolver itself honours an empty period as EMPTY, not as default",
          keys_of(posting.timeline_scope_rows(T, C)) == ["priority_date"],
          str(keys_of(posting.timeline_scope_rows(T, C))))
    ac._set_for_tests(None)

    # The same key on both sides for one tag — legal, but they mean different
    # things (group scope vs per-member), so both must survive independently.
    s = spec([(T, [C])], scope={C: [row("priority_date")]},
             post_join={C: [row("priority_date")]})
    check("E4 the same key as both a scope and a post-join row validates",
          ac.validate(s) == [], str(ac.validate(s)[:1]))
    _install(s)
    check("E4b …and each side keeps it independently",
          keys_of(posting.timeline_scope_rows(T, C))[-1] == "priority_date"
          and keys_of(posting.timeline_post_join_rows(T, C)) == ["priority_date"])

    # Scale: resolution is rebuilt on every access, so it must stay cheap and
    # correct with a config far larger than today's.
    big = spec([(v, TAGS) for v in TYPE_VALUES])
    check("E5 a 5-type x 10-category config validates", ac.validate(big) == [], str(ac.validate(big)[:2]))
    _install(big)
    t0 = time.monotonic()
    for _ in range(200):
        posting.TAG_ATTRIBUTE_TEMPLATES["h4-ead"]
    elapsed = time.monotonic() - t0
    check("E5b …and 200 resolutions of it stay well under a second",
          elapsed < 1.0, f"{elapsed * 1000:.0f}ms")
    check("E5c …with every type and category present",
          len(posting.PROCESSING_TYPES) == 5
          and all(len(t["eligibility_categories"]) == 10 for t in posting.PROCESSING_TYPES))

    # Unicode/whitespace in the human-facing strings must pass through intact.
    s = spec([(T, [C])],
             post_join={C: [row("ead_filed_date", label="Date d'envoi — 提出日 🗓")]})
    check("E6 a non-ASCII label validates", ac.validate(s) == [], str(ac.validate(s)[:1]))
    _install(s)
    check("E6b …and survives resolution byte-for-byte",
          posting.timeline_post_join_rows(T, C)[0]["label"] == "Date d'envoi — 提出日 🗓")

    # A one-option select is odd but legal — a fixed value the user confirms.
    s = spec([(T, [C])], post_join={C: [row("service_center", "select", options=["PSC"])]})
    check("E7 a single-option select is accepted", ac.validate(s) == [], str(ac.validate(s)[:1]))

    # A checkbox as a SCOPE row: unusual, but nothing forbids it.
    s = spec([(T, [C])], scope={C: [row("premium_processing", "checkbox")]})
    check("E8 a checkbox scope row is accepted", ac.validate(s) == [], str(ac.validate(s)[:1]))

    _install(default_spec())


# ---------------------------------------------------------------------------
# X — further negatives
# ---------------------------------------------------------------------------
def group_more_negatives() -> None:
    print("\nX — further negatives")

    def rejects(s, name, needle=""):
        errs = ac.validate(s)
        ok = bool(errs) and (not needle or any(needle in e for e in errs))
        check(name, ok, str(errs[:2]) if errs else "accepted!")

    T, C = "EAD", "h4-ead"

    # THE silent-failure case this whole validator exists for: a real key
    # declared under the wrong map. profile.py would drop it on save.
    rejects(spec([(T, [C])], post_join={C: [
        {"kind": "select", "label": "Status", "field": "key_dates",
         "key": "application_status", "options": ["a"]}]}),
        "X1 a stage key declared as key_dates is rejected", "application_status")
    rejects(spec([(T, [C])], post_join={C: [
        {"kind": "date", "label": "Filed", "field": "key_stages_or_info", "key": "ead_filed_date"}]}),
        "X2 a date key declared as key_stages_or_info is rejected", "ead_filed_date")

    # A processing type nobody can be tagged with — _clean_criteria drops it,
    # so the group would lose its defining criterion on save.
    rejects(spec([("NOT-A-VOCAB-TYPE", [])]),
            "X3 a processing type outside the vocabulary is rejected", "NOT-A-VOCAB-TYPE")

    rejects({**default_spec(), "processing_types": [{"label": "no value",
                                                     "eligibility_categories": []}]},
            "X4 a processing type with no 'value' is rejected", "value")
    rejects({**default_spec(), "processing_types": [{"value": "EAD",
                                                     "eligibility_categories": "nope"}]},
            "X5 eligibility_categories must be a list", "eligibility_categories")
    rejects({**default_spec(), "processing_types": [
        {"value": "EAD", "eligibility_categories": [{"code": "(x)", "label": "no tag"}]}]},
        "X6 a category with no 'tag' is rejected", "tag")
    # category_label names the second dropdown. Blank or non-string would
    # render an unlabelled control, so it is rejected rather than defaulted.
    for bad, name in ((" ", "X6b a blank category_label is rejected"),
                      (7, "X6c a non-string category_label is rejected")):
        rejects({**default_spec(), "processing_types": [
            {"value": "EAD", "category_label": bad, "eligibility_categories": []}]},
            name, "category_label")
    check("X6d a real category_label is accepted, and omitting it stays valid",
          not ac.validate({**default_spec(), "processing_types": [
              {"value": "EAD", "category_label": "Application type",
               "eligibility_categories": []}]})
          and not ac.validate({**default_spec(), "processing_types": [
              {"value": "EAD", "eligibility_categories": []}]}))
    rejects({**default_spec(), "scope_row_extras": "nope"},
            "X7 scope_row_extras must be an object keyed by tag", "scope_row_extras")
    rejects({**default_spec(), "post_join_row_extras": {"h4-ead": "nope"}},
            "X8 a tag's rows must be a list", "post_join_row_extras.h4-ead")
    rejects({**default_spec(), "post_join_row_extras": {"h4-ead": ["not-an-object"]}},
            "X9 a row must be an object", "must be an object")
    rejects({**default_spec(), "post_join_row_extras": {"h4-ead": [{"kind": "date",
                                                                    "label": "X",
                                                                    "field": "key_dates"}]}},
            "X10 a row with no 'key' is rejected", "key")
    rejects(spec([(T, [C])], period=[{"kind": "select", "label": "M",
                                      "field": "key_stages_or_info", "key": "filing_month"}]),
            "X11 a select period row with no options is rejected", "options")

    # Several problems at once should all be reported, not just the first —
    # an editor fixing them one round-trip at a time is a bad workflow.
    s = spec([("NOT-A-VOCAB-TYPE", [])], post_join={"h4-ead": [
        {"kind": "wormhole", "label": "", "field": "nowhere", "key": "not_a_key"}]})
    errs = ac.validate(s)
    check("X12 every problem is reported, not just the first", len(errs) >= 4, f"{len(errs)} errors")

    _install(default_spec())


def main() -> int:
    real_read = ac._read_firestore
    try:
        group_validation()
        group_fallback()
        group_caching()
        group_posting_views()
        group_synthetic_structures()
        group_layering()
        group_required_matrix()
        group_naming()
        group_edge_cases()
        group_more_negatives()
    finally:
        ac._read_firestore = real_read
        ac._reset_for_tests()

    passed = sum(1 for _, ok in _results if ok)
    print("\n" + "=" * 60)
    print(f"SUMMARY: {passed}/{len(_results)} checks passed")
    failed = [n for n, ok in _results if not ok]
    if failed:
        print("FAILED: " + "; ".join(failed))
        return 1
    print("All attribute-config checks passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
