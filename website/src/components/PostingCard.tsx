import Link from 'next/link'

export type PostingCardData = {
  case_id: string
  title: string
  description: string
  visa: string[]
  consulates: string[]
  outcome: string
  subreddit: string
  channel: string
  tags: string[]
  url: string
  date: string
  timestamp?: string // full ingestion timestamp (for relative "X ago")
  event_timestamp?: string // the ORIGINAL source event date — never ingestion time
  author_handle?: string // synthetic per-item handle, or a fixed per-source
                          // handle (e.g. "USCIS") for gov-news content
}

// Human-readable source label: r/subreddit for Reddit content, the source's
// own handle (e.g. "USCIS") when present, else a generic per-channel label
// rather than the raw internal channel token. First-party app postings
// deliberately get no label at all (just the timestamp) — showing the
// product's own brand name on every single card read as noisy/redundant.
//
// `author_handle` is reliably present on the case detail page (a direct
// document fetch) but — verified live — is absent from list-view search
// results specifically (Discovery Engine's schema has it registered as
// non-`retrievable`, so Search API result snippets omit it; only a
// single-document fetch returns it). `channel` itself is derived
// server-side from case_id when the same gap applies to it (see
// search_client.py's _card_from_struct()), so it's reliably present here
// even when author_handle isn't — hence the gov_news-specific fallback
// below, so a News-tab list card reads "Government News" instead of the
// internal "gov_news" token when the nicer per-source name isn't available.
function sourceLabel(r: PostingCardData): string {
  if (r.subreddit) return `r/${r.subreddit}`
  if (r.author_handle) return r.author_handle
  if (r.channel === 'app') return ''
  if (r.channel === 'gov_news') return 'Government News'
  return r.channel
}

export function outcomeBadge(outcome: string) {
  const o = outcome.toLowerCase()
  if (o === 'approved' || o === 'issued') return 'badge-success'
  return 'badge-secondary'
}

// Relative "X ago" for data-freshness (mirrors ReplyItem/GroupChat).
function timeAgo(iso: string): string {
  const t = Date.parse(iso)
  if (isNaN(t)) return ''
  const sec = Math.floor((Date.now() - t) / 1000)
  if (sec < 60) return 'just now'
  const m = Math.floor(sec / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d}d ago`
  return new Date(t).toLocaleDateString()
}

export default function PostingCard({ r }: { r: PostingCardData }) {
  return (
    <Link href={`/case/${encodeURIComponent(r.case_id)}`} className="card-hover block">
      <div className="flex items-start justify-between mb-2 gap-2">
        <div className="flex items-center gap-2 flex-wrap">
          {r.tags.includes('news-update') && <span className="badge-accent">News</span>}
          {r.tags.includes('discussion') && <span className="badge-accent">Discussion</span>}
          {r.tags.includes('blog') && <span className="badge-accent">Blog</span>}
          {r.outcome && <span className={outcomeBadge(r.outcome)}>{r.outcome}</span>}
          {r.visa.slice(0, 2).map((v) => (
            <span key={v} className="badge-primary">{v}</span>
          ))}
          {/* Fallback: if there's no visa/status to show, surface the first
              general tag instead — every card should carry at least one
              relevant tag badge (features/ui-changes-1/changes-2-.md item 2). */}
          {r.visa.length === 0 && r.tags.filter((t) => !['news-update', 'discussion', 'blog'].includes(t))[0] && (
            <span className="badge-primary">{r.tags.filter((t) => !['news-update', 'discussion', 'blog'].includes(t))[0]}</span>
          )}
          {r.consulates.slice(0, 2).map((c) => (
            <span key={c} className="badge-secondary flex items-center gap-1">
              <span className="material-symbols-outlined text-[14px]">location_on</span>{c}
            </span>
          ))}
        </div>
      </div>

      <h3 className="text-headline-md text-on-surface hover:text-primary transition-colors mb-2">
        {r.title}
      </h3>

      {r.description && (
        <p className="text-body-md text-on-surface-variant mb-3 line-clamp-2">{r.description}</p>
      )}

      <div className="flex items-center justify-between text-caption text-on-surface-variant">
        <span title={r.date}>
          {/* The ORIGINAL source date, never when we ingested it — real for
              backend-ingested content (gov-news, Reddit) which is routinely
              backdated relative to ingestion; falls back to `timestamp`/
              `date` only for older cards that predate event_timestamp. */}
          {sourceLabel(r) && `${sourceLabel(r)} · `}
          {timeAgo(r.event_timestamp || r.timestamp || r.date) || r.date}
        </span>
        <span className="flex items-center gap-1 text-primary">
          View Details
          <span className="material-symbols-outlined text-[16px]">arrow_forward</span>
        </span>
      </div>
    </Link>
  )
}
