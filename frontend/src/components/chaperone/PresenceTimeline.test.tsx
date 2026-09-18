import { render, screen } from '@testing-library/react'
import {
  PresenceTimeline,
  computeWindow,
  barGeometry,
  tickStepMs,
  tickTimes,
  positionPct,
  MIN_BAR_WIDTH_PCT,
} from './PresenceTimeline'
import { TimeFormatProvider } from '../../settings/timeFormat'
import type { Attendee } from '../../types'

const MIN = 60_000

// ── matchMedia mock (same pattern as BotStatusIndicator.test) ─────────────────

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

afterEach(() => {
  localStorage.clear()
})

// ── Pure math: computeWindow ──────────────────────────────────────────────────

describe('computeWindow', () => {
  const att = (joinedAt: number): Attendee => ({
    id: `a${joinedAt}`,
    name: 'X',
    role: 'analyst',
    isHost: false,
    joinedAt,
    leftAt: null,
  })

  it('starts at startedAt when every attendee joined after it', () => {
    expect(computeWindow(100, [att(200), att(300)], 900)).toEqual({
      windowStart: 100,
      windowEnd: 900,
    })
  })

  it('starts at the earliest joinedAt when someone joined before startedAt', () => {
    expect(computeWindow(100, [att(40), att(300)], 900)).toEqual({
      windowStart: 40,
      windowEnd: 900,
    })
  })

  it('falls back to startedAt for an empty roster', () => {
    expect(computeWindow(100, [], 900)).toEqual({ windowStart: 100, windowEnd: 900 })
  })
})

// ── Pure math: barGeometry ────────────────────────────────────────────────────

describe('barGeometry', () => {
  const win = { windowStart: 0, windowEnd: 60 * MIN }

  it('positions a departed bar joinedAt → leftAt', () => {
    expect(barGeometry(15 * MIN, 45 * MIN, win)).toEqual({ leftPct: 25, widthPct: 50 })
  })

  it('runs an active bar (leftAt null) joinedAt → windowEnd', () => {
    expect(barGeometry(15 * MIN, null, win)).toEqual({ leftPct: 25, widthPct: 75 })
  })

  it('clamps joinedAt before windowStart to left 0', () => {
    expect(barGeometry(-10 * MIN, 30 * MIN, win)).toEqual({ leftPct: 0, widthPct: 50 })
  })

  it('clamps leftAt after windowEnd to the window edge', () => {
    expect(barGeometry(30 * MIN, 90 * MIN, win)).toEqual({ leftPct: 50, widthPct: 50 })
  })

  it('enforces the minimum visible width on a zero-duration presence', () => {
    expect(barGeometry(30 * MIN, 30 * MIN, win)).toEqual({
      leftPct: 50,
      widthPct: MIN_BAR_WIDTH_PCT,
    })
  })

  it('keeps left + width within 100% when the join is at the window edge', () => {
    const { leftPct, widthPct } = barGeometry(60 * MIN, null, win)
    expect(widthPct).toBe(MIN_BAR_WIDTH_PCT)
    expect(leftPct + widthPct).toBeLessThanOrEqual(100)
  })

  it('degrades safely on a zero-length window', () => {
    expect(barGeometry(0, null, { windowStart: 0, windowEnd: 0 })).toEqual({
      leftPct: 0,
      widthPct: MIN_BAR_WIDTH_PCT,
    })
  })
})

// ── Pure math: tickStepMs (plan-mandated thresholds) ──────────────────────────

describe('tickStepMs', () => {
  it('uses 4m steps for spans up to 16m (inclusive)', () => {
    expect(tickStepMs(10 * MIN)).toBe(4 * MIN)
    expect(tickStepMs(16 * MIN)).toBe(4 * MIN)
  })

  it('uses 8m steps for spans over 16m up to 40m (inclusive)', () => {
    expect(tickStepMs(16 * MIN + 1)).toBe(8 * MIN)
    expect(tickStepMs(40 * MIN)).toBe(8 * MIN)
  })

  it('uses 15m steps for spans over 40m', () => {
    expect(tickStepMs(40 * MIN + 1)).toBe(15 * MIN)
    expect(tickStepMs(180 * MIN)).toBe(15 * MIN)
  })
})

// ── Pure math: tickTimes ──────────────────────────────────────────────────────

describe('tickTimes', () => {
  it('starts at windowStart when it is already a step multiple', () => {
    // span 60m → 15m step
    expect(tickTimes({ windowStart: 0, windowEnd: 60 * MIN })).toEqual(
      [0, 15, 30, 45, 60].map((m) => m * MIN),
    )
  })

  it('starts at the first step multiple ≥ windowStart when unaligned', () => {
    // span 28m → 8m step; multiples of 8m ≥ 7m → 8,16,24,32
    expect(tickTimes({ windowStart: 7 * MIN, windowEnd: 35 * MIN })).toEqual(
      [8, 16, 24, 32].map((m) => m * MIN),
    )
  })

  it('uses 4m steps on short windows', () => {
    // span 14m → 4m step
    expect(tickTimes({ windowStart: 16 * MIN, windowEnd: 30 * MIN })).toEqual(
      [16, 20, 24, 28].map((m) => m * MIN),
    )
  })

  it('returns no ticks for a zero-length window', () => {
    expect(tickTimes({ windowStart: 5 * MIN, windowEnd: 5 * MIN })).toEqual([])
  })
})

// ── Pure math: positionPct ────────────────────────────────────────────────────

describe('positionPct', () => {
  const win = { windowStart: 0, windowEnd: 60 * MIN }

  it('maps windowStart → 0% and the midpoint → 50%', () => {
    expect(positionPct(0, win)).toBe(0)
    expect(positionPct(30 * MIN, win)).toBe(50)
  })

  it('clamps timestamps outside the window', () => {
    expect(positionPct(-5 * MIN, win)).toBe(0)
    expect(positionPct(90 * MIN, win)).toBe(100)
  })

  it('returns 0 on a zero-length window', () => {
    expect(positionPct(0, { windowStart: 0, windowEnd: 0 })).toBe(0)
  })
})

// ── Rendering fixtures ────────────────────────────────────────────────────────

// Fixed epoch, quarter-hour aligned in UTC (2024-01-15 14:30:00 UTC)
const NOW_TS = new Date('2024-01-15T14:30:00Z').getTime()
const STARTED_AT = NOW_TS - 55 * MIN

function makeAttendee(opts: Partial<Attendee> & { id: string; name: string }): Attendee {
  return {
    role: 'analyst',
    isHost: false,
    joinedAt: NOW_TS - 30 * MIN,
    leftAt: null,
    ...opts,
  }
}

const priya  = makeAttendee({ id: 'fo1',  name: 'Priya Sharma',    role: 'fo',      isHost: true, joinedAt: NOW_TS - 45 * MIN })
const bot    = makeAttendee({ id: 'bot1', name: 'Compliance Monitor Bot', role: 'bot',     joinedAt: NOW_TS - 40 * MIN })
const alex   = makeAttendee({ id: 'an1',  name: 'Alex Chen',       role: 'analyst', joinedAt: NOW_TS - 30 * MIN })
const sam    = makeAttendee({ id: 'ot1',  name: 'Sam Okafor',      role: 'other',   joinedAt: NOW_TS - 60 * MIN, leftAt: NOW_TS - 10 * MIN })
const jordan = makeAttendee({ id: 'an2',  name: 'Jordan Rivera',   role: 'analyst', joinedAt: NOW_TS - 50 * MIN, leftAt: NOW_TS - 35 * MIN })

// Deliberately shuffled — the component must sort, not rely on input order.
const ROSTER = [alex, jordan, priya, sam, bot]

function renderTimeline(attendees: Attendee[] = ROSTER, startedAt = STARTED_AT) {
  return render(
    <TimeFormatProvider>
      <PresenceTimeline attendees={attendees} startedAt={startedAt} now={NOW_TS} />
    </TimeFormatProvider>,
  )
}

function laneOf(name: string): HTMLElement {
  const lane = screen.getByText(name).closest('[data-lane]')
  if (!(lane instanceof HTMLElement)) throw new Error(`No lane found for ${name}`)
  return lane
}

/** Build expected HH:MM from local clock — keeps assertions timezone-agnostic. */
function expected24h(ts: number): string {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

// ── Header ────────────────────────────────────────────────────────────────────

describe('PresenceTimeline — header', () => {
  it('renders the "Presence timeline" heading', () => {
    renderTimeline()
    expect(screen.getByRole('heading', { name: 'Presence timeline' })).toBeInTheDocument()
  })

  it('shows the rounded window-span label', () => {
    // window = earliest join (sam, −60m) → now
    renderTimeline()
    expect(screen.getByText('60m window')).toBeInTheDocument()
  })

  it('derives the window from startedAt when nobody joined earlier', () => {
    renderTimeline([], NOW_TS - 20 * MIN)
    expect(screen.getByText('20m window')).toBeInTheDocument()
  })
})

// ── A11y model ────────────────────────────────────────────────────────────────

describe('PresenceTimeline — a11y', () => {
  it('exposes the chart as a single img with a summary label', () => {
    renderTimeline()
    expect(
      screen.getByRole('img', { name: 'Presence timeline: 3 on call, 2 left' }),
    ).toBeInTheDocument()
  })

  it('hides bars, dots, and the now-line from assistive tech', () => {
    const { container } = renderTimeline()
    const decorative = container.querySelectorAll('[data-bar], [data-dot], [data-now-line]')
    expect(decorative.length).toBeGreaterThan(0)
    decorative.forEach((el) => expect(el).toHaveAttribute('aria-hidden', 'true'))
  })

  it('keeps attendee names as real text', () => {
    renderTimeline()
    expect(screen.getByText('Priya Sharma')).toBeInTheDocument()
    expect(screen.getByText('Sam Okafor')).toBeInTheDocument()
  })
})

// ── Lanes ─────────────────────────────────────────────────────────────────────

describe('PresenceTimeline — lanes', () => {
  it('orders lanes exactly like AttendeesPanel: active by joinedAt asc, departed by leftAt desc', () => {
    const { container } = renderTimeline()
    const ids = [...container.querySelectorAll('[data-lane]')].map((el) =>
      el.getAttribute('data-lane'),
    )
    expect(ids).toEqual(['fo1', 'bot1', 'an1', 'ot1', 'an2'])
  })

  it('renders one bar per attendee: active green bars, departed muted bars', () => {
    const { container } = renderTimeline()
    const active = container.querySelectorAll('[data-bar="active"]')
    const departed = container.querySelectorAll('[data-bar="departed"]')
    expect(active).toHaveLength(3)
    expect(departed).toHaveLength(2)
    // active = green; departed = --tx3 (readable mid gray, not the near-invisible --s3)
    expect((active[0] as HTMLElement).style.background).toBe('var(--green)')
    expect((departed[0] as HTMLElement).style.background).toBe('var(--tx3)')
  })

  it('positions bars by the joinedAt/leftAt geometry math', () => {
    renderTimeline()
    // priya: joined −45m in a 60m window → left 25%, width 75% (active → now)
    const priyaBar = laneOf('Priya Sharma').querySelector('[data-bar]') as HTMLElement
    expect(parseFloat(priyaBar.style.left)).toBeCloseTo(25)
    expect(parseFloat(priyaBar.style.width)).toBeCloseTo(75)
    // sam: joined −60m, left −10m → left 0%, width 83.33%
    const samBar = laneOf('Sam Okafor').querySelector('[data-bar]') as HTMLElement
    expect(parseFloat(samBar.style.left)).toBeCloseTo(0)
    expect(parseFloat(samBar.style.width)).toBeCloseTo(83.333, 2)
  })

  it('puts a terminal dot on active bars only', () => {
    renderTimeline()
    expect(laneOf('Priya Sharma').querySelector('[data-dot]')).not.toBeNull()
    expect(laneOf('Alex Chen').querySelector('[data-dot]')).not.toBeNull()
    expect(laneOf('Sam Okafor').querySelector('[data-dot]')).toBeNull()
    expect(laneOf('Jordan Rivera').querySelector('[data-dot]')).toBeNull()
  })

  it('tints active avatars by role and dims departed avatars', () => {
    renderTimeline()
    const priyaAvatar = laneOf('Priya Sharma').querySelector('[data-avatar]') as HTMLElement
    expect(priyaAvatar.style.background).toBe('var(--violet-bg)')
    expect(priyaAvatar.style.color).toBe('var(--violet)')
    expect(priyaAvatar.textContent).toBe('PS')

    const samAvatar = laneOf('Sam Okafor').querySelector('[data-avatar]') as HTMLElement
    expect(samAvatar.style.background).toBe('rgba(255, 255, 255, 0.04)') // jsdom-normalized
    expect(samAvatar.style.color).toBe('var(--tx3)')
    expect(samAvatar.textContent).toBe('SO')
  })

  it('renders no lanes or bars for an empty roster without crashing', () => {
    const { container } = renderTimeline([])
    expect(container.querySelectorAll('[data-lane]')).toHaveLength(0)
    expect(container.querySelectorAll('[data-bar]')).toHaveLength(0)
    expect(
      screen.getByRole('img', { name: 'Presence timeline: 0 on call, 0 left' }),
    ).toBeInTheDocument()
  })
})

// ── Now line ──────────────────────────────────────────────────────────────────

describe('PresenceTimeline — now line', () => {
  it('renders a single now-line', () => {
    const { container } = renderTimeline()
    expect(container.querySelectorAll('[data-now-line]')).toHaveLength(1)
  })
})

// ── Axis ticks ────────────────────────────────────────────────────────────────

describe('PresenceTimeline — axis ticks', () => {
  it('renders 15m-step clock ticks across the 60m window at the right positions', () => {
    const { container } = renderTimeline()
    const ticks = [...container.querySelectorAll('[data-tick]')] as HTMLElement[]
    expect(ticks).toHaveLength(5) // 60m span, quarter-aligned window
    const expectedTimes = [0, 15, 30, 45, 60].map((m) => NOW_TS - 60 * MIN + m * MIN)
    expect(ticks.map((t) => t.textContent)).toEqual(expectedTimes.map(expected24h))
    expect(ticks.map((t) => parseFloat(t.style.left))).toEqual([0, 25, 50, 75, 100])
  })

  it('honors the officer 12h time format on tick labels', () => {
    localStorage.setItem('wcms.timeFormat', '12h')
    const { container } = renderTimeline()
    const first = container.querySelector('[data-tick]') as HTMLElement
    expect(first.textContent).toMatch(/(AM|PM)$/)
  })
})

// ── Reduced motion ────────────────────────────────────────────────────────────

describe('PresenceTimeline — reduced motion', () => {
  it('pulses the terminal dot when motion is allowed', () => {
    mockMatchMedia(false)
    const { container } = renderTimeline()
    const dot = container.querySelector('[data-dot]') as HTMLElement
    expect(dot.style.animation).toMatch(/presence-pulse/)
  })

  it('renders a static dot under prefers-reduced-motion', () => {
    mockMatchMedia(true)
    const { container } = renderTimeline()
    const dot = container.querySelector('[data-dot]') as HTMLElement
    expect(dot.style.animation).toBe('none')
  })
})
