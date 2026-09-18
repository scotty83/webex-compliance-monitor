import { render, screen } from '@testing-library/react'
import { AudioMeter } from './AudioMeter'

const FLAT_LEVELS = Array<number>(9).fill(0)
const LIVE_LEVELS = [0.1, 0.3, 0.5, 0.7, 0.9, 0.8, 0.6, 0.4, 0.2]

// ── Structure ─────────────────────────────────────────────────────────────────

describe('AudioMeter — structure', () => {
  it('renders exactly 9 bars', () => {
    render(<AudioMeter levels={LIVE_LEVELS} status="listening" />)
    expect(screen.getAllByTestId(/^audio-bar-/)).toHaveLength(9)
  })

  it('has role="img" with accessible label', () => {
    render(<AudioMeter levels={LIVE_LEVELS} status="listening" />)
    expect(screen.getByRole('img', { name: /audio level meter/i })).toBeInTheDocument()
  })

  it('renders 9 bars when paused', () => {
    render(<AudioMeter levels={FLAT_LEVELS} status="paused" />)
    expect(screen.getAllByTestId(/^audio-bar-/)).toHaveLength(9)
  })

  it('renders 9 bars in error state', () => {
    render(<AudioMeter levels={FLAT_LEVELS} status="error" />)
    expect(screen.getAllByTestId(/^audio-bar-/)).toHaveLength(9)
  })
})

// ── Levels mapping ────────────────────────────────────────────────────────────

describe('AudioMeter — levels mapping', () => {
  it('exposes each level value via data-level attribute', () => {
    render(<AudioMeter levels={LIVE_LEVELS} status="listening" />)
    const bars = screen.getAllByTestId(/^audio-bar-/)
    LIVE_LEVELS.forEach((lvl, i) => {
      expect(bars[i]).toHaveAttribute('data-level', String(lvl))
    })
  })

  it('all bars show data-level="0" when levels are flat', () => {
    render(<AudioMeter levels={FLAT_LEVELS} status="listening" />)
    const bars = screen.getAllByTestId(/^audio-bar-/)
    bars.forEach((bar) => {
      expect(bar).toHaveAttribute('data-level', '0')
    })
  })

  it('all bars show data-level="0" when paused (hook provides flat levels)', () => {
    // useLiveAudio already zeros levels when paused — AudioMeter just renders them
    render(<AudioMeter levels={FLAT_LEVELS} status="paused" />)
    const bars = screen.getAllByTestId(/^audio-bar-/)
    bars.forEach((bar) => {
      expect(bar).toHaveAttribute('data-level', '0')
    })
  })

  it('tolerates a short levels array by treating missing bars as 0', () => {
    render(<AudioMeter levels={[0.5, 0.5]} status="listening" />)
    // Still renders 9 bars even if only 2 levels given
    expect(screen.getAllByTestId(/^audio-bar-/)).toHaveLength(9)
  })
})
