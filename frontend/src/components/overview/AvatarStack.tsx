import { useState } from 'react'
import { Phone } from 'lucide-react'
import type { Attendee } from '../../types'
import { Tooltip } from '../Tooltip'
import { ROLE_COLOR, getInitials, attendeeLabel } from '../../lib/participants'

const MAX_VISIBLE = 4

interface AvatarStackProps {
  attendees: Attendee[]
}

export function AvatarStack({ attendees }: AvatarStackProps) {
  // Mouse-follow tooltip: text + cursor position, cleared on leave (T13)
  const [tip, setTip] = useState<{ text: string; x: number; y: number } | null>(null)

  const onCall = attendees.filter((a) => a.leftAt === null)
  const left   = attendees.filter((a) => a.leftAt !== null)

  // Stack order: active first, then departed — gives the overflow chip natural meaning
  const ordered = [...onCall, ...left]
  const visible  = ordered.slice(0, MAX_VISIBLE)
  const overflow = ordered.length - MAX_VISIBLE
  const overflowNames = ordered.slice(MAX_VISIBLE).map((a) => attendeeLabel(a)).join('\n')

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
      {/* Avatar strip */}
      <div style={{ display: 'flex', alignItems: 'center' }}>
        {visible.map((a, i) => {
          const { bg, text } = ROLE_COLOR[a.role]
          return (
            <span
              key={a.id}
              aria-label={attendeeLabel(a)}
              onMouseMove={(e) => setTip({ text: attendeeLabel(a), x: e.clientX, y: e.clientY })}
              onMouseLeave={() => setTip(null)}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 30,
                height: 30,
                borderRadius: '50%',
                background: bg,
                color: text,
                fontSize: '11px',
                fontWeight: 800,
                fontFamily: 'var(--font-ui)',
                letterSpacing: '0.02em',
                flexShrink: 0,
                border: '2px solid var(--s1)',
                marginLeft: i === 0 ? 0 : -8,
                position: 'relative',
                zIndex: MAX_VISIBLE - i,
              }}
            >
              {a.pstn
                ? <Phone size={13} strokeWidth={2.5} aria-hidden="true" />
                : getInitials(a.name)}
            </span>
          )
        })}

        {overflow > 0 && (
          <span
            aria-label={`${overflow} more ${overflow === 1 ? 'attendee' : 'attendees'}`}
            onMouseMove={(e) => setTip({ text: overflowNames, x: e.clientX, y: e.clientY })}
            onMouseLeave={() => setTip(null)}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 30,
              height: 30,
              borderRadius: '50%',
              background: 'var(--s3)',
              color: 'var(--tx2)',
              fontSize: '11px',
              fontWeight: 600,
              fontFamily: 'var(--font-ui)',
              flexShrink: 0,
              border: '2px solid var(--s1)',
              marginLeft: -8,
              position: 'relative',
              zIndex: 0,
            }}
          >
            +{overflow}
          </span>
        )}
      </div>

      {/* Text summary */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1px' }}>
        <span style={{ fontSize: '12px', color: 'var(--tx2)', fontFamily: 'var(--font-ui)' }}>
          {onCall.length} on call
        </span>
        {left.length > 0 && (
          <span style={{ fontSize: '11px', color: 'var(--tx2)', fontFamily: 'var(--font-ui)' }}>
            {left.length} left earlier
          </span>
        )}
      </div>

      <Tooltip text={tip?.text ?? null} x={tip?.x ?? 0} y={tip?.y ?? 0} />
    </div>
  )
}
