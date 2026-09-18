import { useCallback, useEffect, useRef, useState } from 'react'
import type { Meeting } from '../types'
import { toMeeting } from '../types'
import type { ApiError } from '../api/client'
import { getMeeting, getMeetings } from '../api/client'

const POLL_INTERVAL_MS = 5_000

// The client-side mock roster survives ONLY under VITE_MOCK (`npm run dev:mock`).
// In real mode attendees come from GET /meetings/:id (backend rosterMonitor cache).
const MOCK = import.meta.env.VITE_MOCK === '1'

/** Map raw /meetings rows to view Meetings, attaching a roster per meeting. */
async function mapMeetings(
  raw: Awaited<ReturnType<typeof getMeetings>>,
  peekMeetingId: string | null,
): Promise<Meeting[]> {
  if (MOCK) {
    // Dynamic import so real builds tree-shake the mock roster data
    // (same dead-code pattern as the VITE_MOCK guards in api/client.ts).
    const { mockRosterFor } = await import('../mock/roster')
    return raw.map((r) =>
      toMeeting(r, mockRosterFor(r, r.bot?.state === 'ended' ? r.bot.updatedAt : undefined)),
    )
  }
  return Promise.all(
    raw.map(async (r) => {
      // Real roster per meeting; org is mock-only data → '' in real mode.
      // peek: bot-independent roster snapshot, requested ONLY for the meeting
      // the officer has open AND whose bot is not in the 'ended' state.
      // An ended meeting has no live roster to peek; its stored history is
      // authoritative, so we skip peek to avoid an empty snapshot displacing
      // the persisted join/leave data before the stored fallback is reached.
      const detail = await getMeeting(r.meetingId, {
        peek: r.meetingId === peekMeetingId && r.bot?.state !== 'ended',
      })
      return toMeeting(r, {
        org: '',
        attendees: detail.roster,
        rosterSource: detail.rosterSource,
        rosterError: detail.rosterError,
      })
    }),
  )
}

export interface UseMeetingsResult {
  meetings: Meeting[]
  loading: boolean
  error: ApiError | Error | null
  refetch: () => void
}

export function useMeetings(opts?: { peekMeetingId?: string | null }): UseMeetingsResult {
  const peekMeetingId = opts?.peekMeetingId ?? null
  const [meetings, setMeetings] = useState<Meeting[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<ApiError | Error | null>(null)

  // Track whether the first load has completed so polls never flip loading→true.
  const firstLoadDone = useRef(false)
  // Flipped to false in effect cleanup; every setState is guarded by this ref
  // so that an in-flight fetch cannot call setState after the component unmounts.
  const mountedRef = useRef(true)
  // Holds the active interval ID so refetch() can restart the poll window.
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  // Latest peek target for the poll — a ref, so navigating between meetings
  // never re-creates fetchData or re-arms the 5 s interval.
  const peekIdRef = useRef<string | null>(peekMeetingId)
  peekIdRef.current = peekMeetingId

  const fetchData = useCallback(async () => {
    const isFirst = !firstLoadDone.current
    try {
      const raw = await getMeetings()
      const mapped = await mapMeetings(raw, peekIdRef.current)
      if (!mountedRef.current) return
      setMeetings(mapped)
      setError(null)
    } catch (err) {
      if (!mountedRef.current) return
      setError(err instanceof Error ? err : new Error(String(err)))
      // On first-load error: fall through to the finally block so loading→false.
    } finally {
      // finally always runs even after an early return inside try/catch, so we
      // must re-check mountedRef here too.
      if (isFirst && mountedRef.current) {
        firstLoadDone.current = true
        setLoading(false)
      }
    }
  }, [])

  // Clears any running interval and arms a fresh one. Called on mount and by
  // refetch() so that a manual retry always restarts the full 5 s window.
  const startInterval = useCallback(() => {
    if (intervalRef.current !== null) clearInterval(intervalRef.current)
    intervalRef.current = setInterval(() => {
      // Optional: pause polling when the tab is hidden to reduce server load.
      if (!document.hidden) {
        void fetchData()
      }
    }, POLL_INTERVAL_MS)
  }, [fetchData])

  useEffect(() => {
    mountedRef.current = true
    void fetchData()
    startInterval()
    return () => {
      mountedRef.current = false
      if (intervalRef.current !== null) {
        clearInterval(intervalRef.current)
        intervalRef.current = null
      }
    }
  }, [fetchData, startInterval])

  // Opening a meeting must not wait for the next 5 s tick — refetch now so
  // the peeked roster appears immediately in the chaperone view. Guarded by
  // firstLoadDone so the mount fetch isn't doubled when a meeting is already
  // open on first render.
  useEffect(() => {
    if (peekMeetingId !== null && firstLoadDone.current) void fetchData()
  }, [peekMeetingId, fetchData])

  const refetch = useCallback(() => {
    void fetchData()
    startInterval() // reset poll window so next auto-poll is a full interval away
  }, [fetchData, startInterval])

  return { meetings, loading, error, refetch }
}
