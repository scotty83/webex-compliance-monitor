import { useOfficer } from '../../auth/AuthGate'

function deriveName(email: string): string {
  const username = email.split('@')[0] ?? ''
  return username
    .split(/[._-]+/)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase())
    .join(' ')
}

function deriveInitials(name: string): string {
  const parts = name.trim().split(/\s+/)
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
  return name.slice(0, 2).toUpperCase()
}

export function OfficerBadge() {
  const officer = useOfficer()

  if (!officer) return null

  const name = deriveName(officer.email)
  const initials = deriveInitials(name)

  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 10,
        background: 'var(--s1)',
        border: '1px solid var(--line)',
        borderRadius: '999px',
        padding: '5px 14px 5px 5px',
      }}
    >
      {/* Avatar circle — handoff gradient (blue → deep violet, not a token) */}
      <div
        aria-hidden="true"
        style={{
          width: 30,
          height: 30,
          borderRadius: '50%',
          background: 'linear-gradient(150deg, var(--blue), #7c6bf0)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontWeight: 800,
          fontSize: 12,
          color: '#fff',
          flexShrink: 0,
          userSelect: 'none',
        }}
      >
        {initials}
      </div>
      {/* Display name */}
      <span
        style={{
          fontSize: 13,
          fontWeight: 700,
          color: 'var(--tx1)',
        }}
      >
        {name}
      </span>
    </div>
  )
}
