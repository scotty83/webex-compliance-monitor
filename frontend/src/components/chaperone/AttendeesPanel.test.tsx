import { render, screen, within } from '@testing-library/react'
import { AttendeesPanel } from './AttendeesPanel'
import { TimeFormatProvider } from '../../settings/timeFormat'
import type { Attendee } from '../../types'

// Fixed epoch for deterministic durations (2024-01-15 14:30:00 UTC)
const NOW_TS = new Date('2024-01-15T14:30:00Z').getTime()
const MIN = 60_000

function makeAttendee(opts: Partial<Attendee> & { id: string; name: string }): Attendee {
  return {
    role: 'analyst',
    isHost: false,
    joinedAt: NOW_TS - 30 * MIN,
    leftAt: null,
    ...opts,
  }
}

// Roster covering every role, HOST, and both presence states.
const priya  = makeAttendee({ id: 'fo1',  name: 'Priya Sharma',    role: 'fo',      isHost: true, joinedAt: NOW_TS - 45 * MIN })
const bot    = makeAttendee({ id: 'bot1', name: 'Compliance Monitor Bot', role: 'bot',     joinedAt: NOW_TS - 40 * MIN })
const alex   = makeAttendee({ id: 'an1',  name: 'Alex Chen',       role: 'analyst', joinedAt: NOW_TS - 30 * MIN })
const sam    = makeAttendee({ id: 'ot1',  name: 'Sam Okafor',      role: 'other',   joinedAt: NOW_TS - 60 * MIN, leftAt: NOW_TS - 10 * MIN })
const jordan = makeAttendee({ id: 'an2',  name: 'Jordan Rivera',   role: 'analyst', joinedAt: NOW_TS - 50 * MIN, leftAt: NOW_TS - 35 * MIN })

// Deliberately shuffled — the component must sort, not rely on input order.
const ROSTER = [alex, jordan, priya, sam, bot]

function renderPanel(attendees: Attendee[] = ROSTER) {
  return render(
    <TimeFormatProvider>
      <AttendeesPanel attendees={attendees} now={NOW_TS} />
    </TimeFormatProvider>,
  )
}

function rowOf(name: string): HTMLElement {
  const row = screen.getAllByRole('listitem').find((r) => within(r).queryByText(name) !== null)
  if (!row) throw new Error(`No attendee row found for ${name}`)
  return row
}

/** Build expected HH:MM from local clock — keeps assertions timezone-agnostic. */
function expected24h(ts: number): string {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

afterEach(() => {
  localStorage.clear()
})

// ── PSTN caller-id display ────────────────────────────────────────────────────

describe('AttendeesPanel — PSTN caller-id', () => {
  it('shows formatted caller ID instead of masked name for PSTN attendee', () => {
    const pstn = makeAttendee({
      id: 'pstn1',
      name: '8452****46',
      role: 'other',
      pstn: true,
      phone: '8452338546',
    } as Attendee & { pstn: boolean; phone: string })
    renderPanel([pstn])
    expect(screen.getByText('(845) 233-8546')).toBeInTheDocument()
    // The raw masked name must not appear
    expect(screen.queryByText('8452****46')).not.toBeInTheDocument()
  })

  it('renders a phone glyph in the avatar disc (no masked-name initials)', () => {
    const pstn = makeAttendee({
      id: 'pstn1',
      name: '8452****46',
      role: 'other',
      pstn: true,
      phone: '8452338546',
    })
    const { container } = renderPanel([pstn])
    expect(container.querySelector('svg.lucide-phone')).toBeInTheDocument()
  })
})

// ── Header ────────────────────────────────────────────────────────────────────

describe('AttendeesPanel — header', () => {
  it('renders the "Attendees" heading', () => {
    renderPanel()
    expect(screen.getByRole('heading', { name: 'Attendees' })).toBeInTheDocument()
  })

  it('shows an "N on call" chip with the active count', () => {
    renderPanel()
    expect(screen.getByText('3 on call')).toBeInTheDocument()
  })

  it('shows an "N left" chip when attendees have departed', () => {
    renderPanel()
    expect(screen.getByText('2 left')).toBeInTheDocument()
  })

  it('omits the left chip when nobody has departed', () => {
    renderPanel([priya, bot, alex])
    expect(screen.queryByText(/\d+ left/)).not.toBeInTheDocument()
  })

  it('handles an empty roster: "0 on call" and an empty list', () => {
    renderPanel([])
    expect(screen.getByText('0 on call')).toBeInTheDocument()
    expect(screen.getByRole('list')).toBeInTheDocument()
    expect(screen.queryAllByRole('listitem')).toHaveLength(0)
  })
})

// ── Sort order ────────────────────────────────────────────────────────────────

describe('AttendeesPanel — sort order', () => {
  it('lists active attendees first (joinedAt asc), then departed (leftAt desc)', () => {
    renderPanel()
    const rows = screen.getAllByRole('listitem')
    const expectedOrder = [
      'Priya Sharma',    // active, joined 45m ago
      'Compliance Monitor Bot', // active, joined 40m ago
      'Alex Chen',       // active, joined 30m ago
      'Sam Okafor',      // departed, left 10m ago (most recent departure first)
      'Jordan Rivera',   // departed, left 35m ago
    ]
    expect(rows).toHaveLength(expectedOrder.length)
    expectedOrder.forEach((name, i) => {
      expect(within(rows[i]).getByText(name)).toBeInTheDocument()
    })
  })
})

// ── Role chips + HOST ─────────────────────────────────────────────────────────

describe('AttendeesPanel — role chips and HOST', () => {
  it('labels analyst (external) rows "External Expert"', () => {
    renderPanel()
    expect(screen.getAllByText('External Expert')).toHaveLength(2) // Alex + Jordan
  })

  it('labels front-office (internal) rows "Internal Analyst"', () => {
    renderPanel()
    expect(within(rowOf('Priya Sharma')).getByText('Internal Analyst')).toBeInTheDocument()
  })

  it('labels bot rows "Compliance bot"', () => {
    renderPanel()
    expect(within(rowOf('Compliance Monitor Bot')).getByText('Compliance bot')).toBeInTheDocument()
  })

  it('shows the HOST marker only on host rows', () => {
    renderPanel()
    expect(screen.getAllByText('HOST')).toHaveLength(1)
    expect(within(rowOf('Priya Sharma')).getByText('HOST')).toBeInTheDocument()
  })
})

// ── Presence sub-lines (text is the primary signal — never color-only) ───────

describe('AttendeesPanel — presence sub-lines', () => {
  it('active row reads "On call · {elapsed}"', () => {
    renderPanel()
    expect(within(rowOf('Alex Chen')).getByText('On call · 30m')).toBeInTheDocument()
  })

  it('departed row reads "Left the call · was on for {duration}"', () => {
    renderPanel()
    expect(
      within(rowOf('Jordan Rivera')).getByText('Left the call · was on for 15m'),
    ).toBeInTheDocument()
  })

  it('active rows carry no "Left" text at all', () => {
    renderPanel()
    expect(within(rowOf('Alex Chen')).queryByText(/left/i)).not.toBeInTheDocument()
  })
})

// ── Join/leave times honor useTimeFormat ─────────────────────────────────────

describe('AttendeesPanel — join/leave times', () => {
  it('24h (default): active row shows one zero-padded "Joined HH:MM" time', () => {
    renderPanel()
    const row = rowOf('Alex Chen')
    expect(within(row).getByText(/Joined/)).toBeInTheDocument()
    const times = row.querySelectorAll('time')
    expect(times).toHaveLength(1)
    expect(times[0]).toHaveTextContent(expected24h(alex.joinedAt))
  })

  it('departed row shows both Joined and Left times with a "Left" label', () => {
    renderPanel()
    const row = rowOf('Jordan Rivera')
    const times = row.querySelectorAll('time')
    expect(times).toHaveLength(2)
    expect(times[0]).toHaveTextContent(expected24h(jordan.joinedAt))
    expect(times[1]).toHaveTextContent(expected24h(jordan.leftAt as number))
    expect(within(row).getByText('Left')).toBeInTheDocument()
  })

  it('12h: times honor the stored TimeFormat', () => {
    localStorage.setItem('wcms.timeFormat', '12h')
    renderPanel()
    const time = rowOf('Alex Chen').querySelector('time')
    expect(time?.textContent).toMatch(/^\d{1,2}:\d{2} (AM|PM)$/)
  })
})

// ── Accessibility ─────────────────────────────────────────────────────────────

describe('AttendeesPanel — accessibility', () => {
  it('renders a labelled region containing list semantics', () => {
    renderPanel()
    expect(screen.getByRole('region', { name: 'Attendees' })).toBeInTheDocument()
    expect(screen.getByRole('list')).toBeInTheDocument()
    expect(screen.getAllByRole('listitem')).toHaveLength(5)
  })

  it('avatars are aria-hidden — the name text is the accessible label', () => {
    renderPanel()
    const initials = within(rowOf('Alex Chen')).getByText('AC')
    expect(initials.closest('[aria-hidden="true"]')).not.toBeNull()
  })
})
