# USCIS Case Status API — evaluation (for future consideration)

**Status:** DEFERRED. Evaluated 2026-09-29; no code written and no USCIS account created.
**Registry:** `docs/ingestion/GROUNDING-SOURCES.md`. Section B lists "USCIS — Case Status API"; section C rules out
the `my.uscis.gov` private API.
**Decision needed to un-defer:** the two business questions in §5 (US incorporation, Section 508).

---

## 1. The question

Can the platform add value by calling USCIS APIs, for example
`https://my.uscis.gov/secure-messaging/api/case-service/applicant/cases`?

**Answer:** not that endpoint. Yes through USCIS's **official Case Status API**, and it could become a
strong differentiator.

## 2. Why not the `my.uscis.gov` endpoint (ruled out)

| Finding (verified 2026-09-29) | Consequence |
|---|---|
| It returns **401** unless the caller has the applicant's own logged-in USCIS-account session | It is the private backend of the USCIS online account, not a public API |
| That account sits behind Login.gov + MFA | We would have to collect users' USCIS credentials or session tokens: credential handling, account-takeover risk, and a large security/legal liability |
| It is undocumented and has no developer terms | Using it would break USCIS terms, and it can change or break without notice |

The same applies to **scraping** the public case-status page (`egov.uscis.gov`, bot protection) and to
unofficial "case tracker" wrappers. **Do not build on any of these.**

## 3. The official route: USCIS "Torch" API program (`developer.uscis.gov`)

The API catalog (verified 2026-09-29) lists two products:

| API | What it does | Value for us |
|---|---|---|
| **Case Status** | Case status for USCIS customers and representatives who need regular access, keyed by **receipt number** | **High** (see §4) |
| FOIA Request & Status | Create a FOIA/Privacy Act request for A-File material and track its status | Low or niche. Maybe later, as a guided "get your A-File" flow |

**How access works (from the portal's Get Started / Production Access / FAQ pages):**
- A **pull model over REST**. Our backend calls USCIS; USCIS never pushes to us.
- **OAuth 2.0 client credentials:** our Developer Team App gets a Client ID and Secret, which are exchanged
  for an access token sent on every request. **The user's USCIS login is never involved**; the user gives us
  only a receipt number.
- **One case per call** (no batch endpoint). **Rate limits and throttling apply**; the exact numbers are not
  on the public pages, so get them in the sandbox.
- **Sandbox → demo → production.** Sign up, create a team and app, build and test in the sandbox, then email
  for production access. After that:
  - a **Developer Portal Affidavit** (business, website, privacy policy and ToS are verified)
  - a **demo** with a 4-digit `demo_id` request header, run by USCIS, which checks HTTPS success and error handling
  - **production keys**, delivered on USCIS letterhead
- **Eligibility:** software organisations **incorporated in the United States** that follow the Terms of Use
  and offer **Section 508-compliant** apps and websites with a suitable **privacy policy**, posted publicly.
- **No shared credentials or keys.** Every developer needs their own account. Extra production keys are only
  granted for an **independent back-end**.
- **Cost:** no USCIS fee found. The cost is onboarding time plus engineering.

**Verify in the sandbox before designing further:** the exact response schema (the docs render
client-side). Also check whether status **history** is returned, which form types and receipt prefixes are
supported, the rate limits, and any rules on **storing or aggregating** responses.

## 4. Value to the platform

| # | Capability | Why it matters here |
|---|---|---|
| 1 | **Verified, self-updating timelines.** A user links a receipt number and their timeline updates from USCIS, with a *verified by USCIS* badge | Profiles already track self-reported milestones (`h1b_receipt_date`, `h1b_approved_date`, `rfe_date` in `backend/profile.py`); "same boat" matching (`matching.py`) gets more trustworthy with verified data |
| 2 | **Status-change alerts** (e.g. *Case Was Approved*, *Request for Evidence Was Sent*) | A reason to return daily; a natural hook for group chat ("3 people in your cohort got RFEs this week") |
| 3 | **"What's my case status?" in the assistant** | Answered live from USCIS in its official words, with a link. A new source tier alongside gov / community |
| 4 | **Processing-time insights from verified cases** (e.g. "I-765 c(3)(C) filed in May: median N days") | **The differentiator.** Competitors such as Trackitt rely on self-reported data. Needs explicit consent, a minimum cohort size and a terms review (§6) |

Feature 4 depends on features 1 and 2, and on enough linked users.

## 5. Readiness (prerequisites)

| Requirement | Status | Owner |
|---|---|---|
| **US-incorporated company/organization** behind meridianjourney.ai | ❓ **Business decision/confirmation** | Founder |
| **Section 508** (accessibility) compliance of site and app | ❓ **Needs an audit** (WCAG 2.x AA is the practical bar) | Eng + design |
| Public **privacy policy** and **terms of service** | ✅ `website/src/app/privacy`, `website/src/app/terms` exist. ⚠️ Must be updated to cover receipt numbers, USCIS data, consent and retention | Founder/legal |
| Real user authentication (receipt numbers tie to identity) | ✅ Firebase ID-token verification in `api.py`; `ALLOW_USER_IMPERSONATION` is off by default. Must stay off in prod | Eng |
| Secret management for the Client Secret | ✅ Pattern exists (Secret Manager, no key files; `docs/DEPLOYMENT.md`) | Eng |
| USCIS sandbox, demo and production steps | ⏳ Plan for several weeks of calendar time (demo booking) | Eng |

## 6. Proposed design (when un-deferred)

**Principle:** case data is **per-user, private and live**. It is **never** indexed into the shared DS-1
datastore, the BigQuery `postings_metadata` table or community postings.

```
User links receipt # (consent) ──► POST /me/cases ──► Firestore users/{uid}/cases/{caseRef}
                                                          │
Daily refresh (internal, secret-gated) ──► uscis_case_status.py ──OAuth2 CC──► USCIS Case Status API
                                                          │ status changed?
                                                          ├─► timeline milestone (verified) ──► profile / matching
                                                          └─► notification (in-app; FCM when it lands)
Assist "what's my status?" ──► tool call ──► latest stored status (+ on-demand refresh) ──► source_tier="uscis_case"
```

- **Module:** `backend/uscis_case_status.py`. It handles token fetch and caching (refresh before expiry), a
  single-case lookup, and response normalization. It retries with backoff on 429/5xx and never retries on
  4xx validation errors.
  - ⚠️ Add it to the `backend/Dockerfile` COPY list; `tests/test_packaging.py` enforces this.
- **Secrets:** Client ID and Secret in **Secret Manager**, mounted as env vars. Sandbox and production are
  separate apps (USCIS issues separate credentials).
- **Storage:** `users/{uid}/cases/{caseRef}` holds the receipt number, form type, the last status text and
  code, `last_checked_at`, `last_changed_at`, a history of status transitions, and the user's consent flags
  (`alerts`, `insights`).
  - `caseRef` is a salted hash of the receipt number, so the document ID is not the raw number.
  - Firestore is encrypted at rest. Access is limited to the owning user plus the backend service account.
- **Logging:** receipt numbers are **masked** in all logs (e.g. `IOE*******123`) and never appear in analytics.
- **Refresh:** a daily internal route (`POST /internal/case-status/refresh`, gated like the gov-news poll).
  - It paces calls to stay within USCIS rate limits and skips cases in a final state.
  - Its trigger is **one new Cloud Scheduler job**, the only net-new GCP resource.
- **Assist integration:** a new intent/tool. The answer quotes **USCIS's status text verbatim**, plus date and link.
  - Guardrails are unchanged: no interpretation of what a status "means legally" and no eligibility or
    outcome predictions.
  - Offer a disclaimer and a nudge to consult an attorney for RFEs and denials.
- **Unlink and delete:** unlinking deletes the case document and its history. Account deletion cascades.
  Retention follows the privacy policy.
- **Insights (Phase 4 only):**
  - opt-in (`insights` consent)
  - aggregate only from derived durations, never raw receipt numbers
  - **minimum cohort size** (e.g. at least 10) before showing any statistic
  - confirm the USCIS terms allow aggregate or derived use first

## 7. Phasing

| Phase | Scope | Exit criterion |
|---|---|---|
| **0 — Business** | Confirm US incorporation; Section 508 audit; update privacy policy and ToS for case data | Answers to §5's open rows |
| **1 — Sandbox** | Portal sign-up, team and app; `uscis_case_status.py` against the sandbox; verify the §3 unknowns | Sandbox round-trip; schema documented |
| **2 — Demo → production** | Affidavit; `demo_id` header; HTTPS success/error handling; USCIS demo | Production keys received |
| **3 — Linking + verified timeline + alerts** | Link/unlink UI (web, then mobile); daily refresh; in-app notifications; "verified" badge | Real users' statuses sync; alerts fire on change |
| **4 — Insights** | Consented, cohort-thresholded processing-time stats | Terms review passed; the cohort threshold is enforced |

## 8. Test plan (same no-GCP style as the grounding suites)

- **Client:** token caching and refresh; 401 leads to one token refresh and retry; 429 and 5xx back off; 4xx
  is not retried; the response is normalized.
- **Privacy:**
  - receipt numbers are masked in logs (assert on captured output)
  - `caseRef` is not the raw number
  - no case data reaches DS-1, BigQuery postings or the gov/community tiers (assert on the publish paths)
- **Refresh:** unchanged status means no write and no notification; a change produces exactly one timeline
  event plus one notification; final states are skipped; pacing respects the configured rate.
- **Consent:** no alerts without `alerts` consent; users without `insights` consent are excluded from
  aggregation; the cohort threshold is enforced.
- **Assist:** a status question gets the verbatim status text plus link, with no legal interpretation.
  Guardrail regression tests are reused.
- **Packaging:** the module is covered by `tests/test_packaging.py`.

## 9. Risks

| Risk | Mitigation |
|---|---|
| Production access denied or slow (eligibility, 508) | Resolve Phase 0 first; the sandbox work is low-cost and reusable |
| Receipt numbers are sensitive (tie a person to a case) | Consent, masking, hashed IDs, owner-only access, deletion on unlink, a clear privacy policy |
| Users read a status as a legal outcome | Verbatim USCIS text; existing no-legal-advice guardrails; attorney nudge on RFE or denial |
| Rate limits as linked cases grow | Daily cadence, skipping final states, pacing, backoff; ask USCIS about higher limits at the demo |
| USCIS terms restrict storage or aggregation | Confirm in Phase 1; Phase 4 is conditional on it |
| API schema or version changes | Pin the version (the catalog shows version selection); isolate normalization; contract tests on sandbox fixtures |
