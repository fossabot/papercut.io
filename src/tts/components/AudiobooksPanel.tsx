import { useState } from 'react'
import type { SavedAudiobookRecord } from '../storage/AudiobookLibrary'
import type { AudiobookDownloadRecord } from '../storage/AudiobookDownloadQueue'
import type { TtsDtype, TtsVoice } from '../types'
import type { AudiobookCacheState } from '../hooks/useAudiobookCache'
import {
  formatAudiobookVoiceMeta,
  formatDownloadSavedStatus,
  formatDuration,
  formatSpeedLabel,
  formatStorageSize,
} from '../utils/format'
import { Panel } from '../../components/Panel/Panel'
import { AudioSetupPanel, type AudioSetupPanelProps } from './AudioSetupPanel'
import './AudiobooksPanel.css'

interface ActiveAudiobookSave {
  title: string
  url: string
  modelId: string
  textPreprocessor: string
  voice: TtsVoice
  speed: number
  dtype: TtsDtype
}

interface AudiobookExportState {
  id: string
  status: 'exporting' | 'exported' | 'cancelled' | 'error'
  message: string
}

interface AudiobookDeleteState {
  id: string
  status: 'deleting' | 'deleted' | 'error'
  message: string
}

interface AudiobookImportState {
  status: 'idle' | 'importing' | 'imported' | 'cancelled' | 'error'
  message: string
}

interface AudiobooksPanelProps {
  activeDownload: ActiveAudiobookSave | null
  audioSetup: AudioSetupPanelProps
  activeDownloadTitle: string
  deleteState: AudiobookDeleteState | null
  downloadState: AudiobookCacheState
  exportState: AudiobookExportState | null
  importState: AudiobookImportState
  documentOpening?: boolean
  isSaving: boolean
  queuedDownloads: AudiobookDownloadRecord[]
  savedAudiobooks: SavedAudiobookRecord[]
  onCancelSave: () => void
  onDeleteSaved: (record: SavedAudiobookRecord) => void
  onExportSaved: (record: SavedAudiobookRecord) => void
  onImportAudiobook: () => void
  onOpenSaved: (record: SavedAudiobookRecord) => void
  onRemoveQueued: (id: string) => void
  onResumeQueued: (record: AudiobookDownloadRecord) => void
}

export function AudiobooksPanel({
  activeDownload,
  audioSetup,
  activeDownloadTitle,
  deleteState,
  downloadState,
  exportState,
  importState,
  documentOpening = false,
  isSaving,
  queuedDownloads,
  savedAudiobooks,
  onCancelSave,
  onDeleteSaved,
  onExportSaved,
  onImportAudiobook,
  onOpenSaved,
  onRemoveQueued,
  onResumeQueued,
}: AudiobooksPanelProps) {
  const [setupOpen, setSetupOpen] = useState(false)
  const activePercent = getDownloadPercent(downloadState.cachedChunks, downloadState.totalChunks)
  const savedCount = savedAudiobooks.length
  const queueCount = queuedDownloads.length
  const meta = formatAudiobookMeta(isSaving, queueCount, savedCount)
  const hasAudiobooks = isSaving || queueCount > 0 || savedCount > 0
  const setupSummary = formatAudioSetupSummary(audioSetup)

  return (
    <Panel
      className="audiobooks-panel"
      ariaLabel="Audiobooks"
      title="Audiobooks"
      meta={meta}
      defaultOpen
    >
      <div className="audiobooks-actions-row">
        <button
          type="button"
          className="audiobooks-import-btn"
          disabled={importState.status === 'importing'}
          onClick={onImportAudiobook}
        >
          {importState.status === 'importing' ? '📂 Importing Bundle' : '📁 Import Bundle'}
        </button>

        <button
          type="button"
          className={'audiobooks-setup-disclosure' + (setupOpen ? ' audiobooks-setup-disclosure-open' : '')}
          aria-expanded={setupOpen}
          aria-controls="audiobooks-audio-setup"
          onClick={() => setSetupOpen((value) => !value)}
        >
          <span className="audiobooks-setup-disclosure-icon" aria-hidden="true">⚙</span>
          <span className="audiobooks-setup-disclosure-main">
            <span className="audiobooks-setup-disclosure-title">Audio Setup</span>
            <span className="audiobooks-setup-disclosure-summary">{setupSummary}</span>
          </span>
          <span className="audiobooks-setup-disclosure-chevron" aria-hidden="true">{setupOpen ? '▲' : '▼'}</span>
        </button>
        {importState.message && importState.status !== 'idle' && (
          <span className={'audiobooks-import-status document-import-' + importState.status}>
            {importState.message}
          </span>
        )}
      </div>

      {setupOpen && (
        <section id="audiobooks-audio-setup" className="audiobooks-section audiobooks-setup" aria-label="Audio Setup">
          <AudioSetupPanel {...audioSetup} />
        </section>
      )}

      {!hasAudiobooks && (
        <div className="audiobooks-empty">
          <h2>No saved audiobooks yet</h2>
          <p>Save audio from a document or import a Papercut audiobook bundle.</p>
        </div>
      )}

      <div className="audiobooks-list">
        {isSaving && (
          <section className="audiobooks-section" aria-label="Saving audiobook">
            <h3 className="audiobooks-section-title">Saving</h3>
            <div className="audiobook-item audiobook-item-active">
              <div className="audiobook-row">
                <span className="audiobook-title">{activeDownloadTitle}</span>
                <span className="audiobook-meta">{downloadState.cachedChunks}/{downloadState.totalChunks}</span>
              </div>
              <div className="audiobook-status-text">
                {activeDownload ? formatAudiobookVoiceMeta(activeDownload.modelId, activeDownload.voice, activeDownload.speed, activeDownload.dtype, activeDownload.textPreprocessor) + ' - ' : ''}{formatDownloadSavedStatus(downloadState.audioDurationSec, activePercent, downloadState.wavBytes)}
              </div>
              <div className="audiobook-meter" aria-label={'Saving audiobook ' + activePercent + '% complete'}>
                <span style={{ width: activePercent + '%' }} />
              </div>
              <button className="audiobook-secondary" onClick={onCancelSave}>Pause</button>
            </div>
          </section>
        )}

        {queueCount > 0 && (
          <section className="audiobooks-section" aria-label="Audiobook queue">
            <h3 className="audiobooks-section-title">Queue</h3>
            {queuedDownloads.map((record) => {
              const percent = getDownloadPercent(record.cachedChunks, record.totalChunks)
              return (
                <div key={record.id} className={'audiobook-item audiobook-item-' + record.status}>
                  <div className="audiobook-row">
                    <span className="audiobook-title">{record.title}</span>
                    <span className="audiobook-meta">{record.cachedChunks}/{record.totalChunks}</span>
                  </div>
                  <div className="audiobook-status-text">
                    {formatAudiobookVoiceMeta(record.modelId, record.voice, record.speed, record.dtype, record.textPreprocessor) + ' - ' + formatDownloadSavedStatus(record.audioDurationSec, percent, record.wavBytes)}
                  </div>
                  <div className="audiobook-meter" aria-label={'Audiobook save ' + percent + '% complete'}>
                    <span style={{ width: percent + '%' }} />
                  </div>
                  <div className="audiobook-actions">
                    <span className="audiobook-status-text">{record.message || record.status}</span>
                    <button className="audiobook-resume" onClick={() => onResumeQueued(record)}>
                      {record.status === 'error' ? 'Retry' : 'Resume'}
                    </button>
                    <button className="audiobook-secondary" onClick={() => onRemoveQueued(record.id)}>Remove</button>
                  </div>
                </div>
              )
            })}
          </section>
        )}

        {savedCount > 0 && (
          <section className="audiobooks-section" aria-label="Saved audiobooks">
            <h3 className="audiobooks-section-title">Saved</h3>
            {savedAudiobooks.map((record) => {
              const recordExportState = exportState?.id === record.id ? exportState : null
              const recordDeleteState = deleteState?.id === record.id ? deleteState : null
              const exporting = recordExportState?.status === 'exporting'
              const deleting = recordDeleteState?.status === 'deleting'
              const storage = formatStorageSize(record.wavBytes)
              return (
                <div key={record.id} className="audiobook-item audiobook-item-saved">
                  <button
                    className="audiobook-saved-main"
                    disabled={documentOpening}
                    onClick={() => { if (!documentOpening) onOpenSaved(record) }}
                  >
                    <span className="audiobook-title">{record.title}</span>
                    <span className="audiobook-meta">
                      {formatAudiobookVoiceMeta(record.modelId, record.voice, record.speed, record.dtype, record.textPreprocessor)}
                      {' - ' + record.chunks + ' chunks'}
                      {record.audioDurationSec ? ' - ' + formatDuration(record.audioDurationSec) : ''}
                      {storage ? ' - ' + storage : ''}
                    </span>
                  </button>
                  <button
                    className="audiobook-export"
                    disabled={exporting || deleting}
                    onClick={() => onExportSaved(record)}
                  >
                    {exporting ? 'Exporting' : 'Export Bundle'}
                  </button>
                  <button
                    className="audiobook-delete"
                    disabled={exporting || deleting}
                    onClick={() => onDeleteSaved(record)}
                  >
                    {deleting ? 'Deleting' : 'Delete'}
                  </button>
                  {recordExportState && (
                    <div
                      className={'audiobook-status-text audiobook-operation-status audiobook-export-' + recordExportState.status}
                      title={recordExportState.message}
                    >
                      {recordExportState.message}
                    </div>
                  )}
                  {recordDeleteState && (
                    <div
                      className={'audiobook-status-text audiobook-operation-status audiobook-delete-' + recordDeleteState.status}
                      title={recordDeleteState.message}
                    >
                      {recordDeleteState.message}
                    </div>
                  )}
                </div>
              )
            })}
          </section>
        )}

        {deleteState && deleteState.status !== 'deleting' && !savedAudiobooks.some((record) => record.id === deleteState.id) && (
          <div className={'audiobook-status-text audiobook-delete-summary audiobook-delete-' + deleteState.status}>
            {deleteState.message}
          </div>
        )}
      </div>
    </Panel>
  )
}

function formatAudiobookMeta(isSaving: boolean, queueCount: number, savedCount: number): string | undefined {
  const parts: string[] = []
  if (isSaving) parts.push('saving')
  if (queueCount > 0) parts.push(queueCount + ' queued')
  if (savedCount > 0) parts.push(savedCount + ' saved')
  return parts.length > 0 ? parts.join(' / ') : undefined
}

function getDownloadPercent(cachedChunks: number, totalChunks: number): number {
  if (totalChunks <= 0) return 0
  return Math.round((cachedChunks / totalChunks) * 100)
}

function formatAudioSetupSummary(audioSetup: AudioSetupPanelProps): string {
  const model = audioSetup.models.find((item) => item.id === audioSetup.modelId)
  const voice = audioSetup.voices.find((item) => item.id === audioSetup.voice)
  const pieces = [
    model?.name ?? 'Model',
    voice?.name ?? audioSetup.voice,
    formatSpeedLabel(audioSetup.speed),
  ]

  if (audioSetup.modelInstallProgress && audioSetup.modelInstallProgress.status !== 'installed') {
    pieces.push('Downloading ' + audioSetup.modelInstallProgress.percent + '%')
  } else if (audioSetup.modelStatus?.installed) {
    pieces.push('Installed')
  }

  return pieces.join(' · ')
}
