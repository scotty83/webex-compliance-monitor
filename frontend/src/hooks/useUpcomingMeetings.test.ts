// RED → GREEN: useUpcomingMeetings polling hook tests (60 s cadence).
// Mocks the api/client module so fetch behaviour is controlled here.

vi.mock('../api/client', () => ({
  getUpcomingMeetings: vi.fn(),
  // ApiError is imported as a type only by useUpcomingMeetings; provided for completeness.
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
import { getUpcomingMeetings } from '../api/client'
import { useUpcomingMeetings } from './useUpcomingMeetings'
import type { UpcomingMeeting } from '../types'

const mockGetUpcoming = vi.mocked(getUpcomingMeetings)

const BASE = 1_700_000_000_000
const MIN = 60_000

function up(id: string, startInMin: number): UpcomingMeeting {
  return {
    meetingId: id,
    title: `Upcoming ${id}`,
    scheduledStart: BASE + startInMin * MIN,
  }
}

describe('useUpcomingMeetings', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.resetAllMocks()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('starts with loading:true and an empty meetings array', () => {
    // Never-resolving promise → no state updates during this synchronous assertion.
    mockGetUpcoming.mockImplementation(() => new Promise(() => {}))
    const { result } = renderHook(() => useUpcomingMeetings())

    expect(result.current.loading).toBe(true)
    expect(result.current.meetings).toEqual([])
    expect(result.current.error).toBeNull()
  })

  it('sets loading:false and populates meetings after the first fetch', async () => {
    mockGetUpcoming.mockResolvedValue([up('u1', 10), up('u2', 45)])
    const { result } = renderHook(() => useUpcomingMeetings())

    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(result.current.loading).toBe(false)
    expect(result.current.meetings).toHaveLength(2)
    expect(result.current.meetings[0].meetingId).toBe('u1')
    expect(result.current.error).toBeNull()
  })

  it('maps an empty result to no meetings and NO error', async () => {
    mockGetUpcoming.mockResolvedValue([])
    const { result } = renderHook(() => useUpcomingMeetings())

    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(result.current.loading).toBe(false)
    expect(result.current.meetings).toEqual([])
    expect(result.current.error).toBeNull()
  })

  it('re-polls at 60 s — not before — without flipping loading back to true', async () => {
    mockGetUpcoming.mockResolvedValue([up('u1', 10)])
    const { result } = renderHook(() => useUpcomingMeetings())

    // First load
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(mockGetUpcoming).toHaveBeenCalledTimes(1)
    expect(result.current.loading).toBe(false)

    // 59 s: nothing yet
    await act(async () => {
      vi.advanceTimersByTime(59_000)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(mockGetUpcoming).toHaveBeenCalledTimes(1)

    // 60 s: interval fires
    await act(async () => {
      vi.advanceTimersByTime(1_000)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(mockGetUpcoming).toHaveBeenCalledTimes(2)
    expect(result.current.loading).toBe(false) // no blank flash on poll
  })

  it('keeps last-good meetings and sets error on a poll failure', async () => {
    mockGetUpcoming.mockResolvedValueOnce([up('u1', 10)])
    const { result } = renderHook(() => useUpcomingMeetings())

    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(result.current.meetings).toHaveLength(1)
    expect(result.current.error).toBeNull()

    mockGetUpcoming.mockRejectedValueOnce(new Error('Network timeout'))
    await act(async () => {
      vi.advanceTimersByTime(60_000)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(result.current.meetings).toHaveLength(1) // last-good preserved
    expect(result.current.error).toBeInstanceOf(Error)
    expect(result.current.loading).toBe(false)
  })

  it('clears error on a subsequent successful poll', async () => {
    mockGetUpcoming
      .mockResolvedValueOnce([up('u1', 10)]) // first load ok
      .mockRejectedValueOnce(new Error('blip')) // first poll fails
      .mockResolvedValueOnce([up('u1', 10)]) // second poll recovers

    const { result } = renderHook(() => useUpcomingMeetings())

    await act(async () => { await Promise.resolve(); await Promise.resolve() })

    await act(async () => {
      vi.advanceTimersByTime(60_000)
      await Promise.resolve(); await Promise.resolve()
    })
    expect(result.current.error).not.toBeNull()

    await act(async () => {
      vi.advanceTimersByTime(60_000)
      await Promise.resolve(); await Promise.resolve()
    })
    expect(result.current.error).toBeNull()
    expect(result.current.meetings).toHaveLength(1)
  })

  it('pauses polling while the tab is hidden and resumes when visible', async () => {
    mockGetUpcoming.mockResolvedValue([up('u1', 10)])
    renderHook(() => useUpcomingMeetings())

    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(mockGetUpcoming).toHaveBeenCalledTimes(1)

    const hiddenSpy = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    await act(async () => {
      vi.advanceTimersByTime(60_000)
      await Promise.resolve(); await Promise.resolve()
    })
    expect(mockGetUpcoming).toHaveBeenCalledTimes(1) // hidden → skipped

    hiddenSpy.mockReturnValue(false)
    await act(async () => {
      vi.advanceTimersByTime(60_000)
      await Promise.resolve(); await Promise.resolve()
    })
    expect(mockGetUpcoming).toHaveBeenCalledTimes(2) // visible → resumed

    hiddenSpy.mockRestore()
  })

  it('clears the interval on unmount (no leak)', async () => {
    mockGetUpcoming.mockResolvedValue([up('u1', 10)])
    const { unmount } = renderHook(() => useUpcomingMeetings())

    await act(async () => { await Promise.resolve(); await Promise.resolve() })

    unmount()

    await act(async () => {
      vi.advanceTimersByTime(180_000)
      await Promise.resolve(); await Promise.resolve()
    })

    expect(mockGetUpcoming).toHaveBeenCalledTimes(1)
  })

  it('does not call setState after unmount when a fetch is in flight', async () => {
    let resolveDeferred!: (value: UpcomingMeeting[]) => void
    const deferred = new Promise<UpcomingMeeting[]>((res) => {
      resolveDeferred = res
    })
    mockGetUpcoming.mockReturnValue(deferred)

    const { result, unmount } = renderHook(() => useUpcomingMeetings())

    const snapshot = {
      loading: result.current.loading,
      meetings: result.current.meetings,
      error: result.current.error,
    }

    unmount()

    await act(async () => {
      resolveDeferred([up('u1', 10)])
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(result.current.loading).toBe(snapshot.loading)
    expect(result.current.meetings).toEqual(snapshot.meetings)
    expect(result.current.error).toBe(snapshot.error)
  })
})
