import { render, screen, within } from '@testing-library/react'
import { ListeningActivity } from './ListeningActivity'
import { TimeFormatProvider } from '../../settings/timeFormat'
import type { ListeningEntry } from '../../listening/log'

// ── Fixtures ──────────────────────────────────────────────────────────────────

// Local-time constructor — formatStartTime renders wall-clock local time
const AT_1405 = new Date(2024, 0, 15, 14, 5).getTime()

function makeEntry(overrides: Partial<ListeningEntry> = {}): ListeningEntry {
  return {
    action: 'listen_start',
    meetingId: 'm1',
    title: 'Compliance Audit',
    at: AT_1405,
    ...overrides,
  }
}

function renderPanel(entries: readonly ListeningEntry[]) {
  return render(
    <TimeFormatProvider>
      <ListeningActivity entries={entries} />
    </TimeFormatProvider>,
  )
}

beforeEach(() => {
  localStorage.clear()
})

// ── Header ────────────────────────────────────────────────────────────────────

describe('ListeningActivity — header', () => {
  it('renders the heading', () => {
    renderPanel([])
    expect(screen.getByRole('heading', { name: 'Listening activity' })).toBeInTheDocument()
  })
})

// ── Empty state ───────────────────────────────────────────────────────────────

describe('ListeningActivity — empty state', () => {
  it('teaches what the panel is for when there are no entries', () => {
    renderPanel([])
    expect(
      screen.getByText('No listening activity yet — join a meeting to listen for the record.'),
    ).toBeInTheDocument()
  })
})

// ── Entries ───────────────────────────────────────────────────────────────────

describe('ListeningActivity — entries', () => {
  it('renders a start entry with label, meeting title, and 24h time (default)', () => {
    renderPanel([makeEntry({ action: 'listen_start' })])
    const row = screen.getByTestId('listening-entry-0')
    expect(within(row).getByText('Started listening')).toBeInTheDocument()
    expect(within(row).getByText('Compliance Audit')).toBeInTheDocument()
    expect(within(row).getByText('14:05')).toBeInTheDocument()
  })

  it('renders a stop entry with the stopped label', () => {
    renderPanel([makeEntry({ action: 'listen_stop' })])
    expect(screen.getByText('Stopped listening')).toBeInTheDocument()
  })

  it('honours the 12h officer time format', () => {
    localStorage.setItem('wcms.timeFormat', '12h')
    renderPanel([makeEntry()])
    expect(screen.getByText('2:05 PM')).toBeInTheDocument()
  })

  it('renders entries in the given (newest-first) order', () => {
    renderPanel([
      makeEntry({ action: 'listen_stop', title: 'Newest Call' }),
      makeEntry({ action: 'listen_start', title: 'Older Call' }),
    ])
    const rows = screen.getAllByTestId(/^listening-entry-/)
    expect(within(rows[0]!).getByText('Newest Call')).toBeInTheDocument()
    expect(within(rows[1]!).getByText('Older Call')).toBeInTheDocument()
  })

  it('caps the visible list at 10 entries', () => {
    const entries = Array.from({ length: 14 }, (_, i) =>
      makeEntry({ title: `Call ${i}`, at: AT_1405 - i * 60_000 }),
    )
    renderPanel(entries)
    expect(screen.getAllByTestId(/^listening-entry-/)).toHaveLength(10)
    expect(screen.getByText('Call 0')).toBeInTheDocument()
    expect(screen.queryByText('Call 10')).not.toBeInTheDocument()
  })
})
