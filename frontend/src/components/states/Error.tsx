import { AlertTriangle, RefreshCw } from 'lucide-react'
import { useState } from 'react'

interface ErrorStateProps {
  error: Error | null
  onRetry: () => void
}

export function ErrorState({ error, onRetry }: ErrorStateProps) {
  const gist = error?.message ?? 'Unknown error'
  const [btnHovered, setBtnHovered] = useState(false)

  return (
    <div
      role="alert"
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: '12px',
        padding: '16px',
        borderRadius: 'var(--radius-md)',
        background: 'var(--red-bg)',
        border: '1px solid rgba(255, 91, 82, 0.25)',
      }}
    >
      <AlertTriangle
        size={18}
        color="var(--red)"
        aria-hidden="true"
        style={{ flexShrink: 0, marginTop: '1px' }}
      />
      <div
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          gap: '6px',
        }}
      >
        <span
          style={{
            fontFamily: 'var(--font-ui)',
            fontSize: '14px',
            fontWeight: 600,
            color: 'var(--tx1)',
          }}
        >
          Couldn't load meetings
        </span>
        <span style={{ fontSize: '13px', color: 'var(--tx2)' }}>{gist}</span>
        <button
          onClick={onRetry}
          onMouseEnter={() => setBtnHovered(true)}
          onMouseLeave={() => setBtnHovered(false)}
          style={{
            alignSelf: 'flex-start',
            display: 'inline-flex',
            alignItems: 'center',
            gap: '6px',
            marginTop: '4px',
            padding: '6px 12px',
            borderRadius: 'var(--radius-sm)',
            border: '1px solid var(--line2)',
            background: btnHovered ? 'var(--s3)' : 'var(--s2)',
            color: 'var(--tx1)',
            fontSize: '13px',
            fontFamily: 'var(--font-ui)',
            fontWeight: 500,
            cursor: 'pointer',
            transition: 'background 150ms ease',
          }}
        >
          <RefreshCw size={13} aria-hidden="true" />
          Retry
        </button>
      </div>
    </div>
  )
}
