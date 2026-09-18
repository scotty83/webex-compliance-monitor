import { useState } from 'react'
import { Eye, Headphones, History } from 'lucide-react'
import type { BotState } from '../../types'

interface JoinButtonProps {
  meetingId: string
  botState: BotState
  onOpenMeeting: (id: string) => void
}

// 'live' = green chaperone join (audio); 'view' = read-only entry (bot not in
// call, meeting still in progress); 'history' = past meeting review.
type JoinMode = 'live' | 'view' | 'history'

interface ButtonConfig {
  label: string
  mode: JoinMode
  /** 'live' = green chaperone CTA; 'history' = neutral read-only review. */
  intent: 'live' | 'history'
}

const CONFIG: Record<BotState, ButtonConfig> = {
  connected:    { label: 'Chaperone join', mode: 'live',    intent: 'live' },
  dialing:      { label: 'View attendees', mode: 'view',    intent: 'live' },
  idle:         { label: 'View attendees', mode: 'view',    intent: 'live' },
  disconnected: { label: 'View attendees', mode: 'view',    intent: 'live' },
  failed:       { label: 'View attendees', mode: 'view',    intent: 'live' },
  // Ended-meeting history: navigable, but visually distinct from the green
  // live CTA — an officer must never mistake review for live listening.
  ended:        { label: 'View history',   mode: 'history', intent: 'history' },
}

export function JoinButton({ meetingId, botState, onOpenMeeting }: JoinButtonProps) {
  const { label, mode } = CONFIG[botState]
  const [hovered, setHovered] = useState(false)

  const Icon = mode === 'history' ? History : mode === 'view' ? Eye : Headphones

  const background = mode === 'live' ? 'var(--green-solid)' : mode === 'view' ? 'var(--s2)' : 'var(--s3)'
  const color      = mode === 'live' ? '#06210f' : 'var(--tx1)'

  return (
    <button
      className="join-btn"
      onClick={() => onOpenMeeting(meetingId)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        width: '100%',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '7px',
        // 'view' uses a real border (–1px each side) → shave padding to keep
        // all three modes the same rendered height.
        padding: mode === 'view' ? '8px 15px' : '9px 16px',
        borderRadius: '10px',
        border: mode === 'view' ? '1px solid var(--line2)' : 'none',
        cursor: 'pointer',
        fontFamily: 'var(--font-ui)',
        fontSize: '14px',
        fontWeight: 700,
        lineHeight: 1,
        transition: 'background 150ms ease, filter 150ms ease',
        background,
        color,
        // Inset hairline on 'history' so button height matches the live CTA.
        boxShadow: mode === 'history' ? 'inset 0 0 0 1px var(--line2)' : 'none',
        filter: hovered ? 'brightness(1.12)' : 'none',
      }}
    >
      <Icon size={15} aria-hidden="true" strokeWidth={2} />
      {label}
    </button>
  )
}
