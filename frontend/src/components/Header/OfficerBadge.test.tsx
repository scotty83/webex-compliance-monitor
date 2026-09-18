import { render, screen } from '@testing-library/react'
import { OfficerBadge } from './OfficerBadge'
import type { Officer } from '../../types'

// Mock useOfficer so we can control what it returns per test
vi.mock('../../auth/AuthGate', () => ({
  useOfficer: vi.fn(),
}))

import { useOfficer } from '../../auth/AuthGate'
const mockUseOfficer = useOfficer as ReturnType<typeof vi.fn>

function setOfficer(officer: Officer | null) {
  mockUseOfficer.mockReturnValue(officer)
}

beforeEach(() => {
  vi.clearAllMocks()
})

test('shows initials "DW" for email "dana.whitfield@compliance.example"', () => {
  setOfficer({ email: 'dana.whitfield@compliance.example', role: 'officer' })
  render(<OfficerBadge />)
  expect(screen.getByText('DW')).toBeInTheDocument()
})

test('shows display name "Dana Whitfield" for email "dana.whitfield@compliance.example"', () => {
  setOfficer({ email: 'dana.whitfield@compliance.example', role: 'officer' })
  render(<OfficerBadge />)
  expect(screen.getByText('Dana Whitfield')).toBeInTheDocument()
})

test('shows "AL" initials for email "alice@compliance.example"', () => {
  setOfficer({ email: 'alice@compliance.example', role: 'officer' })
  render(<OfficerBadge />)
  expect(screen.getByText('AL')).toBeInTheDocument()
})

test('shows "Alice" name for email "alice@compliance.example"', () => {
  setOfficer({ email: 'alice@compliance.example', role: 'officer' })
  render(<OfficerBadge />)
  expect(screen.getByText('Alice')).toBeInTheDocument()
})

test('renders nothing when useOfficer() returns null', () => {
  setOfficer(null)
  const { container } = render(<OfficerBadge />)
  expect(container.firstChild).toBeNull()
})
