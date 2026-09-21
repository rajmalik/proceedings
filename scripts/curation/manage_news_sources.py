#!/usr/bin/env python3
"""
manage_news_sources.py — add/list/enable/disable/remove content sources
(official-site news updates AND forum postings, e.g. Reddit) in the
Firestore-backed registry (backend/news_sources.py). See
docs/ingestion/GOV-NEWS-MULTI-SOURCE-CONFIG.md for the full design.

For a "news"-type source, this is the ONLY thing that needs to happen to
add it to the automated pipeline — no code change, no deploy. The next
scheduled (or manual) poll run reads the registry fresh and picks it up
automatically. A "forum_posting"-type source (Reddit, other community
forums) can be registered here too, for a single source of truth across
both content types — but it will never be auto-polled (see
`--content-type` below); that content still goes through the existing
manual, human-curated path (scripts/curation/publish_reddit.py).

`--content-license`, `--content-type`, and `--source-category` are
deliberately REQUIRED, no default — two independent safety gates from
GOV-NEWS-INGESTION-PLAN.md §4.2 and GOV-NEWS-MULTI-SOURCE-CONFIG.md §5:
- `public_domain` is the only content_license this pipeline processes
  unattended today. `copyrighted` (any forum/law-firm source) is stored
  but NEVER polled until the paraphrase/review posture that license needs
  is actually built.
- `news` is the only content_type with an automated publish handler today
  (`publish_gov_news_item()` — built for official/authoritative content,
  no PII scrub, no moderation check). `forum_posting` is stored but never
  auto-published through that handler, regardless of license — forum
  content has a genuinely different risk profile (user-generated, PII,
  needs curation) that handler was never built for.
Requiring both flags forces a conscious choice every time, rather than
defaulting to "safe" and letting someone add an unvetted source without
thinking about either question.

Usage:
  # A new federal-government RSS source (the only fully-automated shape today)
  manage_news_sources.py add dol \
    --display-name "Department of Labor" \
    --site-url https://www.dol.gov \
    --feed-url https://www.dol.gov/some/rss/feed.xml \
    --content-license public_domain --content-type news --source-category government

  # Registering a forum source for a single source of truth — NOT auto-polled,
  # publishing still goes through scripts/curation/publish_reddit.py by hand
  manage_news_sources.py add reddit-h1b \
    --display-name "r/h1b" --site-url https://www.reddit.com/r/h1b \
    --feed-url "" --fetch-method manual \
    --content-license copyrighted --content-type forum_posting --source-category forum

  manage_news_sources.py list
  manage_news_sources.py show uscis
  manage_news_sources.py disable uscis   # stop polling without deleting config
  manage_news_sources.py enable uscis
  manage_news_sources.py remove uscis --confirm
"""

from __future__ import annotations

import argparse
import os
import sys

from dotenv import load_dotenv

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "backend"))
load_dotenv()

import news_sources as ns  # noqa: E402

_CONTENT_LICENSES = {"public_domain", "copyrighted"}
_CONTENT_TYPES = {"news", "forum_posting"}
_SOURCE_CATEGORIES = {"government", "law_firm", "forum"}
_FETCH_METHODS = {"rss"}  # the honest limit — only RSS has an automated adapter today
# "manual" isn't polled at all — for forum_posting sources registered here purely
# for a single source of truth, whose actual publishing stays a human-curated
# script (scripts/curation/publish_reddit.py), never gov_news_poll.py.
_ALL_FETCH_METHOD_CHOICES = _FETCH_METHODS | {"api", "scrape", "manual"}


def cmd_add(args: argparse.Namespace) -> int:
    if ns.get_source(args.slug):
        print(f"'{args.slug}' already exists — use a different slug, or edit it with "
              f"add again (upsert), or remove it first.", file=sys.stderr)
        return 1
    if args.fetch_method == "rss" and not args.feed_url:
        print("--feed-url is required when --fetch-method is 'rss'.", file=sys.stderr)
        return 1
    if args.fetch_method not in _FETCH_METHODS:
        reason = ("never polled by design — see the module docstring" if args.fetch_method == "manual"
                  else f"has no adapter yet in gov_news_poll.py — stored but silently skipped by every poll run")
        print(f"NOTE: fetch_method={args.fetch_method!r} — {reason}.", file=sys.stderr)
    ns.upsert_source(
        args.slug,
        display_name=args.display_name,
        site_url=args.site_url,
        feed_url=args.feed_url,
        fetch_method=args.fetch_method,
        content_license=args.content_license,
        content_type=args.content_type,
        source_category=args.source_category,
        channel=args.channel,
        enabled=not args.disabled,
    )
    if args.content_license != "public_domain":
        print(f"NOTE: content_license={args.content_license!r} — stored, but "
              f"get_enabled_sources() will exclude it from every poll run until this "
              f"pipeline implements that license's storage posture. See "
              f"GOV-NEWS-INGESTION-PLAN.md §4.2.")
    if args.content_type != "news":
        print(f"NOTE: content_type={args.content_type!r} — stored, but "
              f"get_enabled_sources() will exclude it from every poll run: only 'news' "
              f"has an automated publish handler today. See "
              f"GOV-NEWS-MULTI-SOURCE-CONFIG.md §5.")
    print(f"Added '{args.slug}' ({'enabled' if not args.disabled else 'disabled'}). "
          f"Picked up automatically on the next poll run — no deploy needed.")
    return 0


def cmd_list(args: argparse.Namespace) -> int:  # noqa: ARG001
    sources = ns.list_all_sources()
    if not sources:
        print("No sources configured.")
        return 0
    enabled_now = ns.get_enabled_sources()
    for slug, cfg in sources.items():
        status = "ACTIVE" if slug in enabled_now else (
            "disabled" if cfg.get("enabled") is False else "configured but not automatable")
        print(f"{slug:20} [{status:28}] {cfg.get('display_name', '?')} "
              f"— {cfg.get('content_type', '?')}/{cfg.get('content_license', '?')}/{cfg.get('source_category', '?')} "
              f"— {cfg.get('feed_url') or '(no feed — ' + str(cfg.get('fetch_method', '?')) + ')'}")
    return 0


def cmd_show(args: argparse.Namespace) -> int:
    cfg = ns.get_source(args.slug)
    if not cfg:
        print(f"'{args.slug}' not found.", file=sys.stderr)
        return 1
    for k, v in sorted(cfg.items()):
        print(f"  {k}: {v}")
    return 0


def cmd_enable(args: argparse.Namespace) -> int:
    if not ns.get_source(args.slug):
        print(f"'{args.slug}' not found.", file=sys.stderr)
        return 1
    ns.set_enabled(args.slug, True)
    print(f"'{args.slug}' enabled — picked up on the next poll run.")
    return 0


def cmd_disable(args: argparse.Namespace) -> int:
    if not ns.get_source(args.slug):
        print(f"'{args.slug}' not found.", file=sys.stderr)
        return 1
    ns.set_enabled(args.slug, False)
    print(f"'{args.slug}' disabled — the next poll run will skip it (config preserved).")
    return 0


def cmd_remove(args: argparse.Namespace) -> int:
    if not args.confirm:
        print("Refusing to remove without --confirm (this deletes the config; "
              "already-published content is untouched).", file=sys.stderr)
        return 1
    if not ns.remove_source(args.slug):
        print(f"'{args.slug}' not found.", file=sys.stderr)
        return 1
    print(f"'{args.slug}' removed.")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)

    p_add = sub.add_parser("add", help="add a new source")
    p_add.add_argument("slug", help="short unique id, e.g. 'dol' — becomes source_system")
    p_add.add_argument("--display-name", required=True, help='e.g. "Department of Labor" or "r/h1b"')
    p_add.add_argument("--site-url", required=True)
    p_add.add_argument("--feed-url", default="", help="the RSS feed URL to poll — required if --fetch-method is 'rss'")
    p_add.add_argument("--content-license", required=True, choices=sorted(_CONTENT_LICENSES),
                        help="public_domain (federal gov, verified) or copyrighted (forum/law-firm) — see the module docstring")
    p_add.add_argument("--content-type", required=True, choices=sorted(_CONTENT_TYPES),
                        help="news (official-site updates) or forum_posting (Reddit, other community "
                             "forums) — only 'news' is auto-published today, see the module docstring")
    p_add.add_argument("--source-category", required=True, choices=sorted(_SOURCE_CATEGORIES))
    p_add.add_argument("--fetch-method", default="rss", choices=sorted(_ALL_FETCH_METHOD_CHOICES),
                        help="default: rss (the only one with an automated adapter today); "
                             "use 'manual' for a forum_posting source with no poll mechanism")
    p_add.add_argument("--channel", default="gov_news",
                        help='search-boost/doc_kind bucket, default "gov_news" — a law-firm or forum '
                             'source should use a different value, see GOV-NEWS-INGESTION-PLAN.md §4.2')
    p_add.add_argument("--disabled", action="store_true", help="add but don't enable yet")
    p_add.set_defaults(func=cmd_add)

    p_list = sub.add_parser("list", help="list all configured sources")
    p_list.set_defaults(func=cmd_list)

    p_show = sub.add_parser("show", help="show one source's full config")
    p_show.add_argument("slug")
    p_show.set_defaults(func=cmd_show)

    p_enable = sub.add_parser("enable", help="enable a source")
    p_enable.add_argument("slug")
    p_enable.set_defaults(func=cmd_enable)

    p_disable = sub.add_parser("disable", help="disable a source (config preserved)")
    p_disable.add_argument("slug")
    p_disable.set_defaults(func=cmd_disable)

    p_remove = sub.add_parser("remove", help="permanently delete a source's config")
    p_remove.add_argument("slug")
    p_remove.add_argument("--confirm", action="store_true")
    p_remove.set_defaults(func=cmd_remove)

    args = ap.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
