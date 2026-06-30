import './TranslationPanel.css'
import type {
  TranslatedDocumentInfo,
  TranslationCapabilities,
  TranslationDeleteResult,
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
  selectedDocument: TranslationSeedDocument | null
  startState: {
    checking: boolean
    result: TranslationStartResult | null
    message: string
  }
  translatedDocuments: TranslatedDocumentInfo[]
  onDeleteTranslatedDocument: (id: string) => Promise<void>
  onStartTranslationPreflight: (document: TranslationSeedDocument) => Promise<void>
  refresh: () => Promise<void>
}

export function TranslationPanel({
  capabilities,
  deleteState,
  error,
  loading,
  selectedDocument,
  startState,
  translatedDocuments,
  onDeleteTranslatedDocument,
  onStartTranslationPreflight,
  refresh,
}: TranslationPanelProps) {
  const statusLabel = loading ? 'Checking' : capabilities?.available ? 'Available' : 'Planned'

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
          <span>{formatDocumentFormat(selectedDocument.format)} readiness can be checked before native translation ships.</span>
          <button
            type="button"
            disabled={startState.checking}
            title="Validate the selected document against the planned translation job pipeline"
            onClick={() => { void onStartTranslationPreflight(selectedDocument) }}
          >
            {startState.checking ? 'Checking...' : 'Check Readiness'}
          </button>
        </div>
      ) : (
        <div className="translation-empty-state">
          <h3>No document selected</h3>
          <p>Open a document and choose Translate from the document actions menu when the translation backend lands.</p>
        </div>
      )}

      {startState.message && (
        <div
          className={'translation-alert' + (startState.result ? '' : ' translation-alert-neutral')}
          role="status"
        >
          <strong>{startState.result ? 'Translation job response' : 'Translation preflight'}</strong>
          <span>{startState.message}</span>
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
                <div>
                  <strong>{model.name}</strong>
                  <span>{model.engine} · {model.tier} · {model.manifestState}</span>
                </div>
                <p>{model.notes}</p>
                <small>
                  {model.sourceLanguages.join(', ')} to {model.targetLanguages.join(', ')}
                </small>
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

function formatDocumentFormat(format?: string): string {
  if (!format) return 'Document'
  return format.toUpperCase()
}
