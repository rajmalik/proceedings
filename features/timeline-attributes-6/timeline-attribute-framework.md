# Timeline group attributes as configuration

**Status:** evaluation + implementation, 2026-08-06. Written to answer two
questions asked together with the I-485 priority-date change:

3. Can the attributes a Timeline group collects be made *dependent on the
   second dropdown* (eligibility category) rather than hardcoded?
4. Can the same hold as the *first dropdown* (processing type) grows — with
   the second dropdown's contents, and the attributes, both driven by
   configuration?

Short answer to both: **yes, and it now is.** This document describes what
shipped, what it costs to add the next type or category, and the three things
the framework deliberately still does *not* do.

> Engineering analysis. Nothing here is legal advice, and none of it should be
> surfaced to users as eligibility guidance.

---

## 1. The two dropdowns and the two row sets

A Timeline group is scoped by a pair — **Processing type** (EAD, H-1B, …) and,
for types that have one, an **Eligibility category** (`stem-opt-extension`,
`adjustment-of-status`, …). That pair decides two independent sets of fields,
which are easy to confuse and must not be:

| | **Scope rows** | **Post-join rows** |
|---|---|---|
| Where entered | find/create panel | the group's own page, on join |
| Stored on | the **group's** `criteria_tags` | the **member's own profile** |
| Shared by | every member — it's what the group *is* | nobody; one row per member |
| Used for | search (`_exact_match`), dedup, the group name | the members table |
| Required? | never | configurable per row; row 0 by default |

The distinction is not cosmetic, and the test is simple: **does every member
of the cohort share this value?** The filing period does — it is what the
group *is*. An individual's dates do not: two members of one
`stem-opt-extension` Aug-2026 group filed on different days, and every member
of an I-485 cohort has their own priority date. Putting a per-member fact in
the scope would give each person a group of one.

## 2. How resolution works

Both sets resolve by layering, in `backend/config/timeline_attributes.default.json` (loaded by `backend/posting.py`):

```
base (every Timeline scope)  +  processing-type extras  +  category extras
```

A later layer replaces an earlier row with the same `key` **in place** rather
than appending a second control for it (`_layer_rows`). The base is the period
pair — a 3-letter Month and a Year — which every scope gets so that any two
Timeline groups remain comparable by filing period no matter what else they
are scoped by.

The entry points:

```python
timeline_scope_rows(processing_type="", eligibility="") -> list[dict]
timeline_post_join_rows(processing_type="", eligibility="") -> list[dict]
required_keys(rows) -> list[str]
```

Either argument may be empty, which is what lets tag-only callers — group
naming, the group page, attribute validation, all of which only ever have a
stored tag to go on — reuse the same resolver without knowing which dropdown
a tag came from.

`_resolve_templates()` runs once at import and does two things:

1. flattens the spec into the two tag-keyed registries the rest of the system
   already reads (`TAG_ATTRIBUTE_TEMPLATES`, `POST_JOIN_ATTRIBUTE_TEMPLATES`),
   so nothing downstream had to change; and
2. attaches the resolved `scope_rows` / `post_join_rows` to **each dropdown
   option** in `PROCESSING_TYPES`, so a client reads the rows straight off the
   option the user selected — no second lookup, and correct even once a type
   and a category both contribute rows.

Both clients prefer (2) and fall back to (1), which keeps a vocab payload
cached before this change working. `/api/tag-vocab` caches for an hour
(`revalidate: 3600`), so that fallback is not theoretical.

### Row shape

```python
{"kind": "date"|"select"|"year"|"checkbox",
 "label": str, "field": "key_dates"|"key_stages_or_info", "key": str,
 "options": [...],          # select only
 "required": True,          # post-join only; see required_keys()
 "name_prefix": "PD"}       # scope only; labels this value in the group name
```

`kind` drives the control **and** the server-side validation, so the two
cannot drift — a `select` value outside `options` is a 422, not a silent drop.
`field` decides which map the value lands in. Every `key` must already exist
in the matching CSV (`1.8-key-dates` / `1.7-key-stages`) or `profile.py`'s
cleaners drop it on save; test `V` asserts this per row.

## 3. What shipped for I-485

One entry:

```python
POST_JOIN_ROW_EXTRAS = {
    "adjustment-of-status": [
        {"kind": "date", "label": "Priority Date", "field": "key_dates",
         "key": "priority_date", "required": False},
    ],
}
```

`priority_date` was already real 1.8 vocabulary — no CSV change. Joining an
AOS group now offers a Priority Date field; every other category is untouched,
and the find/create panel is unchanged.

**It is a post-join row, not a scope row**, because a priority date is a
per-member fact: everyone in an AOS cohort has their own. Scoping the whole
group by one exact date would have split every cohort into cohorts of one, and
because Timeline dedup is name-based, it would have put a raw date in the group
name. The cohort is defined by its filing period; what each member is waiting
on is theirs.

**It is explicitly optional**, which is what the `"required": False`
declaration is for. `required_keys()` falls back to "row 0 is required" for
templates that declare nothing — the convention the STEM-OPT template was
written to — so a single-row template would otherwise have made its one row
mandatory and blocked joining. A declared flag anywhere in a template switches
resolution to literal mode; that is the only way to express "collect this, but
never block on it" (M43d).

Two consequences worth knowing:

- An AOS group is still **gated** (`needs_attributes` is true until the member
  submits), but the form can be saved empty — the attributes doc is written
  regardless, which clears the gate. "Optional" means optional to *fill*, not
  optional to *see*.
- `_timeline_group_name()` still walks the resolved scope rows generically
  rather than hardcoding "first select, then first year". That generalisation
  outlived the row that motivated it, and is what M45 exercises.

## 4. Cost of the next change

| Change | Work |
|---|---|
| Extra field on an existing category | 1 entry in `SCOPE_ROW_EXTRAS` (defines the cohort) or `POST_JOIN_ROW_EXTRAS` (varies per member) |
| New eligibility category under EAD | 1 row in `EAD_ELIGIBILITY_CATEGORIES` (+ its tag must exist in the vocabulary) |
| New processing type with its own categories | 1 entry in `PROCESSING_TYPES` naming its own category list |
| Move which field is mandatory | `"required": True` on the row |

None of these touch the website or the mobile app. Both render whatever rows
the resolved config hands them, including a `date` row they have never seen
before — which is what let the priority date move from the create panel to the
join form as a pure config change, with no UI code following it.

**Deciding which set a new field belongs to** is the one judgement the config
can't make for you: does every member of the cohort share this value? If yes
it scopes the group; if each member has their own, it is a post-join row.

The remaining hand-written coupling is small and deliberate: a processing
type's *value* must be either a 1.1 visa code or a 1.6 action tag, because
`processingTypeField()` routes it into `current_visa_or_greencard_category`
vs `tags` by checking the visa vocabulary. A new type that is neither would
need that routing extended.

## 5. What this deliberately does NOT do

**Per-type overrides of a shared category.** `TAG_ATTRIBUTE_TEMPLATES` is
keyed by a single tag, so if `adjustment-of-status` ever appears under two
processing types with *different* rows, the tag-keyed lookup can only return
one of them. The pair-aware resolver and the enriched dropdown options are
already correct; the flat registry is the weak link, and it exists because
stored criteria carry tags, not the dropdown pair that produced them. The fix,
when needed, is to store the processing type explicitly on the group rather
than inferring it — worth doing at the same time as the first type that shares
a category, and not before.

**Conditional rows within a category.** Every row for a scope is always shown.
"Show X only when Y is set" (say, a receipt-notice date only once status is
`pending`) has no representation in the spec. It would be a `"when": {...}`
predicate on the row, evaluated identically in both clients — cheap to add,
but no current category needs it, and a predicate language that nothing uses
is a liability.

**Validation beyond kind + options.** A date row accepts any string the client
sends. There is no range check, no "approved date must follow filed date", no
priority-date sanity bound. `_validate_attribute_values` is the single place
this would go, and it already has the row in hand.

## 6. Follow-ups

- **AOS collects only the priority date.** The equivalent of the 11 STEM-OPT
  rows — receipt date, biometrics, interview, EAD/AP combo card, approval — is
  the natural next config entry, and needs its key list checked against 1.8
  first. Once a genuinely mandatory row exists there, mark it
  `"required": True`; the other rows keep their explicit `required: False`.
- **No category configures a scope extra**, so `name_prefix` and the date
  branch of each panel's scope renderer are carried without a live user. Both
  are covered by tests against an injected row (M45 / the "synthetic
  scope-extra" category in each client's suite) rather than left unexercised.
- Task #199 (the EAD-evaluation follow-ups: retiring duplicate `stem-opt` /
  `h4-work-auth`, marking `l2-ead` historical, the six gap tags) is unchanged
  by this work and still open.

## 7. Where the tests are

`backend/tests/test_matching.py`, group **M34–M44d**: the resolution rules
(layering, override-in-place, unknown pairs), the required-key config, the
dropdown enrichment, and the naming/dedup consequences. **M32–M32c** pin the
"every scope leads with Month + Year" invariant that the extras must not
break. `backend/tests/test_profile_vocab.py` group **V** checks every resolved
row against the CSV vocabulary its `field` names.

Client-side, both `website/src/app/find/__tests__/page.test.tsx` and
`mobile/src/screens/__tests__/FindScreen.test.tsx` carry a
"scope rows are configuration, not code" block: the extra row renders, a date
row is sent in `key_dates` while a period row goes to `key_stages_or_info`, a
category without extras shows only the period pair, and switching category
drops the previous one's values.
