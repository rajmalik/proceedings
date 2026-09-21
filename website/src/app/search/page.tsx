import { redirect } from 'next/navigation'

// Search moved to "/" (the new Home page). Kept as a redirect, not deleted,
// so old bookmarked/shared /search links keep working — including any
// ?q=&mode= they carried, which UnifiedSearch reads from the URL.
export default async function SearchPageRedirect({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const params = await searchParams
  const qs = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'string') qs.set(key, value)
    else if (Array.isArray(value)) value.forEach((v) => qs.append(key, v))
  }
  const suffix = qs.toString()
  redirect(suffix ? `/?${suffix}` : '/')
}
