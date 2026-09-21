import { NextRequest, NextResponse } from 'next/server'

import { apiBase } from '@/lib/apiBase'
const PYTHON_API_URL = apiBase()

function userHeader(request: NextRequest): Record<string, string> {
  const uid = request.headers.get('x-user-id') || ''
  const tok = request.headers.get('authorization') || ''
  return { ...(uid ? { 'X-User-Id': uid } : {}), ...(tok ? { Authorization: tok } : {}) }
}

// POST /api/groups/{id}/invite — a current member adds someone they know by handle.
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const body = await request.json()
    const res = await fetch(`${PYTHON_API_URL}/api/groups/${encodeURIComponent(params.id)}/invite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...userHeader(request) },
      body: JSON.stringify({ handle: body.handle }),
    })
    const data = await res.json()
    if (!res.ok) return NextResponse.json({ detail: data.detail || 'Could not invite that handle' }, { status: res.status })
    return NextResponse.json(data)
  } catch {
    return NextResponse.json({ detail: 'Unable to reach the groups service.' }, { status: 503 })
  }
}
