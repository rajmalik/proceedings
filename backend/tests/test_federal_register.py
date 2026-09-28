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
    print(f"\nSUMMARY: {_passed}/{_passed + _failed} checks passed")
    sys.exit(1 if _failed else 0)


if __name__ == "__main__":
    main()
