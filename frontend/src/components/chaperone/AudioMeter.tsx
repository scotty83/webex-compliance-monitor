import type { LiveStatus } from '../../hooks/useLiveAudio'

const NUM_BARS = 9
const MIN_HEIGHT_PCT = 8 // minimum visible height as % of container

interface AudioMeterProps {
  levels: number[]
  status: LiveStatus
}

/**
 * 9-bar vertical audio level meter.
 *
 * Colors: --green when listening, --tx3 otherwise.
 * Heights map directly from levels[i] (0..1).
 * Reduced-motion: the hook already zeroes levels under reduced-motion, so
 * no extra animation is added here — height changes are cheap CSS transitions.
 *
 * Accessible: role="img" carries the label; the textual status label in
 * MeetingBar is the primary AT signal so this meter is decorative data-viz.
 */
export function AudioMeter({ levels, status }: AudioMeterProps) {
  const isListening = status === 'listening'

  return (
    <div
      role="img"
      aria-label="Audio level meter"
      style={{
        display: 'flex',
        gap: '2px',
        alignItems: 'flex-end',
        height: '30px',
        width: '56px',
        flexShrink: 0,
      }}
    >
      {Array.from({ length: NUM_BARS }, (_, i) => {
        const level = levels[i] ?? 0
        const heightPct = Math.max(MIN_HEIGHT_PCT, level * 100)

        return (
          <div
            key={i}
            data-testid={`audio-bar-${i}`}
            data-level={level}
            style={{
              flex: 1,
              height: `${heightPct}%`,
              backgroundColor: isListening ? 'var(--green)' : 'var(--tx3)',
              borderRadius: '2px',
              // Cheap: animates the height property only; bars are display:block
              // so height changes are self-contained — no ancestor reflow.
              transition: 'height 60ms ease, background-color 150ms ease',
            }}
          />
        )
      })}
    </div>
  )
}
