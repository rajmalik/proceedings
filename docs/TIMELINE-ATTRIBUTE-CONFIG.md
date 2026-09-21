# Timeline attribute config — runbook

The fields a Timeline group is scoped by, and the fields it collects from each
member on join, are **data, not code**. They live in a Firestore document and
change without a deploy.

    Firestore   app_config/timeline_attributes
    Loader      backend/attribute_config.py
    Base spec   backend/config/timeline_attributes.default.json
                (+ config/README.md — the reasoning behind it)
    Publisher   backend/scripts/publish_attribute_config.py
    Read API    GET  /api/config/attributes
    Refresh     POST /api/config/attributes/refresh   (X-Admin-Token)

---

## 1. Seed it into Firestore for the first time

**You may not need to.** With no document, every instance serves the base spec
shipped in the image (`config/timeline_attributes.default.json`, loaded into
`posting.DEFAULT_ATTRIBUTE_SPEC`) and the app works normally — `meta.source` just reads
`default`. Seed the document when you want to start *editing* config without
deploying. A brand-new environment is not broken until then.

### The three moving parts

| | What | Why it's that one |
|---|---|---|
| **Program that writes** | [`backend/scripts/publish_attribute_config.py`](../backend/scripts/publish_attribute_config.py) | The **only** write path. The API deliberately exposes no config-write endpoint, so a malformed spec can't arrive over HTTP — it has to come through here, and here runs `attribute_config.validate()` *before* it writes. |
| **JSON it reads** | [`backend/config/timeline_attributes.default.json`](../backend/config/timeline_attributes.default.json) | The base spec, and the single source for a fresh seed. `posting._load_base_config()` loads it into `DEFAULT_ATTRIBUTE_SPEC` at import; `--from-default` publishes exactly that. Its field-by-field reasoning is in [`backend/config/README.md`](../backend/config/README.md). |
| **Where it lands** | Firestore document `app_config/timeline_attributes`, in the **GCP project your ADC resolves to** | One document per project. Not a collection to design, not an index to create — see the warning below about *which* project that actually is. |

The whole path in one line:

    config/timeline_attributes.default.json
      → posting.DEFAULT_ATTRIBUTE_SPEC        (loaded at import)
      → publish_attribute_config.py --from-default
      → validate()                            (refuses to write a bad spec)
      → Firestore  app_config/timeline_attributes   (version bumped)
      → attribute_config.get()  in every API instance, within one TTL

### Prerequisites

```bash
gcloud auth application-default login          # once per machine
```

**Which project gets written is decided by ADC, not by `.env`.** The publisher
constructs a bare `firestore.Client()`, which resolves the project from
`GOOGLE_CLOUD_PROJECT` or the ADC credentials — it does *not* read
`GCP_PROJECT_ID`, even though that is set in `backend/.env` and usually holds
the same value. Setting `GCP_PROJECT_ID` alone will silently write to whatever
project your ADC points at. Check before you publish:

```bash
gcloud config get-value project                  # what ADC will use
python -c "from google.cloud import firestore; print(firestore.Client().project)"
```

To target a different project explicitly, set `GOOGLE_CLOUD_PROJECT` for the
command, or re-run `gcloud auth application-default login` against it.

- The caller needs Firestore **write** access to the `app_config` collection —
  `roles/datastore.user` covers it. The running API only ever *reads*, so its
  service account needs `roles/datastore.viewer` at minimum (it almost
  certainly already has more, since groups and profiles live in Firestore).
- No collection or index to create up front: Firestore makes
  `app_config/timeline_attributes` on first write, and a single-document read
  needs no composite index.

### Seed it

The script finds the JSON and `backend/.env` relative to its own location, so
it works from anywhere; `cd backend` just keeps the `--file` paths below short.

```bash
cd backend
python scripts/publish_attribute_config.py --from-default --yes
```

`--from-default` is what makes this a *seed from the JSON file*: it reads
`config/timeline_attributes.default.json` (via `posting.DEFAULT_ATTRIBUTE_SPEC`)
rather than any local edit. In order, the script:

1. loads the JSON and runs `attribute_config.validate()` on it — on any error it
   prints every problem and **writes nothing** (exit 1);
2. prints a unified diff of live-vs-proposed, so you see exactly what changes;
3. sets `version` to `(live version or 0) + 1`;
4. writes `app_config/timeline_attributes` in the resolved project.

Drop `--yes` to stop after step 2 and be asked. To seed from a file that is
*not* the shipped default — a spec exported from another environment, say —
use `--file <path>` instead; it takes the same validate → diff → write path.

```bash
python scripts/publish_attribute_config.py --file spec.json --validate-only   # check only
python scripts/publish_attribute_config.py --file spec.json --yes             # write it
```

### Verify

```bash
python scripts/publish_attribute_config.py --show          # the stored document
curl -s https://<api-host>/api/config/attributes | jq .meta
```

`meta.source` should flip from `default` to `firestore` within one TTL (60s),
or immediately after `POST /api/config/attributes/refresh`. If it still says
`default`, read `meta.last_error` — §6.

### Which environment you just wrote to

The document is **per GCP project**, so dev / staging / prod each need their
own seed. They can hold different specs on purpose; nothing syncs them. There
is no environment flag on the script — the target is whatever project ADC
resolves, so switching environments means switching credentials:

```bash
# one-off, for this command only
GOOGLE_CLOUD_PROJECT=my-staging-project \
  python scripts/publish_attribute_config.py --from-default --yes

# or switch the ambient credentials
gcloud auth application-default login       # against the other project
```

Confirm which one you hit, from the environment's own API rather than from
your shell:

```bash
curl -s https://<api-host>/api/config/attributes | jq '.meta.source, .meta.version'
```

Keep the exported JSON in version control or a ticket if you want a record of
what each environment is running — `--show` is the only other source of truth.

### After seeding, the JSON is no longer what's live

This is the trap worth internalising: once a project has a published document,
**editing `timeline_attributes.default.json` changes nothing in that
environment.** Firestore overrides the shipped base, so the file only serves
environments with no document yet, and only seeds new ones. To change a live
environment you either re-run the seed (`--from-default`, picking up your JSON
edit) or publish an edited export — §2. To go back to the file for good, delete
the document:

```bash
python scripts/publish_attribute_config.py --delete --yes
```

## 2. Change a field

```bash
cd backend
python scripts/publish_attribute_config.py --export spec.json
$EDITOR spec.json
python scripts/publish_attribute_config.py --file spec.json --validate-only
python scripts/publish_attribute_config.py --file spec.json --yes
```

Live everywhere within one TTL (60 s default). To confirm immediately:

```bash
curl -X POST -H "X-Admin-Token: $MODERATION_ADMIN_TOKEN" \
  https://<api-host>/api/config/attributes/refresh
```

**Never edit the document in the Firestore console.** The console does not run
`validate()`; the publisher does. An invalid document isn't served (the backend
rejects it and keeps last-good), but you'd only discover that from
`last_error`, having believed the change was live.

## 3. The spec

```jsonc
{
  "version": 3,
  "processing_types": [                    // the FIRST dropdown
    {"value": "EAD", "label": "EAD",
     "eligibility_categories": [           // the SECOND dropdown, per type
       {"code": "(c)(9)", "label": "Pending adjustment of status (I-485)",
        "tag": "adjustment-of-status"}
     ]}
  ],
  "period_rows":          [row, ...],          // base scope, every group
  "scope_row_extras":     {"<tag>": [row]},    // extra create-time rows
  "post_join_row_extras": {"<tag>": [row]}     // per-member join rows
}
```

A **row**:

| Field | Meaning |
|---|---|
| `kind` | `date` \| `select` \| `year` \| `checkbox` — the datatype. Drives the control *and* the server-side validation. |
| `label` | what the user sees |
| `key` | **must already exist** in `tags-cleaned/1.8-key-dates.csv` or `1.7-key-stages.csv` |
| `field` | `key_dates` \| `key_stages_or_info` — which profile map the value lands in |
| `options` | `select` only; the value domain the server enforces |
| `required` | post-join only. Any declared flag wins literally; declare none and row 0 is required. `false` on the only row = collect it, never block. |
| `name_prefix` | scope only; labels this value's segment in the generated group name |

**Scope vs post-join** is the one judgement the config can't make for you:
*does every member of the cohort share this value?* Yes → scope row. Each
member has their own → post-join row. A per-member fact in the scope gives
everybody a cohort of one.

## 4. Adding a key the vocabulary doesn't have

Validation rejects a `key` that isn't in the CSVs, because `profile.py`'s
cleaners silently drop unknown keys — the form would accept input and throw it
away. So a genuinely new field is **two** changes:

1. add the key to the right `tags-cleaned/*.csv` (a code change, needs a deploy)
2. then reference it from the config (no deploy)

Adding a field that uses an *existing* key is config-only.

## 5. Caching and propagation

| Layer | Window | Tunable by |
|---|---|---|
| Backend in-process | 60 s | `ATTR_CONFIG_TTL_SECONDS` |
| Website `/api/tag-vocab` | 60 s | `VOCAB_REVALIDATE_SECONDS` |
| Mobile | per screen mount | — |

Worst case browser propagation is roughly the sum, so ~2 minutes on defaults.
Inside the TTL there is **no** Firestore traffic; on expiry it is one document
read per instance. A failing backend is retried once per TTL, not per request.

The TTL is a staleness bound, not a correctness bound: two instances can
briefly serve different versions. That is fine for form definitions, and is
why group *names* are built from stored criteria rather than recomputed from
config.

## 6. When something looks wrong

```bash
curl https://<api-host>/api/config/attributes | jq .meta
```

`source` is the answer to "is prod running my edit?":

| `source` | Meaning | Do |
|---|---|---|
| `firestore` | serving the published document | check `version` matches what you published |
| `last-good` | the document is unreadable or **failed validation** — serving the previous good one | read `last_error`; fix and republish |
| `default` | nothing published, or nothing has ever validated — serving `config/timeline_attributes.default.json` from the image | publish, or check `last_error` |

**Rollback** is `--delete` (every instance reverts to the shipped base JSON
within one TTL) or republishing the previous JSON. Keep the exported file.

## 7. Why Firestore

Already an in-process dependency — no new client, IAM or env — and strongly
consistent, so an edit is visible on the very next refresh. GCS would have
worked but is slower and needs generation-polling to detect change. Cloud Run
env vars were disqualified outright: changing one requires a new revision,
which is the exact thing this removes.

## 8. What is still code

- **The four `kind`s.** A fifth (`number`, `multiselect`) needs the validator
  plus each client's control renderer — three code changes.
- **Format/range/cross-field validation.** A `date` row accepts any string;
  there is no "approved must follow filed".
- **Conditional visibility.** No `"when": {…}` predicate; every row for a
  scope is always shown.
- **Join-time resolution is by tag, not by the dropdown pair.** If a
  processing type ever gets its own post-join rows *and* a category does too,
  the join form returns only one of them. See
  `features/timeline-attributes-6/timeline-attribute-framework.md` §5.

## 9. Tests

`backend/tests/test_attribute_config.py` — 41 checks, no GCP calls (Firestore
is stubbed):

- **V** validation accepts the shipped default and rejects unknown keys/kinds/
  fields, optionless selects, duplicates, and side-confused flags
- **F** the fallback ladder, including *invalid published config keeps
  last-good* and *unreachable Firestore keeps last-good*
- **C** cache behaviour: 50 reads → 1 fetch, TTL expiry, forced refresh, and a
  dead backend retried once per TTL rather than per request
- **P** a config edit changes `POST_JOIN_ATTRIBUTE_TEMPLATES`, the dropdown
  options, the `/api/tag-vocab` payload and server-side validation — with no
  restart and no reimport
