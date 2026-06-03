import type { SavedAudiobookRecord } from './AudiobookLibrary'
import type { AudiobookDownloadRecord } from './AudiobookDownloadQueue'
import type { KokoroDtype, KokoroVoice } from './types'
import type { AudiobookCacheState } from './useAudiobookCache'
import {
  formatAudiobookVoiceMeta,
  formatDownloadSavedStatus,
  formatDuration,
  formatStorageSize,
} from './format'

interface ActiveAudiobookDownload {
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

interface AudiobookDownloadsPanelProps {
  activeDownload: ActiveAudiobookDownload | null
  activeDownloadTitle: string
  deleteState: AudiobookDeleteState | null
  downloadState: AudiobookCacheState
  exportState: AudiobookExportState | null
  isSaving: boolean
  queuedDownloads: AudiobookDownloadRecord[]
  savedAudiobooks: SavedAudiobookRecord[]
  showDownloads: boolean
  onCancelSave: () => void
  onDeleteSaved: (record: SavedAudiobookRecord) => void
  onExportSaved: (record: SavedAudiobookRecord) => void
  onOpenSaved: (record: SavedAudiobookRecord) => void
  onRemoveQueued: (id: string) => void
  onResumeQueued: (record: AudiobookDownloadRecord) => void
  onToggleDownloads: () => void
}

export function AudiobookDownloadsPanel({
  activeDownload,
  activeDownloadTitle,
  deleteState,
  downloadState,
  exportState,
  isSaving,
  queuedDownloads,
  savedAudiobooks,
  showDownloads,
  onCancelSave,
  onDeleteSaved,
  onExportSaved,
  onOpenSaved,
  onRemoveQueued,
  onResumeQueued,
  onToggleDownloads,
}: AudiobookDownloadsPanelProps) {
  if (!isSaving && queuedDownloads.length === 0 && savedAudiobooks.length === 0) return null

  const activePercent = getDownloadPercent(downloadState.cachedChunks, downloadState.totalChunks)

  return (
    <div className="downloads-panel">
      <button
        className="downloads-toggle"
        onClick={onToggleDownloads}
      >
        <span>Downloads</span>
        <span className={`toggle-arrow ${showDownloads ? 'open' : ''}`}>&#9662;</span>
      </button>
      {showDownloads && (
        <div className="downloads-list">
          {isSaving && (
            <div className="download-item download-item-active">
              <div className="download-row">
                <span className="download-title">{activeDownloadTitle}</span>
                <span className="download-count">{downloadState.cachedChunks}/{downloadState.totalChunks}</span>
              </div>
              <div className="download-status-text">
                {activeDownload ? formatAudiobookVoiceMeta(activeDownload.voice, activeDownload.speed, activeDownload.dtype) + ' • ' : ''}{formatDownloadSavedStatus(downloadState.audioDurationSec, activePercent, downloadState.wavBytes)}
              </div>
              <div className="download-meter" aria-label={'Saving audiobook ' + activePercent + '% complete'}>
                <span style={{ width: activePercent + '%' }} />
              </div>
              <button className="download-cancel" onClick={onCancelSave}>Pause</button>
            </div>
          )}

          {queuedDownloads.map((record) => {
            const percent = getDownloadPercent(record.cachedChunks, record.totalChunks)
            return (
              <div key={record.id} className={'download-item download-item-' + record.status}>
                <div className="download-row">
                  <span className="download-title">{record.title}</span>
                  <span className="download-count">{record.cachedChunks}/{record.totalChunks}</span>
                </div>
                <div className="download-status-text">
                  {formatAudiobookVoiceMeta(record.voice, record.speed, record.dtype) + ' • ' + formatDownloadSavedStatus(record.audioDurationSec, percent, record.wavBytes)}
                </div>
                <div className="download-meter" aria-label={'Audiobook save ' + percent + '% complete'}>
                  <span style={{ width: percent + '%' }} />
                </div>
                <div className="download-actions">
                  <span className="download-status-text">{record.message || record.status}</span>
                  <button className="download-resume" onClick={() => onResumeQueued(record)}>
                    {record.status === 'error' ? 'Retry' : 'Resume'}
                  </button>
                  <button className="download-cancel" onClick={() => onRemoveQueued(record.id)}>Remove</button>
                </div>
              </div>
            )
          })}

          {savedAudiobooks.map((record) => {
            const recordExportState = exportState?.id === record.id ? exportState : null
            const recordDeleteState = deleteState?.id === record.id ? deleteState : null
            const exporting = recordExportState?.status === 'exporting'
            const deleting = recordDeleteState?.status === 'deleting'
            const storage = formatStorageSize(record.wavBytes)
            return (
              <div
                key={record.id}
                className="download-item download-item-saved"
              >
                <button
                  className="download-saved-main"
                  onClick={() => onOpenSaved(record)}
                >
                  <span className="download-title">{record.title}</span>
                  <span className="download-count">
                    {formatAudiobookVoiceMeta(record.voice, record.speed, record.dtype)}
                    {' • ' + record.chunks + ' chunks'}
                    {record.audioDurationSec ? ' • ' + formatDuration(record.audioDurationSec) : ''}
                    {storage ? ' • ' + storage : ''}
                  </span>
                </button>
                <button
                  className="download-export"
                  disabled={exporting || deleting}
                  onClick={() => onExportSaved(record)}
                >
                  {exporting ? 'Exporting' : 'Export Bundle'}
                </button>
                <button
                  className="download-delete"
                  disabled={exporting || deleting}
                  onClick={() => onDeleteSaved(record)}
                >
                  {deleting ? 'Deleting' : 'Delete'}
                </button>
                {recordExportState && (
                  <div
                    className={'download-status-text download-export-status download-export-' + recordExportState.status}
                    title={recordExportState.message}
                  >
                    {recordExportState.message}
                  </div>
                )}
                {recordDeleteState && (
                  <div
                    className={'download-status-text download-export-status download-delete-' + recordDeleteState.status}
                    title={recordDeleteState.message}
                  >
                    {recordDeleteState.message}
                  </div>
                )}
              </div>
            )
          })}

          {deleteState && deleteState.status !== 'deleting' && !savedAudiobooks.some((record) => record.id === deleteState.id) && (
            <div className={'download-status-text download-delete-summary download-delete-' + deleteState.status}>
              {deleteState.message}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function getDownloadPercent(cachedChunks: number, totalChunks: number): number {
  if (totalChunks <= 0) return 0
  return Math.round((cachedChunks / totalChunks) * 100)
}
