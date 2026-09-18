import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MeetingCard, formatStartTime, formatElapsed } from './MeetingCard'
import { TimeFormatProvider } from '../../settings/timeFormat'
import type { Meeting } from '../../types'

// Fixed epoch for deterministic time tests (2024-01-15 14:30:00 UTC)
const START_TS = new Date('2024-01-15T14:30:00Z').getTime()
const NOW_TS   = START_TS + 30 * 60_000 // 30 min later

function makeMeeting(opts: Partial<Meeting> = {}): Meeting {
  return {
    id: 'm1',
    title: 'Compliance Review',
    org: 'Apex Securities',
    sipUri: 'sip:meeting@apex.com',
    startedAt: START_TS,
    botState: 'connected',
    attendees: [],
    ...opts,
  }
}

function renderCard(meeting: Meeting, onOpenMeeting = vi.fn()) {
  return render(
    <TimeFormatProvider>
      <MeetingCard meeting={meeting} now={NOW_TS} onOpenMeeting={onOpenMeeting} />
    </TimeFormatProvider>,
  )
}

// ── Pure helpers ──────────────────────────────────────────────────────────────

describe('formatElapsed', () => {
  it('< 1m when under 1 minute', () => {
    expect(formatElapsed(START_TS + 30_000, START_TS)).toBe('< 1m')
  })
  it('Nm for whole minutes under an hour', () => {
    expect(formatElapsed(START_TS + 30 * 60_000, START_TS)).toBe('30m')
  })
  it('Xh for exact hours', () => {
    expect(formatElapsed(START_TS + 120 * 60_000, START_TS)).toBe('2h')
  })
  it('Xh Ym for hours + remainder', () => {
    expect(formatElapsed(START_TS + 90 * 60_000, START_TS)).toBe('1h 30m')
  })
  it('0m when now is before startedAt', () => {
    expect(formatElapsed(START_TS - 1000, START_TS)).toBe('0m')
  })
})

describe('formatStartTime', () => {
  it('24h: zero-pads hours and minutes using local clock', () => {
    // Build expected string from local time to stay timezone-agnostic
    const d = new Date(START_TS)
    const expected = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    expect(formatStartTime(START_TS, '24h')).toBe(expected)
  })
  it('12h: format is "H:MM AM/PM" with no leading zero on hour', () => {
    const result = formatStartTime(START_TS, '12h')
    // e.g. "9:30 AM" or "2:30 PM" — format check only (timezone-agnostic)
    expect(result).toMatch(/^\d{1,2}:\d{2} (AM|PM)$/)
  })
})

// ── Card structure ────────────────────────────────────────────────────────────

describe('MeetingCard — structure', () => {
  it('renders meeting title as a heading', () => {
    renderCard(makeMeeting())
    expect(screen.getByRole('heading', { name: /Compliance Review/ })).toBeInTheDocument()
  })

  it('renders org name', () => {
    renderCard(makeMeeting())
    expect(screen.getByText('Apex Securities')).toBeInTheDocument()
  })

  it('renders SIP URI', () => {
    renderCard(makeMeeting())
    expect(screen.getByText('sip:meeting@apex.com')).toBeInTheDocument()
  })

  it('shows elapsed time from now', () => {
    renderCard(makeMeeting())
    // 30 minutes elapsed
    expect(screen.getByText(/30m/)).toBeInTheDocument()
  })

  it('has data-testid for test targeting', () => {
    renderCard(makeMeeting({ id: 'xyz' }))
    expect(screen.getByTestId('meeting-card-xyz')).toBeInTheDocument()
  })
})

// ── No REC badge ──────────────────────────────────────────────────────────────

describe('MeetingCard — no recording text', () => {
  it('does not render "REC" text', () => {
    renderCard(makeMeeting())
    expect(screen.queryByText(/\bREC\b/)).not.toBeInTheDocument()
  })

  it('does not render "recording" text', () => {
    renderCard(makeMeeting())
    expect(screen.queryByText(/recording/i)).not.toBeInTheDocument()
  })
})

// ── BotStatusIndicator integration ───────────────────────────────────────────

describe('MeetingCard — bot status display', () => {
  it('shows "Bot connected" status for connected state', () => {
    renderCard(makeMeeting({ botState: 'connected' }))
    expect(screen.getByRole('status', { name: /Bot connected/ })).toBeInTheDocument()
  })

  it('shows "Bot failed" status for failed state', () => {
    renderCard(makeMeeting({ botState: 'failed' }))
    expect(screen.getByRole('status', { name: /Bot failed/ })).toBeInTheDocument()
  })
})

// ── JoinButton integration ────────────────────────────────────────────────────

describe('MeetingCard — join button', () => {
  it('connected: join button enabled', () => {
    renderCard(makeMeeting({ botState: 'connected' }))
    expect(screen.getByRole('button', { name: /Chaperone join/ })).not.toBeDisabled()
  })

  it('failed: join button enabled with "View attendees" (read-only entry)', () => {
    renderCard(makeMeeting({ botState: 'failed' }))
    expect(screen.getByRole('button', { name: /View attendees/ })).not.toBeDisabled()
  })

  it('disconnected: join button enabled with "View attendees" (read-only entry)', () => {
    renderCard(makeMeeting({ botState: 'disconnected' }))
    expect(screen.getByRole('button', { name: /View attendees/ })).not.toBeDisabled()
  })

  it('ended: join button enabled with "View history"', () => {
    renderCard(makeMeeting({ botState: 'ended', endedAt: NOW_TS - 10 * 60_000 }))
    expect(screen.getByRole('button', { name: /View history/ })).not.toBeDisabled()
  })

  it('click calls onOpenMeeting with correct id', async () => {
    const onOpenMeeting = vi.fn()
    renderCard(makeMeeting({ id: 'm99', botState: 'connected' }), onOpenMeeting)
    await userEvent.click(screen.getByRole('button', { name: /Chaperone join/ }))
    expect(onOpenMeeting).toHaveBeenCalledWith('m99')
  })
})

// ── Task 6: ended meeting meta ────────────────────────────────────────────────

test('ended meeting shows "Ended … · ran …" instead of a live elapsed counter', () => {
  const NOW = Date.now()
  const meeting: Meeting = {
    id: 'm-ended', title: 'Ended briefing', org: '', sipUri: '1@x.webex.com',
    startedAt: NOW - 60 * 60_000, botState: 'ended', attendees: [],
    endedAt: NOW - 10 * 60_000,
  }
  render(
    <TimeFormatProvider>
      <MeetingCard meeting={meeting} now={NOW} onOpenMeeting={() => {}} />
    </TimeFormatProvider>,
  )
  expect(screen.getByText(/^Ended .+ · ran /)).toBeInTheDocument()
  expect(screen.queryByText(/^Started /)).not.toBeInTheDocument()
})
