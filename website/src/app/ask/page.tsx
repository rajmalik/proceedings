import { redirect } from 'next/navigation'

// /ask is consolidated into the unified search interface (AI answer +
// results), now at "/" (the Home page).
export default function AskPage() {
  redirect('/')
}
