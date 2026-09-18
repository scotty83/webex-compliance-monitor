// Self-hosted fonts — Mulish weights
import '@fontsource/mulish/400.css'
import '@fontsource/mulish/400-italic.css'
import '@fontsource/mulish/500.css'
import '@fontsource/mulish/600.css'
import '@fontsource/mulish/700.css'
import '@fontsource/mulish/800.css'
// Self-hosted fonts — IBM Plex Mono weights
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/500.css'
import '@fontsource/ibm-plex-mono/600.css'
// Design tokens
import './tokens.css'
// Global styles (must come after tokens)
import './styles/global.css'
// Structural responsive rules (T14 — must come after global to win the cascade)
import './styles/responsive.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { AuthGate } from './auth/AuthGate'
import App from './App'

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('Root element not found')

createRoot(rootEl).render(
  <StrictMode>
    <AuthGate>
      <App />
    </AuthGate>
  </StrictMode>,
)
