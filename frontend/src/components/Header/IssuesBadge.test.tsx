import { render, screen } from '@testing-library/react'
import { IssuesBadge } from './IssuesBadge'
import { FAILURE_GRACE_MS } from '../../lib/partitionMeetings'
import type { Meeting } from '../../types'

const NOW = 1_700_000_000_000

/** A terminal bot always carries an endedAt (types.ts maps bot.updatedAt →
 *  endedAt for every terminal state), so fixtures default to "just failed". */
function mkMeeting(overrides: Partial<Meeting> & { id: string }): Meeting {
  return {
    title: 'Test Meeting',
    org: '',
    sipUri: '',
    startedAt: 0,
    botState: 'idle',
    endedAt: NOW,
    attendees: [],
    ...overrides,
  }
}

test('0 issues → element with role="status" is NOT in the DOM', () => {
  const meetings = [mkMeeting({ id: '1', botState: 'connected' })]
  render(<IssuesBadge meetings={meetings} now={NOW} />)
  expect(screen.queryByRole('status')).not.toBeInTheDocument()
})

test('1 failed bot → text "1 bot needs attention" present', () => {
  const meetings = [mkMeeting({ id: '1', botState: 'failed' })]
  render(<IssuesBadge meetings={meetings} now={NOW} />)
  expect(screen.getByText('1 bot needs attention')).toBeInTheDocument()
})

test('1 failed bot → has role="status"', () => {
  const meetings = [mkMeeting({ id: '1', botState: 'failed' })]
  render(<IssuesBadge meetings={meetings} now={NOW} />)
  expect(screen.getByRole('status')).toBeInTheDocument()
})

test('1 failed bot → has aria-live="polite"', () => {
  const meetings = [mkMeeting({ id: '1', botState: 'failed' })]
  render(<IssuesBadge meetings={meetings} now={NOW} />)
  expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite')
})

test('2 disconnected bots → "2 bots need attention"', () => {
  const meetings = [
    mkMeeting({ id: '1', botState: 'disconnected' }),
    mkMeeting({ id: '2', botState: 'disconnected' }),
  ]
  render(<IssuesBadge meetings={meetings} now={NOW} />)
  expect(screen.getByText('2 bots need attention')).toBeInTheDocument()
})

test('1 connected bot + 1 failed → count=1', () => {
  const meetings = [
    mkMeeting({ id: '1', botState: 'connected' }),
    mkMeeting({ id: '2', botState: 'failed' }),
  ]
  render(<IssuesBadge meetings={meetings} now={NOW} />)
  expect(screen.getByText('1 bot needs attention')).toBeInTheDocument()
})

test('AlertTriangle icon is rendered (aria-hidden svg present)', () => {
  const meetings = [mkMeeting({ id: '1', botState: 'failed' })]
  const { container } = render(<IssuesBadge meetings={meetings} now={NOW} />)
  const svg = container.querySelector('svg[aria-hidden="true"]')
  expect(svg).toBeInTheDocument()
})

// The badge must track exactly the bots still LOUD in Active. partitionMeetings
// demotes a failed/disconnected bot to Past once FAILURE_GRACE_MS elapses, so a
// badge counting the raw list stays lit forever for a meeting that no longer has
// an actionable card — and an officer (no delete rights) can never clear it.
test('a failure past the grace window is NOT counted (badge clears with the Active card)', () => {
  const meetings = [
    mkMeeting({ id: '1', botState: 'failed', endedAt: NOW - FAILURE_GRACE_MS - 1 }),
  ]
  render(<IssuesBadge meetings={meetings} now={NOW} />)
  expect(screen.queryByRole('status')).not.toBeInTheDocument()
})

test('counts only the still-loud failure when one is fresh and one is grace-expired', () => {
  const meetings = [
    mkMeeting({ id: 'fresh', botState: 'failed', endedAt: NOW - 1_000 }),
    mkMeeting({ id: 'old', botState: 'disconnected', endedAt: NOW - FAILURE_GRACE_MS - 1 }),
  ]
  render(<IssuesBadge meetings={meetings} now={NOW} />)
  expect(screen.getByText('1 bot needs attention')).toBeInTheDocument()
})

test('a cleanly ended bot is never counted', () => {
  const meetings = [mkMeeting({ id: '1', botState: 'ended', endedAt: NOW })]
  render(<IssuesBadge meetings={meetings} now={NOW} />)
  expect(screen.queryByRole('status')).not.toBeInTheDocument()
})
