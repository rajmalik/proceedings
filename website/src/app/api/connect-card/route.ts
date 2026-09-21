import { NextRequest, NextResponse } from 'next/server'

import { apiBase } from '@/lib/apiBase'
const PYTHON_API_URL = apiBase()

// POST /api/connect-card — publish a 'looking to connect' card from the active profile.
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const uid = request.headers.get('x-user-id') || ''
    const tok = request.headers.get('authorization') || ''
    const res = await fetch(`${PYTHON_API_URL}/api/connect-card`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(uid ? { 'X-User-Id': uid } : {}),
        ...(tok ? { Authorization: tok } : {}),
      },
      body: JSON.stringify({ note: (body.note || '').slice(0, 2000) }),
    })
    const data = await res.json()
    if (!res.ok) return NextResponse.json({ detail: data.detail || 'Could not publish connect card' }, { status: res.status })
    return NextResponse.json(data)
  } catch {
    return NextResponse.json({ detail: 'Unable to reach the connect service.' }, { status: 503 })
  }
}
