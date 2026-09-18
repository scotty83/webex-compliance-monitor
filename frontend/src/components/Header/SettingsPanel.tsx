import { useRef, useState, useEffect, useLayoutEffect } from 'react'
import { Settings, X } from 'lucide-react'
import { useTimeFormat, type TimeFormat } from '../../settings/timeFormat'

const formats: TimeFormat[] = ['12h', '24h']

function getFocusable(el: HTMLElement): HTMLElement[] {
  return Array.from(
    el.querySelectorAll<HTMLElement>(
      'button:not([disabled]):not([tabindex="-1"]), [tabindex]:not([tabindex="-1"])'
    )
  )
}

const sampleDate = new Date(2025, 0, 1, 14, 30, 0)

// Desktop single-row header height (--header-height); measurement fallback
const HEADER_HEIGHT = 62

export function SettingsPanel() {
  const [open, setOpen] = useState(false)
  const [panelTop, setPanelTop] = useState(HEADER_HEIGHT)
  const gearRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const radioRefs = useRef<(HTMLButtonElement | null)[]>([null, null])
  const { format, setFormat } = useTimeFormat()

  function close() {
    setOpen(false)
  }

  function handleRadioKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const idx = formats.indexOf(format)
    let nextIdx: number | null = null

    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault()
      nextIdx = (idx + 1) % formats.length
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault()
      nextIdx = (idx - 1 + formats.length) % formats.length
    }

    if (nextIdx !== null) {
      setFormat(formats[nextIdx])
      radioRefs.current[nextIdx]?.focus()
    }
  }

  // Anchor the panel to the header's real bottom edge — the ≤760px flex-wrap
  // rule in styles/responsive.css lets the header grow taller than the
  // desktop --header-height, so a static top would overlap wrapped rows.
  useLayoutEffect(() => {
    if (!open) return

    function measure() {
      setPanelTop(
        document.querySelector('.app-header')?.getBoundingClientRect().bottom ??
          HEADER_HEIGHT
      )
    }

    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [open])

  // Focus first element in panel on open; restore gear focus on close
  useEffect(() => {
    if (open) {
      setTimeout(() => {
        if (panelRef.current) {
          const focusables = getFocusable(panelRef.current)
          focusables[0]?.focus()
        }
      }, 0)
    } else {
      gearRef.current?.focus()
    }
  }, [open])

  // Keyboard: Escape + Tab trap
  useEffect(() => {
    if (!open) return

    function handleKeyDown(e: globalThis.KeyboardEvent) {
      if (e.key === 'Escape') {
        close()
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
  }, [open])

  const sampleTime = sampleDate.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: format === '12h',
  })

  return (
    <>
      {/* Gear button */}
      <button
        ref={gearRef}
        aria-label="Open settings"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
        className="icon-btn"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 36,
          height: 36,
          borderRadius: 'var(--radius-sm)',
          border: 'none',
          background: 'transparent',
          color: 'var(--tx2)',
          cursor: 'pointer',
          flexShrink: 0,
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.color = 'var(--tx1)'
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.color = 'var(--tx2)'
        }}
      >
        <Settings size={18} strokeWidth={2} aria-hidden="true" />
      </button>

      {open && (
        <>
          {/* Backdrop */}
          <div
            data-testid="settings-backdrop"
            aria-hidden="true"
            onClick={close}
            style={{
              position: 'fixed',
              inset: 0,
              zIndex: 40, // --z-settings-overlay
              background: 'rgba(0,0,0,0.4)',
            }}
          />

          {/* Panel */}
          <div
            ref={panelRef}
            role="dialog"
            aria-label="Settings"
            aria-modal="true"
            className="settings-panel"
            style={{
              position: 'fixed',
              top: panelTop,
              right: 24,
              zIndex: 42, // --z-settings-panel
              background: 'var(--s2)',
              border: '1px solid var(--line)',
              borderRadius: 'var(--radius-lg)',
              width: 280,
              padding: 20,
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
              <span
                style={{
                  fontWeight: 700,
                  fontSize: 14,
                  color: 'var(--tx1)',
                }}
              >
                Settings
              </span>
              <button
                aria-label="Close settings"
                onClick={close}
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

            {/* Time format section */}
            <div>
              <div
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  color: 'var(--tx3)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.06em',
                  marginBottom: 10,
                }}
              >
                Time format
              </div>

              {/* Segmented toggle — radiogroup with roving tabindex + arrow-key nav */}
              <div
                role="radiogroup"
                aria-label="Time format"
                onKeyDown={handleRadioKeyDown}
                style={{ display: 'flex', gap: 6, marginBottom: 10 }}
              >
                {formats.map((f, idx) => (
                  <button
                    key={f}
                    ref={(el) => { radioRefs.current[idx] = el }}
                    type="button"
                    role="radio"
                    aria-checked={format === f}
                    aria-label={f}
                    tabIndex={format === f ? 0 : -1}
                    onClick={() => setFormat(f)}
                    className="icon-btn"
                    style={{
                      flex: 1,
                      padding: '6px 0',
                      borderRadius: 'var(--radius-sm)',
                      fontSize: 13,
                      fontWeight: 600,
                      cursor: 'pointer',
                      background: format === f ? 'var(--green-bg)' : 'transparent',
                      color: format === f ? 'var(--green)' : 'var(--tx2)',
                      border:
                        format === f
                          ? '1px solid rgba(52,199,106,.3)'
                          : '1px solid var(--line)',
                      transition: 'all 150ms ease',
                    }}
                  >
                    {f}
                  </button>
                ))}
              </div>

              {/* Sample time preview */}
              <div
                style={{
                  fontSize: 12,
                  color: 'var(--tx3)',
                  textAlign: 'center',
                }}
              >
                Preview:{' '}
                <span style={{ color: 'var(--tx2)', fontWeight: 600 }}>
                  {sampleTime}
                </span>
              </div>
            </div>
          </div>
        </>
      )}
    </>
  )
}
