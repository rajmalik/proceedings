import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'

/**
 * The group/invitation proxy routes.
 *
 * No proxy route in this repo had a test before; this branch added a dozen of
 * them, and they are the only thing standing between the browser and the
 * FastAPI service. They're thin, but each one hand-rolls the same four things,
 * and a single omission is a real bug class:
 *
 *   - forwarding the caller's identity (drop it and every call 400s, which is
 *     exactly the shared-link bug this branch fixed)
 *   - the upstream URL, with the group id percent-encoded
 *   - the request body it reshapes
 *   - upstream failure handling: status passthrough, and 503 when the backend
 *     is unreachable rather than an unhandled rejection
 *
 * They are exercised through their exported handlers with a hand-built request
 * — the routes only ever touch `headers.get()` and `json()`.
 */

const BASE = 'http://localhost:8000'

type Body = unknown
function req(opts: { uid?: string; token?: string; body?: Body; noBody?: boolean } = {}): NextRequest {
  const headers = new Map<string, string>()
  if (opts.uid) headers.set('x-user-id', opts.uid)
  if (opts.token) headers.set('authorization', opts.token)
  return {
    headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null },
    json: async () => {
      if (opts.noBody) throw new SyntaxError('Unexpected end of JSON input')
      return opts.body ?? {}
    },
  } as unknown as NextRequest
}

function upstream(status = 200, payload: unknown = { ok: true }) {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  })) as unknown as typeof fetch
}

const lastCall = () => (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
const calledUrl = () => String(lastCall()[0])
const calledInit = () => lastCall()[1] as RequestInit
const calledHeaders = () => (calledInit()?.headers || {}) as Record<string, string>
const calledBody = () => JSON.parse(String(calledInit()?.body ?? '{}'))

beforeEach(() => { vi.resetModules() })

// ── every route, one row: the shared contract ──────────────────────────────
type Row = {
  name: string
  load: () => Promise<{ handler: (r: NextRequest, ctx?: never) => Promise<Response> }>
  path: string
  method?: string
  body?: Body
  /** Deliberately unauthenticated — searching groups needs no identity, the
   *  same way Advanced Search's posting search doesn't. */
  public?: boolean
  /** Deliberately swallows upstream failure and answers 200 with a neutral
   *  body instead of passing the status through. Only for routes whose result
   *  is cosmetic: a dead preview must not block creating a group. */
  softFail?: unknown
}

const ID = 'g1'
const ctx = { params: { id: ID } } as never

const ROUTES: Row[] = [
  { name: 'GET /groups', path: '/api/groups', method: 'GET',
    load: async () => ({ handler: (r) => import('../route').then((m) => m.GET(r)) }) },
  { name: 'POST /groups', path: '/api/groups', method: 'POST', body: { criteria: {} },
    load: async () => ({ handler: (r) => import('../route').then((m) => m.POST(r)) }) },
  { name: 'POST /groups/search', path: '/api/groups/search', method: 'POST', body: { criteria: {} }, public: true,
    load: async () => ({ handler: (r) => import('../search/route').then((m) => m.POST(r)) }) },
  { name: 'POST /groups/preview', path: '/api/groups/preview', method: 'POST', body: { criteria: {} },
    public: true, softFail: { name: '', description: '' },
    load: async () => ({ handler: (r) => import('../preview/route').then((m) => m.POST(r)) }) },
  { name: 'GET /groups/invitations', path: '/api/groups/invitations', method: 'GET',
    load: async () => ({ handler: (r) => import('../invitations/route').then((m) => m.GET(r)) }) },
  { name: 'GET /groups/{id}', path: `/api/groups/${ID}`, method: 'GET',
    load: async () => ({ handler: (r) => import('../[id]/route').then((m) => m.GET(r, ctx)) }) },
  { name: 'GET /groups/{id}/attributes', path: `/api/groups/${ID}/attributes`, method: 'GET',
    load: async () => ({ handler: (r) => import('../[id]/attributes/route').then((m) => m.GET(r, ctx)) }) },
  { name: 'POST /groups/{id}/attributes', path: `/api/groups/${ID}/attributes`, method: 'POST',
    load: async () => ({ handler: (r) => import('../[id]/attributes/route').then((m) => m.POST(r, ctx)) }) },
  { name: 'GET /groups/{id}/invitations', path: `/api/groups/${ID}/invitations`, method: 'GET',
    load: async () => ({ handler: (r) => import('../[id]/invitations/route').then((m) => m.GET(r, ctx)) }) },
  { name: 'POST /groups/{id}/invitations/accept', path: `/api/groups/${ID}/invitations/accept`, method: 'POST',
    load: async () => ({ handler: (r) => import('../[id]/invitations/accept/route').then((m) => m.POST(r, ctx)) }) },
  { name: 'POST /groups/{id}/invitations/decline', path: `/api/groups/${ID}/invitations/decline`, method: 'POST',
    load: async () => ({ handler: (r) => import('../[id]/invitations/decline/route').then((m) => m.POST(r, ctx)) }) },
  { name: 'POST /groups/{id}/archive', path: `/api/groups/${ID}/archive`, method: 'POST', body: { archived: true },
    load: async () => ({ handler: (r) => import('../[id]/archive/route').then((m) => m.POST(r, ctx)) }) },
  { name: 'POST /groups/{id}/add-members', path: `/api/groups/${ID}/add-members`, method: 'POST', body: { user_ids: ['u2'] },
    load: async () => ({ handler: (r) => import('../[id]/add-members/route').then((m) => m.POST(r, ctx)) }) },
  { name: 'POST /groups/{id}/find-candidates', path: `/api/groups/${ID}/find-candidates`, method: 'POST',
    load: async () => ({ handler: (r) => import('../[id]/find-candidates/route').then((m) => m.POST(r, ctx)) }) },
  { name: 'POST /groups/{id}/join', path: `/api/groups/${ID}/join`, method: 'POST',
    load: async () => ({ handler: (r) => import('../[id]/join/route').then((m) => m.POST(r, ctx)) }) },
]

describe.each(ROUTES)('$name', (row) => {
  it('forwards to the matching backend path with the right method', async () => {
    global.fetch = upstream()
    const { handler } = await row.load()
    await handler(req({ uid: 'demo-arjun', body: row.body }))
    expect(calledUrl()).toBe(`${BASE}${row.path}`)
    expect(calledInit()?.method ?? 'GET').toBe(row.method)
  })

  it(row.public
    ? 'deliberately sends NO identity — this route is public'
    : 'forwards the caller identity — without it the backend 400s', async () => {
    global.fetch = upstream()
    const { handler } = await row.load()
    await handler(req({ uid: 'demo-arjun', token: 'Bearer tok', body: row.body }))
    if (row.public) {
      // The backend's search_groups_route takes no viewer at all; forwarding
      // one would imply a per-viewer result set that doesn't exist.
      expect(calledHeaders()).not.toHaveProperty('X-User-Id')
    } else {
      expect(calledHeaders()['X-User-Id']).toBe('demo-arjun')
      expect(calledHeaders()['Authorization']).toBe('Bearer tok')
    }
  })

  it('omits the identity headers entirely when the caller has none', async () => {
    // Sending `X-User-Id: ""` reads as a real (empty) identity upstream.
    global.fetch = upstream()
    const { handler } = await row.load()
    await handler(req({ body: row.body }))
    expect(calledHeaders()).not.toHaveProperty('X-User-Id')
    expect(calledHeaders()).not.toHaveProperty('Authorization')
  })

  it(row.softFail
    ? 'swallows an upstream error into a neutral 200 — the result is cosmetic'
    : 'passes an upstream error status and detail straight through', async () => {
    global.fetch = upstream(403, { detail: 'Only members can do that.' })
    const { handler } = await row.load()
    const res = await handler(req({ uid: 'demo-arjun', body: row.body }))
    if (row.softFail) {
      expect(res.status).toBe(200)
      await expect(res.json()).resolves.toEqual(row.softFail)
    } else {
      expect(res.status).toBe(403)
      await expect(res.json()).resolves.toEqual({ detail: 'Only members can do that.' })
    }
  })

  it(row.softFail
    ? 'answers a neutral 200 when the backend is unreachable, never blocking the page'
    : 'answers 503 when the backend is unreachable, not an unhandled rejection', async () => {
    global.fetch = vi.fn(async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch
    const { handler } = await row.load()
    const res = await handler(req({ uid: 'demo-arjun', body: row.body }))
    if (row.softFail) {
      expect(res.status).toBe(200)
      await expect(res.json()).resolves.toEqual(row.softFail)
    } else {
      expect(res.status).toBe(503)
      await expect(res.json()).resolves.toEqual({ detail: expect.stringMatching(/Unable to reach/) })
    }
  })

  it(row.softFail
    ? 'still answers a neutral 200 when the upstream error has no detail'
    : 'substitutes its own message when the upstream error has no detail', async () => {
    global.fetch = upstream(500, {})
    const { handler } = await row.load()
    const res = await handler(req({ uid: 'demo-arjun', body: row.body }))
    if (row.softFail) {
      expect(res.status).toBe(200)
      await expect(res.json()).resolves.toEqual(row.softFail)
      return
    }
    expect(res.status).toBe(500)
    const body = await res.json() as { detail: string }
    expect(body.detail).toBeTruthy()
  })
})

describe('group id encoding', () => {
  it('percent-encodes an id with URL-significant characters', async () => {
    // Firestore ids are alphanumeric today, but a raw interpolation here is a
    // path-traversal shaped hole waiting for the first id that isn't.
    global.fetch = upstream()
    const m = await import('../[id]/route')
    await m.GET(req({ uid: 'demo-arjun' }), { params: { id: 'a/../b?x=1' } } as never)
    expect(calledUrl()).toBe(`${BASE}/api/groups/a%2F..%2Fb%3Fx%3D1`)
  })
})

describe('bodies the routes reshape', () => {
  it('POST /attributes sends values and notes', async () => {
    global.fetch = upstream()
    const m = await import('../[id]/attributes/route')
    await m.POST(req({ uid: 'demo-mei', body: { values: { priority_date: '2021-03-15' }, notes: 'hi' } }), ctx)
    expect(calledBody()).toEqual({ values: { priority_date: '2021-03-15' }, notes: 'hi' })
  })

  it('POST /attributes defaults a partial body rather than sending undefined', async () => {
    global.fetch = upstream()
    const m = await import('../[id]/attributes/route')
    await m.POST(req({ uid: 'demo-mei', body: {} }), ctx)
    expect(calledBody()).toEqual({ values: {}, notes: '' })
  })

  it('accept forwards values/notes — accepting runs the same attribute gate as joining', async () => {
    global.fetch = upstream()
    const m = await import('../[id]/invitations/accept/route')
    await m.POST(req({ uid: 'demo-mei', body: { values: { ead_filed_date: '2026-03-01' } } }), ctx)
    expect(calledBody()).toEqual({ values: { ead_filed_date: '2026-03-01' }, notes: '' })
  })

  it('accept tolerates a body-less POST instead of 503ing on the JSON parse', async () => {
    // The find page accepts with no body when the group needs no attributes.
    global.fetch = upstream()
    const m = await import('../[id]/invitations/accept/route')
    const res = await m.POST(req({ uid: 'demo-mei', noBody: true }), ctx)
    expect(res.status).toBe(200)
    expect(calledBody()).toEqual({ values: {}, notes: '' })
  })

  it('archive coerces the flag to a real boolean', async () => {
    global.fetch = upstream()
    const m = await import('../[id]/archive/route')
    await m.POST(req({ uid: 'demo-arjun', body: { archived: 'yes' } }), ctx)
    expect(calledBody()).toEqual({ archived: true })
  })

  it('archive sends false rather than dropping the key when un-archiving', async () => {
    global.fetch = upstream()
    const m = await import('../[id]/archive/route')
    await m.POST(req({ uid: 'demo-arjun', body: { archived: false } }), ctx)
    expect(calledBody()).toEqual({ archived: false })
  })

  it('add-members defaults to an empty list rather than undefined', async () => {
    global.fetch = upstream()
    const m = await import('../[id]/add-members/route')
    await m.POST(req({ uid: 'demo-arjun', body: {} }), ctx)
    expect(calledBody()).toEqual({ user_ids: [] })
  })

  it('preview forwards only criteria and group_type — it sends nothing else upstream', async () => {
    global.fetch = upstream()
    const m = await import('../preview/route')
    await m.POST(req({
      uid: 'demo-arjun',
      // precision/max_age_days belong to /search; preview must not smuggle them.
      body: { criteria: { tags: ['EAD'] }, group_type: 'timeline', precision: 'strict' },
    }))
    expect(calledBody()).toEqual({ criteria: { tags: ['EAD'] }, group_type: 'timeline' })
  })

  it('preview defaults a partial body rather than sending undefined', async () => {
    global.fetch = upstream()
    const m = await import('../preview/route')
    await m.POST(req({ uid: 'demo-arjun', body: {} }))
    expect(calledBody()).toEqual({ criteria: {}, group_type: '' })
  })

  it('preview returns the upstream name and description untouched', async () => {
    global.fetch = upstream(200, { name: 'H-1B-change-of-status-COS-Mar-2026', description: 'Blurb.' })
    const m = await import('../preview/route')
    const res = await m.POST(req({ uid: 'demo-arjun', body: { criteria: {}, group_type: 'timeline' } }))
    await expect(res.json()).resolves.toEqual({
      name: 'H-1B-change-of-status-COS-Mar-2026', description: 'Blurb.',
    })
  })
})

describe('POST /api/profile/key-dates', () => {
  it('forwards the key_dates map with the caller identity', async () => {
    global.fetch = upstream()
    const m = await import('../../profile/key-dates/route')
    await m.POST(req({ uid: 'demo-mei', body: { key_dates: { ead_filed_date: '2026-03-01' } } }))
    expect(calledUrl()).toBe(`${BASE}/api/profile/key-dates`)
    expect(calledBody()).toEqual({ key_dates: { ead_filed_date: '2026-03-01' } })
    expect(calledHeaders()['X-User-Id']).toBe('demo-mei')
  })

  it('defaults an absent map to {}', async () => {
    global.fetch = upstream()
    const m = await import('../../profile/key-dates/route')
    await m.POST(req({ uid: 'demo-mei', body: {} }))
    expect(calledBody()).toEqual({ key_dates: {} })
  })

  it('names the profile service in its 503, not the groups service', async () => {
    global.fetch = vi.fn(async () => { throw new Error('down') }) as unknown as typeof fetch
    const m = await import('../../profile/key-dates/route')
    const res = await m.POST(req({ uid: 'demo-mei', body: {} }))
    expect(res.status).toBe(503)
    await expect(res.json()).resolves.toEqual({ detail: 'Unable to reach the profile service.' })
  })
})
