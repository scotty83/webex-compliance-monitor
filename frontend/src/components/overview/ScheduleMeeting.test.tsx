// Mock the session hook (same pattern as OfficerBadge.test.tsx) and the api
// method; ApiError stays the REAL class via importActual so instanceof works.
vi.mock('../../auth/AuthGate', () => ({
  useOfficer: vi.fn(),
}))
vi.mock('../../api/client', async () => {
  const actual = await vi.importActual<typeof import('../../api/client')>('../../api/client')
  return { ...actual, scheduleMeeting: vi.fn() }
})

import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ScheduleMeeting } from './ScheduleMeeting'
import { useOfficer } from '../../auth/AuthGate'
import { scheduleMeeting, ApiError } from '../../api/client'
import type { CreatedMeeting } from '../../types'

const mockUseOfficer = vi.mocked(useOfficer)
const mockSchedule = vi.mocked(scheduleMeeting)

const CREATED: CreatedMeeting = {
  webexMeetingId: 'wx-1',
  title: 'Board sync',
  start: new Date('2027-01-15T14:00').getTime(),
  sipAddress: '123@site.webex.example',
  joinUrl: 'https://site.webex.example/meet/board',
}

beforeEach(() => {
  vi.clearAllMocks()
  mockUseOfficer.mockReturnValue({ email: 'a@bank.example', role: 'admin' })
})

async function openDialog() {
  render(<ScheduleMeeting />)
  await userEvent.click(screen.getByRole('button', { name: 'Schedule meeting' }))
  return screen.getByRole('dialog', { name: 'Schedule a meeting' })
}

/** Fill title/date/time; duration keeps its default of 30. jsdom date/time
 *  inputs reject userEvent.type — set them via fireEvent.change. */
async function fillValidForm() {
  await userEvent.type(screen.getByLabelText('Title'), 'Board sync')
  fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2027-01-15' } })
  fireEvent.change(screen.getByLabelText('Time'), { target: { value: '14:00' } })
}

// ─── Admin-only visibility (spec: hidden entirely for officers) ───────────────

test('renders the trigger button for an admin', () => {
  render(<ScheduleMeeting />)
  expect(screen.getByRole('button', { name: 'Schedule meeting' })).toBeInTheDocument()
})

test('renders NOTHING for an officer', () => {
  mockUseOfficer.mockReturnValue({ email: 'o@bank.example', role: 'officer' })
  const { container } = render(<ScheduleMeeting />)
  expect(container).toBeEmptyDOMElement()
})

test('renders NOTHING when there is no session (useOfficer → null)', () => {
  mockUseOfficer.mockReturnValue(null)
  const { container } = render(<ScheduleMeeting />)
  expect(container).toBeEmptyDOMElement()
})

// ─── Dialog behavior (SettingsPanel pattern) ──────────────────────────────────

test('clicking the trigger opens a labelled dialog', async () => {
  await openDialog()
  expect(screen.getByRole('dialog', { name: 'Schedule a meeting' })).toBeInTheDocument()
})

test('opening the form pre-fills date & time with the next quarter-hour (local)', () => {
  vi.useFakeTimers()
  try {
    vi.setSystemTime(new Date(2026, 6, 10, 7, 22, 0)) // Fri 2026-07-10 07:22 local → 07:30
    render(<ScheduleMeeting />)
    fireEvent.click(screen.getByRole('button', { name: 'Schedule meeting' }))
    expect(screen.getByLabelText('Date')).toHaveValue('2026-07-10')
    expect(screen.getByLabelText('Time')).toHaveValue('07:30')
  } finally {
    vi.useRealTimers()
  }
})

test('pre-fill rolls into the next hour when opened in the last quarter', () => {
  vi.useFakeTimers()
  try {
    vi.setSystemTime(new Date(2026, 6, 10, 7, 52, 0)) // 07:52 local → 08:00
    render(<ScheduleMeeting />)
    fireEvent.click(screen.getByRole('button', { name: 'Schedule meeting' }))
    expect(screen.getByLabelText('Date')).toHaveValue('2026-07-10')
    expect(screen.getByLabelText('Time')).toHaveValue('08:00')
  } finally {
    vi.useRealTimers()
  }
})

test('an exact quarter-hour boundary advances to the following quarter (strictly future)', () => {
  vi.useFakeTimers()
  try {
    vi.setSystemTime(new Date(2026, 6, 10, 7, 30, 0)) // exactly 07:30 → 07:45, never "now"
    render(<ScheduleMeeting />)
    fireEvent.click(screen.getByRole('button', { name: 'Schedule meeting' }))
    expect(screen.getByLabelText('Time')).toHaveValue('07:45')
  } finally {
    vi.useRealTimers()
  }
})

test('Escape closes the dialog and focus returns to the trigger', async () => {
  await openDialog()
  await userEvent.keyboard('{Escape}')
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Schedule meeting' }))
})

test('backdrop click closes the dialog', async () => {
  await openDialog()
  const backdrop = document.querySelector('[data-testid="schedule-backdrop"]') as HTMLElement
  expect(backdrop).toBeInTheDocument()
  await userEvent.click(backdrop)
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
})

// ─── Client-side validation (mirrors the backend) ─────────────────────────────

test('empty title → alert, api not called', async () => {
  await openDialog()
  fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2027-01-15' } })
  fireEvent.change(screen.getByLabelText('Time'), { target: { value: '14:00' } })
  await userEvent.click(screen.getByRole('button', { name: 'Schedule' }))
  expect(screen.getByRole('alert')).toHaveTextContent('Title is required')
  expect(mockSchedule).not.toHaveBeenCalled()
})

test('past start → alert, api not called', async () => {
  await openDialog()
  await userEvent.type(screen.getByLabelText('Title'), 'Board sync')
  fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2020-01-01' } })
  fireEvent.change(screen.getByLabelText('Time'), { target: { value: '09:00' } })
  await userEvent.click(screen.getByRole('button', { name: 'Schedule' }))
  expect(screen.getByRole('alert')).toHaveTextContent('Start must be in the future')
  expect(mockSchedule).not.toHaveBeenCalled()
})

test('out-of-range duration → alert, api not called', async () => {
  await openDialog()
  await fillValidForm()
  fireEvent.change(screen.getByLabelText('Duration (minutes)'), { target: { value: '0' } })
  await userEvent.click(screen.getByRole('button', { name: 'Schedule' }))
  expect(screen.getByRole('alert')).toHaveTextContent('between 1 and 480')
  expect(mockSchedule).not.toHaveBeenCalled()
})

// ─── Invitee chips (comma/enter-separated) ────────────────────────────────────

test('Enter commits a valid email as a removable chip', async () => {
  await openDialog()
  await userEvent.type(screen.getByLabelText('Invitees'), 'bob@fund.example{Enter}')
  const remove = screen.getByRole('button', { name: 'Remove bob@fund.example' })
  expect(remove).toBeInTheDocument()
  await userEvent.click(remove)
  expect(screen.queryByRole('button', { name: 'Remove bob@fund.example' })).not.toBeInTheDocument()
})

test('comma also commits a chip', async () => {
  await openDialog()
  await userEvent.type(screen.getByLabelText('Invitees'), 'ann@fund.example,')
  expect(screen.getByRole('button', { name: 'Remove ann@fund.example' })).toBeInTheDocument()
})

test('invalid email is rejected with an alert and never becomes a chip', async () => {
  await openDialog()
  await userEvent.type(screen.getByLabelText('Invitees'), 'not-an-email{Enter}')
  expect(screen.getByRole('alert')).toHaveTextContent('not-an-email')
  expect(screen.queryByRole('button', { name: /^Remove/ })).not.toBeInTheDocument()
})

// ─── Submit: success panel ────────────────────────────────────────────────────

test('valid submit calls the api with the exact input (pending draft committed) and shows the success panel', async () => {
  mockSchedule.mockResolvedValue(CREATED)
  await openDialog()
  await fillValidForm()
  await userEvent.type(screen.getByLabelText('Invitees'), 'bob@fund.example{Enter}')
  await userEvent.type(screen.getByLabelText('Invitees'), 'ann@fund.example') // left uncommitted
  await userEvent.click(screen.getByRole('button', { name: 'Schedule' }))

  await waitFor(() => expect(mockSchedule).toHaveBeenCalledWith({
    title: 'Board sync',
    start: new Date('2027-01-15T14:00').getTime(),
    durationMinutes: 30,
    invitees: ['bob@fund.example', 'ann@fund.example'],
  }))
  expect(await screen.findByText('Meeting scheduled')).toBeInTheDocument()
  expect(screen.getByRole('link', { name: 'https://site.webex.example/meet/board' }))
    .toHaveAttribute('href', 'https://site.webex.example/meet/board')
  expect(screen.getByText('123@site.webex.example')).toBeInTheDocument()
  expect(screen.getByText(/appear in Upcoming/)).toBeInTheDocument()
})

test('Copy button writes the join URL to the clipboard and announces it', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined)
  Object.assign(navigator, { clipboard: { writeText } })
  mockSchedule.mockResolvedValue(CREATED)
  await openDialog()
  await fillValidForm()
  await userEvent.click(screen.getByRole('button', { name: 'Schedule' }))
  await screen.findByText('Meeting scheduled')

  await userEvent.click(screen.getByRole('button', { name: 'Copy join link' }))
  expect(writeText).toHaveBeenCalledWith('https://site.webex.example/meet/board')
  expect(await screen.findByText('Join link copied')).toBeInTheDocument()
})

test('Done closes the dialog and a reopened form is blank', async () => {
  mockSchedule.mockResolvedValue(CREATED)
  await openDialog()
  await fillValidForm()
  await userEvent.click(screen.getByRole('button', { name: 'Schedule' }))
  await screen.findByText('Meeting scheduled')

  await userEvent.click(screen.getByRole('button', { name: 'Done' }))
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: 'Schedule meeting' }))
  expect(screen.getByLabelText('Title')).toHaveValue('')
})

// ─── Submit: error mapping ────────────────────────────────────────────────────

test('403 → the missing-scope message (spec copy)', async () => {
  mockSchedule.mockRejectedValue(new ApiError(403, 'forbidden'))
  await openDialog()
  await fillValidForm()
  await userEvent.click(screen.getByRole('button', { name: 'Schedule' }))
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'The Service App is missing the meeting-create scope',
  )
})

test('400 → the server validation message verbatim', async () => {
  mockSchedule.mockRejectedValue(new ApiError(400, 'start must be in the future'))
  await openDialog()
  await fillValidForm()
  await userEvent.click(screen.getByRole('button', { name: 'Schedule' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('start must be in the future')
})

test('502 (e.g. created-but-no-sipAddress) → the server message verbatim', async () => {
  mockSchedule.mockRejectedValue(
    new ApiError(502, 'Webex created meeting wx-9 with no sipAddress — the bot cannot dial it'),
  )
  await openDialog()
  await fillValidForm()
  await userEvent.click(screen.getByRole('button', { name: 'Schedule' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('no sipAddress')
})
