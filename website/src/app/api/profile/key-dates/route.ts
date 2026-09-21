import { NextRequest, NextResponse } from 'next/server'

import { apiBase } from '@/lib/apiBase'
const PYTHON_API_URL = apiBase()

function userHeader(request: NextRequest): Record<string, string> {
  const uid = request.headers.get('x-user-id') || ''
  const tok = request.headers.get('authorization') || ''
  return { ...(uid ? { 'X-User-Id': uid } : {}), ...(tok ? { Authorization: tok } : {}) }
}

// POST /api/profile/key-dates — merge a partial key_dates update into the
// active user's profile (the post-join Timeline attribute form's save).
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const res = await fetch(`${PYTHON_API_URL}/api/profile/key-dates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...userHeader(request) },
      body: JSON.stringify({ key_dates: body.key_dates || {} }),
    })
    const data = await res.json()
    if (!res.ok) return NextResponse.json({ detail: data.detail || 'Could not save your dates' }, { status: res.status })
    return NextResponse.json(data)
  } catch {
    return NextResponse.json({ detail: 'Unable to reach the profile service.' }, { status: 503 })
  }
}
