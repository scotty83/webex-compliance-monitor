import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ChaperoneView, displayNowFor } from './ChaperoneView'
import { TimeFormatProvider } from '../../settings/timeFormat'
import type { Meeting } from '../../types'
import { useLiveAudio } from '../../hooks/useLiveAudio'
import type { UseLiveAudioResult } from '../../hooks/useLiveAudio'
import { clearListeningLog, getListeningEntries } from '../../listening/log'

// vi.mock is hoisted — module is replaced before any import resolves
vi.mock('../../hooks/useLiveAudio', () => ({ useLiveAudio: vi.fn() }))

// The listening log is module-level session state — reset between tests
beforeEach(() => {
  clearListeningLog()
})

// ── Fixtures ──────────────────────────────────────────────────────────────────

const START_TS = new Date('2024-01-15T14:00:00Z').getTime()
const NOW_TS   = new Date('2024-01-15T14:30:00Z').getTime() // 30m elapsed

function makeMeeting(opts: Partial<Meeting> = {}): Meeting {
  return {
    id: 'meet1',
    title: 'Compliance Audit',
    org: 'Apex Securities',
    sipUri: 'sip:meet@apex.com',
    startedAt: START_TS,
    botState: 'connected',
    attendees: [],
    ...opts,
  }
}

function setupHook(overrides: Partial<UseLiveAudioResult> = {}): {
  pause: ReturnType<typeof vi.fn>
  resume: ReturnType<typeof vi.fn>
} {
  const pause = vi.fn()
  const resume = vi.fn()
  vi.mocked(useLiveAudio).mockReturnValue({
    status: 'listening',
    levels: Array<number>(9).fill(0.5),
    error: undefined,
    pause,
    resume,
    ...overrides,
  })
  return { pause, resume }
}

function renderChaperone(
  meeting: Meeting | undefined,
  onBack = vi.fn(),
  opts: { meetings?: Meeting[]; onOpenMeeting?: (id: string) => void } = {},
) {
  const onOpenMeeting = opts.onOpenMeeting ?? vi.fn()
  const ui = (m: Meeting | undefined) => (
    <TimeFormatProvider>
      <ChaperoneView
        activeMeeting={m}
        meetings={opts.meetings ?? (m ? [m] : [])}
        now={NOW_TS}
        onBackToOverview={onBack}
        onOpenMeeting={onOpenMeeting}
      />
    </TimeFormatProvider>
  )
  const view = render(ui(meeting))
  return {
    ...view,
    onOpenMeeting,
    /** Re-render with a (possibly different) active meeting — same mount. */
    rerenderWith: (m: Meeting | undefined) => view.rerender(ui(m)),
  }
}

// ── Graceful fallback ─────────────────────────────────────────────────────────

describe('ChaperoneView — missing activeMeeting', () => {
  it('renders fallback message instead of crashing', () => {
    setupHook()
    renderChaperone(undefined)
    expect(screen.getByText(/no longer available/i)).toBeInTheDocument()
  })

  it('fallback Back button calls onBackToOverview', async () => {
    setupHook()
    const onBack = vi.fn()
    renderChaperone(undefined, onBack)
    await userEvent.click(screen.getByRole('button', { name: /back to overview/i }))
    expect(onBack).toHaveBeenCalledOnce()
  })
})

// ── MeetingBar — navigation ───────────────────────────────────────────────────

describe('ChaperoneView — Back button', () => {
  it('clicking Back calls onBackToOverview', async () => {
    setupHook()
    const onBack = vi.fn()
    renderChaperone(makeMeeting(), onBack)
    await userEvent.click(screen.getByRole('button', { name: /back to overview/i }))
    expect(onBack).toHaveBeenCalledOnce()
  })
})

// ── MeetingBar — content ──────────────────────────────────────────────────────

describe('ChaperoneView — meeting info', () => {
  it('renders the meeting title', () => {
    setupHook()
    renderChaperone(makeMeeting())
    expect(screen.getByRole('heading', { name: /Compliance Audit/ })).toBeInTheDocument()
  })

  it('does NOT render a "REC" badge', () => {
    setupHook()
    renderChaperone(makeMeeting())
    expect(screen.queryByText(/\bREC\b/)).not.toBeInTheDocument()
  })

  it('renders org name', () => {
    setupHook()
    renderChaperone(makeMeeting())
    expect(screen.getByText('Apex Securities')).toBeInTheDocument()
  })

  it('renders BotStatusIndicator for the meeting', () => {
    setupHook()
    renderChaperone(makeMeeting({ botState: 'connected' }))
    expect(screen.getByRole('status', { name: /Bot Connected/i })).toBeInTheDocument()
  })

  it('shows elapsed time in the sub-line', () => {
    setupHook()
    renderChaperone(makeMeeting())
    // 30 min elapsed → "30m" in the "Started …" sub-line (PresenceTimeline
    // shows "30m window" and ListeningActivity can show "Started listening",
    // so scope to the sub-line via its "Started ·" direct text)
    expect(screen.getByText(/Started ·/)).toHaveTextContent('30m')
  })
})

// ── Live audio status label ───────────────────────────────────────────────────

describe('ChaperoneView — status label', () => {
  it('shows "Listening" when status is listening', () => {
    setupHook({ status: 'listening' })
    renderChaperone(makeMeeting())
    expect(screen.getByText('Listening')).toBeInTheDocument()
  })

  it('shows "Paused" when status is paused', () => {
    setupHook({ status: 'paused', levels: Array<number>(9).fill(0) })
    renderChaperone(makeMeeting())
    expect(screen.getByText('Paused')).toBeInTheDocument()
  })

  it('shows "Connecting…" when status is connecting', () => {
    setupHook({ status: 'connecting' })
    renderChaperone(makeMeeting())
    expect(screen.getByText('Connecting…')).toBeInTheDocument()
  })
})

// ── Fail-LOUD error states ────────────────────────────────────────────────────

describe('ChaperoneView — error display', () => {
  it('shows "Bot not connected" for 4404 error (fail-LOUD)', () => {
    setupHook({
      status: 'error',
      error: { code: 4404, message: 'Bot not connected' },
    })
    renderChaperone(makeMeeting())
    expect(screen.getByText('Bot not connected')).toBeInTheDocument()
  })

  it('shows auth error message for 4401', () => {
    setupHook({
      status: 'error',
      error: { code: 4401, message: 'Session expired — sign in again' },
    })
    renderChaperone(makeMeeting())
    expect(screen.getByText('Session expired — sign in again')).toBeInTheDocument()
  })
})

// ── Pause / Resume controls ───────────────────────────────────────────────────

describe('ChaperoneView — Pause/Resume controls', () => {
  it('shows Pause button when listening', () => {
    setupHook({ status: 'listening' })
    renderChaperone(makeMeeting())
    expect(screen.getByRole('button', { name: /pause audio/i })).toBeInTheDocument()
  })

  it('clicking Pause calls live.pause()', async () => {
    const { pause } = setupHook({ status: 'listening' })
    renderChaperone(makeMeeting())
    await userEvent.click(screen.getByRole('button', { name: /pause audio/i }))
    expect(pause).toHaveBeenCalledOnce()
  })

  it('shows Resume button when paused', () => {
    setupHook({ status: 'paused', levels: Array<number>(9).fill(0) })
    renderChaperone(makeMeeting())
    expect(screen.getByRole('button', { name: /resume audio/i })).toBeInTheDocument()
  })

  it('clicking Resume calls live.resume()', async () => {
    const { resume } = setupHook({ status: 'paused', levels: Array<number>(9).fill(0) })
    renderChaperone(makeMeeting())
    await userEvent.click(screen.getByRole('button', { name: /resume audio/i }))
    expect(resume).toHaveBeenCalledOnce()
  })
})

// ── Reconnect control (error state must not be a dead end) ───────────────────

describe('ChaperoneView — Reconnect control', () => {
  it('shows a Reconnect button when live status is error', () => {
    setupHook({
      status: 'error',
      error: { message: 'Connection lost (1006)' },
      levels: Array<number>(9).fill(0),
    })
    renderChaperone(makeMeeting())
    expect(screen.getByRole('button', { name: /reconnect audio/i })).toBeInTheDocument()
  })

  it('clicking Reconnect calls live.resume()', async () => {
    const { resume } = setupHook({
      status: 'error',
      error: { message: 'Connection lost (1006)' },
      levels: Array<number>(9).fill(0),
    })
    renderChaperone(makeMeeting())
    await userEvent.click(screen.getByRole('button', { name: /reconnect audio/i }))
    expect(resume).toHaveBeenCalledOnce()
  })
})

// ── AttendeesPanel integration ────────────────────────────────────────────────

describe('ChaperoneView — attendees panel', () => {
  it('renders the AttendeesPanel with the meeting roster', () => {
    setupHook()
    renderChaperone(
      makeMeeting({
        attendees: [
          {
            id: 'a1',
            name: 'Alex Chen',
            role: 'analyst',
            isHost: false,
            joinedAt: START_TS,
            leftAt: null,
          },
        ],
      }),
    )
    const panel = screen.getByRole('region', { name: 'Attendees' })
    // Scoped: PresenceTimeline renders the same names in its lane gutters
    expect(within(panel).getByText('Alex Chen')).toBeInTheDocument()
  })
})

// ── PresenceTimeline integration ──────────────────────────────────────────────

describe('ChaperoneView — presence timeline', () => {
  it('renders the PresenceTimeline for the active meeting', () => {
    setupHook()
    renderChaperone(makeMeeting())
    expect(screen.getByRole('heading', { name: 'Presence timeline' })).toBeInTheDocument()
    expect(screen.getByRole('img', { name: /^Presence timeline:/ })).toBeInTheDocument()
  })
})

// ── AudioMeter integration ────────────────────────────────────────────────────

describe('ChaperoneView — AudioMeter', () => {
  it('renders exactly 9 audio meter bars', () => {
    setupHook({ status: 'listening' })
    renderChaperone(makeMeeting())
    expect(screen.getAllByTestId(/^audio-bar-/)).toHaveLength(9)
  })
})

// ── T12: right-column panels ──────────────────────────────────────────────────

describe('ChaperoneView — right column panels', () => {
  it('renders OtherMeetings excluding the active meeting', () => {
    setupHook()
    const active = makeMeeting()
    const other = makeMeeting({ id: 'meet2', title: 'Parallel Call' })
    renderChaperone(active, vi.fn(), { meetings: [active, other] })
    const panel = screen.getByRole('region', { name: 'Other active meetings' })
    expect(within(panel).getByText('Parallel Call')).toBeInTheDocument()
    expect(within(panel).queryByText('Compliance Audit')).not.toBeInTheDocument()
  })

  it('clicking a connected other-meeting row calls onOpenMeeting with its id', async () => {
    setupHook()
    const active = makeMeeting()
    const other = makeMeeting({ id: 'meet2', title: 'Parallel Call', botState: 'connected' })
    const { onOpenMeeting } = renderChaperone(active, vi.fn(), { meetings: [active, other] })
    await userEvent.click(screen.getByRole('button', { name: /Parallel Call/ }))
    expect(onOpenMeeting).toHaveBeenCalledWith('meet2')
  })

  it('renders the ListeningActivity panel', () => {
    setupHook()
    renderChaperone(makeMeeting())
    expect(screen.getByRole('region', { name: 'Listening activity' })).toBeInTheDocument()
  })
})

// ── Task 8: read-only mode for a non-connected bot ───────────────────────────

describe('ChaperoneView — read-only for a non-connected bot', () => {
  it('failed bot: useLiveAudio is called with active:false (NEVER opens the live WS)', () => {
    setupHook()
    renderChaperone(makeMeeting({ botState: 'failed' }))
    const calls = vi.mocked(useLiveAudio).mock.calls
    const lastCall = calls[calls.length - 1]!
    expect(lastCall[0]).toMatchObject({ active: false })
  })

  it('connected bot: active:true (live path unchanged — regression pin)', () => {
    setupHook()
    renderChaperone(makeMeeting({ botState: 'connected' }))
    const calls = vi.mocked(useLiveAudio).mock.calls
    const lastCall = calls[calls.length - 1]!
    expect(lastCall[0]).toMatchObject({ active: true })
  })

  it('failed bot: shows the view-only badge and hides audio controls', () => {
    setupHook()
    renderChaperone(makeMeeting({ botState: 'failed' }))
    expect(screen.getByTestId('view-only-badge')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Pause audio/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Reconnect/ })).not.toBeInTheDocument()
  })

  it('failed bot with lastError: the fail-loud error is visible', () => {
    setupHook()
    renderChaperone(makeMeeting({ botState: 'failed', lastError: 'SIP 488 Not Acceptable Here' }))
    expect(screen.getByText('SIP 488 Not Acceptable Here')).toBeInTheDocument()
  })

  it('peek roster: attendees render, presence timeline replaced by the snapshot note', () => {
    setupHook()
    renderChaperone(makeMeeting({ botState: 'failed', rosterSource: 'peek' }))
    expect(screen.getByTestId('peek-note')).toBeInTheDocument()
    expect(screen.queryByText(/Presence timeline/i)).not.toBeInTheDocument()
  })

  it('rosterError: an alert panel names the failure (fail-loud)', () => {
    setupHook()
    renderChaperone(
      makeMeeting({
        botState: 'failed',
        attendees: [],
        rosterSource: 'none',
        rosterError: 'roster peek failed: Webex API error 502 for /meetingParticipants',
      }),
    )
    expect(screen.getByRole('alert')).toHaveTextContent(/roster peek failed/)
  })
})

// ── displayNowFor — frozen clock for read-only history ────────────────────────

describe('displayNowFor — frozen clock for read-only history', () => {
  it('returns endedAt when read-only and the end time is known', () => {
    expect(displayNowFor(true, 5_000, 9_999)).toBe(5_000)
  })
  it('returns live now otherwise', () => {
    expect(displayNowFor(false, 5_000, 9_999)).toBe(9_999)
    expect(displayNowFor(true, undefined, 9_999)).toBe(9_999)
  })
})

// ── T14: structural responsive hooks ─────────────────────────────────────────
// jsdom doesn't apply CSS, so we assert the className hooks that
// styles/responsive.css targets (2-col → 1-col below 760px; sticky released).

describe('ChaperoneView — responsive layout hooks', () => {
  it('content grid carries the chaperone-grid class', () => {
    setupHook()
    const { container } = renderChaperone(makeMeeting())
    expect(container.querySelector('.chaperone-grid')).toBeInTheDocument()
  })

  it('right column carries the chaperone-side class and holds the side panels', () => {
    setupHook()
    const { container } = renderChaperone(makeMeeting())
    const side = container.querySelector('.chaperone-side')
    expect(side).toBeInTheDocument()
    expect(
      within(side as HTMLElement).getByRole('region', { name: 'Other active meetings' }),
    ).toBeInTheDocument()
    expect(
      within(side as HTMLElement).getByRole('region', { name: 'Listening activity' }),
    ).toBeInTheDocument()
  })
})

// ── T12: session listening log recording ─────────────────────────────────────

describe('ChaperoneView — listening log recording', () => {
  it('records listen_start when status transitions connecting → listening', () => {
    setupHook({ status: 'connecting' })
    const { rerenderWith } = renderChaperone(makeMeeting())
    expect(getListeningEntries()).toHaveLength(0)

    setupHook({ status: 'listening' })
    rerenderWith(makeMeeting())

    expect(getListeningEntries()).toHaveLength(1)
    expect(getListeningEntries()[0]).toMatchObject({
      action: 'listen_start',
      meetingId: 'meet1',
      title: 'Compliance Audit',
    })
  })

  it('records listen_stop on pause and listen_start again on resume', () => {
    setupHook({ status: 'listening' })
    const { rerenderWith } = renderChaperone(makeMeeting())
    expect(getListeningEntries()[0]).toMatchObject({ action: 'listen_start' })

    // Pause → stop
    setupHook({ status: 'paused', levels: Array<number>(9).fill(0) })
    rerenderWith(makeMeeting())
    expect(getListeningEntries()[0]).toMatchObject({
      action: 'listen_stop',
      meetingId: 'meet1',
    })

    // Resume: paused → connecting → listening ⇒ start
    setupHook({ status: 'connecting' })
    rerenderWith(makeMeeting())
    setupHook({ status: 'listening' })
    rerenderWith(makeMeeting())
    expect(getListeningEntries()).toHaveLength(3)
    expect(getListeningEntries()[0]).toMatchObject({
      action: 'listen_start',
      meetingId: 'meet1',
    })
  })

  it('records listen_stop when unmounted while listening', () => {
    setupHook({ status: 'listening' })
    const { unmount } = renderChaperone(makeMeeting())
    expect(getListeningEntries()).toHaveLength(1)

    unmount()

    expect(getListeningEntries()).toHaveLength(2)
    expect(getListeningEntries()[0]).toMatchObject({
      action: 'listen_stop',
      meetingId: 'meet1',
      title: 'Compliance Audit',
    })
  })

  it('a meeting switch records stop for the OLD meeting and start for the NEW', () => {
    const m1 = makeMeeting({ id: 'meet1', title: 'First Call' })
    const m2 = makeMeeting({ id: 'meet2', title: 'Second Call' })

    setupHook({ status: 'listening' })
    const { rerenderWith } = renderChaperone(m1, vi.fn(), { meetings: [m1, m2] })

    // Switch: App swaps activeMeeting while the old WS is still 'listening'
    // (stale render), then useLiveAudio tears down (→ connecting) and the new
    // meeting's hello arrives (→ listening).
    setupHook({ status: 'listening' })
    rerenderWith(m2)
    setupHook({ status: 'connecting' })
    rerenderWith(m2)
    setupHook({ status: 'listening' })
    rerenderWith(m2)

    const actions = getListeningEntries().map((e) => `${e.action}:${e.meetingId}`)
    // Newest-first: start(new) ← stop(old) ← start(old)
    expect(actions).toEqual(['listen_start:meet2', 'listen_stop:meet1', 'listen_start:meet1'])
    // Attribution: the stop carries the OLD meeting's title
    expect(getListeningEntries()[1]?.title).toBe('First Call')
    expect(getListeningEntries()[0]?.title).toBe('Second Call')
  })

  it('recorded entries render in the ListeningActivity panel', () => {
    setupHook({ status: 'listening' })
    renderChaperone(makeMeeting())
    const panel = screen.getByRole('region', { name: 'Listening activity' })
    expect(within(panel).getByText('Started listening')).toBeInTheDocument()
    expect(within(panel).getByText('Compliance Audit')).toBeInTheDocument()
  })
})
