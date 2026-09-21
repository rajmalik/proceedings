import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import Modal from '@/components/Modal'

// The first modal in the codebase — there was no dialog/portal/library to
// inherit correct behaviour from, so every affordance here is hand-rolled and
// worth pinning: dismissal, what must NOT dismiss, the focus trap, and the
// body-scroll lock (which leaks a stuck page if the cleanup is ever dropped).

function open(props: Partial<React.ComponentProps<typeof Modal>> = {}) {
  const onClose = vi.fn()
  const utils = render(
    <Modal open onClose={onClose} title="Member profile" {...props}>
      <button>inside-first</button>
      <button>inside-last</button>
    </Modal>,
  )
  return { onClose, ...utils }
}

beforeEach(() => { document.body.style.overflow = '' })

describe('Modal — rendering', () => {
  it('renders nothing at all when closed', () => {
    const onClose = vi.fn()
    render(<Modal open={false} onClose={onClose} title="Member profile"><p>body</p></Modal>)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByText('body')).toBeNull()
  })

  it('renders a labelled modal dialog with its children when open', () => {
    open()
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(dialog).toHaveAttribute('aria-label', 'Member profile')
    expect(screen.getByText('Member profile')).toBeInTheDocument()
    expect(screen.getByText('inside-first')).toBeInTheDocument()
  })
})

describe('Modal — dismissal', () => {
  it('closes on Escape', () => {
    const { onClose } = open()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes on a scrim click', () => {
    const { onClose } = open()
    fireEvent.click(screen.getByTestId('modal-scrim'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes from the X button', () => {
    const { onClose } = open()
    fireEvent.click(screen.getByLabelText('Close'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('does NOT close when the panel itself is clicked', () => {
    // The scrim's onClick sits on an ancestor; without stopPropagation every
    // click inside the modal would dismiss it.
    const { onClose } = open()
    fireEvent.click(screen.getByRole('dialog'))
    expect(onClose).not.toHaveBeenCalled()
  })

  it('does NOT close when content inside the panel is clicked', () => {
    const { onClose } = open()
    fireEvent.click(screen.getByText('inside-first'))
    expect(onClose).not.toHaveBeenCalled()
  })

  it('ignores keys that are not Escape', () => {
    const { onClose } = open()
    fireEvent.keyDown(document, { key: 'a' })
    fireEvent.keyDown(document, { key: 'Enter' })
    expect(onClose).not.toHaveBeenCalled()
  })

  it('stops listening for Escape once closed', () => {
    // A listener surviving unmount would close the NEXT modal too.
    const onClose = vi.fn()
    const { rerender } = render(
      <Modal open onClose={onClose} title="t"><p>body</p></Modal>,
    )
    rerender(<Modal open={false} onClose={onClose} title="t"><p>body</p></Modal>)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
  })
})

describe('Modal — focus trap', () => {
  it('focuses the panel on open so keyboard input starts inside', () => {
    open()
    expect(document.activeElement).toBe(screen.getByRole('dialog'))
  })

  it('wraps Tab from the last focusable back to the first', () => {
    open()
    const close = screen.getByLabelText('Close')
    const last = screen.getByText('inside-last')
    last.focus()
    fireEvent.keyDown(document, { key: 'Tab' })
    // The X button is the first focusable in DOM order (header precedes body).
    expect(document.activeElement).toBe(close)
  })

  it('wraps Shift+Tab from the first focusable back to the last', () => {
    open()
    const close = screen.getByLabelText('Close')
    close.focus()
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(screen.getByText('inside-last'))
  })

  it('leaves Tab alone in the middle of the sequence', () => {
    // Only the two ends are intercepted; the browser handles the rest.
    open()
    const first = screen.getByText('inside-first')
    first.focus()
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(document.activeElement).toBe(first)
  })

  it('does not crash when the modal has nothing focusable', () => {
    const onClose = vi.fn()
    render(<Modal open onClose={onClose} title="t"><p>just text</p></Modal>)
    expect(() => fireEvent.keyDown(document, { key: 'Tab' })).not.toThrow()
  })
})

describe('Modal — body scroll lock', () => {
  it('locks page scroll while open', () => {
    open()
    expect(document.body.style.overflow).toBe('hidden')
  })

  it('restores the previous overflow on close, rather than clearing it', () => {
    // Blindly setting '' would clobber a lock some other component owns.
    document.body.style.overflow = 'scroll'
    const onClose = vi.fn()
    const { rerender } = render(
      <Modal open onClose={onClose} title="t"><p>body</p></Modal>,
    )
    expect(document.body.style.overflow).toBe('hidden')
    rerender(<Modal open={false} onClose={onClose} title="t"><p>body</p></Modal>)
    expect(document.body.style.overflow).toBe('scroll')
  })

  it('restores scroll on unmount, not just on the open prop flipping', () => {
    const onClose = vi.fn()
    const { unmount } = render(
      <Modal open onClose={onClose} title="t"><p>body</p></Modal>,
    )
    unmount()
    expect(document.body.style.overflow).toBe('')
  })
})
