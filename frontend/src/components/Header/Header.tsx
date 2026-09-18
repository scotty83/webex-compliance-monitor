import type { Meeting } from '../../types'
import { StatusPill } from './StatusPill'
import { IssuesBadge } from './IssuesBadge'
import { OfficerBadge } from './OfficerBadge'
import { SettingsPanel } from './SettingsPanel'

interface HeaderProps {
  meetings: Meeting[]
  /** Tick from App — forwarded to IssuesBadge so the attention count clears in
   *  step with the Active/Past split. */
  now: number
}

export function Header({ meetings, now }: HeaderProps) {
  return (
    <header
      className="app-header"
      style={{
        position: 'sticky',
        top: 0,
        // minHeight (not height) so the ≤760px flex-wrap rule in
        // styles/responsive.css can grow the bar when clusters wrap
        minHeight: 'var(--header-height)',
        zIndex: 20, // --z-header
        background: 'rgba(16,17,20,.86)',
        backdropFilter: 'blur(14px)',
        WebkitBackdropFilter: 'blur(14px)',
        borderBottom: '1px solid var(--line)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        // Horizontal only — the ≤760px rule adds padding-block when rows wrap
        paddingInline: 24,
        gap: 16,
      }}
    >
      {/* Left — brand */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
        {/* 34px rounded-square logo mark */}
        <div
          style={{
            width: 34,
            height: 34,
            borderRadius: 8,
            background: 'linear-gradient(135deg, #1fa557 0%, #34c76a 100%)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
          }}
        >
          <svg
            width="20"
            height="20"
            viewBox="0 0 20 20"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            aria-hidden="true"
          >
            {/* headphones arc */}
            <path
              d="M4 11a6 6 0 0 1 12 0"
              stroke="white"
              strokeWidth="1.8"
              strokeLinecap="round"
              fill="none"
            />
            {/* left ear cup */}
            <rect x="2.5" y="11" width="3" height="5" rx="1.5" fill="white" />
            {/* right ear cup */}
            <rect x="14.5" y="11" width="3" height="5" rx="1.5" fill="white" />
          </svg>
        </div>

        <div>
          <div
            style={{
              fontWeight: 800,
              fontSize: 15,
              color: 'var(--tx1)',
              lineHeight: 1.1,
            }}
          >
            Compliance Monitor
          </div>
          <div
            style={{
              fontSize: 11,
              color: 'var(--tx2)',
              lineHeight: 1.1,
            }}
          >
            Webex monitoring console
          </div>
        </div>
      </div>

      {/* Middle — status cluster, hugs the brand (handoff) rather than centering */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          flexWrap: 'wrap',
          flex: 1,
          justifyContent: 'flex-start',
          paddingLeft: 24,
        }}
      >
        <StatusPill count={meetings.length} />
        <IssuesBadge meetings={meetings} now={now} />
      </div>

      {/* Right — controls */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
        <SettingsPanel />
        <div
          aria-hidden="true"
          style={{ width: 1, height: 26, background: 'var(--line)', flexShrink: 0 }}
        />
        <OfficerBadge />
      </div>
    </header>
  )
}
