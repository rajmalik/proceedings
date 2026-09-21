import { NextRequest, NextResponse } from 'next/server'

import { apiBase } from '@/lib/apiBase'
const PYTHON_API_URL = apiBase()

function userHeader(request: NextRequest): Record<string, string> {
  const uid = request.headers.get('x-user-id') || ''
  const tok = request.headers.get('authorization') || ''
  return { ...(uid ? { 'X-User-Id': uid } : {}), ...(tok ? { Authorization: tok } : {}) }
}

// GET /api/groups/{id}/invitations — pending invitations for one group (members only).
export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const res = await fetch(`${PYTHON_API_URL}/api/groups/${encodeURIComponent(params.id)}/invitations`, {
      headers: { ...userHeader(request) },
    })
    const data = await res.json()
    if (!res.ok) return NextResponse.json({ detail: data.detail || 'Could not load invitations' }, { status: res.status })
    return NextResponse.json(data)
  } catch {
    return NextResponse.json({ detail: 'Unable to reach the groups service.' }, { status: 503 })
  }
}
