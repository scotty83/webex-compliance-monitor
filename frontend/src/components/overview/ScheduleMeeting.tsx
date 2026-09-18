import { useEffect, useRef, useState } from 'react'
import { CalendarPlus, X } from 'lucide-react'
import { useOfficer } from '../../auth/AuthGate'
import { scheduleMeeting, ApiError } from '../../api/client'
import type { CreatedMeeting } from '../../types'

// Mirrors backend/src/meetings/routes.ts EMAIL_RE — same "looks like an email" bar.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// Spec copy: officers never see the form, so a 403 at submit means the scope.
const SCOPE_403_MESSAGE =
  'The Service App is missing the meeting-create scope — ask your Webex admin to add it.'

/** Next FUTURE quarter-hour (:00/:15/:30/:45) in LOCAL time, split into the
 *  <input type="date"> (YYYY-MM-DD) and <input type="time"> (HH:MM) values the
 *  form binds. Always strictly after `now`: on an exact boundary it advances to
 *  the following quarter (setMinutes rolls the hour/day on overflow). */
function nextQuarterHourFields(now: Date): { date: string; time: string } {
  const d = new Date(now)
  d.setSeconds(0, 0)
  d.setMinutes(Math.floor(d.getMinutes() / 15) * 15 + 15)
  const pad = (n: number) => String(n).padStart(2, '0')
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  }
}

// SettingsPanel's selector + inputs (this dialog has text/date/time/number fields).
function getFocusable(el: HTMLElement): HTMLElement[] {
  return Array.from(
    el.querySelectorAll<HTMLElement>(
      'button:not([disabled]):not([tabindex="-1"]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )
  )
}

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: 12,
  fontWeight: 600,
  color: 'var(--tx2)',
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
  marginBottom: 6,
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '8px 10px',
  borderRadius: 'var(--radius-sm)',
  border: '1px solid var(--line)',
  background: 'var(--s1)',
  color: 'var(--tx1)',
  fontSize: 13,
}

export function ScheduleMeeting() {
  const officer = useOfficer()
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [date, setDate] = useState('')
  const [time, setTime] = useState('')
  const [duration, setDuration] = useState('30')
  const [invitees, setInvitees] = useState<string[]>([])
  const [inviteeDraft, setInviteeDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [created, setCreated] = useState<CreatedMeeting | null>(null)
  const [copied, setCopied] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  // Focus-return guard: only refocus the trigger after a REAL close — without
  // this, the mount-time effect run would steal page focus (SettingsPanel gets
  // away with it; two components doing it would fight).
  const wasOpen = useRef(false)

  // Focus first field on open; restore trigger focus on close (dialog contract).
  useEffect(() => {
    if (open) {
      setTimeout(() => {
        if (panelRef.current) getFocusable(panelRef.current)[0]?.focus()
      }, 0)
    } else if (wasOpen.current) {
      triggerRef.current?.focus()
    }
    wasOpen.current = open
  }, [open])

  // Keyboard: Escape closes + Tab trap (SettingsPanel pattern).
  useEffect(() => {
    if (!open) return

    function handleKeyDown(e: globalThis.KeyboardEvent) {
      if (e.key === 'Escape') {
        handleClose()
        return
      }
      if (e.key === 'Tab' && panelRef.current) {
        const focusables = getFocusable(panelRef.current)
        if (focusables.length === 0) return
        const first = focusables[0]
        const last = focusables[focusables.length - 1]
        if (e.shiftKey) {
          if (document.activeElement === first) {
            e.preventDefault()
            last.focus()
          }
        } else {
          if (document.activeElement === last) {
            e.preventDefault()
            first.focus()
          }
        }
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- handleClose reads `created`
  }, [open, created])

  // Hidden ENTIRELY for officers / no session (spec: role !== 'admin').
  // All hooks are above this line (rules of hooks).
  if (officer?.role !== 'admin') return null

  /** Open a fresh form pre-filled with the nearest future quarter-hour. Only
   *  seeds date/time when both are empty, so a mid-edit reopen keeps the user's
   *  values; resetForm() blanks them after a success so the next open recomputes
   *  from the clock. */
  function openForm() {
    if (date === '' && time === '') {
      const next = nextQuarterHourFields(new Date())
      setDate(next.date)
      setTime(next.time)
    }
    setOpen(true)
  }

  function resetForm() {
    setTitle('')
    setDate('')
    setTime('')
    setDuration('30')
    setInvitees([])
    setInviteeDraft('')
    setError(null)
    setCreated(null)
    setCopied(false)
  }

  /** Close: after a success, reset so the next open is a blank form;
   *  mid-edit close keeps the field values (accidental Esc is recoverable). */
  function handleClose() {
    if (created) resetForm()
    else setError(null)
    setOpen(false)
  }

  function commitDraft(): boolean {
    const raw = inviteeDraft.trim().replace(/,+$/, '')
    if (raw === '') return true
    if (!EMAIL_RE.test(raw)) {
      setError(`"${raw}" is not a valid email address`)
      return false
    }
    if (!invitees.includes(raw)) setInvitees([...invitees, raw])
    setInviteeDraft('')
    setError(null)
    return true
  }

  function handleInviteeKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault() // Enter commits a chip; it must not submit the form
      commitDraft()
    } else if (e.key === 'Backspace' && inviteeDraft === '' && invitees.length > 0) {
      setInvitees(invitees.slice(0, -1))
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    // Commit a pending draft so a typed-but-uncommitted email is never dropped.
    const draft = inviteeDraft.trim().replace(/,+$/, '')
    let finalInvitees = invitees
    if (draft !== '') {
      if (!EMAIL_RE.test(draft)) {
        setError(`"${draft}" is not a valid email address`)
        return
      }
      finalInvitees = invitees.includes(draft) ? invitees : [...invitees, draft]
    }
    // Mirrors backend validation (routes.ts) so most errors never round-trip.
    if (title.trim() === '') {
      setError('Title is required')
      return
    }
    if (date === '' || time === '') {
      setError('Start date and time are required')
      return
    }
    const start = new Date(`${date}T${time}`).getTime()
    if (Number.isNaN(start)) {
      setError('Start date and time are required')
      return
    }
    if (start <= Date.now()) {
      setError('Start must be in the future')
      return
    }
    const durationMinutes = Number(duration)
    if (!Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 480) {
      setError('Duration must be a whole number between 1 and 480 minutes')
      return
    }

    setError(null)
    setSubmitting(true)
    scheduleMeeting({ title: title.trim(), start, durationMinutes, invitees: finalInvitees })
      .then((m) => {
        setInvitees(finalInvitees)
        setInviteeDraft('')
        setCreated(m)
      })
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 403) setError(SCOPE_403_MESSAGE)
        else if (err instanceof Error) setError(err.message)
        else setError('Scheduling failed — try again')
      })
      .finally(() => setSubmitting(false))
  }

  function copyJoinUrl() {
    if (!created) return
    void navigator.clipboard.writeText(created.joinUrl)
      .then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
      })
      .catch(() => setError('Copy failed — select the link manually'))
  }

  return (
    <>
      {/* Trigger — .join-btn supplies the on-brand green focus-visible ring */}
      <button
        ref={triggerRef}
        type="button"
        className="join-btn"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={openForm}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 14px',
          borderRadius: 'var(--radius-sm)',
          border: '1px solid rgba(52,199,106,.3)',
          background: 'var(--green-bg)',
          color: 'var(--green)',
          fontWeight: 600,
          fontSize: 13,
          cursor: 'pointer',
          flexShrink: 0,
        }}
      >
        <CalendarPlus size={16} strokeWidth={2} aria-hidden="true" />
        Schedule meeting
      </button>

      {open && (
        <>
          {/* Backdrop */}
          <div
            data-testid="schedule-backdrop"
            aria-hidden="true"
            onClick={handleClose}
            style={{
              position: 'fixed',
              inset: 0,
              zIndex: 40, // --z-settings-overlay tier
              background: 'rgba(0,0,0,0.4)',
            }}
          />

          {/* Centering wrapper — pointerEvents none so backdrop clicks land */}
          <div
            style={{
              position: 'fixed',
              inset: 0,
              zIndex: 42, // --z-settings-panel tier
              display: 'flex',
              alignItems: 'flex-start',
              justifyContent: 'center',
              paddingTop: '10vh',
              pointerEvents: 'none',
            }}
          >
            <div
              ref={panelRef}
              role="dialog"
              aria-modal="true"
              aria-label="Schedule a meeting"
              style={{
                pointerEvents: 'auto',
                background: 'var(--s2)',
                border: '1px solid var(--line)',
                borderRadius: 'var(--radius-lg)',
                width: 'min(440px, calc(100vw - 32px))',
                maxHeight: '80vh',
                overflowY: 'auto',
                padding: 20,
                // Reused animation; the global prefers-reduced-motion `*` rule
                // in styles/global.css zeroes it for reduced-motion users.
                animation: 'settingsSlide 200ms ease-out',
              }}
            >
              {/* Panel header */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  marginBottom: 16,
                }}
              >
                <span style={{ fontWeight: 700, fontSize: 14, color: 'var(--tx1)' }}>
                  {created ? 'Meeting scheduled' : 'Schedule a meeting'}
                </span>
                <button
                  aria-label="Close schedule form"
                  onClick={handleClose}
                  className="icon-btn"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: 28,
                    height: 28,
                    borderRadius: 'var(--radius-sm)',
                    border: 'none',
                    background: 'transparent',
                    color: 'var(--tx2)',
                    cursor: 'pointer',
                  }}
                >
                  <X size={16} aria-hidden="true" />
                </button>
              </div>

              {created ? (
                /* ── Success panel ─────────────────────────────────────── */
                <div>
                  <p style={{ fontSize: 13, color: 'var(--tx1)', fontWeight: 600, marginTop: 0 }}>
                    {created.title}
                  </p>
                  <p style={{ fontSize: 13, color: 'var(--tx2)', marginTop: 4 }}>
                    {new Date(created.start).toLocaleString()}
                  </p>

                  <div style={{ marginTop: 12 }}>
                    <span style={labelStyle}>Join link</span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <a
                        href={created.joinUrl}
                        target="_blank"
                        rel="noreferrer"
                        style={{
                          fontSize: 13,
                          color: 'var(--green)',
                          overflowWrap: 'anywhere',
                        }}
                      >
                        {created.joinUrl}
                      </a>
                      <button
                        type="button"
                        onClick={copyJoinUrl}
                        className="icon-btn"
                        style={{
                          flexShrink: 0,
                          padding: '4px 10px',
                          borderRadius: 'var(--radius-sm)',
                          border: '1px solid var(--line)',
                          background: 'transparent',
                          color: 'var(--tx2)',
                          fontSize: 12,
                          fontWeight: 600,
                          cursor: 'pointer',
                        }}
                      >
                        Copy join link
                      </button>
                    </div>
                    <p aria-live="polite" style={{ fontSize: 12, color: 'var(--green)', minHeight: 16, margin: '4px 0 0' }}>
                      {copied ? 'Join link copied' : ''}
                    </p>
                  </div>

                  <div style={{ marginTop: 8 }}>
                    <span style={labelStyle}>SIP address (bot dial target)</span>
                    <p style={{ fontSize: 13, color: 'var(--tx1)', margin: 0, overflowWrap: 'anywhere' }}>
                      {created.sipAddress}
                    </p>
                  </div>

                  <p style={{ fontSize: 12, color: 'var(--tx2)', marginTop: 12 }}>
                    Invitees have been emailed by Webex. It will appear in Upcoming within a few seconds.
                  </p>

                  <button
                    type="button"
                    onClick={handleClose}
                    className="join-btn"
                    style={{
                      marginTop: 8,
                      padding: '8px 14px',
                      borderRadius: 'var(--radius-sm)',
                      border: '1px solid rgba(52,199,106,.3)',
                      background: 'var(--green-bg)',
                      color: 'var(--green)',
                      fontWeight: 600,
                      fontSize: 13,
                      cursor: 'pointer',
                    }}
                  >
                    Done
                  </button>
                </div>
              ) : (
                /* ── Form ──────────────────────────────────────────────── */
                <form onSubmit={handleSubmit} noValidate>
                  <div style={{ marginBottom: 12 }}>
                    <label htmlFor="sched-title" style={labelStyle}>Title</label>
                    <input
                      id="sched-title"
                      type="text"
                      value={title}
                      onChange={(e) => setTitle(e.target.value)}
                      style={inputStyle}
                    />
                  </div>

                  <div style={{ display: 'flex', gap: 10, marginBottom: 12 }}>
                    <div style={{ flex: 1 }}>
                      <label htmlFor="sched-date" style={labelStyle}>Date</label>
                      <input
                        id="sched-date"
                        type="date"
                        value={date}
                        onChange={(e) => setDate(e.target.value)}
                        style={inputStyle}
                      />
                    </div>
                    <div style={{ flex: 1 }}>
                      <label htmlFor="sched-time" style={labelStyle}>Time</label>
                      <input
                        id="sched-time"
                        type="time"
                        value={time}
                        onChange={(e) => setTime(e.target.value)}
                        style={inputStyle}
                      />
                    </div>
                  </div>

                  <div style={{ marginBottom: 12 }}>
                    <label htmlFor="sched-duration" style={labelStyle}>Duration (minutes)</label>
                    <input
                      id="sched-duration"
                      type="number"
                      min={1}
                      max={480}
                      step={1}
                      value={duration}
                      onChange={(e) => setDuration(e.target.value)}
                      style={inputStyle}
                    />
                  </div>

                  <div style={{ marginBottom: 12 }}>
                    <label htmlFor="sched-invitees" style={labelStyle}>Invitees</label>
                    {invitees.length > 0 && (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 6 }}>
                        {invitees.map((email) => (
                          <span
                            key={email}
                            style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: 4,
                              padding: '2px 6px 2px 8px',
                              borderRadius: 'var(--radius-sm)',
                              border: '1px solid var(--line)',
                              background: 'var(--s1)',
                              color: 'var(--tx1)',
                              fontSize: 12,
                            }}
                          >
                            {email}
                            <button
                              type="button"
                              aria-label={`Remove ${email}`}
                              onClick={() => setInvitees(invitees.filter((i) => i !== email))}
                              className="icon-btn"
                              style={{
                                display: 'flex',
                                border: 'none',
                                background: 'transparent',
                                color: 'var(--tx2)',
                                cursor: 'pointer',
                                padding: 2,
                              }}
                            >
                              <X size={12} aria-hidden="true" />
                            </button>
                          </span>
                        ))}
                      </div>
                    )}
                    <input
                      id="sched-invitees"
                      type="text"
                      value={inviteeDraft}
                      onChange={(e) => setInviteeDraft(e.target.value)}
                      onKeyDown={handleInviteeKeyDown}
                      placeholder="email — press Enter or comma to add"
                      style={inputStyle}
                    />
                  </div>

                  {error !== null && (
                    <p role="alert" style={{ fontSize: 12, color: 'var(--red, #e5484d)', margin: '0 0 10px' }}>
                      {error}
                    </p>
                  )}

                  <button
                    type="submit"
                    disabled={submitting}
                    className="join-btn"
                    style={{
                      width: '100%',
                      padding: '9px 0',
                      borderRadius: 'var(--radius-sm)',
                      border: '1px solid rgba(52,199,106,.3)',
                      background: 'var(--green-bg)',
                      color: 'var(--green)',
                      fontWeight: 600,
                      fontSize: 13,
                      cursor: submitting ? 'wait' : 'pointer',
                      opacity: submitting ? 0.6 : 1,
                    }}
                  >
                    {submitting ? 'Scheduling…' : 'Schedule'}
                  </button>
                </form>
              )}
            </div>
          </div>
        </>
      )}
    </>
  )
}
