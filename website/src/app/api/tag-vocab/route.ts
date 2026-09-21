import { NextResponse } from 'next/server'

import { apiBase } from '@/lib/apiBase'
const PYTHON_API_URL = apiBase()

/**
 * How long Next may serve a cached vocab payload.
 *
 * This used to be an hour, on the reasoning that the vocabulary is static.
 * Half of the payload no longer is: the Timeline attribute templates come
 * from externalised config (backend attribute_config) that changes without a
 * deploy, and an hour here would have capped propagation at an hour no matter
 * what the backend TTL said — the slowest cache in the chain wins.
 *
 * 60s matches the backend's default TTL, so an edit reaches a browser in
 * about two TTLs worst case. Tunable without a rebuild via
 * VOCAB_REVALIDATE_SECONDS for an environment that wants it tighter (or, for
 * a static-vocab-only deployment, looser).
 */
const REVALIDATE_SECONDS = Number(process.env.VOCAB_REVALIDATE_SECONDS ?? 60)

export async function GET() {
  try {
    const res = await fetch(`${PYTHON_API_URL}/api/tag-vocab`, {
      next: { revalidate: REVALIDATE_SECONDS },
    })
    const data = await res.json()
    if (!res.ok) {
      return NextResponse.json({ detail: data.detail || 'Could not load vocab' }, { status: res.status })
    }
    return NextResponse.json(data)
  } catch {
    return NextResponse.json({ visa: [], consulate: [], consulate_options: [], tag: [], stage_key: [], date_key: [] }, { status: 200 })
  }
}
