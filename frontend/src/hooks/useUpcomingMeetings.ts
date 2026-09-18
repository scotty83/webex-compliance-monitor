import { useCallback, useEffect, useRef, useState } from 'react'
import type { UpcomingMeeting } from '../types'
import type { ApiError } from '../api/client'
import { getUpcomingMeetings } from '../api/client'

// Upcoming meetings change slowly — poll once a minute (vs 5 s for active).
const POLL_INTERVAL_MS = 60_000

export interface UseUpcomingMeetingsResult {
  meetings: UpcomingMeeting[]
  loading: boolean
  error: ApiError | Error | null
}

/**
 * Polls GET /meetings/upcoming every 60 s. Mirrors useMeetings: first-load-only
 * loading, keep-last-good on poll error, mountedRef guards, hidden-tab pause.
 * No refetch — the section renders nothing on error, so there is no retry UI.
 */
export function useUpcomingMeetings(): UseUpcomingMeetingsResult {
  const [meetings, setMeetings] = useState<UpcomingMeeting[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<ApiError | Error | null>(null)

  // Track whether the first load has completed so polls never flip loading→true.
  const firstLoadDone = useRef(false)
  // Flipped to false in effect cleanup; every setState is guarded by this ref
  // so that an in-flight fetch cannot call setState after the component unmounts.
  const mountedRef = useRef(true)

  const fetchData = useCallback(async () => {
    const isFirst = !firstLoadDone.current
    try {
      const rows = await getUpcomingMeetings()
      if (!mountedRef.current) return
      setMeetings(rows)
      setError(null)
    } catch (err) {
      if (!mountedRef.current) return
      setError(err instanceof Error ? err : new Error(String(err)))
      // Keep last-good meetings — no setMeetings here.
    } finally {
      // finally always runs even after an early return inside try/catch, so we
      // must re-check mountedRef here too.
      if (isFirst && mountedRef.current) {
        firstLoadDone.current = true
        setLoading(false)
      }
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    void fetchData()
    const id = setInterval(() => {
      // Pause polling when the tab is hidden to reduce server load.
      if (!document.hidden) {
        void fetchData()
      }
    }, POLL_INTERVAL_MS)
    return () => {
      mountedRef.current = false
      clearInterval(id)
    }
  }, [fetchData])

  return { meetings, loading, error }
}
