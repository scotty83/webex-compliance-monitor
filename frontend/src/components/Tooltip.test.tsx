import { render } from '@testing-library/react'
import { Tooltip } from './Tooltip'

/** The tooltip is the only aria-hidden node these tests render. */
const getTip = () => document.body.querySelector<HTMLElement>('[aria-hidden="true"]')

// ── Visibility ────────────────────────────────────────────────────────────────

describe('Tooltip — visibility', () => {
  it('renders nothing when text is null', () => {
    render(<Tooltip text={null} x={10} y={10} />)
    expect(getTip()).toBeNull()
  })

  it('renders nothing when text is empty', () => {
    render(<Tooltip text="" x={10} y={10} />)
    expect(getTip()).toBeNull()
  })

  it('renders the text when non-empty', () => {
    render(<Tooltip text="Jordan Rivera" x={10} y={10} />)
    expect(getTip()).toHaveTextContent('Jordan Rivera')
  })
})

// ── Portal + a11y ─────────────────────────────────────────────────────────────

describe('Tooltip — portal', () => {
  it('renders as a direct child of document.body, outside the React container', () => {
    const { container } = render(<Tooltip text="Alice" x={10} y={10} />)
    const tip = getTip()
    expect(tip).not.toBeNull()
    expect(tip!.parentElement).toBe(document.body)
    expect(container.contains(tip)).toBe(false)
  })

  it('is aria-hidden (duplicates existing accessible names)', () => {
    render(<Tooltip text="Alice" x={10} y={10} />)
    expect(getTip()!.getAttribute('aria-hidden')).toBe('true')
  })

  it('sits on the tooltip z-layer with position: fixed', () => {
    render(<Tooltip text="Alice" x={10} y={10} />)
    const tip = getTip()!
    expect(tip.style.position).toBe('fixed')
    expect(tip.style.zIndex).toBe('var(--z-tooltip)')
  })
})

// ── Mouse-follow positioning ──────────────────────────────────────────────────

describe('Tooltip — positioning', () => {
  it('positions at cursor + (12, 14) offset', () => {
    render(<Tooltip text="Alice" x={100} y={200} />)
    const tip = getTip()!
    expect(tip.style.left).toBe('112px')
    expect(tip.style.top).toBe('214px')
  })

  it('updates position when coordinates change', () => {
    const { rerender } = render(<Tooltip text="Alice" x={100} y={200} />)
    rerender(<Tooltip text="Alice" x={300} y={400} />)
    const tip = getTip()!
    expect(tip.style.left).toBe('312px')
    expect(tip.style.top).toBe('414px')
  })

  it('clamps to the right/bottom viewport edges', () => {
    render(<Tooltip text="Alice" x={window.innerWidth + 500} y={window.innerHeight + 500} />)
    const tip = getTip()!
    expect(parseFloat(tip.style.left)).toBeLessThanOrEqual(window.innerWidth)
    expect(parseFloat(tip.style.top)).toBeLessThanOrEqual(window.innerHeight)
  })

  it('never goes past the top/left viewport edges', () => {
    render(<Tooltip text="Alice" x={-500} y={-500} />)
    const tip = getTip()!
    expect(tip.style.left).toBe('0px')
    expect(tip.style.top).toBe('0px')
  })
})

// ── Multi-line content ────────────────────────────────────────────────────────

describe('Tooltip — multi-line', () => {
  it('renders newline-separated names one per line', () => {
    render(<Tooltip text={'Alice Brown\nBob Chen'} x={10} y={10} />)
    const tip = getTip()!
    expect(tip.textContent).toBe('Alice Brown\nBob Chen')
    expect(tip.style.whiteSpace).toBe('pre-line')
  })
})
