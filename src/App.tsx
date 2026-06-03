import {
  useState,
  useEffect,
  useCallback,
} from 'react'
import './App.css'
import type { SearchResult } from './types/search'
import { usePagefind } from './hooks/usePagefind'
import { useSearch } from './hooks/useSearch'
import { useDocumentFilters } from './hooks/useDocumentFilters'
import { SearchBar } from './components/SearchBar/SearchBar'
import { SearchResults } from './components/SearchResults/SearchResults'
import { DocumentsPanel } from './components/DocumentsPanel/DocumentsPanel'
import { DocumentViewer } from './components/DocumentViewer/DocumentViewer'
import type { DocumentInfo } from './types/search'
import { clearPhraseFetchCache } from './utils/phraseSearch'
import {
  deleteUploadedDocument,
  getUploadedDocumentSource,
  importHtmlDocument,
  isUploadedDocumentUrl,
  listUploadedDocuments,
  type UploadedDocument,
} from './uploads/DocumentUploads'

function App() {
  // const [userUploads, setUserUploads] = useState<UserUploadDocument[]>(() => getUserUploads())
  const [uploadedDocuments, setUploadedDocuments] = useState<UploadedDocument[]>([])
  const [documentImport, setDocumentImport] = useState<{ status: 'idle' | 'importing' | 'imported' | 'deleting' | 'deleted' | 'cancelled' | 'error'; message: string }>({ status: 'idle', message: '' })
  const { pagefindRef, pagefindReady, allDocuments, documentsLoading } = usePagefind()

  const loadHtmlDocument = useCallback(async (url: string): Promise<string> => {
    if (isUploadedDocumentUrl(url)) return getUploadedDocumentSource(url)
    // if (isUserUploadUrl(url)) return getImportedAudiobookSource(url)

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
  const handleCloseDocument = useCallback(() => {
    closeDocumentAudio()
    clearSelectedDocument()
  }, [clearSelectedDocument, closeDocumentAudio])

  const handleImportHtmlDocument = useCallback(async () => {
    setDocumentImport({ status: 'importing', message: 'Importing HTML document' })
    try {
      const result = await importHtmlDocument()
      setUploadedDocuments(await listUploadedDocuments())
      setShowDocuments(true)
      setDocumentImport({ status: 'imported', message: 'Imported ' + result.title })
      await handleViewDocument(result.url)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const cancelled = message.toLowerCase().includes('cancelled')
      setDocumentImport({
        status: cancelled ? 'cancelled' : 'error',
        message: cancelled ? 'Import cancelled.' : message,
      })
    }
  }, [handleViewDocument, setShowDocuments])

  const handleDeleteUploadedDocument = useCallback(async (doc: DocumentInfo) => {
    if (doc.source !== 'upload') return
    const confirmed = window.confirm('Delete this uploaded document from this device? This also removes it from local search results.')
    if (!confirmed) return

    setDocumentImport({ status: 'deleting', message: 'Deleting ' + doc.title })
    try {
      const result = await deleteUploadedDocument(doc.url)
      setUploadedDocuments(await listUploadedDocuments())
      removeResultsForUrl(doc.url)
      clearPhraseFetchCache(doc.url)
      removeFilter(doc.title)
      if (selectedDoc === doc.url) {
        handleCloseDocument()
      }

      const storage = formatStorageSize(result.bytesFreed)
      setDocumentImport({
        status: 'deleted',
        message: storage ? 'Deleted ' + doc.title + ' and freed ' + storage + '.' : 'Deleted ' + doc.title + '.',
      })
    } catch (err) {
      setDocumentImport({
        status: 'error',
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }, [handleCloseDocument, removeFilter, removeResultsForUrl, selectedDoc])

  if (selectedDoc) {
    return (
      <DocumentViewer
        url={selectedDoc}
        content={docContent}
        onClose={handleCloseDocument}
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
          } // ,
          // {
          //   id: 'audiobook',
          //   label: 'Audiobook',
          //   detail: 'Import a .papercut-audiobook bundle',
          //   statusLabel: audiobookImport.status === 'importing' ? 'Importing Audiobook' : undefined,
          //   disabled: audiobookImport.status === 'importing',
          //   onSelect: handleImportAudiobook,
          // },
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
        onDeleteDocument={handleDeleteUploadedDocument}
        onToggleAllInGroup={toggleAllInGroup}
        onViewDocument={handleViewDocument}
      />

      <SearchResults
        results={results}
        loading={loading}
        submittedQuery={submittedQuery}
        lastSearchInfo={lastSearchInfo}
        selectedFilters={selectedFilters}
        onViewResult={(result) => handleViewDocument(result.url)}
      />
    </div>
  )
}

export default App
