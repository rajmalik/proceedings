import { NextRequest, NextResponse } from 'next/server'

import { apiBase } from '@/lib/apiBase'
const PYTHON_API_URL = apiBase()

function userHeader(request: NextRequest): Record<string, string> {
  const uid = request.headers.get('x-user-id') || ''
  const tok = request.headers.get('authorization') || ''
  return { ...(uid ? { 'X-User-Id': uid } : {}), ...(tok ? { Authorization: tok } : {}) }
}

// POST /api/groups/{id}/add-members — a current member adds one or more
// found candidates (by user_id) directly. Member-only (enforced backend-side).
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const body = await request.json()
    const res = await fetch(`${PYTHON_API_URL}/api/groups/${encodeURIComponent(params.id)}/add-members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...userHeader(request) },
      body: JSON.stringify({ user_ids: body.user_ids || [] }),
    })
    const data = await res.json()
    if (!res.ok) return NextResponse.json({ detail: data.detail || 'Could not add candidates' }, { status: res.status })
    return NextResponse.json(data)
  } catch {
    return NextResponse.json({ detail: 'Unable to reach the groups service.' }, { status: 503 })
  }
}
