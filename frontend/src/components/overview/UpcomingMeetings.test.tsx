// RED → GREEN: UpcomingMeetings section tests.
// The hook is mocked so the component's render logic is tested in isolation.

vi.mock('../../hooks/useUpcomingMeetings', () => ({
  useUpcomingMeetings: vi.fn(),
}))

import { render, screen, within } from '@testing-library/react'
import { UpcomingMeetings, formatCountdown } from './UpcomingMeetings'
import { useUpcomingMeetings } from '../../hooks/useUpcomingMeetings'
import { TimeFormatProvider } from '../../settings/timeFormat'
import type { UpcomingMeeting } from '../../types'

const mockUseUpcoming = vi.mocked(useUpcomingMeetings)

const MIN = 60_000
// Fixed epoch for deterministic tests (2024-01-15 14:30:00 UTC)
const NOW = new Date('2024-01-15T14:30:00Z').getTime()

function up(id: string, startInMin: number, title?: string): UpcomingMeeting {
  return {
    meetingId: id,
    title: title ?? `Upcoming ${id}`,
    scheduledStart: NOW + startInMin * MIN,
  }
}

function mockState(
  state: Partial<{ meetings: UpcomingMeeting[]; loading: boolean; error: Error | null }> = {},
) {
  mockUseUpcoming.mockReturnValue({
    meetings: [],
    loading: false,
    error: null,
    ...state,
  })
}

function renderSection() {
  return render(
    <TimeFormatProvider>
      <UpcomingMeetings now={NOW} />
    </TimeFormatProvider>,
  )
}

/** Expected 24h wall-clock string, computed from local time (timezone-agnostic). */
function expected24(ts: number): string {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

beforeEach(() => {
  localStorage.removeItem('wcms.timeFormat') // default 24h
  mockState()
})

// ── Pure countdown helper ─────────────────────────────────────────────────────

describe('formatCountdown', () => {
  it('"starting now" when scheduledStart is in the past — never negative', () => {
    expect(formatCountdown(NOW, NOW - 5 * MIN)).toBe('starting now')
    expect(formatCountdown(NOW, NOW - 1)).toBe('starting now')
  })

  it('"starting now" at exactly the scheduled start', () => {
    expect(formatCountdown(NOW, NOW)).toBe('starting now')
  })

  it('rounds sub-minute remainders up: 30 s out → "in 1m"', () => {
    expect(formatCountdown(NOW, NOW + 30_000)).toBe('in 1m')
  })

  it('"in Nm" under an hour', () => {
    expect(formatCountdown(NOW, NOW + 10 * MIN)).toBe('in 10m')
    expect(formatCountdown(NOW, NOW + 59 * MIN)).toBe('in 59m')
  })

  it('"in Hh" for exact hours', () => {
    expect(formatCountdown(NOW, NOW + 60 * MIN)).toBe('in 1h')
  })

  it('"in Hh Mm" for hours + remainder', () => {
    expect(formatCountdown(NOW, NOW + 90 * MIN)).toBe('in 1h 30m')
    expect(formatCountdown(NOW, NOW + 150 * MIN)).toBe('in 2h 30m')
  })
})

// ── Hidden states — the section renders NOTHING ───────────────────────────────

describe('UpcomingMeetings — hidden states', () => {
  it('renders nothing when there are no upcoming meetings', () => {
    mockState({ meetings: [] })
    const { container } = renderSection()
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing while loading (first load — no skeleton for this surface)', () => {
    mockState({ meetings: [], loading: true })
    const { container } = renderSection()
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing on error with no data', () => {
    mockState({ meetings: [], error: new Error('boom') })
    const { container } = renderSection()
    expect(container.firstChild).toBeNull()
  })

  it('keeps rendering last-good rows on a poll error WITH data', () => {
    mockState({ meetings: [up('u1', 10)], error: new Error('poll blip') })
    renderSection()
    expect(screen.getByText('Upcoming u1')).toBeInTheDocument()
  })
})

// ── Structure & a11y ──────────────────────────────────────────────────────────

describe('UpcomingMeetings — structure & a11y', () => {
  it('renders a labelled region named "Upcoming meetings"', () => {
    mockState({ meetings: [up('u1', 10)] })
    renderSection()
    expect(screen.getByRole('region', { name: 'Upcoming meetings' })).toBeInTheDocument()
  })

  it('renders a heading and list semantics with one listitem per meeting', () => {
    mockState({ meetings: [up('u1', 10), up('u2', 45), up('u3', 150)] })
    renderSection()
    expect(screen.getByRole('heading', { name: 'Upcoming meetings' })).toBeInTheDocument()
    const list = screen.getByRole('list')
    expect(within(list).getAllByRole('listitem')).toHaveLength(3)
  })

  it('rows are informational — no join/register buttons or links', () => {
    mockState({ meetings: [up('u1', 10), up('u2', 45)] })
    renderSection()
    const region = screen.getByRole('region', { name: 'Upcoming meetings' })
    expect(within(region).queryAllByRole('button')).toHaveLength(0)
    expect(within(region).queryAllByRole('link')).toHaveLength(0)
  })
})

// ── Rows: sort, countdown, time format ────────────────────────────────────────

describe('UpcomingMeetings — rows', () => {
  it('sorts rows by scheduledStart ascending regardless of input order', () => {
    mockState({
      meetings: [up('u45', 45, 'Third'), up('u10', 10, 'Second'), up('uPast', -5, 'First')],
    })
    renderSection()
    const items = screen.getAllByRole('listitem')
    expect(items.map((li) => within(li).getByText(/First|Second|Third/).textContent)).toEqual([
      'First',
      'Second',
      'Third',
    ])
  })

  it('shows countdown chips as real text: "in 10m", "in 2h 30m"', () => {
    mockState({ meetings: [up('u1', 10), up('u2', 150)] })
    renderSection()
    expect(screen.getByText('in 10m')).toBeInTheDocument()
    expect(screen.getByText('in 2h 30m')).toBeInTheDocument()
  })

  it('shows "starting now" for a meeting past its scheduledStart but not yet tracked', () => {
    mockState({ meetings: [up('u1', -3)] })
    renderSection()
    expect(screen.getByText('starting now')).toBeInTheDocument()
  })

  it('renders the scheduled time in 24h format by default', () => {
    const m = up('u1', 10)
    mockState({ meetings: [m] })
    renderSection()
    expect(screen.getByText(expected24(m.scheduledStart))).toBeInTheDocument()
  })

  it('renders the scheduled time in 12h format when the setting is 12h', () => {
    localStorage.setItem('wcms.timeFormat', '12h')
    mockState({ meetings: [up('u1', 10)] })
    renderSection()
    expect(screen.getByText(/^\d{1,2}:\d{2} (AM|PM)$/)).toBeInTheDocument()
  })
})
