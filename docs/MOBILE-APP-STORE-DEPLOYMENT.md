# Mobile deployment runbook — iOS App Store (`mobile/`)

Step-by-step for building, submitting, and releasing the **Meridian** iOS app
via **EAS (Expo Application Services)**, plus what's automated today and what
still needs a human. Companion to [`docs/DEPLOYMENT.md`](DEPLOYMENT.md) (backend
+ website) and [`docs/WEBSITE-DEPLOYMENT.md`](WEBSITE-DEPLOYMENT.md) — this is
the mobile equivalent.

> **Correcting the record:** [`docs/PROD-READINESS.md`](PROD-READINESS.md) §6 and
> [`docs/DEPLOYMENT.md`](DEPLOYMENT.md) §9 describe mobile as "never built" /
> "not deployed" / `eas.json (absent)`. That's stale. `mobile/eas.json` has existed
> since commit `e23cab7` and the app has already been through **two real App
> Store Review submissions** — see
> [`docs/business/app-review-1.2-ugc-response.md`](business/app-review-1.2-ugc-response.md)
> for the actual build 11 rejection (Guidelines 5.1.1(i)/5.1.2(i), 2.3.6, 1.2)
> and the build 12 fix. What's actually missing is **documentation and
> automation** of the release process itself — that's what this doc and the
> scripts/workflow below provide.

| Fact | Value |
|---|---|
| App name / slug | Meridian / `meridian` |
| iOS bundle ID | `com.krishmalik.meridian` |
| Expo/EAS project | `krishmalik/meridian`, `projectId` `32aefb08-a393-4fae-966e-865bfee02758` (`mobile/app.config.js:63-66`) |
| Current version | `1.1.0` (`mobile/app.config.js:6` and `mobile/package.json:3` — kept in sync, see [`docs/RELEASE-TAGGING.md`](RELEASE-TAGGING.md)) |
| Build number | managed **remotely by EAS** (`eas.json`'s `appVersionSource: "remote"` + `production.autoIncrement: true`) — don't hand-edit `ios.buildNumber` |
| Workflow type | **Managed / CNG** (Continuous Native Generation) — `mobile/ios/` is a disposable, gitignored `expo prebuild` artifact, never hand-edited, never committed |
| Config file | `mobile/app.config.js` (dynamic JS config, not `app.json`) |
| Source dir | `mobile/` |

---

## 0. How the pieces fit together

```
  mobile/app.config.js  ──expo prebuild (CNG)──▶  mobile/ios/ (gitignored, generated)
         │
         ▼
  mobile/eas.json  ──eas build──▶  EAS cloud build servers ──▶  signed .ipa
         │                                                          │
         │                                                     eas submit
         ▼                                                          ▼
  Expo/EAS account (projectId)                          App Store Connect → TestFlight
                                                                      │
                                                        (human) attach build to a
                                                        version, fill "What's New",
                                                        Submit for Review
                                                                      │
                                                                      ▼
                                                              Apple App Review
                                                                      │
                                                                      ▼
                                                              Public App Store release
```

Two things never touch git: the generated `mobile/ios/` native project, and
any signing secret (distribution cert, provisioning profile, App Store
Connect API key). EAS is the system of record for signing credentials —
that's what "managed workflow" buys you here.

---

## 1. Accounts — who owns which login, per site, and what to do without access

**Read this before §2 if you're not sure you have access to every account
below.** Four separate identities are involved, and it's easy to conflate
them — the single most important fact in this section is that **recovering
one does not recover the others.**

| # | System | What it is | What it's used for | Site |
|---|---|---|---|---|
| A | **Apple ID** | Apple's personal account system (2FA login) | Signs into App Store Connect and the Apple Developer portal, and any interactive `eas credentials`/`eas submit` Apple-login step | https://appleid.apple.com |
| B | **Apple Developer Program membership** | $99/yr paid enrollment tied to (A), or to an Organization Team | Grants App Store Connect access; lets you create/rotate certs, provisioning profiles, and API keys | https://developer.apple.com/account |
| C | **App Store Connect app record** | The actual "Meridian" listing, `com.krishmalik.meridian` | TestFlight builds, App Review submissions, store metadata | https://appstoreconnect.apple.com |
| D | **Expo/EAS account** | `krishmalik` on expo.dev — **entirely separate from Apple** | `eas build`/`eas submit` auth; caches Apple signing credentials so you don't re-enter them each time; owns the project's `projectId` | https://expo.dev — check with `npx eas-cli whoami` |

(A)/(B) are the same login; (C) is reached *through* (B)'s Team; (D) shares
nothing with any of them — no SSO, no linked recovery, nothing.

### Is it safe to try logging in / creating a new account?

Yes. **Attempting** any login or recovery flow below — checking whether an
account exists, submitting a password-reset form, contacting support — is
non-destructive. It doesn't change, delete, or lock anything on the existing
project. The only place risk enters is *after* a failed recovery, if you
decide to stand up a brand-new account instead — see the impact table below
before doing that.

### "Forgot password" won't help if the registered email isn't yours

Standard password reset assumes you control the account's recovery email. If
that email belongs to the previous developer, retrying "Forgot password"
just resends a link to an inbox you can't open. Plan around it instead:

**For (D) Expo/EAS — low-stakes to work around:**
1. Check whether your own email, or a Google/GitHub/Apple login you control,
   was ever added as a **second** sign-in method on the `krishmalik` account
   (Account Settings → Connections — only visible once logged in some other
   way). If so, use that login directly instead of a password.
2. If not: Expo has a manual account-recovery process for exactly this
   "the person who set this up left" situation. Contact Expo support
   (https://expo.dev, or help.expo.dev) and be ready to demonstrate you're a
   legitimate stakeholder — point them at this GitHub repo, the `projectId`
   in `mobile/app.config.js`, and commit history showing you maintain the app.
3. If that doesn't resolve in a reasonable time: **it's fine to create a new
   Expo account and move on.** This is genuinely low-risk — see the impact
   table below for exactly what that costs (not much).

**For (A)/(B)/(C) Apple — check carefully before assuming the worst:**
1. Apple's account recovery (iforgot.apple.com) is built for **the account
   owner** recovering **their own** forgotten password. It is *not* a
   mechanism for a third party to take over someone else's Apple ID — it
   will not help here if (A) is genuinely the previous developer's personal
   Apple ID and they can't be reached.
2. **Check first whether the Apple Developer Program membership (B) is an
   Organization enrollment, not an Individual one** — this is the detail
   that determines everything else. If anyone else (a cofounder, another
   company officer) already holds an **Account Holder** or **Admin** role on
   that Organization Team, they can invite *your own, separate* Apple ID as
   a new member directly — no password recovery of anyone's account
   required. Check this before assuming you're stuck.
3. If it's an **Individual** enrollment under the previous developer's own
   personal Apple ID, and there is truly no way to reach them: this is a
   **hard blocker with no reliable self-service fix.** Apple's formal
   recourse (business-entity Account Holder transfer) exists for
   Organization accounts, not Individual ones. Don't jump to "start over"
   until you've exhausted (1)–(2) above and confirmed — via App Store
   Connect → Users and Access, if you can see it at all, or by asking anyone
   who might already have a role — that genuinely no one else has access.

### Impact if you create a new account instead of recovering the old one

The two systems have **very different stakes.** Weigh this before deciding:

| If you create a new... | Impact |
|---|---|
| **Expo/EAS account (D) only** — Apple access (A/B/C) is fine, or separately resolved | **Low stakes.** Run `eas init` under the new account to create a new EAS project; update `owner` in `mobile/app.config.js` and `projectId` in `mobile/eas.json` to point at it. You lose old EAS build *history* (cosmetic) and redo `eas credentials` once (§2.3) — but because it re-attaches to the **same, existing** Apple Developer Team/bundle ID, the App Store Connect app record, any TestFlight testers, and the App Review history (build 11/12) are all preserved untouched. Clean, low-risk, fully reversible in spirit — the Expo account is just a build-orchestration login, not where anything of lasting value lives. |
| **Apple Developer Program enrollment (B)**, because (A)/(C) are confirmed truly unreachable | **High stakes — real loss of continuity.** A new enrollment cannot claim the existing `com.krishmalik.meridian` bundle ID (bundle IDs are globally unique across Apple, permanently bound to the Team that registered them) or the existing App Store Connect app record. You'd need: a **new bundle identifier**, a **new app record**, and a **fresh App Review submission from zero** (the "already survived App Review twice" history doesn't carry over, though the reviewer-notes content in `app-review-1.2-ugc-response.md` still helps you pass faster). You'd also need to **regenerate Firebase/Google Sign-In config** for the new bundle ID — `mobile/config/GoogleService-Info.plist` and the `iosUrlScheme`/URL-scheme entries in `app.config.js` are keyed to the current bundle ID and won't work unchanged. Any existing TestFlight testers or App Store presence under the old app record is orphaned. **Exhaust every option in the previous subsection first.** |

**Bottom line:** don't let Expo/EAS login trouble hold up progress — it's
low-risk to route around. Treat Apple Developer Program / App Store Connect
access as the one to protect and investigate carefully; a from-scratch Apple
enrollment is the only genuinely costly outcome described in this doc.

### Once you've been invited — confirm exactly what you can and can't do

A worked example from actually doing this: getting invited to App Store
Connect is not one uniform level of access — it's worth confirming precisely
what you got before assuming it unblocks everything.

**Where to check:** App Store Connect → **Users and Access** → **People**
tab, while inside the correct team context (§1's team-switching note
applies here too). The list shows every person with access to that team, an
**Apple Account** (their sign-in email), a **Name**, a **Role**, and which
**Apps** they can see. In a real check of this project's team, the table
showed exactly two rows: the invited developer's own account (role:
**Admin**, all apps), and the original developer's account (role:
**Account Holder, Admin**, all apps) — i.e. `Account Holder` is not a role
you'd ever expect to see on your own row; only the person who originally
enrolled has it, appearing *alongside* Admin on their own row, never on
anyone else's.

**What "Admin" (or App Manager) as an invited user *does* unblock,
immediately:** per Apple's own permissions table, both roles can generate
App Store Connect API keys, upload builds, submit apps for review, and
manage TestFlight — the entire App Store Connect side of the release
pipeline. **Do this the moment you confirm either role** — it's independent
of anything else in this doc and doesn't need to wait on a resolved build
path:
1. **Users and Access** → **Integrations** tab → **App Store Connect API**
   → **Generate API Key** (role **App Manager** is enough for the key
   itself, regardless of your own role).
2. Download the `.p8` immediately (one-time download) and note the **Key
   ID** and **Issuer ID**.
3. Store all three in a shared password manager/secrets vault — never
   plaintext chat/email, never git. This is exactly what §2.3 and
   `mobile-deploy.yml` need for non-interactive submits, and it keeps
   working independent of anyone's login session (sidesteps the kind of
   team-context error described earlier in this section).

**What "Admin" as an invited user does *not* unblock, no matter how high the
role:** the Apple Developer **Portal** (Certificates, Identifiers &
Profiles) — confirmed directly from Apple's own docs, worth restating
plainly because it's easy to assume otherwise: *"If you're enrolled as an
individual and add users in App Store Connect, users receive access only to
your content in App Store Connect and are not considered part of your team
in the Apple Developer Program."* This holds **regardless of role** — an
invited Admin is not exempted. Only the `Account Holder` row ever has it.

**The corollary that matters most for building:** this is why a brand-new
Expo/EAS account (the "low stakes" option in the table above) does **not**
actually unblock producing a new build by itself, even once you have full
App Store Connect Admin access. The very first `eas credentials --platform
ios` run under any Expo account needs Developer Portal sign-in to create a
distribution certificate and provisioning profile — and that page stays
Account-Holder-only on an Individual account, full stop. A new Expo account
only "just works" if it's paired with **already-cached** iOS credentials
(i.e. you recovered the *original* Expo/EAS account, which likely has them
from prior submissions) — not with ASC access of any kind, however senior.

**A smaller ask than full account recovery, if reachable only briefly:**
instead of asking the Account Holder to log into a new Expo account (still
needs their 2FA, plus trusting a new relationship), ask them to **export
the existing iOS distribution certificate (`.p12`, with its password) and
provisioning profile (`.mobileprovision`) directly from the Developer
Portal / their Mac's Keychain**, and hand over just those two files. A new
Expo project can then build using **local credentials**
(`eas.json`'s `credentialsSource: "local"`, pointing at those files)
instead of EAS-managed ones — no interactive Expo login from them at all.
Caveat: this only works if the private key material was actually exported/
saved somewhere at creation time — if not, the cert can't be extracted
after the fact, only revoked and recreated, which needs Developer Portal
access again regardless.

### Doing this the right way — avoid a repeat single point of failure

This whole section exists because exactly one person had App Store Connect
access. Once the Account Holder is reachable, have them do the following —
it takes about 10 minutes and prevents this from happening again:

**1. Invite every developer who needs access — at least two people, not one.**
In App Store Connect, in the **Meridian** team context → **Users and
Access** → **+** (add user) → their Apple ID email → role **App Manager**
(sufficient — Apple's own permissions table shows App Manager can generate
API keys, upload builds, submit for review, and manage TestFlight; a lesser
role like "Developer" or "Marketing" can't). If prompted to scope by app,
check **Meridian** explicitly. **Each invitee must click Accept in the
email** — an unaccepted invite can look like access was granted while
functionally not working yet (plausibly what caused the "something went
wrong" error earlier in this doc's history). Inviting only one replacement
just moves the single point of failure to a new person — invite at least two.

**2. Generate an App Store Connect API key and store it in a team-shared
vault — this is the most durable fix, and needed for CI anyway.** Mechanics
are already documented in §2.3 above — the only difference here is *who*
should end up with a copy: put the `.p8` + Key ID + Issuer ID in a shared
password manager / secrets vault the whole team can reach, not in one
person's inbox. An API key authenticates independent of anyone's login
session or 2FA device, so it isn't exposed to the kind of session/team-
context error described in this section, and it's exactly what
`mobile-deploy.yml` needs for non-interactive CI builds/submits (§3.2).

**3. Understand the hard limit of an Individual account — steps 1–2 don't
fully remove it.** App Store Connect access is *not* the same as full Apple
Developer Portal access (Certificates, Identifiers & Profiles). On an
**Individual** membership, Apple only ever grants Developer Portal access to
the one person who enrolled — it cannot be delegated to invited App Store
Connect users, regardless of role. Steps 1–2 keep day-to-day builds,
submits, and App Review fully unblocked for multiple people; they do **not**
help if the signing certificate/provisioning profile ever needs regenerating
(expiry, revocation, a new capability) — that specifically still needs the
original Account Holder, personally, no matter how many people are invited
elsewhere.

**4. The only complete fix: a separate Organization Apple Developer Program
enrollment.** Organization accounts support multiple people with full Admin
role (Developer Portal included) and a real Account Holder transfer process
if someone leaves — Individual accounts support neither, ever. Full
step-by-step details (confirmed against Apple's own documentation, sources
at the bottom) are in the "Organization enrollment + migration" subsection
immediately below. Short version: App Transfer **does** preserve the bundle ID, App Store
listing, and ratings/reviews (better than earlier drafts of this doc
guessed) — but it still requires the *current* Account Holder to personally
initiate it, so it doesn't solve "the person is unavailable" by itself, only
shrinks that dependency to one minimal, well-defined action. Treat this as a
multi-week undertaking to start now in parallel, not something to wait on
before making progress elsewhere.

### Organization enrollment + migration — detailed steps

#### Step 0 — the gate to check first: is there a registered legal entity?

Organization enrollment requires a **D-U-N-S Number tied to an actual
registered legal entity** (LLC, corporation, limited partnership, etc.) —
sole proprietors and unregistered personal projects **cannot** get a D-U-N-S
Number and can't enroll as an Organization at all. Nothing in this repo
(`docs/business/`, or any top-level doc) documents a registered legal entity
— everything points to this being a personal project under "Krish Malik"
individually today. Confirm whether an LLC/corporation already exists behind
Meridian before starting — if not, forming one is a state-level business
registration step, entirely outside Apple's process, with its own
cost/timeline, and would need to happen first.

#### Step 1 — Organization enrollment (once the legal entity exists)

1. **D-U-N-S Number** — look up whether the entity already has one via
   Apple's D-U-N-S lookup tool (legal entity name + HQ address + mailing
   address). If not found, request one for free — allow **up to 5 business
   days** from Dun & Bradstreet, then **up to 2 more business days** for
   Apple to receive it. Budget **~1–2 weeks** total before enrollment can
   even start.
2. **Enroll** at Apple's Developer Program enrollment page (organization
   enrollment is **web-only**, not in the mobile app). Enter the legal
   entity name and D-U-N-S Number.
3. **Confirm legal binding authority** — the enrolling person must be the
   owner/founder, an executive, or someone with documented authority to bind
   the org to Apple's agreements. If not the owner, Apple requires a
   reference contact who can confirm that authority.
4. **Verification** — Apple checks the D-U-N-S Number and binding authority;
   may request notarized business documents.
5. **Contact requirements** — a work email on the organization's own domain
   (not a personal address), and a live, functional website tied to that
   domain (a placeholder page doesn't count) — `meridianjourney.ai` should
   satisfy this.
6. **Pay $99/year** — the **standard** Apple Developer Program (App Store
   distribution) costs the same $99/yr for Organizations as Individual.
   *(Don't confuse this with the separate $299/yr Apple Developer
   **Enterprise** Program — that's for internal-only enterprise
   distribution, not relevant here.)*
7. **Confirmation** — typically within 24 hours of payment; contact Apple
   support with the Enrollment ID if not received.

#### Step 2 — check app transfer eligibility *now*, independent of Step 1

App Transfer preserves the bundle ID (`com.krishmalik.meridian`), the App
Store listing, ratings/reviews, and App ID. But per Apple's own transfer
criteria, the app **must have at least one version actually released to the
App Store**, and specifically **cannot** currently be in any of: Processing
for Distribution, Waiting for Review, In Review, Accepted, **Pending
Developer Release**, or Pending Apple Release.

If the app is sitting at **"Ready for Distribution"** (approved but not yet
manually released to the public App Store — the status seen while writing
this), **it is not transfer-eligible right now**, regardless of who's
available. The fix doesn't need the absent developer: anyone with App
Manager/Admin access in App Store Connect can go to the app's version page
and click **"Release This Version."** Once it shows as released/live, it
becomes transfer-eligible. Worth doing regardless of whether Organization
migration happens — an approved build sitting unreleased helps no one.

**"Ready for Distribution" is ambiguous by itself — verify with an
unambiguous check.** The label alone doesn't tell you whether a manual
release is still pending or already happened (App Store Connect's History
tab for that version shows the full timeline of status changes, which
disambiguates it precisely). The one check that's unambiguous regardless of
what the label says: does `https://apps.apple.com/app/id<numeric-app-id>`
(the app's numeric ID is visible in its App Store Connect URL) actually
resolve to a public listing? If yes, that version is genuinely live.

#### Step 3 — pre-transfer cleanup (a real project, not a formality)

Before initiating, the transferring side needs to:
- Generate an app-specific shared secret (if any subscriptions exist).
- **Remove all TestFlight builds and testers** — this data does **not**
  survive transfer and must be cleared beforehand (and rebuilt from scratch
  after).
- Remove all Xcode Cloud data and webhooks (if any).
- Document any Game Center / Apple Pay / Sign in with Apple configuration
  (needs manual reconfiguration after transfer).
- Check that no in-app purchase product IDs collide with anything already
  in the receiving Organization account.

#### Step 4 — the transfer itself (the one step that unavoidably needs the absent developer)

Confirmed directly from Apple's docs: **only the Account Holder can
initiate a transfer, and only the Account Holder of the receiving account
can accept it.** No delegation, no App Manager/Admin substitute — this is
the one action in the whole plan that cannot be routed around.
1. The current Account Holder (once reachable) initiates the transfer from
   the Individual account, targeting the new Organization account.
2. The Organization account's Account Holder accepts it within **60 days**.

#### Step 5 — what still needs redoing after transfer, regardless

Certificates and provisioning profiles must be **recreated fresh** under
the new Team ID (the old EAS-cached ones from the Individual account won't
carry over) — this is §2.2/§2.3 again, just under the new account. If push
notifications are ever added later, APNs certs would need regenerating too
(not relevant today — this app has none).

**Bottom line:** Steps 0–3 don't need the absent developer at all and can
start immediately in parallel; only Step 4 does. This is a multi-week
undertaking (legal entity → D-U-N-S → enrollment → release the pending
build → cleanup → transfer), but it shrinks the dependency on the absent
developer to one minimal, well-defined action instead of blocking
everything.

Sources: [App transfer criteria](https://developer.apple.com/help/app-store-connect/transfer-an-app/app-transfer-criteria) ·
[Overview of app transfer](https://developer.apple.com/help/app-store-connect/transfer-an-app/overview-of-app-transfer) ·
[Program enrollment](https://developer.apple.com/help/account/membership/program-enrollment/) ·
[D-U-N-S Number](https://developer.apple.com/help/account/membership/D-U-N-S)

---

## 2. One-time setup (do this once per Apple/EAS account, not per release)

### 2.1 Confirm access

- [ ] **Apple Developer Program** ($99/yr) + App Store Connect app record —
  should already exist (proven by the build 11/12 submissions). If you can't
  reach it, see §1.
- [ ] **Expo/EAS account** (`krishmalik`, or your own new one per §1) —
  confirm with `npx eas-cli whoami`.
- [ ] **Local EAS CLI login**, once per machine that will run releases by hand:
  ```bash
  cd mobile
  npx eas-cli login          # or: npm run login  (added below)
  npx eas-cli whoami         # confirms you're authenticated
  ```

### 2.2 iOS signing credentials (distribution cert + provisioning profile)

This project uses **EAS-managed ("remote") credentials** — the default when
no `credentialsSource` is set. EAS generates and stores the distribution
certificate and provisioning profile on its servers and reuses them for every
build. You only interact with this once:

```bash
cd mobile
npx eas-cli credentials --platform ios
```

- First run: choose the `production` build profile → **"Let EAS handle the
  process"** → sign in with the Apple ID that owns the Developer Program
  membership (Apple 2FA required, interactive — this step **cannot** be
  scripted/run in CI, it's a one-time human action).
- EAS then creates/reuses the distribution certificate (account-level, one
  per Apple account) and an app-specific provisioning profile, and stores
  both remotely. Every subsequent `eas build` (local or CI) reuses them
  automatically — **no further interaction needed** until the provisioning
  profile expires (~12 months) or the bundle ID changes, at which point
  `eas build` prompts to regenerate it (still no manual Xcode/Apple Developer
  portal work required).
- Verify what's stored: `npx eas-cli credentials --platform ios` → **View**.

### 2.3 App Store Connect API Key (for non-interactive `eas submit`)

`eas submit` needs a way to authenticate to App Store Connect without a human
typing an Apple ID + 2FA code each time. The supported non-interactive path
is an **App Store Connect API Key**:

1. App Store Connect → **Users and Access** → **Integrations** → **App Store
   Connect API** → **Generate API Key** (role: **App Manager** is sufficient;
   avoid **Admin** unless you need it for other reasons).
2. Download the `.p8` key file **once** — Apple only lets you download it
   once, so store it safely immediately (password manager / secrets vault).
   Note the **Key ID** and **Issuer ID** shown next to it.
3. Two ways to make EAS use it — pick one:
   - **Interactive, cached remotely (simplest for solo/local use):**
     ```bash
     npx eas-cli credentials --platform ios
     ```
     → select **App Store Connect: Manage your API Key** → **Set up your
     project to use an API Key for EAS Submit** → point it at the downloaded
     `.p8`. EAS stores it on its servers against this project; every future
     `eas submit` (local or CI, as long as you're authenticated as this EAS
     account/token) uses it with no further prompts.
   - **Explicit in `eas.json`** (needed if you want the path checked into
     `submit.production.ios`, or you're not using the EAS-remote-storage
     option): add
     ```json
     "submit": {
       "production": {
         "ios": {
           "appleId": "your-apple-id@example.com",
           "ascAppId": "<App Store Connect app's numeric Apple ID>",
           "appleTeamId": "<10-char Apple Developer Team ID>",
           "ascApiKeyPath": "./secrets/AuthKey_XXXXXXXXXX.p8",
           "ascApiKeyId": "XXXXXXXXXX",
           "ascApiKeyIssuerId": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
         }
       }
     }
     ```
     **Never commit the actual `.p8` file** — `mobile/.gitignore:14-18`
     already blocks `*.p8`/`*.p12`/`*.mobileprovision`/`*.key`, so a path
     under `mobile/secrets/` is safe from accidental commits, but the file
     itself only ever lives on your machine / as a CI secret (§3.2).
   - `mobile/eas.json`'s `submit.production` is currently `{}` (empty) — pick
     one of the two options above and fill it in before you rely on
     non-interactive submit. Until then, `eas submit` falls back to
     interactive prompts (fine for a one-off manual submit, not for CI).

Find `ascAppId` and `appleTeamId`: App Store Connect → your app → **App
Information** → **Apple ID** (that number is `ascAppId`); Apple Developer
account → **Membership** → **Team ID** (that's `appleTeamId`).

### 2.4 App-specific config that's already handled (don't redo it)

These are already correctly wired in `mobile/app.config.js` — documented here
so nobody "fixes" them by accident:

- **Sign in with Apple**: `ios.usesAppleSignIn: true` (`app.config.js:23`)
  auto-injects the `com.apple.developer.applesignin` entitlement on every
  `expo prebuild`. **Never hand-edit `mobile/ios/*/*.entitlements`** — it's
  regenerated from this config on every build (comment at `app.config.js:20-22`).
- **Google Sign-In**: `googleServicesFile` points at the tracked
  `mobile/config/GoogleService-Info.plist`, plus a matching URL scheme in
  `infoPlist.CFBundleURLTypes` and the `iosUrlScheme` plugin option
  (`app.config.js:24-32,55-59`). If Google ever regenerates that plist (e.g.
  a new Firebase iOS app), replace the file in place — the config already
  points at it.
- **Modular-headers build fix**: `mobile/plugins/withModularHeaders.js` is a
  local config plugin patching the generated `Podfile` so Google Sign-In's
  transitive pods (`GoogleUtilities`, `RecaptchaInterop`, `AppCheckCore`)
  build with `:modular_headers => true`, avoiding a Swift "ambiguous implicit
  access level for import of 'Expo'" error. It runs automatically on every
  `prebuild`/`eas build` — no action needed unless the build starts failing
  with that exact Swift error again (see §8 Troubleshooting).
- **No push notifications today** — `expo-notifications` isn't integrated
  (confirmed: no references anywhere in `mobile/src` or config), so **no
  APNs key/cert setup is needed** for this app in its current form. If push
  is added later, generate an APNs key the same way as the ASC API key
  (Apple Developer → Certificates, Identifiers & Profiles → Keys) and add it
  via `eas credentials`.

---

## 3. CI setup (for the automated GitHub Actions path — do this once)

If you want releases triggerable from GitHub Actions (recommended — see §5),
set these up once:

### 3.1 `EXPO_TOKEN` — required

1. https://expo.dev/accounts/krishmalik/settings/access-tokens → **Create
   token**. Prefer a **robot/bot user token** scoped to this project if your
   Expo plan supports it; a personal access token works too.
2. GitHub repo → **Settings → Secrets and variables → Actions** → **New
   repository secret** → name `EXPO_TOKEN`, paste the token.

With `EXPO_TOKEN` set, `eas build`/`eas submit --non-interactive` run without
any interactive login — CI authenticates as that token.

### 3.2 Apple submit credentials for CI — required only if you want `submit: true` runs

CI reuses whatever's already configured per §2.3 — if you did the
**"interactive, cached remotely"** option, CI needs nothing extra (the
`EXPO_TOKEN`-authenticated `eas submit` call fetches the stored API key from
EAS's servers automatically). If you instead want the `eas.json`-explicit
path, additionally store the `.p8` **contents** (base64-encoded) as a repo
secret and have the workflow write it to a temp file — see the commented
example in [`.github/workflows/mobile-deploy.yml`](../.github/workflows/mobile-deploy.yml).

### 3.3 Reviewer/approval gate — reuses existing setup

`mobile-deploy.yml` (§5) runs under the same `environment: production` gate
already configured for [`deploy.yml`](../.github/workflows/deploy.yml) (see
[`docs/CI-CD.md`](CI-CD.md#one-time-github-setup-needs-repo-admin)) — if that
required-reviewer rule is already set up for backend/website deploys, mobile
releases are gated the same way with **no extra GitHub setup**.

---

## 4. Everyday release flow (once §1–§2 are done)

This is the sequence for shipping a normal update. Steps marked **🤖** are
scripted (§5); everything else needs a human decision or Apple's own review.

1. **Bump the version** — 🤖 partially. Edit `version` in `mobile/app.config.js`
   **and** `mobile/package.json` together (keep them in sync); leave
   `ios.buildNumber` alone (EAS bumps it remotely). Full mechanics already
   documented — see [`docs/RELEASE-TAGGING.md` §"Mobile is a variant of the
   same flow"](RELEASE-TAGGING.md#mobile-is-a-variant-of-the-same-flow). Do
   this as part of the normal PR for the release.
2. **Merge the PR to `main`** — CI (`ci.yml`) already runs `npm test` on
   every push (Jest); this doesn't build/submit anything for mobile yet.
3. **Preflight** — 🤖 (`npm run test`, git-clean check — see §5.2/§5.3).
4. **Build** — 🤖 `eas build --platform ios --profile production`
   (§5.1/§5.2). Produces a signed `.ipa`, uploaded to EAS's servers. Takes
   ~15–25 min on Apple's/EAS's build queue; you get a build-details URL
   immediately and can walk away (`--no-wait`) or block until it finishes.
5. **Submit to App Store Connect** — 🤖 `eas submit --platform ios --profile
   production` (or `eas build --auto-submit`, one shot). This delivers the
   binary into **TestFlight processing** — it does **not** by itself put the
   app in front of Apple's App Review team.
6. **TestFlight internal testing** (human) — once the build finishes
   processing (~10–30 min, Apple-side), it's available to your internal
   TestFlight testers automatically. Install via the TestFlight app, smoke
   the release manually. This is the point to catch anything before burning
   an App Review cycle.
7. **Attach the build to an App Store version + submit for review** (human,
   App Store Connect UI) — App Store Connect → your app → **+ Version** (or
   the existing pending version) → select the new build → fill **What's New
   in This Version** → **Submit for Review**. *(This step has an official
   automation path too — the App Store Connect API / `eas metadata` — but
   it's not wired up here; see §5.4 and §7 for why it's left manual.)*
8. **Fill/confirm App Review reviewer info** (human, one-time-ish) — App
   Review Information → Notes + Sign-In Information. Reuse the exact,
   already-battle-tested reviewer notes template and demo-account setup in
   [`docs/business/app-review-1.2-ugc-response.md`](business/app-review-1.2-ugc-response.md)
   §1–§2 rather than writing new ones — that content already got a prior
   submission past Guideline 1.2 (UGC).
9. **Record the required screen-recording** (human, physical device) — Apple
   requires a real device, not the simulator, for UGC-flow proof. Script is
   already written: `app-review-1.2-ugc-response.md` §3.
10. **Apple App Review** (Apple, 1–3 days typically) — out of your control.
    If rejected, see §8 for the exact fixes already applied to two prior
    real rejections.
11. **Release** — once approved, either auto-releases or needs one more
    manual "Release this version" click in App Store Connect, depending on
    the release-type setting chosen in step 7.
12. **Tag the release** — once Apple accepts the build, tag the merged
    commit per [`docs/RELEASE-TAGGING.md`](RELEASE-TAGGING.md#mobile-is-a-variant-of-the-same-flow)
    (`mobile-vX.Y.Z`). Not automated — tagging is always an explicit human
    decision project-wide (same rule as backend/website).

---

## 5. Automation — what's scripted and how to run it

**Answering "can this be scripted?" directly: yes, for everything up through
delivering a binary into TestFlight.** EAS Build + EAS Submit are
purpose-built for exactly this, and both are fully non-interactive-capable
once §2–§3 are done. What's **not** scriptable (and why) is in §5.4/§7.

### 5.1 npm scripts (`mobile/package.json`)

```bash
cd mobile
npm run build:ios:preview       # eas build --platform ios --profile preview (simulator build, fast, for smoke-testing a build pipeline change)
npm run build:ios:production    # eas build --platform ios --profile production
npm run submit:ios              # eas submit --platform ios --profile production --latest
npm run release:ios             # full local pipeline: preflight + build (+ optional --submit) — see §5.3
npm run metadata:push           # eas metadata:push (store.config.json → App Store Connect) — see §5.4
npm run metadata:pull           # eas metadata:pull (App Store Connect → store.config.json)
```

### 5.2 GitHub Actions — [`mobile-deploy.yml`](../.github/workflows/mobile-deploy.yml)

The primary, recommended automation path. Actions tab → **Mobile — EAS Build
& Submit (manual approval)** → **Run workflow**:

| Input | What it does |
|---|---|
| `profile` | `preview` (simulator build, quick sanity check) or `production` |
| `submit` | `false` (default) — kick off the build and return immediately (`--no-wait`), doesn't burn CI minutes waiting on Apple's queue. `true` — waits for the build, then `--auto-submit`s it to App Store Connect/TestFlight. |
| `ref` | branch/tag/SHA to build (defaults to `main`) |

Same two-layer human control as [`deploy.yml`](../.github/workflows/deploy.yml):
the run only starts on manual dispatch, and the job pauses for
required-reviewer approval (`environment: production`) before it touches EAS.
Requires `EXPO_TOKEN` (§3.1); needs §2.2/§2.3 already done once, interactively,
by a human (EAS reuses those stored credentials — the workflow itself never
does interactive Apple login).

### 5.3 Local script — [`mobile/scripts/release-ios.sh`](../mobile/scripts/release-ios.sh)

For releasing from a laptop instead of CI (e.g. before CI secrets are set
up, or for a `preview` build you want to iterate on quickly):

```bash
cd mobile
./scripts/release-ios.sh production            # build only
./scripts/release-ios.sh production --submit    # build, then auto-submit
./scripts/release-ios.sh preview                # simulator build, for pipeline smoke-testing
```

What it automates: confirms `eas-cli` is authenticated, refuses to run on a
dirty git tree, runs the Jest suite, prints the current
`version`/`buildNumber` for a final human sanity-check before kicking off a
real build, then shells out to `eas build` (optionally `--auto-submit`).

### 5.4 Store listing / metadata — `mobile/store.config.json` + `eas metadata`

`eas metadata:push`/`eas metadata:pull` manage most App Store Connect listing
fields (title, subtitle, description, keywords, support/marketing/privacy
URLs, category, age-rating advisory, and — usefully — the **App Review**
`notes`/demo-account fields) from a version-controlled JSON file instead of
clicking through the App Store Connect UI. `mobile/store.config.json` is
pre-populated with everything that's already known/decided (privacy URL,
support contact, category, and the **exact reviewer-notes text** from
`app-review-1.2-ugc-response.md` §1) — fields that still need real
marketing copy decided are left as `TODO(...)` placeholders; **don't push
until those are filled in**.

**Known limitations of this tool** (per Expo's docs, not a gap in this
setup): `eas metadata` does **not** support screenshot uploads, and does
**not** support Google Play at all — screenshots stay a manual App Store
Connect upload regardless.

```bash
cd mobile
npm run metadata:pull    # sync store.config.json with whatever's live today, before your first push
# ...edit store.config.json, fill in TODOs...
npm run metadata:push    # validates + uploads
```

---

## 6. What's still manual, and why

| Step | Why it can't be (fully) automated |
|---|---|
| First-ever `eas credentials` setup (§2.2/§2.3) | Requires interactive Apple ID + 2FA login — a security control on Apple's side, not something to script around. One-time only, though. |
| Attaching a TestFlight build to an App Store **version** and clicking Submit for Review | `eas submit` delivers to TestFlight processing but stops short of the App Review queue by design — Apple wants a human confirming "What's New" text and the specific build per version. *(The App Store Connect API can do this too, but wiring it up is a larger lift than this pass covers — see §7.)* |
| The App Review screen recording (`app-review-1.2-ugc-response.md` §3) | Apple explicitly requires **physical-device** capture, and reviewing the recording for correctness before submission is a judgment call. |
| Reading/responding to actual App Review feedback | Apple's decisions aren't scriptable by definition. §8 captures the fixes for the categories of rejection already seen so a repeat is fast, not automatic. |
| Store screenshots | `eas metadata` explicitly doesn't support screenshot upload (§5.4) — stays a manual App Store Connect upload. |
| Deciding *when* to ship / tagging the release | Same project-wide rule as backend/website — [`docs/RELEASE-TAGGING.md`](RELEASE-TAGGING.md) is explicit that tagging/releasing is always a deliberate human call, never automatic on a successful build. |
| Account recovery / access to a login someone else set up | See §1 — a security control by design (Apple's especially), not a gap in this pipeline. |

---

## 7. Optional next steps (not implemented in this pass)

- **App Store Connect API automation of the "attach build → submit for
  review" step** (§6) — possible via direct App Store Connect API calls
  (create a version, associate the build, trigger review) using the same
  ASC API key from §2.3. Bigger lift than `eas metadata`/`eas submit`; worth
  doing only once release cadence is frequent enough to justify it.
- **EAS Update** (OTA JS-only updates) — would let small JS/asset-only fixes
  ship to users without a new binary/App Review cycle at all. Not currently
  wired in (`expo-updates` isn't a dependency). Apple still requires OTA
  content to follow the same guidelines as a binary submission — it's a
  latency optimization, not a way to bypass review. Worth a separate,
  deliberate pass if release velocity becomes a pain point.
- **Android / Play Store** — this doc is iOS-only; the Android/Play Store
  equivalent (a genuine from-scratch setup, not an access-recovery problem)
  is now documented separately in
  [`docs/MOBILE-PLAY-STORE-DEPLOYMENT.md`](MOBILE-PLAY-STORE-DEPLOYMENT.md).
  `mobile-deploy.yml` is shared and platform-aware (`platform: ios | android
  | all`).

---

## 8. Troubleshooting — known issues (from real prior submissions)

### Build fails: "ambiguous implicit access level for import of 'Expo'" (Swift)
Caused by Google Sign-In's transitive CocoaPods needing modular headers.
Already fixed by `mobile/plugins/withModularHeaders.js` (§2.4) — if it
recurs, check that plugin is still listed in `app.config.js`'s `plugins`
array and hasn't been accidentally removed.

### App Review rejection — Guideline 5.1.1(i) / 5.1.2(i) (third-party AI data sharing)
**Already fixed** (build 12) — the app now shows a one-time AI-consent screen
before any text is sent to Gemini, enforced globally (`assertAIConsent`), with
a Profile toggle to disable AI anytime. Full detail + the exact reviewer note
to paste: `app-review-1.2-ugc-response.md` lines 9–31. If this resurfaces (e.g.
a new AI-touching feature bypasses the consent gate), the fix pattern is:
route it through the same `assertAIConsent` check before any Gemini call.

### App Review rejection — Guideline 2.3.6 (Age Rating / Age Assurance)
**Config-only fix, no rebuild needed:** App Store Connect → app → **App
Information** → **Age Rating** → **Edit** → set Age Assurance / In-App
Controls to **None** → Save. Detail: `app-review-1.2-ugc-response.md`
lines 33–36.

### App Review rejection — Guideline 1.2 (User-Generated Content)
Full reviewer-notes template, demo-account setup steps, and a screen-recording
script are ready to reuse verbatim: `app-review-1.2-ugc-response.md` §1–§3.
The safeguards it documents (EULA gate, content filtering, report/block,
24h moderator response) are already implemented — a 1.2 rejection on an
unrelated build most likely means the reviewer notes/demo account weren't
filled in for that submission, not a missing feature.

### `eas build` hangs waiting for credentials interactively in CI
Means §2.2/§2.3 weren't completed yet (or EAS's stored credentials expired).
CI can't do the interactive Apple login — go run `eas credentials --platform
ios` from a developer machine once, then retry CI.

### Entitlements/Podfile changes disappear after a rebuild
Expected — `mobile/ios/` is regenerated from `app.config.js` +
`mobile/plugins/` on every `prebuild`/`eas build` (§0). Any native change
must go through `app.config.js` (config properties) or a config plugin
(`mobile/plugins/`), never a hand-edit under `mobile/ios/`.

### Locked out of the Expo/EAS account, or the Apple Developer account
See §1 — the two are unrelated login systems with very different recovery
paths and very different stakes if you end up creating a new one.

---

## 9. Quick reference

```bash
# One-time (per machine, interactive)
cd mobile && npx eas-cli login
npx eas-cli credentials --platform ios

# Every release
npm run build:ios:production            # or: ./scripts/release-ios.sh production
npm run submit:ios                      # or: ./scripts/release-ios.sh production --submit
# ...then in App Store Connect: attach build to a version, fill What's New, Submit for Review

# CI (after §3 setup)
gh workflow run mobile-deploy.yml -f profile=production -f submit=true -f ref=main

# Metadata (optional, after filling TODOs in store.config.json)
npm run metadata:push

# Check build/submit status
npx eas-cli build:list --platform ios --limit 5
npx eas-cli submit:list --platform ios --limit 5
```
