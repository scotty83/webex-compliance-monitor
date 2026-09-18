import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import App from './App'

const { ENDED } = vi.hoisted(() => {
  const NOW = Date.now()
  return {
    ENDED: {
      id: 'm-ended',
      title: 'Ended briefing',
      org: '',
      sipUri: '1@x.webex.com',
      startedAt: NOW - 3_600_000,
      botState: 'ended' as const,
      endedAt: NOW - 600_000,
      attendees: [
        { id: 'p-fo', name: 'Dana Host', role: 'fo' as const, isHost: true, joinedAt: NOW - 3_500_000, leftAt: NOW - 610_000 },
        { id: 'p-an', name: 'Alex Analyst', role: 'analyst' as const, isHost: false, joinedAt: NOW - 3_400_000, leftAt: NOW - 620_000 },
      ],
    },
  }
})

vi.mock('./hooks/useMeetings', () => ({
  useMeetings: () => ({ meetings: [ENDED], loading: false, error: null, refetch: () => {} }),
}))
vi.mock('./hooks/useUpcomingMeetings', () => ({
  useUpcomingMeetings: () => ({ meetings: [], loading: false, error: null, refetch: () => {} }),
}))
// The read-only view must open no live WS — stub the hook so this test can
// never touch WebSocket even if the wiring regresses, and so we can assert
// it was held inactive.
vi.mock('./hooks/useLiveAudio', () => ({
  useLiveAudio: vi.fn(() => ({
    status: 'idle',
    levels: Array<number>(9).fill(0),
    pause: () => {},
    resume: () => {},
  })),
}))
import { useLiveAudio } from './hooks/useLiveAudio'

describe('ended-meeting history navigation', () => {
  it('View history on an ended card opens the read-only chaperone view with the stored roster', () => {
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: /view history/i }))
    expect(document.querySelector('[data-view="chaperone"]')).toBeTruthy()
    // Historical roster renders through the untouched AttendeesPanel/PresenceTimeline.
    expect(screen.getAllByText('Dana Host').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Alex Analyst').length).toBeGreaterThan(0)
    // No live audio for an ended meeting: every call held the hook inactive.
    const calls = vi.mocked(useLiveAudio).mock.calls
    expect(calls.length).toBeGreaterThan(0)
    expect(calls.every(([opts]) => opts.active === false)).toBe(true)
  })
})
