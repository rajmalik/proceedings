# EAD eligibility categories → our tag vocabulary

**Status:** evaluation, 2026-08-06. Written to answer three questions before the
"Processing type → EAD" UI change ships:

1. Which US immigration / non-immigration categories can apply for an EAD?
2. Which of those do we already have a tag for?
3. Which have **no** tag — and where is our vocabulary redundant or wrong?

**Authority.** The controlling list is **8 CFR § 274a.12**, "Classes of aliens
authorized to accept employment", which is also the source of the eligibility
category codes printed on Form I-765 and on the EAD card itself. Cited via
[Cornell LII](https://www.law.cornell.edu/cfr/text/8/274a.12) (the eCFR copy
redirects through a bot wall). Cross-checked against
[USCIS Form I-765](https://www.uscis.gov/i-765) and the
[I-765 instructions](https://www.uscis.gov/sites/default/files/document/forms/i-765instr.pdf).

> This is engineering analysis for building a tag taxonomy. It is **not legal
> advice** and must never be surfaced to users as eligibility guidance — the
> same guardrail `query.py` enforces for answers.

---

## 1. The three tiers, and why only two of them matter to us

§ 274a.12 splits into three paragraphs, and the distinction decides whether an
"EAD timeline" is even a thing for that person:

| Para | Meaning | Do they file I-765? | In scope for an EAD group? |
|---|---|---|---|
| **(a)** | Authorized **incident to status** | Often yes — but only to *get the card* as evidence | **Partly** — they have a real filing timeline |
| **(b)** | Authorized **for a specific employer** | **No** | **No** — no EAD, no timeline |
| **(c)** | **Must apply** for authorization | **Yes** — the EAD *is* the authorization | **Yes — the core case** |

The **(b)** classes are the whole of H-1B, L-1, O-1, P, TN, E-1/E-2, F-1
on-campus/CPT, J-1, and so on. They are employment-authorized by virtue of
their status and **never file an I-765**. This is the single most important
thing for the UI: *an H-1B holder is not an EAD applicant.* If the second
dropdown lists visa codes generically, it will offer H-1B, L-1 and TN — all of
which are wrong answers.

So the dropdown must be built from **(c)** (and the subset of **(a)** that
files for a card), not from our 1.1 visa list.

---

## 2. Paragraph (c) — must apply for an EAD

The core list. "Our tag" is the closest existing entry in `tags-cleaned/`.

| I-765 code | Who | Our tag(s) | File | Verdict |
|---|---|---|---|---|
| (c)(1) | A-1/A-2 dependent spouse/child | `A-1`, `A-2` | 1.1 | ⚠️ status only — no *dependent* tag |
| (c)(2) | E-1 dependent (Taiwan/CCNAA) | `E-1` | 1.1 | ⚠️ status only |
| (c)(3)(i)(A) | F-1 **pre-completion** OPT | `F-1` + `opt-application` | 1.1, 1.6 | ✅ |
| (c)(3)(i)(B) | F-1 **post-completion** OPT | `F-1` + `opt-application` | 1.1, 1.6 | ⚠️ same tag as pre-completion |
| (c)(3)(i)(C) | F-1 **24-month STEM OPT extension** | `stem-opt-extension` · `stem-opt` · `opt-extension` | 1.6, 1.10, 1.6 | ❌ **three tags, one concept** |
| (c)(3)(ii) | F-1 intl-organization internship | `F-1` | 1.1 | ❌ no tag |
| (c)(3)(iii) | F-1 severe economic hardship | `F-1` | 1.1 | ❌ no tag |
| (c)(4) | G-1/G-3/G-4 dependent | `G-1`…`G-4` | 1.1 | ⚠️ status only |
| (c)(5) | **J-2** spouse/child of exchange visitor | `J-2` | 1.1 | ✅ |
| (c)(6) | M-1 post-completion practical training | `M-1` | 1.1 | ⚠️ no PT action tag |
| (c)(7) | NATO-1…NATO-7 dependent | — | — | ❌ **no NATO tags at all** |
| (c)(8) | **Asylum applicant** (150-day clock / rec. approval) | `asylum` | 1.10 | ⚠️ conflated with grantee — see §5 |
| (c)(9) | **Pending I-485 adjustment** | `adjustment-of-status`, `AOS`, `i485-filing`, `aos-filing` | 1.2, 1.3, 1.6 | ✅ (over-supplied) |
| (c)(10) | Suspension / cancellation of removal, NACARA | `cancellation-of-removal` | 1.10 | ⚠️ NACARA unrepresented |
| (c)(11) | Parole — humanitarian / significant public benefit | `humanitarian-parole` | 1.10 | ✅ |
| (c)(12) | E-2 CNMI investor spouse | — | — | ❌ no CNMI tags |
| (c)(14) | **Deferred action** (economic necessity) | — | — | ❌ no generic deferred-action tag |
| (c)(16) | Registry — record of lawful admission (part 249) | — | — | ❌ no tag |
| (c)(17) | B-1 domestic servant / foreign airline employee | `B-1` | 1.1 | ⚠️ sub-case unrepresented |
| (c)(18) | Final order, released on order of supervision | — | — | ❌ no tag |
| (c)(19) | **TPS applicant** | `TPS` | 1.3 | ✅ |
| (c)(20) | § 210 legalization applicant | — | — | ❌ no tag |
| (c)(21) | S-5/S-6 witness or informant | `S-5`, `S-6` | 1.1 | ✅ |
| (c)(22) | § 245A legalization applicant | — | — | ❌ no tag |
| (c)(24) | LIFE Act § 1104 adjustment applicant | — | — | ❌ no tag |
| (c)(25) | T-2…T-6 derivative family | `T-2`…`T-6` | 1.1 | ✅ |
| (c)(26) | **H-4 spouse of H-1B** | `H-4` + `h4-ead` · `h4-work-auth` | 1.1, 1.6 | ⚠️ **two tags, one concept** |
| (c)(33) | **DACA** | `DACA` | 1.3 | ✅ |
| (c)(34) | Spouse of entrepreneur parolee (IE) | — | — | ❌ no tag |
| (c)(35) | EB-1/2/3 principal, compelling circumstances | `EB-1`, `EB-2`, `EB-3` | 1.2 | ⚠️ no "compelling circumstances" tag |
| (c)(36) | Spouse/child of a (c)(35) principal | — | — | ❌ no tag |
| (c)(40) | T applicant with bona fide application | `T-1` | 1.1 | ⚠️ pending vs granted conflated |

## 3. Paragraph (a) — authorized by status, but still file for the card

These people are already allowed to work; the I-765 gets them the physical
document. They have a real filing timeline, so an EAD group is meaningful.

| I-765 code | Who | Our tag(s) | Verdict |
|---|---|---|---|
| (a)(3) | **Refugee** | `refugee` (1.10) | ✅ |
| (a)(4) | Paroled as a refugee | `refugee` + `humanitarian-parole` | ⚠️ composite |
| (a)(5) | **Asylee (granted)** | `asylum` (1.10) | ⚠️ same tag as (c)(8) applicant |
| (a)(6) | K-1 fiancé(e) / **K-2** child | `K-1` | ❌ **K-2 missing from 1.1** |
| (a)(7) | N-8 / N-9 | — | ❌ no tag |
| (a)(8) | Compact of Free Association (FSM/RMI/Palau) | — | ❌ no tag |
| (a)(9) | K-3 / K-4 | `K-3`, `K-4` | ✅ |
| (a)(10) | Withholding of deportation/removal granted | — | ❌ no tag |
| (a)(12) | **TPS granted** | `TPS` (1.3) | ⚠️ same tag as (c)(19) applicant |
| (a)(15) | V-1 / V-2 / V-3 | `V-1`, `V-2`, `V-3` | ✅ |
| (a)(16) | T-1 trafficking victim | `T-1` | ✅ |
| (a)(19) | U-1 crime victim | `U-1` | ✅ |
| (a)(20) | U-2 / U-3 / **U-4 / U-5** derivatives | `U-2`, `U-3` | ❌ **U-4, U-5 missing from 1.1** |

---

## 4. Gaps — categories with NO matching tag

Requested explicitly. Fifteen EAD-eligible classes have nothing in our
vocabulary. Grouped by how much they matter to this product:

**Likely to appear in real user posts — worth adding**

| Missing | Code | Why it matters |
|---|---|---|
| Generic **deferred action** | (c)(14) | Distinct from DACA; recurring in forums |
| **Withholding of removal** granted | (a)(10) | Common humanitarian outcome |
| **K-2** (child of K-1) | (a)(6) | A plain hole in 1.1 — K-1/K-3/K-4 are all present |
| **U-4 / U-5** derivatives | (a)(20) | Same hole; U-1/U-2/U-3 are present |
| **Compelling-circumstances EAD** | (c)(35)/(c)(36) | Rising topic for backlogged EB-1/2/3 Indian nationals |
| F-1 **severe economic hardship** | (c)(3)(iii) | Real F-1 sub-case with its own evidence burden |

**Rare in this product's population — record, don't necessarily add**

| Missing | Code |
|---|---|
| NATO-1…NATO-7 dependents | (c)(7) |
| CNMI E-2 investor spouse | (c)(12) |
| Registry / part 249 | (c)(16) |
| Order of supervision | (c)(18) |
| § 210 and § 245A legalization | (c)(20), (c)(22) |
| LIFE Act § 1104 | (c)(24) |
| Entrepreneur-parolee spouse | (c)(34) |
| N-8 / N-9 | (a)(7) |
| Compact of Free Association | (a)(8) |
| F-1 intl-organization internship | (c)(3)(ii) |

---

## 5. Conflicts and redundancy — the call-outs

### 5.1 `stem-opt-extension` is an ACTION tag, not a status — and the brief assumes otherwise

This is the important one, and it's exactly the check the request asked for.

The proposed second dropdown is described as *"the categories the candidate
must be in to be eligible to apply for EAD"*. Strictly, that is a **status**
(F-1, H-4, J-2, TPS, asylum applicant, …). But `stem-opt-extension` lives in
**1.6-visa-form-actions.csv** — it describes *the thing being filed*, not the
status the filer holds. The status underlying (c)(3)(i)(C) is **F-1**.

So listing it as a "category" is a category error *if* the dropdown is a list
of statuses. Two ways out:

- **(A) Dropdown = I-765 eligibility category** — "(c)(3)(C) F-1 STEM OPT
  extension", "(c)(9) Pending I-485", "(c)(26) H-4 spouse". `stem-opt-extension`
  becomes a legitimate entry because a (c)-code *is* status + basis fused
  together, which is precisely what the EAD card prints. **Recommended.**
- **(B) Dropdown = raw status** — F-1, H-4, J-2… Then STEM OPT is not an option
  at all, and picking "F-1" can't distinguish a STEM-OPT cohort from an initial
  OPT cohort. This loses the grouping the product exists for.

Option A also resolves the naming question cleanly: an EAD group is
`EAD-<eligibility-category>-<cycle>-<year>`.

### 5.2 Three tags for one STEM-OPT concept

| Tag | File | Description |
|---|---|---|
| `stem-opt-extension` | 1.6 | "STEM 24-month OPT extension application" |
| `opt-extension` | 1.6 | "Extension of OPT (**typically STEM 24-month extension**)" |
| `stem-opt` | 1.10 | "STEM Optional Practical Training (**24-month extension**)" |

All three mean (c)(3)(i)(C). A post could be tagged any of the three, so an
exact-match Timeline group keyed on one of them silently misses the other two.
**Recommendation:** keep `stem-opt-extension` (most precise, already the
template key), retire `stem-opt`, and narrow `opt-extension`'s description to
non-STEM extensions or retire it too. This mirrors the `i765-*`, `AOS` and
`COE` retirements already done in this repo.

### 5.3 `h4-ead` vs `h4-work-auth`

Both 1.6, both mean (c)(26). Same duplicate-tagging problem. Keep `h4-ead`.

### 5.4 `asylum` and `TPS` each conflate *applicant* with *grantee*

- `asylum` covers both (c)(8) *pending applicant, 150-day clock* and (a)(5)
  *granted asylee*. Completely different timelines — the whole point of an EAD
  group.
- `TPS` likewise covers (c)(19) applicant and (a)(12) grantee.

These need a pending/granted distinction before either can anchor a Timeline
group. Not blocking the EAD change, but it caps how useful those cohorts are.

### 5.5 `l2-ead` is probably obsolete

`l2-ead` (1.6) describes an EAD for L-2 spouses. Since the 2021 *Shergill*
settlement and the resulting USCIS policy, **L-2 spouses are employment-
authorized incident to status** (the `L-2S` code in our own 1.1 reflects this)
and no longer need an EAD. The tag should be marked historical rather than
offered as a current EAD category. The same applies to E-1/E-2 spouses (`E-2S`
is not in our 1.1 at all).

### 5.6 `(c)(9)` is over-supplied

`adjustment-of-status` (1.2), `AOS` (1.3), `adjustment-of-status-AOS` (1.3
alt), `i485-filing` and `aos-filing` (1.6) all point at the same cohort. Not a
new problem and partly already addressed by the AOS retirement, but if
(c)(9) becomes a dropdown entry it needs **one** canonical tag.

---

## 6. What the dropdown should contain

Applying §5.1 option A, and keeping only categories where we have a usable tag
*and* a plausible user population, the EAD eligibility dropdown should offer:

| Label | Code | Backing tag |
|---|---|---|
| F-1 STEM OPT extension (24-month) | (c)(3)(C) | `stem-opt-extension` |
| F-1 post-completion OPT | (c)(3)(B) | `opt-application` |
| Pending adjustment of status (I-485) | (c)(9) | `adjustment-of-status` |
| H-4 spouse of H-1B | (c)(26) | `h4-ead` |
| J-2 spouse of exchange visitor | (c)(5) | `J-2` |
| Asylum applicant | (c)(8) | `asylum` |
| TPS | (c)(19)/(a)(12) | `TPS` |
| DACA | (c)(33) | `DACA` |
| Refugee / asylee | (a)(3)/(a)(5) | `refugee` |
| Parole (humanitarian) | (c)(11) | `humanitarian-parole` |

Ten entries, each with exactly one backing tag that already exists. Everything
else in §2/§3 is either a (b) class that never files, or a §4 gap.

**Only `stem-opt-extension` gets the Cycle/Year fields** — Fall/Spring cohorts
are a STEM-OPT-specific idea (they track the academic calendar). The other nine
have no cycle, so those dropdowns stay hidden, which is exactly the behaviour
the request asks for.

---

## 7. Recommended sequencing

1. **Now, with the UI change** — add the ten-entry eligibility list; hide
   Cycle/Year unless `stem-opt-extension`; name groups
   `EAD-<category>-<cycle>-<year>`.
2. **Next, cheap** — retire `stem-opt` and `h4-work-auth` as duplicates (§5.2,
   §5.3); mark `l2-ead` historical (§5.5).
3. **Then** — add the six "likely" gap tags from §4.
4. **Later, needs thought** — split applicant/grantee for `asylum` and `TPS`
   (§5.4), and pick one canonical (c)(9) tag (§5.6).

Steps 2–4 are **not** in the current change; they are recorded here so the
duplicates don't get baked into the new dropdown.
