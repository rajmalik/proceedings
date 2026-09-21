import { ReplyCardData } from '../services/apiService';

/**
 * Client-side reply threading. The backend returns a FLAT list of replies for a
 * posting (each carrying `parent_reply_id`, empty = top-level); the client nests
 * them. On mobile we render through a single `FlatList`, so instead of a nested
 * component tree we flatten the hierarchy into one DFS-ordered display list where
 * each row carries its `depth` + descendant metadata. Collapsing a subtree is
 * then just filtering rows whose ancestor is collapsed (see `visibleRows`).
 */

export interface FlatReplyRow {
  reply: ReplyCardData;
  depth: number; // 0 = top-level reply (direct reply to the posting)
  descendantCount: number; // total nested replies beneath this one ("[+] N replies")
  hasChildren: boolean;
  ancestorIds: string[]; // parent-reply id chain to the root (for collapse filtering)
}

function comparator(sort: 'top' | 'new') {
  // Mirrors the backend's per-sibling ordering: 'new' = recency; 'top' = score
  // then recency. ISO-8601 timestamps sort lexicographically.
  return (a: ReplyCardData, b: ReplyCardData): number => {
    if (sort === 'new') return b.created_at.localeCompare(a.created_at);
    return b.score - a.score || b.created_at.localeCompare(a.created_at);
  };
}

/**
 * Flatten the flat reply list into a DFS-ordered display list with depth +
 * descendant counts, siblings sorted at every level by `sort`. A reply whose
 * `parent_reply_id` is missing from the set (e.g. a blocked/filtered author, or
 * a soft-deleted leaf the server dropped) is treated as top-level so it never
 * disappears. Guards against cycles from corrupt data.
 */
export function flattenReplyTree(
  replies: ReplyCardData[],
  sort: 'top' | 'new',
): FlatReplyRow[] {
  const ids = new Set(replies.map((r) => r.id));
  const byParent = new Map<string, ReplyCardData[]>();
  for (const r of replies) {
    const pid = r.parent_reply_id && ids.has(r.parent_reply_id) ? r.parent_reply_id : '';
    const bucket = byParent.get(pid);
    if (bucket) bucket.push(r);
    else byParent.set(pid, [r]);
  }

  const cmp = comparator(sort);
  for (const bucket of byParent.values()) bucket.sort(cmp);

  const rows: FlatReplyRow[] = [];
  const seen = new Set<string>();

  const walk = (parentId: string, depth: number, ancestorIds: string[]): void => {
    const children = byParent.get(parentId) || [];
    for (const child of children) {
      if (seen.has(child.id)) continue; // cycle guard
      seen.add(child.id);
      const row: FlatReplyRow = {
        reply: child,
        depth,
        descendantCount: 0,
        hasChildren: false,
        ancestorIds,
      };
      rows.push(row);
      const before = rows.length;
      walk(child.id, depth + 1, [...ancestorIds, child.id]);
      row.descendantCount = rows.length - before;
      row.hasChildren = row.descendantCount > 0;
    }
  };
  walk('', 0, []);
  return rows;
}

/** Rows visible given a set of collapsed reply ids: a row hides when any of its
 *  ancestors is collapsed. A collapsed row itself stays visible (it shows the
 *  "[+] N replies" summary); only its descendants are removed. */
export function visibleRows(rows: FlatReplyRow[], collapsed: Set<string>): FlatReplyRow[] {
  if (collapsed.size === 0) return rows;
  return rows.filter((row) => !row.ancestorIds.some((id) => collapsed.has(id)));
}
