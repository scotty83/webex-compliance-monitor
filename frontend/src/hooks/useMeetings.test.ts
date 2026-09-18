// RED → GREEN: useMeetings polling hook tests
// Mocks the api/client module so fetch behaviour is controlled here.

vi.mock('../api/client', () => ({
  getMeetings: vi.fn(),
  getMeeting: vi.fn(),
  // ApiError is imported as a type only by useMeetings; provide it for completeness.
  ApiError: class ApiError extends Error {
    status: number
    constructor(status: number, message: string) {
      super(message)
      this.name = 'ApiError'
      this.status = status
    }
  },
}))

import { renderHook, act } from '@testing-library/react'
import { getMeeting, getMeetings } from '../api/client'
import { useMeetings } from './useMeetings'

const rawMeeting = {
  meetingId: 'meeting-abc',
  sipUri: 'sip:room@example.com',
  title: 'Q3 Earnings Call',
  createdAt: 1_700_000_000_000,
  bot: {
    meetingId: 'meeting-abc',
    state: 'connected' as const,
    joinedAt: 1_700_000_060_000,
    updatedAt: 1_700_000_120_000,
  },
}

const mockGetMeetings = vi.mocked(getMeetings)
const mockGetMeetingDetail = vi.mocked(getMeeting)

// Real-mode roster returned by GET /meetings/:id (backend rosterMonitor cache).
const realAttendee = {
  id: 'p-fo',
  name: 'Dana Host',
  role: 'fo' as const,
  isHost: true,
  joinedAt: 1_700_000_030_000,
  leftAt: null,
}

// fetchData now chains getMeetings → Promise.all(getMeeting …) → setState;
// flush generously so every await settles under fake timers.
async function flushMicrotasks(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve()
}

describe('useMeetings', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.resetAllMocks()
    mockGetMeetingDetail.mockResolvedValue({
      meeting: {
        meetingId: 'meeting-abc',
        sipUri: 'sip:room@example.com',
        title: 'Q3 Earnings Call',
        createdAt: 1_700_000_000_000,
      },
      bot: rawMeeting.bot,
      roster: [realAttendee],
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('starts with loading:true and an empty meetings array', () => {
    // Use a never-resolving promise so no state updates happen during this
    // synchronous assertion — avoids "not wrapped in act()" warnings.
    mockGetMeetings.mockImplementation(() => new Promise(() => {}))
    const { result } = renderHook(() => useMeetings())

    expect(result.current.loading).toBe(true)
    expect(result.current.meetings).toEqual([])
    expect(result.current.error).toBeNull()
  })

  it('sets loading:false and populates meetings after first fetch', async () => {
    mockGetMeetings.mockResolvedValue([rawMeeting])
    const { result } = renderHook(() => useMeetings())

    await act(async () => {
      // flush the resolved promise microtasks
      await flushMicrotasks()
    })

    expect(result.current.loading).toBe(false)
    expect(result.current.meetings).toHaveLength(1)
    // toMeeting maps meetingId → id
    expect(result.current.meetings[0].id).toBe('meeting-abc')
    // botState comes from bot.state
    expect(result.current.meetings[0].botState).toBe('connected')
    // Real mode: attendees come from GET /meetings/:id; org is not in the
    // contract → '' (the mock roster survives only under VITE_MOCK).
    expect(result.current.meetings[0].org).toBe('')
    expect(result.current.meetings[0].attendees).toEqual([realAttendee])
    expect(mockGetMeetingDetail).toHaveBeenCalledWith('meeting-abc', { peek: false })
  })

  it('re-polls after ~5 s without flipping loading back to true', async () => {
    mockGetMeetings.mockResolvedValue([rawMeeting])
    const { result } = renderHook(() => useMeetings())

    // First load
    await act(async () => {
      await flushMicrotasks()
    })
    expect(result.current.loading).toBe(false)

    // Advance 5 s — setInterval fires
    await act(async () => {
      vi.advanceTimersByTime(5_000)
      await flushMicrotasks()
    })

    expect(result.current.loading).toBe(false)   // no blank-screen flash
    expect(mockGetMeetings).toHaveBeenCalledTimes(2)
  })

  it('keeps last-good meetings and sets error on a poll failure', async () => {
    mockGetMeetings.mockResolvedValueOnce([rawMeeting])
    const { result } = renderHook(() => useMeetings())

    // First load succeeds
    await act(async () => {
      await flushMicrotasks()
    })
    expect(result.current.meetings).toHaveLength(1)
    expect(result.current.error).toBeNull()

    // Second call (poll) fails
    mockGetMeetings.mockRejectedValueOnce(new Error('Network timeout'))
    await act(async () => {
      vi.advanceTimersByTime(5_000)
      await flushMicrotasks()
    })

    expect(result.current.meetings).toHaveLength(1)   // last-good preserved
    expect(result.current.error).toBeInstanceOf(Error)
    expect(result.current.loading).toBe(false)
  })

  it('keeps last-good meetings and sets error when ONE per-meeting detail fetch fails mid-poll', async () => {
    // Pins the N+1 failure path: the per-meeting getMeeting calls run inside
    // the same try as the list fetch, so a single detail rejection must land
    // in the catch → keep-last-good + error, same as a list failure.
    const rawMeetingB = {
      ...rawMeeting,
      meetingId: 'meeting-def',
      bot: { ...rawMeeting.bot, meetingId: 'meeting-def' },
    }
    mockGetMeetings.mockResolvedValue([rawMeeting, rawMeetingB])
    const { result } = renderHook(() => useMeetings())

    // First load succeeds (beforeEach detail mock resolves for every id).
    await act(async () => {
      await flushMicrotasks()
    })
    expect(result.current.meetings).toHaveLength(2)
    expect(result.current.error).toBeNull()

    // Next poll: the list resolves, but ONE of the two detail fetches rejects.
    mockGetMeetingDetail.mockImplementation(async (id) => {
      if (id === 'meeting-def') throw new Error('detail fetch failed')
      return {
        meeting: {
          meetingId: 'meeting-abc',
          sipUri: 'sip:room@example.com',
          title: 'Q3 Earnings Call',
          createdAt: 1_700_000_000_000,
        },
        bot: rawMeeting.bot,
        roster: [realAttendee],
      }
    })
    await act(async () => {
      vi.advanceTimersByTime(5_000)
      await flushMicrotasks()
    })

    expect(result.current.meetings).toHaveLength(2)   // last-good preserved
    expect(result.current.error).toBeInstanceOf(Error)
    expect(result.current.loading).toBe(false)
  })

  it('clears error on a subsequent successful poll', async () => {
    mockGetMeetings
      .mockResolvedValueOnce([rawMeeting])   // first load ok
      .mockRejectedValueOnce(new Error('blip')) // first poll fails
      .mockResolvedValueOnce([rawMeeting])   // second poll recovers

    const { result } = renderHook(() => useMeetings())

    await act(async () => { await flushMicrotasks() })

    // first poll — error
    await act(async () => {
      vi.advanceTimersByTime(5_000)
      await flushMicrotasks()
    })
    expect(result.current.error).not.toBeNull()

    // second poll — recover
    await act(async () => {
      vi.advanceTimersByTime(5_000)
      await flushMicrotasks()
    })
    expect(result.current.error).toBeNull()
    expect(result.current.meetings).toHaveLength(1)
  })

  it('exposes a refetch() function that triggers an immediate fetch', async () => {
    mockGetMeetings.mockResolvedValue([rawMeeting])
    const { result } = renderHook(() => useMeetings())

    await act(async () => { await flushMicrotasks() })
    expect(mockGetMeetings).toHaveBeenCalledTimes(1)

    await act(async () => {
      result.current.refetch()
      await flushMicrotasks()
    })
    expect(mockGetMeetings).toHaveBeenCalledTimes(2)
  })

  it('clears the interval on unmount (no act warning / leak)', async () => {
    mockGetMeetings.mockResolvedValue([rawMeeting])
    const { unmount } = renderHook(() => useMeetings())

    await act(async () => { await flushMicrotasks() })

    unmount()

    // Advance past interval — should NOT trigger another fetch
    await act(async () => {
      vi.advanceTimersByTime(10_000)
      await flushMicrotasks()
    })

    expect(mockGetMeetings).toHaveBeenCalledTimes(1)
  })

  it('does not call setState after unmount when a fetch is in flight', async () => {
    // Deferred promise — we control exactly when getMeetings resolves.
    let resolveDeferred!: (value: typeof rawMeeting[]) => void
    const deferred = new Promise<typeof rawMeeting[]>((res) => {
      resolveDeferred = res
    })
    mockGetMeetings.mockReturnValue(deferred)

    const { result, unmount } = renderHook(() => useMeetings())

    // Snapshot state immediately after mount (fetch is in flight, not yet resolved).
    const snapshot = {
      loading: result.current.loading,
      meetings: result.current.meetings,
      error: result.current.error,
    }

    // Unmount BEFORE the in-flight fetch resolves.
    unmount()

    // Now resolve the deferred promise — the mountedRef guard must prevent any
    // setState from running on the now-dead component.
    await act(async () => {
      resolveDeferred([rawMeeting])
      await flushMicrotasks()
    })

    // renderHook freezes result.current after unmount; the snapshot must be
    // unchanged — no state update should have propagated.
    expect(result.current.loading).toBe(snapshot.loading)
    expect(result.current.meetings).toEqual(snapshot.meetings)
    expect(result.current.error).toBe(snapshot.error)
  })

  it('refetch() resets the poll window so the next auto-poll is a full interval away', async () => {
    mockGetMeetings.mockResolvedValue([rawMeeting])
    const { result } = renderHook(() => useMeetings())

    // First load completes (T=0).
    await act(async () => { await flushMicrotasks() })
    expect(mockGetMeetings).toHaveBeenCalledTimes(1)

    // At T=3 s: call refetch() before the original T=5 s auto-poll fires.
    await act(async () => { vi.advanceTimersByTime(3_000) })
    await act(async () => {
      result.current.refetch()
      await flushMicrotasks()
    })
    expect(mockGetMeetings).toHaveBeenCalledTimes(2) // refetch fired immediately

    // At T=5 s: the original interval would have fired here — it must NOT
    // because refetch() restarted the window.
    await act(async () => {
      vi.advanceTimersByTime(2_000) // advance to T=5 s
      await flushMicrotasks()
    })
    expect(mockGetMeetings).toHaveBeenCalledTimes(2) // no extra fetch

    // At T=8 s: the restarted interval (T=3 s + 5 s) fires.
    await act(async () => {
      vi.advanceTimersByTime(3_000) // advance to T=8 s
      await flushMicrotasks()
    })
    expect(mockGetMeetings).toHaveBeenCalledTimes(3)
  })

  it('an empty real roster maps to empty attendees — no mock fallback in real mode', async () => {
    mockGetMeetings.mockResolvedValue([rawMeeting])
    mockGetMeetingDetail.mockResolvedValue({
      meeting: {
        meetingId: 'meeting-abc',
        sipUri: 'sip:room@example.com',
        title: 'Q3 Earnings Call',
        createdAt: 1_700_000_000_000,
      },
      bot: rawMeeting.bot,
      roster: [],
    })
    const { result } = renderHook(() => useMeetings())
    await act(async () => { await flushMicrotasks() })
    expect(result.current.meetings[0].attendees).toEqual([])
  })
})

describe('useMeetings — roster peek for the open meeting', () => {
  it('passes peek:true ONLY for the peekMeetingId', async () => {
    mockGetMeetings.mockResolvedValue([rawMeeting, { ...rawMeeting, meetingId: 'meeting-def' }])
    renderHook(() => useMeetings({ peekMeetingId: 'meeting-def' }))
    await act(async () => { await flushMicrotasks() })
    const byId = new Map(mockGetMeetingDetail.mock.calls.map((c) => [c[0], c[1]]))
    expect(byId.get('meeting-abc')).toEqual({ peek: false })
    expect(byId.get('meeting-def')).toEqual({ peek: true })
  })

  it('setting peekMeetingId (opening a meeting) triggers an immediate refetch', async () => {
    mockGetMeetings.mockResolvedValue([rawMeeting])
    const { rerender } = renderHook(
      ({ peekId }: { peekId: string | null }) => useMeetings({ peekMeetingId: peekId }),
      { initialProps: { peekId: null as string | null } },
    )
    await act(async () => { await flushMicrotasks() })
    const before = mockGetMeetings.mock.calls.length
    rerender({ peekId: 'meeting-abc' })
    await act(async () => { await flushMicrotasks() })
    expect(mockGetMeetings.mock.calls.length).toBe(before + 1)
  })

  it('rosterSource/rosterError from the detail land on the mapped Meeting', async () => {
    mockGetMeetings.mockResolvedValue([rawMeeting])
    mockGetMeetingDetail.mockResolvedValue({
      meeting: { meetingId: 'meeting-abc', sipUri: 'sip:room@example.com', title: 'Q3 Earnings Call', createdAt: 1 },
      bot: null,
      roster: [realAttendee],
      rosterSource: 'peek',
      rosterError: undefined,
    })
    const { result } = renderHook(() => useMeetings({ peekMeetingId: 'meeting-abc' }))
    await act(async () => { await flushMicrotasks() })
    expect(result.current.meetings[0]?.rosterSource).toBe('peek')
    expect(result.current.meetings[0]?.attendees).toEqual([realAttendee])
  })
})
