import { NextRequest, NextResponse } from 'next/server'

import { apiBase } from '@/lib/apiBase'
const PYTHON_API_URL = apiBase()

function userHeader(request: NextRequest): Record<string, string> {
  const uid = request.headers.get('x-user-id') || ''
  const tok = request.headers.get('authorization') || ''
  return { ...(uid ? { 'X-User-Id': uid } : {}), ...(tok ? { Authorization: tok } : {}) }
}

// POST /api/groups/{id}/find-candidates — rank candidate users against this
// group's own stored criteria. Member-only (enforced backend-side).
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const res = await fetch(`${PYTHON_API_URL}/api/groups/${encodeURIComponent(params.id)}/find-candidates`, {
      method: 'POST',
      headers: { ...userHeader(request) },
    })
    const data = await res.json()
    if (!res.ok) return NextResponse.json({ detail: data.detail || 'Could not find candidates' }, { status: res.status })
    return NextResponse.json(data)
  } catch {
    return NextResponse.json({ detail: 'Unable to reach the groups service.' }, { status: 503 })
  }
}
