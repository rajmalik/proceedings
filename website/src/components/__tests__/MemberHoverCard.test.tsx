import { render, screen, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import MemberHoverCard, { type MemberAttributes, type PostJoinRow } from '@/components/MemberHoverCard'

// Hovering a member shows what they submitted for THIS group, out of data the
// group page already fetched. The properties that matter: it costs no request,
// it only appears when there is something to show, and it never leaks another
// member's values.

const ROWS: PostJoinRow[] = [
  { label: 'Date Applied', field: 'key_dates', key: 'ead_filed_date' },
  { label: 'Status', field: 'key_stages_or_info', key: 'application_status' },
  { label: 'Date Approved', field: 'key_dates', key: 'ead_approved_date' },
]

const ATTRS: MemberAttributes = {
  user_id: 'demo-mei', username: 'mei-f1', processing_type: 'stem-opt-extension',
  values: { ead_filed_date: '2026-03-01', application_status: 'pending' },
  notes: 'filed early', submitted_at: '', updated_at: '',
}

function mount(attrs: MemberAttributes | undefined = ATTRS, rows: PostJoinRow[] = ROWS) {
  return render(
    <MemberHoverCard attrs={attrs} rows={rows}>
      <button>mei-f1</button>
    </MemberHoverCard>,
  )
}

const card = () => screen.queryByTestId('member-hover-card')

beforeEach(() => {
  global.fetch = vi.fn(() => { throw new Error('hovering must not fetch') }) as unknown as typeof fetch
})

describe('MemberHoverCard — visibility', () => {
  it('renders the wrapped row and no card until hovered', () => {
    mount()
    expect(screen.getByText('mei-f1')).toBeInTheDocument()
    expect(card()).toBeNull()
  })

  it('shows the card on hover and hides it again on leave', () => {
    const { container } = mount()
    const wrapper = container.firstChild as HTMLElement
    fireEvent.mouseEnter(wrapper)
    expect(card()).toBeInTheDocument()
    fireEvent.mouseLeave(wrapper)
    expect(card()).toBeNull()
  })

  it('also opens on focus, so the card is not pointer-only', () => {
    const { container } = mount()
    const wrapper = container.firstChild as HTMLElement
    fireEvent.focus(wrapper)
    expect(card()).toBeInTheDocument()
    fireEvent.blur(wrapper)
    expect(card()).toBeNull()
  })

  it('costs no network request', () => {
    // The data is handed down from the group page's single /attributes fetch.
    const { container } = mount()
    fireEvent.mouseEnter(container.firstChild as HTMLElement)
    expect(global.fetch).not.toHaveBeenCalled()
  })
})

describe('MemberHoverCard — content', () => {
  function hover(attrs: MemberAttributes | undefined = ATTRS, rows: PostJoinRow[] = ROWS) {
    const { container } = mount(attrs, rows)
    fireEvent.mouseEnter(container.firstChild as HTMLElement)
    return container
  }

  it('labels the card with the processing type', () => {
    hover()
    expect(within(card()!).getByText('stem-opt-extension')).toBeInTheDocument()
  })

  it('shows only the rows the member actually filled in', () => {
    hover()
    const panel = card()!
    expect(within(panel).getByText(/Date Applied/)).toBeInTheDocument()
    expect(within(panel).getByText(/2026-03-01/)).toBeInTheDocument()
    // ead_approved_date is in the template but empty for this member — a blank
    // row would read as "approved on: nothing".
    expect(within(panel).queryByText(/Date Approved/)).toBeNull()
  })

  it('shows the notes when present', () => {
    hover()
    expect(within(card()!).getByText(/filed early/)).toBeInTheDocument()
  })

  it('renders a member who submitted values but no notes', () => {
    hover({ ...ATTRS, notes: '' })
    const panel = card()!
    expect(within(panel).getByText(/2026-03-01/)).toBeInTheDocument()
    expect(within(panel).queryByText(/filed early/)).toBeNull()
  })

  it('renders a member with notes but no values', () => {
    hover({ ...ATTRS, values: {} })
    expect(within(card()!).getByText(/filed early/)).toBeInTheDocument()
  })
})

describe('MemberHoverCard — nothing to show', () => {
  it('stays closed for a member who has submitted nothing at all', () => {
    // Rendered directly rather than via mount(): a default parameter fires on
    // `undefined`, so the helper cannot express "no attrs prop".
    const { container } = render(
      <MemberHoverCard rows={ROWS}><button>omar-b1b2</button></MemberHoverCard>,
    )
    fireEvent.mouseEnter(container.firstChild as HTMLElement)
    // An empty popover on hover is worse than no popover.
    expect(card()).toBeNull()
  })

  it('stays closed when the member has an empty record — no values, no notes', () => {
    const { container } = mount({ ...ATTRS, values: {}, notes: '' })
    fireEvent.mouseEnter(container.firstChild as HTMLElement)
    expect(card()).toBeNull()
  })

  it('stays closed when the values do not match any template row', () => {
    // A stale key from a retired template must not open a blank card.
    const { container } = mount({ ...ATTRS, values: { retired_key: 'x' }, notes: '' })
    fireEvent.mouseEnter(container.firstChild as HTMLElement)
    expect(card()).toBeNull()
  })

  it('stays closed when the template has no rows', () => {
    const { container } = mount({ ...ATTRS, notes: '' }, [])
    fireEvent.mouseEnter(container.firstChild as HTMLElement)
    expect(card()).toBeNull()
  })
})
