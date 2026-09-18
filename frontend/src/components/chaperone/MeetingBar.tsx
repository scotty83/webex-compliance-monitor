import type { CSSProperties } from 'react'
import { ChevronLeft, Eye, Pause, Play, RotateCw } from 'lucide-react'
import type { Meeting } from '../../types'
import type { UseLiveAudioResult } from '../../hooks/useLiveAudio'
import { BotStatusIndicator } from '../BotStatusIndicator'
import { AudioMeter } from './AudioMeter'
import { useTimeFormat } from '../../settings/timeFormat'
import { formatStartTime, formatElapsed } from '../../lib/time'

// ── Status helpers ────────────────────────────────────────────────────────────

function statusText(live: UseLiveAudioResult): string {
  if (live.status === 'error') return live.error?.message ?? 'Error'
  if (live.status === 'connecting') return 'Connecting…'
  if (live.status === 'paused')    return 'Paused'
  if (live.status === 'listening') return 'Listening'
  return 'Idle'
}

function statusDotColor(live: UseLiveAudioResult): string {
  if (live.status === 'listening') return 'var(--green)'
  if (live.status === 'error')     return 'var(--red)'
  if (live.status === 'connecting')return 'var(--amber)'
  return 'var(--tx3)'
}

// Shared inline style for the listen-control buttons (Pause/Resume/Reconnect)
// so the error-state Reconnect button matches the Pause/Resume styling exactly.
const listenBtnStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '6px',
  background: 'var(--s2)',
  border: '1px solid var(--line)',
  borderRadius: 'var(--radius-sm)',
  padding: '8px 14px',
  cursor: 'pointer',
  color: 'var(--tx1)',
  fontSize: '13.5px',
  fontWeight: 700,
  fontFamily: 'var(--font-ui)',
}

// ── Component ─────────────────────────────────────────────────────────────────

interface MeetingBarProps {
  meeting: Meeting
  now: number
  live: UseLiveAudioResult
  onBack: () => void
  /** View-only (bot not connected): replaces the meter/pause/reconnect cluster
   *  with a badge + the bot's fail-loud lastError. `live` is ignored. */
  readOnly?: boolean
}

export function MeetingBar({ meeting: m, now, live, onBack, readOnly = false }: MeetingBarProps) {
  const { format } = useTimeFormat()

  const startTime = formatStartTime(m.startedAt, format)
  const elapsed   = formatElapsed(now, m.startedAt)
  const label     = statusText(live)
  const dotColor  = statusDotColor(live)
  const isError   = live.status === 'error'
  const isPaused  = live.status === 'paused'
  const isListening = live.status === 'listening'

  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '18px',
        background: 'var(--s1)',
        borderRadius: 'var(--radius-lg)',
        gap: '16px',
        flexWrap: 'wrap',
      }}
    >
      {/* ── Left cluster ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', minWidth: 0 }}>
        {/* Back button */}
        <button
          className="icon-btn"
          onClick={onBack}
          aria-label="Back to overview"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '4px',
            background: 'var(--s2)',
            border: '1px solid var(--line)',
            borderRadius: 'var(--radius-sm)',
            padding: '6px 10px',
            cursor: 'pointer',
            color: 'var(--tx1)',
            fontSize: '14px',
            flexShrink: 0,
            fontFamily: 'var(--font-ui)',
          }}
        >
          <ChevronLeft size={16} aria-hidden="true" />
          Overview
        </button>

        {/* Meeting title + sub-line */}
        <div style={{ minWidth: 0 }}>
          <h2
            style={{
              fontFamily: 'var(--font-ui)',
              fontWeight: 800,
              fontSize: '18px',
              color: 'var(--tx1)',
              margin: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {m.title}
          </h2>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              fontSize: '12px',
              color: 'var(--tx2)',
              flexWrap: 'wrap',
              marginTop: '2px',
            }}
          >
            <span>{m.org}</span>
            <span aria-hidden="true" style={{ color: 'var(--tx3)' }}>·</span>
            <BotStatusIndicator state={m.botState} prefix="Bot " showLabel size="sm" />
            <span aria-hidden="true" style={{ color: 'var(--tx3)' }}>·</span>
            <span>
              {'Started '}
              <time
                dateTime={new Date(m.startedAt).toISOString()}
                style={{ fontFamily: 'var(--font-mono)' }}
              >
                {startTime}
              </time>
              {' · '}
              {elapsed}
            </span>
          </div>
        </div>
      </div>

      {/* ── Right cluster — listen controls OR view-only badge ── */}
      {readOnly ? (
        <div
          data-testid="view-only-badge"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
            background: 'var(--s2)',
            border: '1px solid var(--line)',
            borderRadius: '12px',
            padding: '8px 14px',
            flexShrink: 0,
          }}
        >
          <Eye size={16} aria-hidden="true" style={{ color: 'var(--tx2)', flexShrink: 0 }} />
          <div>
            <span
              style={{
                fontSize: '13.5px',
                fontWeight: 800,
                color: 'var(--tx1)',
                fontFamily: 'var(--font-ui)',
              }}
            >
              View only
            </span>
            <div
              style={{
                fontSize: '11px',
                fontWeight: 600,
                color: 'var(--tx2)', // tx3 fails AA at this size
                marginTop: '2px',
              }}
            >
              Bot not in call — no live audio
            </div>
          </div>
          {/* Fail-loud: the reason the bot isn't here, verbatim from BotStatus */}
          {m.lastError && (
            <span
              role="alert"
              style={{
                color: 'var(--red)',
                fontFamily: 'var(--font-mono)',
                fontSize: '12px',
                maxWidth: '360px',
              }}
            >
              {m.lastError}
            </span>
          )}
        </div>
      ) : (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
            flexShrink: 0,
          }}
        >
          {/* Meter + status cluster — bordered sub-panel per handoff */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '12px',
              background: 'var(--s2)',
              border: '1px solid var(--line)',
              borderRadius: '12px',
              padding: '8px 14px',
            }}
          >
            <AudioMeter levels={live.levels} status={live.status} />

            {/* Status label + sub-label */}
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <span
                  aria-hidden="true"
                  style={{
                    width: '8px',
                    height: '8px',
                    borderRadius: '50%',
                    backgroundColor: dotColor,
                    display: 'inline-block',
                    flexShrink: 0,
                  }}
                />
                {/* aria-live so status changes are announced to screen-readers */}
                <span
                  aria-live="polite"
                  style={{
                    fontSize: '13.5px',
                    fontWeight: isError ? 700 : 800,
                    color: isError
                      ? 'var(--red)'
                      : isListening
                        ? 'var(--green)'
                        : 'var(--tx1)',
                    fontFamily: 'var(--font-ui)',
                  }}
                >
                  {label}
                </span>
              </div>
              <div
                style={{
                  fontSize: '11px',
                  fontWeight: 600,
                  color: 'var(--tx2)', // tx3 fails AA at this size
                  marginTop: '2px',
                }}
              >
                Listen-only · audio
              </div>
            </div>
          </div>

          {/* Pause / Resume button — shown only when actionable */}
          {(isListening || isPaused) && (
            <button
              className="icon-btn"
              onClick={isPaused ? live.resume : live.pause}
              aria-label={isPaused ? 'Resume audio' : 'Pause audio'}
              style={listenBtnStyle}
            >
              {isPaused ? (
                <Play size={16} aria-hidden="true" />
              ) : (
                <Pause size={16} aria-hidden="true" />
              )}
              {isPaused ? 'Resume audio' : 'Pause audio'}
            </button>
          )}

          {/* Reconnect button — error state must not be a dead end; resume()
              resets wantOpen/retriedRef and reconnects */}
          {isError && (
            <button
              className="icon-btn"
              onClick={live.resume}
              aria-label="Reconnect audio"
              style={listenBtnStyle}
            >
              <RotateCw size={16} aria-hidden="true" />
              Reconnect
            </button>
          )}
        </div>
      )}
    </div>
  )
}
