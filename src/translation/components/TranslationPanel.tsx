import { useMemo, useState } from 'react'
import './TranslationPanel.css'
import type {
  TranslatedDocumentInfo,
  TranslationCapabilities,
  TranslationDeleteResult,
  TranslationJobProgress,
  TranslationModelInstallProgress,
  TranslationModelInstallResult,
  TranslationModelInfo,
  TranslationModelStatus,
  TranslationStartRequest,
  TranslationStartResult,
} from '../api/nativeTranslation'

export interface TranslationSeedDocument {
  title: string
  url: string
  format?: string
}

interface TranslationPanelProps {
  capabilities: TranslationCapabilities | null
  deleteState: TranslationDeleteResult | null
  error: string
  loading: boolean
  modelInstallState: {
    installingModelId: string
    progress: TranslationModelInstallProgress | null
    result: TranslationModelInstallResult | null
    message: string
  }
  modelStatuses: Record<string, TranslationModelStatus>
  selectedDocument: TranslationSeedDocument | null
  startState: {
    cancelling: boolean
    checking: boolean
    jobId: string
    progress: TranslationJobProgress | null
    result: TranslationStartResult | null
    message: string
  }
  translatedDocuments: TranslatedDocumentInfo[]
  onCancelTranslation: () => Promise<void>
  onDeleteTranslatedDocument: (id: string) => Promise<void>
  onOpenTranslatedDocument: (url: string) => void | Promise<void>
  onInstallTranslationModel: (modelId: string) => Promise<void>
  onStartTranslationPreflight: (request: TranslationStartRequest) => Promise<void>
  refresh: () => Promise<void>
}

export function TranslationPanel({
  capabilities,
  deleteState,
  error,
  loading,
  modelInstallState,
  modelStatuses,
  selectedDocument,
  startState,
  translatedDocuments,
  onCancelTranslation,
  onDeleteTranslatedDocument,
  onOpenTranslatedDocument,
  onInstallTranslationModel,
  onStartTranslationPreflight,
  refresh,
}: TranslationPanelProps) {
  const statusLabel = loading ? 'Checking' : capabilities?.available ? 'Available' : 'Planned'
  const modelOptions = useMemo(() => capabilities?.models ?? [], [capabilities])
  const [modelId, setModelId] = useState('')
  const [sourceLanguage, setSourceLanguage] = useState('auto')
  const [targetLanguage, setTargetLanguage] = useState('en')
  const [qualityMode, setQualityMode] = useState('balanced')
  const activeModelId = modelOptions.some((model) => model.id === modelId) ? modelId : modelOptions[0]?.id ?? ''
  const selectedModel = useMemo(
    () => modelOptions.find((model) => model.id === activeModelId) ?? null,
    [activeModelId, modelOptions],
  )
  const sourceLanguages = useMemo(
    () => uniqueOptions(['auto', ...(selectedModel?.sourceLanguages ?? [])]),
    [selectedModel],
  )
  const targetLanguages = useMemo(
    () => uniqueOptions(selectedModel?.targetLanguages.length ? selectedModel.targetLanguages : ['en']),
    [selectedModel],
  )
  const qualityModes = useMemo(
    () => uniqueOptions([
      selectedModel?.defaultQualityMode ?? capabilities?.defaultQualityMode ?? 'balanced',
      'fast',
      'balanced',
      'quality',
    ]),
    [capabilities, selectedModel],
  )
  const activeSourceLanguage = sourceLanguages.includes(sourceLanguage) ? sourceLanguage : 'auto'
  const activeTargetLanguage = targetLanguages.includes(targetLanguage) ? targetLanguage : targetLanguages[0] ?? 'en'
  const activeQualityMode = qualityModes.includes(qualityMode) ? qualityMode : qualityModes[0] ?? 'balanced'

  return (
    <section className="translation-panel" aria-label="Offline translation">
      <div className="translation-panel-header">
        <div>
          <h2>Offline Translation</h2>
          <p>Translate long-form HTML and EPUB documents into durable document copies.</p>
        </div>
        <button
          type="button"
          className="translation-status-pill"
          onClick={() => { void refresh() }}
          disabled={loading}
          title="Refresh translation capabilities"
        >
          {statusLabel}
        </button>
      </div>

      {error && (
        <div className="translation-alert translation-alert-error" role="alert">
          {error}
        </div>
      )}

      {capabilities && !capabilities.available && (
        <div className="translation-alert">
          <strong>Translation backend unavailable.</strong>
          <span>{capabilities.reason}</span>
        </div>
      )}

      {selectedDocument ? (
        <div className="translation-selected-document">
          <span className="translation-kicker">Selected Document</span>
          <strong>{selectedDocument.title}</strong>
          <span>{formatDocumentFormat(selectedDocument.format)} translation runs as a separate generated document copy.</span>
          <div className="translation-preflight-controls" aria-label="Translation readiness options">
            <label>
              <span>Model</span>
              <select
                value={activeModelId}
                disabled={!modelOptions.length || startState.checking}
                onChange={(event) => {
                  const nextModelId = event.target.value
                  const nextModel = modelOptions.find((model) => model.id === nextModelId)
                  setModelId(nextModelId)
                  setSourceLanguage('auto')
                  setTargetLanguage(nextModel?.targetLanguages[0] ?? 'en')
                  setQualityMode(nextModel?.defaultQualityMode ?? capabilities?.defaultQualityMode ?? 'balanced')
                }}
              >
                {modelOptions.length ? modelOptions.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.name}
                  </option>
                )) : (
                  <option value="">No planned models</option>
                )}
              </select>
            </label>
            <label>
              <span>Source</span>
              <select
                value={activeSourceLanguage}
                disabled={startState.checking}
                onChange={(event) => setSourceLanguage(event.target.value)}
              >
                {sourceLanguages.map((language) => (
                  <option key={language} value={language}>
                    {formatLanguageLabel(language)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Target</span>
              <select
                value={activeTargetLanguage}
                disabled={startState.checking}
                onChange={(event) => setTargetLanguage(event.target.value)}
              >
                {targetLanguages.map((language) => (
                  <option key={language} value={language}>
                    {formatLanguageLabel(language)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Quality</span>
              <select
                value={activeQualityMode}
                disabled={startState.checking}
                onChange={(event) => setQualityMode(event.target.value)}
              >
                {qualityModes.map((mode) => (
                  <option key={mode} value={mode}>
                    {formatQualityLabel(mode)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="translation-action-row">
            <button
              type="button"
              disabled={startState.checking || !activeModelId}
              title="Run the selected document through the translation job pipeline"
              onClick={() => {
                void onStartTranslationPreflight({
                  documentUrl: selectedDocument.url,
                  sourceLanguage: activeSourceLanguage,
                  targetLanguage: activeTargetLanguage,
                  modelId: activeModelId,
                  qualityMode: activeQualityMode,
                })
              }}
            >
              {startState.checking ? 'Translating...' : 'Run Translation'}
            </button>
            {startState.checking && (
              <button
                type="button"
                className="translation-cancel-btn"
                disabled={startState.cancelling}
                onClick={() => { void onCancelTranslation() }}
              >
                {startState.cancelling ? 'Cancelling...' : 'Cancel'}
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="translation-empty-state">
          <h3>No document selected</h3>
          <p>Open a document and choose Translate from the document actions menu.</p>
        </div>
      )}

      {startState.message && (
        <div
          className={'translation-alert' + (startState.result ? '' : ' translation-alert-neutral')}
          role="status"
        >
          <strong>{startState.result ? 'Translation job response' : 'Translation preflight'}</strong>
          <span>{startState.message}</span>
          {startState.progress && (
            <TranslationProgressMeter progress={startState.progress} />
          )}
        </div>
      )}

      {modelInstallState.message && (
        <div
          className={'translation-alert' + (modelInstallState.result ? '' : ' translation-alert-neutral')}
          role="status"
        >
          <strong>{modelInstallState.result ? 'Model installed' : 'Model install'}</strong>
          <span>{modelInstallState.message}</span>
          {modelInstallState.progress && modelInstallState.progress.status !== 'installed' && (
            <div className="translation-progress-meter" aria-label={'Translation model download ' + modelInstallState.progress.percent + '% complete'}>
              <span style={{ width: modelInstallState.progress.percent + '%' }} />
            </div>
          )}
        </div>
      )}

      <div className="translation-roadmap-grid">
        <article>
          <h3>Target Architecture</h3>
          <p>Translation will create a separate document variant so original imports, search rows, and audiobook caches stay unchanged.</p>
        </article>
        <article>
          <h3>Job Model</h3>
          <p>Long books should translate chapter and section batches with progress, cancel/resume, quality checks, and cached segment output.</p>
        </article>
        <article>
          <h3>Model Catalog</h3>
          <p>Model choices should mirror TTS: verified downloads, platform-aware catalogs, and explicit speed/quality tradeoffs.</p>
        </article>
      </div>

      <section className="translation-section" aria-label="Candidate translation models">
        <div className="translation-section-header">
          <h3>Candidate Models</h3>
          <span>{capabilities?.models.length ?? 0} planned</span>
        </div>
        {capabilities?.models.length ? (
          <div className="translation-model-list">
            {capabilities.models.map((model) => (
              <article key={model.id} className="translation-model-item">
                <div className="translation-model-item-header">
                  <div>
                    <strong>{model.name}</strong>
                    <span>{model.engine} · {model.tier} · {model.manifestState}</span>
                  </div>
                  <TranslationModelInstallButton
                    model={model}
                    progress={modelInstallState.progress?.modelId === model.id ? modelInstallState.progress : null}
                    status={modelStatuses[model.id]}
                    disabled={Boolean(modelInstallState.installingModelId)}
                    onInstall={onInstallTranslationModel}
                  />
                </div>
                <p>{model.notes}</p>
                <small>
                  {model.sourceLanguages.join(', ')} to {model.targetLanguages.join(', ')}
                </small>
                {modelStatuses[model.id] && (
                  <small>{formatModelStatus(modelStatuses[model.id])}</small>
                )}
                <small>{model.licenseNotes}</small>
                <small>{model.sizeNotes}</small>
              </article>
            ))}
          </div>
        ) : (
          <p className="translation-section-empty">No model metadata available in this runtime.</p>
        )}
      </section>

      <section className="translation-section" aria-label="Translated documents">
        <div className="translation-section-header">
          <h3>Translated Documents</h3>
          <span>{translatedDocuments.length} saved</span>
        </div>
        {deleteState && (
          <div className={'translation-alert' + (deleteState.deleted ? '' : ' translation-alert-error')} role="status">
            {deleteState.message}
          </div>
        )}
        {translatedDocuments.length > 0 ? (
          <div className="translation-document-list">
            {translatedDocuments.map((doc) => (
              <article key={doc.id} className="translation-document-item">
                <div>
                  <strong>{doc.title}</strong>
                  <span>{doc.sourceLanguage} to {doc.targetLanguage} · {doc.modelId} · {doc.status}</span>
                </div>
                <button
                  type="button"
                  className="translation-document-view-btn"
                  onClick={() => { void onOpenTranslatedDocument(doc.documentUrl) }}
                >
                  View
                </button>
                <button
                  type="button"
                  className="translation-document-delete-btn"
                  onClick={() => { void onDeleteTranslatedDocument(doc.id) }}
                >
                  Delete
                </button>
              </article>
            ))}
          </div>
        ) : (
          <p className="translation-section-empty">No translated documents yet.</p>
        )}
      </section>
    </section>
  )
}

function TranslationProgressMeter({ progress }: { progress: TranslationJobProgress }) {
  return (
    <div className="translation-job-progress">
      <div className="translation-job-progress-header">
        <span>{formatQualityLabel(progress.status)}</span>
        <span>{progress.percent}%</span>
      </div>
      <div
        className="translation-progress-meter"
        aria-label={'Translation job ' + progress.percent + '% complete'}
      >
        <span style={{ width: progress.percent + '%' }} />
      </div>
      <small>
        {progress.completedSegments} of {progress.totalSegments} segments · {progress.completedBatches} of {progress.totalBatches} batches
      </small>
      {progress.cachedSegments > 0 && (
        <small>
          Reused {progress.cachedSegments} cached segment{progress.cachedSegments === 1 ? '' : 's'}
          {progress.translatedSegments > 0 ? ' · Translated ' + progress.translatedSegments + ' fresh' : ''}
          {progress.reusedSegmentsInBatch > 0 ? ' · Current batch reused ' + progress.reusedSegmentsInBatch : ''}
        </small>
      )}
      {progress.preview && <small>Preview: {progress.preview}</small>}
    </div>
  )
}

interface TranslationModelInstallButtonProps {
  disabled: boolean
  model: TranslationModelInfo
  progress: TranslationModelInstallProgress | null
  status?: TranslationModelStatus
  onInstall: (modelId: string) => Promise<void>
}

function TranslationModelInstallButton({
  disabled,
  model,
  progress,
  status,
  onInstall,
}: TranslationModelInstallButtonProps) {
  const installable = model.manifestState === 'pinned-file-manifest'
  const installing = progress !== null || status?.installing
  if (status?.installed) {
    return <span className="translation-model-badge">Installed</span>
  }
  if (!installable) {
    return <span className="translation-model-badge translation-model-badge-muted">Planned</span>
  }
  return (
    <button
      type="button"
      className="translation-model-install-btn"
      disabled={disabled || installing}
      onClick={() => { void onInstall(model.id) }}
    >
      {installing ? 'Installing ' + (progress?.percent ?? 0) + '%' : 'Install'}
    </button>
  )
}

function formatDocumentFormat(format?: string): string {
  if (!format) return 'Document'
  return format.toUpperCase()
}

function formatLanguageLabel(language: string): string {
  if (language === 'auto') return 'Auto detect'
  return language.toUpperCase()
}

function formatQualityLabel(mode: string): string {
  return mode.charAt(0).toUpperCase() + mode.slice(1)
}

function formatModelStatus(status: TranslationModelStatus): string {
  if (status.installed) {
    return 'Installed · ' + formatBytes(status.installedBytes)
  }
  if (status.installing) {
    return 'Download in progress · ' + formatBytes(status.archiveBytes)
  }
  if (status.archiveBytes > 0) {
    return 'Download size · ' + formatBytes(status.archiveBytes)
  }
  return status.message
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB'
  const mb = bytes / (1024 * 1024)
  if (mb < 1024) return mb.toFixed(mb >= 100 ? 0 : 1) + ' MB'
  const gb = mb / 1024
  return gb.toFixed(gb >= 10 ? 1 : 2) + ' GB'
}

function uniqueOptions(values: string[]): string[] {
  return values.filter((value, index) => value && values.indexOf(value) === index)
}
