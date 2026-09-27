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
| **USCIS — F-1→H-1B→EB→I-485 pathway** (14 pages: F-1 students-and-employment, OPT, STEM OPT; H-1B specialty + cap-gap + e-registration; I-129; H-4 EAD; permanent-workers; EB-1/EB-2/EB-3; I-131 advance parole; AOS filing charts) | official_reference | official_reference |
| **USCIS — core topics** (10 pages: GC eligibility categories hub + employment-based/family-preference/asylee GC; asylum; TPS; N-400 naturalization; citizenship & naturalization; I-90; I-539) | official_reference | official_reference |
| **DOL OFLC — employer side of the employment path** (4 pages: Foreign Labor Certification hub, PERM, LCA H-1B/H-1B1/E-3, prevailing wage) | official_reference | official_reference |
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
| **Remaining USCIS long tail** — pathway + core topics now grounded (section A); REMAINING: niche GC-eligibility categories (broadcaster, NATO-6, U/T/SIJ victims, religious worker, etc.), consular-processing, maintaining/replacing residence, family-of-US-citizens subpages, citizenship study materials | P2–P3 | official_reference config (curate from `harvest_uscis_sitemap.py`; sharper once a `--demand-file` of query-log misses is wired) |
| **Sub-pages of DHS Study in the States** — `studyinthestates.dhs.gov/students/study/*`, `/stem-opt-hub`, `/sevp-portal-help`, `/sevis-help-hub/*`, `/schools` | P2 | official_reference config |
| **Sub-pages of ICE SEVIS** — `ice.gov/sevis/overview`, `/students`, `/schools`, `/schools/reg`, `/schools/school-alerts` | P2 | official_reference config |
| State Dept — Visa Bulletin (`travel.state.gov`) | P1 (ops) | official_reference adapter (resilient fetch) |
| USCIS — Processing times (`egov.uscis.gov/processing-times`) | P1 (ops) | adapter (fetch decision pending) |
| USCIS — Case Status API (`developer.uscis.gov`) | P1 (ops) | function-call (authenticated, live) |
| **Federal Register — immigration rules/notices** (`federalregister.gov` JSON API; agencies USCIS, DHS parent, EOIR, ICE; types RULE/PRORULE/NOTICE) — NEXT PICK | P1 (latest) | FR API adapter → gov_news: drop PRA "Information Collection"/Privacy Act/Meeting titles; DHS-parent needs immigration-keyword filter; text from API abstract + raw_text (not the USCIS Drupal selector). ~40 relevant docs/yr |
| eCFR — Title 8 CFR (`ecfr.gov` API) | P2 (legal) | API adapter → new doc_kind |
| DOL — remaining (`dol.gov` H-2A/H-2B programs; `flag.dol.gov` FLAG portal + public disclosure data) | P3 | official_reference config (core PERM/LCA/PWD now grounded — section A). PERM FAQs page fetches ~99w (stub — not groundable); `dol.gov/rss` unscoped; DOL-ETA FR rules 0/8 immigration |
| DOJ EOIR — BIA/AAO precedent (`justice.gov/eoir`) | P2 (legal) | PDF ingest |
| USCIS — remaining forms/topics (fees, Policy Manual chapters) | P2 | official_reference config |
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
| Federal Register — raw agency RSS as-is (e.g. `documents.rss?conditions[agencies][]=u-s-citizenship-and-immigration-services`) | ~97% PRA "Information Collection" notices (42/43 on 2026-09-27) → would outrank real form pages in gov tier; ICE/EOIR RSS empty. Use the filtered FR API adapter (section B) instead. |
