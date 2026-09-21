import { NextRequest, NextResponse } from 'next/server'

import { apiBase } from '@/lib/apiBase'
const PYTHON_API_URL = apiBase()

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const q = (body.q || '').trim()

    if (!q) {
      return NextResponse.json({ tags: [] })
    }

    const res = await fetch(`${PYTHON_API_URL}/api/search/query-tags`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q }),
    })
    const data = await res.json()

    if (!res.ok) {
      return NextResponse.json({ detail: data.detail || 'Could not derive tags' }, { status: res.status })
    }
    return NextResponse.json(data)
  } catch {
    return NextResponse.json({ tags: [] })
  }
}
