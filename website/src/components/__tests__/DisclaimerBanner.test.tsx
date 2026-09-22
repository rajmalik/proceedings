import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import DisclaimerBanner from '@/components/DisclaimerBanner'

describe('DisclaimerBanner', () => {
  it('renders the default copy with no props (legacy page banner)', () => {
    render(<DisclaimerBanner />)
    expect(screen.getByText(/not a lawyer/i)).toBeInTheDocument()
  })

  it('renders custom text + className (AI-answer inline mode)', () => {
    const { container } = render(<DisclaimerBanner text="This is general information, not legal advice." className="my-inline" />)
    expect(screen.getByText('This is general information, not legal advice.')).toBeInTheDocument()
    expect(container.querySelector('.my-inline')).toBeTruthy()
  })
})
