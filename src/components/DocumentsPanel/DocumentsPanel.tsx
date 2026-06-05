import { useState } from 'react'
import type { DocumentInfo } from '../../types/search'
import type { AuthorGroup } from '../../hooks/useDocumentFilters'
import { Panel } from '../Panel/Panel'
import { DocumentList } from '../DocumentList/DocumentList'

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
  audioSavedOnly?: boolean
  collapsedAuthors: Set<string>
  docFilterLower: string
  documentFilter: string
  documentsLoading: boolean
  groupedDocs: AuthorGroup[]
  importOptions?: DocumentImportOption[]
  importStatuses?: DocumentsPanelStatus[]
  showDocuments: boolean
  onAudioSavedOnlyChange?: (enabled: boolean) => void
  onDeleteDocument?: (doc: DocumentInfo) => void | Promise<void>
  onFilterChange: (value: string) => void
  onToggleAuthor: (author: string) => void
  onToggleShow: () => void
  onViewDocument: (url: string) => void
}

export function DocumentsPanel({
  allDocuments,
  audioSavedOnly = false,
  collapsedAuthors,
  docFilterLower,
  documentFilter,
  documentsLoading,
  groupedDocs,
  importOptions = [],
  importStatuses = [],
  showDocuments,
  onAudioSavedOnlyChange,
  onDeleteDocument,
  onFilterChange,
  onToggleAuthor,
  onToggleShow,
  onViewDocument,
}: DocumentsPanelProps) {
  const [importMenuOpen, setImportMenuOpen] = useState(false)
  const activeImport = importOptions.find((option) => option.statusLabel)
  const hasImportOptions = importOptions.length > 0
  const deleteDisabled = importStatuses.some((item) => item.status === 'deleting')

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

  return (
    <Panel
      className="documents-panel"
      ariaLabel="Documents"
      title={`Documents (${allDocuments.length})`}
      open={showDocuments}
      onToggle={onToggleShow}
    >
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
        {onAudioSavedOnlyChange && (
          <label className="audio-filter-toggle">
            <input
              type="checkbox"
              checked={audioSavedOnly}
              onChange={(e) => onAudioSavedOnlyChange(e.target.checked)}
            />
            <span>Saved Audio</span>
          </label>
        )}
      </div>

      {importStatuses.map((item, index) => item.message && item.status !== 'idle' ? (
        <div key={item.status + index} className={'document-import-status document-import-' + item.status}>
          {item.message}
        </div>
      ) : null)}

      <DocumentList
        groupedDocs={groupedDocs}
        collapsedAuthors={collapsedAuthors}
        docFilterLower={docFilterLower}
        emptyMessage={getEmptyMessage(allDocuments.length, audioSavedOnly, documentFilter)}
        onToggleAuthor={onToggleAuthor}
        onViewDocument={onViewDocument}
        onDeleteDocument={onDeleteDocument}
        deleteDisabled={deleteDisabled}
      />
    </Panel>
  )
}


function getEmptyMessage(documentCount: number, audioSavedOnly: boolean, documentFilter: string): string {
  if (documentCount === 0) return 'No documents available yet.'
  if (audioSavedOnly) return 'No saved audio matches.'
  if (documentFilter.trim()) return 'No documents match the filter.'
  return 'No documents available yet.'
}
