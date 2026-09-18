// RED → GREEN: typed API client tests
// vi.mock is hoisted by Vitest; imports below reference the mocked module.

vi.mock('../auth/session', () => ({
  getToken: vi.fn(),
  redirectToLogin: vi.fn(),
}))

import { getToken, redirectToLogin } from '../auth/session'
import { getMeetings, getMeeting, getUpcomingMeetings, scheduleMeeting, ApiError } from './client'

const mockGetToken = vi.mocked(getToken)
const mockRedirectToLogin = vi.mocked(redirectToLogin)

function mockFetch(status: number, body: unknown): void {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response)
}

describe('ApiError', () => {
  it('is an instance of Error with a status code', () => {
    const err = new ApiError(500, 'Internal Server Error')
    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(ApiError)
    expect(err.status).toBe(500)
    expect(err.message).toBe('Internal Server Error')
  })
})

describe('getMeetings()', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('returns the unwrapped meetings array on 200', async () => {
    const meetings = [
      {
        meetingId: 'm1',
        sipUri: 'sip:room@example.com',
        title: 'Q3 Earnings',
        createdAt: 1_000_000,
        bot: null,
      },
    ]
    mockGetToken.mockReturnValue('tok')
    mockFetch(200, { meetings })

    const result = await getMeetings()
    expect(result).toEqual(meetings)
  })

  it('sets Authorization: Bearer <token> when a token exists', async () => {
    mockGetToken.mockReturnValue('super-secret')
    mockFetch(200, { meetings: [] })

    await getMeetings()

    expect(globalThis.fetch).toHaveBeenCalledWith(
      '/meetings',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer super-secret',
        }),
      }),
    )
  })

  it('omits the Authorization header when there is no token', async () => {
    mockGetToken.mockReturnValue(null)
    mockFetch(200, { meetings: [] })

    await getMeetings()

    const [, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ]
    expect((init.headers as Record<string, string>)['Authorization']).toBeUndefined()
  })

  it('throws ApiError with the HTTP status on a non-401 error response', async () => {
    mockGetToken.mockReturnValue('tok')
    mockFetch(500, { message: 'Server boom' })

    await expect(getMeetings()).rejects.toBeInstanceOf(ApiError)
    // second call to get the status
    mockFetch(500, { message: 'Server boom' })
    await expect(getMeetings()).rejects.toMatchObject({ status: 500 })
  })

  it('calls redirectToLogin() and throws on a 401 response', async () => {
    mockGetToken.mockReturnValue('expired')
    mockFetch(401, { message: 'Unauthorized' })

    await expect(getMeetings()).rejects.toThrow()
    expect(mockRedirectToLogin).toHaveBeenCalledTimes(1)
  })

  it('throws ApiError (not a redirect) on a 403 response', async () => {
    mockGetToken.mockReturnValue('tok')
    mockFetch(403, { message: 'Forbidden' })

    await expect(getMeetings()).rejects.toBeInstanceOf(ApiError)
    expect(mockRedirectToLogin).not.toHaveBeenCalled()
  })
})

describe('error body shapes', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('reads the message from a backend { error: "..." } body', async () => {
    // The backend consistently sends { error: "..." } (auth/middleware.ts,
    // meetings/routes.ts) — the client must surface it, not a blank statusText.
    mockGetToken.mockReturnValue('tok')
    mockFetch(500, { error: 'boom from backend' })

    await expect(getMeetings()).rejects.toMatchObject({
      status: 500,
      message: 'boom from backend',
    })
  })

  it('surfaces { error } on a 401 body too (redirect still fires)', async () => {
    mockGetToken.mockReturnValue('expired')
    mockFetch(401, { error: 'invalid or expired token' })

    await expect(getMeetings()).rejects.toMatchObject({
      status: 401,
      message: 'invalid or expired token',
    })
    expect(mockRedirectToLogin).toHaveBeenCalledTimes(1)
  })

  it('prefers body.message over body.error when both are present', async () => {
    mockGetToken.mockReturnValue('tok')
    mockFetch(500, { message: 'from message', error: 'from error' })

    await expect(getMeetings()).rejects.toMatchObject({ message: 'from message' })
  })
})

describe('getUpcomingMeetings()', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('returns the unwrapped meetings array on 200', async () => {
    const meetings = [
      { meetingId: 'u1', title: 'Pre-Market Huddle', scheduledStart: 1_700_000_600_000 },
    ]
    mockGetToken.mockReturnValue('tok')
    mockFetch(200, { meetings })

    const result = await getUpcomingMeetings()
    expect(result).toEqual(meetings)
    expect(globalThis.fetch).toHaveBeenCalledWith('/meetings/upcoming', expect.anything())
  })

  it('404 is NOT special-cased (endpoint exists) — throws ApiError(404)', async () => {
    mockGetToken.mockReturnValue('tok')
    mockFetch(404, { message: 'Not Found' })

    await expect(getUpcomingMeetings()).rejects.toMatchObject({ status: 404 })
  })

  it('500 throws ApiError with status', async () => {
    mockGetToken.mockReturnValue('tok')
    mockFetch(500, { message: 'Server boom' })

    await expect(getUpcomingMeetings()).rejects.toBeInstanceOf(ApiError)
    mockFetch(500, { message: 'Server boom' })
    await expect(getUpcomingMeetings()).rejects.toMatchObject({ status: 500 })
  })

  it('401 keeps redirecting via the request wrapper and rethrows', async () => {
    mockGetToken.mockReturnValue('expired')
    mockFetch(401, { message: 'Unauthorized' })

    await expect(getUpcomingMeetings()).rejects.toMatchObject({ status: 401 })
    expect(mockRedirectToLogin).toHaveBeenCalledTimes(1)
  })

  it('403 throws, no redirect', async () => {
    mockGetToken.mockReturnValue('tok')
    mockFetch(403, { message: 'Forbidden' })

    await expect(getUpcomingMeetings()).rejects.toMatchObject({ status: 403 })
    expect(mockRedirectToLogin).not.toHaveBeenCalled()
  })
})

describe('getMeeting(id)', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('returns the unwrapped meeting detail on 200', async () => {
    const payload = {
      meeting: { meetingId: 'x1', sipUri: 'sip:x@e.com', title: 'T', createdAt: 1 },
      bot: null,
      roster: [],
    }
    mockGetToken.mockReturnValue('tok')
    mockFetch(200, payload)

    const result = await getMeeting('x1')
    expect(result).toEqual(payload)
  })
})

describe('getMeeting() — peek opt-in', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  const detail = {
    meeting: { meetingId: 'm1', sipUri: 's@x.webex.com', title: 'T', createdAt: 1 },
    bot: null,
    roster: [],
    rosterSource: 'none',
    rosterError: 'roster unavailable: meeting has no webexMeetingId',
  }

  it('appends ?peek=1 when asked', async () => {
    mockGetToken.mockReturnValue('tok')
    mockFetch(200, detail)
    await getMeeting('m1', { peek: true })
    expect(vi.mocked(globalThis.fetch).mock.calls[0]![0]).toBe('/meetings/m1?peek=1')
  })

  it('peek:false / no opts → unchanged path, no query string', async () => {
    mockGetToken.mockReturnValue('tok')
    mockFetch(200, detail)
    await getMeeting('m1', { peek: false })
    await getMeeting('m1')
    expect(vi.mocked(globalThis.fetch).mock.calls[0]![0]).toBe('/meetings/m1')
    expect(vi.mocked(globalThis.fetch).mock.calls[1]![0]).toBe('/meetings/m1')
  })

  it('passes rosterSource/rosterError through untouched', async () => {
    mockGetToken.mockReturnValue('tok')
    mockFetch(200, detail)
    const res = await getMeeting('m1', { peek: true })
    expect(res.rosterSource).toBe('none')
    expect(res.rosterError).toMatch(/no webexMeetingId/)
  })
})

describe('scheduleMeeting()', () => {
  const INPUT = {
    title: 'Board sync',
    start: 1_800_000_000_000,
    durationMinutes: 30,
    invitees: ['alex@fund.example'],
  }
  const CREATED = {
    webexMeetingId: 'wx-1',
    title: 'Board sync',
    start: 1_800_000_000_000,
    sipAddress: '1@site.webex.example',
    joinUrl: 'https://site.webex.example/meet/1',
  }

  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('POSTs the input as JSON with the Bearer header and returns the CreatedMeeting', async () => {
    mockGetToken.mockReturnValue('tok')
    mockFetch(201, CREATED)

    const result = await scheduleMeeting(INPUT)

    expect(result).toEqual(CREATED)
    expect(globalThis.fetch).toHaveBeenCalledWith(
      '/meetings/schedule',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify(INPUT),
        headers: expect.objectContaining({
          Authorization: 'Bearer tok',
          'Content-Type': 'application/json',
        }),
      }),
    )
  })

  it('403 (missing write scope) → ApiError(403) with the backend { error } message, no redirect', async () => {
    mockGetToken.mockReturnValue('tok')
    mockFetch(403, { error: 'the service app is missing scope meeting:admin_schedules_write' })

    await expect(scheduleMeeting(INPUT)).rejects.toMatchObject({
      status: 403,
      message: 'the service app is missing scope meeting:admin_schedules_write',
    })
    expect(mockRedirectToLogin).not.toHaveBeenCalled()
  })

  it('400 → ApiError(400) surfacing the validation message', async () => {
    mockGetToken.mockReturnValue('tok')
    mockFetch(400, { error: 'start must be in the future' })

    await expect(scheduleMeeting(INPUT)).rejects.toMatchObject({
      status: 400,
      message: 'start must be in the future',
    })
  })

  it('401 → redirect + throw (shared request wrapper behavior)', async () => {
    mockGetToken.mockReturnValue('expired')
    mockFetch(401, { error: 'invalid or expired token' })

    await expect(scheduleMeeting(INPUT)).rejects.toMatchObject({ status: 401 })
    expect(mockRedirectToLogin).toHaveBeenCalledTimes(1)
  })

  it('503 (integration disabled) → ApiError(503) with the message', async () => {
    mockGetToken.mockReturnValue('tok')
    mockFetch(503, { error: 'Webex integration is not configured — meeting scheduling is unavailable' })

    await expect(scheduleMeeting(INPUT)).rejects.toBeInstanceOf(ApiError)
  })
})
