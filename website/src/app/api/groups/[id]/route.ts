import { NextRequest, NextResponse } from 'next/server'

import { apiBase } from '@/lib/apiBase'
const PYTHON_API_URL = apiBase()

function userHeader(request: NextRequest): Record<string, string> {
  const uid = request.headers.get('x-user-id') || ''
  const tok = request.headers.get('authorization') || ''
  return { ...(uid ? { 'X-User-Id': uid } : {}), ...(tok ? { Authorization: tok } : {}) }
}

// GET /api/groups/{id} — one group (name, members, is_member) for the chat page.
export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const res = await fetch(`${PYTHON_API_URL}/api/groups/${encodeURIComponent(params.id)}`, {
      headers: { ...userHeader(request) },
    })
    const data = await res.json()
    if (!res.ok) return NextResponse.json({ detail: data.detail || 'Could not load group' }, { status: res.status })
    return NextResponse.json(data)
  } catch {
    return NextResponse.json({ detail: 'Unable to reach the groups service.' }, { status: 503 })
  }
}

// PUT /api/groups/{id} — rename/re-describe a group. Creator-only (backend-enforced).
export async function PUT(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const body = await request.json()
    const res = await fetch(`${PYTHON_API_URL}/api/groups/${encodeURIComponent(params.id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...userHeader(request) },
      body: JSON.stringify({ name: body.name, description: body.description }),
    })
    const data = await res.json()
    if (!res.ok) return NextResponse.json({ detail: data.detail || 'Could not rename group' }, { status: res.status })
    return NextResponse.json(data)
  } catch {
    return NextResponse.json({ detail: 'Unable to reach the groups service.' }, { status: 503 })
  }
}

// DELETE /api/groups/{id} — soft-delete a group (hidden everywhere, data retained). Creator-only (backend-enforced).
export async function DELETE(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const res = await fetch(`${PYTHON_API_URL}/api/groups/${encodeURIComponent(params.id)}`, {
      method: 'DELETE',
      headers: { ...userHeader(request) },
    })
    const data = await res.json()
    if (!res.ok) return NextResponse.json({ detail: data.detail || 'Could not delete group' }, { status: res.status })
    return NextResponse.json(data)
  } catch {
    return NextResponse.json({ detail: 'Unable to reach the groups service.' }, { status: 503 })
  }
}
