import { render, screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { JoinButton } from './JoinButton'
import type { BotState } from '../../types'

const onOpenMeeting = vi.fn()

beforeEach(() => {
  onOpenMeeting.mockClear()
})

// ── Enabled state: connected only ──────────────────────────────────────────────

describe('JoinButton — connected (enabled)', () => {
  it('renders an enabled button', () => {
    render(<JoinButton meetingId="m1" botState="connected" onOpenMeeting={onOpenMeeting} />)
    expect(screen.getByRole('button')).not.toBeDisabled()
  })

  it('label is "Chaperone join"', () => {
    render(<JoinButton meetingId="m1" botState="connected" onOpenMeeting={onOpenMeeting} />)
    expect(screen.getByRole('button', { name: /Chaperone join/ })).toBeInTheDocument()
  })

  it('click calls onOpenMeeting with the meeting id', async () => {
    render(<JoinButton meetingId="m42" botState="connected" onOpenMeeting={onOpenMeeting} />)
    await userEvent.click(screen.getByRole('button'))
    expect(onOpenMeeting).toHaveBeenCalledOnce()
    expect(onOpenMeeting).toHaveBeenCalledWith('m42')
  })
})

// ── View-only states: read-only entry (bot not in call) ───────────────────────

const VIEW_CASES: BotState[] = ['dialing', 'idle', 'disconnected', 'failed']

describe('JoinButton — view-only states (read-only entry)', () => {
  for (const state of VIEW_CASES) {
    it(`${state}: enabled and labeled "View attendees"`, () => {
      render(<JoinButton meetingId="m1" botState={state} onOpenMeeting={onOpenMeeting} />)
      expect(screen.getByRole('button', { name: /View attendees/ })).not.toBeDisabled()
    })
    it(`${state}: click calls onOpenMeeting with the meeting id`, async () => {
      render(<JoinButton meetingId="m9" botState={state} onOpenMeeting={onOpenMeeting} />)
      await userEvent.click(screen.getByRole('button'))
      expect(onOpenMeeting).toHaveBeenCalledOnce()
      expect(onOpenMeeting).toHaveBeenCalledWith('m9')
    })
  }
})

// ── History state: ended is navigable (not disabled) ──────────────────────────

describe('JoinButton — ended (history, navigable)', () => {
  it('ended: button is enabled', () => {
    render(<JoinButton meetingId="m1" botState="ended" onOpenMeeting={onOpenMeeting} />)
    expect(screen.getByRole('button')).not.toBeDisabled()
  })

  it('ended: label is "View history"', () => {
    render(<JoinButton meetingId="m1" botState="ended" onOpenMeeting={onOpenMeeting} />)
    expect(screen.getByRole('button')).toHaveTextContent('View history')
  })

  it('ended: click calls onOpenMeeting with the meeting id', async () => {
    render(<JoinButton meetingId="m7" botState="ended" onOpenMeeting={onOpenMeeting} />)
    await userEvent.click(screen.getByRole('button'))
    expect(onOpenMeeting).toHaveBeenCalledOnce()
    expect(onOpenMeeting).toHaveBeenCalledWith('m7')
  })
})

// ── aria-disabled ──────────────────────────────────────────────────────────────

describe('JoinButton — aria-disabled', () => {
  it('connected: aria-disabled absent when enabled', () => {
    render(<JoinButton meetingId="m1" botState="connected" onOpenMeeting={onOpenMeeting} />)
    expect(screen.getByRole('button')).not.toHaveAttribute('aria-disabled')
  })

  it('ended: aria-disabled absent (history mode is enabled)', () => {
    render(<JoinButton meetingId="m1" botState="ended" onOpenMeeting={onOpenMeeting} />)
    expect(screen.getByRole('button')).not.toHaveAttribute('aria-disabled')
  })

  it('failed: aria-disabled absent (view mode is enabled)', () => {
    render(<JoinButton meetingId="m1" botState="failed" onOpenMeeting={onOpenMeeting} />)
    expect(screen.getByRole('button')).not.toHaveAttribute('aria-disabled')
  })
})

// ── Task 6: ended → navigable "View history" ───────────────────────────────────

test('ended → enabled "View history" button that opens the meeting', () => {
  const onOpen = vi.fn()
  render(<JoinButton meetingId="m-ended" botState="ended" onOpenMeeting={onOpen} />)
  const btn = screen.getByRole('button', { name: /view history/i })
  expect(btn).toBeEnabled()
  fireEvent.click(btn)
  expect(onOpen).toHaveBeenCalledWith('m-ended')
})
