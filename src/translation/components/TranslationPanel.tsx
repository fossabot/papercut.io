import './TranslationPanel.css'

export interface TranslationSeedDocument {
  title: string
  url: string
  format?: string
}

interface TranslationPanelProps {
  selectedDocument: TranslationSeedDocument | null
}

export function TranslationPanel({ selectedDocument }: TranslationPanelProps) {
  return (
    <section className="translation-panel" aria-label="Offline translation">
      <div className="translation-panel-header">
        <div>
          <h2>Offline Translation</h2>
          <p>Translate long-form HTML and EPUB documents into durable document copies.</p>
        </div>
        <span className="translation-status-pill">Planned</span>
      </div>

      {selectedDocument ? (
        <div className="translation-selected-document">
          <span className="translation-kicker">Selected Document</span>
          <strong>{selectedDocument.title}</strong>
          <span>{formatDocumentFormat(selectedDocument.format)} translation setup is not implemented yet.</span>
        </div>
      ) : (
        <div className="translation-empty-state">
          <h3>No document selected</h3>
          <p>Open a document and choose Translate from the document actions menu when the translation backend lands.</p>
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
    </section>
  )
}

function formatDocumentFormat(format?: string): string {
  if (!format) return 'Document'
  return format.toUpperCase()
}
