interface StatusPillProps {
  count: number
}

export function StatusPill({ count }: StatusPillProps) {
  const label = count === 1 ? '1 meeting tracked' : `${count} meetings tracked`

  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        background: 'var(--s2)',
        border: '1px solid var(--line)',
        borderRadius: 'var(--radius-pill)',
        padding: '4px 12px',
        fontSize: 13,
        fontWeight: 500,
        color: 'var(--tx2)',
      }}
    >
      {/* Green dot */}
      <span
        style={{
          width: 7,
          height: 7,
          borderRadius: '50%',
          background: 'var(--green)',
          flexShrink: 0,
        }}
        aria-hidden="true"
      />
      {label}
    </div>
  )
}
