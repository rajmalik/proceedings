'use client'

import { useEffect } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useAuth } from '@/contexts/AuthContext'
import { DEMO_PICKER_ENABLED } from '@/lib/activeUser'

/**
 * Only a path on THIS origin is an acceptable post-login destination.
 *
 * `//evil.com` and `/\evil.com` are both protocol-relative URLs that browsers
 * resolve to another host, so "starts with /" is not sufficient on its own —
 * without the second character check this is a textbook open redirect, and the
 * value comes straight off the query string.
 */
export function safeReturnPath(next: string | null | undefined): string | null {
  if (!next || !next.startsWith('/')) return null
  if (next.startsWith('//') || next.startsWith('/\\')) return null
  return next
}

/** Where an unauthenticated visitor should be sent, preserving where they were headed. */
export function loginHref(pathname: string, search = ''): string {
  const dest = `${pathname}${search}`
  return dest && dest !== '/' ? `/login?next=${encodeURIComponent(dest)}` : '/login'
}

/**
 * Route guard for pages that require an identity. In **production** it redirects
 * to `/login` once auth settles if there's no Firebase session — carrying the
 * current path as `?next=` so a shared link (e.g. a group invite) survives the
 * detour and lands the recipient where they were actually going. In **dev/test**
 * it's a no-op: the demo-user picker supplies identity there
 * (DEMO_PICKER_ENABLED), so guarding would fight the picker's timing and break
 * the suites. Pages must therefore still handle "no identity yet" themselves —
 * see the group page's needsIdentity branch.
 */
export function useRequireUser(): void {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const { user, loading } = useAuth()
  useEffect(() => {
    if (DEMO_PICKER_ENABLED || loading) return
    if (!user) {
      const qs = searchParams?.toString()
      router.replace(loginHref(pathname || '/', qs ? `?${qs}` : ''))
    }
  }, [user, loading, router, pathname, searchParams])
}
