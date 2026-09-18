// OverviewView mounts UpcomingMeetings, which owns its own polling hook —
// mock the hook so these tests stay synchronous and network-free.
vi.mock('../../hooks/useUpcomingMeetings', () => ({
  useUpcomingMeetings: vi.fn(),
}))

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { OverviewView } from './OverviewView'
import { TimeFormatProvider } from '../../settings/timeFormat'
import { useUpcomingMeetings } from '../../hooks/useUpcomingMeetings'
import type { Meeting } from '../../types'

const mockUseUpcoming = vi.mocked(useUpcomingMeetings)

beforeEach(() => {
  // Default: no upcoming meetings → the section renders nothing.
  mockUseUpcoming.mockReturnValue({ meetings: [], loading: false, error: null })
})

const NOW = Date.now()

function makeMeeting(id: string, opts: Partial<Meeting> = {}): Meeting {
  return {
    id,
    title: `Meeting ${id}`,
    org: 'Acme Corp',
    sipUri: `sip:${id}@example.com`,
    startedAt: NOW - 5 * 60_000,
    botState: 'connected',
    attendees: [],
    ...opts,
  }
}

type Props = React.ComponentProps<typeof OverviewView>

function renderOverview(props: Partial<Props> = {}) {
  const defaults: Props = {
    meetings: [makeMeeting('m1'), makeMeeting('m2')],
    now: NOW,
    loading: false,
    error: null,
    onRetry: vi.fn(),
    onOpenMeeting: vi.fn(),
  }
  return render(
    <TimeFormatProvider>
      <OverviewView {...defaults} {...props} />
    </TimeFormatProvider>,
  )
}

// ── Header block ──────────────────────────────────────────────────────────────

describe('OverviewView — header', () => {
  it('renders "Active meetings" H1', () => {
    renderOverview()
    expect(screen.getByRole('heading', { level: 1, name: /Active meetings/ })).toBeInTheDocument()
  })

  it('renders subtitle copy', () => {
    renderOverview()
    expect(screen.getByText(/Calls currently chaperoned/)).toBeInTheDocument()
  })

  it('legend shows Connected label', () => {
    renderOverview()
    expect(screen.getByText('Connected')).toBeInTheDocument()
  })

  it('legend shows Dialing label', () => {
    renderOverview()
    expect(screen.getByText('Dialing')).toBeInTheDocument()
  })

  it('legend shows Disconnected label', () => {
    renderOverview()
    expect(screen.getByText('Disconnected')).toBeInTheDocument()
  })
})

// ── Meeting cards ─────────────────────────────────────────────────────────────

describe('OverviewView — meeting grid', () => {
  it('renders a card for each meeting', () => {
    renderOverview()
    expect(screen.getByTestId('meeting-card-m1')).toBeInTheDocument()
    expect(screen.getByTestId('meeting-card-m2')).toBeInTheDocument()
  })

  it('no "REC" text anywhere in the view', () => {
    renderOverview()
    expect(screen.queryByText(/\bREC\b/)).not.toBeInTheDocument()
  })

  it('no "recording" text anywhere in the view', () => {
    renderOverview()
    expect(screen.queryByText(/recording/i)).not.toBeInTheDocument()
  })
})

// ── Fail-LOUD: failed / disconnected cards always render ──────────────────────

describe('OverviewView — fail-LOUD', () => {
  it('failed meeting renders a card (not filtered)', () => {
    renderOverview({ meetings: [makeMeeting('m1', { botState: 'failed' })] })
    expect(screen.getByTestId('meeting-card-m1')).toBeInTheDocument()
  })

  it('disconnected meeting renders a card (not filtered)', () => {
    renderOverview({ meetings: [makeMeeting('m2', { botState: 'disconnected' })] })
    expect(screen.getByTestId('meeting-card-m2')).toBeInTheDocument()
  })

  it('failed card shows enabled "View attendees" join button (read-only entry)', () => {
    renderOverview({ meetings: [makeMeeting('m1', { botState: 'failed' })] })
    expect(screen.getByRole('button', { name: /View attendees/ })).not.toBeDisabled()
  })

  it('disconnected card shows enabled "View attendees" join button (read-only entry)', () => {
    renderOverview({ meetings: [makeMeeting('m1', { botState: 'disconnected' })] })
    expect(screen.getByRole('button', { name: /View attendees/ })).not.toBeDisabled()
  })
})

// ── Loading state ─────────────────────────────────────────────────────────────

describe('OverviewView — loading state', () => {
  it('shows skeleton when loading=true and meetings=[]', () => {
    renderOverview({ meetings: [], loading: true })
    expect(screen.getByTestId('loading-skeleton')).toBeInTheDocument()
  })

  it('shows grid (not skeleton) when loading=true but cached meetings exist', () => {
    renderOverview({ loading: true, meetings: [makeMeeting('m1')] })
    expect(screen.getByTestId('meeting-card-m1')).toBeInTheDocument()
    expect(screen.queryByTestId('loading-skeleton')).not.toBeInTheDocument()
  })

  it('does not show the meeting grid when in loading state', () => {
    renderOverview({ meetings: [], loading: true })
    expect(screen.queryByTestId('meeting-card-m1')).not.toBeInTheDocument()
  })

  it('does not show "Active meetings" heading in loading state', () => {
    renderOverview({ meetings: [], loading: true })
    expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument()
  })
})

// ── Empty state ────────────────────────────────────────────────────────────────

describe('OverviewView — empty state', () => {
  it('shows teaching copy when no meetings and not loading', () => {
    renderOverview({ meetings: [], loading: false })
    expect(
      screen.getByText(/No meetings are being chaperoned right now/),
    ).toBeInTheDocument()
  })

  it('shows bot-join description', () => {
    renderOverview({ meetings: [], loading: false })
    expect(
      screen.getByText(/Meetings appear here when a compliance bot joins a call/),
    ).toBeInTheDocument()
  })
})

// ── Error state (no cached data) ──────────────────────────────────────────────

describe('OverviewView — error state with no data', () => {
  it('shows error banner', () => {
    renderOverview({ meetings: [], error: new Error('timeout') })
    expect(screen.getByText(/Couldn't load meetings/)).toBeInTheDocument()
  })

  it('shows the error gist text', () => {
    renderOverview({ meetings: [], error: new Error('Network unreachable') })
    expect(screen.getByText('Network unreachable')).toBeInTheDocument()
  })

  it('Retry button calls onRetry', async () => {
    const onRetry = vi.fn()
    renderOverview({ meetings: [], error: new Error('fail'), onRetry })
    await userEvent.click(screen.getByRole('button', { name: /Retry/ }))
    expect(onRetry).toHaveBeenCalledOnce()
  })

  it('does not show empty-state copy when there is an error', () => {
    renderOverview({ meetings: [], error: new Error('fail') })
    expect(screen.queryByText(/No meetings are being chaperoned/)).not.toBeInTheDocument()
  })
})

// ── Error state with cached data (transient poll error) ───────────────────────

describe('OverviewView — error state with cached data', () => {
  it('keeps showing the grid when error occurs but meetings exist', () => {
    renderOverview({ error: new Error('poll fail'), meetings: [makeMeeting('m1')] })
    expect(screen.getByTestId('meeting-card-m1')).toBeInTheDocument()
  })

  it('does NOT show full error banner when meetings exist', () => {
    renderOverview({ error: new Error('poll fail'), meetings: [makeMeeting('m1')] })
    expect(screen.queryByText(/Couldn't load meetings/)).not.toBeInTheDocument()
  })

  it('shows inline "Reconnecting…" indicator', () => {
    renderOverview({ error: new Error('poll fail'), meetings: [makeMeeting('m1')] })
    expect(screen.getByText(/Reconnecting/)).toBeInTheDocument()
  })
})

// ── Upcoming meetings section ─────────────────────────────────────────────────

describe('OverviewView — upcoming meetings section', () => {
  const upcoming = {
    meetingId: 'u1',
    title: 'Pre-Market Huddle',
    scheduledStart: NOW + 10 * 60_000,
  }

  it('mounts the section BELOW the active-meetings grid when upcoming rows exist', () => {
    mockUseUpcoming.mockReturnValue({ meetings: [upcoming], loading: false, error: null })
    renderOverview()
    const region = screen.getByRole('region', { name: 'Upcoming meetings' })
    expect(region).toBeInTheDocument()
    expect(screen.getByText('Pre-Market Huddle')).toBeInTheDocument()
    // DOM order: the grid card must precede the upcoming section
    const card = screen.getByTestId('meeting-card-m1')
    expect(card.compareDocumentPosition(region) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('renders no upcoming section when there are no upcoming meetings', () => {
    renderOverview()
    expect(screen.queryByRole('region', { name: 'Upcoming meetings' })).not.toBeInTheDocument()
  })

  it('still shows the upcoming section when there are no ACTIVE meetings (empty state)', () => {
    mockUseUpcoming.mockReturnValue({ meetings: [upcoming], loading: false, error: null })
    renderOverview({ meetings: [] })
    expect(screen.getByRole('region', { name: 'Upcoming meetings' })).toBeInTheDocument()
  })
})

// ─── Active/Past partition (amendment 2026-07-10) ──────────────────────────

describe('OverviewView — Active/Past partition', () => {
  const GRACE = 15 * 60 * 1_000 // mirrors FAILURE_GRACE_MS

  it('connected meeting → active grid only; no Past section', () => {
    renderOverview({ meetings: [makeMeeting('mx', { botState: 'connected' })] })
    expect(screen.queryByRole('heading', { name: /past meetings/i })).not.toBeInTheDocument()
  })

  it('ended meeting → appears under Past heading, not in active grid', () => {
    const m = makeMeeting('mx', { botState: 'ended', endedAt: NOW - 1_000 })
    renderOverview({ meetings: [m] })
    expect(screen.getByRole('heading', { name: /past meetings/i })).toBeInTheDocument()
  })

  it('fresh-failed bot (within grace) → active only; Past section hidden', () => {
    const m = makeMeeting('mx', { botState: 'failed', endedAt: NOW - GRACE + 60_000 })
    renderOverview({ meetings: [m] })
    expect(screen.queryByRole('heading', { name: /past meetings/i })).not.toBeInTheDocument()
  })

  it('stale-failed bot (beyond grace) → Past section appears', () => {
    const m = makeMeeting('mx', { botState: 'failed', endedAt: NOW - GRACE - 1_000 })
    renderOverview({ meetings: [m] })
    expect(screen.getByRole('heading', { name: /past meetings/i })).toBeInTheDocument()
  })

  it('Past section hidden when past list is empty', () => {
    renderOverview({ meetings: [makeMeeting('mx', { botState: 'connected' })] })
    expect(screen.queryByRole('heading', { name: /past meetings/i })).not.toBeInTheDocument()
  })
})

// ── onOpenMeeting ──────────────────────────────────────────────────────────────

describe('OverviewView — onOpenMeeting', () => {
  it('clicking "Chaperone join" on a connected card calls onOpenMeeting with id', async () => {
    const onOpenMeeting = vi.fn()
    renderOverview({ meetings: [makeMeeting('m1')], onOpenMeeting })
    await userEvent.click(screen.getByRole('button', { name: /Chaperone join/ }))
    expect(onOpenMeeting).toHaveBeenCalledWith('m1')
  })
})

// ── T14: structural responsive hook ───────────────────────────────────────────
// jsdom doesn't apply CSS — assert the className hook that styles/responsive.css
// targets (container padding tightens below 760px).

describe('OverviewView — responsive layout hook', () => {
  it('page container carries the view-container class in every state', () => {
    const { container, unmount } = renderOverview()
    expect(container.querySelector('.view-container')).toBeInTheDocument()
    unmount()

    // Loading branch renders its own container — must carry the class too
    const loading = renderOverview({ meetings: [], loading: true })
    expect(loading.container.querySelector('.view-container')).toBeInTheDocument()
  })
})
