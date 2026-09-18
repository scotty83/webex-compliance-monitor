import { render, screen } from '@testing-library/react'
import { Header } from './Header'
import type { Meeting } from '../../types'
import { TimeFormatProvider } from '../../settings/timeFormat'

vi.mock('../../auth/AuthGate', () => ({
  useOfficer: vi.fn().mockReturnValue({ email: 'test@compliance.example', role: 'officer' }),
}))

const NOW = 1_700_000_000_000

/** A terminal bot always carries an endedAt (types.ts maps bot.updatedAt →
 *  endedAt for every terminal state), so fixtures default to "just ended". */
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

function wrap(meetings: Meeting[] = []) {
  return render(
    <TimeFormatProvider>
      <Header meetings={meetings} now={NOW} />
    </TimeFormatProvider>
  )
}

test('renders "Compliance Monitor" brand text', () => {
  wrap()
  expect(screen.getByText('Compliance Monitor')).toBeInTheDocument()
})

test('renders "Webex monitoring console" brand text', () => {
  wrap()
  expect(screen.getByText('Webex monitoring console')).toBeInTheDocument()
})

test('renders StatusPill showing meeting count', () => {
  wrap([mkMeeting({ id: '1' }), mkMeeting({ id: '2' })])
  expect(screen.getByText('2 meetings tracked')).toBeInTheDocument()
})

test('no text matching /recording/i anywhere', () => {
  const { container } = wrap()
  expect(container.textContent).not.toMatch(/recording/i)
})

test('with 0 failed/disconnected bots, IssuesBadge is not rendered', () => {
  wrap([mkMeeting({ id: '1', botState: 'connected' })])
  expect(screen.queryByRole('status')).not.toBeInTheDocument()
})

test('with 1 failed bot, "1 bot needs attention" is in the DOM', () => {
  wrap([mkMeeting({ id: '1', botState: 'failed' })])
  expect(screen.getByText('1 bot needs attention')).toBeInTheDocument()
})

test('gear button rendered', () => {
  wrap()
  expect(screen.getByRole('button', { name: 'Open settings' })).toBeInTheDocument()
})
