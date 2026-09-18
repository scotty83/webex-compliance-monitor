import { render, screen, act } from '@testing-library/react'
import { TimeFormatProvider, useTimeFormat } from './timeFormat'

// Helper component that reads context and exposes controls
function Consumer() {
  const { format, setFormat } = useTimeFormat()
  return (
    <div>
      <span data-testid="format">{format}</span>
      <button onClick={() => setFormat('12h')}>set12</button>
      <button onClick={() => setFormat('24h')}>set24</button>
    </div>
  )
}

function wrap() {
  return render(
    <TimeFormatProvider>
      <Consumer />
    </TimeFormatProvider>
  )
}

beforeEach(() => {
  localStorage.clear()
})

test('default is 24h', () => {
  wrap()
  expect(screen.getByTestId('format').textContent).toBe('24h')
})

test('setFormat("12h") updates context so consumers re-render with 12h', () => {
  wrap()
  act(() => {
    screen.getByText('set12').click()
  })
  expect(screen.getByTestId('format').textContent).toBe('12h')
})

test('setFormat("12h") persists to localStorage under key wcms.timeFormat', () => {
  wrap()
  act(() => {
    screen.getByText('set12').click()
  })
  expect(localStorage.getItem('wcms.timeFormat')).toBe('12h')
})

test('on init reads persisted value from localStorage', () => {
  localStorage.setItem('wcms.timeFormat', '12h')
  wrap()
  expect(screen.getByTestId('format').textContent).toBe('12h')
})
