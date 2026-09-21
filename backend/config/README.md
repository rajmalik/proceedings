# `timeline_attributes.default.json` — the base Timeline attribute spec

This file is the **base configuration** for Timeline groups: which fields a
group is scoped by, and which it collects from each member on join.

    base (this file)  →  posting.DEFAULT_ATTRIBUTE_SPEC  →  fallback
                      →  publish_attribute_config.py --from-default  →  Firestore

Firestore (`app_config/timeline_attributes`) **overrides** it at runtime. This
file is what serves until something is published there, and what seeds a fresh
environment. Editing it changes the shipped default — it does **not** change a
running environment that already has a published document.

To change a live environment, see [`docs/TIMELINE-ATTRIBUTE-CONFIG.md`](../../docs/TIMELINE-ATTRIBUTE-CONFIG.md).

This README exists because JSON has nowhere to put a comment, and the
reasoning below is the difference between editing this file confidently and
guessing.

---

## Row schema

```jsonc
{"kind": "date" | "select" | "year" | "checkbox",
 "label": "Date Applied",              // what the user sees
 "key": "ead_filed_date",              // MUST exist in the matching CSV
 "field": "key_dates" | "key_stages_or_info",
 "options": ["approved", "pending"],   // select only
 "required": true,                     // post-join only
 "name_prefix": "PD"}                  // scope only
```

| Field | Notes |
|---|---|
| `kind` | The datatype. Drives the rendered control **and** the server-side validation, so the two can't drift — a `select` value outside `options` is a 422, not a silent drop. A `checkbox` stores the literal `"yes"` or nothing at all; never `"no"`, so unticked and never-answered read the same. |
| `key` | Must already exist in `tags-cleaned/1.8-key-dates.csv` (for `key_dates`) or `1.7-key-stages.csv` (for `key_stages_or_info`). `profile.py`'s cleaners silently drop unknown keys, so an unvalidated typo produces a form that accepts input and throws it away. Validation refuses it for exactly this reason. |
| `field` | Which profile map the value lands in. A key declared under the wrong one is rejected. |
| `required` | Post-join only. Any declared flag is taken literally; declare none and row 0 is required — the convention the STEM-OPT template predates the flag with. `false` on the only row means "collect this, never block on it". |
| `name_prefix` | Scope only. Labels this value's segment in the generated group name so adjacent dates stay legible (`…-Aug-2026-PD-2021-03-15`). |

## Scope rows vs post-join rows

The one judgement the config can't make for you: **does every member of the
cohort share this value?**

- **Yes → scope row.** It's what the group *is*. Stored on the group, part of
  its name, compared by `_exact_match()` when searching and deduping.
- **Each member has their own → post-join row.** Written to that member's own
  profile, shown in the members table.

Putting a per-member fact in the scope gives everybody a cohort of one. That
is why an I-485 **priority date is a post-join row, not a scope row**, even
though it is the thing AOS filers care most about sharing: two people in the
same filing month have different priority dates, and scoping by an exact date
would split every cohort into singletons.

It is also **explicitly `"required": false`** — many filers don't have one to
hand, and some categories never get one. Without the declared flag, the row-0
fallback would make the only row mandatory and block joining outright.

## `period_rows`

Every Timeline scope leads with the same pair: a 3-letter calendar Month and a
Year. There is deliberately **no "Cycle"** anywhere. The OPT categories used to
get a Fall/Spring academic cycle, but two different period controls made the
panel inconsistent depending on what you'd picked, and a filing month is
perfectly well-defined for an OPT application too.

Do **not** publish an empty `period_rows`. Group naming is built from the scope
rows and Timeline dedup is name-based, so stripping the period collapses every
group of a category into one cohort. Validation rejects it. Omitting the key
entirely is different and fine — it means "use this file's value".

## `processing_types` and `eligibility_categories`

The first and second dropdowns. Each type names **its own** category list, so
the second dropdown already depends on the first. Two types have one today:
EAD's entries are 8 CFR eligibility categories, H-1B's are application types
(CoS / consular stamping / change of employer).

Because those are not the same kind of thing, a type may set
`"category_label"` to name its own second dropdown. Omit it and the clients
fall back to "Eligibility category".

A type's `value` and a category's `tag` must both be in the controlled
vocabulary. `_clean_criteria()` drops anything out of vocabulary, so an
unvalidated value would produce a dropdown option whose groups silently lose
their defining criterion on save.

**Which EAD categories are listed, and which are deliberately absent**, comes
from 8 CFR § 274a.12 — the regulation behind the eligibility codes printed on
Form I-765 and on the EAD card. Two rules, both from
[`features/ead-eligibility-5/ead-eligibility-evaluation.md`](../../features/ead-eligibility-5/ead-eligibility-evaluation.md)
(read it before adding a row):

1. Only § 274a.12**(c)** classes (must apply for an EAD) and the **(a)** classes
   that still file an I-765 for the card. The **(b)** classes — H-1B, L-1, O-1,
   TN, E-1/E-2, J-1, F-1 on-campus/CPT — are authorized *incident to status* and
   **never file**, so offering them would be simply wrong.
2. Every `tag` must already exist in the controlled vocabulary, so a group
   scoped to it is findable by the same tag a posting would carry.

`code` is display-only provenance — it makes each row auditable against the
CFR. Nothing keys off it.

## Editing this file

```bash
cd backend
python -c "import json; json.load(open('config/timeline_attributes.default.json'))"   # parses?
python tests/test_packaging.py        # exists, parses, validates, and ships
python tests/test_attribute_config.py # 115 checks over the framework
```

`test_packaging.py` also guards the Dockerfile: the image copies an explicit
allowlist, so a new file under `config/` that isn't copied would be missing in
prod while every local test passed.
