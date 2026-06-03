import { useState, useCallback } from 'react'
import './App.css'
import type { SearchResult } from './types/search'
import { usePagefind } from './hooks/usePagefind'
import { useSearch } from './hooks/useSearch'
import { useDocumentFilters } from './hooks/useDocumentFilters'
import { SearchBar } from './components/SearchBar/SearchBar'
import { SearchResults } from './components/SearchResults/SearchResults'
import { DocumentsPanel } from './components/DocumentsPanel/DocumentsPanel'
import { DocumentViewer } from './components/DocumentViewer/DocumentViewer'
import {
  deleteUploadedDocument,
  getUploadedDocumentSource,
  importHtmlDocument,
  isUploadedDocumentUrl,
  listUploadedDocuments,
  type UploadedDocument,
} from './uploads/DocumentUploads'

function App() {
  const [userUploads, setUserUploads] = useState<UserUploadDocument[]>(() => getUserUploads())
  const [uploadedDocuments, setUploadedDocuments] = useState<UploadedDocument[]>([])
  const [documentImport, setDocumentImport] = useState<{ status: 'idle' | 'importing' | 'imported' | 'deleting' | 'deleted' | 'cancelled' | 'error'; message: string }>({ status: 'idle', message: '' })
  const { pagefindRef, pagefindReady, allDocuments, documentsLoading } = usePagefind()

  const loadHtmlDocument = useCallback(async (url: string): Promise<string> => {
    if (isUploadedDocumentUrl(url)) return getUploadedDocumentSource(url)
    if (isUserUploadUrl(url)) return getImportedAudiobookSource(url)

    const response = await fetch(url)
    if (!response.ok) throw new Error('Failed to load document')
    return response.text()
  }, [])
  const {
    query,
    results,
    loading,
    submittedQuery,
    lastSearchInfo,
    handleSearch,
    submitSearch,
    removeResultsForUrl,
  } = useSearch(pagefindRef, { loadDocumentSource: loadHtmlDocument })
  useEffect(() => {
    async function loadUploadedDocuments() {
      try {
        setUploadedDocuments(await listUploadedDocuments())
      } catch (err) {
        console.warn('Unable to load uploaded documents:', err)
      }
    }
    void loadUploadedDocuments()
  }, [])
  const {
    selectedFilters,
    showDocuments,
    documentFilter,
    collapsedAuthors,
    groupedDocs,
    docFilterLower,
    toggleFilter,
    clearFilters,
    toggleAuthor,
    toggleAllInGroup,
    setShowDocuments,
    setDocumentFilter,
  } = useDocumentFilters(allDocuments)

  const [selectedDoc, setSelectedDoc] = useState<string | null>(null)
  const [docContent, setDocContent] = useState('')

  const handleViewDocument = useCallback(async (url: string) => {
    try {
      const html = await fetch(url).then((r) => r.text())
      setDocContent(html)
      setSelectedDoc(url)
      window.scrollTo({ top: 0 })
    } catch (err) {
      console.error('Failed to load document:', err)
    }
  }, [])

  const handleViewResult = useCallback((result: SearchResult) => {
    handleViewDocument(result.url)
  }, [handleViewDocument])

  if (selectedDoc) {
    return (
      <DocumentViewer
        url={selectedDoc}
        content={docContent}
        onClose={() => { setSelectedDoc(null); setDocContent('') }}
      />
    )
  }

  return (
    <div className="app">
      <header className="header">
        <h1 className="app-title">Papercut</h1>
        <p className="app-subtitle">Full-Text Document Search</p>
      </header>

      <SearchBar
        query={query}
        disabled={!pagefindReady && uploadedDocuments.length === 0}
        onChange={handleSearch}
        onSubmit={submitSearch}
      />

      <DocumentsPanel
        allDocuments={allDocuments}
        documentsLoading={documentsLoading}
        showDocuments={showDocuments}
        documentFilter={documentFilter}
        groupedDocs={groupedDocs}
        docFilterLower={docFilterLower}
        importOptions={[
          {
            id: 'html',
            label: 'HTML',
            detail: 'Import a local .html or .htm document',
            statusLabel: documentImport.status === 'importing' ? 'Importing HTML' : undefined,
            disabled: documentImport.status === 'importing',
            onSelect: handleImportHtmlDocument,
          },
          {
            id: 'audiobook',
            label: 'Audiobook',
            detail: 'Import a .papercut-audiobook bundle',
            statusLabel: audiobookImport.status === 'importing' ? 'Importing Audiobook' : undefined,
            disabled: audiobookImport.status === 'importing',
            onSelect: handleImportAudiobook,
          } // ,
          // { id: 'epub', label: 'EPUB', detail: 'Import EPUB books when parser support lands', future: true },
          // { id: 'pdf', label: 'PDF', detail: 'Import PDFs when text extraction support lands', future: true },
        ]}
        importStatuses={[documentImport]}
        selectedFilters={selectedFilters}
        collapsedAuthors={collapsedAuthors}
        onToggleShow={() => setShowDocuments((v) => !v)}
        onFilterChange={setDocumentFilter}
        onToggleFilter={toggleFilter}
        onClearFilters={clearFilters}
        onToggleAllInGroup={toggleAllInGroup}
        onViewDocument={handleViewDocument}
      />

      <SearchResults
        results={results}
        loading={loading}
        submittedQuery={submittedQuery}
        lastSearchInfo={lastSearchInfo}
        selectedFilters={selectedFilters}
        onViewResult={handleViewResult}
      />
    </div>
  )
}

export default App
