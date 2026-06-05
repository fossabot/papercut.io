import { useState } from 'react'
import type { SavedAudiobookRecord } from '../storage/AudiobookLibrary'
import type { AudiobookDownloadRecord } from '../storage/AudiobookDownloadQueue'
import type { KokoroDtype, KokoroVoice } from '../types'
import type { AudiobookCacheState } from '../hooks/useAudiobookCache'
import {
  formatAudiobookVoiceMeta,
  formatDownloadSavedStatus,
  formatDuration,
  formatStorageSize,
} from '../utils/format'
import { Panel } from '../../components/Panel/Panel'
import { AudioSetupPanel, type AudioSetupPanelProps } from './AudioSetupPanel'

interface ActiveAudiobookSave {
  title: string
  url: string
  voice: KokoroVoice
  speed: number
  dtype: KokoroDtype
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
  isSaving: boolean
  queuedDownloads: AudiobookDownloadRecord[]
  savedAudiobooks: SavedAudiobookRecord[]
  outdatedAudiobooks: SavedAudiobookRecord[]
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
  isSaving,
  queuedDownloads,
  savedAudiobooks,
  outdatedAudiobooks,
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
  const outdatedCount = outdatedAudiobooks.length
  const queueCount = queuedDownloads.length
  const meta = formatAudiobookMeta(isSaving, queueCount, savedCount, outdatedCount)
  const hasAudiobooks = isSaving || queueCount > 0 || savedCount > 0 || outdatedCount > 0

  return (
    <Panel
      className="audiobooks-panel"
      ariaLabel="Audiobooks"
      title="Audiobooks"
      meta={meta}
      defaultOpen
    >
      <div className="audiobooks-toolbar">
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
          className={'audiobooks-setup-btn' + (setupOpen ? ' audiobooks-setup-btn-open' : '')}
          aria-expanded={setupOpen}
          aria-label={setupOpen ? 'Hide audio setup' : 'Show audio setup'}
          title="Audio setup"
          onClick={() => setSetupOpen((value) => !value)}
        >
          <span aria-hidden="true">⚙</span>
        </button>
        {importState.message && importState.status !== 'idle' && (
          <span className={'audiobooks-import-status document-import-' + importState.status}>
            {importState.message}
          </span>
        )}
      </div>

      {setupOpen && (
        <section className="audiobooks-section audiobooks-setup" aria-label="Audio setup">
          <h3 className="audiobooks-section-title">Audio setup</h3>
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
                {activeDownload ? formatAudiobookVoiceMeta(activeDownload.voice, activeDownload.speed, activeDownload.dtype) + ' - ' : ''}{formatDownloadSavedStatus(downloadState.audioDurationSec, activePercent, downloadState.wavBytes)}
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
                    {formatAudiobookVoiceMeta(record.voice, record.speed, record.dtype) + ' - ' + formatDownloadSavedStatus(record.audioDurationSec, percent, record.wavBytes)}
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
                    onClick={() => onOpenSaved(record)}
                  >
                    <span className="audiobook-title">{record.title}</span>
                    <span className="audiobook-meta">
                      {formatAudiobookVoiceMeta(record.voice, record.speed, record.dtype)}
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

        {outdatedCount > 0 && (
          <section className="audiobooks-section" aria-label="Outdated audiobooks">
            <h3 className="audiobooks-section-title">Outdated audio</h3>
            {outdatedAudiobooks.map((record) => {
              const recordDeleteState = deleteState?.id === record.id ? deleteState : null
              const deleting = recordDeleteState?.status === 'deleting'
              const storage = formatStorageSize(record.wavBytes)
              return (
                <div key={record.id} className="audiobook-item audiobook-item-saved audiobook-item-outdated">
                  <div className="audiobook-saved-main audiobook-saved-main-disabled">
                    <span className="audiobook-title">{record.title}</span>
                    <span className="audiobook-meta">
                      {formatAudiobookVoiceMeta(record.voice, record.speed, record.dtype)}
                      {' - ' + record.chunks + ' chunks'}
                      {record.audioDurationSec ? ' - ' + formatDuration(record.audioDurationSec) : ''}
                      {storage ? ' - ' + storage : ''}
                    </span>
                    <span className="audiobook-status-text audiobook-outdated-status">
                      {record.recovered
                        ? 'Recovered imported audio. Playback and export are unavailable; delete it to reclaim storage.'
                        : 'Created with an older or incompatible audio version. Playback and export are unavailable.'}
                    </span>
                  </div>
                  <button
                    className="audiobook-delete"
                    disabled={deleting}
                    onClick={() => onDeleteSaved(record)}
                  >
                    {deleting ? 'Deleting' : 'Delete'}
                  </button>
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

        {deleteState && deleteState.status !== 'deleting' && !savedAudiobooks.some((record) => record.id === deleteState.id) && !outdatedAudiobooks.some((record) => record.id === deleteState.id) && (
          <div className={'audiobook-status-text audiobook-delete-summary audiobook-delete-' + deleteState.status}>
            {deleteState.message}
          </div>
        )}
      </div>
    </Panel>
  )
}

function formatAudiobookMeta(isSaving: boolean, queueCount: number, savedCount: number, outdatedCount: number): string | undefined {
  const parts: string[] = []
  if (isSaving) parts.push('saving')
  if (queueCount > 0) parts.push(queueCount + ' queued')
  if (savedCount > 0) parts.push(savedCount + ' saved')
  if (outdatedCount > 0) parts.push(outdatedCount + ' outdated')
  return parts.length > 0 ? parts.join(' / ') : undefined
}

function getDownloadPercent(cachedChunks: number, totalChunks: number): number {
  if (totalChunks <= 0) return 0
  return Math.round((cachedChunks / totalChunks) * 100)
}
