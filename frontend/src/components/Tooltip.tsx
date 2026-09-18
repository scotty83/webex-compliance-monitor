import { useLayoutEffect, useRef } from 'react'
import { createPortal } from 'react-dom'

// Cursor offset per T13 spec: tooltip trails the pointer at +(12, 14).
const CURSOR_OFFSET_X = 12
const CURSOR_OFFSET_Y = 14

interface TooltipProps {
  /** Content to show; null/empty renders nothing. Newlines render one item per line. */
  text: string | null
  /** Cursor viewport coordinates (event.clientX / event.clientY). */
  x: number
  y: number
}

/**
 * Mouse-follow tooltip, rendered into document.body via portal so panel
 * overflow never clips it. Controlled: the consumer owns show/move/hide
 * (AvatarStack tracks mousemove and passes cursor coordinates).
 *
 * aria-hidden — it only duplicates accessible names that already exist as
 * aria-labels on the hovered elements; keyboard/AT users lose nothing.
 */
export function Tooltip({ text, x, y }: TooltipProps) {
  const ref = useRef<HTMLDivElement>(null)

  // Position at cursor + offset, clamped to the viewport so the tooltip never
  // renders off-screen. Every mousemove DOES re-render (the consumer stores
  // cursor coords in state); the direct style write exists because the clamp
  // needs the element's rendered offsetWidth/offsetHeight, which are only
  // measurable after layout — hence useLayoutEffect + imperative positioning.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const left = Math.min(x + CURSOR_OFFSET_X, window.innerWidth - el.offsetWidth)
    const top = Math.min(y + CURSOR_OFFSET_Y, window.innerHeight - el.offsetHeight)
    el.style.left = `${Math.max(0, left)}px`
    el.style.top = `${Math.max(0, top)}px`
  }, [text, x, y])

  if (!text) return null

  return createPortal(
    <div
      ref={ref}
      aria-hidden="true"
      style={{
        position: 'fixed',
        zIndex: 'var(--z-tooltip)',
        maxWidth: 260,
        padding: '6px 10px',
        background: 'var(--s3)',
        border: '1px solid var(--line2)',
        borderRadius: 8,
        color: 'var(--tx1)',
        fontSize: '12px',
        fontFamily: 'var(--font-ui)',
        whiteSpace: 'pre-line',
        boxShadow: '0 4px 14px rgba(0, 0, 0, 0.45)',
        pointerEvents: 'none', // never intercept the cursor it follows
      }}
    >
      {text}
    </div>,
    document.body,
  )
}
