# Grounding sources — at-a-glance registry

Sources only. Full analysis: `docs/explorations/grounding-strategy.md` + `GROUNDING-INGESTION-PLAN.md`.

> **Maintenance (keep current):** whenever grounding ingestion changes — a source added, removed, or
> toggled on/off; a gap closed; a new source ruled out — update the relevant A/B/C list here **in the
> same change/PR**, in this session and future sessions on any branch. Keep it sources-only (no prose).
Legend — method: `official_reference` / `gov_news` = the two DS-1 pollers · `datastore(DS-2)` = crawl ·
`web-search` = live tier · `function-call` = live API (not indexed). Tier: gov / community / web.

## A. Currently grounded (ingested + in the RAG answer path)

### Government (gov tier — `doc_kind: gov_news | official_reference`)
| Source | Method | doc_kind |
|---|---|---|
| USCIS — AR-11 (`uscis.gov/ar-11`) | official_reference | official_reference |
| USCIS — Change of Address (`uscis.gov/addresschange`) | official_reference | official_reference |
| USCIS — I-765 / EAD (`uscis.gov/i-765`) | official_reference | official_reference |
| USCIS — I-140 (`uscis.gov/i-140`) | official_reference | official_reference |
| USCIS — I-485 (`uscis.gov/i-485`) | official_reference | official_reference |
| USCIS — I-130 (`uscis.gov/i-130`) | official_reference | official_reference |
| USCIS — Adjustment of Status (`uscis.gov/green-card/.../adjustment-of-status`) | official_reference | official_reference |
| USCIS — EAD (`uscis.gov/green-card/.../employment-authorization-document`) | official_reference | official_reference |
| USCIS — Visa Availability & Priority Dates (`uscis.gov/green-card/.../visa-availability-and-priority-dates`) | official_reference | official_reference |
| USCIS — Family (`uscis.gov/family`) | official_reference | official_reference |
| ICE — SEVP/SEVIS (`ice.gov/sevis`) | official_reference | official_reference |
| DHS — Study in the States (`studyinthestates.dhs.gov/students`) | official_reference | official_reference |
| USCIS — Newsroom / alerts (RSS) | gov_news | gov_news |

### Community / first-party (not gov tier)
| Source | Method | doc_kind |
|---|---|---|
| App / user postings | app publish | post |
| Reddit postings | reddit seed/publish | post |
| immihelp.com/experiences | manual bounded seed | (community) |

### Wired but OFF by default (not currently serving)
| Source | Method | Toggle |
|---|---|---|
| uscis.gov, travel.state.gov, dol.gov (+ boundless.com, immigrationdirect.com) | datastore(DS-2) crawl, tier-3 fallback | `GCP_VERTEX_PUBLIC_ENGINE_ID` (unset) |
| uscis.gov, travel.state.gov, dhs.gov | web-search (.gov-restricted) | `AI_ASSIST_WEB_SEARCH=0` |

## B. Gaps — potential sources to add (not yet grounded)

> Sub-page gap: the `official_reference` poller fetches only the **exact URLs** in section A (single-page,
> no crawl), so the **child pages/sub-trees** of section-A sources below are NOT grounded.

| Source | Priority | Proposed method |
|---|---|---|
| **Sub-pages of covered USCIS pages** — `uscis.gov/green-card/*` (green-card-eligibility, how-to-apply, consular-processing, maintaining/replacing/rights), `uscis.gov/family/*` (family-of-us-citizens, spouse/fiancé, adoption), `uscis.gov/working-in-the-united-states/*` (temporary/permanent workers, students-and-employment, employers/I-9) | P1–P2 | official_reference config (curate from `uscis.gov/sitemap`) or DS-2 crawl |
| **Sub-pages of DHS Study in the States** — `studyinthestates.dhs.gov/students/study/*`, `/stem-opt-hub`, `/sevp-portal-help`, `/sevis-help-hub/*`, `/schools` | P2 | official_reference config |
| **Sub-pages of ICE SEVIS** — `ice.gov/sevis/overview`, `/students`, `/schools`, `/schools/reg`, `/schools/school-alerts` | P2 | official_reference config |
| State Dept — Visa Bulletin (`travel.state.gov`) | P1 (ops) | official_reference adapter (resilient fetch) |
| USCIS — Processing times (`egov.uscis.gov/processing-times`) | P1 (ops) | adapter (fetch decision pending) |
| USCIS — Case Status API (`developer.uscis.gov`) | P1 (ops) | function-call (authenticated, live) |
| Federal Register (`federalregister.gov` API) | P2 (legal) | API adapter → new doc_kind |
| eCFR — Title 8 CFR (`ecfr.gov` API) | P2 (legal) | API adapter → new doc_kind |
| DOL — PERM/LCA/foreign labor (`dol.gov`, `flag.dol.gov`) | P2 | official_reference config |
| DOJ EOIR — BIA/AAO precedent (`justice.gov/eoir`) | P2 (legal) | PDF ingest |
| USCIS — more pages (I-129, I-539, I-90, N-400, I-131, H-1B, fees, Policy Manual) | P2 | official_reference config |
| Federal Register — agency-scoped RSS | P1 | gov_news (Firestore registry) |
| CBP (`cbp.gov`) | P3 | official_reference config |
| DHS OHSS statistics (`ohss.dhs.gov`) | P3 | official_reference config |
| regulations.gov | P3 | API adapter |
| govinfo.gov / INA (US Code Title 8) | P3 | official_reference / API |

## C. Ruled out (with reason)
| Source | Reason |
|---|---|
| AILA — Think Immigration blog, AILALink (`aila.org`) | Copyrighted; reuse by written permission only; AILALink is paid. Not ingestible. |
| Murthy — blog + forum (`murthy.com`) | Copyrighted third-party + user-generated content / PII. |
| Trackitt, AM22tech, VisaJourney, ILW / Immigration Daily | Copyrighted + UGC/PII; no license to republish. |
| Reddit (as a NEW authoritative source) | UGC/PII; already ingested as *community* postings, not authoritative. |
| Law-firm / guide sites — boundless.com, immigrationdirect.com | Non-gov, non-authoritative; only present in the default-off DS-2 crawl. Excluded from the authenticated gov corpus. |
| Community immigration MCP servers (uscis-mcp, immigration-mcp, us-immigration-mcp) | Unofficial, no warranty, self-hosted; e.g. processing times sourced from a non-gov aggregator. Not authenticated. |
| immigrationtimes.org | Unofficial aggregator (used by uscis-mcp); not a government source. |
