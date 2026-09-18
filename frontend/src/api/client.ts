import { getToken, redirectToLogin } from '../auth/session'
import type {
  ChaperonedMeeting,
  BotStatus,
  AuditEntry,
  Attendee,
  UpcomingMeeting,
  ScheduleMeetingInput,
  CreatedMeeting,
  RosterSource,
} from '../types'

// Dev-only mock mode (VITE_MOCK=1 → `npm run dev:mock`). The literal is inlined
// at build time, so in real builds these branches are dead code and the mock
// modules are never loaded (dynamic imports below).
const MOCK = import.meta.env.VITE_MOCK === '1'

// ─── Error type ───────────────────────────────────────────────────────────────

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

// ─── Core fetch wrapper ───────────────────────────────────────────────────────
// All requests are same-origin relative paths (SPA served by backend in prod).
// In dev the Vite proxy forwards /meetings, /audit, /auth, /live to the backend.

async function request<T>(
  path: string,
  init?: { method?: 'GET' | 'POST' | 'DELETE'; body?: unknown },
): Promise<T> {
  const token = getToken() // never log the token
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  if (token) {
    headers['Authorization'] = `Bearer ${token}` // never log this line's value
  }

  const res = await fetch(path, {
    method: init?.method ?? 'GET',
    headers,
    ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  })

  if (!res.ok) {
    let message = res.statusText
    try {
      // Backend error bodies are { error: "..." } (auth/middleware.ts,
      // meetings/routes.ts); accept { message } too for other shapes.
      const body = (await res.json()) as { message?: string; error?: string }
      const bodyMessage = body.message ?? body.error
      if (bodyMessage) message = bodyMessage
    } catch {
      // ignore JSON parse failure; fall back to statusText
    }

    if (res.status === 401) {
      redirectToLogin()
      throw new ApiError(401, message)
    }

    throw new ApiError(res.status, message)
  }

  // 204 No Content (DELETE /meetings/:id) — nothing to parse.
  if (res.status === 204) return undefined as T

  return res.json() as Promise<T>
}

// ─── Public API methods ───────────────────────────────────────────────────────

/** GET /meetings — returns all chaperoned meetings visible to the officer. */
export async function getMeetings(): Promise<
  Array<ChaperonedMeeting & { bot: BotStatus | null }>
> {
  if (MOCK) {
    const { mockGetMeetings } = await import('../mock/meetings')
    return mockGetMeetings()
  }
  const data = await request<{
    meetings: Array<ChaperonedMeeting & { bot: BotStatus | null }>
  }>('/meetings')
  return data.meetings
}

/** GET /meetings/upcoming — upcoming (not yet started) meetings on the account. */
export async function getUpcomingMeetings(): Promise<UpcomingMeeting[]> {
  if (MOCK) {
    const { mockGetUpcomingMeetings } = await import('../mock/meetings')
    return mockGetUpcomingMeetings()
  }
  const data = await request<{ meetings: UpcomingMeeting[] }>('/meetings/upcoming')
  return data.meetings
}

/** GET /meetings/:id — meeting detail + roster.
 *  `peek: true` asks the backend for a bot-independent roster snapshot when
 *  the live (rosterMonitor) cache is empty — the view-failed-meeting path.
 *  rosterSource/rosterError are additive; older payloads simply omit them. */
export async function getMeeting(
  id: string,
  opts?: { peek?: boolean },
): Promise<{
  meeting: ChaperonedMeeting
  bot: BotStatus | null
  roster: Attendee[]
  rosterSource?: RosterSource
  rosterError?: string
}> {
  if (MOCK) {
    const { mockGetMeeting } = await import('../mock/meetings')
    return mockGetMeeting(id)
  }
  const qs = opts?.peek ? '?peek=1' : ''
  return request<{
    meeting: ChaperonedMeeting
    bot: BotStatus | null
    roster: Attendee[]
    rosterSource?: RosterSource
    rosterError?: string
  }>(`/meetings/${id}${qs}`)
}

// admin-only; officer access TBD (see T12)
/** GET /audit — typed but NOT called by the console (admin-only endpoint). */
export async function getAudit(params?: {
  meetingId?: string
}): Promise<AuditEntry[]> {
  const qs =
    params?.meetingId
      ? `?meetingId=${encodeURIComponent(params.meetingId)}`
      : ''
  const data = await request<{ entries: AuditEntry[] }>(`/audit${qs}`)
  return data.entries
}

/** DELETE /meetings/:id — admin-only. Deregisters the meeting (the backend
 *  lifecycle hangs up the bot when one is live) and deletes the row plus its
 *  bot-status/presence data. 204 on success; 403 non-admin; 404 unknown id. */
export async function deleteMeeting(id: string): Promise<void> {
  if (MOCK) {
    const { mockDeleteMeeting } = await import('../mock/meetings')
    return mockDeleteMeeting(id)
  }
  await request<void>(`/meetings/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

/** POST /meetings/schedule — admin-only; creates a REAL Webex meeting
 *  (no-lobby, join-before-host) on the scheduler account. 201 → CreatedMeeting;
 *  403 → missing role or missing meeting-create scope; 400 → validation. */
export async function scheduleMeeting(input: ScheduleMeetingInput): Promise<CreatedMeeting> {
  if (MOCK) {
    const { mockScheduleMeeting } = await import('../mock/meetings')
    return mockScheduleMeeting(input)
  }
  return request<CreatedMeeting>('/meetings/schedule', { method: 'POST', body: input })
}
