import { NextRequest, NextResponse } from 'next/server'

import { apiBase } from '@/lib/apiBase'
const PYTHON_API_URL = apiBase()

// POST /api/groups/search — search EXISTING groups by criteria. Public,
// like Advanced Search's own posting search — no auth required to search;
// joining/creating still goes through the authenticated routes.
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const res = await fetch(`${PYTHON_API_URL}/api/groups/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        criteria: body.criteria || {},
        group_type: body.group_type || '',
        precision: body.precision || 'balanced',
        max_age_days: body.max_age_days || 0,
      }),
    })
    const data = await res.json()
    if (!res.ok) return NextResponse.json({ detail: data.detail || 'Could not search groups' }, { status: res.status })
    return NextResponse.json(data)
  } catch {
    return NextResponse.json({ detail: 'Unable to reach the groups service.' }, { status: 503 })
  }
}
