import { renderHook, act } from '@testing-library/react'
import {
  recordListening,
  getListeningEntries,
  subscribeListeningLog,
  clearListeningLog,
  useListeningLog,
  type ListeningEntry,
} from './log'

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeEntry(overrides: Partial<ListeningEntry> = {}): ListeningEntry {
  return {
    action: 'listen_start',
    meetingId: 'm1',
    title: 'Compliance Audit',
    at: 1_700_000_000_000,
    ...overrides,
  }
}

beforeEach(() => {
  clearListeningLog()
})

// ── Store behaviour ───────────────────────────────────────────────────────────

describe('listening log — store', () => {
  it('starts empty', () => {
    expect(getListeningEntries()).toEqual([])
  })

  it('recordListening adds an entry', () => {
    recordListening(makeEntry())
    expect(getListeningEntries()).toHaveLength(1)
    expect(getListeningEntries()[0]).toMatchObject({
      action: 'listen_start',
      meetingId: 'm1',
      title: 'Compliance Audit',
    })
  })

  it('keeps entries newest-first', () => {
    recordListening(makeEntry({ at: 1000, action: 'listen_start' }))
    recordListening(makeEntry({ at: 2000, action: 'listen_stop' }))
    const entries = getListeningEntries()
    expect(entries[0]?.at).toBe(2000)
    expect(entries[1]?.at).toBe(1000)
  })

  it('caps the log at 50 entries, dropping the oldest', () => {
    for (let i = 0; i < 55; i++) {
      recordListening(makeEntry({ at: i }))
    }
    const entries = getListeningEntries()
    expect(entries).toHaveLength(50)
    expect(entries[0]?.at).toBe(54) // newest kept
    expect(entries[49]?.at).toBe(5) // 0..4 dropped
  })

  it('clearListeningLog empties the store', () => {
    recordListening(makeEntry())
    clearListeningLog()
    expect(getListeningEntries()).toEqual([])
  })
})

// ── Subscription ──────────────────────────────────────────────────────────────

describe('listening log — subscribers', () => {
  it('notifies subscribers on record', () => {
    const listener = vi.fn()
    subscribeListeningLog(listener)
    recordListening(makeEntry())
    expect(listener).toHaveBeenCalledOnce()
  })

  it('unsubscribe stops notifications', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeListeningLog(listener)
    unsubscribe()
    recordListening(makeEntry())
    expect(listener).not.toHaveBeenCalled()
  })
})

// ── Hook ──────────────────────────────────────────────────────────────────────

describe('useListeningLog', () => {
  it('returns the current entries and re-renders on record', () => {
    const { result } = renderHook(() => useListeningLog())
    expect(result.current).toEqual([])

    act(() => {
      recordListening(makeEntry({ title: 'Live Update' }))
    })
    expect(result.current).toHaveLength(1)
    expect(result.current[0]?.title).toBe('Live Update')
  })
})
