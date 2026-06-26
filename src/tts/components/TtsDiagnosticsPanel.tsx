import { useEffect, useMemo, useState } from 'react'
import {
  clearTtsDiagnostics,
  getTtsDiagnostics,
  subscribeTtsDiagnostics,
  type TtsDiagnosticEvent,
} from '../diagnostics/TtsDiagnostics'
import { isDebugEnabled } from '../../utils/debugFlags'
import { Panel } from '../../components/Panel/Panel'

interface TtsDiagnosticsPanelProps {
  enabled?: boolean
}

export function TtsDiagnosticsPanel({ enabled = isDebugEnabled() }: TtsDiagnosticsPanelProps) {
  // Developer-only panel; hidden unless debug mode is enabled by the app state
  // or the URL/localStorage gate in utils/debugFlags.
  if (!enabled) return null

  return <TtsDiagnosticsPanelBody />
}

function TtsDiagnosticsPanelBody() {
  const [events, setEvents] = useState<TtsDiagnosticEvent[]>(() => getTtsDiagnostics())

  useEffect(() => {
    return subscribeTtsDiagnostics(() => setEvents([...getTtsDiagnostics()]))
  }, [])

  const latest = events[0]
  const latestSummary = useMemo(() => summarizeLatest(latest), [latest])

  return (
    <Panel
      className="tts-diagnostics-panel"
      ariaLabel="TTS Diagnostics"
      title="TTS Diagnostics"
      meta={latestSummary}
      defaultOpen={false}
    >
      {events.length === 0 ? (
        <p className="no-results">No events yet.</p>
      ) : (
        <div className="tts-diagnostics-body">
          <div className="tts-diagnostics-actions">
            <span>{events.length} event{events.length === 1 ? '' : 's'}</span>
            <button className="tts-diagnostics-clear" onClick={clearTtsDiagnostics}>Clear</button>
          </div>
          <div className="tts-diagnostics-list">
            {events.map((event) => (
              <article key={event.id} className={'tts-diagnostic-event tts-diagnostic-' + event.level}>
                <div className="tts-diagnostic-header">
                  <span>{event.label}</span>
                  <time>{formatTime(event.timestamp)}</time>
                </div>
                <dl className="tts-diagnostic-grid">
                  {Object.entries(event.data).map(([key, value]) => (
                    <div key={key} className="tts-diagnostic-field">
                      <dt>{key}</dt>
                      <dd>{formatValue(value)}</dd>
                    </div>
                  ))}
                </dl>
              </article>
            ))}
          </div>
        </div>
      )}
    </Panel>
  )
}

function summarizeLatest(event: TtsDiagnosticEvent | undefined): string {
  if (!event) return 'No events'
  const actualDevice = event.data.actualDevice
  const rtf = event.data.realTimeFactor
  if (typeof actualDevice === 'string' && typeof rtf === 'number') {
    return actualDevice + ' / RTF ' + rtf
  }
  if (typeof actualDevice === 'string' && actualDevice) return actualDevice
  return event.label.replace('[tts-save] ', '')
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

function formatValue(value: unknown): string {
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : value.toFixed(2)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (value === null || value === undefined || value === '') return '-'
  return String(value)
}
