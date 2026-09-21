# Apify Third-Party Scraper — Legal Assessment & Integration Steps

**Status**: EVALUATION — legal section is informational research, not legal
advice (see disclaimer below). No code built yet.
**Scope assumed**: 2-3 named subreddits, top 3 comments per post by upvote
count only — per [`REDDIT-INGESTION-ALTERNATIVES.md §7`](REDDIT-INGESTION-ALTERNATIVES.md#7-re-evaluation--narrowed-pilot-scope-2026-07-22).
**Last updated**: 2026-07-24 — see §2.4 for the most recent findings (Apify
not currently named in Reddit's litigation, but the specific
`prodiger/reddit-scraper` actor admits the ToS violation and uses an
IP-evasion technique), and §2.5 for empirical confirmation that Reddit's
blocking is a bot-detection problem, not just an IP-reputation one.

> **⚠️ Not legal advice.** The author of this document is a developer, not a
> lawyer, and this repo has no in-house legal team. Everything in the "Legal
> landscape" section below is research summarizing public court rulings and
> published terms — it is not a substitute for a licensed attorney reviewing
> your specific facts. Given the current litigation climate (see §2.3), **do
> not launch this in production without at least one paid consultation with
> an actual attorney** before relying on this path. A single focused
> tech/IP-attorney session (scoped narrowly to "is scraping Reddit via a
> third party legally sound for our specific use case") typically runs
> **$200–500** through a marketplace like Priori Legal, UpCounsel, or a local
> solo tech-law practitioner — cheap relative to the risk being evaluated.

## 1. What Apify's own terms say

Apify's General Terms and Actor Terms are unambiguous: **Apify accepts no
legal risk for what you scrape, and pushes all of it onto you.**

- **Full liability on the user**: *"If you use the Services or extract
  Customer Data from unauthorized sources, you shall be fully liable for
  such activities and solely responsible for compensating any damages
  incurred by and/or any claims of the affected third parties, and Apify
  shall not be liable for any breach of third-party rights (e.g. breach of
  intellectual property rights, ... breach of terms of websites or
  applications and programs of third parties)."*
- **You indemnify Apify**, not the other way around: *"You agree to
  indemnify, defend and hold Apify ... harmless from any third-party claim,
  liability, loss, and expense ... arising out of (i) your use of the
  Website or Services in breach of the Agreement; and (ii) your publication
  or use of any Actors..."*
- Apify disclaims essentially all consequential damages for its own service
  failures too.

**Implication**: using Apify does not transfer or share legal risk — it is a
pure infrastructure/tooling relationship. If Reddit ever pursued a claim
related to scraped content, Apify is contractually positioned to point
entirely at us (and we'd be on the hook for their legal costs too, per the
indemnification clause, if Apify itself got named).

**Free tier vs. paid — no difference to this analysis.** Apify's Terms &
Conditions don't distinguish by billing tier; the liability-on-user /
indemnify-Apify structure above applies identically whether the account is
on the free tier or a paid plan. The only thing billing tier actually
changes is *Apify's* liability *to us* if their own infrastructure fails —
capped at the amount paid to Apify in the prior 12 months, so effectively
near-$0 on the free tier (plus a small statutory floor, ~$1,000, per their
general terms). That's irrelevant to whether ingesting Reddit content is
legal; it only matters if Apify's service itself fails and we wanted
damages from *them*.

## 2. Legal landscape (case law, informational)

### 2.1 CFAA is likely not the risk — hiQ Labs v. LinkedIn (9th Cir.)

The Ninth Circuit held that scraping **publicly accessible pages that don't
require login** does not violate the Computer Fraud and Abuse Act's
"without authorization" clause — CFAA is a federal *criminal* computer-fraud
statute, and courts have read it narrowly for public data. This matters:
**the most severe legal exposure category (federal computer-crime liability)
is unlikely to apply** to scraping Reddit's logged-out public pages.

**But this is not a green light.** hiQ's case didn't end there — after six
years of litigation, LinkedIn and hiQ settled in December 2022 with a
**$500,000 judgment against hiQ** on **California state-law claims**:
trespass to chattels and misappropriation, plus an injunction barring hiQ
from scraping LinkedIn again. The district court's own framing: hiQ wasn't
barred *by law* generally, but *by contract* (LinkedIn's Terms) and state
tort law specifically. **CFAA risk being low doesn't mean scraping risk is
low overall** — it shifts the exposure to contract/tort claims instead.

### 2.2 A favorable data point — Meta Platforms, Inc. v. Bright Data Ltd. (N.D. Cal., 2024)

Judge Chen granted Bright Data summary judgment on Meta's breach-of-contract
claim. The key reasoning: Bright Data scraped Facebook/Instagram **while
logged out** — not as an authenticated "user" who had clicked through and
agreed to Meta's Terms of Service. The court held Meta's ToS, as a
*contract*, **could not bind a party who never became a "user" bound by
it**. Meta dropped the case a month later.

**Relevance**: if Apify's Reddit scrapers likewise operate logged-out /
unauthenticated against public pages (not posing as a logged-in account),
there's a real, recent, on-point precedent that Reddit's User Agreement
(a contract) may not reach that activity at all — undercutting the
breach-of-contract theory specifically.

**Caveats**: this is **one district court ruling** (not binding outside
N.D. Cal., and not even binding on other judges within it), it's
fact-specific to Bright Data's exact operating model, and it says nothing
about copyright, DMCA anti-circumvention, or other claim types Reddit could
bring instead.

### 2.3 The risk that actually matters right now — Reddit's active 2025-2026 litigation campaign

This is the single most important fact for a risk assessment today: **Reddit
is currently, actively suing exactly this fact pattern.**

- **June 2025**: Reddit sued **Anthropic**, alleging unauthorized scraping of
  Reddit data to train Claude.
- **October 2025**: Reddit sued **Perplexity**, plus three scraping/proxy
  infrastructure companies — **SerpApi, Oxylabs, and AWM Proxy** — alleging
  "industrial-scale" scraping (reportedly ~3 billion pages accessed in a
  two-week window in July 2025) and specifically **circumventing anti-scraping
  protections** to feed content into an AI product.
- Both defendants are contesting the claims (Perplexity called it
  "extortion"; SerpApi says it will defend in court) — outcomes are not yet
  decided as of this writing.

**Why this matters more than the case law above**: Reddit's current legal
posture is aggressive *specifically* against the pattern of "third-party
scraper feeds Reddit content into an AI-powered product" — which is
structurally the same shape as this project's use case, just at a vastly
smaller scale (2-3 subreddits, top-3-comments vs. billions of pages). Small
scale plausibly lowers the *probability* Reddit ever notices or targets us,
but it does not change the *legal theory* they're currently litigating under
against others doing a version of the same thing.

**One factual distinction worth naming for legal counsel to weigh**: the
Perplexity suit specifically alleges *circumventing anti-scraping
protections* (bypassing blocks, not just reading public pages). If an Apify
integration here only reads unauthenticated public pages/JSON without
bypassing any CAPTCHA, IP-block, or rate-limit-evasion mechanism, that is a
materially different (and likely lower-risk) fact pattern than what Reddit
is currently litigating — closer to the Bright Data fact pattern (§2.2) than
the Perplexity one. This distinction should be a specific instruction to
whichever Apify actor is used, and a specific question to raise with counsel.
**Update (§2.4 below): the specific, commercially-available actor checked
does NOT meet this bar by default** — worth reading before assuming it does.

### 2.4 Fresh check (2026-07-23) — the actual Apify Reddit Scraper actor's own disclosures

Checked Reddit's active litigation for whether Apify is named, and read the
`prodiger/reddit-scraper` actor's own documentation directly (the specific
actor cited in §5 below). Two findings — one favorable, one that revises
§2.3's optimistic framing:

**Favorable: Apify is not currently named as a defendant.** Neither the June
2025 Anthropic suit nor the October 2025 Perplexity/SerpApi/Oxylabs/AWM
Proxy suit names Apify. The October suit's specific legal theory is **DMCA
anti-circumvention** for scraping Reddit content *via Google Search* at
industrial scale (~3 billion pages in two weeks) — a different technical
method than Apify's direct-to-Reddit approach. **Caveat**: "not currently
sued" is not "legally cleared" — litigation can expand, and this doesn't
change the underlying open legal question.

**Concerning: the actor's own docs admit the ToS violation, and use an
evasion technique.** Reading `prodiger/reddit-scraper`'s documentation
directly surfaced two things:
- A section titled "Is it legal to scrape Reddit?" states outright:
  *"Reddit's ToS restricts automated access, but ToS violations are a
  contractual matter, not a criminal one."* The vendor isn't unaware this
  violates Reddit's ToS — they're explicitly betting on it being civil, not
  criminal, exposure.
- **It uses rotating residential proxies specifically to evade Reddit's
  IP-based blocking of scrapers** — the docs state Reddit "aggressively
  blocks datacenter IP ranges," so the actor routes around that with
  residential IPs plus "reactive 429 backoff" retry logic.

**Why this matters**: IP rotation to defeat a platform's blocking mechanism
is a form of circumvention — conceptually closer to the theory Reddit is
currently litigating against Perplexity/SerpApi/Oxylabs/AWM Proxy (DMCA
anti-circumvention) than to the more favorable *Bright Data v. Meta*
fact pattern (§2.2, plain logged-out page reads, no evasion). **The
"only reads public pages without any evasion mechanism" instruction in the
paragraph above is not satisfied by this actor's default behavior** — it
would need to be explicitly configured differently (if possible) or a
different actor chosen, and that choice should be surfaced to counsel
specifically, not assumed away.

**Net effect on the overall assessment**: revises §4's recommendation to be
more cautious, not less — the paid-consult step there is even more
warranted now that we know the concrete tool involved both acknowledges the
ToS violation and actively evades platform-level blocking, not just reads
public pages passively.

### 2.5 Empirical confirmation (2026-07-24) — the blocking is real and not just about IP reputation

Built and tested a plain, non-evasive unauthenticated JSON export script
(`scripts/curation/reddit-export.py`) as a possible alternative to Apify —
no proxies, no browser-fingerprint spoofing, just a descriptive User-Agent
and stdlib HTTP. It returned `HTTP 403 Blocked` from **both** a sandboxed
cloud environment **and** a developer's own residential home connection.

This matters for the §2.4 assessment above: it confirms Reddit's blocking
of non-browser HTTP clients isn't simply IP-reputation filtering (which a
home connection would bypass) — it's consistent with TLS/HTTP
fingerprint-based bot detection that flags the *client*, not just the
*network origin*. That's the concrete, first-hand reason
`prodiger/reddit-scraper` needs residential-proxy-rotation infrastructure
rather than a plain connection — a single request from a single IP, even a
legitimate residential one, isn't sufficient to get past this. The
evasion techniques flagged in §2.4 aren't incidental engineering choices;
they're load-bearing for the actor to function at all. No attempt was made
to defeat this detection (fingerprint spoofing, header mimicry, proxy
use) — that would be the same circumvention risk category as the rest of
this section. See
[`REDDIT-INGESTION-ALTERNATIVES.md`'s 1-D update](REDDIT-INGESTION-ALTERNATIVES.md#1-d-public-json--rss-endpoints--confirmed-non-viable-in-practice-not-just-policy-2026-07-24)
for the companion finding.

## 3. Mitigating factors already in place

- **Paraphrase-only storage** (D-017, already implemented in
  `backend/posting.py`): summaries stored in the canonical schema are LLM
  paraphrases, not verbatim republication — reduces copyright/republication
  exposure regardless of collection method.
- **No author handle stored** — per the original pipeline spec
  ([`REDDIT-INGESTION-PIPELINE.md`](REDDIT-INGESTION-PIPELINE.md)), Reddit
  author handles are explicitly excluded from canonical JSON and search
  results.
- **Existing kill switch**: `posting.delete_content(case_id)` already exists
  in `backend/posting.py` — if Reddit (or counsel) ever asks for removal,
  there's a working, tested code path to pull content immediately, per
  document.
- **Small, bounded footprint**: 2-3 named subreddits, top-3-comments-by-upvote
  only — a small, defensible, easily-describable scope if ever questioned.

## 4. Practical recommendation

1. **Get the one paid legal consult before production use.** This is the
   single highest-leverage step available to a solo developer without
   in-house counsel — the cost is small relative to the risk category, and
   §2.3 shows this is a live, current enforcement priority for Reddit, not a
   theoretical one.
2. **Instruct the integration to never bypass anti-scraping protections** —
   logged-out, public-page-only, no CAPTCHA-solving, no IP-rotation-to-evade
   blocks. This keeps the fact pattern closer to Bright Data (favorable) than
   Perplexity (currently being sued). **Known gap (§2.4): the default
   `prodiger/reddit-scraper` actor does NOT meet this bar** — it uses
   rotating residential proxies specifically to evade Reddit's IP blocking.
   Either find/configure an actor that only reads public pages without
   evasion, or explicitly flag this trade-off to counsel rather than
   assuming the actor complies.
3. **Stage the rollout**: start at the smallest possible volume (a handful of
   posts to validate the pipeline end-to-end), monitor for any response from
   Reddit (blocks, cease-and-desist, changes to robots.txt/ToS), before
   scaling to the full 2-3-subreddit ongoing cadence.
4. **Re-file the official API ticket in parallel** (already in progress per
   `REDDIT-INGESTION-ALTERNATIVES.md §7.1`) — if it comes through, it
   moots this entire risk category for the fully-licensed path.

## 5. Integration steps (technical)

Assuming legal sign-off is obtained (§4.1):

1. **Pick an Apify actor.** `prodiger/reddit-scraper` ($1.15/1k posts, cheapest
   at this volume) or `trudax/reddit-scraper` are the two cited in
   `REDDIT-INGESTION-ALTERNATIVES.md §3-B`. **Already checked (§2.4):
   `prodiger/reddit-scraper` reads public pages logged-out, but also uses
   residential-proxy IP rotation to evade Reddit's anti-scraper blocking** —
   read whichever actor's documentation directly before selecting it (don't
   assume "public data only" marketing copy means "no evasion techniques");
   `trudax/reddit-scraper` hasn't been checked the same way yet.
2. **Create an Apify account**, add the actor, configure inputs: the 2-3
   target subreddits, sort mode (e.g. `top`/`hot`), and a low
   `postsPerSubreddit` cap matching pilot volume.
3. **Configure comment extraction to top-3-by-score only** — most Reddit
   scraper actors support a `maxComments`/`commentSort=top` input; verify the
   specific actor's parameter name and confirm it sorts by score (upvotes)
   before truncating to 3, not by recency.
4. **Map Apify's output schema to the canonical sidecar shape.** Apify
   returns raw post/comment JSON (title, body, score, permalink, subreddit,
   created timestamp, etc.) — this is *not* the canonical schema. Write a
   small transform step that:
   - Derives `case_id = reddit-<posting_date>-<subreddit>-<post_id>`
     (matches the deterministic dedup key from the original pipeline spec).
   - Sets `channel="reddit"`, `subreddit`, `reddit_post_id` = the real Reddit
     post ID (not a synthesized filename stem, unlike the manual-curation
     batch — see [`MANUAL-CURATION-PLAYBOOK.md`](MANUAL-CURATION-PLAYBOOK.md)),
     `full_url` = the real permalink.
   - Does **not** map any author/username field into the canonical JSON.
   - Feeds `title`+`body` (and up to 3 top comments) through the existing
     `posting._extract()`/tagging path (same Gemini call `posting.py` already
     uses for user-submitted content) to produce the paraphrased
     summary + controlled-vocab tags.
5. **Call the existing publish path** — either `posting.build_canonical()` +
   `posting.validate()` + `posting._write_gcs()` +
   `posting._import_to_datastore()` + `posting._write_bigquery()` directly
   (bypassing `publish_posting()`'s `profile.scrub_pii()`/
   `moderation.check_text()` calls, which are scoped to user-submitted
   content, not public Reddit posts — confirm this exemption with whoever
   reviews the legal/privacy angle, since Reddit posts can still contain
   pasted personal info from the author), or build a thin wrapper mirroring
   `publish_posting()`'s orchestration order.
6. **Run the Apify job on a schedule** (Apify has its own built-in scheduler,
   or trigger via Cloud Scheduler → Apify API) — start low-frequency (e.g.
   daily) given the small subreddit/comment scope; no need for the 10-15 min
   cadence from the original full-scale spec at this volume.
7. **Add dedup**: check `reddit_post_id` against BigQuery
   (`postings.postings_metadata`) before re-tagging/re-importing an
   already-seen post — avoids reprocessing cost and duplicate documents.
8. **Monitor cost and access**: track Apify usage against the free-tier
   credit; watch for any change in scraping success rate (a sudden drop
   could indicate Reddit has blocked the actor's IP range — treat this as a
   signal to pause and reassess, not just a bug to route around).
