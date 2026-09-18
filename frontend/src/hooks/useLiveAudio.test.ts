// RED → GREEN: useLiveAudio WebSocket hook tests
// Uses a fake WebSocket (monkeypatched on globalThis) and a stub AudioSink so
// the WS state machine can be tested in jsdom without WebCodecs or AudioContext.

vi.mock('../auth/session', () => ({
  getToken: vi.fn(() => 'test-token'),
  redirectToLogin: vi.fn(),
}))

import { renderHook, act } from '@testing-library/react'
import { getToken, redirectToLogin } from '../auth/session'
import { useLiveAudio } from './useLiveAudio'
import type { AudioSink, AudioSinkFactory } from './useLiveAudio'

// ── Fake WebSocket ────────────────────────────────────────────────────────────

class FakeWS {
  static instances: FakeWS[] = []

  url: string
  binaryType = 'arraybuffer'
  onopen:    ((evt: Event) => void) | null = null
  onmessage: ((evt: MessageEvent) => void) | null = null
  onerror:   ((evt: Event) => void) | null = null
  onclose:   ((evt: CloseEvent) => void) | null = null
  closedCode: number | undefined

  constructor(url: string) {
    this.url = url
    FakeWS.instances.push(this)
  }

  close(code = 1000) {
    this.closedCode = code
    // Handlers are stripped before close() in the real hook; if they haven't
    // been stripped yet (unexpected path) we fire onclose to simulate the
    // browser behaviour.
    if (this.onclose) {
      this.onclose(
        Object.assign(new Event('close'), { code, reason: '', wasClean: code === 1000 }) as CloseEvent,
      )
    }
  }

  // ── Helpers to drive the fake server ──────────────────────────────────────

  /** Simulate the server-sent hello JSON frame. */
  receiveHello(sampleRate = 48000) {
    this.onmessage?.(
      new MessageEvent('message', {
        data: JSON.stringify({ type: 'hello', codec: 'opus', sampleRate }),
      }),
    )
  }

  /** Simulate a binary Opus frame from the server. */
  receiveBinary(data: ArrayBuffer = new ArrayBuffer(8)) {
    this.onmessage?.(new MessageEvent('message', { data }))
  }

  /** Simulate the server closing the WS with a given code. */
  serverClose(code: number) {
    // Nullify wsRef so the hook sees the WS as gone before we fire the event.
    const saved = this.onclose
    this.onclose = null
    saved?.(
      Object.assign(new Event('close'), { code, reason: '', wasClean: code === 1000 }) as CloseEvent,
    )
  }
}

// ── Stub AudioSink factory ────────────────────────────────────────────────────

function makeStubFactory() {
  const pushedFrames: ArrayBuffer[] = []
  const destroy = vi.fn()
  const sink: AudioSink = {
    push: (f) => pushedFrames.push(f),
    getLevels: () => Array<number>(9).fill(0.42),
    destroy,
  }
  const factory: AudioSinkFactory = vi.fn((_sr: number) => sink)
  return { factory, sink, pushedFrames, destroy }
}

// ── Test setup ────────────────────────────────────────────────────────────────

const mockGetToken      = vi.mocked(getToken)
const mockRedirectToLogin = vi.mocked(redirectToLogin)

let origWebSocket: typeof WebSocket

beforeEach(() => {
  origWebSocket = globalThis.WebSocket
  globalThis.WebSocket = FakeWS as unknown as typeof WebSocket
  FakeWS.instances = []
  mockGetToken.mockReturnValue('test-token')
})

afterEach(() => {
  globalThis.WebSocket = origWebSocket
  vi.resetAllMocks()
})

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Returns the most-recently created FakeWS (there should only be one). */
function lastWs() {
  const ws = FakeWS.instances[FakeWS.instances.length - 1]
  if (!ws) throw new Error('No FakeWS created')
  return ws
}

// ══════════════════════════════════════════════════════════════════════════════
// Tests
// ══════════════════════════════════════════════════════════════════════════════

describe('useLiveAudio', () => {

  // ── Initial state ──────────────────────────────────────────────────────────

  it('starts idle with flat levels when active:false', () => {
    const { stub } = (() => {
      const stub = makeStubFactory()
      return { stub }
    })()
    const { result } = renderHook(() =>
      useLiveAudio({ meetingId: 'mtg-1', active: false }, stub.factory),
    )

    expect(result.current.status).toBe('idle')
    expect(result.current.levels).toHaveLength(9)
    expect(result.current.levels.every((v) => v === 0)).toBe(true)
    expect(result.current.error).toBeUndefined()
    expect(FakeWS.instances).toHaveLength(0) // no WS opened
  })

  // ── Connect → hello → binary frame ────────────────────────────────────────

  it('goes connecting → listening after hello; stub sink receives binary frame', async () => {
    const stub = makeStubFactory()
    const { result } = renderHook(() =>
      useLiveAudio({ meetingId: 'mtg-1', active: true }, stub.factory),
    )

    // After mount with active:true the hook immediately opens the WS.
    expect(result.current.status).toBe('connecting')
    expect(FakeWS.instances).toHaveLength(1)

    const ws = lastWs()
    expect(ws.url).toContain('/live/mtg-1')
    expect(ws.url).toContain('token=test-token')
    // Token must be in the URL query — not logged here; we just verify presence.

    // Simulate server hello.
    await act(async () => { ws.receiveHello(48000) })

    expect(result.current.status).toBe('listening')
    expect(stub.factory).toHaveBeenCalledWith(48000)

    // Simulate a binary Opus frame.
    const frame = new ArrayBuffer(20)
    await act(async () => { ws.receiveBinary(frame) })

    expect(stub.pushedFrames).toHaveLength(1)
    expect(stub.pushedFrames[0]).toBe(frame)

    // levels must always be length 9.
    expect(result.current.levels).toHaveLength(9)
  })

  // ── Close code 4401 ───────────────────────────────────────────────────────

  it('sets error with auth message on close 4401 and calls redirectToLogin', async () => {
    const stub = makeStubFactory()
    const { result } = renderHook(() =>
      useLiveAudio({ meetingId: 'mtg-1', active: true }, stub.factory),
    )

    await act(async () => { lastWs().receiveHello() })
    expect(result.current.status).toBe('listening')

    await act(async () => { lastWs().serverClose(4401) })

    expect(result.current.status).toBe('error')
    expect(result.current.error?.code).toBe(4401)
    expect(result.current.error?.message).toMatch(/session expired|sign in/i)
    expect(mockRedirectToLogin).toHaveBeenCalledTimes(1)
  })

  // ── Close code 4404 ───────────────────────────────────────────────────────

  it('sets "Bot not connected" error on close 4404 (fail-loud)', async () => {
    const stub = makeStubFactory()
    const { result } = renderHook(() =>
      useLiveAudio({ meetingId: 'mtg-1', active: true }, stub.factory),
    )

    await act(async () => { lastWs().receiveHello() })
    await act(async () => { lastWs().serverClose(4404) })

    expect(result.current.status).toBe('error')
    expect(result.current.error?.code).toBe(4404)
    expect(result.current.error?.message).toBe('Bot not connected')
    expect(mockRedirectToLogin).not.toHaveBeenCalled()
  })

  // ── pause() ───────────────────────────────────────────────────────────────

  it('pause() closes the WS, sets status paused, and flattens levels', async () => {
    const stub = makeStubFactory()
    const { result } = renderHook(() =>
      useLiveAudio({ meetingId: 'mtg-1', active: true }, stub.factory),
    )

    await act(async () => { lastWs().receiveHello() })
    expect(result.current.status).toBe('listening')

    const ws = lastWs()
    await act(async () => { result.current.pause() })

    expect(ws.closedCode).toBeDefined()
    expect(result.current.status).toBe('paused')
    expect(result.current.levels).toHaveLength(9)
    expect(result.current.levels.every((v) => v === 0)).toBe(true)
  })

  // ── resume() after pause ──────────────────────────────────────────────────

  it('resume() after pause() opens a new WS and goes connecting', async () => {
    const stub = makeStubFactory()
    const { result } = renderHook(() =>
      useLiveAudio({ meetingId: 'mtg-1', active: true }, stub.factory),
    )

    await act(async () => { lastWs().receiveHello() })
    await act(async () => { result.current.pause() })
    expect(result.current.status).toBe('paused')

    await act(async () => { result.current.resume() })

    expect(result.current.status).toBe('connecting')
    // A second WS should have been created.
    expect(FakeWS.instances).toHaveLength(2)
  })

  // ── active:false ─────────────────────────────────────────────────────────

  it('active:false with no WS never opens a connection', () => {
    const stub = makeStubFactory()
    renderHook(() =>
      useLiveAudio({ meetingId: 'mtg-1', active: false }, stub.factory),
    )
    expect(FakeWS.instances).toHaveLength(0)
  })

  it('flipping active false→true→false closes the WS and goes idle', async () => {
    const stub = makeStubFactory()
    const { result, rerender } = renderHook(
      ({ active }: { active: boolean }) =>
        useLiveAudio({ meetingId: 'mtg-1', active }, stub.factory),
      { initialProps: { active: true } },
    )

    const ws = lastWs()
    await act(async () => { ws.receiveHello() })
    expect(result.current.status).toBe('listening')

    rerender({ active: false })
    // The hook should have called ws.close().
    expect(ws.closedCode).toBeDefined()
  })

  // ── Unmount closes the WS (no leak) ──────────────────────────────────────

  it('unmount closes the WS and does not call setState afterwards', async () => {
    const stub = makeStubFactory()
    const { unmount, result } = renderHook(() =>
      useLiveAudio({ meetingId: 'mtg-1', active: true }, stub.factory),
    )

    await act(async () => { lastWs().receiveHello() })
    const ws = lastWs()

    unmount()

    // WS should have been closed.
    expect(ws.closedCode).toBeDefined()
    // Status frozen at 'listening' — no update after unmount.
    expect(result.current.status).toBe('listening')
  })

  // ── Sink is destroyed on pause and on unmount ─────────────────────────────

  it('destroy() is called on the sink when pause() is invoked', async () => {
    const stub = makeStubFactory()
    const { result } = renderHook(() =>
      useLiveAudio({ meetingId: 'mtg-1', active: true }, stub.factory),
    )

    await act(async () => { lastWs().receiveHello() })
    await act(async () => { result.current.pause() })

    expect(stub.destroy).toHaveBeenCalledTimes(1)
  })

  it('destroy() is called on the sink when the component unmounts', async () => {
    const stub = makeStubFactory()
    const { unmount } = renderHook(() =>
      useLiveAudio({ meetingId: 'mtg-1', active: true }, stub.factory),
    )

    await act(async () => { lastWs().receiveHello() })
    unmount()

    expect(stub.destroy).toHaveBeenCalledTimes(1)
  })

  // ── No WS opened when token is missing ───────────────────────────────────

  it('sets auth error immediately when getToken returns null', async () => {
    mockGetToken.mockReturnValue(null)
    const stub = makeStubFactory()
    const { result } = renderHook(() =>
      useLiveAudio({ meetingId: 'mtg-1', active: true }, stub.factory),
    )

    await act(async () => { /* flush effect */ })

    expect(FakeWS.instances).toHaveLength(0)
    expect(result.current.status).toBe('error')
    expect(result.current.error?.message).toMatch(/session expired|sign in/i)
    expect(mockRedirectToLogin).toHaveBeenCalledTimes(1)
  })

  // ── levels always length 9 ────────────────────────────────────────────────

  it('levels is always length 9 across status transitions', async () => {
    const stub = makeStubFactory()
    const { result } = renderHook(() =>
      useLiveAudio({ meetingId: 'mtg-1', active: true }, stub.factory),
    )

    expect(result.current.levels).toHaveLength(9) // idle / connecting

    await act(async () => { lastWs().receiveHello() })
    expect(result.current.levels).toHaveLength(9) // listening

    await act(async () => { result.current.pause() })
    expect(result.current.levels).toHaveLength(9) // paused

    await act(async () => { result.current.resume() })
    expect(result.current.levels).toHaveLength(9) // connecting again
  })

  // ── Binary frame before hello is ignored ─────────────────────────────────

  it('ignores binary frames received before the hello', async () => {
    const stub = makeStubFactory()
    const { result } = renderHook(() =>
      useLiveAudio({ meetingId: 'mtg-1', active: true }, stub.factory),
    )

    // Send binary before hello — must not crash or push to sink.
    await act(async () => { lastWs().receiveBinary(new ArrayBuffer(16)) })

    expect(stub.pushedFrames).toHaveLength(0)
    expect(result.current.status).toBe('connecting')
  })

  // ── Malformed hello JSON is silently ignored ──────────────────────────────

  it('stays connecting if the hello JSON is malformed', async () => {
    const stub = makeStubFactory()
    const { result } = renderHook(() =>
      useLiveAudio({ meetingId: 'mtg-1', active: true }, stub.factory),
    )

    await act(async () => {
      lastWs().onmessage?.(
        new MessageEvent('message', { data: 'not-json{{{' }),
      )
    })

    expect(result.current.status).toBe('connecting')
  })

  // ── Sink factory error is surfaced ────────────────────────────────────────

  it('surfaces error if the AudioSink factory throws', async () => {
    const badFactory: AudioSinkFactory = () => {
      throw new Error("This browser can't decode the audio stream")
    }
    const { result } = renderHook(() =>
      useLiveAudio({ meetingId: 'mtg-1', active: true }, badFactory),
    )

    await act(async () => { lastWs().receiveHello() })

    expect(result.current.status).toBe('error')
    expect(result.current.error?.message).toMatch(/decode/i)
  })

  // ── Bounded retry: exactly one reconnect attempt ──────────────────────────

  it('retries once on unexpected close and does NOT open a third WS on second drop', async () => {
    vi.useFakeTimers()
    const stub = makeStubFactory()
    const { result } = renderHook(() =>
      useLiveAudio({ meetingId: 'mtg-1', active: true }, stub.factory),
    )

    // First WS opens immediately.
    expect(FakeWS.instances).toHaveLength(1)
    expect(result.current.status).toBe('connecting')

    await act(async () => { lastWs().receiveHello() })
    expect(result.current.status).toBe('listening')

    // Simulate unexpected server drop (code 1006).
    await act(async () => { lastWs().serverClose(1006) })

    // Hook must set a "retrying" error and schedule a reconnect.
    expect(result.current.status).toBe('connecting')
    expect(result.current.error?.message).toMatch(/retrying/i)

    // Advance time so the 1 s retry fires.
    await act(async () => { vi.advanceTimersByTime(1_100) })

    // A second WS must have been opened.
    expect(FakeWS.instances).toHaveLength(2)
    expect(result.current.status).toBe('connecting')

    // Drop the second WS unexpectedly — retry budget is now exhausted.
    await act(async () => { lastWs().serverClose(1006) })

    // No third WS — the bounded-retry guarantee holds.
    expect(FakeWS.instances).toHaveLength(2)
    expect(result.current.status).toBe('error')
    expect(result.current.error?.message).toMatch(/connection lost/i)

    vi.useRealTimers()
  })

  // ── Retry budget re-arms on a SUCCESSFUL hello (not on a failing retry) ────

  it('re-arms the single auto-retry after a successful hello reconnection', async () => {
    vi.useFakeTimers()
    const stub = makeStubFactory()
    const { result } = renderHook(() =>
      useLiveAudio({ meetingId: 'mtg-1', active: true }, stub.factory),
    )

    // WS #1: connect → hello → listening.
    await act(async () => { lastWs().receiveHello() })
    expect(result.current.status).toBe('listening')

    // Drop #1 → consumes the single retry, opens WS #2.
    await act(async () => { lastWs().serverClose(1006) })
    await act(async () => { vi.advanceTimersByTime(1_100) })
    expect(FakeWS.instances).toHaveLength(2)

    // WS #2 succeeds: hello → listening. This must restore the retry budget.
    await act(async () => { lastWs().receiveHello() })
    expect(result.current.status).toBe('listening')

    // Drop #2 (after a successful session) → one more auto-retry, WS #3.
    await act(async () => { lastWs().serverClose(1006) })
    expect(result.current.status).toBe('connecting')
    expect(result.current.error?.message).toMatch(/retrying/i)

    await act(async () => { vi.advanceTimersByTime(1_100) })
    expect(FakeWS.instances).toHaveLength(3)

    // WS #3 never reaches hello and drops → budget exhausted, no WS #4.
    await act(async () => { lastWs().serverClose(1006) })
    await act(async () => { vi.advanceTimersByTime(1_100) })
    expect(FakeWS.instances).toHaveLength(3)
    expect(result.current.status).toBe('error')
    expect(result.current.error?.message).toMatch(/connection lost/i)

    vi.useRealTimers()
  })
})
