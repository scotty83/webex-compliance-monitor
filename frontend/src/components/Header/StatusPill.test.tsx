import { render, screen } from '@testing-library/react'
import { StatusPill } from './StatusPill'

test('shows correct count for 5 meetings', () => {
  render(<StatusPill count={5} />)
  expect(screen.getByText('5 meetings tracked')).toBeInTheDocument()
})

test('singular: "1 meeting tracked" for count=1', () => {
  render(<StatusPill count={1} />)
  expect(screen.getByText('1 meeting tracked')).toBeInTheDocument()
})

test('no text matching /recording/i anywhere in output', () => {
  const { container } = render(<StatusPill count={3} />)
  expect(container.textContent).not.toMatch(/recording/i)
})
