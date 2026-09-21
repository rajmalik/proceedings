"""
test_profile.py — phase-I user profile + AI onboarding.

  A  seed roster + identity helpers (UNIT)
  B  profile shape / vocab cleaning / PII scrub / validate / merge (UNIT)
  C  AI onboarding turn extraction (INTEGRATION, Gemini, may be slightly flaky)
  D  API endpoints via TestClient incl. Firestore roundtrip + isolation + cleanup

A + B are deterministic, no network. C calls Gemini; D uses Firestore (ADC).

Run:  .venv/bin/python tests/test_profile.py            (all)
      .venv/bin/python tests/test_profile.py unit       (A+B only)
"""

import os
import sys

from dotenv import load_dotenv

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
load_dotenv()

PROJECT = os.getenv("GCP_PROJECT_ID") or os.getenv("GCP_PROJECT", "")
_results: list[tuple[str, bool]] = []


def check(name: str, passed: bool, detail: str = "") -> None:
    _results.append((name, passed))
    print(f"  [{'PASS' if passed else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))


# ---------------------------------------------------------------------------
# A — seed roster + identity (UNIT)
# ---------------------------------------------------------------------------

def group_a() -> None:
    print("\nA — seed roster & identity (unit)")
    import profile as pr
    users = pr.seed_users()
    check("A1 roster loads with ids+usernames",
          len(users) >= 1 and all("id" in u and "username" in u for u in users), f"{len(users)} users")
    ids = pr.seed_ids()
    check("A2 seed_ids is a set of the roster ids", isinstance(ids, set) and len(ids) == len(users))
    first = users[0]["id"]
    check("A3 username_for resolves roster id", pr.username_for(first) == users[0]["username"])
    check("A4 username_for falls back to the id for unknown", pr.username_for("nope") == "nope")

    # A5-A6: handle_for(db=None) — no Firestore available, must behave exactly
    # like username_for() (roster lookup, then raw-uid fallback). The Firestore-
    # aware branch (the actual bug fix — Groups: raw uid displayed instead of a
    # real handle) needs a live db and is covered in group D (integration).
    check("A5 handle_for(None, ...) resolves a roster id same as username_for",
          pr.handle_for(None, first) == users[0]["username"])
    check("A6 handle_for(None, ...) falls back to the raw id, same as username_for",
          pr.handle_for(None, "nope") == "nope")

    # A7: a Firestore lookup failure (not just "no db") must not blow up the
    # caller — handle_for() catches and falls back to username_for(), same
    # as the no-db path above. Stub out just enough of the client chain
    # (.collection().document().get()) to raise.
    class _RaisingDoc:
        def get(self):
            raise RuntimeError("simulated Firestore outage")

    class _RaisingCollection:
        def document(self, _uid):
            return _RaisingDoc()

    class _RaisingDb:
        def collection(self, _name):
            return _RaisingCollection()

    check("A7 handle_for falls back to username_for when the Firestore lookup raises",
          pr.handle_for(_RaisingDb(), first) == users[0]["username"])


# ---------------------------------------------------------------------------
# B — profile shape / cleaning / PII / validate / merge (UNIT)
# ---------------------------------------------------------------------------

def group_b() -> None:
    print("\nB — profile cleaning / PII / validate / merge (unit)")
    import profile as pr

    e = pr.empty_profile()
    check("B1 empty_profile has the expected keys",
          all(k in e for k in ("current_visa_or_greencard_category", "visa_applying_for",
                               "primary_consulate", "consulates", "key_stages_or_info",
                               "key_dates", "background_text")))

    # vocab gate: bad visa dropped; consulate kept; primary derived into consulates
    c = pr.clean_profile({
        "current_visa_or_greencard_category": ["H-1B", "BOGUS"],
        "consulates": ["BOM"], "primary_consulate": "BOM",
    })
    check("B2 clean drops out-of-vocab visa", c["current_visa_or_greencard_category"] == ["H-1B"],
          str(c["current_visa_or_greencard_category"]))
    check("B3 primary_consulate kept inside consulates", c["primary_consulate"] == "BOM" and "BOM" in c["consulates"])

    # country-of-* stage values must be ISO-2 country codes
    cs = pr.clean_profile({"key_stages_or_info": {"citizen_of_country": "IN", "resident_of_country": "ZZ"}})
    check("B4 *_of_country: valid ISO-2 kept, invalid dropped",
          cs["key_stages_or_info"].get("citizen_of_country") == "IN"
          and "resident_of_country" not in cs["key_stages_or_info"], str(cs["key_stages_or_info"]))

    # key_dates: valid kept, unparseable dropped (parseable formats are normalized — see B10/B11)
    cd = pr.clean_profile({"key_dates": {"i94_expire_date": "2027-03-15", "visa_interview_date": "sometime soon"}})
    check("B5 key_dates keeps valid, drops unparseable",
          cd["key_dates"] == {"i94_expire_date": "2027-03-15"}, str(cd["key_dates"]))

    # PII scrub on background
    scr = pr.scrub_pii("Reach me at jane@example.com or 555-123-4567, A012345678")
    check("B6 PII scrub redacts email/phone/A-number",
          "@" not in scr and "555" not in scr and "A012345678" not in scr, scr)

    # validate surfaces dropped values as hints
    hints = pr.validate_profile({"current_visa_or_greencard_category": ["H-1B", "BOGUS"],
                                 "key_dates": {"i94_expire_date": "bad"}})
    check("B7 validate_profile reports invalid drops", len(hints) >= 2, str(hints))

    # merge: union lists, overwrite scalars/text when set
    merged = pr.merge_profile(
        {"current_visa_or_greencard_category": ["H-1B"], "background_text": "old"},
        {"current_visa_or_greencard_category": ["H-4"], "visa_applying_for": ["H-1B"], "background_text": "new"})
    check("B8 merge unions visa lists",
          set(merged["current_visa_or_greencard_category"]) == {"H-1B", "H-4"}, str(merged["current_visa_or_greencard_category"]))
    check("B9 merge overwrites background when incoming set", merged["background_text"] == "new")

    # B10 — date normalization across formats (any input format -> YYYY-MM-DD)
    check("B10 normalize_date handles common formats",
          pr.normalize_date("03/15/2027") == "2027-03-15"
          and pr.normalize_date("March 5, 2026") == "2026-03-05"
          and pr.normalize_date("5 Mar 2026") == "2026-03-05"
          and pr.normalize_date("2027/03/15") == "2027-03-15"
          and pr.normalize_date("not a date") == "")
    cn = pr.clean_profile({"key_dates": {"priority_date": "11/01/2024",
                                         "h1b_filed_date": "April 1 2024", "bad": "xx"}})
    check("B11 clean_profile normalizes mixed date formats + drops bad",
          cn["key_dates"] == {"priority_date": "2024-11-01", "h1b_filed_date": "2024-04-01"}, str(cn["key_dates"]))

    # B11b — every *_filed milestone has a date key (regression: i140_filed_date was missing,
    # so "I-140 filed on 02/28/2026" was silently dropped).
    import posting as _pg
    _pg._Vocab.load()
    filed_keys = ("i129_filed_date", "i130_filed_date", "i140_filed_date", "i485_filed_date",
                  "h1b_filed_date", "labor_cert_filed_date")
    check("B11b all common *_filed_date keys exist (incl. i140_filed_date)",
          all(k in _pg._Vocab.date_keys for k in filed_keys),
          str([k for k in filed_keys if k not in _pg._Vocab.date_keys]))
    check("B11c clean_profile captures i140_filed_date (02/28/2026)",
          pr.clean_profile({"key_dates": {"i140_filed_date": "02/28/2026"}})["key_dates"]
          == {"i140_filed_date": "2026-02-28"})

    # B12 — PII scrub keeps dates, redacts real phones/emails/A-numbers
    s = pr.scrub_pii("Interview 2024-03-10, approved in 2 minutes. Call 555-123-4567, jane@x.com, A012345678")
    check("B12 scrub keeps dates, redacts phone/email/A-number",
          "2024-03-10" in s and "2 minutes" in s and "555-123-4567" not in s and "@" not in s and "A012345678" not in s, s)

    # B13 — journey: slug milestone, normalize date, scrub PII, chronological sort, drop empty
    j = pr.clean_profile({"journey": [
        {"milestone": "Port Of Entry", "date": "04/15/2024", "experience": "JFK, fine. Call 555-123-4567"},
        {"milestone": "Visa Interview", "date": "March 10, 2024", "experience": "Mumbai, approved 2024-03-10"},
        {"milestone": "no-text", "date": "2024-01-01", "experience": ""},
    ]})["journey"]
    check("B13 journey cleaned + chronological + empty dropped",
          [e["milestone"] for e in j] == ["visa_interview", "port_of_entry"]
          and j[0]["date"] == "2024-03-10" and "555-123-4567" not in j[1]["experience"], str([e["milestone"] for e in j]))

    # B14 — merge unions journey by (milestone,date), keeps richer text
    mj = pr.merge_profile(
        {"journey": [{"milestone": "visa_interview", "date": "2024-03-10", "experience": "short"}]},
        {"journey": [{"milestone": "visa_interview", "date": "2024-03-10", "experience": "a much longer account"},
                     {"milestone": "h1b_approval", "date": "2024-06-01", "experience": "approved"}]})["journey"]
    check("B14 merge journey unions + keeps richer text",
          len(mj) == 2 and any(e["experience"] == "a much longer account" for e in mj), str(len(mj)))

    # B15 — structural guarantee: journey text NEVER leaks into current-state tag fields
    b15 = pr.clean_profile({
        "current_visa_or_greencard_category": [], "visa_applying_for": ["H-1B"],
        "journey": [{"milestone": "visa_interview", "date": "2019-05-01",
                     "experience": "My F-1 visa was REFUSED under 214(b) at Mumbai in 2019."}],
    })
    check("B15 journey (past F-1 refusal) never populates current-state tags",
          b15["current_visa_or_greencard_category"] == [] and b15["visa_applying_for"] == ["H-1B"]
          and len(b15["journey"]) == 1, str(b15["current_visa_or_greencard_category"]))

    # B16 — the profile schema has NO free concern/topic tag field, so a concern can NEVER be tagged.
    e = pr.empty_profile()
    check("B16 no free concern/tag field exists on the profile",
          "tags" not in e and "concerns_or_questions_tags" not in e, str([k for k in e]))

    # B17 — non-status / outcome words can't sneak into the current-visa tag (out of vocab -> dropped).
    c17 = pr.clean_profile({"current_visa_or_greencard_category": ["refused", "denied", "approved", "H-1B"]})
    check("B17 outcome words (refused/denied/approved) dropped from current visa",
          c17["current_visa_or_greencard_category"] == ["H-1B"], str(c17["current_visa_or_greencard_category"]))

    # B18 — a topical concern ("visa-stamping", "RFE") has no valid tag slot -> dropped everywhere.
    c18 = pr.clean_profile({"current_visa_or_greencard_category": ["visa-stamping"], "consulates": ["RFE"],
                            "visa_applying_for": ["221g"]})
    check("B18 concern words can't be tagged as visa/consulate",
          c18["current_visa_or_greencard_category"] == [] and c18["consulates"] == []
          and c18["visa_applying_for"] == [], str(c18))

    # B19 — spouse's status is background (key_stages), NEVER the user's current visa.
    c19 = pr.clean_profile({"current_visa_or_greencard_category": [],
                            "key_stages_or_info": {"spouse_status": "H-1B"}})
    check("B19 spouse_status stays background, not the user's current visa",
          c19["current_visa_or_greencard_category"] == []
          and c19["key_stages_or_info"].get("spouse_status") == "H-1B", str(c19["current_visa_or_greencard_category"]))


# ---------------------------------------------------------------------------
# C — AI onboarding extraction (INTEGRATION)
# ---------------------------------------------------------------------------

def group_c() -> None:
    print("\nC — AI onboarding extraction (integration)")
    import profile as pr

    out = pr.onboard_turn(
        [{"role": "user", "content": "I'm a UAE citizen in Dubai applying for a B1/B2 visitor visa; "
          "my interview at the Dubai consulate is on 2026-08-12. My name is John Doe, passport N1234567."}],
        pr.empty_profile())
    p = out["profile"]
    check("C1 onboard returns reply + draft + done",
          isinstance(out.get("reply"), str) and isinstance(p, dict) and "done" in out)
    check("C2 captured B1/B2 visa_applying_for",
          any(v in p["visa_applying_for"] for v in ("B-1", "B-2")), str(p["visa_applying_for"]))
    check("C3 captured a Dubai consulate code", len(p["consulates"]) > 0, str(p["consulates"]))
    check("C4 captured the interview date", "2026-08-12" in (p["key_dates"].values()), str(p["key_dates"]))
    blob = (p["background_text"] + str(p["key_stages_or_info"])).lower()
    check("C5 NO PII stored (name/passport not retained)",
          "john" not in blob and "doe" not in blob and "n1234567" not in blob.lower(), blob[:80])

    # C6 — a mixed-in QUESTION/concern must be deferred, not captured into the profile.
    # Rarely the model slips; a real user just re-states, so allow up to 3 attempts and
    # pick a sample that BOTH doesn't capture the concern AND defers the question.
    _defer_words = ("post", "message", "after", "later", "once your profile",
                    "separately", "share it", "set up your profile", "for now")

    def _no_concern(qp):
        b = (qp["background_text"] + str(qp["key_stages_or_info"]) + str(qp["key_dates"])).lower()
        return "stamping" not in b and "re-entry" not in b and "re entry" not in b

    q, qp = None, {}
    for _ in range(3):
        q = pr.onboard_turn(
            [{"role": "user", "content": "I'm on H-1B, citizen of India. By the way I'm worried about "
              "visa-stamping and whether re-entry will be a problem if I travel — what should I do?"}],
            pr.empty_profile(), "basics")
        qp = q["profile"]
        if _no_concern(qp) and any(w in q["reply"].lower() for w in _defer_words):
            break
    check("C6 concern NOT captured in profile (visa-stamping/re-entry, <=3 tries)",
          _no_concern(qp), str(qp.get("key_stages_or_info")))
    check("C6b but profile basics still captured (H-1B)",
          "H-1B" in qp["current_visa_or_greencard_category"], str(qp["current_visa_or_greencard_category"]))
    check("C6c reply defers the question to a posting",
          any(w in q["reply"].lower() for w in _defer_words), q["reply"][:90])

    # C7 — journey-aware: a multi-phase F-1→H-1B→GC narrative captures several valid journey dates.
    j = pr.onboard_turn(
        [{"role": "user", "content": "On H-1B since 2022 (citizen of India). My H-1B expires 2025-09-30, "
          "PERM was filed last month, and my priority date is 2024-11-01."}],
        pr.empty_profile())
    jd = j["profile"]["key_dates"]
    check("C7 journey: >=2 valid journey dates captured",
          len(jd) >= 2 and all(__import__("re").match(r"^\d{4}-\d{2}-\d{2}$", v) for v in jd.values()), str(jd))

    # C8 — STAGE 1 (basics): a PAST F-1/refusal is NOT tagged as current, and no journey is captured.
    e8 = {}
    for _ in range(3):
        e = pr.onboard_turn(
            [{"role": "user", "content": "I'm currently on H-1B (citizen of India). Back in 2019 my F-1 visa "
              "was REFUSED at Mumbai under 214(b) — denied in 30 seconds. In 2021 my H-1B got approved and I "
              "entered at Newark; the CBP officer just asked about my employer."}],
            pr.empty_profile(), "basics")
        e8 = e["profile"]
        if "F-1" not in e8["current_visa_or_greencard_category"]:
            break
    check("C8a stage-1: past F-1/refusal NOT in current state (only H-1B)",
          "F-1" not in e8["current_visa_or_greencard_category"]
          and "F-1" not in e8["visa_applying_for"], str(e8["current_visa_or_greencard_category"]))
    check("C8b stage-1 does NOT capture experiences (journey empty)",
          len(e8["journey"]) == 0, str(e8["journey"]))

    # C9 — a PRIOR status the user no longer holds is not tagged as current (only current status).
    v9: set = set()
    for _ in range(3):
        o9 = pr.onboard_turn([{"role": "user", "content": "I was on F-1 and did OPT for two years; "
                               "I'm NOW on H-1B (citizen of India)."}], pr.empty_profile())
        v9 = set(o9["profile"]["current_visa_or_greencard_category"]) | set(o9["profile"]["visa_applying_for"])
        if "F-1" not in v9:
            break
    check("C9 prior F-1 NOT tagged as current (only H-1B)", "F-1" not in v9 and "H-1B" in v9, str(sorted(v9)))

    # C10 — STAGE 1 never captures experiences, even if the user volunteers one (structural).
    o10 = pr.onboard_turn([{"role": "user", "content": "I'm on H-1B, citizen of India. My H-1B visa "
                            "interview at Mumbai went great, approved in 2 minutes!"}], pr.empty_profile(), "basics")
    check("C10 stage-1 journey always empty (experiences deferred to stage 2)",
          len(o10["profile"]["journey"]) == 0, str(o10["profile"]["journey"]))

    # C11 — STAGE 2 (experiences): given a SAVED profile, gather experiences into journey
    # and leave the current-state tags untouched.
    saved = pr.clean_profile({"current_visa_or_greencard_category": ["H-1B"],
                              "key_stages_or_info": {"citizen_of_country": "IN"},
                              "key_dates": {"visa_interview_date": "2024-03-10", "admission_date": "2024-04-01"}})
    s2: dict = {}
    for _ in range(2):
        s2 = pr.onboard_turn([{"role": "user", "content": "My visa interview at the Mumbai consulate went "
                               "smoothly — the officer asked about my role and approved in 2 minutes."}],
                             saved, "experiences")["profile"]
        if len(s2["journey"]) >= 1:
            break
    check("C11a stage-2 captures experiences into journey", len(s2["journey"]) >= 1, str(len(s2["journey"])))
    check("C11b stage-2 leaves current-state tags unchanged",
          s2["current_visa_or_greencard_category"] == ["H-1B"], str(s2["current_visa_or_greencard_category"]))

    # ---- EDGE CASES: tags must reflect CURRENT state/background ONLY ----
    def basics(text: str) -> dict:
        return pr.onboard_turn([{"role": "user", "content": text}], pr.empty_profile(), "basics")["profile"]

    def retry(text: str, ok):  # re-sample up to 3x for LLM nondeterminism
        p = {}
        for _ in range(3):
            p = basics(text)
            if ok(p):
                break
        return p

    # C12 — multi-step status history: only the CURRENT status is tagged.
    p12 = retry("I started on F-1, did OPT and STEM OPT, then switched to H-1B. I'm now on H-1B (citizen of India).",
                lambda p: "F-1" not in set(p["current_visa_or_greencard_category"]))
    cur12 = set(p12["current_visa_or_greencard_category"])
    check("C12 status history: only current H-1B tagged (no F-1/OPT)",
          "H-1B" in cur12 and "F-1" not in cur12, str(sorted(cur12)))

    # C13 — someone ELSE's visa is not tagged as the user's current status.
    p13 = retry("I'm on H-4 as a dependent. My spouse is the H-1B holder. Citizen of India.",
                lambda p: "H-1B" not in set(p["current_visa_or_greencard_category"]))
    cur13 = set(p13["current_visa_or_greencard_category"])
    check("C13 spouse's H-1B NOT tagged as user's current (user is H-4)",
          "H-1B" not in cur13 and "H-4" in cur13, str(sorted(cur13)))

    # C14 — a PAST refused visa is not tagged as current or intended status.
    p14 = retry("My B-2 tourist visa was REFUSED in 2018 under 214(b). I'm now on H-1B (citizen of India).",
                lambda p: "B-2" not in (set(p["current_visa_or_greencard_category"]) | set(p["visa_applying_for"])))
    cur14 = set(p14["current_visa_or_greencard_category"]) | set(p14["visa_applying_for"])
    check("C14 past refused B-2 NOT tagged as current/applying (only H-1B)",
          "B-2" not in cur14 and "H-1B" in cur14, str(sorted(cur14)))

    # C15 — open concerns/worries never become tags (no free-tag slot + must be deferred).
    def c15blob(p):
        return (str(p["current_visa_or_greencard_category"]) + str(p["visa_applying_for"])
                + str(p["consulates"]) + str(p["key_stages_or_info"])).lower()
    p15 = retry("I'm on H-1B, citizen of India. I'm worried about visa-stamping, a possible 221g, and an RFE.",
                lambda p: not any(w in c15blob(p) for w in ("stamping", "221g", "rfe")))
    check("C15 concern words (stamping/221g/rfe) not in any tag field",
          not any(w in c15blob(p15) for w in ("stamping", "221g", "rfe")), c15blob(p15)[:90])


# ---------------------------------------------------------------------------
# D — API endpoints + Firestore roundtrip (INTEGRATION)
# ---------------------------------------------------------------------------

def group_d() -> None:
    print("\nD — API endpoints + Firestore roundtrip (integration)")
    from fastapi.testclient import TestClient
    import api, profile as pr
    api.RATE_LIMIT_MAX = 100000
    test_uid = "demo-mei"  # use a roster id; cleaned up at the end

    with TestClient(api.app) as client:
        roster = client.get("/api/users").json()
        check("D1 /api/users returns the roster", len(roster) >= 1 and "id" in roster[0])

        check("D2 /api/profile without X-User-Id -> 400",
              client.get("/api/profile").status_code == 400)
        check("D3 /api/profile unknown user -> 404",
              client.get("/api/profile", headers={"X-User-Id": "ghost"}).status_code == 404)

        hdr = {"X-User-Id": test_uid}
        put = client.put("/api/profile", headers=hdr, json={
            "current_visa_or_greencard_category": ["F-1"],
            "key_stages_or_info": {"citizen_of_country": "CN"},
            "key_dates": {"employment_end_date": "2027-05-31"},
            "background_text": "F-1 student. Contact: spam@x.com 555-000-1111",
        })
        pj = put.json()
        check("D4 PUT saves + validates (visa kept, PII scrubbed)",
              put.status_code == 200 and pj["current_visa_or_greencard_category"] == ["F-1"]
              and "@" not in pj["background_text"], f"status={put.status_code}")

        got = client.get("/api/profile", headers=hdr).json()
        check("D5 GET reads back the saved profile",
              got["current_visa_or_greencard_category"] == ["F-1"] and bool(got["updated_at"]))

        other = client.get("/api/profile", headers={"X-User-Id": "demo-sofia"}).json()
        check("D6 per-user isolation (demo-sofia unaffected)",
              other["current_visa_or_greencard_category"] == [], str(other["current_visa_or_greencard_category"]))

        onb = client.post("/api/onboard", headers=hdr, json={
            "messages": [{"role": "user", "content": "I'm on F-1 OPT, citizen of China."}],
            "draft": {}})
        check("D7 /api/onboard returns reply+profile+done",
              onb.status_code == 200 and all(k in onb.json() for k in ("reply", "profile", "done")),
              f"status={onb.status_code}")

        # D9 — save is AUTHORITATIVE: re-saving without a previously-saved key removes it
        # (guards against Firestore map deep-merge leaving stale key_stages/key_dates).
        client.put("/api/profile", headers=hdr, json={
            "current_visa_or_greencard_category": ["F-1"],
            "key_stages_or_info": {"citizen_of_country": "CN", "spouse_status": "H-1B"},
            "key_dates": {"opt_expire_date": "2027-05-31", "f1_expire_date": "2026-01-01"}})
        client.put("/api/profile", headers=hdr, json={
            "current_visa_or_greencard_category": ["F-1"],
            "key_stages_or_info": {"citizen_of_country": "CN"},  # spouse_status removed
            "key_dates": {"opt_expire_date": "2027-05-31"}})       # f1_expire_date removed
        re = client.get("/api/profile", headers=hdr).json()
        check("D9 re-save is authoritative (removed keys are gone, not merged)",
              re["key_stages_or_info"] == {"citizen_of_country": "CN"}
              and re["key_dates"] == {"opt_expire_date": "2027-05-31"},
              f"stages={re['key_stages_or_info']} dates={re['key_dates']}")

        # D14-D17: POST /api/profile/key-dates — the post-join Timeline
        # attribute form's save endpoint. Unlike PUT /api/profile (a full
        # replace, D9 above), this is a PARTIAL merge: it must add/overwrite
        # only the given keys and leave everything else (including other
        # key_dates keys, and non-key_dates fields entirely) untouched.
        client.put("/api/profile", headers=hdr, json={
            "current_visa_or_greencard_category": ["F-1"],
            "tags": ["premium-processing"],
            "key_dates": {"opt_expire_date": "2027-05-31"}})
        kd = client.post("/api/profile/key-dates", headers=hdr, json={
            "key_dates": {"ead_filed_date": "2026-03-01", "rfe_date": "2026-04-15"}})
        kdj = kd.json()
        check("D14 POST key-dates 200 + adds the new keys",
              kd.status_code == 200 and kdj["key_dates"].get("ead_filed_date") == "2026-03-01"
              and kdj["key_dates"].get("rfe_date") == "2026-04-15", f"status={kd.status_code}")
        check("D15 POST key-dates preserves a pre-existing key_dates entry not in the request",
              kdj["key_dates"].get("opt_expire_date") == "2027-05-31", str(kdj["key_dates"]))
        check("D16 POST key-dates leaves other profile fields untouched (visa, tags)",
              kdj["current_visa_or_greencard_category"] == ["F-1"] and kdj["tags"] == ["premium-processing"],
              f"visa={kdj['current_visa_or_greencard_category']} tags={kdj['tags']}")
        kd2 = client.post("/api/profile/key-dates", headers=hdr, json={
            "key_dates": {"ead_filed_date": "2026-03-05"}})
        check("D17 POST key-dates overwrites a matching key on a second call",
              kd2.json()["key_dates"].get("ead_filed_date") == "2026-03-05", str(kd2.json()["key_dates"]))

    # cleanup the test user's Firestore doc
    try:
        if api._db is not None:
            api._db.collection("users").document(test_uid).delete()
            check("D8 cleanup of test profile doc", True)
    except Exception as e:  # noqa: BLE001
        check("D8 cleanup of test profile doc", False, str(e))

    # D10-D12: handle_for(db, uid) — the actual Groups bug fix. A real
    # (non-seed, Firebase-registered) user has NO entry in the static seed
    # roster, so the OLD code path (username_for(uid) alone, with no
    # Firestore fallback — what matching.py/group_messages.py called before
    # this fix) returns the raw uid unchanged. handle_for() must instead
    # find the real handle random_username() assigned at registration.
    new_uid = ""
    with TestClient(api.app) as client:
        reg = client.post("/api/users", json={})
        reg_ok = reg.status_code == 200 and reg.json().get("id") and reg.json().get("username")
        check("D10 POST /api/users registers a fresh non-seed uid with a real handle",
              reg_ok, f"status={reg.status_code} body={reg.text[:200]}")
        if reg_ok:
            new_uid, real_handle = reg.json()["id"], reg.json()["username"]
            check("D11 handle_for(db, uid) resolves the REAL registered handle, not the raw uid",
                  api._db is not None and pr.handle_for(api._db, new_uid) == real_handle,
                  f"handle_for={pr.handle_for(api._db, new_uid) if api._db else 'no db'} real={real_handle}")
            check("D12 the OLD code path (username_for alone) would have returned the raw uid "
                  "— confirms this really is a bug fix, not a no-op",
                  pr.username_for(new_uid) == new_uid, pr.username_for(new_uid))

    # cleanup the synthetic registered user
    try:
        if api._db is not None and new_uid:
            api._db.collection("users").document(new_uid).delete()
            check("D13 cleanup of synthetic registered user", True)
    except Exception as e:  # noqa: BLE001
        check("D13 cleanup of synthetic registered user", False, str(e))


def main() -> int:
    if not PROJECT:
        print("GCP_PROJECT_ID must be set"); return 2
    only = sys.argv[1] if len(sys.argv) > 1 else "all"
    print(f"Profile/onboarding tests — project={PROJECT}  (scope={only})")
    group_a()
    group_b()
    if only in ("all", "llm"):
        group_c()
    if only in ("all", "api"):
        group_d()

    print("\n" + "=" * 60)
    passed = sum(1 for _, ok in _results if ok)
    failed = [n for n, ok in _results if not ok]
    print(f"SUMMARY: {passed}/{len(_results)} checks passed")
    if failed:
        print("FAILED: " + "; ".join(failed)); return 1
    print("All profile/onboarding checks passed."); return 0


if __name__ == "__main__":
    sys.exit(main())
