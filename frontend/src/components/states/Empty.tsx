import { Headphones } from 'lucide-react'

export function Empty() {
  return (
    <div
      role="status"
      aria-label="No active meetings"
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '80px 24px',
        gap: '20px',
        textAlign: 'center',
      }}
    >
      <Headphones
        size={40}
        aria-hidden="true"
        strokeWidth={1.5}
        color="var(--tx3)"
      />
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', maxWidth: '360px' }}>
        <p
          style={{
            fontFamily: 'var(--font-ui)',
            fontWeight: 600,
            fontSize: '16px',
            color: 'var(--tx2)',
            lineHeight: 1.4,
          }}
        >
          No meetings are being chaperoned right now
        </p>
        <p style={{ fontSize: '13px', color: 'var(--tx3)', lineHeight: 1.5 }}>
          Meetings appear here when a compliance bot joins a call.
        </p>
      </div>
    </div>
  )
}
