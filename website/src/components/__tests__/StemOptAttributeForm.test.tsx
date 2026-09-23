import { useState } from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import StemOptAttributeForm from '@/components/StemOptAttributeForm'

/**
 * The STEM OPT join/attribute form (Phase 6): the shared structured card
 * adapted to the group page's flat `values` + `onChange(key,value)` contract,
 * plus the paste-your-timeline on-ramp. Scope: stem-opt-extension only.
 */

// A stateful harness so the controlled card reflects onChange, and we can spy
// on exactly which (key, value) pairs the form emits.
function Harness({ onChangeSpy }: { onChangeSpy?: (k: string, v: string) => void }) {
  const [values, setValues] = useState<Record<string, string>>({})
  const [notes, setNotes] = useState('')
  return (
    <StemOptAttributeForm
      values={values}
      onChange={(k, v) => {
        onChangeSpy?.(k, v)
        setValues((prev) => ({ ...prev, [k]: v }))
      }}
      notes={notes}
      onNotesChange={setNotes}
    />
  )
}

describe('StemOptAttributeForm', () => {
  beforeEach(() => {
    global.fetch = vi.fn() as unknown as typeof fetch
  })

  it('renders the structured card, the notes field, and the paste on-ramp', () => {
    render(<Harness />)
    expect(screen.getByTestId('stem-opt-timeline-card')).toBeInTheDocument()
    expect(screen.getByTestId('stem-opt-paste')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Anything else worth sharing with the cohort?')).toBeInTheDocument()
  })

  it('maps a card date edit back to the flat onChange(key, value)', () => {
    const spy = vi.fn()
    render(<Harness onChangeSpy={spy} />)
    fireEvent.change(screen.getByLabelText('Date applied (I-765 filed)'), { target: { value: '2026-03-18' } })
    expect(spy).toHaveBeenCalledWith('ead_filed_date', '2026-03-18')
  })

  it('maps a card checkbox toggle back to onChange with the CHECKBOX_ON value', () => {
    const spy = vi.fn()
    render(<Harness onChangeSpy={spy} />)
    fireEvent.click(screen.getByLabelText('Premium processing'))
    expect(spy).toHaveBeenCalledWith('premium_processing', 'yes')
  })

  it('paste → tag-suggest → prefills only the canonical fields it returns', async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        key_dates: { ead_filed_date: '2026-03-18', ead_approved_date: '2026-09-17' },
        key_stages_or_info: { application_status: 'approved', off_schema_key: 'nope' },
      }),
    })) as unknown as typeof fetch

    const spy = vi.fn()
    render(<Harness onChangeSpy={spy} />)
    fireEvent.change(screen.getByTestId('stem-opt-paste'), {
      target: { value: 'Filed I-765 on 2026-03-18, approved 2026-09-17.' },
    })
    fireEvent.click(screen.getByTestId('stem-opt-extract'))

    await waitFor(() => expect(spy).toHaveBeenCalledWith('ead_filed_date', '2026-03-18'))
    expect(spy).toHaveBeenCalledWith('ead_approved_date', '2026-09-17')
    expect(spy).toHaveBeenCalledWith('application_status', 'approved')
    // an off-schema key from the model is never applied
    expect(spy).not.toHaveBeenCalledWith('off_schema_key', expect.anything())
    expect(screen.getByTestId('stem-opt-paste-msg')).toHaveTextContent('Filled 3 fields')
  })

  it('says so when a pasted timeline yields no recognizable fields', async () => {
    global.fetch = vi.fn(async () => ({
      ok: true, status: 200, json: async () => ({ key_dates: {}, key_stages_or_info: {} }),
    })) as unknown as typeof fetch

    render(<Harness />)
    fireEvent.change(screen.getByTestId('stem-opt-paste'), { target: { value: 'no dates here' } })
    fireEvent.click(screen.getByTestId('stem-opt-extract'))
    await waitFor(() => expect(screen.getByTestId('stem-opt-paste-msg')).toHaveTextContent('No timeline fields found'))
  })

  it('surfaces the server error message when the extract request is not ok', async () => {
    global.fetch = vi.fn(async () => ({
      ok: false, status: 500, json: async () => ({ detail: 'model unavailable' }),
    })) as unknown as typeof fetch

    const spy = vi.fn()
    render(<Harness onChangeSpy={spy} />)
    fireEvent.change(screen.getByTestId('stem-opt-paste'), { target: { value: 'some timeline' } })
    fireEvent.click(screen.getByTestId('stem-opt-extract'))
    await waitFor(() => expect(screen.getByTestId('stem-opt-paste-msg')).toHaveTextContent('model unavailable'))
    // a failed extract never mutates the fields
    expect(spy).not.toHaveBeenCalled()
  })

  it('falls back to a generic message when the extract request throws', async () => {
    global.fetch = vi.fn(async () => {
      throw new Error('network down')
    }) as unknown as typeof fetch

    render(<Harness />)
    fireEvent.change(screen.getByTestId('stem-opt-paste'), { target: { value: 'some timeline' } })
    fireEvent.click(screen.getByTestId('stem-opt-extract'))
    await waitFor(() => expect(screen.getByTestId('stem-opt-paste-msg')).toHaveTextContent('network down'))
  })

  it('reports a single filled field and tolerates a missing key_stages bucket', async () => {
    // Response omits key_stages_or_info entirely → exercises the `|| {}` guard.
    global.fetch = vi.fn(async () => ({
      ok: true, status: 200, json: async () => ({ key_dates: { ead_filed_date: '2026-03-18' } }),
    })) as unknown as typeof fetch

    render(<Harness />)
    fireEvent.change(screen.getByTestId('stem-opt-paste'), { target: { value: 'x' } })
    fireEvent.click(screen.getByTestId('stem-opt-extract'))
    await waitFor(() => expect(screen.getByTestId('stem-opt-paste-msg')).toHaveTextContent(/Filled 1 field —/))
  })

  it('uses the generic fallback when the failed response carries no detail', async () => {
    global.fetch = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })) as unknown as typeof fetch

    render(<Harness />)
    fireEvent.change(screen.getByTestId('stem-opt-paste'), { target: { value: 'x' } })
    fireEvent.click(screen.getByTestId('stem-opt-extract'))
    await waitFor(() => expect(screen.getByTestId('stem-opt-paste-msg')).toHaveTextContent('Could not read that timeline'))
  })

  it('uses the generic fallback when a non-Error value is thrown', async () => {
    // eslint-disable-next-line @typescript-eslint/no-throw-literal
    global.fetch = vi.fn(async () => { throw 'weird' }) as unknown as typeof fetch

    render(<Harness />)
    fireEvent.change(screen.getByTestId('stem-opt-paste'), { target: { value: 'x' } })
    fireEvent.click(screen.getByTestId('stem-opt-extract'))
    await waitFor(() => expect(screen.getByTestId('stem-opt-paste-msg')).toHaveTextContent('Could not read that timeline'))
  })

  it('disables the extract button until something is pasted', () => {
    render(<Harness />)
    expect(screen.getByTestId('stem-opt-extract')).toBeDisabled()
    fireEvent.change(screen.getByTestId('stem-opt-paste'), { target: { value: 'x' } })
    expect(screen.getByTestId('stem-opt-extract')).not.toBeDisabled()
  })
})
