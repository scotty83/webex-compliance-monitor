// Admin remove control on MeetingCard (two-step confirm → DELETE /meetings/:id).
// Mocks the session hook + the api method (ScheduleMeeting.test.tsx pattern);
// ApiError stays the REAL class via importActual so instanceof works.
vi.mock('../../auth/AuthGate', () => ({
  useOfficer: vi.fn(),
}))
vi.mock('../../api/client', async () => {
  const actual = await vi.importActual<typeof import('../../api/client')>('../../api/client')
  return { ...actual, deleteMeeting: vi.fn() }
})

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MeetingCard } from './MeetingCard'
import { TimeFormatProvider } from '../../settings/timeFormat'
import { useOfficer } from '../../auth/AuthGate'
import { deleteMeeting, ApiError } from '../../api/client'
import type { Meeting } from '../../types'

const mockUseOfficer = vi.mocked(useOfficer)
const mockDelete = vi.mocked(deleteMeeting)

const START_TS = new Date('2024-01-15T14:30:00Z').getTime()
const NOW_TS = START_TS + 30 * 60_000

function makeMeeting(opts: Partial<Meeting> = {}): Meeting {
  return {
    id: 'm1',
    title: 'Compliance Review',
    org: 'Apex Securities',
    sipUri: 'sip:meeting@apex.com',
    startedAt: START_TS,
    botState: 'failed',
    attendees: [],
    ...opts,
  }
}

function renderCard(meeting: Meeting, onRemoved = vi.fn()) {
  render(
    <TimeFormatProvider>
      <MeetingCard meeting={meeting} now={NOW_TS} onOpenMeeting={vi.fn()} onRemoved={onRemoved} />
    </TimeFormatProvider>,
  )
  return onRemoved
}

beforeEach(() => {
  vi.clearAllMocks()
  mockUseOfficer.mockReturnValue({ email: 'a@bank.example', role: 'admin' })
})

test('admin + non-connected: two-step confirm calls the api and onRemoved', async () => {
  mockDelete.mockResolvedValue(undefined)
  const onRemoved = renderCard(makeMeeting())

  // Step 1: arm — nothing deleted yet.
  await userEvent.click(screen.getByRole('button', { name: 'Remove Compliance Review' }))
  expect(mockDelete).not.toHaveBeenCalled()

  // Step 2: confirm — DELETE fires, owner refetch runs.
  await userEvent.click(screen.getByRole('button', { name: 'Confirm remove Compliance Review' }))
  expect(mockDelete).toHaveBeenCalledWith('m1')
  await waitFor(() => expect(onRemoved).toHaveBeenCalled())
})

test('no remove control for an officer', () => {
  mockUseOfficer.mockReturnValue({ email: 'o@bank.example', role: 'officer' })
  renderCard(makeMeeting())
  expect(screen.queryByRole('button', { name: /^Remove/ })).not.toBeInTheDocument()
})

test('no remove control while the bot is connected (live hang-up is not a card delete)', () => {
  renderCard(makeMeeting({ botState: 'connected' }))
  expect(screen.queryByRole('button', { name: /^Remove/ })).not.toBeInTheDocument()
})

test('failed DELETE surfaces the error loudly and keeps the card actionable', async () => {
  mockDelete.mockRejectedValue(new ApiError(502, 'deregister failed'))
  const onRemoved = renderCard(makeMeeting())

  await userEvent.click(screen.getByRole('button', { name: 'Remove Compliance Review' }))
  await userEvent.click(screen.getByRole('button', { name: 'Confirm remove Compliance Review' }))

  expect(await screen.findByRole('alert')).toHaveTextContent('deregister failed')
  expect(onRemoved).not.toHaveBeenCalled()
  // Back to idle — the icon button is available for another attempt.
  expect(screen.getByRole('button', { name: 'Remove Compliance Review' })).toBeInTheDocument()
})

test('armed control auto-disarms back to the icon after 4 s', () => {
  vi.useFakeTimers()
  try {
    renderCard(makeMeeting())
    // fireEvent (sync) — userEvent's internal delays hang under fake timers.
    fireEvent.click(screen.getByRole('button', { name: 'Remove Compliance Review' }))
    expect(
      screen.getByRole('button', { name: 'Confirm remove Compliance Review' }),
    ).toBeInTheDocument()

    act(() => {
      vi.advanceTimersByTime(4_000)
    })
    expect(
      screen.queryByRole('button', { name: 'Confirm remove Compliance Review' }),
    ).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Remove Compliance Review' })).toBeInTheDocument()
  } finally {
    vi.useRealTimers()
  }
})
