import { useEffect, useState } from 'react'
import type { BotState } from '../types'
import { BOT_STATUS_MAP } from './botStatus'

interface BotStatusIndicatorProps {
  state: BotState
  size?: 'sm' | 'md'
  prefix?: string
  showLabel?: boolean
  /** 'pill' wraps the indicator in the handoff's rounded chip (meeting cards). */
  variant?: 'plain' | 'pill'
}

const FAIL_LOUD_STATES: ReadonlySet<BotState> = new Set(['disconnected', 'failed'])

export function BotStatusIndicator({
  state,
  size = 'md',
  prefix = '',
  showLabel = true,
  variant = 'plain',
}: BotStatusIndicatorProps) {
  const { colorVar, bgVar, label, Glyph } = BOT_STATUS_MAP[state]
  const isDialing = state === 'dialing'
  const isFailLoud = FAIL_LOUD_STATES.has(state)
  const isPill = variant === 'pill'
  // Sentence case across the phrase: "Bot connected", but standalone "Connected"
  const fullLabel = prefix
    ? `${prefix}${label.charAt(0).toLowerCase()}${label.slice(1)}`
    : label
  const dotPx = size === 'sm' ? 6 : 8
  const baseIconSize = size === 'sm' ? 12 : 14
  // Fail-loud states step up: +2px and heavier stroke so broken bots pop in dense rows
  const iconSize = isFailLoud ? baseIconSize + 2 : baseIconSize
  const strokeWidth = isFailLoud ? 2.5 : 2

  const color = `var(${colorVar})`
  // tx3 states have no bg token — use a fixed neutral tint
  const ringColor = bgVar ? `var(${bgVar})` : 'rgba(113,117,125,0.2)'

  // Reactive reduced-motion: responds to mid-session OS preference changes
  const [reducedMotion, setReducedMotion] = useState(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  })

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const mql = window.matchMedia('(prefers-reduced-motion: reduce)')
    const handler = (e: MediaQueryListEvent) => setReducedMotion(e.matches)
    mql.addEventListener('change', handler)
    return () => mql.removeEventListener('change', handler)
  }, [])

  return (
    <span
      role="status"
      aria-label={fullLabel}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        // Handoff chip geometry; fail-loud states tint the pill red so a broken
        // bot pops even at a glance (deliberate deviation from the neutral chip).
        ...(isPill && {
          padding: '5px 11px',
          borderRadius: '999px',
          background: isFailLoud ? 'var(--red-bg)' : 'var(--s3)',
        }),
      }}
    >
      {/* Status dot — ring tint when bare (DESIGN.md); flat inside the pill (handoff) */}
      <span
        aria-hidden="true"
        style={{
          display: 'inline-block',
          width: dotPx,
          height: dotPx,
          borderRadius: '50%',
          backgroundColor: color,
          boxShadow: isPill ? 'none' : `0 0 0 3px ${ringColor}`,
          flexShrink: 0,
        }}
      />
      {/* Distinct glyph per state — identified by data-state for tests */}
      <Glyph
        aria-hidden="true"
        data-state={state}
        data-fail-loud={isFailLoud ? 'true' : undefined}
        size={iconSize}
        strokeWidth={strokeWidth}
        color={color}
        style={{
          animation:
            isDialing && !reducedMotion ? 'spin 1s linear infinite' : 'none',
          flexShrink: 0,
        }}
      />
      {showLabel ? (
        <span
          aria-hidden="true"
          style={{
            fontSize: size === 'sm' ? '12px' : '13px',
            ...(isPill && { fontWeight: 700, color: 'var(--tx1)' }),
          }}
        >
          {fullLabel}
        </span>
      ) : (
        <span className="sr-only">{fullLabel}</span>
      )}
    </span>
  )
}
