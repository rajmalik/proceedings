import { NextRequest, NextResponse } from 'next/server'

import { apiBase } from '@/lib/apiBase'
const PYTHON_API_URL = apiBase()

// Forward the caller's identity so the backend picks the right rate-limit tier
// (authenticated per-IP vs anonymous session cap) and the answer path stays
// usable anonymously.
function userHeader(request: NextRequest): Record<string, string> {
  const uid = request.headers.get('x-user-id') || ''
  const tok = request.headers.get('authorization') || ''
  return { ...(uid ? { 'X-User-Id': uid } : {}), ...(tok ? { Authorization: tok } : {}) }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const message = typeof body.message === 'string' ? body.message.trim() : ''
    if (!message || message.length > 2000) {
      return NextResponse.json(
        { detail: 'Message must be between 1 and 2000 characters.' },
        { status: 400 }
      )
    }

    const res = await fetch(`${PYTHON_API_URL}/api/assist`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...userHeader(request) },
      body: JSON.stringify({
        message,
        history: Array.isArray(body.history) ? body.history : [],
        session_id: typeof body.session_id === 'string' ? body.session_id : '',
        force_intent: typeof body.force_intent === 'string' ? body.force_intent : '',
      }),
    })
    const data = await res.json()

    if (!res.ok) {
      return NextResponse.json({ detail: data.detail || 'Backend error' }, { status: res.status })
    }
    return NextResponse.json(data)
  } catch {
    return NextResponse.json(
      { detail: 'Unable to reach the AI service. Please try again later.' },
      { status: 503 }
    )
  }
}
