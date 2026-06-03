import type { DocumentInfo } from '../../types/search'
import type { AuthorGroup } from '../../hooks/useDocumentFilters'

interface DocumentsPanelStatus {
  status: string
  message: string
}

export interface DocumentImportOption {
  id: string
  label: string
  detail?: string
  statusLabel?: string
  disabled?: boolean
  future?: boolean
  onSelect?: () => void
}
interface DocumentsPanelProps {
  allDocuments: DocumentInfo[]
  documentsLoading: boolean
  showDocuments: boolean
  documentFilter: string
  groupedDocs: AuthorGroup[]
  docFilterLower: string
  importOptions?: DocumentImportOption[]
  importStatuses?: DocumentsPanelStatus[]
  selectedFilters: Set<string>
  collapsedAuthors: Set<string>
  onToggleShow: () => void
  onFilterChange: (value: string) => void
  onToggleFilter: (title: string) => void
  onClearFilters: () => void
  onToggleAuthor: (author: string) => void
  onDeleteDocument?: (doc: DocumentInfo) => void | Promise<void>
  onToggleAllInGroup: (docs: DocumentInfo[]) => void
  onViewDocument: (url: string) => void
}

export function DocumentsPanel({
  allDocuments,
  documentsLoading,
  showDocuments,
  documentFilter,
  groupedDocs,
  docFilterLower,
  importOptions = [],
  importStatuses = [],
  selectedFilters,
  collapsedAuthors,
  onToggleShow,
  onFilterChange,
  onToggleFilter,
  onClearFilters,
  onToggleAuthor,
  onDeleteDocument,
  onToggleAllInGroup,
  onViewDocument,
}: DocumentsPanelProps) {
  const [importMenuOpen, setImportMenuOpen] = useState(false)
  const activeImport = importOptions.find((option) => option.statusLabel)
  const hasImportOptions = importOptions.length > 0

  if (documentsLoading) {
    return (
      <div className="documents-panel documents-panel-loading">
        <div className="documents-loading">
          <span className="spinner" aria-hidden="true" />
          <span>Loading Documents&#8230;</span>
        </div>
      </div>
    )
  }

  if (allDocuments.length === 0) return null

  return (
    <div className="documents-panel">
      <button className="documents-toggle" onClick={onToggleShow}>
        <span>Documents ({allDocuments.length})</span>
        <span className={`toggle-arrow ${showDocuments ? 'open' : ''}`}>&#9662;</span>
      </button>

      {showDocuments && (
        <div className="documents-list">
          <div className="documents-list-header">
            <input
              type="text"
              className="document-filter-input"
              placeholder="Filter Documents..."
              value={documentFilter}
              onChange={(e) => onFilterChange(e.target.value)}
            />
            {hasImportOptions && (
              <div className="document-import-menu">
                <button
                  className="document-import-btn"
                  aria-expanded={importMenuOpen}
                  onClick={() => setImportMenuOpen((value) => !value)}
                  type="button"
                >
                  {activeImport?.statusLabel ?? 'Import'}
                  <span className={`toggle-arrow ${importMenuOpen ? 'open' : ''}`}>&#9662;</span>
                </button>
                {importMenuOpen && (
                  <div className="document-import-options">
                    {importOptions.map((option) => {
                      const disabled = option.disabled || option.future || !option.onSelect
                      return (
                        <button
                          key={option.id}
                          className="document-import-option"
                          disabled={disabled}
                          onClick={() => {
                            setImportMenuOpen(false)
                            option.onSelect?.()
                          }}
                          type="button"
                        >
                          <span>{option.label}{option.future ? ' (Future)' : ''}</span>
                          {option.detail && <small>{option.detail}</small>}
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>
            )}
            {selectedFilters.size > 0 && (
              <button className="clear-filters" onClick={onClearFilters}>
                Clear Filters
              </button>
            )}
          </div>

          {importStatuses.map((item, index) => item.message && item.status !== 'idle' ? (
            <div key={item.status + index} className={'document-import-status document-import-' + item.status}>
              {item.message}
            </div>
          ) : null)}

          <div className="documents-scroll">
            {groupedDocs.length === 0 && (
              <p className="no-results">No documents match the filter.</p>
            )}
            {groupedDocs.map(({ author, docs }) => {
              const collapsed = docFilterLower.length === 0 && collapsedAuthors.has(author)
              const allSelected = docs.every((d) => selectedFilters.has(d.title))
              return (
                <div key={author} className="author-group">
                  <div className="author-group-header">
                    <button
                      className="author-group-toggle"
                      onClick={() => onToggleAuthor(author)}
                    >
                      <span className={`toggle-arrow ${collapsed ? '' : 'open'}`}>&#9662;</span>
                      <span className="author-group-title">{author}</span>
                      <span className="author-group-count">({docs.length})</span>
                    </button>
                    <button
                      className="author-group-action"
                      onClick={(e) => { e.stopPropagation(); onToggleAllInGroup(docs) }}
                    >
                      {allSelected ? 'Deselect All' : 'Select All'}
                    </button>
                  </div>
                  {!collapsed && docs.map((doc) => (
                    <label key={doc.url} className="document-item">
                      <input
                        type="checkbox"
                        checked={selectedFilters.has(doc.title)}
                        onChange={() => onToggleFilter(doc.title)}
                      />
                      <span className="document-item-title">{doc.title}</span>
                      <button
                        className="document-view-btn"
                        onClick={(e) => { e.preventDefault(); onViewDocument(doc.url) }}
                      >
                        View
                      </button>
                      {doc.source === 'upload' && onDeleteDocument && (
                        <button
                          className="document-delete-btn"
                          disabled={importStatuses.some((item) => item.status === 'deleting')}
                          onClick={(e) => {
                            e.preventDefault()
                            void onDeleteDocument(doc)
                          }}
                        >
                          Delete
                        </button>
                      )}
                    </label>
                  ))}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {selectedFilters.size > 0 && (
        <div className="active-filters">
          {Array.from(selectedFilters).map((title) => (
            <span key={title} className="filter-tag">
              {title}
              <button className="filter-tag-remove" onClick={() => onToggleFilter(title)}>
                &times;
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
