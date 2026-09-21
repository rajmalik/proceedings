"""
test_matching.py — phase-M "Find users in same boat" (matching + groups).

Groups:
  A  pure scoring + criteria cleaning/merge (no network) — always runs
  D  pure DATE matching: exact, approximate windows, parsing care — always runs
  G  pure positive/negative matching across every criteria dimension — always runs
  B  live Firestore: find_turn shape, find_matches ranking, group round-trip — INTEGRATION
  C  HTTP API via FastAPI TestClient (auth gating, matches, groups) — INTEGRATION
  E  live Firestore: merge profile+criteria, positive/negative matching — INTEGRATION
  F  live Firestore: date matching end-to-end via find_matches — INTEGRATION
  H  live Firestore: positive/negative matches + ranking/top_n/min_score — INTEGRATION
  L  live Firestore: group lifecycle — validity/expiration, archive, join/search
     exclude non-active groups, dedup skips dead groups — INTEGRATION
  M  pure: mandatory post-join Timeline attributes — type matching +
     required-field validation — always runs
  N  live Firestore: member_attributes — join_group() gate, save/list,
     rename lock, name-based dedup, HTTP routes — INTEGRATION
  O  pure: invitation id + the re-invite decision table — always runs
  P  live Firestore: invitations — a pending invitee is invisible to every
     membership read, guards, accept/decline, cancellation, bulk invites,
     backwards compatibility — INTEGRATION
  Q  live Firestore: invitation HTTP routes (incl. route-ordering) +
     the find-candidates fixes — INTEGRATION

Run:  .venv/bin/python tests/test_matching.py [unit|integration|all]
"""

import os
import secrets
import sys

from dotenv import load_dotenv

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
load_dotenv()

import matching as M  # noqa: E402
import posting  # noqa: E402

PROJECT = os.getenv("GCP_PROJECT_ID") or os.getenv("GCP_PROJECT", "")
_results: list[tuple[str, bool]] = []


def check(name: str, passed: bool, detail: str = "") -> None:
    _results.append((name, passed))
    print(f"  [{'PASS' if passed else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))


# ---------------------------------------------------------------------------
# A — pure scoring + criteria cleaning/merge
# ---------------------------------------------------------------------------

def group_a_pure() -> None:
    print("\nA — pure scoring + criteria")
    crit = {"current_visa_or_greencard_category": ["H-1B"], "visa_applying_for": ["EB-2"],
            "consulates": ["BOM"], "key_stages_or_info": {"citizen_of_country": "IN", "visa_status": "pending"},
            "key_dates": {"priority_date": "2022-01-01"}}

    strong = M._score(crit, {"current_visa_or_greencard_category": ["H-1B"], "visa_applying_for": ["EB-2"],
                             "consulates": ["BOM"], "key_stages_or_info": {"citizen_of_country": "IN"}})
    check("A1 strong = visa+visa+consulate+stage (3+3+1.5+1)", abs(strong["score"] - 8.5) < 0.01, str(strong["score"]))
    check("A2 shared lists the overlap",
          set(strong["shared"]) == {"H-1B", "EB-2", "BOM", "citizen_of_country=IN"}, str(strong["shared"]))

    consonly = M._score(crit, {"consulates": ["BOM"], "current_visa_or_greencard_category": ["F-1"]})
    check("A3 consulate-only = 1.5", abs(consonly["score"] - 1.5) < 0.01, str(consonly["score"]))

    disjoint = M._score(crit, {"current_visa_or_greencard_category": ["B-1"], "consulates": ["LON"],
                               "key_stages_or_info": {"citizen_of_country": "GB"}})
    check("A4 disjoint = 0 + empty shared", disjoint["score"] == 0.0 and disjoint["shared"] == [])

    check("A5 visa outweighs consulate (ranking)", strong["score"] > consonly["score"] > disjoint["score"])

    # stage requires SAME key AND value
    sval = M._score({"key_stages_or_info": {"visa_status": "pending"}},
                    {"key_stages_or_info": {"visa_status": "approved"}})
    check("A6 same stage key, different value → no match", sval["score"] == 0.0)

    # cleaning drops out-of-vocab + journey/identity
    cleaned = M._clean_criteria({"current_visa_or_greencard_category": ["H-1B", "NOT-A-VISA"],
                                 "journey": [1, 2], "username": "x"})
    check("A7 _clean_criteria drops bad tags + journey/identity",
          cleaned["current_visa_or_greencard_category"] == ["H-1B"]
          and "journey" not in cleaned and "username" not in cleaned, str(cleaned))

    # A7b-A7d: _clean_criteria re-admits 1.6 visa-form-action tags (e.g. a
    # Timeline group's Processing type, stem-opt-extension) even though
    # profile.clean_profile()'s clean_misc_tags excludes them for personal
    # profiles (1.3+1.10 only) — without this, a Timeline group's stored
    # criteria_tags.tags always came back empty for its Processing type.
    import posting
    import profile
    check("A7b stem-opt-extension really is a 1.6 tag, not a 1.10 misc tag (sanity check for this test)",
          "stem-opt-extension" in posting._Vocab.visa_form_map and "stem-opt-extension" not in posting._Vocab.misc)
    pt_cleaned = M._clean_criteria({"tags": ["stem-opt-extension", "not-a-real-tag"]})
    check("A7c _clean_criteria KEEPS a 1.6 tag (stem-opt-extension) in criteria tags",
          pt_cleaned["tags"] == ["stem-opt-extension"], str(pt_cleaned["tags"]))
    profile_cleaned = profile.clean_profile({"tags": ["stem-opt-extension"], "journey": []})
    check("A7d profile.clean_profile() itself still EXCLUDES 1.6 tags (personal-profile behavior unchanged)",
          profile_cleaned["tags"] == [], str(profile_cleaned["tags"]))

    merged = M._merge_criteria({"consulates": ["BOM"]}, {"consulates": ["DEL"]})
    check("A8 _merge_criteria unions lists", merged["consulates"] == ["BOM", "DEL"], str(merged["consulates"]))

    check("A9 _summary is a compact line",
          M._summary({"current_visa_or_greencard_category": ["H-1B"], "consulates": ["BOM"]}) == "H-1B · BOM")

    # A10-A15: group lifecycle (status/expiration) + Timeline default naming —
    # all pure, no Firestore round-trip needed.
    check("A10 _effective_status: active + no expiration stays active",
          M._effective_status({"status": "active", "expiration_date": ""}) == "active")
    from datetime import datetime, timedelta, timezone
    future = (datetime.now(timezone.utc) + timedelta(days=30)).isoformat()
    past = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()
    check("A11 _effective_status: active + future expiration stays active",
          M._effective_status({"status": "active", "expiration_date": future}) == "active")
    check("A12 _effective_status: active + past expiration reports archived (lazy, no write)",
          M._effective_status({"status": "active", "expiration_date": past}) == "archived")
    check("A13 _effective_status: manually archived stays archived regardless of expiration",
          M._effective_status({"status": "archived", "expiration_date": future}) == "archived")
    check("A14 _effective_status: deleted stays deleted regardless of expiration",
          M._effective_status({"status": "deleted", "expiration_date": past}) == "deleted")
    check("A15 _effective_status: missing status defaults to active",
          M._effective_status({}) == "active")
    check("A15b _effective_status: legacy 'formed' status (pre-existing groups) normalizes to active",
          M._effective_status({"status": "formed"}) == "active")
    check("A15c _effective_status: legacy 'formed' + past expiration still auto-archives",
          M._effective_status({"status": "formed", "expiration_date": past}) == "archived")

    full_name = M._timeline_group_name({"tags": ["stem-opt-extension"],
                                        "key_stages_or_info": {"filing_month": "Sep", "filing_year": "2026"}})
    check("A16 _timeline_group_name assembles <type>-<month>-<year>",
          full_name == "stem-opt-extension-Sep-2026", full_name)
    type_only_name = M._timeline_group_name({"tags": ["stem-opt-extension"], "key_stages_or_info": {}})
    check("A17 _timeline_group_name with no Cycle/Year yet still names by type alone",
          type_only_name == "stem-opt-extension", type_only_name)
    no_type_name = M._timeline_group_name({"tags": ["rfe-experience"], "key_stages_or_info": {}})
    check("A18 _timeline_group_name returns '' when no registered processing type is present (caller falls back)",
          no_type_name == "", repr(no_type_name))
    visa_ptype_name = M._timeline_group_name({"current_visa_or_greencard_category": ["H-1B"],
                                              "key_stages_or_info": {"filing_month": "Mar", "filing_year": "2027"}})
    check("A19 _timeline_group_name also reads a processing type stored in current_visa_or_greencard_category",
          visa_ptype_name == "H-1B-Mar-2027", visa_ptype_name)

    check("A20 every _VALIDITY_DAYS option is > 0 and TIMELINE_VALIDITY_OPTIONS is a subset of REGULAR_VALIDITY_OPTIONS",
          all(d > 0 for d in M._VALIDITY_DAYS.values())
          and set(M.TIMELINE_VALIDITY_OPTIONS) <= set(M.REGULAR_VALIDITY_OPTIONS)
          and set(M.REGULAR_VALIDITY_OPTIONS) - set(M.TIMELINE_VALIDITY_OPTIONS) == {"3_years", "5_years", "10_years"})


# ---------------------------------------------------------------------------
# B — live Firestore: find_turn, find_matches, groups
# ---------------------------------------------------------------------------

def group_b_firestore() -> None:
    print("\nB — live Firestore matching + groups (integration)")
    from google.cloud import firestore
    db = firestore.Client(project=PROJECT)

    ids = {k: f"test-match-{k}-{secrets.token_hex(3)}" for k in ("a", "b", "c", "d")}
    seeds = {
        ids["a"]: {"username": "alpha", "current_visa_or_greencard_category": ["H-1B"],
                   "consulates": ["BOM"], "key_stages_or_info": {"citizen_of_country": "IN"}},
        ids["b"]: {"username": "bravo", "current_visa_or_greencard_category": ["H-1B"]},
        ids["c"]: {"username": "charlie", "current_visa_or_greencard_category": ["F-1"], "consulates": ["LON"]},
        ids["d"]: {"username": "delta", "current_visa_or_greencard_category": ["F-1"]},
    }
    criteria = {"current_visa_or_greencard_category": ["H-1B"], "consulates": ["BOM"],
                "key_stages_or_info": {"citizen_of_country": "IN"}}
    gid = ""
    try:
        # one live find_turn — assert SHAPE only (LLM output is non-deterministic)
        turn = M.find_turn([{"role": "user", "content": "I'm on H-1B from India, applied EB-2, interview in Mumbai"}], {})
        check("B0 find_turn returns {reply, criteria(validated), done}",
              isinstance(turn.get("reply"), str) and isinstance(turn.get("done"), bool)
              and set(turn.get("criteria", {})) == set(M.CRITERIA_FIELDS), str(list(turn.get("criteria", {}))))

        for uid, p in seeds.items():
            db.collection("users").document(uid).set(p)

        # from a's perspective: self excluded; b qualifies (H-1B=3.0); c disjoint (dropped)
        by = {m["user_id"]: m for m in M.find_matches(db, ids["a"], criteria)}
        check("B1 self excluded", ids["a"] not in by)
        check("B2 H-1B peer present, disjoint absent", ids["b"] in by and ids["c"] not in by, str(list(by)))
        check("B3 H-1B-only peer scores 3.0", ids["b"] in by and abs(by[ids["b"]]["score"] - 3.0) < 0.01,
              str(by.get(ids["b"])))

        # from b's perspective: a is a strong match (H-1B + BOM + citizen IN = 5.5)
        m2 = {m["user_id"]: m for m in M.find_matches(db, ids["b"], criteria)}
        check("B4 strong peer ranks 5.5", ids["a"] in m2 and abs(m2[ids["a"]]["score"] - 5.5) < 0.01,
              str(m2.get(ids["a"])))

        # group: create (me + selected peer), with a generated name
        g = M.find_or_create_group(db, "demo-arjun", "looking for H-1B folks at Mumbai", criteria,
                                   [{"user_id": ids["a"], "username": "alpha"}])
        gid = g["group_id"]
        member_ids = {m["user_id"] for m in g["members"]}
        check("B5 create: id + generated name + ONLY the creator as a member + not joined "
              "(peers are invited now, not silently added)",
              bool(gid) and g["name"] and member_ids == {"demo-arjun"} and g["joined"] is False,
              f"name={g['name']} members={member_ids}")
        check("B5b …and the peer got a pending invitation instead",
              [i["user_id"] for i in (g.get("invited") or [])] == [ids["a"]], str(g.get("invited")))

        # same signature (extra dates ignored) → JOIN the same group, add new member
        g2 = M.find_or_create_group(db, ids["b"], "same boat, different words",
                                    {**criteria, "key_dates": {"priority_date": "2022-05-01"}}, [])
        check("B6 same-signature → joins existing group + adds member",
              g2["group_id"] == gid and g2["joined"] is True and ids["b"] in {m["user_id"] for m in g2["members"]},
              f"gid={g2['group_id']} joined={g2['joined']}")

        # browse all + my membership + direct join
        allg = {x["group_id"]: x for x in M.list_all_groups(db, ids["c"])}
        check("B7 list_all_groups includes it, is_member False for non-member",
              gid in allg and allg[gid]["is_member"] is False)
        jg = M.join_group(db, gid, ids["c"])
        check("B8 join_group adds the user", ids["c"] in {m["user_id"] for m in jg["members"]} and jg["joined"] is True)
        mine = {x["group_id"] for x in M.my_groups(db, ids["c"])}
        check("B9 my_groups reflects membership after join", gid in mine)

        # B10: non-distinctive (no visa/consulate/country) criteria used to be
        # rejected — that guard was removed so a Timeline group whose only
        # distinguishing facet is a non-visa Processing type (e.g.
        # stem-opt-extension, which lands in `tags`, not in the signature)
        # can still be created.
        nd = M.find_or_create_group(db, "demo-arjun", "x", {}, [])
        nd_gid = nd["group_id"]
        try:
            check("B10 non-distinctive (empty) criteria now creates/joins a group",
                  bool(nd_gid) and "demo-arjun" in {m["user_id"] for m in nd["members"]}, str(nd))
        finally:
            if not nd["joined"]:
                db.collection("groups").document(nd_gid).delete()

        # B11-B14: _group_view's new fields — admin flag, description, last_activity_at
        creator_view = next(x for x in M.list_all_groups(db, "demo-arjun") if x["group_id"] == gid)
        check("B11 creator sees is_admin=True", creator_view["is_admin"] is True)
        peer_view = next(x for x in M.list_all_groups(db, ids["a"]) if x["group_id"] == gid)
        check("B12 non-creator member sees is_admin=False", peer_view["is_admin"] is False)
        check("B13 new group starts with an empty description", creator_view["description"] == "")
        check("B14 new group has a last_activity_at timestamp", bool(creator_view["last_activity_at"]))

        # B15-B16: rename_group — creator-only
        try:
            M.rename_group(db, gid, ids["a"], name="Hijacked")
            check("B15 rename by non-creator rejected", False, "no raise")
        except PermissionError:
            check("B15 rename by non-creator rejected (PermissionError)", True)
        renamed = M.rename_group(db, gid, "demo-arjun", name="Mumbai H-1B crew", description="H-1B folks near BOM")
        check("B16 rename by creator updates name + description",
              renamed["name"] == "Mumbai H-1B crew" and renamed["description"] == "H-1B folks near BOM",
              str((renamed["name"], renamed["description"])))

        # B17-B19: invite_member — member-only, handle-based, direct add
        try:
            M.invite_member(db, gid, "some-stranger-not-a-member", "delta")
            check("B17 invite by non-member rejected", False, "no raise")
        except PermissionError:
            check("B17 invite by non-member rejected (PermissionError)", True)
        try:
            M.invite_member(db, gid, "demo-arjun", "no-such-handle-at-all")
            check("B18 invite of an unknown handle rejected", False, "no raise")
        except ValueError:
            check("B18 invite of an unknown handle rejected (ValueError)", True)
        invited = M.invite_member(db, gid, "demo-arjun", "delta")
        check("B19 invite by handle creates a PENDING invitation for the resolved user "
              "(it used to add them directly — now they must accept)",
              invited["status"] == "pending" and invited["user_id"] == ids["d"], str(invited))
        check("B19b …and the group has NOT gained a member yet",
              ids["d"] not in {m["user_id"] for m in
                               db.collection("groups").document(gid).get().to_dict()["members"]})
        accepted = M.accept_invitation(db, gid, ids["d"])
        check("B19c accepting the invitation is what actually adds them",
              ids["d"] in {m["user_id"] for m in accepted["members"]},
              str({m["user_id"] for m in accepted["members"]}))

        # B20-B21: leave_group — a regular member leaving needs no reassignment;
        # the creator leaving must hand admin to a remaining member.
        left = M.leave_group(db, gid, ids["d"])
        check("B20 leave_group removes the member, admin unchanged for a non-creator leaving",
              ids["d"] not in {m["user_id"] for m in left["members"]} and left["created_by"] == "demo-arjun",
              str(({m["user_id"] for m in left["members"]}, left["created_by"])))
        creator_left = M.leave_group(db, gid, "demo-arjun")
        check("B21 creator leaving reassigns admin to a remaining member",
              "demo-arjun" not in {m["user_id"] for m in creator_left["members"]}
              and creator_left["created_by"] in {m["user_id"] for m in creator_left["members"]},
              str((creator_left["created_by"], {m["user_id"] for m in creator_left["members"]})))
        new_admin = creator_left["created_by"]

        # B22-B24: all three new mutators 404 (KeyError) on a group that
        # doesn't exist — mirrors join_group's existing "Group not found" gate.
        try:
            M.rename_group(db, "no-such-group-xyz", new_admin, name="x")
            check("B22 rename_group on a missing group raises", False, "no raise")
        except KeyError:
            check("B22 rename_group on a missing group raises (KeyError)", True)
        try:
            M.invite_member(db, "no-such-group-xyz", new_admin, "alpha")
            check("B23 invite_member on a missing group raises", False, "no raise")
        except KeyError:
            check("B23 invite_member on a missing group raises (KeyError)", True)
        try:
            M.leave_group(db, "no-such-group-xyz", new_admin)
            check("B24 leave_group on a missing group raises", False, "no raise")
        except KeyError:
            check("B24 leave_group on a missing group raises (KeyError)", True)

        # B25: inviting a handle that's ALREADY a member is now an explicit
        # error rather than the old silent dedup no-op — the person typed a
        # specific handle and deserves to be told it's already in the group.
        # ids["a"] was a PEER at creation (B5), so they're only invited — accept
        # first so this really is the already-a-member case.
        M.accept_invitation(db, gid, ids["a"])
        current = next(g for g in M.list_all_groups(db, new_admin) if g["group_id"] == gid)
        before_members = {m["user_id"] for m in current["members"]}
        try:
            M.invite_member(db, gid, new_admin, "alpha")
            check("B25 inviting an already-member handle raises ValueError", False, "no raise")
        except ValueError:
            check("B25 inviting an already-member handle raises ValueError", True)
        after_members = {m["user_id"] for m in
                         db.collection("groups").document(gid).get().to_dict()["members"]}
        check("B25b …and the member list is unchanged", after_members == before_members,
              str(after_members))

        # B26: a non-member "leaving" is a harmless no-op (no exception,
        # membership list unaffected) — leave_group filters by user_id and
        # simply finds nothing to remove.
        left_by_stranger = M.leave_group(db, gid, "some-stranger-never-joined")
        check("B26 leave_group by a non-member is a no-op, membership unchanged",
              {m["user_id"] for m in left_by_stranger["members"]} == before_members,
              str({m["user_id"] for m in left_by_stranger["members"]}))

        # B27-B28: rename_group only touches the field(s) actually provided.
        desc_before_27 = current["description"]
        r27 = M.rename_group(db, gid, new_admin, name="Only Name Changed")
        check("B27 rename with only `name` leaves `description` untouched",
              r27["name"] == "Only Name Changed" and r27["description"] == desc_before_27,
              str((r27["name"], r27["description"])))
        r28 = M.rename_group(db, gid, new_admin, description="Only description changed")
        check("B28 rename with only `description` leaves `name` untouched",
              r28["description"] == "Only description changed" and r28["name"] == "Only Name Changed",
              str((r28["name"], r28["description"])))

        # B29-B30: name/description are capped, not rejected, when over length.
        r29 = M.rename_group(db, gid, new_admin, name="n" * 150)
        check("B29 name is truncated to 100 chars, not rejected",
              len(r29["name"]) == 100, len(r29["name"]))
        r30 = M.rename_group(db, gid, new_admin, description="d" * 600)
        check("B30 description is truncated to 500 chars, not rejected",
              len(r30["description"]) == 500, len(r30["description"]))

        # B31: an empty/whitespace-only name is rejected outright (unlike the
        # cap above — there's no reasonable truncation of nothing).
        try:
            M.rename_group(db, gid, new_admin, name="   ")
            check("B31 empty/whitespace name rejected", False, "no raise")
        except ValueError:
            check("B31 empty/whitespace name rejected (ValueError)", True)

        # B32-B33: the LAST member leaving DELETES the group (and its messages)
        # outright rather than leaving an orphaned, empty, admin-less doc behind.
        # "DV" is a rare, distinctive, valid visa code confirmed unclaimed by any
        # real group earlier in this session — guard on `joined` anyway so a
        # collision fails loudly instead of silently mutating a real group.
        import group_messages as GM
        solo = M.find_or_create_group(db, ids["a"], "solo scratch group for leave-deletes-group check",
                                      {"current_visa_or_greencard_category": ["DV"]}, [])
        solo_gid = solo["group_id"]
        try:
            if solo["joined"]:
                check("B32 last member leaving deletes the group", False,
                      "signature collided with a real existing group — skipped")
                check("B33 last member leaving deletes its messages too", False, "skipped")
            else:
                GM.post_message(db, solo_gid, ids["a"], "hello before leaving")
                emptied = M.leave_group(db, solo_gid, ids["a"])
                solo_doc = db.collection("groups").document(solo_gid).get()
                check("B32 last member leaving soft-deletes the group (status=deleted, doc retained)",
                      emptied["members"] == [] and solo_doc.exists and (solo_doc.to_dict() or {}).get("status") == "deleted",
                      str((emptied["members"], solo_doc.exists, (solo_doc.to_dict() or {}).get("status") if solo_doc.exists else None)))
                remaining_msgs = list(db.collection("groups").document(solo_gid).collection("messages").stream())
                check("B33 last member leaving does NOT delete its messages (soft delete retains data)",
                      len(remaining_msgs) == 1, f"{len(remaining_msgs)} messages left behind")
        finally:
            if not solo["joined"]:
                db.collection("groups").document(solo_gid).delete()

        # B34-B36: delete_group — creator-only, works even with other members
        # still present, and removes the messages subcollection too.
        multi = M.find_or_create_group(db, ids["a"], "multi-member group for delete_group check",
                                       {"current_visa_or_greencard_category": ["SB-1"]},
                                       [{"user_id": ids["b"], "username": "bravo"}])
        multi_gid = multi["group_id"]
        try:
            if multi["joined"]:
                check("B34 delete_group by non-creator raises PermissionError", False, "skipped (signature collided)")
                check("B35 delete_group by the creator removes the group + messages", False, "skipped (signature collided)")
            else:
                # bravo was passed as a peer, so they're invited, not a member —
                # accept so this stays a genuinely multi-member group.
                M.accept_invitation(db, multi_gid, ids["b"])
                GM.post_message(db, multi_gid, ids["b"], "hi from bravo")
                try:
                    M.delete_group(db, multi_gid, ids["b"])
                    check("B34 delete_group by non-creator raises PermissionError", False, "no raise")
                except PermissionError:
                    check("B34 delete_group by non-creator raises PermissionError", True)
                M.delete_group(db, multi_gid, ids["a"])
                multi_doc = db.collection("groups").document(multi_gid).get()
                msgs_retained = list(db.collection("groups").document(multi_gid).collection("messages").stream()) != []
                check("B35 delete_group by the creator soft-deletes (doc retained, status=deleted, messages retained)",
                      multi_doc.exists and (multi_doc.to_dict() or {}).get("status") == "deleted" and msgs_retained,
                      str((multi_doc.exists, (multi_doc.to_dict() or {}).get("status") if multi_doc.exists else None, msgs_retained)))
                check("B35b a soft-deleted group is excluded from list_all_groups()",
                      multi_gid not in {g["group_id"] for g in M.list_all_groups(db, ids["a"])})
        finally:
            if not multi["joined"]:
                db.collection("groups").document(multi_gid).delete()

        try:
            M.delete_group(db, "no-such-group-xyz", ids["a"])
            check("B36 delete_group on a missing group raises (KeyError)", False, "no raise")
        except KeyError:
            check("B36 delete_group on a missing group raises (KeyError)", True)

        # B37-B41: Timeline create-time dedup is now name-based
        # (_find_group_by_name — the group's auto-generated <type>-<cycle>-
        # <year> name, since Timeline groups can't be renamed), not the
        # coarse visa/consulate/country _signature() Regular groups still
        # use — two Timeline cohorts that differ only in Cycle/Year (both
        # empty visa/consulate/country, so they'd share the SAME signature)
        # must NOT collide into one group. stem-opt-extension requires the
        # "Date Applied" attribute to join/create (POST_JOIN_ATTRIBUTE_
        # TEMPLATES row 0) — every call below supplies it.
        EAD = {"ead_filed_date": "2031-01-15"}
        tl_ids: list[str] = []
        try:
            t1 = M.find_or_create_group(db, ids["a"], "Fall 2031 STEM OPT cohort",
                                        {"tags": ["stem-opt-extension"],
                                         "key_stages_or_info": {"filing_month": "Sep", "filing_year": "2031"}},
                                        [], "timeline", "Fall 2031 STEM OPT cohort", values=EAD)
            tl_ids.append(t1["group_id"])
            check("B37 create Timeline group + description saved",
                  t1["joined"] is False and t1["description"] == "Fall 2031 STEM OPT cohort",
                  f"joined={t1['joined']} desc={t1['description']!r}")

            t2 = M.find_or_create_group(db, ids["b"], "same cohort", {
                "tags": ["stem-opt-extension"],
                "key_stages_or_info": {"filing_month": "Sep", "filing_year": "2031"}}, [], "timeline", values=EAD)
            check("B38 identical criteria (diff user) JOINS the same Timeline group",
                  t2["joined"] is True and t2["group_id"] == t1["group_id"], str(t2))

            t3 = M.find_or_create_group(db, ids["c"], "different year, same processing type", {
                "tags": ["stem-opt-extension"],
                "key_stages_or_info": {"filing_month": "Sep", "filing_year": "2032"}}, [], "timeline", values=EAD)
            if t3["group_id"] not in tl_ids:
                tl_ids.append(t3["group_id"])
            check("B39 same processing type, DIFFERENT year -> creates a NEW group (the bug this fixes)",
                  t3["joined"] is False and t3["group_id"] != t1["group_id"], str(t3))

            # B40: a request that leaves Cycle/Year unset entirely computes a
            # DIFFERENT name ("stem-opt-extension" alone, vs. T1's
            # "...-Sep-2031") — so it must NOT be treated as a duplicate of
            # T1, even though both are the same processing type.
            t4 = M.find_or_create_group(db, ids["d"], "no cycle/year picked yet",
                                        {"tags": ["stem-opt-extension"]}, [], "timeline", values=EAD)
            if t4["group_id"] not in tl_ids:
                tl_ids.append(t4["group_id"])
            check("B40 partial (no Cycle/Year) criteria does NOT match a fully-specified Timeline group",
                  t4["joined"] is False and t4["group_id"] not in (t1["group_id"], t3["group_id"]), str(t4))

            # B40b: name-based dedup means an incidental EXTRA unrelated tag
            # no longer prevents a same-name collision — under the old
            # full-criteria _exact_match() comparison this would have been
            # treated as a different group; now it correctly joins T1, since
            # the extra tag doesn't feed the computed name at all.
            t1b = M.find_or_create_group(db, ids["a"], "same cohort but with an extra unrelated tag", {
                "tags": ["stem-opt-extension", "rfe-experience"],
                "key_stages_or_info": {"filing_month": "Sep", "filing_year": "2031"}}, [], "timeline", values=EAD)
            check("B40b an incidental extra tag no longer prevents a same-name Timeline collision",
                  t1b["joined"] is True and t1b["group_id"] == t1["group_id"], str(t1b))

            # B41: Regular groups are unaffected — still the coarse
            # _signature() lookup (unrelated tags don't create new groups).
            r1 = M.find_or_create_group(db, ids["a"], "regular r1",
                                        {"current_visa_or_greencard_category": ["SB-1"]}, [], "")
            r2 = M.find_or_create_group(db, ids["b"], "regular r2, extra unrelated tag",
                                        {"current_visa_or_greencard_category": ["SB-1"], "tags": ["rfe-experience"]}, [], "")
            check("B41 Regular groups still use the coarse _signature() lookup (unchanged)",
                  r2["joined"] is True and r2["group_id"] == r1["group_id"], str((r1, r2)))
            if not r1["joined"]:
                db.collection("groups").document(r1["group_id"]).delete()

            # B42: _find_by_signature() bug fix — group_type is now part of
            # the lookup key, so two groups of DIFFERENT types sharing the
            # same coarse signature (this live Firestore project has plenty
            # of pre-existing empty-signature groups, so this seeds two
            # docs with a deliberately unique shared signature rather than
            # relying on a naturally-empty one) must resolve to DIFFERENT
            # docs, not cross-match each other.
            uniq_sig = f"test-b42-sig-{secrets.token_hex(4)}"
            seed_reg = _seed_group(db, ids["a"], "seed regular", {}, "")
            seed_tl = _seed_group(db, ids["b"], "seed timeline", {}, "timeline")
            db.collection("groups").document(seed_reg["group_id"]).update({"signature": uniq_sig})
            db.collection("groups").document(seed_tl["group_id"]).update({"signature": uniq_sig})
            try:
                found_reg = M._find_by_signature(db, uniq_sig, "")
                found_tl = M._find_by_signature(db, uniq_sig, "timeline")
                check("B42 _find_by_signature scopes by group_type — same signature, different types resolve to different docs",
                      found_reg is not None and found_tl is not None
                      and found_reg.id == seed_reg["group_id"] and found_tl.id == seed_tl["group_id"],
                      f"reg={found_reg.id if found_reg else None} want={seed_reg['group_id']}; "
                      f"tl={found_tl.id if found_tl else None} want={seed_tl['group_id']}")
            finally:
                db.collection("groups").document(seed_reg["group_id"]).delete()
                db.collection("groups").document(seed_tl["group_id"]).delete()
        finally:
            for tgid in tl_ids:
                db.collection("groups").document(tgid).delete()
    finally:
        for uid in ids.values():
            db.collection("users").document(uid).delete()
        if gid:
            db.collection("groups").document(gid).delete()
        print("  cleaned up test docs")


# ---------------------------------------------------------------------------
# L — live Firestore: group lifecycle (validity/expiration, archive, soft
# delete's effect on join/search/dedup)
# ---------------------------------------------------------------------------

def group_l_lifecycle() -> None:
    print("\nL — live Firestore: group lifecycle (integration)")
    from datetime import datetime, timedelta, timezone
    from google.cloud import firestore
    db = firestore.Client(project=PROJECT)

    ids = {k: f"test-lifecycle-{k}-{secrets.token_hex(3)}" for k in ("a", "b", "c")}
    db.collection("users").document(ids["a"]).set({"username": "lc-alpha"})
    db.collection("users").document(ids["b"]).set({"username": "lc-bravo"})
    db.collection("users").document(ids["c"]).set({"username": "lc-charlie"})
    gids: list[str] = []
    try:
        now = datetime.now(timezone.utc)
        # Distinctive, out-of-the-ordinary criteria per group so this shared
        # dev Firestore's pre-existing groups can never collide/auto-join
        # into these: Timeline groups use unrealistic Cycle/Year pairs
        # (dedup is exact-match on the full criteria_tags); Regular groups
        # use the rare "SIV" greencard category paired with an obscure
        # consulate each (dedup is coarse visa+consulate _signature()).
        g1_criteria = {"tags": ["stem-opt-extension"],
                       "key_stages_or_info": {"filing_month": "Sep", "filing_year": "2098"}}
        g2_criteria = {"current_visa_or_greencard_category": ["SIV"], "consulates": ["ASB"]}
        g5_criteria = {"current_visa_or_greencard_category": ["SIV"], "consulates": ["LFW"]}
        gname_criteria = {"tags": ["stem-opt-extension"],
                          "key_stages_or_info": {"filing_month": "Mar", "filing_year": "2097"}}
        EAD = {"ead_filed_date": "2098-01-15"}  # stem-opt-extension's required post-join attribute

        # L1-L2: validity -> expiration_date, default validity
        g1 = M.find_or_create_group(db, ids["a"], "1-month timeline group", g1_criteria, [], "timeline", "", "1_month", values=EAD)
        gids.append(g1["group_id"])
        exp1 = datetime.fromisoformat(g1["expiration_date"])
        check("L1 validity='1_month' sets expiration_date ~30 days out",
              abs((exp1 - now).days - 30) <= 1 and g1["status"] == "active", g1["expiration_date"])

        g2 = M.find_or_create_group(db, ids["b"], "default-validity regular group", g2_criteria, [], "")
        gids.append(g2["group_id"])
        exp2 = datetime.fromisoformat(g2["expiration_date"])
        check("L2 omitted validity defaults to '1_year' (~365 days)",
              abs((exp2 - now).days - 365) <= 1, g2["expiration_date"])

        # L3-L5: validity validation
        try:
            M.find_or_create_group(db, ids["a"], "bad validity for timeline",
                                   {"tags": ["stem-opt-extension"],
                                    "key_stages_or_info": {"filing_month": "Sep", "filing_year": "2096"}},
                                   [], "timeline", "", "5_years", values=EAD)
            check("L3 a Regular-only validity ('5_years') is rejected for a Timeline group", False, "no raise")
        except ValueError:
            check("L3 a Regular-only validity ('5_years') is rejected for a Timeline group", True)
        try:
            M.find_or_create_group(db, ids["a"], "garbage validity",
                                   {"current_visa_or_greencard_category": ["SIV"], "consulates": ["TAS"]},
                                   [], "", "", "not-a-real-option")
            check("L4 a nonsense validity string is rejected", False, "no raise")
        except ValueError:
            check("L4 a nonsense validity string is rejected", True)
        g5 = M.find_or_create_group(db, ids["a"], "5-year regular group", g5_criteria, [], "", "", "5_years")
        gids.append(g5["group_id"])
        exp5 = datetime.fromisoformat(g5["expiration_date"])
        check("L5 '5_years' is accepted for a Regular group (~1826 days)",
              abs((exp5 - now).days - 1826) <= 1, g5["expiration_date"])

        # L6: created_by_username
        check("L6 _group_view resolves created_by_username from the members list",
              g1["created_by_username"] == "lc-alpha", g1["created_by_username"])

        # L7: Timeline default naming end-to-end (via find_or_create_group, not just the pure helper)
        gname = M.find_or_create_group(db, ids["a"], "named timeline group", gname_criteria, [], "timeline", values=EAD)
        gids.append(gname["group_id"])
        check("L7 a Timeline group created end-to-end gets the <type>-<month>-<year> name",
              gname["name"] == "stem-opt-extension-Mar-2097", gname["name"])

        # L8-L11: archive_group permissions + transitions
        try:
            M.archive_group(db, g1["group_id"], ids["b"], True)
            check("L8 archive_group by a non-creator raises PermissionError", False, "no raise")
        except PermissionError:
            check("L8 archive_group by a non-creator raises PermissionError", True)
        archived = M.archive_group(db, g1["group_id"], ids["a"], True)
        check("L9 archive_group by the creator sets status to archived", archived["status"] == "archived", archived["status"])
        unarchived = M.archive_group(db, g1["group_id"], ids["a"], False)
        check("L10 unarchiving (archived=False) sets status back to active", unarchived["status"] == "active", unarchived["status"])
        try:
            M.archive_group(db, "no-such-group-xyz", ids["a"], True)
            check("L11 archive_group on a missing group raises KeyError", False, "no raise")
        except KeyError:
            check("L11 archive_group on a missing group raises KeyError", True)

        # L12: archive_group rejects an already-deleted group
        M.delete_group(db, g5["group_id"], ids["a"])
        try:
            M.archive_group(db, g5["group_id"], ids["a"], True)
            check("L12 archive_group on an already-deleted group raises ValueError", False, "no raise")
        except ValueError:
            check("L12 archive_group on an already-deleted group raises ValueError", True)

        # L13-L14: an archived group is excluded from search_groups() and rejects join_group()
        M.archive_group(db, g1["group_id"], ids["a"], True)
        surfaced = {g["group_id"] for g in M.search_groups(db, g1_criteria, "timeline")}
        check("L13 an archived group never surfaces in search_groups()", g1["group_id"] not in surfaced)
        try:
            M.join_group(db, g1["group_id"], ids["c"])
            check("L14 join_group on an archived group raises ValueError", False, "no raise")
        except ValueError:
            check("L14 join_group on an archived group raises ValueError", True)

        # L15: join_group on a soft-deleted group also raises ValueError (doc
        # still physically exists — join_group reads it directly, not via
        # list_all_groups()'s filter)
        try:
            M.join_group(db, g5["group_id"], ids["c"])
            check("L15 join_group on a soft-deleted group raises ValueError", False, "no raise")
        except ValueError:
            check("L15 join_group on a soft-deleted group raises ValueError", True)

        # L16: find_or_create_group's dedup skips an archived Timeline
        # duplicate and creates a fresh group rather than reviving it.
        fresh = M.find_or_create_group(db, ids["c"], "same cohort, but the old one is archived", g1_criteria, [], "timeline", values=EAD)
        gids.append(fresh["group_id"])
        check("L16 find_or_create_group opens a NEW group instead of rejoining an archived Timeline duplicate",
              fresh["joined"] is False and fresh["group_id"] != g1["group_id"], str(fresh))

        # L17: same, for a Regular group's coarse _signature() dedup path
        M.archive_group(db, g2["group_id"], ids["b"], True)
        fresh_reg = M.find_or_create_group(db, ids["c"], "same signature, but the old regular group is archived", g2_criteria, [], "")
        gids.append(fresh_reg["group_id"])
        check("L17 find_or_create_group opens a NEW group instead of rejoining an archived Regular duplicate",
              fresh_reg["joined"] is False and fresh_reg["group_id"] != g2["group_id"], str(fresh_reg))

        # L18: an "active"-status group whose expiration_date has already
        # passed is lazily reported/treated as archived — search + dedup
        # both honor this without any write happening.
        db.collection("groups").document(gname["group_id"]).update(
            {"expiration_date": (now - timedelta(days=1)).isoformat()})
        surfaced2 = {g["group_id"] for g in M.search_groups(db, gname_criteria, "timeline")}
        check("L18 an expired-but-stored-active group is excluded from search_groups() (lazy status)",
              gname["group_id"] not in surfaced2)
        fresh_expired = M.find_or_create_group(db, ids["b"], "same cohort, but the old one just expired", gname_criteria, [], "timeline", values=EAD)
        gids.append(fresh_expired["group_id"])
        check("L19 find_or_create_group opens a NEW group instead of rejoining an expired-but-active-status duplicate",
              fresh_expired["joined"] is False and fresh_expired["group_id"] != gname["group_id"], str(fresh_expired))
    finally:
        for uid in ids.values():
            db.collection("users").document(uid).delete()
        for gid in gids:
            db.collection("groups").document(gid).delete()
        print("  cleaned up lifecycle test docs")


# ---------------------------------------------------------------------------
# C — HTTP API via TestClient
# ---------------------------------------------------------------------------

def group_c_api() -> None:
    print("\nC — HTTP API via TestClient (integration)")
    from fastapi.testclient import TestClient
    from google.cloud import firestore
    import api
    api.RATE_LIMIT_MAX = 100000

    db = firestore.Client(project=PROJECT)
    test_uid = f"test-match-api-{secrets.token_hex(3)}"
    A = {"X-User-Id": "demo-arjun"}
    created_groups: list[str] = []
    try:
        db.collection("users").document(test_uid).set(
            {"username": "apitest", "current_visa_or_greencard_category": ["H-1B"], "consulates": ["BOM"]})
        with TestClient(api.app) as c:
            check("C1 find/matches without user → 400",
                  c.post("/api/find/matches", json={"criteria": {}}).status_code == 400)
            check("C2 groups list without user → 400", c.get("/api/groups").status_code == 400)
            check("C3 unknown user → 404",
                  c.post("/api/find/matches", json={"criteria": {}},
                         headers={"X-User-Id": "ghost"}).status_code == 404)

            r = c.post("/api/find/matches",
                       json={"criteria": {"current_visa_or_greencard_category": ["H-1B"], "consulates": ["BOM"]}},
                       headers=A)
            by = {m["user_id"]: m for m in r.json().get("matches", [])}
            check("C4 matches 200 + excludes self + finds the test peer",
                  r.status_code == 200 and "demo-arjun" not in by and test_uid in by, f"status={r.status_code}")

            # C5: non-distinctive (no visa/consulate/country) criteria used to
            # 422 — that guard was removed, so this now creates/joins normally.
            nd = c.post("/api/groups", json={"criteria_text": "x", "criteria": {}, "members": []}, headers=A)
            ndj = nd.json()
            if ndj.get("group_id") and not ndj.get("joined"):
                created_groups.append(ndj["group_id"])
            check("C5 create group with non-distinctive criteria → 200",
                  nd.status_code == 200 and bool(ndj.get("group_id")), f"status={nd.status_code}")

            g = c.post("/api/groups", json={
                "criteria_text": "H-1B at Mumbai",
                "criteria": {"current_visa_or_greencard_category": ["H-1B"], "consulates": ["BOM"]},
                "members": [{"user_id": test_uid, "username": "apitest"}],
            }, headers=A)
            gj = g.json()
            if gj.get("group_id"):
                created_groups.append(gj["group_id"])
            mids = {m["user_id"] for m in gj.get("members", [])}
            check("C6 create 200 + name + only the creator as a member + not joined "
                  "(the peer is invited, not added)",
                  g.status_code == 200 and gj.get("group_id") and gj.get("name")
                  and mids == {"demo-arjun"} and gj.get("joined") is False, f"status={g.status_code} members={mids}")
            check("C6b …and the peer comes back in `invited`",
                  [i["user_id"] for i in gj.get("invited", [])] == [test_uid], str(gj.get("invited")))

            # same signature again as mei → JOINs the existing group
            g2 = c.post("/api/groups", json={
                "criteria_text": "same boat",
                "criteria": {"current_visa_or_greencard_category": ["H-1B"], "consulates": ["BOM"]},
                "members": [],
            }, headers={"X-User-Id": "demo-mei"})
            g2j = g2.json()
            check("C7 same-signature create → joined existing (same id, joined=true)",
                  g2j.get("group_id") == gj.get("group_id") and g2j.get("joined") is True, str(g2j.get("joined")))

            mine = c.get("/api/groups", headers=A).json().get("groups", [])
            check("C8 GET /api/groups returns groups I'm a member of",
                  any(x["group_id"] == gj.get("group_id") for x in mine))

            allg = c.get("/api/groups/all", headers={"X-User-Id": "demo-sofia"}).json().get("groups", [])
            mine_in_all = next((x for x in allg if x["group_id"] == gj.get("group_id")), {})
            check("C9 GET /api/groups/all browse + is_member False for sofia",
                  bool(mine_in_all) and mine_in_all.get("is_member") is False)

            j = c.post(f"/api/groups/{gj.get('group_id')}/join", headers={"X-User-Id": "demo-sofia"})
            jj = j.json()
            check("C10 POST /{id}/join adds the user (joined=true, is_member)",
                  j.status_code == 200 and jj.get("joined") is True
                  and "demo-sofia" in {m["user_id"] for m in jj.get("members", [])}, f"status={j.status_code}")
            check("C11 join unknown group → 404",
                  c.post("/api/groups/no-such-group/join", headers=A).status_code == 404)

            gid = gj.get("group_id")
            # C12-C13: PUT rename — creator-only
            check("C12 PUT rename by non-creator → 403",
                  c.put(f"/api/groups/{gid}", json={"name": "Hijacked"},
                        headers={"X-User-Id": test_uid}).status_code == 403)
            ren = c.put(f"/api/groups/{gid}", json={"name": "API Renamed", "description": "desc via API"}, headers=A)
            check("C13 PUT rename by creator → 200, name + description updated",
                  ren.status_code == 200 and ren.json().get("name") == "API Renamed"
                  and ren.json().get("description") == "desc via API", f"status={ren.status_code}")

            # C14-C16: POST invite — member-only, handle-based
            check("C14 POST invite by non-member → 403",
                  c.post(f"/api/groups/{gid}/invite", json={"handle": "apitest"},
                         headers={"X-User-Id": "demo-omar"}).status_code == 403)
            check("C15 POST invite of an unknown handle → 422",
                  c.post(f"/api/groups/{gid}/invite", json={"handle": "no-such-handle"}, headers=A).status_code == 422)
            inv = c.post(f"/api/groups/{gid}/invite", json={"handle": "omar-b1b2"}, headers=A)
            check("C16 POST invite of a known handle → 200 and returns a pending InvitationCard "
                  "(the invitee is NOT added until they accept)",
                  inv.status_code == 200 and inv.json().get("status") == "pending"
                  and inv.json().get("user_id") == "demo-omar", f"status={inv.status_code} body={inv.json()}")
            # Accept so the later leave/admin-reassignment checks still have a
            # second member to reassign to.
            c.post(f"/api/groups/{gid}/invitations/accept", json={}, headers={"X-User-Id": "demo-omar"})

            # C17: POST leave — the creator leaving reassigns admin
            lv = c.post(f"/api/groups/{gid}/leave", headers=A)
            check("C17 POST leave (creator) → 200, admin reassigned to a remaining member",
                  lv.status_code == 200 and "demo-arjun" not in {m["user_id"] for m in lv.json().get("members", [])}
                  and lv.json().get("created_by") in {m["user_id"] for m in lv.json().get("members", [])},
                  f"status={lv.status_code} body={lv.json()}")
            check("C18 leave unknown group → 404",
                  c.post("/api/groups/no-such-group/leave", headers=A).status_code == 404)

            new_admin_c = lv.json().get("created_by")
            NA = {"X-User-Id": new_admin_c}
            members_after_17 = {m["user_id"] for m in lv.json().get("members", [])}

            # C19-C20: rename/invite 404 on a missing group (mirrors join/leave above).
            check("C19 PUT rename on a missing group → 404",
                  c.put("/api/groups/no-such-group", json={"name": "x"}, headers=NA).status_code == 404)
            check("C20 POST invite on a missing group → 404",
                  c.post("/api/groups/no-such-group/invite", json={"handle": "apitest"},
                         headers=NA).status_code == 404)

            # C21: Pydantic's min_length=1 on GroupInvite.handle rejects an empty
            # handle before the route body ever calls invite_member.
            check("C21 POST invite with an empty handle → 422 (request validation)",
                  c.post(f"/api/groups/{gid}/invite", json={"handle": ""}, headers=NA).status_code == 422)

            # C22: inviting a handle that's already a member is now an explicit
            # 422 rather than the old silent dedup no-op. "apitest" was a PEER
            # at creation (C6), so they're only invited — accept first so this
            # really exercises the already-a-member path.
            c.post(f"/api/groups/{gid}/invitations/accept", json={}, headers={"X-User-Id": test_uid})
            re_inv = c.post(f"/api/groups/{gid}/invite", json={"handle": "apitest"}, headers=NA)
            check("C22 POST invite of an already-member handle → 422",
                  re_inv.status_code == 422, f"status={re_inv.status_code} body={re_inv.json()}")

            # C23: leaving a group you already left (non-member) is a harmless
            # 200 no-op, not a 403/404 — leave_group only ever filters, never checks.
            # Re-baseline: the C22 accept above legitimately added a member, so
            # members_after_17 is stale by this point.
            members_before_23 = {m["user_id"] for m in
                                 c.get(f"/api/groups/{gid}", headers=NA).json().get("members", [])}
            relv = c.post(f"/api/groups/{gid}/leave", headers=A)
            check("C23 leave by a non-member (already left) → 200, membership unchanged",
                  relv.status_code == 200
                  and {m["user_id"] for m in relv.json().get("members", [])} == members_before_23,
                  f"status={relv.status_code}")

            # C24: an empty PUT body updates neither field (only `updated_at`).
            noop = c.put(f"/api/groups/{gid}", json={}, headers=NA)
            check("C24 PUT rename with an empty body → 200, name/description unchanged",
                  noop.status_code == 200 and noop.json().get("name") == ren.json().get("name")
                  and noop.json().get("description") == ren.json().get("description"),
                  f"status={noop.status_code}")

            # C25: a whitespace-only name is a 422 (ValueError from rename_group).
            check("C25 PUT rename with a whitespace-only name → 422",
                  c.put(f"/api/groups/{gid}", json={"name": "   "}, headers=NA).status_code == 422)

            # C26-C28: DELETE — creator-only, group (and messages) gone after.
            check("C26 DELETE by a non-creator → 403",
                  c.delete(f"/api/groups/{gid}", headers=A).status_code == 403)
            check("C27 DELETE on a missing group → 404",
                  c.delete("/api/groups/no-such-group", headers=NA).status_code == 404)
            dele = c.delete(f"/api/groups/{gid}", headers=NA)
            check("C28 DELETE by the creator → 200 {ok:true}, group is gone",
                  dele.status_code == 200 and dele.json().get("ok") is True
                  and c.get(f"/api/groups/{gid}", headers=NA).status_code == 404,
                  f"status={dele.status_code} body={dele.json()}")

            # C29: the orphan-leak fix, exercised over HTTP end-to-end — the sole
            # member POSTing /leave deletes the group, not just empties it.
            solo = c.post("/api/groups", json={
                "criteria_text": "solo group for HTTP leave-deletes-group check",
                "criteria": {"current_visa_or_greencard_category": ["SIV"]},
                "members": [],
            }, headers=A)
            solo_gid = solo.json().get("group_id")
            if solo.json().get("joined"):
                check("C29 POST leave as the sole member deletes the group (HTTP)", False,
                      "signature collided with a real existing group — skipped")
            else:
                created_groups.append(solo_gid)
                solo_leave = c.post(f"/api/groups/{solo_gid}/leave", headers=A)
                check("C29 POST leave as the sole member deletes the group (HTTP)",
                      solo_leave.status_code == 200
                      and c.get(f"/api/groups/{solo_gid}", headers=A).status_code == 404,
                      f"leave_status={solo_leave.status_code}")

            # C30-C34: validity → status/expiration_date on the create response,
            # and the new /api/groups/{id}/archive route end to end.
            lc = c.post("/api/groups", json={
                "criteria_text": "lifecycle HTTP test group",
                "criteria": {"current_visa_or_greencard_category": ["SIV"], "consulates": ["EBB"]},
                "members": [], "validity": "3_months",
            }, headers=NA)
            lcj = lc.json()
            if lcj.get("group_id") and not lcj.get("joined"):
                created_groups.append(lcj["group_id"])
            check("C30 create response carries status='active' and a non-empty expiration_date",
                  lc.status_code == 200 and lcj.get("status") == "active" and bool(lcj.get("expiration_date")),
                  f"status={lc.status_code} body_status={lcj.get('status')} exp={lcj.get('expiration_date')!r}")
            lc_gid = lcj.get("group_id")

            check("C31 POST /{id}/archive by a non-creator → 403",
                  c.post(f"/api/groups/{lc_gid}/archive", json={"archived": True}, headers=A).status_code == 403)
            check("C32 POST /{id}/archive on a missing group → 404",
                  c.post("/api/groups/no-such-group/archive", json={"archived": True}, headers=NA).status_code == 404)
            arch = c.post(f"/api/groups/{lc_gid}/archive", json={"archived": True}, headers=NA)
            check("C33 POST /{id}/archive by the creator → 200, status becomes archived",
                  arch.status_code == 200 and arch.json().get("status") == "archived",
                  f"status={arch.status_code} body={arch.json()}")
            check("C34 join on the now-archived group → 422",
                  c.post(f"/api/groups/{lc_gid}/join", headers=A).status_code == 422)

            # C35: archiving an already-deleted group → 422 (gid was DELETEd at C28)
            check("C35 POST /{id}/archive on an already-deleted group → 422",
                  c.post(f"/api/groups/{gid}/archive", json={"archived": True}, headers=NA).status_code == 422)
    finally:
        db.collection("users").document(test_uid).delete()
        for gid in created_groups:
            db.collection("groups").document(gid).delete()
        print("  cleaned up API test docs")


def group_d_dates() -> None:
    print("\nD — date matching (pure): exact, approximate windows, parsing care")
    base = "2022-01-01"

    # proximity buckets (scenario 4 — what closeness makes a match)
    check("D1 exact date proximity = 1.5", M._date_proximity(base, "2022-01-01") == M._DATE_EXACT)
    check("D2 ±20d within 30 → 1.0", M._date_proximity(base, "2022-01-21") == 1.0)
    check("D3 ±75d within 90 → 0.6", M._date_proximity(base, "2022-03-17") == 0.6)
    check("D4 ±150d within 180 → 0.3", M._date_proximity(base, "2022-05-31") == 0.3)
    check("D5 ±400d beyond window → 0.0", M._date_proximity(base, "2023-02-05") == 0.0)
    check("D6 proximity is symmetric",
          M._date_proximity(base, "2022-02-10") == M._date_proximity("2022-02-10", base))

    # scenario 5 — careful parsing: blank/None/malformed/other-format never crash
    for bad in ("", "not-a-date", None, "2022-13-40", "02/01/2022"):
        check(f"D7 malformed date {bad!r} → 0 proximity (no crash)", M._date_proximity(base, bad) == 0.0)

    sc = lambda pd: M._score({"key_dates": {"priority_date": base}}, {"key_dates": {"priority_date": pd}})["score"]
    check("D8 exact date-only reaches MIN_SCORE (a match)", sc("2022-01-01") >= M.MIN_SCORE)
    check("D9 ±20d date-only reaches MIN_SCORE (APPROXIMATE match)", sc("2022-01-21") >= M.MIN_SCORE)
    check("D10 ±60d date-only below MIN_SCORE (not a match alone)", sc("2022-03-02") < M.MIN_SCORE)
    check("D11 far shared key keeps a floor (same milestone, different timing)", sc("2025-01-01") == M._DATE_FLOOR)

    # scenario 3 — dates must be the SAME milestone key
    diffkey = M._score({"key_dates": {"priority_date": base}}, {"key_dates": {"visa_interview_date": base}})
    check("D12 different date key → no credit + not shared", diffkey["score"] == 0.0 and diffkey["shared"] == [])

    multi = M._score({"key_dates": {"priority_date": base, "i140_approved_date": "2023-01-01"}},
                     {"key_dates": {"priority_date": base, "i140_approved_date": "2023-01-20"}})
    check("D13 multiple shared dates sum (exact 1.5 + approx 1.0 = 2.5)", abs(multi["score"] - 2.5) < 0.01, str(multi["score"]))
    check("D14 labels mark exact vs approximate",
          "priority_date(exact)" in multi["shared"] and "i140_approved_date(~)" in multi["shared"], str(multi["shared"]))

    near = M._score({"current_visa_or_greencard_category": ["H-1B"], "key_dates": {"priority_date": base}},
                    {"current_visa_or_greencard_category": ["H-1B"], "key_dates": {"priority_date": "2022-01-10"}})["score"]
    far = M._score({"current_visa_or_greencard_category": ["H-1B"], "key_dates": {"priority_date": base}},
                   {"current_visa_or_greencard_category": ["H-1B"], "key_dates": {"priority_date": "2025-01-10"}})["score"]
    check("D15 date proximity is a bonus on top of visa; closer ranks higher",
          abs(near - 4.0) < 0.01 and abs(far - 3.1) < 0.01 and near > far, f"near={near} far={far}")


def group_e_merge_match() -> None:
    print("\nE — merge profile+criteria, positive/negative matching (integration)")
    from google.cloud import firestore
    import reconcile as rc
    db = firestore.Client(project=PROJECT)

    ids = {k: f"test-mm-{k}-{secrets.token_hex(3)}" for k in ("eb2", "h1b", "both", "none")}
    seeds = {
        ids["eb2"]:  {"username": "eb2only", "visa_applying_for": ["EB-2"], "consulates": ["BOM"]},
        ids["h1b"]:  {"username": "h1bonly", "current_visa_or_greencard_category": ["H-1B"]},
        ids["both"]: {"username": "bothvisa", "current_visa_or_greencard_category": ["H-1B"],
                      "visa_applying_for": ["EB-2"], "consulates": ["BOM"]},
        ids["none"]: {"username": "unrelated", "current_visa_or_greencard_category": ["F-1"], "consulates": ["LON"]},
    }
    saved_profile = {"current_visa_or_greencard_category": ["H-1B"]}   # what's in the profile
    criteria = {"visa_applying_for": ["EB-2"], "consulates": ["BOM"]}  # different — what they typed here
    try:
        for uid, p in seeds.items():
            db.collection("users").document(uid).set(p)

        # scenario 2 — positive / negative on the ENTERED criteria
        by_crit = {m["user_id"]: m for m in M.find_matches(db, "demo-arjun", criteria)}
        check("E1 positive: EB-2/BOM peers matched", ids["eb2"] in by_crit and ids["both"] in by_crit)
        check("E2 negative: unrelated (F-1/LON) NOT matched", ids["none"] not in by_crit)
        check("E3 negative: H-1B-only NOT matched by EB-2/BOM criteria", ids["h1b"] not in by_crit)
        check("E4 only criteria∩profile counts: extra H-1B (not in criteria) doesn't inflate; both ties eb2-only at 4.5",
              abs(by_crit[ids["both"]]["score"] - by_crit[ids["eb2"]]["score"]) < 0.01
              and abs(by_crit[ids["eb2"]]["score"] - 4.5) < 0.01,
              f'both={by_crit[ids["both"]]["score"]} eb2={by_crit[ids["eb2"]]["score"]}')

        # scenario 1 — profile differs; MERGE profile+criteria, then match on merged
        merged = rc.reconcile_profile_message(saved_profile, criteria)["merged"]
        check("E5 merged = profile H-1B ∪ criteria EB-2/BOM",
              "H-1B" in (merged.get("current_visa_or_greencard_category") or [])
              and "EB-2" in (merged.get("visa_applying_for") or [])
              and "BOM" in (merged.get("consulates") or []))
        by_merged = {m["user_id"]: m for m in M.find_matches(db, "demo-arjun", merged)}
        check("E6 merge brings in the profile-only (H-1B) peer", ids["h1b"] in by_merged)
        check("E7 merged matches ⊇ criteria-only matches, and add H-1B peer",
              set(by_crit) <= set(by_merged) and ids["h1b"] in (set(by_merged) - set(by_crit)))
    finally:
        for uid in ids.values():
            db.collection("users").document(uid).delete()
        print("  cleaned up merge-match test docs")


def group_f_dates_match() -> None:
    print("\nF — date matching end-to-end via find_matches (integration)")
    from google.cloud import firestore
    db = firestore.Client(project=PROJECT)

    pd = "2022-01-01"
    ids = {k: f"test-dt-{k}-{secrets.token_hex(3)}" for k in ("exact", "near", "far", "key2", "dateonly")}
    seeds = {
        ids["exact"]: {"username": "exactpd", "current_visa_or_greencard_category": ["H-1B"], "key_dates": {"priority_date": pd}},
        ids["near"]:  {"username": "nearpd", "current_visa_or_greencard_category": ["H-1B"], "key_dates": {"priority_date": "2022-01-20"}},
        ids["far"]:   {"username": "farpd", "current_visa_or_greencard_category": ["H-1B"], "key_dates": {"priority_date": "2024-06-01"}},
        ids["key2"]:  {"username": "otherdate", "current_visa_or_greencard_category": ["H-1B"], "key_dates": {"visa_interview_date": pd}},
        ids["dateonly"]: {"username": "dateonly", "key_dates": {"priority_date": "2022-01-15"}},  # no visa, +14d
    }
    crit = {"current_visa_or_greencard_category": ["H-1B"], "key_dates": {"priority_date": pd}}
    try:
        for uid, p in seeds.items():
            db.collection("users").document(uid).set(p)

        by = {m["user_id"]: m for m in M.find_matches(db, "demo-arjun", crit)}
        check("F1 exact > near > far by date proximity (all share H-1B)",
              by[ids["exact"]]["score"] > by[ids["near"]]["score"] > by[ids["far"]]["score"],
              f'exact={by[ids["exact"]]["score"]} near={by[ids["near"]]["score"]} far={by[ids["far"]]["score"]}')
        check("F2 exact priority_date labeled (exact)", "priority_date(exact)" in by[ids["exact"]]["shared"])
        check("F3 near priority_date labeled (~) approximate", "priority_date(~)" in by[ids["near"]]["shared"])
        check("F4 different date key → matches on visa only, no date credit",
              ids["key2"] in by and abs(by[ids["key2"]]["score"] - 3.0) < 0.01
              and not any("priority_date" in s for s in by[ids["key2"]]["shared"]))

        # scenario 4 — date-only criteria: which approximate date alone qualifies
        by2 = {m["user_id"]: m for m in M.find_matches(db, "demo-arjun", {"key_dates": {"priority_date": pd}})}
        check("F5 date-only: within-30d peer IS a match (no shared visa needed)", ids["dateonly"] in by2)
        check("F6 date-only: far peer is NOT a match", ids["far"] not in by2)
    finally:
        for uid in ids.values():
            db.collection("users").document(uid).delete()
        print("  cleaned up date-match test docs")


def group_g_match_criteria() -> None:
    print("\nG — positive / negative matching across every criteria dimension (pure)")
    S = lambda c, p: M._score(c, p)["score"]

    # --- visa / category ---
    crit = {"current_visa_or_greencard_category": ["H-1B", "L-1"]}
    check("G1 one of two visas shared → 3.0 (partial positive)",
          S(crit, {"current_visa_or_greencard_category": ["H-1B"]}) == 3.0)
    check("G2 both visas shared → 6.0 (full positive)",
          S(crit, {"current_visa_or_greencard_category": ["H-1B", "L-1"]}) == 6.0)
    check("G3 no visa overlap → 0.0 (negative)",
          S(crit, {"current_visa_or_greencard_category": ["F-1"]}) == 0.0)
    check("G4 cross-field current↔applying matches the same code (same journey stage)",
          S({"current_visa_or_greencard_category": ["H-1B"]}, {"visa_applying_for": ["H-1B"]}) == 3.0)

    # --- consulates ---
    check("G5 primary_consulate ↔ consulates cross-field matches",
          S({"primary_consulate": "BOM"}, {"consulates": ["BOM"]}) == 1.5)
    check("G6 partial consulate overlap [BOM,DEL] vs [DEL,MAA] → 1.5 (shares DEL)",
          S({"consulates": ["BOM", "DEL"]}, {"consulates": ["DEL", "MAA"]}) == 1.5)
    check("G7 no consulate overlap → 0.0 (negative)",
          S({"consulates": ["BOM"]}, {"consulates": ["LON"]}) == 0.0)

    # --- status facts (key_stages_or_info) ---
    check("G8 same status fact (visa_status=approved) → 1.0 (positive)",
          S({"key_stages_or_info": {"visa_status": "approved"}}, {"key_stages_or_info": {"visa_status": "approved"}}) == 1.0)
    check("G9 same key, different value → 0.0 (negative)",
          S({"key_stages_or_info": {"visa_status": "approved"}}, {"key_stages_or_info": {"visa_status": "pending"}}) == 0.0)
    check("G10 different status key → 0.0 (negative)",
          S({"key_stages_or_info": {"visa_status": "approved"}}, {"key_stages_or_info": {"case_status": "approved"}}) == 0.0)
    check("G11 same citizen_of_country → 1.0 (positive); different → 0.0 (negative)",
          S({"key_stages_or_info": {"citizen_of_country": "IN"}}, {"key_stages_or_info": {"citizen_of_country": "IN"}}) == 1.0
          and S({"key_stages_or_info": {"citizen_of_country": "IN"}}, {"key_stages_or_info": {"citizen_of_country": "CN"}}) == 0.0)

    # --- thresholds / edges ---
    check("G12 a single status fact reaches MIN_SCORE (1.0)", 1.0 >= M.MIN_SCORE)
    check("G13 empty criteria vs anything → 0.0 (no match)",
          S({}, {"current_visa_or_greencard_category": ["H-1B"], "consulates": ["BOM"]}) == 0.0)
    check("G14 anything vs empty profile → 0.0 (no match)",
          S({"current_visa_or_greencard_category": ["H-1B"], "consulates": ["BOM"]}, {}) == 0.0)

    # --- combined ---
    full = M._score(
        {"current_visa_or_greencard_category": ["H-1B"], "consulates": ["BOM"],
         "key_stages_or_info": {"citizen_of_country": "IN"}, "key_dates": {"priority_date": "2022-01-01"}},
        {"current_visa_or_greencard_category": ["H-1B"], "consulates": ["BOM"],
         "key_stages_or_info": {"citizen_of_country": "IN"}, "key_dates": {"priority_date": "2022-01-01"}})
    check("G15 full overlap sums all signals (3+1.5+1+1.5 = 7.0)", abs(full["score"] - 7.0) < 0.01, str(full["score"]))
    check("G16 shared lists every matched facet",
          set(full["shared"]) == {"H-1B", "BOM", "citizen_of_country=IN", "priority_date(exact)"}, str(full["shared"]))


def group_h_match_integration() -> None:
    print("\nH — positive / negative matching via find_matches (integration)")
    from google.cloud import firestore
    db = firestore.Client(project=PROJECT)

    ids = {k: f"test-mc-{k}-{secrets.token_hex(3)}" for k in
           ("clone", "strong", "visa", "consulate", "stage", "diffvisa", "diffcons", "empty")}
    crit = {"current_visa_or_greencard_category": ["H-1B"], "consulates": ["BOM"],
            "key_stages_or_info": {"citizen_of_country": "IN"}}
    seeds = {
        ids["clone"]:     {"username": "clone", "current_visa_or_greencard_category": ["H-1B"], "consulates": ["BOM"], "key_stages_or_info": {"citizen_of_country": "IN"}},   # 5.5
        ids["strong"]:    {"username": "strong", "current_visa_or_greencard_category": ["H-1B"], "consulates": ["BOM"]},  # 4.5
        ids["visa"]:      {"username": "visaonly", "current_visa_or_greencard_category": ["H-1B"]},  # 3.0
        ids["consulate"]: {"username": "consonly", "current_visa_or_greencard_category": ["F-1"], "consulates": ["BOM"]},  # 1.5
        ids["stage"]:     {"username": "stageonly", "current_visa_or_greencard_category": ["O-1"], "key_stages_or_info": {"citizen_of_country": "IN"}},  # 1.0
        ids["diffvisa"]:  {"username": "diffvisa", "current_visa_or_greencard_category": ["F-1"]},  # 0 (negative)
        ids["diffcons"]:  {"username": "diffcons", "current_visa_or_greencard_category": ["B-1"], "consulates": ["LON"]},  # 0 (negative)
        ids["empty"]:     {"username": "emptyprof"},  # 0 (negative)
    }
    try:
        for uid, p in seeds.items():
            db.collection("users").document(uid).set(p)
        ms = M.find_matches(db, "demo-arjun", crit)
        by = {m["user_id"]: m for m in ms}

        # positives present with the expected scores
        check("H1 clone (visa+consulate+status) = 5.5", ids["clone"] in by and abs(by[ids["clone"]]["score"] - 5.5) < 0.01)
        check("H2 strong (visa+consulate) = 4.5", ids["strong"] in by and abs(by[ids["strong"]]["score"] - 4.5) < 0.01)
        check("H3 visa-only = 3.0", ids["visa"] in by and abs(by[ids["visa"]]["score"] - 3.0) < 0.01)
        check("H4 consulate-only = 1.5", ids["consulate"] in by and abs(by[ids["consulate"]]["score"] - 1.5) < 0.01)
        check("H5 status-fact-only = 1.0 (== MIN_SCORE, still a match)", ids["stage"] in by and abs(by[ids["stage"]]["score"] - 1.0) < 0.01)

        # negatives excluded
        check("H6 disjoint-visa peer excluded", ids["diffvisa"] not in by)
        check("H7 disjoint-consulate peer excluded", ids["diffcons"] not in by)
        check("H8 empty profile excluded", ids["empty"] not in by)
        check("H9 caller is never in their own matches", "demo-arjun" not in by)

        # ranking among our seeds is strictly by score desc
        ours = [m["user_id"] for m in ms if m["user_id"] in ids.values()]
        expected = [ids["clone"], ids["strong"], ids["visa"], ids["consulate"], ids["stage"]]
        check("H10 ranked by score desc", ours == expected, str([(by[i]["username"], by[i]["score"]) for i in ours]))

        # top_n cap + min_score override
        top2 = M.find_matches(db, "demo-arjun", crit, top_n=2)
        check("H11 top_n caps the result + stays sorted",
              len(top2) == 2 and top2[0]["score"] >= top2[1]["score"], str(len(top2)))
        strict = {m["user_id"] for m in M.find_matches(db, "demo-arjun", crit, min_score=2.0)}
        check("H12 min_score raises the bar (keeps ≥3.0, drops ≤1.5)",
              ids["visa"] in strict and ids["consulate"] not in strict and ids["stage"] not in strict)
    finally:
        for uid in ids.values():
            db.collection("users").document(uid).delete()
        print("  cleaned up match-criteria test docs")


# ---------------------------------------------------------------------------
# I — pure: tags scoring (_score), _exact_match(), _within_age() (Timeline
# Groups redesign — features/timeline-notifications-3/ Find Groups plan)
# ---------------------------------------------------------------------------

def group_i_tags_and_exact_pure() -> None:
    print("\nI — pure: tags in _score(), _exact_match(), _within_age()")

    # I1-I3: tags flow through CRITERIA_FIELDS/_clean_criteria and _score()
    check("I1 'tags' is now in CRITERIA_FIELDS", "tags" in M.CRITERIA_FIELDS)
    # Note: "AOS" (1.3 abbreviation) is used here, not a 1.6 visa-form-action
    # tag like "ead-filing" — profile.clean_profile()'s `tags` field only
    # ever accepts 1.3/1.10 misc tags (see test_profile_vocab.py's T4), so a
    # 1.6 tag would be dropped as OOV regardless of this feature's changes.
    cleaned = M._clean_criteria({"tags": ["AOS", "NOT-A-TAG"]})
    check("I2 _clean_criteria validates tags against the controlled vocab",
          "AOS" in cleaned["tags"] and "NOT-A-TAG" not in cleaned["tags"], str(cleaned["tags"]))
    s = M._score({"current_visa_or_greencard_category": ["H-1B"], "tags": ["AOS"]},
                 {"current_visa_or_greencard_category": ["H-1B"], "tags": ["AOS"]})
    check("I3 shared tag adds W_TAG (3.0 + 0.75 = 3.75)", abs(s["score"] - 3.75) < 0.01, str(s["score"]))
    check("I3b shared tag listed in shared + shared_detail",
          "AOS" in s["shared"] and s["shared_detail"]["tags"] == ["AOS"], str(s))
    s_none = M._score({"tags": ["AOS"]}, {"tags": ["EAD"]})
    check("I4 disjoint tags → no tag credit", s_none["score"] == 0.0)

    # I5-I10: _exact_match() — Timeline-group matching
    crit = {"current_visa_or_greencard_category": ["H-1B"], "consulates": ["BOM"], "tags": ["AOS"]}
    check("I5 exact match on every specified category → True",
          M._exact_match(crit, {"current_visa_or_greencard_category": ["H-1B"],
                                "consulates": ["BOM"], "tags": ["AOS"]}))
    check("I6 group has an EXTRA visa the searcher didn't ask for → False (not a subset/overlap check)",
          not M._exact_match(crit, {"current_visa_or_greencard_category": ["H-1B", "L-1"],
                                    "consulates": ["BOM"], "tags": ["AOS"]}))
    check("I7 group is missing a specified tag → False",
          not M._exact_match(crit, {"current_visa_or_greencard_category": ["H-1B"],
                                    "consulates": ["BOM"], "tags": []}))
    check("I8 a category the searcher left blank imposes no constraint",
          M._exact_match({"current_visa_or_greencard_category": ["H-1B"]},
                         {"current_visa_or_greencard_category": ["H-1B"], "consulates": ["ANYTHING"],
                          "tags": ["whatever"]}))
    check("I9 empty criteria vs anything → True (no constraints at all)",
          M._exact_match({}, {"current_visa_or_greencard_category": ["H-1B"]}))
    check("I10 cross-field current↔applying_for still counts as the same category for exact match",
          M._exact_match({"current_visa_or_greencard_category": ["H-1B"]}, {"visa_applying_for": ["H-1B"]}))

    # I11-I13: _within_age() — the Cutoff-period helper
    from datetime import datetime, timedelta, timezone
    now = datetime.now(timezone.utc)
    recent = (now - timedelta(days=5)).isoformat()
    old = (now - timedelta(days=400)).isoformat()
    check("I11 max_age_days=0 ('All time') always True regardless of age",
          M._within_age(old, 0) and M._within_age(recent, 0))
    check("I12 within the window → True", M._within_age(recent, 30))
    check("I13 outside the window → False", not M._within_age(old, 30))
    check("I14 blank/malformed created_at outside 'All time' → False (fails closed, not open)",
          not M._within_age("", 30) and not M._within_age(None, 30))

    # I15-I19: _exact_match() key_stages_or_info / key_dates comparison
    # (features/timeline-notifications-3/ — Timeline group criteria panel:
    # key-stage/key-date entry now feeds real search criteria, not just tags).
    c_kd = {"current_visa_or_greencard_category": ["H-1B"], "key_dates": {"ead_filed_date": "2026-01-01"}}
    check("I15 exact key_dates match on a specified key → True",
          M._exact_match(c_kd, {"current_visa_or_greencard_category": ["H-1B"],
                                "key_dates": {"ead_filed_date": "2026-01-01"}}))
    check("I16 key_dates value mismatch on a specified key → False",
          not M._exact_match(c_kd, {"current_visa_or_greencard_category": ["H-1B"],
                                    "key_dates": {"ead_filed_date": "2026-02-02"}}))
    check("I17 key_dates key missing from the group entirely → False",
          not M._exact_match(c_kd, {"current_visa_or_greencard_category": ["H-1B"], "key_dates": {}}))
    c_st = {"key_stages_or_info": {"citizen_of_country": "IN"}}
    check("I18 exact key_stages_or_info match → True",
          M._exact_match(c_st, {"key_stages_or_info": {"citizen_of_country": "IN"}}))
    check("I19 key_stages_or_info value mismatch → False",
          not M._exact_match(c_st, {"key_stages_or_info": {"citizen_of_country": "CN"}}))
    check("I20 a key the searcher didn't specify imposes no constraint (unconstrained key_dates)",
          M._exact_match({}, {"key_dates": {"anything": "goes"}}))


# ---------------------------------------------------------------------------
# M — pure: mandatory post-join Timeline attributes (_matched_post_join_type,
# _validate_attribute_values)
# ---------------------------------------------------------------------------

def group_m_attributes_pure() -> None:
    print("\nM — pure: post-join attribute matching + validation")

    check("M1 _matched_post_join_type finds a registered type in criteria_tags.tags",
          M._matched_post_join_type({"group_type": "timeline", "criteria_tags": {"tags": ["stem-opt-extension"]}}) == "stem-opt-extension")
    check("M2 _matched_post_join_type finds a registered type in current_visa_or_greencard_category",
          M._matched_post_join_type({"group_type": "timeline",
                                     "criteria_tags": {"current_visa_or_greencard_category": ["stem-opt-extension"]}}) == "stem-opt-extension")
    check("M3 _matched_post_join_type is '' for a Regular group even with the same tag",
          M._matched_post_join_type({"group_type": "", "criteria_tags": {"tags": ["stem-opt-extension"]}}) == "")
    # O-1 is real vocabulary but configures no post-join rows, so a Timeline
    # group scoped to it collects nothing on join. (Not H-1B — that gained a
    # 12-row petition template; see test_profile_vocab.py group V.)
    check("M4 _matched_post_join_type is '' for a Timeline group whose type configures no rows",
          M._matched_post_join_type({"group_type": "timeline", "criteria_tags": {"current_visa_or_greencard_category": ["O-1"]}}) == "")
    check("M5 _matched_post_join_type is '' for a Timeline group with no matching tag at all",
          M._matched_post_join_type({"group_type": "timeline", "criteria_tags": {"tags": ["rfe-experience"]}}) == "")

    check("M6 POST_JOIN_ATTRIBUTE_TEMPLATES['stem-opt-extension'] row 0 is Date Applied / ead_filed_date (the required convention)",
          posting.POST_JOIN_ATTRIBUTE_TEMPLATES["stem-opt-extension"][0]["key"] == "ead_filed_date")

    clean = M._validate_attribute_values("stem-opt-extension", {"ead_filed_date": " 2026-03-01 ", "rfe_date": "2026-04-01"})
    check("M7 _validate_attribute_values strips whitespace and keeps registered keys",
          clean == {"ead_filed_date": "2026-03-01", "rfe_date": "2026-04-01"}, str(clean))

    clean_unknown = M._validate_attribute_values("stem-opt-extension", {"ead_filed_date": "2026-03-01", "not_a_real_key": "x"})
    check("M8 _validate_attribute_values drops keys not in the matched type's template",
          "not_a_real_key" not in clean_unknown, str(clean_unknown))

    try:
        M._validate_attribute_values("stem-opt-extension", {"rfe_date": "2026-04-01"})
        check("M9 the required row-0 field (Date Applied) missing raises ValueError", False, "no raise")
    except ValueError as e:
        check("M9 the required row-0 field (Date Applied) missing raises ValueError", "Date Applied" in str(e), str(e))

    try:
        M._validate_attribute_values("stem-opt-extension", None)
        check("M10 values=None also raises (treated as nothing submitted)", False, "no raise")
    except ValueError:
        check("M10 values=None also raises (treated as nothing submitted)", True)

    only_required = M._validate_attribute_values("stem-opt-extension", {"ead_filed_date": "2026-03-01"})
    check("M11 only the required field, all others blank, is valid (optional fields really are optional)",
          only_required == {"ead_filed_date": "2026-03-01"}, str(only_required))

    check("M12 compute_needs_attributes is False when there's no viewer_id",
          M.compute_needs_attributes(None, "g1", {"group_type": "timeline", "criteria_tags": {"tags": ["stem-opt-extension"]}, "members": []}, "") is False)
    check("M13 compute_needs_attributes is False for a Regular group (fast path, no Firestore read needed)",
          M.compute_needs_attributes(None, "g1", {"group_type": "", "criteria_tags": {}, "members": [{"user_id": "u1"}]}, "u1") is False)
    # --- M23-M28: EAD processing type + eligibility category naming --------
    check("M23 the EAD processing type exists and carries eligibility categories",
          any(t["value"] == "EAD" and t["eligibility_categories"]
              for t in posting.PROCESSING_TYPES))
    bad_tag = [c for c in posting.EAD_ELIGIBILITY_CATEGORIES
               if c["tag"] not in set(posting.vocab_lists()["tag"]) | set(posting.vocab_lists()["visa"])]
    check("M24 every eligibility category's tag is in the controlled vocabulary",
          not bad_tag, f"unknown tags: {[c['tag'] for c in bad_tag]}")
    # (b)-class visas are authorized incident to status and never file an
    # I-765 — offering them as EAD categories would be plainly wrong.
    never_files = {"H-1B", "L-1", "L-1A", "L-1B", "O-1", "TN", "E-1", "E-2", "J-1"}
    check("M25 no (b)-class 'authorized incident to status' visa is offered as an EAD category",
          not (never_files & {c["tag"] for c in posting.EAD_ELIGIBILITY_CATEGORIES}))

    check("M26 a new EAD group names itself <type>-<eligibility>-<month>-<year>",
          M._timeline_group_name({"tags": ["EAD", "stem-opt-extension"],
                                  "key_stages_or_info": {"filing_month": "Sep", "filing_year": "2027"}})
          == "EAD-stem-opt-extension-Sep-2027")
    check("M27 an eligibility category with no Cycle/Year template names itself <type>-<eligibility>",
          M._timeline_group_name({"tags": ["EAD", "h4-ead"]}) == "EAD-h4-ead")
    # The pre-EAD groups carry only the eligibility tag; their names must not move.
    # A group created before the Cycle→Month switch carries stem_opt_cycle /
    # stem_opt_year, which nothing reads anymore — so its name is no longer
    # REPRODUCIBLE from its criteria. Its STORED name is untouched (names are
    # persisted, not recomputed), which is what actually matters; the only
    # casualty is name-based dedup against such a group, and nothing produces
    # old-style criteria any longer.
    check("M28 a legacy stem_opt_* group degrades to the bare tag, and does NOT "
          "resurrect a Cycle segment",
          M._timeline_group_name({"tags": ["stem-opt-extension"],
                                  "key_stages_or_info": {"stem_opt_cycle": "Fall", "stem_opt_year": "2026"}})
          == "stem-opt-extension")

    # --- M29-M33: create no longer demands attributes; Cycle vs Month ------
    check("M29 require=False lets the CREATE path through with no attributes at all",
          M._validate_attribute_values("stem-opt-extension", {}, require=False) == {})
    try:
        M._validate_attribute_values("stem-opt-extension", {"application_status": "bogus"}, require=False)
        check("M30 …but a bad select is still rejected on the create path", False, "no raise")
    except ValueError:
        check("M30 …but a bad select is still rejected on the create path", True)
    try:
        M._validate_attribute_values("stem-opt-extension", {})
        check("M31 JOINING still requires the row-0 attribute (require defaults True)", False, "no raise")
    except ValueError as e:
        check("M31 JOINING still requires the row-0 attribute (require defaults True)",
              "Date Applied" in str(e), str(e))

    # Every scope STARTS with the same two period rows — there is no Cycle
    # anywhere. A category may configure extra rows after them, but never
    # replace or reorder the base, so every Timeline group is comparable by
    # filing period no matter what else it is scoped by.
    wrong = [(k, [r["label"] for r in v]) for k, v in posting.TAG_ATTRIBUTE_TEMPLATES.items()
             if [r["label"] for r in v][:2] != ["Month", "Year"]]
    check("M32 every processing type and eligibility category leads with Month + Year — no Cycle",
          not wrong, str(wrong))
    check("M32b …and no template row anywhere is labelled Cycle",
          not any(r["label"] == "Cycle"
                  for v in posting.TAG_ATTRIBUTE_TEMPLATES.values() for r in v))
    check("M32c …and every category writes the same two period keys first",
          {tuple(r["key"] for r in posting.TAG_ATTRIBUTE_TEMPLATES[c["tag"]])[:2]
           for c in posting.EAD_ELIGIBILITY_CATEGORIES} == {("filing_month", "filing_year")})

    months = posting.TAG_ATTRIBUTE_TEMPLATES["h4-ead"][0]["options"]
    check("M33 the Month options are the 12 three-letter names in calendar order",
          months == ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                     "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"], str(months))

    # --- M34-M44: the attribute framework -----------------------------------
    # Rows are resolved from a declarative spec per (processing type,
    # eligibility category). These checks pin the resolution rules themselves,
    # so a new type/category is a config change and not a code change.
    # I-485's priority date is a PER-MEMBER fact, not a group scope: everyone
    # in an AOS cohort has their own, so scoping the group by one exact date
    # would split every cohort into cohorts of one.
    aos_pj = posting.timeline_post_join_rows("EAD", "adjustment-of-status")
    check("M34 I-485 collects a Priority Date on JOIN, not on create",
          [r["key"] for r in aos_pj] == ["priority_date"]
          and [r["key"] for r in posting.timeline_scope_rows("EAD", "adjustment-of-status")]
          == ["filing_month", "filing_year"],
          str([r["key"] for r in aos_pj]))
    pd_row = aos_pj[0]
    check("M35 …as a date row writing into key_dates",
          (pd_row["kind"], pd_row["field"]) == ("date", "key_dates"), str(pd_row))
    check("M35b …and it is OPTIONAL, so joining an AOS group is never blocked by it",
          posting.required_keys(aos_pj) == [], str(posting.required_keys(aos_pj)))
    check("M35c …which the join gate honours — no values at all still validates",
          M._validate_attribute_values("adjustment-of-status", {}, require=True) == {})
    check("M36 …and priority_date is real 1.8 vocabulary, so profile.py won't drop it",
          "priority_date" in posting.vocab_lists()["date_key"])

    check("M37 a category with no extras resolves to the base period rows alone",
          [r["key"] for r in posting.timeline_scope_rows("EAD", "h4-ead")]
          == ["filing_month", "filing_year"])
    check("M38 a type with no eligibility list resolves off the type alone",
          [r["key"] for r in posting.timeline_scope_rows("H-1B")]
          == ["filing_month", "filing_year"])
    check("M39 an unknown pair still gets the base rows rather than nothing",
          [r["key"] for r in posting.timeline_scope_rows("NOPE", "ALSO-NOPE")]
          == ["filing_month", "filing_year"])

    # A later layer REPLACES a same-key row in place — two controls for one
    # key would let a client submit whichever it liked.
    layered = posting._layer_rows(
        [{"key": "a", "label": "A"}, {"key": "b", "label": "B"}],
        [{"key": "a", "label": "A-override"}, {"key": "c", "label": "C"}])
    check("M40 layering overrides a same-key row in place and appends the rest",
          [(r["key"], r["label"]) for r in layered]
          == [("a", "A-override"), ("b", "B"), ("c", "C")], str(layered))

    check("M41 every dropdown option carries its resolved rows for the client",
          all("scope_rows" in t and "post_join_rows" in t for t in posting.PROCESSING_TYPES)
          and all("scope_rows" in c for t in posting.PROCESSING_TYPES
                  for c in t["eligibility_categories"]))
    # Each type names its own list, so picking a different first dropdown must
    # give a genuinely different second one — not a shared global list filtered
    # after the fact. Asserted as disjointness rather than exact contents so
    # this doesn't have to be edited every time a category is configured.
    by_type = {t["value"]: {c["tag"] for c in t["eligibility_categories"]}
               for t in posting.PROCESSING_TYPES if t["eligibility_categories"]}
    check("M42 the second dropdown's contents depend on the first",
          len(by_type) > 1 and all(a.isdisjoint(b) for a in by_type.values()
                                   for b in by_type.values() if a is not b),
          str({k: sorted(v) for k, v in by_type.items()}))
    check("M42b a type may name its own second dropdown, and H-1B's are application types",
          next(t for t in posting.PROCESSING_TYPES
               if t["value"] == "H-1B").get("category_label") == "Application type")

    # --- ALL_ELIGIBILITY_CATEGORIES ----------------------------------------
    # The accessor whose absence caused the collision below. EAD's own list
    # stays exported for callers that specifically mean EAD's 8 CFR classes,
    # but anything resolving "which category is this group scoped to" must
    # read every type's.
    all_tags = [c["tag"] for c in posting.ALL_ELIGIBILITY_CATEGORIES]
    ead_tags = [c["tag"] for c in posting.EAD_ELIGIBILITY_CATEGORIES]
    check("M47 ALL_ELIGIBILITY_CATEGORIES spans every type, not just EAD",
          set(ead_tags) < set(all_tags), str(sorted(set(all_tags) - set(ead_tags))))
    check("M47b …and it is exactly the union of the per-type lists, in order",
          all_tags == [c["tag"] for t in posting.PROCESSING_TYPES
                       for c in t.get("eligibility_categories") or []], str(all_tags))
    check("M47c …with no duplicates — a tag belongs to one type",
          len(all_tags) == len(set(all_tags)), str(all_tags))
    check("M47d …and it tracks config, so a new type's categories appear unbidden",
          {"change-of-status-COS", "h1b-stamping", "change-of-employer-COE"} <= set(all_tags))

    # --- generated name + description (preview_timeline_group) -------------
    def crit(cat, ptype="H-1B", month="Mar", year="2026"):
        """Which criteria field a tag lands in is decided by its vocabulary
        class — exactly how the clients route it (find/page.tsx's
        processingTypeField). Getting this wrong in a fixture makes the tag
        look dropped when the code is fine."""
        c: dict = {"current_visa_or_greencard_category": [], "tags": [],
                   "key_stages_or_info": {}}
        for t in (ptype, cat):
            if not t:
                continue
            c["current_visa_or_greencard_category" if t in posting._Vocab.visa
              else "tags"].append(t)
        if month:
            c["key_stages_or_info"] = {"filing_month": month, "filing_year": year}
        return c

    # THE regression: every H-1B application type must name its OWN cohort.
    # Resolving the category against EAD's list alone (which is what the code
    # did when EAD was the only type with one) returned "" for all three, so
    # all three produced "H-1B-Mar-2026" — and Timeline dedup is name-based,
    # so a change-of-employer cohort would have silently joined a
    # change-of-status one.
    h1b_names = [M.preview_timeline_group(crit(c))["name"]
                 for c in ("change-of-status-COS", "h1b-stamping", "change-of-employer-COE")]
    check("M50a each H-1B application type generates a DISTINCT group name",
          len(set(h1b_names)) == 3, str(h1b_names))
    check("M50b …and each name carries its own application type",
          all(c in n for c, n in zip(
              ("change-of-status-COS", "h1b-stamping", "change-of-employer-COE"), h1b_names)),
          str(h1b_names))
    check("M50c the generated name is exactly what find_or_create_group would use",
          h1b_names[0] == M._timeline_group_name(
              M._clean_criteria(crit("change-of-status-COS"))), h1b_names[0])

    cos = M.preview_timeline_group(crit("change-of-status-COS"))
    check("M51a the description names the type and the application type by LABEL",
          "H-1B" in cos["description"]
          and "Change of Status (initial, in the U.S.)" in cos["description"],
          cos["description"])
    check("M51b …carries the filing period",
          "Mar 2026" in cos["description"], cos["description"])
    check("M51c …and lists the fields members will actually be asked for",
          "Receipt Date (petition submitted)" in cos["description"]
          and "9 more" in cos["description"], cos["description"])
    no_period = M.preview_timeline_group(crit("change-of-status-COS", month=""))["description"]
    check("M51d a period-less scope still describes the cohort, claiming no period",
          no_period.startswith("H-1B · Change of Status (initial, in the U.S.).")
          and "Mar" not in no_period, no_period)
    check("M51e criteria naming no processing type get NO invented description",
          M.preview_timeline_group({"tags": ["rfe-experience"]})["description"] == "")
    check("M51f a Regular group is never given a generated description",
          M.preview_timeline_group(crit("change-of-status-COS"), "")["description"] == "")
    check("M52 preview is pure — two calls with the same criteria agree",
          M.preview_timeline_group(crit("h1b-stamping"))
          == M.preview_timeline_group(crit("h1b-stamping")))

    # The name and the description are built from the SAME segments, so a
    # scope row that reaches one must reach the other — otherwise the blurb
    # would describe a cohort the name doesn't.
    part = M.preview_timeline_group(crit("change-of-status-COS", month="Mar", year=""))
    check("M53a a half-filled period still names and describes what IS set",
          part["name"] == "H-1B-change-of-status-COS-Mar"
          and "filed Mar." in part["description"], str(part))

    # A priority date is a PER-MEMBER fact, so it is a post-join row, not a
    # scope row — it must stay out of both the name and the "filed …" phrase,
    # and appear only as a field members will be asked for. Putting it in the
    # scope would give every AOS filer a cohort of one.
    aos = {"current_visa_or_greencard_category": ["adjustment-of-status"], "tags": ["EAD"],
           "key_stages_or_info": {"filing_month": "Aug", "filing_year": "2026"},
           "key_dates": {"priority_date": "2021-03-15"}}
    aos_p = M.preview_timeline_group(aos)
    check("M53b a per-member date stays out of the generated name",
          aos_p["name"] == "EAD-adjustment-of-status-Aug-2026", aos_p["name"])
    check("M53c …and out of the period phrase the description states",
          "filed Aug 2026." in aos_p["description"]
          and "2021-03-15" not in aos_p["description"], aos_p["description"])
    check("M53d …but IS named as a field members will be asked for",
          "Priority Date" in aos_p["description"], aos_p["description"])

    # required_keys() is the config; row 0 is only the fallback.
    check("M43 an explicit required flag decides which rows are mandatory",
          posting.required_keys([{"key": "x"}, {"key": "y", "required": True}]) == ["y"])
    check("M43b …and a template with no flag falls back to row 0",
          posting.required_keys([{"key": "x"}, {"key": "y"}]) == ["x"])
    check("M43c …and an empty template requires nothing",
          posting.required_keys([]) == [])
    # The only way to express "collect this, but never block on it" — without
    # it, a single-row optional template would make its one row mandatory.
    check("M43d a declared required:False means NOTHING is mandatory, not row 0",
          posting.required_keys([{"key": "x", "required": False}]) == [])

    check("M44 every scope row the criteria carry a value for lands in the name",
          M._timeline_group_name({
              "tags": ["EAD", "adjustment-of-status"],
              "key_stages_or_info": {"filing_month": "Aug", "filing_year": "2026"}})
          == "EAD-adjustment-of-status-Aug-2026")
    check("M44b …and a row with no value is omitted rather than left blank",
          M._timeline_group_name({"tags": ["EAD", "adjustment-of-status"],
                                  "key_stages_or_info": {"filing_year": "2026"}})
          == "EAD-adjustment-of-status-2026")
    check("M44c a per-member fact never reaches the group name",
          M._timeline_group_name({
              "tags": ["EAD", "adjustment-of-status"],
              "key_stages_or_info": {"filing_month": "Aug", "filing_year": "2026"},
              "key_dates": {"priority_date": "2021-03-15"}})
          == "EAD-adjustment-of-status-Aug-2026")
    check("M44d existing STEM-OPT and H-1B names are byte-identical to before",
          (M._timeline_group_name({"tags": ["EAD", "stem-opt-extension"],
                                   "key_stages_or_info": {"filing_month": "Aug", "filing_year": "2026"}}),
           M._timeline_group_name({"current_visa_or_greencard_category": ["H-1B"],
                                   "key_stages_or_info": {"filing_month": "Mar", "filing_year": "2026"}}))
          == ("EAD-stem-opt-extension-Aug-2026", "H-1B-Mar-2026"))

    # M45: no category configures an extra scope row today, so the naming
    # machinery that keeps two same-period groups distinct is exercised
    # against an injected one. Without it, name-based dedup would merge two
    # groups that differ only by that extra criterion.
    #
    # Injected through the CONFIG rather than by patching a module global —
    # that is the real path now, so this doubles as proof that a published
    # config actually reaches group naming.
    import attribute_config
    attribute_config._set_for_tests({
        **posting.DEFAULT_ATTRIBUTE_SPEC,
        "scope_row_extras": {"h4-ead": [
            {"kind": "date", "label": "Card Received", "field": "key_dates",
             "key": "ead_card_received_date", "name_prefix": "RD"}]},
    })
    try:
        base = {"tags": ["EAD", "h4-ead"],
                "key_stages_or_info": {"filing_month": "Aug", "filing_year": "2026"}}
        named = M._timeline_group_name({**base, "key_dates": {"ead_card_received_date": "2026-08-20"}})
        check("M45 an extra scope row reaches the name behind its name_prefix",
              named == "EAD-h4-ead-Aug-2026-RD-2026-08-20", named)
        other = M._timeline_group_name({**base, "key_dates": {"ead_card_received_date": "2026-09-02"}})
        check("M45b …so two values in one filing month are DIFFERENT groups",
              named != other, f"{named} vs {other}")
        check("M45c …and the row is omitted entirely when unset",
              M._timeline_group_name(base) == "EAD-h4-ead-Aug-2026")
        check("M45d …and the injected row reaches the tag-keyed registry too",
              [r["key"] for r in posting.TAG_ATTRIBUTE_TEMPLATES["h4-ead"]]
              == ["filing_month", "filing_year", "ead_card_received_date"],
              str([r["key"] for r in posting.TAG_ATTRIBUTE_TEMPLATES["h4-ead"]]))
    finally:
        attribute_config._set_for_tests(None)
    check("M45e reverting the config reverts the behaviour, no restart",
          [r["key"] for r in posting.TAG_ATTRIBUTE_TEMPLATES["h4-ead"]]
          == ["filing_month", "filing_year"])

    # --- M46-M52: what the validator does with input it did NOT expect -------
    # Everything above proves the happy shapes. These are the ones a client
    # bug, a stale cached vocab payload, or a hand-rolled curl produces.

    # A tag with no registered template must degrade quietly: no rows to
    # collect means nothing to validate and nothing to require.
    check("M46 an unknown processing type validates to {} instead of raising",
          M._validate_attribute_values("no-such-type", {"anything": "x"}, require=True) == {})
    check("M46b …and that holds for a group whose type simply collects nothing",
          M._validate_attribute_values("H-1B", {"ead_filed_date": "2026-03-01"}, require=True) == {})

    # Keys outside the template are dropped rather than stored. Storing them
    # would put un-vocabularied keys into the member's profile, where
    # profile.py's cleaners silently discard them anyway.
    stray = M._validate_attribute_values(
        "stem-opt-extension", {"ead_filed_date": "2026-03-01", "not_a_row": "x", "": "y"})
    check("M47 values for keys not in the template are dropped",
          stray == {"ead_filed_date": "2026-03-01"}, str(stray))

    # The full falsy vocabulary, case-insensitively — an unticked box must be
    # ABSENT, because absent is what "never answered" also looks like.
    req = {"ead_filed_date": "2026-03-01"}
    falsy_kept = [v for v in ("", "no", "NO", "false", "False", "0", "off", "OFF", "none", "None")
                  if "premium_processing" in M._validate_attribute_values(
                      "stem-opt-extension", {**req, "premium_processing": v})]
    check("M48 every falsy checkbox spelling is omitted, in any case", not falsy_kept, str(falsy_kept))
    truthy = {v: M._validate_attribute_values(
        "stem-opt-extension", {**req, "premium_processing": v}).get("premium_processing")
        for v in ("yes", "true", "1", "on", "checked", True)}
    check("M48b …and every truthy spelling normalises to the ONE stored literal",
          set(truthy.values()) == {posting.CHECKBOX_ON}, str(truthy))

    # Blank/None for a non-checkbox row is "not answered", not an empty string
    # written into the profile.
    blanks = M._validate_attribute_values(
        "stem-opt-extension", {**req, "rfe_date": "   ", "ead_approved_date": None})
    check("M49 whitespace-only and None values are dropped, not stored blank",
          "rfe_date" not in blanks and "ead_approved_date" not in blanks, str(blanks))

    # The required check runs on the CLEANED value — whitespace must not
    # satisfy it, or the gate is bypassable with a space bar.
    try:
        M._validate_attribute_values("stem-opt-extension", {"ead_filed_date": "   "}, require=True)
        check("M50 a whitespace-only required field still fails the gate", False, "no raise")
    except ValueError as e:
        check("M50 a whitespace-only required field still fails the gate",
              "Date Applied" in str(e), str(e))
    try:
        M._validate_attribute_values("stem-opt-extension", None, require=True)
        check("M50b …as does a wholly absent values payload", False, "no raise")
    except ValueError as e:
        check("M50b …as does a wholly absent values payload", "required" in str(e), str(e))

    # The caller's dict is theirs — join_group passes the request body straight
    # in, and a mutation would leak coerced values back into the API layer.
    original = {"ead_filed_date": "2026-03-01", "premium_processing": "true"}
    snapshot = dict(original)
    M._validate_attribute_values("stem-opt-extension", original)
    check("M51 validation does not mutate the caller's values dict", original == snapshot, str(original))

    check("M52 layering nothing at all yields no rows",
          posting._layer_rows() == [] and posting._layer_rows([], []) == [])
    check("M52b an unknown pair collects no post-join rows",
          posting.timeline_post_join_rows("NOPE", "ALSO-NOPE") == [])
    check("M52c resolving twice returns equal but independent row lists",
          # The resolver hands out copies; a client mutating one row must not
          # corrupt the registry every other caller reads.
          posting.timeline_scope_rows("EAD", "h4-ead") == posting.timeline_scope_rows("EAD", "h4-ead")
          and posting.timeline_scope_rows("EAD", "h4-ead")[0]
          is not posting.timeline_scope_rows("EAD", "h4-ead")[0])

    check("M14 compute_needs_attributes is False when the viewer isn't a member (fast path)",
          M.compute_needs_attributes(None, "g1", {"group_type": "timeline", "criteria_tags": {"tags": ["stem-opt-extension"]},
                                                  "members": [{"user_id": "someone-else"}]}, "u1") is False)

    # --- M15-M22: rows are no longer all dates — kind drives validation -----
    rows = posting.POST_JOIN_ATTRIBUTE_TEMPLATES["stem-opt-extension"]
    by_kind = {}
    for r in rows:
        by_kind.setdefault(r.get("kind", "date"), []).append(r)
    check("M15 the template carries select and checkbox rows, not only dates",
          {"date", "select", "checkbox"} <= set(by_kind), str(sorted(by_kind)))

    req = {"ead_filed_date": "2026-03-01"}
    sel = M._validate_attribute_values("stem-opt-extension", {**req, "application_status": "RFE"})
    check("M16 a select value inside the row's options is kept",
          sel.get("application_status") == "RFE", str(sel))
    try:
        M._validate_attribute_values("stem-opt-extension", {**req, "application_status": "maybe"})
        check("M17 a select value OUTSIDE the options raises (not silently dropped)", False, "no raise")
    except ValueError as e:
        check("M17 a select value OUTSIDE the options raises (not silently dropped)",
              "Status" in str(e), str(e))

    on = M._validate_attribute_values("stem-opt-extension", {**req, "premium_processing": True})
    check("M18 a truthy checkbox normalises to CHECKBOX_ON",
          on.get("premium_processing") == posting.CHECKBOX_ON, str(on))
    for falsy in (False, "", "no", "false", "0", "off"):
        off = M._validate_attribute_values("stem-opt-extension", {**req, "premium_processing": falsy})
        if "premium_processing" in off:
            check(f"M19 a falsy checkbox ({falsy!r}) is OMITTED, never stored as 'no'", False, str(off))
            break
    else:
        check("M19 a falsy checkbox is OMITTED, never stored as 'no' — unticked reads "
              "the same as never-answered", True)

    # Every key must exist in the CSV its row names, or profile.py's cleaners
    # drop it on save and the value vanishes with no error anywhere.
    posting._Vocab.load()
    unknown = [
        r["key"] for r in rows
        if r["key"] not in (posting._Vocab.profile_stage_keys
                            if r["field"] == "key_stages_or_info" else posting._Vocab.date_keys)
    ]
    check("M20 every template key is in the controlled vocabulary for its field",
          not unknown, f"missing from CSV: {unknown}")

    check("M21 the two replaced date keys are gone from the template",
          not {"biometrics_appointment_date", "noid_date"} & {r["key"] for r in rows})
    check("M22 …and their checkbox replacements are present on key_stages_or_info",
          all(any(r["key"] == k and r["field"] == "key_stages_or_info" for r in rows)
              for k in ("biometrics_requested", "noid_issued")))


# ---------------------------------------------------------------------------
# O — pure: invitation id + the re-invite decision table
# ---------------------------------------------------------------------------

def group_o_invitations_pure() -> None:
    print("\nO — pure: invitation id + re-invite decision table")

    check("O1 _invitation_id is the {group}__{user} composite (mirrors interactions._vote_id)",
          M._invitation_id("g1", "u1") == "g1__u1", M._invitation_id("g1", "u1"))

    check("O2 no doc + not a member → create", M._reinvite_action(None, False) == "create")
    check("O3 no doc but already a member → block_member (membership wins)",
          M._reinvite_action(None, True) == "block_member")
    check("O4 an existing pending invite → noop_pending (idempotent re-invite, no error)",
          M._reinvite_action({"status": "pending"}, False) == "noop_pending")
    check("O5 a declined invite → revive (declining doesn't permanently block)",
          M._reinvite_action({"status": "declined"}, False) == "revive")
    check("O6 a cancelled invite → revive",
          M._reinvite_action({"status": "cancelled"}, False) == "revive")
    check("O7 accepted-then-left (accepted doc, not currently a member) → revive",
          M._reinvite_action({"status": "accepted"}, False) == "revive")
    check("O8 accepted AND still a member → block_member",
          M._reinvite_action({"status": "accepted"}, True) == "block_member")

    check("O9 INVITATION_STATUSES is the documented 4-value set",
          M.INVITATION_STATUSES == ("pending", "accepted", "declined", "cancelled"),
          str(M.INVITATION_STATUSES))

    view = M._invitation_view("g1__u1", {
        "group_id": "g1", "group_name": "n", "user_id": "u1", "username": "alpha",
        "invited_by": "u2", "invited_by_username": "bravo", "status": "pending",
        "created_at": "2026-01-01", "responded_at": "",
        # fields that must NOT leak to the client:
        "declined_count": 3, "cancel_reason": "x", "updated_at": "2026-01-02",
    }, requires_attributes=True)
    check("O10 _invitation_view exposes exactly the documented client keys (no internals leak)",
          set(view) == {"invitation_id", "group_id", "group_name", "user_id", "username",
                        "invited_by", "invited_by_username", "status", "requires_attributes",
                        "created_at", "responded_at"}, str(sorted(view)))
    check("O11 requires_attributes rides on the view", view["requires_attributes"] is True)

    # The find-candidates repair, at the pure-scoring level.
    crit = {"tags": ["stem-opt-extension"], "key_dates": {}}
    prof_with_dates = {"tags": [], "key_dates": {"ead_filed_date": "2026-03-01"}}
    s = M._score(M._clean_criteria(crit), prof_with_dates)
    check("O12 a Timeline processing type now scores against the template's key_dates keys "
          "(it silently scored ZERO before — profiles can't hold 1.6 tags)",
          s["score"] > 0 and "ead_filed_date" in s["shared_detail"]["processing"], str(s))

    far = M._score({"key_dates": {"ead_filed_date": "2020-01-01"}},
                   {"key_dates": {"ead_filed_date": "2026-01-01"}})
    check("O13 a shared date key that is FAR apart still scores the floor…",
          far["score"] >= M._DATE_FLOOR, str(far))
    check("O14 …but is NOT listed as shared — a '≠' chip under a 'shared' heading reads as a match",
          not any("≠" in s for s in far["shared"]), str(far["shared"]))

    near = M._score({"key_dates": {"ead_filed_date": "2026-01-01"}},
                    {"key_dates": {"ead_filed_date": "2026-01-01"}})
    check("O15 an exact date match IS listed as shared",
          any("ead_filed_date" in s for s in near["shared"]), str(near["shared"]))

    check("O16 _match_reason builds a human sentence and keeps visa codes upper-case",
          M._match_reason({"visa": ["H-1B"], "consulates": ["BOM"], "tags": [],
                           "stages": [], "dates": [], "processing": []}).startswith("Both H-1B"),
          M._match_reason({"visa": ["H-1B"], "consulates": ["BOM"], "tags": [],
                           "stages": [], "dates": [], "processing": []}))
    check("O17 _match_reason is empty (not a crash) when nothing overlaps",
          M._match_reason({"visa": [], "consulates": [], "tags": [], "stages": [],
                           "dates": [], "processing": []}) == "")


# ---------------------------------------------------------------------------
# J — live Firestore: search_groups() — regular tag-overlap scoring +
# precision thresholds, Timeline exact-match, group_type + cutoff filtering
# ---------------------------------------------------------------------------

def _seed_group(db, owner: str, criteria_text: str, criteria: dict, group_type: str = "") -> dict:
    """Write a group doc directly, bypassing find_or_create_group()'s
    _signature()-based auto-join — several of these seeded groups
    deliberately share the same distinctive visa/consulate facets (to test
    group_type/cutoff filtering independent of overlap), and going through
    find_or_create_group() would collapse same-signature groups into one
    regardless of group_type, invalidating the test."""
    now = M._now_iso()
    doc = {
        "name": "seeded test group", "description": "", "group_type": group_type or "",
        "signature": f"seed:{secrets.token_hex(4)}",  # distinct so it can't collide/auto-join
        "criteria_text": criteria_text, "criteria_tags": M._clean_criteria(criteria),
        "members": [{"user_id": owner, "username": owner}], "created_by": owner,
        "status": "active", "expiration_date": "", "created_at": now, "updated_at": now, "last_activity_at": now,
    }
    ref = db.collection("groups").document()
    ref.set(doc)
    return M._group_view(ref.id, doc, owner)


def group_j_search_groups() -> None:
    print("\nJ — live Firestore: search_groups() (integration)")
    from google.cloud import firestore
    db = firestore.Client(project=PROJECT)

    searcher = {"current_visa_or_greencard_category": ["H-1B"], "consulates": ["BOM"], "tags": ["AOS"]}
    owner = f"test-search-owner-{secrets.token_hex(3)}"
    gids: list[str] = []
    try:
        # All 6 groups use _seed_group() (own random signature each), NOT
        # find_or_create_group() — several deliberately share the SAME
        # distinctive visa/consulate facets (to test group_type filtering
        # independent of overlap), and find_or_create_group()'s own
        # _signature()-based auto-join would collapse same-signature groups
        # into one regardless of the group_type passed in, which would
        # invalidate this test rather than exercise search_groups().
        strong = _seed_group(db, owner, "full overlap", searcher)
        gids.append(strong["group_id"])
        weak = _seed_group(db, owner, "tag-only overlap", {"tags": ["AOS"]})
        gids.append(weak["group_id"])
        medium = _seed_group(db, owner, "consulate-only overlap", {"consulates": ["BOM"]})
        gids.append(medium["group_id"])
        disjoint = _seed_group(db, owner, "no overlap at all", {"current_visa_or_greencard_category": ["F-1"]})
        gids.append(disjoint["group_id"])

        t_exact = _seed_group(db, owner, "timeline exact", searcher, group_type="timeline")
        gids.append(t_exact["group_id"])
        t_partial = _seed_group(db, owner, "timeline partial",
                                {"current_visa_or_greencard_category": ["H-1B"], "consulates": ["BOM"]},
                                group_type="timeline")
        gids.append(t_partial["group_id"])
        t_date_match = _seed_group(db, owner, "timeline exact key_dates",
                                   {"key_dates": {"ead_filed_date": "2026-03-01"}}, group_type="timeline")
        gids.append(t_date_match["group_id"])
        t_date_off = _seed_group(db, owner, "timeline mismatched key_dates",
                                 {"key_dates": {"ead_filed_date": "2026-04-15"}}, group_type="timeline")
        gids.append(t_date_off["group_id"])

        # J1-J4: regular (group_type="") — tag-overlap scoring, "balanced" (default)
        balanced = {g["group_id"]: g for g in M.search_groups(db, searcher, group_type="", precision="balanced")}
        check("J1 full-overlap regular group surfaces at balanced",
              strong["group_id"] in balanced, str(list(balanced)))
        check("J2 consulate-only regular group surfaces at balanced (score 1.5 >= MIN_SCORE 1.0)",
              medium["group_id"] in balanced, str(balanced.get(medium["group_id"], {}).get("score")))
        check("J3 tag-only regular group does NOT surface at balanced (score 0.75 < MIN_SCORE 1.0)",
              weak["group_id"] not in balanced)
        check("J4 disjoint regular group never surfaces", disjoint["group_id"] not in balanced)
        check("J5 Timeline groups never leak into a regular (group_type='') search",
              t_exact["group_id"] not in balanced and t_partial["group_id"] not in balanced)

        # J6-J8: Match Precision changes what surfaces (regular groups only)
        broad = {g["group_id"] for g in M.search_groups(db, searcher, group_type="", precision="broad")}
        check("J6 'broad' surfaces the tag-only group too (0.75 >= 0.5)", weak["group_id"] in broad)
        strict = {g["group_id"] for g in M.search_groups(db, searcher, group_type="", precision="strict")}
        check("J7 'strict' excludes the consulate-only group (1.5 < 2.5)", medium["group_id"] not in strict)
        check("J8 'strict' still keeps the full-overlap group", strong["group_id"] in strict)

        # J9-J11: Timeline (group_type="timeline") — exact match, precision ignored
        tl = {g["group_id"] for g in M.search_groups(db, searcher, group_type="timeline", precision="balanced")}
        check("J9 exact-match Timeline group surfaces", t_exact["group_id"] in tl)
        check("J10 partial-overlap Timeline group is excluded (would have scored under regular rules)",
              t_partial["group_id"] not in tl)
        tl_strict = {g["group_id"] for g in M.search_groups(db, searcher, group_type="timeline", precision="strict")}
        check("J11 precision is ignored for Timeline — 'strict' still finds the exact match",
              t_exact["group_id"] in tl_strict)
        check("J12 regular groups never leak into a Timeline search",
              strong["group_id"] not in tl and medium["group_id"] not in tl)

        # J13-J14: max_age_days cutoff (0 = All time unaffected; backdate one group)
        db.collection("groups").document(weak["group_id"]).update(
            {"created_at": "2020-01-01T00:00:00+00:00"})
        all_time = {g["group_id"] for g in M.search_groups(db, searcher, group_type="", precision="broad", max_age_days=0)}
        check("J13 max_age_days=0 ('All time') is unaffected by an old group", weak["group_id"] in all_time)
        cutoff_30 = {g["group_id"] for g in M.search_groups(db, searcher, group_type="", precision="broad", max_age_days=30)}
        check("J14 a 30-day cutoff excludes the backdated group", weak["group_id"] not in cutoff_30)

        # J15-J16: Timeline search with a key_dates criterion (Timeline
        # group panel now captures key_stages_or_info/key_dates directly —
        # _exact_match() must honor them, not just visa/consulate/tags).
        date_searcher = {"key_dates": {"ead_filed_date": "2026-03-01"}}
        tl_by_date = {g["group_id"] for g in M.search_groups(db, date_searcher, group_type="timeline")}
        check("J15 Timeline search by key_dates finds the exact date match",
              t_date_match["group_id"] in tl_by_date)
        check("J16 Timeline search by key_dates excludes a mismatched date",
              t_date_off["group_id"] not in tl_by_date)
    finally:
        for gid in gids:
            db.collection("groups").document(gid).delete()
        print("  cleaned up test groups")


# ---------------------------------------------------------------------------
# K — HTTP API: /api/groups/search, /find-candidates, /add-members
# ---------------------------------------------------------------------------

def group_k_search_and_candidates_api() -> None:
    print("\nK — HTTP API: group search + find-candidates + add-members (integration)")
    from fastapi.testclient import TestClient
    from google.cloud import firestore
    import api
    api.RATE_LIMIT_MAX = 100000

    db = firestore.Client(project=PROJECT)
    owner = f"test-k-owner-{secrets.token_hex(3)}"
    candidate = f"test-k-candidate-{secrets.token_hex(3)}"
    outsider = f"test-k-outsider-{secrets.token_hex(3)}"
    A = {"X-User-Id": owner}
    gids: list[str] = []
    try:
        db.collection("users").document(owner).set({"username": "kowner"})
        db.collection("users").document(outsider).set({"username": "koutsider"})
        db.collection("users").document(candidate).set(
            {"username": "kcandidate", "current_visa_or_greencard_category": ["H-1B"], "consulates": ["BOM"]})
        with TestClient(api.app) as c:
            g = c.post("/api/groups", json={
                "criteria_text": "K-group", "group_type": "timeline",
                "criteria": {"current_visa_or_greencard_category": ["H-1B"], "consulates": ["BOM"]},
                "members": [],
            }, headers=A)
            gj = g.json()
            gids.append(gj["group_id"])
            check("K1 POST /api/groups honors group_type", gj.get("group_type") == "timeline", str(gj.get("group_type")))

            # K2-K3: /api/groups/search finds it via exact match on the Timeline type
            s = c.post("/api/groups/search", json={
                "criteria": {"current_visa_or_greencard_category": ["H-1B"], "consulates": ["BOM"]},
                "group_type": "timeline", "precision": "balanced",
            })
            found = {x["group_id"] for x in s.json().get("groups", [])}
            check("K2 POST /api/groups/search is public (no auth) and 200s", s.status_code == 200)
            check("K3 POST /api/groups/search finds the exact-match Timeline group", gj["group_id"] in found)

            # K4: searching for group_type="" (regular) does NOT find the Timeline group
            s_regular = c.post("/api/groups/search", json={
                "criteria": {"current_visa_or_greencard_category": ["H-1B"], "consulates": ["BOM"]},
                "group_type": "", "precision": "balanced",
            })
            check("K4 searching group_type='' does not surface the Timeline group",
                  gj["group_id"] not in {x["group_id"] for x in s_regular.json().get("groups", [])})

            # K5-K6: find-candidates — member-only
            check("K5 find-candidates by a non-member → 403",
                  c.post(f"/api/groups/{gj['group_id']}/find-candidates",
                         headers={"X-User-Id": outsider}).status_code == 403)
            fc = c.post(f"/api/groups/{gj['group_id']}/find-candidates", headers=A)
            fc_ids = {m["user_id"] for m in fc.json().get("matches", [])}
            check("K6 find-candidates by a member → 200, finds the seeded candidate",
                  fc.status_code == 200 and candidate in fc_ids, f"status={fc.status_code} ids={fc_ids}")

            check("K7 find-candidates on a missing group → 404",
                  c.post("/api/groups/no-such-group/find-candidates", headers=A).status_code == 404)

            # K8-K10: add-members — member-only, dedupes, adds the found candidate
            check("K8 add-members by a non-member → 403",
                  c.post(f"/api/groups/{gj['group_id']}/add-members", json={"user_ids": [candidate]},
                         headers={"X-User-Id": outsider}).status_code == 403)
            am = c.post(f"/api/groups/{gj['group_id']}/add-members", json={"user_ids": [candidate]}, headers=A)
            check("K9 add-members by a member → 200 and the candidate is INVITED, not added",
                  am.status_code == 200
                  and [i["user_id"] for i in am.json().get("invited", [])] == [candidate]
                  and candidate not in {m["user_id"] for m in am.json()["group"].get("members", [])},
                  f"status={am.status_code} body={am.json()}")
            am2 = c.post(f"/api/groups/{gj['group_id']}/add-members", json={"user_ids": [candidate]}, headers=A)
            check("K10 re-inviting the same candidate is skipped as already_pending, not duplicated",
                  [s["reason"] for s in am2.json().get("skipped", [])] == ["already_pending"],
                  str(am2.json().get("skipped")))
            # Accept so K11 still exercises "an existing MEMBER never resurfaces".
            c.post(f"/api/groups/{gj['group_id']}/invitations/accept", json={},
                   headers={"X-User-Id": candidate})

            # K11: candidate excluded from find-candidates once already a member
            fc2 = c.post(f"/api/groups/{gj['group_id']}/find-candidates", headers=A)
            check("K11 an already-added member no longer surfaces as a find-candidates result",
                  candidate not in {m["user_id"] for m in fc2.json().get("matches", [])})

            check("K12 add-members on a missing group → 404",
                  c.post("/api/groups/no-such-group/add-members", json={"user_ids": [candidate]},
                         headers=A).status_code == 404)
    finally:
        for uid in (owner, outsider, candidate):
            db.collection("users").document(uid).delete()
        for gid in gids:
            db.collection("groups").document(gid).delete()
        print("  cleaned up API test docs")


# ---------------------------------------------------------------------------
# N — live Firestore: member_attributes — join_group() gate, save/list,
# rename lock, HTTP routes
# ---------------------------------------------------------------------------

def group_n_member_attributes_integration() -> None:
    print("\nN — live Firestore: member attributes (integration)")
    from google.cloud import firestore
    import profile as P
    db = firestore.Client(project=PROJECT)

    ids = {k: f"test-n-{k}-{secrets.token_hex(3)}" for k in ("a", "b", "c")}
    db.collection("users").document(ids["a"]).set({"username": "n-alpha"})
    db.collection("users").document(ids["b"]).set({"username": "n-bravo"})
    db.collection("users").document(ids["c"]).set({"username": "n-charlie"})
    gids: list[str] = []
    try:
        crit_1 = {"tags": ["stem-opt-extension"],
                  "key_stages_or_info": {"filing_month": "Sep", "filing_year": "2099"}}
        crit_2 = {"tags": ["stem-opt-extension"],
                  "key_stages_or_info": {"filing_month": "Mar", "filing_year": "2099"}}

        # N1: creating a Timeline group matching a registered template with NO
        # values SUCCEEDS. The attributes moved off the create form entirely —
        # the creator is gated instead by needs_attributes the moment they land
        # on the group page (see find_or_create_group's require=False comment).
        g_bare = M.find_or_create_group(db, ids["a"], "n-group", crit_1, [], "timeline")
        gids.append(g_bare["group_id"])
        check("N1 creating a matched Timeline group with NO attribute values succeeds",
              bool(g_bare.get("group_id")), str(g_bare)[:120])
        bare_doc = db.collection("groups").document(g_bare["group_id"]).get().to_dict()
        check("N1b …and the creator is immediately flagged as still owing them",
              M.compute_needs_attributes(db, g_bare["group_id"], bare_doc, ids["a"]) is True)
        db.collection("groups").document(g_bare["group_id"]).delete()
        gids.pop()

        # N2: providing the required value succeeds — writes both the
        # member_attributes subcollection doc and profile.key_dates.
        g1 = M.find_or_create_group(db, ids["a"], "n-group", crit_1, [], "timeline",
                                    values={"ead_filed_date": "2099-01-15", "rfe_date": "2099-02-01"},
                                    notes="my cohort notes")
        gids.append(g1["group_id"])
        attr_doc = M._member_attributes_ref(db, g1["group_id"]).document(ids["a"]).get()
        check("N2a find_or_create_group's create branch writes a member_attributes doc",
              attr_doc.exists and attr_doc.to_dict().get("values", {}).get("ead_filed_date") == "2099-01-15",
              str(attr_doc.to_dict() if attr_doc.exists else None))
        check("N2b the notes text is stored on the member_attributes doc",
              attr_doc.to_dict().get("notes") == "my cohort notes")
        prof_a = P.get_profile(db, ids["a"])
        check("N2c the submitted values also merge into the user's own profile.key_dates",
              prof_a.get("key_dates", {}).get("ead_filed_date") == "2099-01-15", str(prof_a.get("key_dates")))

        # N3: join_group() on the SAME group with no values raises (a second
        # user joining still needs to supply the required field themselves).
        try:
            M.join_group(db, g1["group_id"], ids["b"])
            check("N3 join_group on a matched Timeline group with no values raises ValueError", False, "no raise")
        except ValueError as e:
            check("N3 join_group on a matched Timeline group with no values raises ValueError",
                  "Date Applied" in str(e), str(e))
        # confirm the rejected join_group call didn't add the member as a side effect
        g1_after = M._group_view(g1["group_id"], db.collection("groups").document(g1["group_id"]).get().to_dict(), ids["a"])
        check("N3b the rejected join_group call added no member (validated before mutation)",
              ids["b"] not in {m["user_id"] for m in g1_after["members"]}, str(g1_after["members"]))

        # N4: join_group() with the required value succeeds.
        joined = M.join_group(db, g1["group_id"], ids["b"], {"ead_filed_date": "2099-03-01"})
        check("N4 join_group with the required value succeeds and adds the member",
              ids["b"] in {m["user_id"] for m in joined["members"]}, str(joined["members"]))
        check("N4b join_group's gate also wrote a member_attributes doc for the joiner",
              M._member_attributes_ref(db, g1["group_id"]).document(ids["b"]).get().exists)

        # N5: a member who already submitted can join_group() again (e.g. a
        # re-invite/no-op) without being re-gated — no values needed.
        rejoin = M.join_group(db, g1["group_id"], ids["b"])
        check("N5 a member with an existing attributes doc is not re-gated on a subsequent join_group call",
              ids["b"] in {m["user_id"] for m in rejoin["members"]}, str(rejoin))

        # N6-N8: save_member_attributes() permission/validation cases
        try:
            M.save_member_attributes(db, g1["group_id"], ids["c"], {"ead_filed_date": "2099-04-01"})
            check("N6 save_member_attributes by a non-member raises PermissionError", False, "no raise")
        except PermissionError:
            check("N6 save_member_attributes by a non-member raises PermissionError", True)

        try:
            M.save_member_attributes(db, g1["group_id"], ids["b"], {"rfe_date": "2099-02-01"})
            check("N7 save_member_attributes missing the required field raises ValueError", False, "no raise")
        except ValueError as e:
            check("N7 save_member_attributes missing the required field raises ValueError",
                  "Date Applied" in str(e), str(e))

        # O-1, not H-1B — H-1B now configures a 12-row petition template.
        g_no_template = M.find_or_create_group(
            db, ids["c"], "n-no-template", {"current_visa_or_greencard_category": ["O-1"]}, [], "timeline")
        gids.append(g_no_template["group_id"])
        try:
            M.save_member_attributes(db, g_no_template["group_id"], ids["c"], {"anything": "x"})
            check("N8 save_member_attributes on a group with no registered template raises ValueError", False, "no raise")
        except ValueError:
            check("N8 save_member_attributes on a group with no registered template raises ValueError", True)

        # N9: compute_needs_attributes reflects an invited/gated member for
        # real Firestore state (not just the pure fast-paths from group M).
        g1_data = db.collection("groups").document(g1["group_id"]).get().to_dict()
        M._member_attributes_ref(db, g1["group_id"]).document(ids["b"]).delete()  # simulate not-yet-submitted
        check("N9 compute_needs_attributes is True for a member with no submitted attributes doc",
              M.compute_needs_attributes(db, g1["group_id"], g1_data, ids["b"]) is True)
        M.save_member_attributes(db, g1["group_id"], ids["b"], {"ead_filed_date": "2099-03-01"})
        check("N9b compute_needs_attributes is False again once the member submits via save_member_attributes",
              M.compute_needs_attributes(db, g1["group_id"], g1_data, ids["b"]) is False)

        # N10-N11: list_member_attributes() membership gating + shared visibility
        try:
            M.list_member_attributes(db, g1["group_id"], ids["c"])
            check("N10 list_member_attributes by a non-member raises PermissionError", False, "no raise")
        except PermissionError:
            check("N10 list_member_attributes by a non-member raises PermissionError", True)
        shared = M.list_member_attributes(db, g1["group_id"], ids["b"])
        shared_uids = {d.get("user_id") for d in shared}
        check("N11 list_member_attributes by a member returns the whole cohort's submissions, not just their own",
              shared_uids == {ids["a"], ids["b"]}, str(shared_uids))

        # N12-N13: rename_group() rejects a Timeline name change but allows description
        try:
            M.rename_group(db, g1["group_id"], ids["a"], name="a new name")
            check("N12 rename_group rejects a Timeline group name change", False, "no raise")
        except ValueError:
            check("N12 rename_group rejects a Timeline group name change", True)
        renamed = M.rename_group(db, g1["group_id"], ids["a"], description="updated cohort description")
        check("N13 rename_group still allows a Timeline group's description to change",
              renamed["description"] == "updated cohort description", renamed["description"])

        # N14: name-based dedup — a second create with identical processing
        # type/cycle/year (crit_2 differs only in an unrelated field vs crit_1
        # would collide; here confirm a DIFFERENT cycle opens a fresh group)
        g2 = M.find_or_create_group(db, ids["a"], "n-group-2", crit_2, [], "timeline",
                                    values={"ead_filed_date": "2099-05-01"})
        gids.append(g2["group_id"])
        check("N14 a different Cycle/Year produces a different Timeline group name (no false collision)",
              g2["group_id"] != g1["group_id"] and g2["name"] != g1["name"], f"{g2['name']} vs {g1['name']}")

        # N14b: a soft-deleted group sharing the same name must never poison
        # dedup for later creates — regression for a real bug where
        # _find_group_by_name()'s bare .limit(1) could return an arbitrary
        # doc (Firestore equality-query order is unspecified), so once ANY
        # dead group existed under a name, a fresh active group with the
        # same name would never be found and joins would silently fork into
        # duplicates forever.
        dead_criteria = {"tags": ["stem-opt-extension"],
                         "key_stages_or_info": {"filing_month": "Sep", "filing_year": "2098"}}
        dead_ead = {"ead_filed_date": "2099-07-01"}
        dead = M.find_or_create_group(db, ids["a"], "dead group", dead_criteria, [], "timeline", values=dead_ead)
        gids.append(dead["group_id"])
        M.delete_group(db, dead["group_id"], ids["a"])
        alive = M.find_or_create_group(db, ids["b"], "alive group, same name as the dead one",
                                       dead_criteria, [], "timeline", values=dead_ead)
        gids.append(alive["group_id"])
        check("N14b a dead group under the same name doesn't block dedup for a later active create",
              alive["group_id"] != dead["group_id"] and alive["name"] == dead["name"], str(alive))
        rejoin = M.find_or_create_group(db, ids["c"], "third create, same name — must join the ALIVE one",
                                        dead_criteria, [], "timeline", values=dead_ead)
        gids.append(rejoin["group_id"])
        check("N14c a third create with the same name joins the alive group, not the dead one or a new one",
              rejoin["joined"] is True and rejoin["group_id"] == alive["group_id"], str(rejoin))

        # N15-N18: HTTP layer — /api/groups/{id}/attributes routes +
        # extended join/create bodies
        from fastapi.testclient import TestClient
        import api
        api.RATE_LIMIT_MAX = 100000
        db.collection("users").document(ids["a"]).set({"username": "n-alpha"})
        with TestClient(api.app) as c:
            A = {"X-User-Id": ids["a"]}
            Bh = {"X-User-Id": ids["b"]}
            Ch = {"X-User-Id": ids["c"]}

            r_no_values = c.post("/api/groups", json={
                "criteria_text": "n-http-group", "group_type": "timeline",
                "criteria": {"tags": ["stem-opt-extension"],
                            "key_stages_or_info": {"filing_month": "Jan", "filing_year": "2099"}},
                "members": [],
            }, headers=A)
            # No longer a 422: attributes are collected on the group page after
            # creation, not on the find/create panel.
            check("N15 POST /api/groups with a matched Timeline type and no values → 200",
                  r_no_values.status_code == 200, str(r_no_values.status_code))
            if r_no_values.status_code == 200:
                check("N15b …and the response flags needs_attributes for the creator",
                      r_no_values.json().get("needs_attributes") is True, str(r_no_values.json())[:160])
                gids.append(r_no_values.json()["group_id"])

            r_created = c.post("/api/groups", json={
                "criteria_text": "n-http-group", "group_type": "timeline",
                "criteria": {"tags": ["stem-opt-extension"],
                            "key_stages_or_info": {"filing_month": "Jan", "filing_year": "2099"}},
                "members": [], "values": {"ead_filed_date": "2099-06-01"},
            }, headers=A)
            gj = r_created.json()
            gids.append(gj["group_id"])
            check("N16 POST /api/groups with the required value → 201-equivalent 200, needs_attributes False for the creator",
                  r_created.status_code == 200 and gj["needs_attributes"] is False, str(gj))

            r_join_bad = c.post(f"/api/groups/{gj['group_id']}/join", json={}, headers=Bh)
            check("N17 POST /api/groups/{id}/join with no body values → 422",
                  r_join_bad.status_code == 422, str(r_join_bad.status_code))
            r_join_ok = c.post(f"/api/groups/{gj['group_id']}/join",
                               json={"values": {"ead_filed_date": "2099-06-15"}, "notes": "joining via HTTP"},
                               headers=Bh)
            check("N18 POST /api/groups/{id}/join with values → 200, joined",
                  r_join_ok.status_code == 200 and ids["b"] in {m["user_id"] for m in r_join_ok.json()["members"]},
                  str(r_join_ok.status_code))

            r_get = c.get(f"/api/groups/{gj['group_id']}", headers=Ch)
            check("N19 GET /api/groups/{id} 200s for a non-member with needs_attributes False (fast path)",
                  r_get.status_code == 200 and r_get.json()["needs_attributes"] is False, str(r_get.json()))

            r_attrs_post = c.post(f"/api/groups/{gj['group_id']}/attributes",
                                  json={"values": {"ead_filed_date": "2099-06-20"}, "notes": "via attributes route"},
                                  headers=Ch)
            check("N20 POST /api/groups/{id}/attributes by a non-member → 403",
                  r_attrs_post.status_code == 403, str(r_attrs_post.status_code))

            r_attrs_get = c.get(f"/api/groups/{gj['group_id']}/attributes", headers=Bh)
            attrs_json = r_attrs_get.json()
            check("N21 GET /api/groups/{id}/attributes by a member → 200, includes their own submission",
                  r_attrs_get.status_code == 200 and
                  any(a["user_id"] == ids["b"] for a in attrs_json.get("attributes", [])), str(attrs_json))

            r_rename_bad = c.put(f"/api/groups/{gj['group_id']}", json={"name": "renamed"}, headers=A)
            check("N22 PUT /api/groups/{id} rejects a Timeline name change over HTTP → 422",
                  r_rename_bad.status_code == 422, str(r_rename_bad.status_code))
    finally:
        for gid in gids:
            for doc in M._member_attributes_ref(db, gid).stream():
                doc.reference.delete()
            db.collection("groups").document(gid).delete()
        for uid in ids.values():
            db.collection("users").document(uid).delete()
        print("  cleaned up member-attributes test docs")


# ---------------------------------------------------------------------------
# P — live Firestore: invitations. The load-bearing property is that a PENDING
# invitee is invisible to every existing membership read, with no changes to
# any of those reads.
# ---------------------------------------------------------------------------

def _purge_invitations(db, group_ids: list[str]) -> None:
    from google.cloud.firestore_v1.base_query import FieldFilter
    for gid in group_ids:
        for doc in db.collection("group_invitations").where(
                filter=FieldFilter("group_id", "==", gid)).stream():
            doc.reference.delete()


def group_p_invitations_integration() -> None:
    print("\nP — live Firestore: invitations (integration)")
    from google.cloud import firestore
    import group_messages
    db = firestore.Client(project=PROJECT)

    ids = {k: f"test-p-{k}-{secrets.token_hex(3)}" for k in ("a", "b", "c")}
    db.collection("users").document(ids["a"]).set({"username": "p-alpha"})
    db.collection("users").document(ids["b"]).set({"username": "p-bravo"})
    db.collection("users").document(ids["c"]).set({"username": "p-charlie"})
    gids: list[str] = []
    try:
        reg = {"current_visa_or_greencard_category": ["SIV"], "consulates": ["FRA"]}
        g = M.find_or_create_group(db, ids["a"], "p-regular", reg, [], "")
        gid = g["group_id"]
        gids.append(gid)

        # --- P1-P7: a pending invitee is NOT a member, anywhere -------------
        inv = M.create_invitation(db, gid, ids["a"], ids["b"])
        check("P1 create_invitation writes group_invitations/{gid}__{uid} as pending",
              inv["status"] == "pending" and inv["invitation_id"] == f"{gid}__{ids['b']}", str(inv))
        fresh = db.collection("groups").document(gid).get().to_dict()
        check("P2 …and groups/{id}.members is UNCHANGED — the invitee is not a member",
              {m["user_id"] for m in fresh["members"]} == {ids["a"]}, str(fresh["members"]))
        check("P3 _group_view().is_member is False for the pending invitee",
              M._group_view(gid, fresh, ids["b"])["is_member"] is False)
        try:
            group_messages._require_member(db, gid, ids["b"])
            check("P4 group chat stays locked to a pending invitee", False, "no raise")
        except PermissionError:
            check("P4 group chat stays locked to a pending invitee", True)
        try:
            M.list_member_attributes(db, gid, ids["b"])
            check("P5 list_member_attributes rejects a pending invitee", False, "no raise")
        except PermissionError:
            check("P5 list_member_attributes rejects a pending invitee", True)
        check("P6 my_groups() does not include a group you're only invited to",
              gid not in {x["group_id"] for x in M.my_groups(db, ids["b"])})
        browse = {x["group_id"]: x for x in M.list_all_groups(db, ids["b"])}
        check("P7 list_all_groups marks it is_invited=True, is_member=False for the invitee",
              browse[gid]["is_invited"] is True and browse[gid]["is_member"] is False, str(browse[gid].get("is_invited")))
        owner_browse = {x["group_id"]: x for x in M.list_all_groups(db, ids["a"])}
        check("P7b …and is_invited=False, is_member=True for the actual member",
              owner_browse[gid]["is_invited"] is False and owner_browse[gid]["is_member"] is True)

        # --- P8-P9: the two read surfaces -----------------------------------
        mine = M.list_pending_invitations_for_user(db, ids["b"])
        check("P8 list_pending_invitations_for_user returns it with a live hydrated group",
              len(mine) == 1 and mine[0]["group"]["group_id"] == gid
              and mine[0]["invitation"]["requires_attributes"] is False, str(mine))
        check("P9 list_pending_invitations_for_group returns it for a member",
              len(M.list_pending_invitations_for_group(db, gid, ids["a"])) == 1)
        try:
            M.list_pending_invitations_for_group(db, gid, ids["c"])
            check("P9b …and rejects a non-member", False, "no raise")
        except PermissionError:
            check("P9b …and rejects a non-member", True)

        # --- P10-P15: guards -------------------------------------------------
        inv2 = M.invite_member(db, gid, ids["a"], "p-charlie")
        check("P10 invite_member by handle creates an invitation, adds no member",
              inv2["status"] == "pending" and len(
                  db.collection("groups").document(gid).get().to_dict()["members"]) == 1, str(inv2))
        again = M.create_invitation(db, gid, ids["a"], ids["b"])
        check("P11 re-inviting a pending invitee is idempotent — same doc, created_at preserved",
              again["invitation_id"] == inv["invitation_id"] and again["created_at"] == inv["created_at"], str(again))
        for label, fn, exc in [
            ("P12 inviting an existing member raises ValueError",
             lambda: M.create_invitation(db, gid, ids["a"], ids["a"]), ValueError),
            ("P13 self-invite raises ValueError",
             lambda: M.create_invitation(db, gid, ids["a"], ids["a"]), ValueError),
            ("P14 a non-member can't invite (PermissionError)",
             lambda: M.create_invitation(db, gid, ids["c"], ids["b"]), PermissionError),
            ("P14b inviting an unknown uid raises ValueError",
             lambda: M.create_invitation(db, gid, ids["a"], "no-such-user-xyz"), ValueError),
        ]:
            try:
                fn()
                check(label, False, "no raise")
            except exc:
                check(label, True)

        arch = M.find_or_create_group(db, ids["a"], "p-archived",
                                      {"current_visa_or_greencard_category": ["SIV"], "consulates": ["MNL"]}, [], "")
        gids.append(arch["group_id"])
        M.archive_group(db, arch["group_id"], ids["a"], True)
        try:
            M.create_invitation(db, arch["group_id"], ids["a"], ids["b"])
            check("P15 inviting into an ARCHIVED group raises ValueError (a gap invite_member had before)",
                  False, "no raise")
        except ValueError:
            check("P15 inviting into an ARCHIVED group raises ValueError (a gap invite_member had before)", True)

        # --- P16-P19: accept --------------------------------------------------
        accepted = M.accept_invitation(db, gid, ids["b"])
        check("P16 accept adds the member and flips the invitation to accepted",
              ids["b"] in {m["user_id"] for m in accepted["members"]}, str(accepted["members"]))
        check("P16b …and my_groups now includes it",
              gid in {x["group_id"] for x in M.my_groups(db, ids["b"])})
        check("P19 double-accept is idempotent (no raise, no duplicate member)",
              len(M.accept_invitation(db, gid, ids["b"])["members"]) == 2)

        tl_crit = {"tags": ["stem-opt-extension"],
                   "key_stages_or_info": {"filing_month": "Sep", "filing_year": "2094"}}
        tl = M.find_or_create_group(db, ids["a"], "p-timeline", tl_crit, [], "timeline",
                                    values={"ead_filed_date": "2094-01-01"})
        tgid = tl["group_id"]
        gids.append(tgid)
        M.create_invitation(db, tgid, ids["a"], ids["c"])
        tl_mine = M.list_pending_invitations_for_user(db, ids["c"])
        check("P8b requires_attributes is True for a matched Timeline group",
              tl_mine and tl_mine[0]["invitation"]["requires_attributes"] is True, str(tl_mine))
        try:
            M.accept_invitation(db, tgid, ids["c"])
            check("P17 accepting a matched Timeline invite with NO values raises ValueError", False, "no raise")
        except ValueError as e:
            check("P17 accepting a matched Timeline invite with NO values raises ValueError",
                  "Date Applied" in str(e), str(e))
        after = db.collection("groups").document(tgid).get().to_dict()
        check("P17b …and NO member was added (validated before mutation)",
              ids["c"] not in {m["user_id"] for m in after["members"]}, str(after["members"]))
        check("P17c …and the invitation is still pending, so it can be retried",
              db.collection("group_invitations").document(
                  M._invitation_id(tgid, ids["c"])).get().to_dict()["status"] == "pending")
        M.accept_invitation(db, tgid, ids["c"], {"ead_filed_date": "2094-03-01"})
        check("P18 accepting WITH the required value succeeds and writes member_attributes",
              M._member_attributes_ref(db, tgid).document(ids["c"]).get().exists)
        check("P18b …and merges into the accepter's own profile.key_dates",
              (db.collection("users").document(ids["c"]).get().to_dict().get("key_dates") or {})
              .get("ead_filed_date") == "2094-03-01")

        # --- P20-P22: decline ------------------------------------------------
        solo = M.find_or_create_group(db, ids["a"], "p-solo",
                                      {"current_visa_or_greencard_category": ["SIV"], "consulates": ["KTM"]}, [], "")
        sgid = solo["group_id"]
        gids.append(sgid)
        M.create_invitation(db, sgid, ids["a"], ids["b"])
        dec = M.decline_invitation(db, sgid, ids["b"])
        solo_after = db.collection("groups").document(sgid).get().to_dict()
        check("P20 declining NEVER soft-deletes the group — a 1-member group survives its "
              "only invitee declining (decline must not route through leave_group)",
              dec["status"] == "declined" and M._effective_status(solo_after) == "active"
              and len(solo_after["members"]) == 1, str(solo_after.get("status")))
        check("P20b decline is idempotent", M.decline_invitation(db, sgid, ids["b"])["status"] == "declined")
        try:
            M.accept_invitation(db, sgid, ids["b"])
            check("P21 accepting after declining raises ValueError", False, "no raise")
        except ValueError:
            check("P21 accepting after declining raises ValueError", True)
        try:
            M.decline_invitation(db, gid, ids["b"])  # b already accepted gid
            check("P21b declining after accepting raises ValueError", False, "no raise")
        except ValueError:
            check("P21b declining after accepting raises ValueError", True)
        revived = M.create_invitation(db, sgid, ids["a"], ids["b"])
        check("P22 re-inviting after a decline revives to pending, carrying declined_count",
              revived["status"] == "pending"
              and db.collection("group_invitations").document(
                  M._invitation_id(sgid, ids["b"])).get().to_dict()["declined_count"] == 1, str(revived))

        # --- P23-P25: cancellation -------------------------------------------
        M.archive_group(db, sgid, ids["a"], True)
        try:
            M.accept_invitation(db, sgid, ids["b"])
            check("P23 accepting into a group archived after the invite raises ValueError", False, "no raise")
        except ValueError:
            check("P23 accepting into a group archived after the invite raises ValueError", True)
        check("P23b …and the invitation is marked cancelled with a reason",
              db.collection("group_invitations").document(M._invitation_id(sgid, ids["b"])).get()
              .to_dict()["cancel_reason"] == "group_inactive")
        check("P23c …and it disappears from the invitee's list",
              sgid not in {e["invitation"]["group_id"] for e in M.list_pending_invitations_for_user(db, ids["b"])})

        delg = M.find_or_create_group(db, ids["a"], "p-deleted",
                                      {"current_visa_or_greencard_category": ["SIV"], "consulates": ["ABJ"]}, [], "")
        gids.append(delg["group_id"])
        M.create_invitation(db, delg["group_id"], ids["a"], ids["b"])
        M.delete_group(db, delg["group_id"], ids["a"])
        check("P24 deleting a group cancels its pending invitations",
              db.collection("group_invitations").document(
                  M._invitation_id(delg["group_id"], ids["b"])).get().to_dict()["status"] == "cancelled")

        lastg = M.find_or_create_group(db, ids["a"], "p-lastleave",
                                       {"current_visa_or_greencard_category": ["SIV"], "consulates": ["ACC"]}, [], "")
        gids.append(lastg["group_id"])
        M.create_invitation(db, lastg["group_id"], ids["a"], ids["b"])
        M.leave_group(db, lastg["group_id"], ids["a"])  # last member → soft-delete branch
        check("P25 the last member leaving (soft-delete branch) also cancels pending invitations",
              db.collection("group_invitations").document(
                  M._invitation_id(lastg["group_id"], ids["b"])).get().to_dict()["status"] == "cancelled")

        # --- P26-P28: the other add-paths -------------------------------------
        # ids["c"] already has a pending invite from P10 and ids["b"] accepted
        # in P16, so this exercises three different skip reasons at once
        # alongside one genuinely fresh invite.
        db.collection("users").document(f"{ids['a']}-d").set({"username": "p-delta"})
        fresh_uid = f"{ids['a']}-d"
        bulk = M.add_members(db, gid, ids["a"], [ids["c"], ids["b"], "unknown-uid-zzz", fresh_uid])
        check("P26 add_members INVITES rather than adding — members unchanged",
              len(bulk["group"]["members"]) == 2, str(bulk["group"]["members"]))
        reasons = {s["user_id"]: s["reason"] for s in bulk["skipped"]}
        check("P26b …and reports per-candidate skips without aborting the batch",
              reasons.get(ids["b"]) == "already_member"
              and reasons.get(ids["c"]) == "already_pending"
              and reasons.get("unknown-uid-zzz") == "unknown_user"
              and [i["user_id"] for i in bulk["invited"]] == [fresh_uid],
              f"skipped={bulk['skipped']} invited={[i['user_id'] for i in bulk['invited']]}")
        db.collection("users").document(fresh_uid).delete()

        peer = M.find_or_create_group(db, ids["a"], "p-peers",
                                      {"current_visa_or_greencard_category": ["SIV"], "consulates": ["ADD"]},
                                      [{"user_id": ids["b"], "username": "p-bravo"}], "")
        gids.append(peer["group_id"])
        check("P27 find_or_create_group's create branch adds ONLY the creator as a member…",
              {m["user_id"] for m in peer["members"]} == {ids["a"]}, str(peer["members"]))
        check("P27b …and invites the peers instead",
              len(peer.get("invited") or []) == 1
              and peer["invited"][0]["user_id"] == ids["b"], str(peer.get("invited")))

        # --- P28: joined-not-accepted self-heals (found in live walkthrough) --
        # An invitee who arrives via the join preview or a shared link calls
        # join_group(), never accept_invitation(), so their invitation stays
        # `pending` forever. Without a read-time member filter the sidebar
        # listed the same person under BOTH "Members" and "Invited · awaiting
        # reply". The user-scoped reader always filtered; this one didn't.
        joiner = f"test-p-j-{secrets.token_hex(3)}"
        ids["j"] = joiner
        db.collection("users").document(joiner).set({"username": "p-joiner"})
        M.create_invitation(db, gid, ids["a"], joiner)
        check("P28 the invitee is listed as pending before joining",
              joiner in {i["user_id"] for i in
                         M.list_pending_invitations_for_group(db, gid, ids["a"])})
        M.join_group(db, gid, joiner)          # the join preview path, NOT accept
        check("P28b …and is dropped from the group's pending list once they're a member",
              joiner not in {i["user_id"] for i in
                             M.list_pending_invitations_for_group(db, gid, ids["a"])},
              str(M.list_pending_invitations_for_group(db, gid, ids["a"])))
        check("P28c …and from their own invitations feed too",
              gid not in {e["invitation"]["group_id"]
                          for e in M.list_pending_invitations_for_user(db, joiner)})

        # --- P29-P30: candidate exclusion + backwards compatibility -----------
        check("P29 pending_invitee_ids surfaces the outstanding invitee for candidate exclusion",
              ids["c"] in M.pending_invitee_ids(db, gid), str(M.pending_invitee_ids(db, gid)))

        legacy = _seed_group(db, ids["a"], "p-legacy", {"current_visa_or_greencard_category": ["SIV"]})
        gids.append(legacy["group_id"])
        check("P30 a legacy group whose members were written directly reads identically — "
              "no invitations, is_invited False, nothing breaks",
              M.list_pending_invitations_for_group(db, legacy["group_id"], ids["a"]) == []
              and {x["group_id"]: x for x in M.list_all_groups(db, ids["a"])}[
                  legacy["group_id"]]["is_invited"] is False)
    finally:
        _purge_invitations(db, gids)
        for gid_ in gids:
            for doc in M._member_attributes_ref(db, gid_).stream():
                doc.reference.delete()
            db.collection("groups").document(gid_).delete()
        for uid in ids.values():
            db.collection("users").document(uid).delete()
        print("  cleaned up invitation test docs")


# ---------------------------------------------------------------------------
# Q — HTTP routes for invitations + the find-candidates repair
# ---------------------------------------------------------------------------

def group_q_invitations_api() -> None:
    print("\nQ — HTTP API: invitations + find-candidates repair (integration)")
    from fastapi.testclient import TestClient
    from google.cloud import firestore
    import api
    api.RATE_LIMIT_MAX = 100000
    db = firestore.Client(project=PROJECT)

    ids = {k: f"test-q-{k}-{secrets.token_hex(3)}" for k in ("a", "b")}
    db.collection("users").document(ids["a"]).set({"username": "q-alpha"})
    db.collection("users").document(ids["b"]).set({"username": "q-bravo"})
    gids: list[str] = []
    try:
        A = {"X-User-Id": ids["a"]}
        B = {"X-User-Id": ids["b"]}
        with TestClient(api.app) as c:
            r = c.post("/api/groups", json={
                "criteria_text": "q-group", "group_type": "",
                "criteria": {"current_visa_or_greencard_category": ["SIV"], "consulates": ["AKL"]},
                "members": [],
            }, headers=A)
            gj = r.json()
            gids.append(gj["group_id"])
            gid = gj["group_id"]

            # Q1: the route-ordering constraint. If /api/groups/invitations were
            # declared below GET /api/groups/{group_id}, "invitations" would be
            # captured as a group id and this would 404 "Group not found".
            r_inv = c.get("/api/groups/invitations", headers=B)
            check("Q1 GET /api/groups/invitations resolves to the invitations route, "
                  "NOT get_group_route (route-ordering constraint)",
                  r_inv.status_code == 200 and "invitations" in r_inv.json(), str(r_inv.json()))

            # Same constraint for the preview route — and it must not need
            # auth, since the create screen shows the name before you commit.
            before = len(c.get("/api/groups/all", headers=A).json()["groups"])
            r_prev = c.post("/api/groups/preview", json={
                "group_type": "timeline",
                "criteria": {"current_visa_or_greencard_category": ["H-1B"],
                             "tags": ["change-of-status-COS"],
                             "key_stages_or_info": {"filing_month": "Mar", "filing_year": "2026"}}})
            check("Q1b POST /api/groups/preview resolves, needs no auth, and returns "
                  "the generated name + description",
                  r_prev.status_code == 200
                  and r_prev.json()["name"] == "H-1B-change-of-status-COS-Mar-2026"
                  and "Change of Status" in r_prev.json()["description"], str(r_prev.json()))
            check("Q1c …and previewing creates nothing",
                  len(c.get("/api/groups/all", headers=A).json()["groups"]) == before)

            r2 = c.post(f"/api/groups/{gid}/invite", json={"handle": "q-bravo"}, headers=A)
            check("Q2 POST /invite → 200 and returns an InvitationCard (not a group card)",
                  r2.status_code == 200 and r2.json().get("status") == "pending"
                  and "invitation_id" in r2.json(), str(r2.json()))
            check("Q2b …and GET /api/groups/{id} shows no new member",
                  len(c.get(f"/api/groups/{gid}", headers=A).json()["members"]) == 1)

            mine = c.get("/api/groups/invitations", headers=B).json()
            check("Q3 the invitee sees it, with the group embedded and is_member False",
                  mine["total"] == 1 and mine["invitations"][0]["group"]["is_member"] is False, str(mine))

            r_dec = c.post(f"/api/groups/{gid}/invitations/decline", headers=B)
            check("Q6 POST /invitations/decline → 200, status declined",
                  r_dec.status_code == 200 and r_dec.json()["status"] == "declined", str(r_dec.json()))
            check("Q6b …and the group still exists with its original member",
                  len(c.get(f"/api/groups/{gid}", headers=A).json()["members"]) == 1)

            c.post(f"/api/groups/{gid}/invite", json={"handle": "q-bravo"}, headers=A)
            r_acc = c.post(f"/api/groups/{gid}/invitations/accept", json={}, headers=B)
            check("Q5 POST /invitations/accept → 200 and the invitee is now a member",
                  r_acc.status_code == 200
                  and ids["b"] in {m["user_id"] for m in r_acc.json()["members"]}, str(r_acc.status_code))

            check("Q7 accepting with no invitation on record → 404",
                  c.post(f"/api/groups/{gid}/invitations/accept", json={},
                         headers={"X-User-Id": ids["a"]}).status_code == 404)

            # Timeline gate over HTTP
            rt = c.post("/api/groups", json={
                "criteria_text": "q-timeline", "group_type": "timeline",
                "criteria": {"tags": ["stem-opt-extension"],
                             "key_stages_or_info": {"filing_month": "Mar", "filing_year": "2093"}},
                "members": [], "values": {"ead_filed_date": "2093-01-01"},
            }, headers=A)
            tgid = rt.json()["group_id"]
            gids.append(tgid)
            c.post(f"/api/groups/{tgid}/invite", json={"handle": "q-bravo"}, headers=A)
            check("Q4 accepting a matched Timeline invite with no values → 422",
                  c.post(f"/api/groups/{tgid}/invitations/accept", json={}, headers=B).status_code == 422)
            check("Q4b …and with the required value → 200, needs_attributes False",
                  (lambda r: r.status_code == 200 and r.json()["needs_attributes"] is False)(
                      c.post(f"/api/groups/{tgid}/invitations/accept",
                             json={"values": {"ead_filed_date": "2093-05-05"}}, headers=B)))

            check("Q8 GET /api/groups/{id}/invitations by a non-member → 403",
                  c.get(f"/api/groups/{gid}/invitations",
                        headers={"X-User-Id": "nobody-xyz"}).status_code in (403, 404, 400))

            r_bulk = c.post(f"/api/groups/{gid}/add-members", json={"user_ids": [ids["b"]]}, headers=A)
            check("Q10 POST /add-members returns {group, invited, skipped}",
                  r_bulk.status_code == 200 and set(r_bulk.json()) == {"group", "invited", "skipped"},
                  str(sorted(r_bulk.json())))

            r_peer = c.post("/api/groups", json={
                "criteria_text": "q-peers", "group_type": "",
                "criteria": {"current_visa_or_greencard_category": ["SIV"], "consulates": ["AMM"]},
                "members": [{"user_id": ids["b"], "username": "q-bravo"}],
            }, headers=A)
            pj = r_peer.json()
            gids.append(pj["group_id"])
            check("Q9 POST /api/groups with peers → only the creator is a member, peers are invited",
                  len(pj["members"]) == 1 and len(pj["invited"]) == 1, str(pj["members"]))

            # The find-candidates repair, end to end.
            r_fc = c.post(f"/api/groups/{gid}/find-candidates", headers=A)
            check("Q11 find-candidates 200s and every match carries a human reason",
                  r_fc.status_code == 200
                  and all("reason" in m for m in r_fc.json()["matches"]), str(r_fc.status_code))
            returned = {m["user_id"] for m in r_fc.json()["matches"]}
            member_ids = {m["user_id"] for m in c.get(f"/api/groups/{gid}", headers=A).json()["members"]}
            check("Q12 …and never re-offers an existing member or a pending invitee",
                  not (returned & member_ids) and not (returned & M.pending_invitee_ids(db, gid)),
                  str(returned & member_ids))
    finally:
        _purge_invitations(db, gids)
        for gid_ in gids:
            for doc in M._member_attributes_ref(db, gid_).stream():
                doc.reference.delete()
            db.collection("groups").document(gid_).delete()
        for uid in ids.values():
            db.collection("users").document(uid).delete()
        print("  cleaned up invitation API test docs")


def main() -> int:
    if not PROJECT:
        print("GCP_PROJECT_ID must be set")
        return 2
    only = sys.argv[1] if len(sys.argv) > 1 else "all"
    print(f"Matching tests — project={PROJECT}  (scope={only})")

    group_a_pure()
    group_d_dates()
    group_g_match_criteria()
    group_i_tags_and_exact_pure()
    group_m_attributes_pure()
    group_o_invitations_pure()
    if only in ("all", "integration"):
        group_b_firestore()
        group_c_api()
        group_e_merge_match()
        group_f_dates_match()
        group_h_match_integration()
        group_j_search_groups()
        group_k_search_and_candidates_api()
        group_l_lifecycle()
        group_n_member_attributes_integration()
        group_p_invitations_integration()
        group_q_invitations_api()

    print("\n" + "=" * 60)
    passed = sum(1 for _, ok in _results if ok)
    failed = [n for n, ok in _results if not ok]
    print(f"SUMMARY: {passed}/{len(_results)} checks passed")
    if failed:
        print("FAILED: " + "; ".join(failed))
        return 1
    print("All matching checks passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
