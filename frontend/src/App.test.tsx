import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from './App'
import type { Meeting } from './types'
import { clearListeningLog } from './listening/log'

vi.mock('./hooks/useMeetings', () => ({
  useMeetings: vi.fn(),
}))

// UpcomingMeetings owns its own polling hook — stub it so App tests stay
// synchronous and network-free (empty → the section renders nothing).
vi.mock('./hooks/useUpcomingMeetings', () => ({
  useUpcomingMeetings: vi
    .fn()
    .mockReturnValue({ meetings: [], loading: false, error: null }),
}))

vi.mock('./auth/AuthGate', () => ({
  useOfficer: vi.fn().mockReturnValue({ email: 'test@compliance.example', role: 'officer' }),
}))

// Chaperone tests run the real useLiveAudio with no session token, which calls
// redirectToLogin() — stub only the navigation (jsdom can't navigate and logs
// "Not implemented" errors otherwise).
vi.mock('./auth/session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./auth/session')>()
  return { ...actual, redirectToLogin: vi.fn() }
})

import { useMeetings } from './hooks/useMeetings'
const mockUseMeetings = vi.mocked(useMeetings)

// ── fixtures ──────────────────────────────────────────────────────────────────

function makeMeeting(id: string, title: string): Meeting {
  return {
    id,
    title,
    org: 'Acme',
    sipUri: `sip:${id}@example.com`,
    startedAt: Date.now() - 5 * 60_000,
    botState: 'connected',
    attendees: [],
  }
}

const MEETINGS: Meeting[] = [makeMeeting('m1', 'Alpha Call'), makeMeeting('m2', 'Beta Call')]

function mockMeetings(meetings: Meeting[] = MEETINGS) {
  mockUseMeetings.mockReturnValue({ meetings, loading: false, error: null, refetch: vi.fn() })
}

beforeEach(() => {
  // The listening log is module-level session state; chaperone-view tests here
  // write to it, so reset between tests to avoid cross-test leakage.
  clearListeningLog()
  mockMeetings()
})

// ── shell renders ─────────────────────────────────────────────────────────────

describe('App shell', () => {
  it('renders the header brand text', () => {
    render(<App />)
    expect(screen.getByText('Compliance Monitor')).toBeInTheDocument()
    expect(screen.getByText('Webex monitoring console')).toBeInTheDocument()
  })

  it('starts on overview view', () => {
    render(<App />)
    expect(screen.getByRole('main')).toHaveAttribute('data-view', 'overview')
  })

  it('renders meeting card titles in overview', () => {
    render(<App />)
    expect(screen.getByText('Alpha Call')).toBeInTheDocument()
    expect(screen.getByText('Beta Call')).toBeInTheDocument()
  })

  it('shows empty state when no meetings', () => {
    mockMeetings([])
    render(<App />)
    expect(screen.getByText(/No meetings are being chaperoned right now/)).toBeInTheDocument()
  })

  it('shows loading skeleton on first load', () => {
    mockUseMeetings.mockReturnValue({ meetings: [], loading: true, error: null, refetch: vi.fn() })
    render(<App />)
    expect(screen.getByTestId('loading-skeleton')).toBeInTheDocument()
  })

  it('shows error banner when error and no data', () => {
    mockUseMeetings.mockReturnValue({
      meetings: [],
      loading: false,
      error: new Error('fetch failed'),
      refetch: vi.fn(),
    })
    render(<App />)
    expect(screen.getByText(/Couldn't load meetings/)).toBeInTheDocument()
  })
})

// ── view switching ────────────────────────────────────────────────────────────

describe('onOpenMeeting / onBackToOverview', () => {
  it('clicking m1 join button switches to chaperone view for m1', async () => {
    render(<App />)
    const card1 = screen.getByTestId('meeting-card-m1')
    await userEvent.click(within(card1).getByRole('button', { name: /Chaperone join/ }))
    expect(screen.getByRole('main')).toHaveAttribute('data-view', 'chaperone')
    expect(screen.getByRole('main')).toHaveAttribute('data-meeting-id', 'm1')
    expect(screen.getByText(/Alpha Call/)).toBeInTheDocument()
  })

  it('onBackToOverview returns to overview', async () => {
    render(<App />)
    const card2 = screen.getByTestId('meeting-card-m2')
    await userEvent.click(within(card2).getByRole('button', { name: /Chaperone join/ }))
    expect(screen.getByRole('main')).toHaveAttribute('data-view', 'chaperone')
    await userEvent.click(screen.getByRole('button', { name: /Back/ }))
    expect(screen.getByRole('main')).toHaveAttribute('data-view', 'overview')
  })

  it('overview stays stable with empty meetings list', () => {
    mockMeetings([])
    render(<App />)
    expect(screen.getByRole('main')).toHaveAttribute('data-view', 'overview')
  })

  it('clicking an OtherMeetings row switches the chaperone to that meeting', async () => {
    render(<App />)
    // Enter chaperone for m1
    const card1 = screen.getByTestId('meeting-card-m1')
    await userEvent.click(within(card1).getByRole('button', { name: /Chaperone join/ }))
    expect(screen.getByRole('main')).toHaveAttribute('data-meeting-id', 'm1')

    // Right column lists m2 — hop to it
    const panel = screen.getByRole('region', { name: 'Other active meetings' })
    await userEvent.click(within(panel).getByRole('button', { name: /Beta Call/ }))

    expect(screen.getByRole('main')).toHaveAttribute('data-meeting-id', 'm2')
    // And m1 is now the "other" meeting
    expect(
      within(screen.getByRole('region', { name: 'Other active meetings' })).getByText('Alpha Call'),
    ).toBeInTheDocument()
  })
})
