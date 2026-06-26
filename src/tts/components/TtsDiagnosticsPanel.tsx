import { useEffect, useMemo, useState } from 'react'
import {
  clearTtsDiagnostics,
  getTtsDiagnostics,
  subscribeTtsDiagnostics,
  type TtsDiagnosticLevel,
  type TtsDiagnosticEvent,
} from '../diagnostics/TtsDiagnostics'
import { isDebugEnabled } from '../../utils/debugFlags'
import { Panel } from '../../components/Panel/Panel'
import './TtsDiagnosticsPanel.css'

interface TtsDiagnosticsPanelProps {
  enabled?: boolean
}

type TtsDiagnosticCategory = 'all' | 'native' | 'save' | 'playback' | 'highlight' | 'other'
type TtsDiagnosticLevelFilter = 'all' | TtsDiagnosticLevel

export function TtsDiagnosticsPanel({ enabled = isDebugEnabled() }: TtsDiagnosticsPanelProps) {
  // Developer-only panel; hidden unless debug mode is enabled by the app state
  // or the URL/localStorage gate in utils/debugFlags.
  if (!enabled) return null

  return <TtsDiagnosticsPanelBody />
}

function TtsDiagnosticsPanelBody() {
  const [events, setEvents] = useState<TtsDiagnosticEvent[]>(() => getTtsDiagnostics())
  const [category, setCategory] = useState<TtsDiagnosticCategory>('all')
  const [level, setLevel] = useState<TtsDiagnosticLevelFilter>('all')
  const [copyStatus, setCopyStatus] = useState('')

  useEffect(() => {
    return subscribeTtsDiagnostics(() => setEvents([...getTtsDiagnostics()]))
  }, [])

  const filteredEvents = useMemo(() => events.filter((event) => {
    if (level !== 'all' && event.level !== level) return false
    if (category !== 'all' && getEventCategory(event) !== category) return false
    return true
  }), [category, events, level])

  const latest = events[0]
  const latestSummary = useMemo(() => summarizeLatest(latest), [latest])
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(filteredEvents, null, 2))
      setCopyStatus('Copied')
      window.setTimeout(() => setCopyStatus(''), 1600)
    } catch {
      setCopyStatus('Copy failed')
    }
  }

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
            <span>{filteredEvents.length} of {events.length} event{events.length === 1 ? '' : 's'}</span>
            <label>
              <span>Category</span>
              <select
                className="tts-diagnostics-filter"
                value={category}
                onChange={(event) => setCategory(event.target.value as TtsDiagnosticCategory)}
              >
                <option value="all">All</option>
                <option value="native">Native</option>
                <option value="save">Save</option>
                <option value="playback">Playback</option>
                <option value="highlight">Highlight</option>
              </select>
            </label>
            <label>
              <span>Level</span>
              <select
                className="tts-diagnostics-filter"
                value={level}
                onChange={(event) => setLevel(event.target.value as TtsDiagnosticLevelFilter)}
              >
                <option value="all">All</option>
                <option value="info">Info</option>
                <option value="warn">Warn</option>
                <option value="error">Error</option>
              </select>
            </label>
            <button className="tts-diagnostics-clear" onClick={handleCopy}>Copy JSON</button>
            <button className="tts-diagnostics-clear" onClick={clearTtsDiagnostics}>Clear</button>
            {copyStatus && <span className="tts-diagnostics-copy-status">{copyStatus}</span>}
          </div>
          <div className="tts-diagnostics-list">
            {filteredEvents.length === 0 ? (
              <p className="no-results">No events match the current filters.</p>
            ) : filteredEvents.map((event) => (
              <article key={event.id} className={'tts-diagnostic-event tts-diagnostic-' + event.level}>
                <div className="tts-diagnostic-header">
                  <span>
                    <span className="tts-diagnostic-category">{getEventCategory(event)}</span>
                    {event.label}
                  </span>
                  <time>{formatTime(event.timestamp)}</time>
                </div>
                <dl className="tts-diagnostic-grid">
                  {Object.entries(event.data).map(([key, value]) => (
                    <div key={key} className="tts-diagnostic-field">
                      <dt>{key}</dt>
                      <dd>{renderDiagnosticValue(value)}</dd>
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

function getEventCategory(event: TtsDiagnosticEvent): Exclude<TtsDiagnosticCategory, 'all'> {
  if (event.label.startsWith('[tts-native]')) return 'native'
  if (event.label.startsWith('[tts-save]')) return 'save'
  if (event.label.startsWith('[tts-playback]')) return 'playback'
  if (event.label.startsWith('[tts-highlight]')) return 'highlight'
  return 'other'
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

function renderDiagnosticValue(value: unknown) {
  if (Array.isArray(value) || (value && typeof value === 'object')) {
    return (
      <details className="tts-diagnostic-value-details">
        <summary>{previewDiagnosticValue(value)}</summary>
        <pre>{stringifyDiagnosticValue(value)}</pre>
      </details>
    )
  }
  return formatValue(value)
}

function previewDiagnosticValue(value: unknown): string {
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'
    if (value.every((item) => ['string', 'number', 'boolean'].includes(typeof item))) {
      const joined = value.map(String).join(', ')
      return joined.length > 80 ? joined.slice(0, 77) + '...' : joined
    }
    return '[' + value.length + ' item' + (value.length === 1 ? '' : 's') + ']'
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value)
    if (keys.length === 0) return '{}'
    const keyPreview = keys.slice(0, 3).join(', ')
    return '{' + keyPreview + (keys.length > 3 ? ', ...' : '') + '}'
  }
  return formatValue(value)
}

function stringifyDiagnosticValue(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}
