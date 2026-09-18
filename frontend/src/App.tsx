import { useEffect, useState } from 'react'
import { useMeetings } from './hooks/useMeetings'
import type { Meeting } from './types'
import { Header } from './components/Header/Header'
import { TimeFormatProvider } from './settings/timeFormat'
import { OverviewView } from './components/overview/OverviewView'
import { ChaperoneView } from './components/chaperone/ChaperoneView'

export default function App() {
  const [activeId, setActiveId] = useState<string | null>(null)
  const { meetings, loading, error, refetch } = useMeetings({ peekMeetingId: activeId })
  const [now, setNow] = useState(() => Date.now())

  // 1s tick for elapsed-time displays; cleared on unmount
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(id)
  }, [])

  const activeMeeting: Meeting | undefined =
    activeId !== null ? meetings.find((m) => m.id === activeId) : undefined

  // Typed handlers — T9 will use these signatures
  const onOpenMeeting = (id: string) => setActiveId(id)
  const onBackToOverview = () => setActiveId(null)

  return (
    <TimeFormatProvider>
      {/* data-now exposed so elapsed-time components can read tick value */}
      <div className="app" data-now={now}>
        <Header meetings={meetings} now={now} />

        {activeId === null ? (
          <main data-view="overview">
            <OverviewView
              meetings={meetings}
              now={now}
              loading={loading}
              error={error}
              onRetry={refetch}
              onOpenMeeting={onOpenMeeting}
            />
          </main>
        ) : (
          <main data-view="chaperone" data-meeting-id={activeId}>
            <ChaperoneView
              activeMeeting={activeMeeting}
              meetings={meetings}
              now={now}
              onBackToOverview={onBackToOverview}
              onOpenMeeting={onOpenMeeting}
            />
          </main>
        )}
      </div>
    </TimeFormatProvider>
  )
}
