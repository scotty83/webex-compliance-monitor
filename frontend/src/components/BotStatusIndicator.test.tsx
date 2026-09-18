import { render, screen } from '@testing-library/react'
import { BotStatusIndicator } from './BotStatusIndicator'
import type { BotState } from '../types'

// ── helpers ───────────────────────────────────────────────────────────────────

function mockMatchMedia(matches: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn((query: string) => ({
      matches: query === '(prefers-reduced-motion: reduce)' ? matches : false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  })
}

beforeEach(() => {
  mockMatchMedia(false)
})

// ── 6-state non-color contract ────────────────────────────────────────────────

const STATE_LABELS: Record<BotState, string> = {
  connected: 'Connected',
  dialing: 'Dialing',
  disconnected: 'Disconnected',
  failed: 'Failed',
  idle: 'Idle',
  ended: 'Ended',
}

describe('BotStatusIndicator — per-state', () => {
  for (const [state, expectedLabel] of Object.entries(STATE_LABELS) as [BotState, string][]) {
    it(`${state}: aria-label contains "${expectedLabel}"`, () => {
      render(<BotStatusIndicator state={state} />)
      const indicator = screen.getByRole('status')
      expect(indicator).toHaveAttribute('aria-label', expectedLabel)
    })

    it(`${state}: renders a distinct glyph with data-state="${state}"`, () => {
      const { container } = render(<BotStatusIndicator state={state} />)
      const glyph = container.querySelector(`[data-state="${state}"]`)
      expect(glyph).not.toBeNull()
    })

    it(`${state}: label text is visible by default`, () => {
      render(<BotStatusIndicator state={state} />)
      expect(screen.getByText(expectedLabel)).toBeInTheDocument()
    })
  }
})

// ── prefix composition ────────────────────────────────────────────────────────

describe('prefix', () => {
  it('composes prefix + label into aria-label', () => {
    render(<BotStatusIndicator state="connected" prefix="Bot " />)
    expect(screen.getByRole('status')).toHaveAttribute('aria-label', 'Bot connected')
  })

  it('visible label text also includes prefix', () => {
    render(<BotStatusIndicator state="connected" prefix="Bot " />)
    expect(screen.getByText('Bot connected')).toBeInTheDocument()
  })
})

// ── showLabel=false ───────────────────────────────────────────────────────────

describe('showLabel=false', () => {
  it('aria-label still present', () => {
    render(<BotStatusIndicator state="failed" showLabel={false} />)
    expect(screen.getByRole('status')).toHaveAttribute('aria-label', 'Failed')
  })

  it('label text is in a .sr-only span (not visually shown)', () => {
    const { container } = render(<BotStatusIndicator state="failed" showLabel={false} />)
    const srOnly = container.querySelector('.sr-only')
    expect(srOnly).not.toBeNull()
    expect(srOnly?.textContent).toBe('Failed')
  })
})

// ── fail-LOUD prominence ──────────────────────────────────────────────────────

describe('fail-LOUD prominence', () => {
  const failLoudStates: BotState[] = ['disconnected', 'failed']
  const quietStates: BotState[] = ['connected', 'dialing', 'idle', 'ended']

  for (const state of failLoudStates) {
    it(`${state}: glyph carries data-fail-loud="true"`, () => {
      const { container } = render(<BotStatusIndicator state={state} />)
      const glyph = container.querySelector(`[data-state="${state}"]`)
      expect(glyph).toHaveAttribute('data-fail-loud', 'true')
    })
  }

  for (const state of quietStates) {
    it(`${state}: glyph does NOT carry data-fail-loud`, () => {
      const { container } = render(<BotStatusIndicator state={state} />)
      const glyph = container.querySelector(`[data-state="${state}"]`)
      expect(glyph).not.toHaveAttribute('data-fail-loud', 'true')
    })
  }
})

// ── reduced-motion: dialing spinner is static ────────────────────────────────

describe('reduced-motion', () => {
  it('dialing spinner has animation:none under prefers-reduced-motion', () => {
    mockMatchMedia(true)
    const { container } = render(<BotStatusIndicator state="dialing" />)
    const glyph = container.querySelector('[data-state="dialing"]') as HTMLElement | null
    expect(glyph).not.toBeNull()
    expect(glyph?.style.animation).toBe('none')
  })

  it('dialing spinner has spin animation when reduced-motion is off', () => {
    mockMatchMedia(false)
    const { container } = render(<BotStatusIndicator state="dialing" />)
    const glyph = container.querySelector('[data-state="dialing"]') as HTMLElement | null
    expect(glyph?.style.animation).toMatch(/spin/)
  })
})
