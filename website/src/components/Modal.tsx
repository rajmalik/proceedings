'use client'

import { useEffect, useRef } from 'react'

/**
 * The first modal in this codebase — there was no dialog, portal, or UI
 * library to reuse (the only prior overlay was TopAppBar's dropdown). Kept
 * deliberately small: scrim, Escape, click-outside, and a focus trap, using
 * the native <dialog>-less approach the rest of the app's styling assumes.
 *
 * Renders inline rather than through a portal — the app has no portal root,
 * and a `fixed inset-0` overlay escapes its stacking context anyway.
 */
export default function Modal({
  open, onClose, title, children,
}: {
  open: boolean
  onClose: () => void
  title: string
  children: React.ReactNode
}) {
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { onClose(); return }
      if (e.key !== 'Tab') return
      // Focus trap: keep Tab inside the panel while it's open.
      const focusable = panelRef.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])'
      )
      if (!focusable?.length) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', onKey)
    // Don't let the page behind scroll while the modal owns the viewport.
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    panelRef.current?.focus()
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
    }
  }, [open, onClose])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-on-surface/40 p-4 sm:items-center"
      onClick={onClose}
      data-testid="modal-scrim"
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-2xl bg-surface-container-lowest border border-outline-variant rounded-xl shadow-lg my-8 focus:outline-none"
      >
        <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-outline-variant">
          <h2 className="text-label-md font-semibold text-on-surface">{title}</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-on-surface-variant hover:text-primary inline-flex items-center"
          >
            <span className="material-symbols-outlined text-[20px]">close</span>
          </button>
        </div>
        <div className="p-4">{children}</div>
      </div>
    </div>
  )
}
