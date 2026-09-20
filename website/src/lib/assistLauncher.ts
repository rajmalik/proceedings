// The AI-Assist chatbot is a single global component (rendered once in the root
// layout, bottom-right). Its collapsed launcher lives bottom-right on every page
// EXCEPT the Home page, where the launcher instead sits inline in the search row
// (UnifiedSearch). To open the one global panel from that inline button — a
// different component — we use a lightweight window event instead of lifting the
// open state into a shared context/provider.
export const ASSIST_OPEN_EVENT = 'aiassist:open'

export function openAssist(): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(ASSIST_OPEN_EVENT))
  }
}
