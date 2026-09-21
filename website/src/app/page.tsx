import { Suspense } from 'react'
import UnifiedSearch from '@/components/UnifiedSearch'

// "/" is now the Home page: search-first (Search ⇄ AI Mode), recent results
// shown by default. Previously a separate marketing landing page — see
// components/archived/LandingPage.tsx (reserved for a future "What We Do"
// page) — and previously at /search, which now redirects here. Suspense is
// required because UnifiedSearch reads ?q=&mode=.
export default function HomePage() {
  return (
    <Suspense fallback={<div className="max-w-3xl mx-auto px-4 py-8 text-on-surface-variant">Loading…</div>}>
      <UnifiedSearch />
    </Suspense>
  )
}
