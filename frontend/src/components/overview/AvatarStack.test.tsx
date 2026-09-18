import { render, screen, fireEvent } from '@testing-library/react'
import { AvatarStack } from './AvatarStack'
import type { Attendee, ParticipantRole } from '../../types'

const BASE_TIME = 1_700_000_000_000

function makeAttendee(id: string, opts: Partial<Attendee> = {}): Attendee {
  return {
    id,
    name: 'Test User',
    role: 'analyst' as ParticipantRole,
    isHost: false,
    joinedAt: BASE_TIME,
    leftAt: null,
    ...opts,
  }
}

// ── On-call count ─────────────────────────────────────────────────────────────

describe('AvatarStack — on-call count', () => {
  it('shows "N on call" for attendees with leftAt=null', () => {
    const attendees = [
      makeAttendee('a1', { leftAt: null }),
      makeAttendee('a2', { leftAt: null }),
    ]
    render(<AvatarStack attendees={attendees} />)
    expect(screen.getByText('2 on call')).toBeInTheDocument()
  })

  it('counts only active (leftAt=null) in "on call"', () => {
    const attendees = [
      makeAttendee('a1', { leftAt: null }),
      makeAttendee('a2', { leftAt: BASE_TIME + 60_000 }),
    ]
    render(<AvatarStack attendees={attendees} />)
    expect(screen.getByText('1 on call')).toBeInTheDocument()
  })
})

// ── Left-earlier count ────────────────────────────────────────────────────────

describe('AvatarStack — left-earlier', () => {
  it('shows "N left earlier" when some attendees have leftAt set', () => {
    const attendees = [
      makeAttendee('a1', { leftAt: null }),
      makeAttendee('a2', { leftAt: BASE_TIME + 60_000 }),
    ]
    render(<AvatarStack attendees={attendees} />)
    expect(screen.getByText('1 left earlier')).toBeInTheDocument()
  })

  it('does not show "left earlier" when all are active', () => {
    const attendees = [makeAttendee('a1', { leftAt: null })]
    render(<AvatarStack attendees={attendees} />)
    expect(screen.queryByText(/left earlier/)).not.toBeInTheDocument()
  })
})

// ── Initials ──────────────────────────────────────────────────────────────────

describe('AvatarStack — initials', () => {
  it('shows 2-char initials from name', () => {
    render(<AvatarStack attendees={[makeAttendee('a1', { name: 'Alice Brown' })]} />)
    expect(screen.getByText('AB')).toBeInTheDocument()
  })

  it('single-word name gets one initial', () => {
    render(<AvatarStack attendees={[makeAttendee('a1', { name: 'Jordan' })]} />)
    expect(screen.getByText('J')).toBeInTheDocument()
  })
})

// ── Overflow chip ─────────────────────────────────────────────────────────────

describe('AvatarStack — overflow', () => {
  it('shows +N chip when attendees > 4', () => {
    const attendees = Array.from({ length: 6 }, (_, i) =>
      makeAttendee(`a${i}`, { name: `Person ${i}` }),
    )
    render(<AvatarStack attendees={attendees} />)
    expect(screen.getByText('+2')).toBeInTheDocument()
  })

  it('no overflow chip when attendees <= 4', () => {
    const attendees = Array.from({ length: 4 }, (_, i) =>
      makeAttendee(`a${i}`, { name: `Person ${i}` }),
    )
    render(<AvatarStack attendees={attendees} />)
    expect(screen.queryByText(/^\+\d/)).not.toBeInTheDocument()
  })

  it('+N chip has accessible label for overflow count (plural)', () => {
    const attendees = Array.from({ length: 6 }, (_, i) =>
      makeAttendee(`a${i}`, { name: `Person ${i}` }),
    )
    render(<AvatarStack attendees={attendees} />)
    expect(screen.getByLabelText('2 more attendees')).toBeInTheDocument()
  })

  it('+N chip accessible label is singular for 1 overflow', () => {
    const attendees = Array.from({ length: 5 }, (_, i) =>
      makeAttendee(`a${i}`, { name: `Person ${i}` }),
    )
    render(<AvatarStack attendees={attendees} />)
    expect(screen.getByLabelText('1 more attendee')).toBeInTheDocument()
  })
})

// ── Hover tooltip ─────────────────────────────────────────────────────────────

describe('AvatarStack — hover tooltip', () => {
  it('shows a body-level tooltip with the attendee name on avatar mousemove', () => {
    const { container } = render(
      <AvatarStack attendees={[makeAttendee('a1', { name: 'Jordan Rivera' })]} />,
    )
    fireEvent.mouseMove(screen.getByLabelText('Jordan Rivera'), { clientX: 40, clientY: 50 })
    const tip = screen.getByText('Jordan Rivera')
    expect(tip.parentElement).toBe(document.body) // portal — never clipped by card overflow
    expect(container.contains(tip)).toBe(false)
  })

  it('follows the mouse: position updates on each mousemove', () => {
    render(<AvatarStack attendees={[makeAttendee('a1', { name: 'Jordan Rivera' })]} />)
    const avatar = screen.getByLabelText('Jordan Rivera')
    fireEvent.mouseMove(avatar, { clientX: 40, clientY: 50 })
    const tip = screen.getByText('Jordan Rivera')
    expect(tip.style.left).toBe('52px') // cursor + 12
    expect(tip.style.top).toBe('64px') // cursor + 14
    fireEvent.mouseMove(avatar, { clientX: 100, clientY: 120 })
    expect(tip.style.left).toBe('112px')
    expect(tip.style.top).toBe('134px')
  })

  it('clears the tooltip on mouse leave', () => {
    render(<AvatarStack attendees={[makeAttendee('a1', { name: 'Jordan Rivera' })]} />)
    const avatar = screen.getByLabelText('Jordan Rivera')
    fireEvent.mouseMove(avatar, { clientX: 40, clientY: 50 })
    expect(screen.getByText('Jordan Rivera')).toBeInTheDocument()
    fireEvent.mouseLeave(avatar)
    expect(screen.queryByText('Jordan Rivera')).not.toBeInTheDocument()
  })

  it('+N chip tooltip lists the remaining names one per line', () => {
    const attendees = Array.from({ length: 6 }, (_, i) =>
      makeAttendee(`a${i}`, { name: `Person ${i}` }),
    )
    render(<AvatarStack attendees={attendees} />)
    fireEvent.mouseMove(screen.getByLabelText('2 more attendees'), { clientX: 10, clientY: 10 })
    const tip = screen.getByText((_, el) => el?.textContent === 'Person 4\nPerson 5')
    expect(tip.style.whiteSpace).toBe('pre-line')
    fireEvent.mouseLeave(screen.getByLabelText('2 more attendees'))
    expect(screen.queryByText((_, el) => el?.textContent === 'Person 4\nPerson 5')).toBeNull()
  })

  it('has no native title attributes (custom tooltip replaces them)', () => {
    const attendees = Array.from({ length: 6 }, (_, i) =>
      makeAttendee(`a${i}`, { name: `Person ${i}` }),
    )
    const { container } = render(<AvatarStack attendees={attendees} />)
    expect(container.querySelectorAll('[title]')).toHaveLength(0)
  })
})

// ── PSTN glyph ────────────────────────────────────────────────────────────────

describe('AvatarStack — PSTN phone glyph', () => {
  it('renders a phone glyph (no initials) for a PSTN attendee', () => {
    const pstn = makeAttendee('pstn1', {
      name: '8452****46',
      pstn: true,
      phone: '8452338546',
    });
    render(<AvatarStack attendees={[pstn]} />);
    // Initials should NOT appear
    expect(screen.queryByText('84')).not.toBeInTheDocument();
    // aria-label uses the formatted number
    expect(screen.getByLabelText('(845) 233-8546')).toBeInTheDocument();
  });

  it('non-PSTN attendee still shows initials', () => {
    const web = makeAttendee('w1', { name: 'Alice Brown', pstn: false });
    render(<AvatarStack attendees={[web]} />);
    expect(screen.getByText('AB')).toBeInTheDocument();
  });
});
