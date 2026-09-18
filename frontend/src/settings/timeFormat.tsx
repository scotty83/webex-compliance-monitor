import { createContext, useContext, useState, type ReactNode } from 'react'

export type TimeFormat = '12h' | '24h'

const LS_KEY = 'wcms.timeFormat'

function readStored(): TimeFormat {
  try {
    const stored = localStorage.getItem(LS_KEY)
    if (stored === '12h' || stored === '24h') return stored
  } catch {
    // localStorage unavailable (e.g. SSR or private browsing restriction)
  }
  return '24h'
}

interface TimeFormatContextValue {
  format: TimeFormat
  setFormat: (f: TimeFormat) => void
}

const TimeFormatContext = createContext<TimeFormatContextValue | null>(null)

export function TimeFormatProvider({ children }: { children: ReactNode }) {
  const [format, setFormatState] = useState<TimeFormat>(readStored)

  function setFormat(f: TimeFormat) {
    setFormatState(f)
    try {
      localStorage.setItem(LS_KEY, f)
    } catch {
      // ignore
    }
  }

  return (
    <TimeFormatContext.Provider value={{ format, setFormat }}>
      {children}
    </TimeFormatContext.Provider>
  )
}

export function useTimeFormat(): TimeFormatContextValue {
  const ctx = useContext(TimeFormatContext)
  if (!ctx) throw new Error('useTimeFormat must be used within TimeFormatProvider')
  return ctx
}
