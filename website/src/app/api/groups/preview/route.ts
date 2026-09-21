import { NextRequest, NextResponse } from 'next/server'

import { apiBase } from '@/lib/apiBase'
const PYTHON_API_URL = apiBase()

// POST /api/groups/preview — the name and description these criteria WOULD
// produce, without creating anything. Public, like /search.
//
// A preview failing must never block the create flow, so a non-OK response
// comes back as empty strings rather than an error the page has to render:
// the worst case is a create screen with no generated name, not one you
// can't use.
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const res = await fetch(`${PYTHON_API_URL}/api/groups/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        criteria: body.criteria || {},
        group_type: body.group_type || '',
      }),
    })
    const data = await res.json()
    if (!res.ok) return NextResponse.json({ name: '', description: '' })
    return NextResponse.json(data)
  } catch {
    return NextResponse.json({ name: '', description: '' })
  }
}
