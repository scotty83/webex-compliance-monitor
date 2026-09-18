import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { OtherMeetings } from './OtherMeetings'
import type { Attendee, Meeting } from '../../types'

// ── Fixtures ──────────────────────────────────────────────────────────────────

const START_TS = new Date('2024-01-15T14:00:00Z').getTime()
const NOW_TS   = new Date('2024-01-15T14:30:00Z').getTime() // 30m elapsed

function makeAttendee(id: string, leftAt: number | null): Attendee {
  return { id, name: `P ${id}`, role: 'other', isHost: false, joinedAt: START_TS, leftAt }
}

function makeMeeting(opts: Partial<Meeting> & { id: string }): Meeting {
  return {
    title: `Meeting ${opts.id}`,
    org: 'Apex Securities',
    sipUri: `sip:${opts.id}@apex.com`,
    startedAt: START_TS,
    botState: 'connected',
    attendees: [],
    ...opts,
  }
}

function renderPanel(meetings: Meeting[], onOpenMeeting = vi.fn()) {
  render(
    <OtherMeetings
      meetings={meetings}
      activeMeetingId="active"
      now={NOW_TS}
      onOpenMeeting={onOpenMeeting}
    />,
  )
  return onOpenMeeting
}

const ACTIVE = makeMeeting({ id: 'active', title: 'Active Call' })

// ── Header ────────────────────────────────────────────────────────────────────

describe('OtherMeetings — header', () => {
  it('renders the heading and sub-line', () => {
    renderPanel([ACTIVE, makeMeeting({ id: 'm2' })])
    expect(screen.getByRole('heading', { name: 'Other active meetings' })).toBeInTheDocument()
    expect(screen.getByText('Hop between calls to listen in')).toBeInTheDocument()
  })
})

// ── Filtering & ordering ──────────────────────────────────────────────────────

describe('OtherMeetings — rows', () => {
  it('excludes the active meeting', () => {
    renderPanel([ACTIVE, makeMeeting({ id: 'm2', title: 'Other Call' })])
    expect(screen.queryByText('Active Call')).not.toBeInTheDocument()
    expect(screen.getByText('Other Call')).toBeInTheDocument()
  })

  it('orders connected first, then dialing/idle, fail-loud last', () => {
    renderPanel([
      ACTIVE,
      makeMeeting({ id: 'failed1', botState: 'failed' }),
      makeMeeting({ id: 'idle1', botState: 'idle' }),
      makeMeeting({ id: 'conn1', botState: 'connected' }),
      makeMeeting({ id: 'disc1', botState: 'disconnected' }),
      makeMeeting({ id: 'dial1', botState: 'dialing' }),
      makeMeeting({ id: 'conn2', botState: 'connected' }),
    ])
    const ids = screen
      .getAllByTestId(/^other-meeting-/)
      .map((el) => el.getAttribute('data-testid'))
    expect(ids).toEqual([
      'other-meeting-conn1',
      'other-meeting-conn2',
      'other-meeting-idle1',
      'other-meeting-dial1',
      'other-meeting-failed1',
      'other-meeting-disc1',
    ])
  })

  it('shows "N on call · elapsed" meta counting only attendees still on the call', () => {
    renderPanel([
      ACTIVE,
      makeMeeting({
        id: 'm2',
        attendees: [
          makeAttendee('a1', null),
          makeAttendee('a2', null),
          makeAttendee('a3', NOW_TS - 60_000), // left — not counted
        ],
      }),
    ])
    expect(screen.getByText('2 on call · 30m')).toBeInTheDocument()
  })

  it('renders the empty line when no other meetings exist', () => {
    renderPanel([ACTIVE])
    expect(screen.getByText('No other meetings tracked')).toBeInTheDocument()
  })
})

// ── Connected rows — interactive ──────────────────────────────────────────────

describe('OtherMeetings — connected rows', () => {
  it('connected row is a button; clicking calls onOpenMeeting(id)', async () => {
    const onOpen = renderPanel([
      ACTIVE,
      makeMeeting({ id: 'm2', title: 'Hop Target', botState: 'connected' }),
    ])
    const row = screen.getByRole('button', { name: /Hop Target/ })
    await userEvent.click(row)
    expect(onOpen).toHaveBeenCalledExactlyOnceWith('m2')
  })

  it('connected row carries a screen-reader-only bot status (no visible label)', () => {
    renderPanel([ACTIVE, makeMeeting({ id: 'm2', botState: 'connected' })])
    const row = screen.getByTestId('other-meeting-m2')
    const status = within(row).getByRole('status', { name: 'Connected' })
    expect(status).toBeInTheDocument()
    // Label text is sr-only, not painted (global.css isn't loaded in jsdom,
    // so assert the class rather than computed visibility)
    expect(within(row).getByText('Connected')).toHaveClass('sr-only')
  })
})

// ── Disconnected / failed rows — fail-loud, non-interactive ───────────────────

describe('OtherMeetings — fail-loud rows', () => {
  it.each(['disconnected', 'failed'] as const)(
    '%s row is not a button and shows a VISIBLE status label',
    (state) => {
      renderPanel([
        ACTIVE,
        makeMeeting({ id: 'm2', title: 'Broken Call', botState: state }),
      ])
      expect(screen.queryByRole('button', { name: /Broken Call/ })).not.toBeInTheDocument()
      const row = screen.getByTestId('other-meeting-m2')
      const label = state === 'disconnected' ? 'Disconnected' : 'Failed'
      const labelEl = within(row).getByText(label)
      expect(labelEl).toBeVisible()
      expect(labelEl).not.toHaveClass('sr-only')
    },
  )

  it('dialing row is not a button', () => {
    renderPanel([ACTIVE, makeMeeting({ id: 'm2', title: 'Dialing Call', botState: 'dialing' })])
    expect(screen.queryByRole('button', { name: /Dialing Call/ })).not.toBeInTheDocument()
  })
})
