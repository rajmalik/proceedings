#!/usr/bin/env python3
"""No-GCP, no-network tests for federal_register_poll.py (the Federal Register
adapter — docs/ingestion/FEDERAL-REGISTER-GROUNDING-PLAN.md).

The FR API (_get_json) and full-text fetch (_get_text) are stubbed with
recorded-shape fixtures; publish is an injected recorder. Covers:
  A  selector config contract
  B  immigration-only filter (L2-L4) incl. edge cases seen in the live dry run
  C  status labels / final-rule detection
  D  excerpt extraction from GPO raw text (ToC / abbreviation-list skipping)
  E  digest shape (operational facts first, word cap, tag_text, disclaimers)
  F  poll: incremental (known id => zero fetch/publish), cap, dry-run,
     failures, API outage, supersession, force
  G  gov_news_poll dispatch + publish_gov_news_item tag_text/ingestion_method
  H  deterministic e2e: TPS question -> gov-tier answer citing federalregister.gov

Run:  python tests/test_federal_register.py      (wired into the CI gate)
"""
import json
import sys
import tempfile
from datetime import date
from pathlib import Path

_BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_BACKEND))

import federal_register_poll as fr  # noqa: E402

_passed = 0
_failed = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global _passed, _failed
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f" — {detail}" if detail else ""))
    if ok:
        _passed += 1
    else:
        _failed += 1


CFG = fr.load_config()
USCIS = {"slug": "u-s-citizenship-and-immigration-services", "name": "U.S. Citizenship and Immigration Services"}
DHS = {"slug": "homeland-security-department", "name": "Homeland Security Department"}
CBP = {"slug": "u-s-customs-and-border-protection", "name": "U.S. Customs and Border Protection"}
DOL = {"slug": "employment-and-training-administration", "name": "Employment and Training Administration"}
STATE = {"slug": "state-department", "name": "State Department"}


def doc(dn, type_="Rule", title="A rule", action="Final rule.", agencies=(DHS,), cfr=((8, "214"),),
        pub="2026-09-01", abstract="DHS amends its regulations governing nonimmigrant workers.",
        rins=(), **kw):
    d = {"document_number": dn, "type": type_, "title": title, "action": action,
         "agencies": list(agencies), "cfr_references": [{"title": t, "part": p} for t, p in cfr],
         "publication_date": pub, "abstract": abstract, "dates": "Effective October 1, 2026.",
         "effective_on": kw.pop("effective_on", "2026-10-01" if type_ == "Rule" else None),
         "comments_close_on": kw.pop("comments_close_on", None),
         "regulation_id_numbers": list(rins), "docket_ids": ["DHS-2026-0001"],
         "citation": "91 FR 1000", "correction_of": kw.pop("correction_of", None),
         "html_url": f"https://www.federalregister.gov/d/{dn}",
         "pdf_url": f"https://www.govinfo.gov/{dn}.pdf",
         "raw_text_url": f"https://www.federalregister.gov/raw/{dn}.txt"}
    d.update(kw)
    return d


PROSE = ("    The Secretary of Homeland Security has determined that the conditions for the designation \n"
         "continue to be met. Eligible nationals may re-register and apply for employment \n"
         "authorization documents during the re-registration period described in this notice. \n")
GPO_RULE = ("<html><body><pre>\n[Federal Register]\nSUMMARY: short\n\nSUPPLEMENTARY INFORMATION:\n\n"
            "Table of Contents\n\nI. Public Participation\nII. Executive Summary\n"
            "    A. Purpose of the Regulatory Action\n    B. Summary of Legal Authority\n"
            "III. Background\n    1. Statutes and Case Law, Pre-IIRIRA and the INS 1999 Notice of Proposed\n\n"
            "I. Public Participation\n\n    All interested parties are invited to participate in this rulemaking \n"
            "by submitting written data, views, comments and arguments on all aspects. \n\n"
            "II. Executive Summary\n\nA. Purpose of the Regulatory Action\n\n"
            "    The purpose of this rulemaking is to change the H-1B selection process so that \n"
            "registrations are weighted by wage level.\\1\\ DHS expects this to favor higher-paid \n"
            "workers while maintaining access for all employers. \n</pre></body></html>")
GPO_TPS = ("<html><body><pre>\nSUPPLEMENTARY INFORMATION:\n\nList of Abbreviations\n\n"
           "CFR--Code of Federal Regulations\nDHS--U.S. Department of Homeland Security\n"
           "TPS--Temporary Protected Status\n\nWhat is Temporary Protected Status?\n\n" + PROSE +
           "</pre></body></html>")


# ---------------------------------------------------------------------------
def group_config():
    print("\nA — selector config contract")
    whole, parts = fr._allowlist(CFG)
    check("A1 8 CFR is allowlisted whole", 8 in whole)
    check("A2 DOL 20 CFR 655 + 656 allowlisted", {(20, "655"), (20, "656")} <= parts)
    check("A3 State 22 CFR 40/41/42 allowlisted", {(22, "40"), (22, "41"), (22, "42")} <= parts)
    check("A4 notice agencies = USCIS/ICE/EOIR, CBP excluded",
          set(CFG["notice_agencies"]) == {"u-s-citizenship-and-immigration-services",
                                          "u-s-immigration-and-customs-enforcement",
                                          "executive-office-for-immigration-review"})
    check("A5 incremental + cost knobs present",
          CFG["lookback_days"] >= 7 and 0 < CFG["max_publish_per_run"] <= 50
          and CFG["excerpt_max_words"] < CFG["digest_max_words"] <= 3000)
    check("A6 api_base is federalregister.gov over https", CFG["api_base"].startswith("https://www.federalregister.gov/"))
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
        json.dump({"api_base": "x", "rule_selectors": [{"cfr_title": 8}]}, f)
    try:
        fr.load_config(f.name)
        check("A7 incomplete config raises (no permissive fallback)", False)
    except ValueError:
        check("A7 incomplete config raises (no permissive fallback)", True)
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
        bad = json.load(open(fr._CONFIG_PATH))
        bad["rule_selectors"] = [{"cfr_title": "8"}]
        json.dump(bad, f)
    try:
        fr.load_config(f.name)
        check("A8 non-int cfr_title rejected", False)
    except ValueError:
        check("A8 non-int cfr_title rejected", True)


def group_filter():
    print("\nB — immigration-only filter (L2-L4)")
    c = lambda d: fr.classify(d, CFG)  # noqa: E731
    check("B1 PRA '60-Day notice.' dropped",
          c(doc("n1", "Notice", "Application for Employment Authorization", "60-Day notice.", (USCIS,), ()))[1] == "filtered_pra")
    check("B2 PRA 'Currently Approved Collection' title dropped",
          c(doc("n2", "Notice", "Extension, Without Change, of a Currently Approved Collection: Biographic Information",
                "Notice.", (USCIS,), ()))[1] == "filtered_pra")
    check("B3 ICE form-titled 30-day PRA notice dropped via action",
          c(doc("n3", "Notice", "Departure Notification Record", "30-Day notice.",
                ({"slug": "u-s-immigration-and-customs-enforcement"},), ()))[1] == "filtered_pra")
    check("B4 TPS termination notice KEPT (no CFR, agency signal)",
          c(doc("n4", "Notice", "Termination of the Designation of Haiti for Temporary Protected Status",
                "Notice.", (DHS, USCIS), ()))[0])
    check("B5 seaplane-base designation (8 CFR) denied by title",
          c(doc("r1", title="Withdrawal of International Airport Designation of Chalk Seaplane Base",
                cfr=((8, "100"), (19, "122"))))[1] == "filtered_title_deny")
    check("B6 8 CFR 100 as the ONLY part => cfr deny",
          c(doc("r2", title="Designation of a new airport", cfr=((8, "100"),)))[1] == "filtered_cfr_deny")
    check("B7 8 CFR 100 + 214 => kept (deny only when sole part)",
          c(doc("r3", title="Changes to admission", cfr=((8, "100"), (8, "214"))))[0])
    check("B8 Medicaid-style rule (no immigration signal) => no_signal",
          c(doc("r4", title="Medicaid Program; Community Engagement", agencies=({"slug": "cms"},),
                cfr=((42, "435"),), abstract="States must verify engagement."))[1] == "filtered_no_signal")
    check("B9 DOL 20 CFR 655 wage rule kept",
          c(doc("r5", "Proposed Rule", "Improving Wage Protections for Certain Workers", "Proposed rule.",
                (DOL,), ((20, "655"),)))[0])
    check("B10 State 22 CFR 41 visa rule kept",
          c(doc("r6", title="Visas: Visa Bond Program", agencies=(STATE,), cfr=((22, "41"),)))[0])
    check("B11 keyword-only signal keeps an otherwise unlisted doc",
          c(doc("r7", title="Alien Registration Form", agencies=({"slug": "x"},), cfr=((28, "1"),)))[0])
    check("B12 'meeting' notice dropped",
          c(doc("n5", "Notice", "Advisory Committee; Meeting", "Notice of meeting.", (USCIS,), ()))[1] == "filtered_pra")
    check("B13 malformed cfr_references tolerated",
          fr.classify({**doc("r8"), "cfr_references": [{"title": None}, {"title": "x"}]}, CFG)[0])


def group_labels():
    print("\nC — status labels / final-rule detection")
    check("C1 proposed rule label says not in effect",
          fr.status_label(doc("p", "Proposed Rule", action="Notice of proposed rulemaking.")) == "Proposed rule (not in effect)")
    check("C2 interim final rule", fr.status_label(doc("i", action="Interim final rule.")) == "Interim final rule")
    check("C3 final rule", fr.status_label(doc("f", action="Final rule.")) == "Final rule")
    check("C4 ratification-type Rule => plain 'Rule'", fr.status_label(doc("r", action="Ratification.")) == "Rule")
    check("C5 C1- number => Correction", fr.status_label(doc("C1-2026-1", action="Final rule; correction.")) == "Correction")
    check("C6 correction_of set => Correction", fr.status_label(doc("x", correction_of="2026-1")) == "Correction")
    check("C7 notice", fr.status_label(doc("n", "Notice", action="Notice.")) == "Notice")
    check("C8 'Final rule; delay of effective date' is NOT a superseding final",
          not fr.is_final_rule(doc("d", action="Final rule; delay of effective date.")))
    check("C9 comment-period extension is NOT final",
          not fr.is_final_rule(doc("e", action="Interim final rule; extension of comment period.")))
    check("C10 real final rule is final", fr.is_final_rule(doc("f", action="Final rule.")))
    check("C11 superseded headline", fr.headline(doc("p", "Proposed Rule", "Fee"), superseded=True)
          == "Proposed rule (superseded by final rule): Fee")


def group_excerpt():
    print("\nD — excerpt from GPO raw text")
    ex = fr.excerpt(GPO_RULE, 200)
    check("D1 skips ToC, starts at the real Executive Summary's first prose",
          ex.startswith("Executive Summary: The purpose of this rulemaking"), ex[:60])
    check("D2 excerpt contains the operational prose", "weighted by wage level" in ex)
    check("D3 footnote markers stripped", "\\1\\" not in ex)
    paged = GPO_RULE.replace("registrations are weighted", "registrations [[Page 101209]] are weighted")
    check("D3b GPO page markers stripped", "[[Page" not in fr.excerpt(paged, 200))
    mini_toc = GPO_RULE.replace("II. Executive Summary\n\nA. Purpose of the Regulatory Action\n\n",
                                "II. Executive Summary\n\nA. Purpose\nB. Summary of the Major Provisions\n1. Amend 8 CFR 208.3\n\n")
    check("D3c Executive Summary with its own mini-ToC => still starts at prose",
          fr.excerpt(mini_toc, 50).startswith("Executive Summary: The purpose"))
    check("D4 skips abbreviation list (TPS notice)", fr.excerpt(GPO_TPS, 200).startswith("The Secretary of Homeland"))
    check("D5 word cap + ellipsis", len(fr.excerpt(GPO_RULE, 10).split()) == 11 and fr.excerpt(GPO_RULE, 10).endswith("…"))
    check("D6 max_words 0 => empty", fr.excerpt(GPO_RULE, 0) == "")
    plain = "Header\n\nIn rule document 2026-1 beginning on page 47101 make the following correction. On page 5 fix the date.\n"
    check("D7 non-GPO layout falls back to first sentence-y paragraph",
          fr.excerpt(plain, 50, min_para_words=10).startswith("In rule document"))
    check("D8 nothing usable => empty", fr.excerpt("<pre>tiny</pre>", 50) == "")


def group_digest():
    print("\nE — digest shape")
    d = doc("2026-2", "Proposed Rule", "Fee for Certain H-1B Petitions", "Proposed rule.", comments_close_on="2026-10-10",
            rins=("1615-AC99",))
    body, tag = fr.build_digest(d, GPO_RULE, CFG)
    lines = body.splitlines()
    check("E1 STATUS is the first line", lines[0].startswith("STATUS: PROPOSED RULE — NOT IN EFFECT"))
    check("E2 operational header: published/effective/comments/CFR/RIN/official text",
          all(s in body for s in ("Published: 2026-09-01", "Effective: n/a (proposal)", "Comments close: 2026-10-10",
                                  "CFR affected: 8 CFR 214", "1615-AC99", "Official text: https://www.federalregister.gov/d/2026-2")))
    check("E3 SUMMARY precedes KEY EXCERPT", body.index("SUMMARY:") < body.index("KEY EXCERPT"))
    check("E4 tag_text excludes the long excerpt", "KEY EXCERPT" not in tag and "SUMMARY:" in tag)
    check("E5 not-legal-advice + public-domain attribution footer",
          "Not legal advice" in body and "public domain" in body)
    final = doc("2026-9", title="Fee for Certain H-1B Petitions", pub="2026-12-01", effective_on="2027-01-01")
    sbody, _ = fr.build_digest(d, GPO_RULE, CFG, superseded_by=final)
    check("E6 superseded proposal names the final rule + its effective date",
          "SUPERSEDED" in sbody and "2026-12-01" in sbody and "2027-01-01" in sbody and final["html_url"] in sbody)
    huge = "<pre>SUPPLEMENTARY INFORMATION:\n\n" + ("    Word " + "lorem ipsum dolor sit amet consectetur. " * 12 + "\n") * 800 + "</pre>"
    hbody, _ = fr.build_digest(doc("2026-3"), huge, CFG)
    check("E7 digest word cap enforced on a huge rule", len(hbody.split()) <= CFG["digest_max_words"] + 5,
          str(len(hbody.split())))
    nb, _ = fr.build_digest(doc("2026-4", "Notice", action="Notice.", cfr=(), abstract=""), GPO_TPS, CFG)
    check("E8 no-abstract notice still gets excerpt; no Effective line for notices",
          "KEY EXCERPT" in nb and "Effective:" not in nb and "CFR affected: none" in nb)


# ---------------------------------------------------------------------------
class Stub:
    """Stubs fr._get_json / fr._get_text; records calls."""
    def __init__(self, selector_docs, rin_docs=None, raw=None, fail_json=False, fail_text=()):
        self.selector_docs, self.rin_docs = selector_docs, rin_docs or {}
        self.raw, self.fail_json, self.fail_text = raw or {}, fail_json, set(fail_text)
        self.json_calls, self.text_calls = [], []

    def get_json(self, url, params):
        self.json_calls.append(params)
        if self.fail_json:
            raise ConnectionError("federalregister.gov down")
        if "conditions[regulation_id_number]" in params:
            return {"results": self.rin_docs.get(params["conditions[regulation_id_number]"], [])}
        types = params.get("conditions[type][]")
        if types == ["NOTICE"]:
            res = [d for d in self.selector_docs if d["type"] == "Notice"]
        else:
            t, p = params.get("conditions[cfr][title]"), params.get("conditions[cfr][part]")
            res = [d for d in self.selector_docs if d["type"] != "Notice"
                   and any(r["title"] == t and (p is None or r["part"] == p) for r in d["cfr_references"])]
        return {"results": res}

    def get_text(self, url):
        self.text_calls.append(url)
        if any(url.endswith(f"/{dn}.txt") for dn in self.fail_text):
            raise TimeoutError("slow")
        return self.raw.get(url, GPO_RULE)

    def __enter__(self):
        self._o = (fr._get_json, fr._get_text)
        fr._get_json, fr._get_text = self.get_json, self.get_text
        return self

    def __exit__(self, *a):
        fr._get_json, fr._get_text = self._o


class Recorder:
    def __init__(self, fail=()):
        self.calls, self.fail = [], set(fail)

    def __call__(self, **kw):
        if kw["source_item_id"] in self.fail:
            raise RuntimeError("datastore import failed")
        self.calls.append(kw)
        return {"case_id": f"gov_news-federal-register-{kw['source_item_id']}"}


SRC = dict(fr.DEFAULT_SOURCE)


def run(stub, known=None, **kw):
    rec = kw.pop("publish", None) or Recorder()
    with stub:
        r = fr.poll_source("federal-register", SRC, known=known if known is not None else {},
                           publish=rec, today=date(2026, 9, 27), **kw)
    return r, rec


def group_poll():
    print("\nF — poll: incremental, cap, dry-run, failures, supersession")
    tps = doc("2026-100", "Notice", "Extension of the Designation of Lebanon for Temporary Protected Status",
              "Notice.", (DHS, USCIS), (), pub="2026-09-10")
    h1b = doc("2026-101", "Proposed Rule", "Fee for Certain H-1B Petitions", "Proposed rule.", pub="2026-09-12")
    pra = doc("2026-102", "Notice", "Biographic Information", "60-Day notice.", (USCIS,), (), pub="2026-09-13")
    base = [tps, h1b, pra]

    r, rec = run(Stub(base))
    check("F1 new docs published exactly once each", r["new"] == 2 and len(rec.calls) == 2, str(r["new"]))
    kw = next(c for c in rec.calls if c["source_item_id"] == "2026-101")
    check("F2 publish kwargs: id=document_number, api method, tag_text, FR url, pub date, gov_news channel",
          kw["ingestion_method"] == "api" and kw["tag_text"] and kw["full_url"].endswith("/2026-101")
          and kw["posting_date"] == "2026-09-12" and kw["channel"] == "gov_news" and kw["is_edit"] is False
          and kw["title"].startswith("Proposed rule (not in effect): "))
    check("F3 filtered counters reported", r["filtered_pra"] == 1 and r["filtered"][0]["guid"] == "2026-102")
    check("F4 default window = today - lookback_days", r["since"] == "2026-09-06", r["since"])

    stub = Stub(base)
    r, rec = run(stub, known={"2026-100": "h", "2026-101": "h"})
    check("F5 rerun with all known => zero publishes", r["new"] == 0 and r["unchanged"] == 2 and not rec.calls)
    check("F6 known ids => ZERO full-text fetches (skip before fetch/tag/write)", stub.text_calls == [], str(stub.text_calls))

    r, rec = run(Stub(base), max_publish=1)
    check("F7 per-run cap: 1 published, 1 deferred (retried next run)", r["new"] == 1 and r["deferred"] == 1)
    check("F8 oldest first under the cap", rec.calls[0]["source_item_id"] == "2026-100")

    r, rec = run(Stub(base), dry_run=True, publish=Recorder())
    check("F9 dry-run never publishes, returns digests", not rec.calls and all(p.get("digest") for p in r["published"]))

    r, _ = run(Stub(base, fail_json=True))
    check("F10 API outage => source skipped, no crash", r.get("skipped") and "API error" in r["reason"])

    r, rec = run(Stub(base), publish=Recorder(fail={"2026-100"}))
    check("F11 one publish failure isolated; others continue", r["failed"] == 1 and r["new"] == 1
          and r["failures"][0]["guid"] == "2026-100")

    r, rec = run(Stub(base, fail_text={"2026-101"}))
    check("F12 full-text fetch failure => still published from abstract", r["new"] == 2 and r["failed"] == 0)
    noabs = doc("2026-103", "Notice", "TPS notice", "Notice.", (USCIS,), (), abstract="", pub="2026-09-14")
    r, rec = run(Stub([noabs], fail_text={"2026-103"}))
    check("F13 no abstract AND no full text => failed (nothing groundable)", r["failed"] == 1 and not rec.calls)

    r, rec = run(Stub(base), known={"2026-100": "h"}, force=True)
    check("F14 force ignores known set", r["new"] + r["edited"] == 2)

    # Supersession: a new final rule re-labels its already-ingested proposal (once).
    prop = doc("2025-500", "Proposed Rule", "Public Charge", "Notice of proposed rulemaking.",
               pub="2025-11-19", rins=("1615-AD06",))
    final = doc("2026-600", "Rule", "Public Charge", "Final rule.", pub="2026-07-20", rins=("1615-AD06",),
                effective_on="2026-09-18")
    ext = doc("2026-601", "Rule", "Public Charge; extension", "Final rule; extension of comment period.",
              pub="2026-08-01", rins=("1615-AD06",))
    rins = {"1615-AD06": [prop, final, ext]}
    r, rec = run(Stub([final], rin_docs=rins), known={"2025-500": "h"})
    edit = [c for c in rec.calls if c["source_item_id"] == "2025-500"]
    check("F15 new final rule => known proposal republished as is_edit (SUPERSEDED)",
          len(edit) == 1 and edit[0]["is_edit"] is True and "SUPERSEDED" in edit[0]["description"]
          and edit[0]["title"].startswith("Proposed rule (superseded by final rule)")
          and edit[0]["posting_date"] == "2025-11-19")
    r, rec = run(Stub([final], rin_docs=rins), known={})
    check("F16 proposal never ingested => no supersede edit", [c["source_item_id"] for c in rec.calls] == ["2026-600"])
    r, rec = run(Stub([prop], rin_docs=rins), known={})
    check("F17 backfill: proposal built AFTER its final exists is labelled superseded at build time",
          "SUPERSEDED" in rec.calls[0]["description"] and "2026-600" in rec.calls[0]["description"])
    r, rec = run(Stub([ext], rin_docs=rins), known={"2025-500": "h"})
    check("F18 comment-extension Rule sharing the RIN does NOT supersede",
          [c["source_item_id"] for c in rec.calls] == ["2026-601"])

    orig = fr._CONFIG_PATH
    try:
        fr.load_config.__defaults__ = ("/nonexistent/fr.json",)
        r, _ = run(Stub(base))
        check("F19 missing config => skipped (never an unfiltered run)", r.get("skipped") and "config error" in r["reason"])
    finally:
        fr.load_config.__defaults__ = (orig,)


def group_wiring():
    print("\nG — pipeline wiring")
    import gov_news_poll
    seen = {}

    def fake(slug, source, **kw):
        seen.update(slug=slug, **kw)
        return {"source": slug, "ok": True}
    orig = fr.poll_source
    fr.poll_source = fake
    try:
        res = gov_news_poll.poll_source("federal-register", SRC, dry_run=True, since="2024-09-27", max_publish=9)
        check("G1 federalregister_api dispatches to the FR adapter with since/max_publish",
              res.get("ok") and seen == {"slug": "federal-register", "dry_run": True, "force": False,
                                          "since": "2024-09-27", "max_publish": 9}, str(seen))
    finally:
        fr.poll_source = orig
    res = gov_news_poll.poll_source("x", {**SRC, "fetch_method": "scrape"})
    check("G2 other non-RSS methods still skipped (unchanged)", res.get("skipped") is True)

    import posting
    captured = {}
    saved = {n: getattr(posting, n) for n in ("_extract", "validate", "_write_gcs", "_import_to_datastore", "_write_bigquery")}
    posting._extract = lambda title, text: captured.setdefault("tagged", text) and {}
    posting.validate = lambda c: []
    posting._write_gcs = lambda c, md: (captured.update(md=md, canonical=c) or ("gs://b/x.md", "gs://b/x.json"))
    posting._import_to_datastore = lambda c, uri: None
    posting._write_bigquery = lambda c, **kw: None
    try:
        posting.publish_gov_news_item(title="Final rule: X", description="LONG BODY with excerpt",
                                      source_system="federal-register", author_handle="Federal Register",
                                      source_item_id="2026-1", full_url="https://www.federalregister.gov/d/2026-1",
                                      posting_date="2026-09-01", tag_text="SHORT header+summary",
                                      ingestion_method="api")
        check("G3 tag_text is what gets tagged; description is what gets stored",
              captured["tagged"] == "SHORT header+summary" and "LONG BODY with excerpt" in captured["md"])
        check("G4 ingestion_method=api + doc_kind=gov_news on the canonical",
              captured["canonical"]["ingestion_method"] == "api" and captured["canonical"]["doc_kind"] == "gov_news")
        captured.clear()
        posting.publish_gov_news_item(title="T", description="RSS desc", source_system="uscis", author_handle="USCIS",
                                      source_item_id="g", full_url="u", posting_date="2026-09-01")
        check("G5 RSS callers unchanged: tags from description, ingestion_method rss_feed",
              captured["tagged"] == "RSS desc" and captured["canonical"]["ingestion_method"] == "rss_feed")
    finally:
        for n, f in saved.items():
            setattr(posting, n, f)
    src = (_BACKEND.parent / "scripts" / "curation" / "manage_news_sources.py").read_text()
    check("G6 registry CLI knows federalregister_api has an adapter",
          '_FETCH_METHODS = {"rss", "federalregister_api"}' in src)


def group_e2e():
    print("\nH — deterministic e2e: TPS question -> gov-tier answer citing federalregister.gov")
    import assist
    import search_client
    url = "https://www.federalregister.gov/documents/2026/05/29/2026-10704/extension-of-lebanon-designation"
    chunk = {"chunk_id": "gov_news-federal-register-2026-05-29-abcd1234",
             "text": "STATUS: NOTICE ... The designation of Lebanon for TPS is extended through November 27, 2027.",
             "source": url, "labels": [], "score": 0.8, "as_of": "2026-05-29", "channel": "gov_news"}
    calls = []

    def fake(question, project_id, location, engine_id, max_results=5, filter_expr="", preamble=""):
        calls.append(filter_expr)
        if filter_expr == assist._GOV_FILTER:
            return {"answer": "Lebanon's TPS designation was extended through November 27, 2027.",
                    "chunks": [chunk], "is_fallback": False}
        return {"answer": search_client.FALLBACK_MESSAGE, "chunks": [], "is_fallback": True}
    orig = search_client.answer_query
    search_client.answer_query = fake
    try:
        res = assist.answer_cascade("Was TPS for Lebanon extended?", project_id="p", location="global", engine_id="e")
        check("H1 gov tier answers (gov_news doc_kind is inside the gov filter)",
              res["source_tier"] == "gov" and "gov_news" in assist._GOV_FILTER, res["source_tier"])
        check("H2 citation is the official federalregister.gov document",
              any(c.get("source") == url for c in res.get("citations", [])), str(res.get("citations")))
    finally:
        search_client.answer_query = orig


# ---------------------------------------------------------------------------
# Coverage-gap groups (added after `coverage run --branch`, 2026-09-27)
# ---------------------------------------------------------------------------

class _Resp:
    def __init__(self, payload=None, text="", status=200):
        self._p, self.text, self.status = payload, text, status

    def raise_for_status(self):
        if self.status >= 400:
            raise fr.requests.HTTPError(f"{self.status}")

    def json(self):
        return self._p


def group_http():
    print("\nI — HTTP helpers + pagination + selector params (real code paths, requests stubbed)")
    seen = []
    orig = fr.requests.get

    def fake_get(url, params=None, headers=None, timeout=None):
        seen.append({"url": url, "params": params, "headers": headers, "timeout": timeout})
        if url.endswith(".txt"):
            return _Resp(text="<pre>raw</pre>", status=404 if "missing" in url else 200)
        return _Resp({"results": [{"document_number": "x"}]}, status=500 if "boom" in url else 200)
    fr.requests.get = fake_get
    try:
        check("I1 _get_json returns parsed JSON", fr._get_json("https://api/documents.json", {"a": 1})["results"][0]
              ["document_number"] == "x")
        check("I2 polite UA + timeout on every request",
              seen[-1]["headers"]["User-Agent"].startswith("meridianjourney-grounding-bot") and seen[-1]["timeout"] == 60)
        check("I3 _get_text returns body", fr._get_text("https://fr/raw/a.txt") == "<pre>raw</pre>")
        for label, call in (("I4 HTTP error raises (json)", lambda: fr._get_json("https://boom", {})),
                            ("I5 HTTP error raises (text)", lambda: fr._get_text("https://fr/missing.txt"))):
            try:
                call()
                check(label, False)
            except fr.requests.HTTPError:
                check(label, True)
    finally:
        fr.requests.get = orig

    calls = []

    def paged_json(url, params):
        calls.append(params)
        page = params["page"]
        return {"results": [{"document_number": f"d{page}"}], "next_page_url": f"p{page + 1}" if page < 3 else None}
    o = fr._get_json
    fr._get_json = paged_json
    try:
        out = fr._paged(CFG, {"x": 1})
        check("I6 pagination follows next_page_url to the end", [d["document_number"] for d in out] == ["d1", "d2", "d3"])
        p = calls[0]
        check("I7 page params: per_page=1000, order=oldest, all fields requested",
              p.get("per_page") == 1000 and p.get("order") == "oldest" and set(fr._FIELDS) <= set(p["fields[]"])
              and {"abstract", "raw_text_url", "regulation_id_numbers", "correction_of"} <= set(p["fields[]"]))
        calls.clear()
        fr._get_json = lambda url, params: (calls.append(1) or {"results": [], "next_page_url": "again"})
        fr._paged(CFG, {})
        check("I8 hard stop at 20 pages on a runaway next_page_url", len(calls) == 20, str(len(calls)))
    finally:
        fr._get_json = o

    stub = Stub([doc("2026-7", cfr=((8, "214"), (20, "655")))])  # hit by TWO selectors
    with stub:
        got = fr.fetch_candidates(CFG, "2026-09-01")
    rule_calls = [c for c in stub.json_calls if c.get("conditions[type][]") == ["RULE", "PRORULE"]]
    notice_calls = [c for c in stub.json_calls if c.get("conditions[type][]") == ["NOTICE"]]
    check("I9 one API query per rule selector + one notice query",
          len(rule_calls) == len(CFG["rule_selectors"]) and len(notice_calls) == 1)
    check("I10 whole-title selector sends no cfr part; part selectors do",
          any(c["conditions[cfr][title]"] == 8 and "conditions[cfr][part]" not in c for c in rule_calls)
          and any(c.get("conditions[cfr][part]") == "656" for c in rule_calls))
    check("I11 every query is date-bounded by `since`",
          all(c["conditions[publication_date][gte]"] == "2026-09-01" for c in stub.json_calls))
    check("I12 notice query targets exactly the configured agencies",
          notice_calls[0]["conditions[agencies][]"] == CFG["notice_agencies"])
    check("I13 doc matched by two selectors is a single candidate", list(got) == ["2026-7"])


def group_filter_regressions():
    print("\nJ — filter regressions: real titles from the 24-month dry run (golden set) + L2 scope")
    kept = [  # (type, action, title, agencies, cfr)
        ("Notice", "Notice.", "Termination of the Designation of Haiti for Temporary Protected Status", (DHS, USCIS), ()),
        ("Notice", "Notice of extension of Temporary Protected Status designation.",
         "Extension of Lebanon Designation for Temporary Protected Status", (DHS, USCIS), ()),
        ("Notice", "Notice.", "Employment Authorization for Lebanese F-1 Nonimmigrant Students Experiencing Severe Economic Hardship",
         (DHS, USCIS), ()),
        ("Notice", "Notice.", "Notice of Implementation of 2025 Naturalization Civics Test", (DHS, USCIS), ()),
        ("Notice", "Notice of inflationary fee adjustment.", "Inflation Adjustment to HR-1 Immigration Fees", (DHS, USCIS), ()),
        ("Notice", "Notice.", "Termination of Family Reunification Parole Processes for Colombians, Cubans, Ecuadorians",
         (DHS, USCIS), ()),
        ("Rule", "Final rule.", "Weighted Selection Process for Registrants and Petitioners Seeking To File Cap-Subject H-1B Petitions",
         (DHS,), ((8, "214"),)),
        ("Proposed Rule", "Proposed rule.", "Fee for Certain H-1B Petitions", (DHS,), ((8, "103"), (8, "214"))),
        ("Rule", "Interim final rule.", "Removal of the Automatic Extension of Employment Authorization Documents",
         (DHS,), ((8, "274a"),)),
        ("Rule", "Final rule.", "Public Charge Ground of Inadmissibility", (DHS,), ((8, "103"), (8, "212"))),
        ("Rule", "Final rule.", "Visas: Visa Bond Program", (STATE,), ((22, "41"),)),
        ("Rule", "Interim final rule.", "Adverse Effect Wage Rate Methodology for the Temporary Employment of H-2A Nonimmigrants",
         (DOL,), ((20, "655"),)),
        ("Rule", "Final rule.", "Inflation Adjustment for EOIR OBBBA Fees; Fiscal Year 2027",
         ({"slug": "executive-office-for-immigration-review"},), ((8, "1003"),)),
    ]
    dropped = [  # (type, action, title, agencies, cfr, expected_reason)
        ("Notice", "60-day notice.", "Extension, Without Change, of a Currently Approved Collection: Biographic Information",
         (USCIS,), (), "filtered_pra"),
        ("Notice", "30-Day notice.", "Flight Manifest/Billing Agreement",
         ({"slug": "u-s-immigration-and-customs-enforcement"},), (), "filtered_pra"),
        ("Notice", "Notice of a modified system of records.", "Privacy Act of 1974; System of Records", (DHS,), (), "filtered_pra"),
        ("Rule", "Final rule.", "Automation of CBP Form I-418 for Vessels", (DHS, CBP), ((8, "251"), (19, "4")), "filtered_title_deny"),
        ("Rule", "Final rule.", "Establishing the Gordie Howe International Bridge as a Port of Entry in Detroit, MI",
         (DHS, CBP), ((8, "100"), (19, "101")), "filtered_title_deny"),
        ("Rule", "Final rule.", "Regulatory Changes Required by the Energy Security and Lightering Independence Act of 2022",
         (DHS,), ((8, "258"),), "filtered_title_deny"),
    ]
    bad_keep = [t for ty, a, t, ag, c in kept if not fr.classify(doc("k", ty, t, a, ag, c), CFG)[0]]
    check("J1 golden set: every real immigration doc is KEPT", not bad_keep, str(bad_keep))
    bad_drop = [(t, fr.classify(doc("d", ty, t, a, ag, c), CFG)[1]) for ty, a, t, ag, c, want in dropped
                if fr.classify(doc("d", ty, t, a, ag, c), CFG)[1] != want]
    check("J2 golden set: every real noise doc DROPPED for the expected reason", not bad_drop, str(bad_drop))
    check("J3 L2 never drops a RULE whose title says 'Meeting'",
          fr.classify(doc("r", "Rule", "Meeting the Requirements for H-1B Specialty Occupations", "Final rule."), CFG)[0])
    check("J4 L2 never drops a PROPOSED RULE titled 'Collection of Information' (e.g. biometrics)",
          fr.classify(doc("p", "Proposed Rule", "Collection of Information and Biometrics From Aliens",
                          "Proposed rule."), CFG)[0])
    check("J5 L2 still drops a PRA *notice* with the same words",
          fr.classify(doc("n", "Notice", "Collection of Information: Form I-765", "60-Day notice.", (USCIS,), ()), CFG)[1]
          == "filtered_pra")
    check("J6 doc with no agencies / no title / no abstract doesn't crash",
          fr.classify({"document_number": "z", "type": "Rule"}, CFG) == (False, "filtered_no_signal"))


def group_digest_edges():
    print("\nK — digest / label edges")
    d = doc("2026-5", "Notice", "TPS", "Notice.", (USCIS,), (), docket_ids=[], pdf_url=None, dates=None)
    body, tag = fr.build_digest(d, "", CFG)
    check("K1 no RIN/docket => no 'RIN / Docket' line", "RIN / Docket" not in body)
    check("K2 no PDF => official link without PDF suffix", "(PDF:" not in body and "Official text: https://" in body)
    check("K3 no dates => no DATES section", "DATES:" not in body)
    check("K4 empty raw text => no KEY EXCERPT, footer still present", "KEY EXCERPT" not in body and "Not legal advice" in body)
    big = doc("2026-6", abstract="word " * 3000)
    bbody, _ = fr.build_digest(big, GPO_RULE, CFG)
    check("K5 abstract alone exceeds budget => excerpt dropped, no crash", "KEY EXCERPT" not in bbody)
    check("K6 headline falls back to document_number", fr.headline({"document_number": "2026-9", "type": "Notice"})
          == "Notice: 2026-9")
    check("K7 unknown type label passes through; empty type => 'Document'",
          fr.status_label({"type": "Presidential Document", "document_number": "p"}) == "Presidential Document"
          and fr.status_label({"document_number": "p"}) == "Document")
    ex = fr.excerpt("<pre>SUPPLEMENTARY INFORMATION:\n\nI. Executive Summary\n\nII. Executive Summary\n\n"
                    "Heading only\n\n" + PROSE + "</pre>", 30)
    check("K8 Executive Summary heading(s) with prose only much later still yields prose",
          ex.startswith("Executive Summary: The Secretary"), ex[:50])
    only_toc = "<pre>SUPPLEMENTARY INFORMATION:\n\nII. Executive Summary\n    A. Purpose\n</pre>"
    check("K9 heading with NO prose after it anywhere => empty (no ToC dumped)", fr.excerpt(only_toc, 30) == "")
    check("K10 HTML entities decoded", "&amp;" not in fr.excerpt(
        "<pre>SUPPLEMENTARY INFORMATION:\n\n    DHS &amp; DOL jointly issue this rule to update the H-2B cap for the "
        "second half of the fiscal year today.\n</pre>", 30))


def group_poll_edges():
    print("\nL — poll edges: defaults, cache, supersede failure, ordering, idempotent ids")
    import gov_news_poll
    import posting
    base = [doc("2026-100", "Notice", "TPS for X", "Notice.", (USCIS,), (), pub="2026-09-10")]

    bq_calls = []
    orig_eh = gov_news_poll._existing_hashes
    gov_news_poll._existing_hashes = lambda slug: (bq_calls.append(slug) or {"2026-100": "h"})
    try:
        with Stub(base):
            r = fr.poll_source("federal-register", SRC, dry_run=True, today=date(2026, 9, 27))
        check("L1 default known-set = BigQuery lookup keyed by source slug",
              bq_calls == ["federal-register"] and r["unchanged"] == 1)
        bq_calls.clear()
        with Stub(base):
            r = fr.poll_source("federal-register", SRC, dry_run=True, force=True, today=date(2026, 9, 27))
        check("L2 force => BigQuery NOT consulted, doc reprocessed", bq_calls == [] and r["new"] == 1)
    finally:
        gov_news_poll._existing_hashes = orig_eh

    rec = Recorder()
    orig_pub = posting.publish_gov_news_item
    posting.publish_gov_news_item = rec
    try:
        with Stub(base):
            fr.poll_source("federal-register", SRC, known={}, today=date(2026, 9, 27))
        check("L3 default publisher = posting.publish_gov_news_item", len(rec.calls) == 1)
    finally:
        posting.publish_gov_news_item = orig_pub

    prop_a = doc("2025-1", "Proposed Rule", "A", "Proposed rule.", pub="2025-01-01", rins=("R1",))
    prop_b = doc("2025-2", "Proposed Rule", "B", "Proposed rule.", pub="2025-02-01", rins=("R1",))
    stub = Stub([prop_a, prop_b], rin_docs={"R1": [prop_a, prop_b]})
    run(stub)
    rin_calls = [c for c in stub.json_calls if "conditions[regulation_id_number]" in c]
    check("L4 RIN family fetched once per run (cache), not once per doc", len(rin_calls) == 1, str(len(rin_calls)))

    early_final = doc("2024-9", "Rule", "A", "Final rule.", pub="2024-06-01", rins=("R2",))
    late1 = doc("2026-8", "Rule", "A", "Final rule.", pub="2026-08-01", rins=("R2",))
    late0 = doc("2026-3", "Rule", "A", "Final rule.", pub="2026-03-01", rins=("R2",))
    p = doc("2025-5", "Proposed Rule", "A", "Proposed rule.", pub="2025-05-01", rins=("R2",))
    fam = {"R2": [early_final, late1, late0, p]}
    with Stub([], rin_docs=fam):
        s = fr.find_superseding_final(p, CFG, {})
    check("L5 earliest LATER final rule chosen; earlier final ignored", s and s["document_number"] == "2026-3")
    with Stub([], rin_docs=fam):
        check("L6 proposal without RIN => never superseded",
              fr.find_superseding_final(doc("x", "Proposed Rule", rins=()), CFG, {}) is None)
        check("L7 a correction to a proposal is not itself superseded",
              fr.find_superseding_final(doc("C1-2025-5", "Proposed Rule", rins=("R2",)), CFG, {}) is None)
        check("L8 non-final Rule triggers no supersession sweep",
              fr.proposals_superseded_by(doc("y", "Rule", action="Final rule; delay of effective date.", rins=("R2",)),
                                         CFG, {}) == [])

    prop = doc("2025-500", "Proposed Rule", "PC", "Proposed rule.", pub="2025-11-19", rins=("R3",))
    final = doc("2026-600", "Rule", "PC", "Final rule.", pub="2026-07-20", rins=("R3",))
    r, rec = run(Stub([final], rin_docs={"R3": [prop, final]}, fail_text={"2025-500"}), known={"2025-500": "h"})
    check("L9 supersede failure is isolated: final still published, failure recorded",
          [c["source_item_id"] for c in rec.calls] == ["2026-600"] and r["failed"] == 1
          and r["failures"][0]["error"].startswith("supersede:"))

    r, rec = run(Stub([final, prop], rin_docs={"R3": [prop, final]}), known={})
    ids = [c["source_item_id"] for c in rec.calls]
    check("L10 same-run proposal + final: proposal built once (labelled at build time), no extra edit",
          ids == ["2025-500", "2026-600"] and all(not c["is_edit"] for c in rec.calls)
          and "SUPERSEDED" in rec.calls[0]["description"])

    same_day = [doc("2026-20", "Notice", "TPS B", "Notice.", (USCIS,), (), pub="2026-09-10"),
                doc("2026-10", "Notice", "TPS A", "Notice.", (USCIS,), (), pub="2026-09-10")]
    r, rec = run(Stub(same_day))
    check("L11 deterministic order: date, then document_number",
          [c["source_item_id"] for c in rec.calls] == ["2026-10", "2026-20"])

    r, rec = run(Stub([final, doc("2026-700", "Notice", "TPS", "Notice.", (USCIS,), (), pub="2026-09-01")],
                      rin_docs={"R3": [prop, final]}), known={"2025-500": "h"}, max_publish=1)
    check("L12 supersede edits count toward the cap (next doc deferred)",
          r["new"] == 1 and r["edited"] == 1 and r["deferred"] == 1)

    captured = []
    saved = {n: getattr(posting, n) for n in ("_extract", "validate", "_write_gcs", "_import_to_datastore", "_write_bigquery")}
    posting._extract = lambda title, text: {}
    posting.validate = lambda c: []
    posting._write_gcs = lambda c, md: ("gs://b/x.md", "gs://b/x.json")
    posting._import_to_datastore = lambda c, uri: None
    posting._write_bigquery = lambda c, **kw: captured.append((c["case_id"], kw.get("delete_existing")))
    try:
        r, _ = run(Stub([final], rin_docs={"R3": [prop, final]}), known={}, publish=posting.publish_gov_news_item)
        r, _ = run(Stub([final], rin_docs={"R3": [prop, final]}), known={}, publish=posting.publish_gov_news_item)
        check("L13 same document => same case_id on retry (idempotent, no duplicate doc)",
              captured[0][0] == captured[1][0] and captured[0][0].startswith("gov_news-federal-register-2026-07-20-"))
        captured.clear()
        run(Stub([prop], rin_docs={"R3": [prop]}), known={}, publish=posting.publish_gov_news_item)
        run(Stub([final], rin_docs={"R3": [prop, final]}), known={"2025-500": "h"}, publish=posting.publish_gov_news_item)
        prop_ids = [cid for cid, _ in captured if "2025-11-19" in cid]
        check("L14 superseded re-publish reuses the proposal's case_id and deletes-before-insert in BigQuery",
              len(prop_ids) == 2 and prop_ids[0] == prop_ids[1]
              and [de for cid, de in captured if "2025-11-19" in cid] == [False, True])
    finally:
        for n, f in saved.items():
            setattr(posting, n, f)


def group_cli():
    print("\nM — CLIs: adapter dry-run entry point + poll_gov_news summary/args + poll_all pass-through")
    import contextlib
    import io
    import types
    import gov_news_poll

    base = [doc("2026-100", "Notice", "TPS for X", "Notice.", (USCIS,), (), pub="2026-09-10"),
            doc("2026-102", "Notice", "Biographic Information", "60-Day notice.", (USCIS,), (), pub="2026-09-13")]
    old_argv = sys.argv
    try:
        sys.argv = ["federal_register_poll.py", "--since", "2026-09-01", "--no-bq", "--show", "1"]
        out = io.StringIO()
        noabs = doc("2026-104", "Notice", "TPS for Y", "Notice.", (USCIS,), (), abstract="", pub="2026-09-11")
        with Stub(base + [noabs], fail_text={"2026-104"}), contextlib.redirect_stdout(out):
            rc = fr._main()
        txt = out.getvalue()
        check("M1 dry-run CLI: rc 0, counts, kept/filtered lists, sample digest",
              rc == 0 and "new=1" in txt and "filtered_pra=1" in txt and "2026-102" in txt
              and "SAMPLE DIGEST 2026-100" in txt and "STATUS: NOTICE" in txt)
        check("M1b dry-run CLI lists per-doc failures", "FAILED 2026-104" in txt)
        sys.argv = ["federal_register_poll.py", "--no-bq"]
        with Stub(base, fail_json=True), contextlib.redirect_stdout(io.StringIO()) as o2:
            rc = fr._main()
        check("M2 dry-run CLI: API down => rc 1 with reason", rc == 1 and "skipped:" in o2.getvalue())
        check("M3 dry-run CLI never publishes (no publisher resolved in dry-run)",
              "case_id" not in txt)
    finally:
        sys.argv = old_argv

    seen = {}
    orig_ges, orig_ps = gov_news_poll.get_enabled_sources, gov_news_poll.poll_source
    gov_news_poll.get_enabled_sources = lambda: {"uscis": {"fetch_method": "rss"}, "federal-register": SRC}
    gov_news_poll.poll_source = lambda slug, cfg, **kw: (seen.setdefault(slug, kw) and None) or {"source": slug, **kw}
    try:
        res = gov_news_poll.poll_all(since="2024-09-27", max_publish=200)
        check("M4 poll_all forwards since/max_publish to every source",
              seen["federal-register"] == {"dry_run": False, "force": False, "since": "2024-09-27", "max_publish": 200}
              and len(res) == 2)
        res = gov_news_poll.poll_all(source_slug="nope")
        check("M5 poll_all: unknown/disabled slug reported, not crashed", res[0].get("skipped") is True)
        seen.clear()
        gov_news_poll.poll_all(source_slug="federal-register")
        check("M6 poll_all: --source limits the run to one slug; defaults unchanged for the scheduler",
              list(seen) == ["federal-register"] and seen["federal-register"]["since"] == ""
              and seen["federal-register"]["max_publish"] is None)
    finally:
        gov_news_poll.get_enabled_sources, gov_news_poll.poll_source = orig_ges, orig_ps

    # scripts/curation/poll_gov_news.py — import with a no-op dotenv so CI never reads a .env
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "poll_gov_news_cli", _BACKEND.parent / "scripts" / "curation" / "poll_gov_news.py")
    cli = importlib.util.module_from_spec(spec)
    real_dotenv = sys.modules.get("dotenv")
    sys.modules["dotenv"] = types.SimpleNamespace(load_dotenv=lambda *a, **k: None)
    try:
        spec.loader.exec_module(cli)
    finally:
        if real_dotenv is not None:
            sys.modules["dotenv"] = real_dotenv
        else:
            sys.modules.pop("dotenv", None)
    got = {}
    cli.poll_all = lambda **kw: (got.update(kw) or [
        {"source": "federal-register", "display_name": "Federal Register", "items_in_feed": 3, "already_known": 1,
         "new": 1, "edited": 0, "unchanged": 1, "failed": 0, "deferred": 2, "filtered_pra": 1,
         "filtered_title_deny": 0, "published": [{"title": "Notice: TPS", "action": "new", "case_id": "c1"}],
         "failures": []},
        {"source": "uscis", "display_name": "USCIS", "items_in_feed": 5, "already_known": 5, "new": 0, "edited": 0,
         "unchanged": 5, "failed": 0, "published": [], "failures": []}])
    old_argv = sys.argv
    try:
        sys.argv = ["poll_gov_news.py", "--source", "federal-register", "--since", "2024-09-27",
                    "--max-publish", "200", "--dry-run"]
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            rc = cli.main()
        txt = out.getvalue()
        check("M7 CLI passes --source/--since/--max-publish/--dry-run through to poll_all",
              rc == 0 and got == {"source_slug": "federal-register", "dry_run": True, "force": False,
                                  "since": "2024-09-27", "max_publish": 200}, str(got))
        check("M8 CLI prints FR filter + deferred counters", "filtered_pra=1" in txt and "deferred=2" in txt)
        uscis_block = txt.split("=== uscis")[1]
        check("M9 CLI output for RSS sources unchanged (no extra counters line)",
              "filtered_" not in uscis_block and "deferred" not in uscis_block)
        sys.argv = ["poll_gov_news.py"]
        got.clear()
        with contextlib.redirect_stdout(io.StringIO()):
            cli.main()
        check("M10 CLI defaults: all sources, no since/cap override", got == {"source_slug": "", "dry_run": False,
              "force": False, "since": "", "max_publish": None})
    finally:
        sys.argv = old_argv


def group_config_edges():
    print("\nN — config edges")
    import re as _re
    good = json.load(open(fr._CONFIG_PATH))
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
        json.dump({**good, "exclude_pattern": "(unclosed"}, f)
    try:
        fr.load_config(f.name)
        check("N1 invalid regex in config raises", False)
    except _re.error:
        check("N1 invalid regex in config raises", True)
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
        f.write("{not json")
    try:
        fr.load_config(f.name)
        check("N2 malformed JSON raises", False)
    except ValueError:
        check("N2 malformed JSON raises", True)
    lean = {k: v for k, v in good.items() if k not in ("lookback_days", "max_publish_per_run",
                                                        "digest_max_words", "excerpt_max_words", "cfr_deny")}
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
        json.dump(lean, f)
    c = fr.load_config(f.name)
    check("N3 optional knobs default safely",
          (c["lookback_days"], c["max_publish_per_run"], c["digest_max_words"], c["excerpt_max_words"], c["_cfr_deny"])
          == (21, 25, 2500, 1800, set()))
    check("N4 shipped per-run cap leaves headroom in the shared 300s request", CFG["max_publish_per_run"] <= 10)
    check("N5 lookback window covers >=2 missed weekly runs", CFG["lookback_days"] >= 14)
    check("N6 DEFAULT_SOURCE passes the registry's automation gates",
          fr.DEFAULT_SOURCE["content_license"] == "public_domain" and fr.DEFAULT_SOURCE["content_type"] == "news"
          and fr.DEFAULT_SOURCE["fetch_method"] == "federalregister_api")
    import news_sources
    check("N7 DEFAULT_SOURCE has every registry REQUIRED_FIELD", news_sources.REQUIRED_FIELDS <= set(fr.DEFAULT_SOURCE),
          str(news_sources.REQUIRED_FIELDS - set(fr.DEFAULT_SOURCE)))


def main() -> None:
    print("== test_federal_register ==")
    group_config()
    group_filter()
    group_labels()
    group_excerpt()
    group_digest()
    group_poll()
    group_wiring()
    group_e2e()
    group_http()
    group_filter_regressions()
    group_digest_edges()
    group_poll_edges()
    group_cli()
    group_config_edges()
    print(f"\nSUMMARY: {_passed}/{_passed + _failed} checks passed")
    sys.exit(1 if _failed else 0)


if __name__ == "__main__":
    main()
