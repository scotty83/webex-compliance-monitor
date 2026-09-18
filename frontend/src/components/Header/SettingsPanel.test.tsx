import { render, screen, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SettingsPanel } from './SettingsPanel'
import { TimeFormatProvider } from '../../settings/timeFormat'

function wrap() {
  return render(
    <TimeFormatProvider>
      <SettingsPanel />
    </TimeFormatProvider>
  )
}

beforeEach(() => {
  localStorage.clear()
})

test('gear button is in the DOM with aria-label="Open settings"', () => {
  wrap()
  expect(screen.getByRole('button', { name: 'Open settings' })).toBeInTheDocument()
})

test('clicking gear opens the panel (dialog appears)', async () => {
  wrap()
  const gear = screen.getByRole('button', { name: 'Open settings' })
  await userEvent.click(gear)
  expect(screen.getByRole('dialog')).toBeInTheDocument()
})

test('panel has role="dialog"', async () => {
  wrap()
  await userEvent.click(screen.getByRole('button', { name: 'Open settings' }))
  expect(screen.getByRole('dialog')).toBeInTheDocument()
})

test('close button (aria-label="Close settings") closes the panel', async () => {
  wrap()
  await userEvent.click(screen.getByRole('button', { name: 'Open settings' }))
  expect(screen.getByRole('dialog')).toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: 'Close settings' }))
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
})

test('pressing Escape closes the panel', async () => {
  wrap()
  await userEvent.click(screen.getByRole('button', { name: 'Open settings' }))
  expect(screen.getByRole('dialog')).toBeInTheDocument()
  await userEvent.keyboard('{Escape}')
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
})

test('after close, focus returns to gear button', async () => {
  wrap()
  const gear = screen.getByRole('button', { name: 'Open settings' })
  await userEvent.click(gear)
  await userEvent.click(screen.getByRole('button', { name: 'Close settings' }))
  expect(document.activeElement).toBe(gear)
})

test('clicking backdrop closes the panel', async () => {
  wrap()
  await userEvent.click(screen.getByRole('button', { name: 'Open settings' }))
  expect(screen.getByRole('dialog')).toBeInTheDocument()
  // The backdrop has aria-hidden="true", find it via test-id or by clicking outside dialog
  const backdrop = document.querySelector('[data-testid="settings-backdrop"]') as HTMLElement
  expect(backdrop).toBeInTheDocument()
  await userEvent.click(backdrop)
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
})

test('12h button click persists to localStorage', async () => {
  wrap()
  await userEvent.click(screen.getByRole('button', { name: 'Open settings' }))
  // The toggle uses role="radio" on the underlying <button>
  await userEvent.click(screen.getByRole('radio', { name: '12h' }))
  expect(localStorage.getItem('wcms.timeFormat')).toBe('12h')
})

test('24h button click updates format', async () => {
  // Start with 12h persisted
  localStorage.setItem('wcms.timeFormat', '12h')
  wrap()
  await userEvent.click(screen.getByRole('button', { name: 'Open settings' }))
  await userEvent.click(screen.getByRole('radio', { name: '24h' }))
  expect(localStorage.getItem('wcms.timeFormat')).toBe('24h')
})

// Roving-tabindex selector: excludes buttons with tabindex="-1" (unselected radios)
const FOCUSABLE_SEL =
  'button:not([disabled]):not([tabindex="-1"]), [tabindex]:not([tabindex="-1"])'

test('focus trap: Tab from last focusable element wraps to first', async () => {
  wrap()
  await userEvent.click(screen.getByRole('button', { name: 'Open settings' }))

  const dialog = screen.getByRole('dialog')
  const focusables = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SEL))
  expect(focusables.length).toBeGreaterThan(0)

  // Focus the last focusable element
  act(() => {
    focusables[focusables.length - 1].focus()
  })

  // Tab should wrap to first
  await userEvent.tab()
  expect(document.activeElement).toBe(focusables[0])
})

test('focus trap: Shift+Tab from first focusable element wraps to last', async () => {
  wrap()
  await userEvent.click(screen.getByRole('button', { name: 'Open settings' }))

  const dialog = screen.getByRole('dialog')
  const focusables = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SEL))
  expect(focusables.length).toBeGreaterThan(0)

  // Focus the first focusable element
  act(() => {
    focusables[0].focus()
  })

  // Shift+Tab should wrap to last
  await userEvent.tab({ shift: true })
  expect(document.activeElement).toBe(focusables[focusables.length - 1])
})

test('ArrowRight in radiogroup moves selection from 12h to 24h', async () => {
  localStorage.setItem('wcms.timeFormat', '12h')
  wrap()
  await userEvent.click(screen.getByRole('button', { name: 'Open settings' }))

  const radio12h = screen.getByRole('radio', { name: '12h' })
  const radio24h = screen.getByRole('radio', { name: '24h' })
  expect(radio12h).toHaveAttribute('aria-checked', 'true')
  expect(radio24h).toHaveAttribute('aria-checked', 'false')

  // Focus 12h (it has tabindex=0 when selected) and press ArrowRight
  act(() => { radio12h.focus() })
  await userEvent.keyboard('{ArrowRight}')

  expect(radio24h).toHaveAttribute('aria-checked', 'true')
  expect(document.activeElement).toBe(radio24h)
})

test('ArrowLeft in radiogroup moves selection from 24h back to 12h (wrapping)', async () => {
  wrap() // default 24h
  await userEvent.click(screen.getByRole('button', { name: 'Open settings' }))

  const radio12h = screen.getByRole('radio', { name: '12h' })
  const radio24h = screen.getByRole('radio', { name: '24h' })
  expect(radio24h).toHaveAttribute('aria-checked', 'true')

  act(() => { radio24h.focus() })
  await userEvent.keyboard('{ArrowLeft}')

  expect(radio12h).toHaveAttribute('aria-checked', 'true')
  expect(document.activeElement).toBe(radio12h)
})

// ── Panel anchoring — top edge follows the header's measured bottom ──────────

function mockRect(bottom: number): DOMRect {
  return {
    bottom,
    top: 0,
    left: 0,
    right: 0,
    width: 0,
    height: bottom,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect
}

/** Render SettingsPanel next to a fake .app-header with a mocked rect. */
function wrapWithHeader(bottom: number) {
  const utils = render(
    <TimeFormatProvider>
      <header className="app-header" data-testid="fake-header" />
      <SettingsPanel />
    </TimeFormatProvider>
  )
  const header = screen.getByTestId('fake-header')
  header.getBoundingClientRect = () => mockRect(bottom)
  return { ...utils, header }
}

test('panel top falls back to 62px when no .app-header exists', async () => {
  wrap() // renders SettingsPanel without a header
  await userEvent.click(screen.getByRole('button', { name: 'Open settings' }))
  expect(screen.getByRole('dialog').style.top).toBe('62px')
})

test('panel top anchors to the measured header bottom (wrapped/taller header)', async () => {
  wrapWithHeader(110)
  await userEvent.click(screen.getByRole('button', { name: 'Open settings' }))
  expect(screen.getByRole('dialog').style.top).toBe('110px')
})

test('panel re-measures the header on window resize', async () => {
  const { header } = wrapWithHeader(110)
  await userEvent.click(screen.getByRole('button', { name: 'Open settings' }))
  expect(screen.getByRole('dialog').style.top).toBe('110px')

  // Header grows (e.g. clusters wrap at a narrower width)
  header.getBoundingClientRect = () => mockRect(140)
  act(() => {
    window.dispatchEvent(new Event('resize'))
  })

  expect(screen.getByRole('dialog').style.top).toBe('140px')
})
