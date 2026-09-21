import { NextRequest, NextResponse } from 'next/server'

import { apiBase } from '@/lib/apiBase'
const PYTHON_API_URL = apiBase()

// POST /api/onboard — one AI-onboarding turn for the active user.
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const uid = request.headers.get('x-user-id') || ''
    const tok = request.headers.get('authorization') || ''
    const res = await fetch(`${PYTHON_API_URL}/api/onboard`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(uid ? { 'X-User-Id': uid } : {}),
        ...(tok ? { Authorization: tok } : {}),
      },
      body: JSON.stringify({ messages: body.messages || [], draft: body.draft || {}, stage: body.stage || 'basics' }),
    })
    const data = await res.json()
    if (!res.ok) return NextResponse.json({ detail: data.detail || 'Onboarding error' }, { status: res.status })
    return NextResponse.json(data)
  } catch {
    return NextResponse.json({ detail: 'Unable to reach the onboarding service.' }, { status: 503 })
  }
}
