#!/usr/bin/env python3
"""No-GCP, no-network tests for the RSS path of gov_news_poll.py (the live
USCIS newsroom poller). Added with the Federal Register work, which changed
this module's dispatch — these prove the RSS path is behaviorally unchanged.

Stubs: gov_news_poll.requests.get (feed + article pages), _existing_hashes
(the BigQuery known map), posting.publish_gov_news_item (recorder).
posting.content_hash_for is the REAL function (pure) — the dedup contract.

Run:  python tests/test_gov_news_poll.py      (wired into the CI gate)
"""
import sys
from pathlib import Path

_BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_BACKEND))

import gov_news_poll as g  # noqa: E402
import posting  # noqa: E402

_passed = 0
_failed = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global _passed, _failed
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f" — {detail}" if detail else ""))
    if ok:
        _passed += 1
    else:
        _failed += 1


LONG = " ".join(["USCIS announced a policy update affecting employment authorization documents."] * 6)
THIN = "USCIS alert: see details."
FULL = "Full article body describing the change to Form I-765 filing locations in detail for applicants."
SRC = {"display_name": "USCIS", "fetch_method": "rss", "feed_url": "https://www.uscis.gov/feed",
       "channel": "gov_news", "content_type": "news"}


def rss(*items):
    body = "".join(
        f"<item><title>{t}</title><link>{l}</link><description>{d}</description>"
        f"<pubDate>{p}</pubDate><guid>{gid}</guid></item>" for t, l, d, p, gid in items)
    return f"<?xml version='1.0'?><rss><channel>{body}</channel></rss>"


class _Resp:
    def __init__(self, text, status=200):
        self.text, self.status = text, status

    def raise_for_status(self):
        if self.status >= 400:
            raise g.requests.HTTPError(str(self.status))


class Env:
    """Installs stubs; `pages` maps URL -> HTML (or an int status)."""
    def __init__(self, feed, pages=None, known=None, fail_publish=()):
        self.feed, self.pages, self.known = feed, pages or {}, known or {}
        self.fail_publish, self.published, self.gets = set(fail_publish), [], []

    def _get(self, url, timeout=None):
        self.gets.append(url)
        if url == SRC["feed_url"]:
            return _Resp(self.feed)
        page = self.pages.get(url, 404)
        return _Resp("", page) if isinstance(page, int) else _Resp(page)

    def _publish(self, **kw):
        if kw["source_item_id"] in self.fail_publish:
            raise RuntimeError("import failed")
        self.published.append(kw)
        return {"case_id": f"gov_news-uscis-{kw['source_item_id']}"}

    def __enter__(self):
        self._o = (g.requests.get, g._existing_hashes, posting.publish_gov_news_item)
        g.requests.get = self._get
        g._existing_hashes = lambda slug: dict(self.known)
        posting.publish_gov_news_item = self._publish
        return self

    def __exit__(self, *a):
        g.requests.get, g._existing_hashes, posting.publish_gov_news_item = self._o


def item(gid, desc=LONG, title=None, pub="Mon, 22 Sep 2026 10:00:00 -0400"):
    return (title or f"News {gid}", f"https://www.uscis.gov/news/{gid}", desc, pub, gid)


def main() -> None:
    print("== test_gov_news_poll (RSS path) ==")

    print("\nA — feed parsing")
    with Env(rss(item("a"), ("", "https://x", "d", "", "b"), item("c", pub="not a date"))) as e:
        items = g._parse_feed(SRC["feed_url"])
    check("A1 malformed item (no title) skipped, others kept", [i["guid"] for i in items] == ["a", "c"])
    check("A2 RFC-822 pubDate -> YYYY-MM-DD", items[0]["posting_date"] == "2026-09-22")
    check("A3 unparseable pubDate -> '' (no crash)", items[1]["posting_date"] == "")

    print("\nB — classify new / unchanged / edited against the BigQuery map")
    h_a = posting.content_hash_for("News a", LONG)
    with Env(rss(item("a"), item("b"), item("c")), known={"a": h_a, "b": "stale-hash"}) as e:
        r = g.poll_source("uscis", SRC)
    check("B1 counts: 1 new, 1 edited, 1 unchanged", (r["new"], r["edited"], r["unchanged"]) == (1, 1, 1), str(r))
    by = {p["source_item_id"]: p for p in e.published}
    check("B2 unchanged item NOT republished", "a" not in by)
    check("B3 edited item republished with is_edit=True (delete-before-insert)", by["b"]["is_edit"] is True)
    check("B4 new item: guid is source_item_id, link is full_url, RSS defaults (no tag_text/ingestion override)",
          by["c"]["is_edit"] is False and by["c"]["full_url"].endswith("/c") and by["c"]["channel"] == "gov_news"
          and by["c"]["content_type"] == "news" and "tag_text" not in by["c"] and "ingestion_method" not in by["c"])
    check("B5 summary shape (what the CLI/route print)",
          {"source", "display_name", "items_in_feed", "already_known", "published", "failures"} <= set(r)
          and r["items_in_feed"] == 3 and r["already_known"] == 2)

    print("\nC — thin description -> full-article fallback (hash-after-fallback regression)")
    url = "https://www.uscis.gov/news/t"
    page = f"<html><article><div class='field--name-body'>{FULL}</div></article></html>"
    with Env(rss(item("t", desc=THIN)), pages={url: page}) as e:
        r = g.poll_source("uscis", SRC)
    check("C1 thin RSS description replaced by the fetched article body", e.published[0]["description"] == FULL)
    stored = posting.content_hash_for("News t", FULL)
    with Env(rss(item("t", desc=THIN)), pages={url: page}, known={"t": stored}) as e:
        r = g.poll_source("uscis", SRC)
    check("C2 REGRESSION (2026-07-27): rerun of an unchanged thin item is 'unchanged', not re-edited forever",
          r["unchanged"] == 1 and r["edited"] == 0 and not e.published, str(r))
    main_only = f"<html><main><article>{FULL}</article></main></html>"
    with Env(rss(item("t", desc=THIN)), pages={url: main_only}) as e:
        g.poll_source("uscis", SRC)
    check("C3 selector fallback: `main article` when the Drupal body field is absent",
          FULL in e.published[0]["description"])
    with Env(rss(item("t", desc=THIN)), pages={url: 503}) as e:
        r = g.poll_source("uscis", SRC)
    check("C4 article fetch failure -> publish the thin description (no crash)",
          r["new"] == 1 and e.published[0]["description"] == THIN)
    with Env(rss(item("l"))) as e:
        g.poll_source("uscis", SRC)
    check("C5 long description -> no article fetch at all", e.gets == [SRC["feed_url"]])
    with Env(rss(item("t", desc=THIN)), pages={url: "<html><div>no article markup</div></html>"}) as e:
        g.poll_source("uscis", SRC)
    check("C6 page matches neither selector -> keep the thin description", e.published[0]["description"] == THIN)

    print("\nD — run modes + isolation")
    with Env(rss(item("a"), item("b"))) as e:
        r = g.poll_source("uscis", SRC, dry_run=True)
    check("D1 dry-run: classified, nothing published", r["new"] == 2 and not e.published
          and all(p.get("dry_run") for p in r["published"]))
    with Env(rss(item("a")), known={"a": h_a}) as e:
        r = g.poll_source("uscis", SRC, force=True)
    check("D2 force: known map ignored, item republished", r["new"] == 1 and len(e.published) == 1)
    with Env(rss(item("a"), item("b")), fail_publish={"a"}) as e:
        r = g.poll_source("uscis", SRC)
    check("D3 one publish failure isolated; run continues", r["failed"] == 1 and r["new"] == 2
          and [p["source_item_id"] for p in e.published] == ["b"] and r["failures"][0]["guid"] == "a")
    with Env(rss(item("a"))) as e:
        r = g.poll_source("uscis", SRC, since="2020-01-01", max_publish=0)
    check("D4 RSS ignores the FR-only since/max_publish knobs", r["new"] == 1 and len(e.published) == 1)
    with Env(rss(*[item(f"n{i}") for i in range(120)])) as e:
        r = g.poll_source("uscis", SRC)
    check("D6 large feed (120 items, past the 50-item checkpoints) fully processed",
          r["new"] == 120 and len({p["source_item_id"] for p in e.published}) == 120)
    r = g.poll_source("x", {**SRC, "fetch_method": "api"})
    check("D5 fetch_method without an adapter -> skipped with reason",
          r.get("skipped") and "no adapter" in r["reason"])

    print("\nE — _existing_hashes (the BigQuery known map; fake client, no GCP)")
    from google.cloud import bigquery
    from google.api_core.exceptions import NotFound
    seen = {}

    class FakeClient:
        mode = "rows"

        def __init__(self, project=None):
            seen["project"] = project

        def query(self, sql, job_config=None):
            seen["sql"], seen["cfg"] = sql, job_config
            if FakeClient.mode == "notfound":
                raise NotFound("table")
            if FakeClient.mode == "boom":
                raise RuntimeError("quota")
            rows = [{"source_item_id": "a", "content_hash": "h1"}, {"source_item_id": "b", "content_hash": "h2"}]
            return type("J", (), {"result": lambda self: rows})()
    orig = bigquery.Client
    bigquery.Client = FakeClient
    try:
        got = g._existing_hashes("federal-register")
        check("E1 rows -> {source_item_id: content_hash}", got == {"a": "h1", "b": "h2"})
        params = {p.name: p.value for p in seen["cfg"].query_parameters}
        check("E2 query is parameterized by source_system (no string interpolation of the slug)",
              params == {"source_system": "federal-register"} and "federal-register" not in seen["sql"])
        check("E3 latest row per id (QUALIFY ROW_NUMBER ... ingestion_timestamp DESC)",
              "QUALIFY ROW_NUMBER()" in seen["sql"] and "ingestion_timestamp DESC" in seen["sql"])
        FakeClient.mode = "notfound"
        check("E4 table missing (first-ever run) -> {} (everything new)", g._existing_hashes("x") == {})
        FakeClient.mode = "boom"
        check("E5 any other BigQuery error -> {} (fail-open, run continues)", g._existing_hashes("x") == {})
    finally:
        bigquery.Client = orig

    print(f"\nSUMMARY: {_passed}/{_passed + _failed} checks passed")
    sys.exit(1 if _failed else 0)


if __name__ == "__main__":
    main()
