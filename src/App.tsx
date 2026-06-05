import {
  useState,
  useEffect,
  useCallback,
  useMemo
} from 'react'
import './App.css'
import papercutIcon from './assets/papercut-icon.png'
import { usePagefind } from './hooks/usePagefind'
import { useSearch } from './hooks/useSearch'
import { SearchBar } from './components/SearchBar/SearchBar'
import { SearchResults } from './components/SearchResults/SearchResults'
import { DocumentsPanel } from './components/DocumentsPanel/DocumentsPanel'
import { DocumentViewer } from './components/DocumentViewer/DocumentViewer'
import { TabNav, type AppTab } from './components/TabNav/TabNav'
import { SearchScope } from './components/SearchScope/SearchScope'
import { useDocumentFilters } from './hooks/useDocumentFilters'
import type { DocumentInfo } from './types/search'
import { clearPhraseFetchCache } from './utils/phraseSearch'
import { AudioControls } from './tts/components/AudioControls'
import { TtsDiagnosticsPanel } from './tts/components/TtsDiagnosticsPanel'
import { AudiobooksPanel } from './tts/components/AudiobooksPanel'
import { getImportedAudiobookSource } from './tts/api/nativeTts'
import { formatStorageSize } from './utils/formatUtils'
import { getUserUploads, isUserUploadUrl, type UserUploadDocument } from './tts/storage/UserUploads'
import { useAudiobookManager } from './tts/hooks/useAudiobookManager'
import {
  deleteUploadedDocument,
  getUploadedDocumentSource,
  importHtmlDocument,
  isUploadedDocumentUrl,
  listUploadedDocuments,
  type UploadedDocument,
} from './uploads/DocumentUploads'

function App() {
  const [selectedDoc, setSelectedDoc] = useState<string | null>(null)
  const [docContent, setDocContent] = useState('')
  const [activeTab, setActiveTab] = useState<AppTab>('search')
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

  const clearSelectedDocument = useCallback(() => {
    setSelectedDoc(null)
    setDocContent('')
  }, [])

  const handleUserUploadsChanged = useCallback(() => {
    setUserUploads(getUserUploads())
  }, [])

  const audiobook = useAudiobookManager({
    allDocuments,
    docContent,
    loadHtmlDocument,
    selectedDoc,
    uploadedDocuments,
    userUploads,
    onClearDocument: clearSelectedDocument,
    onUserUploadsChanged: handleUserUploadsChanged,
  })
  const {
    audioControlsProps,
    audioSetupProps,
    audiobookImport,
    audioSavedOnly,
    closeDocumentAudio,
    audiobooksPanelProps,
    filterResults,
    hasFloatingAudioControls,
    importAudiobook: importAudiobookBundle,
    includeDocumentInList,
    openSavedAudiobook,
    prepareDocumentOpen,
    setAudioSavedOnly,
    ttsHighlight,
  } = audiobook

  const libraryDocuments = useMemo<DocumentInfo[]>(() => [
    ...allDocuments.map((doc) => ({ ...doc, source: 'bundled' as const })),
    ...uploadedDocuments.map((upload) => ({ title: upload.title, url: upload.url, source: 'upload' as const })),
    ...userUploads.map((upload) => ({ title: upload.title, url: upload.url, source: 'audiobook-upload' as const })),
  ], [allDocuments, uploadedDocuments, userUploads]) 

  const searchFilters = useDocumentFilters(libraryDocuments, { includeDocument: includeDocumentInList })
  const libraryFilters = useDocumentFilters(libraryDocuments, { includeDocument: includeDocumentInList })

  const {
    selectedFilters,
    documentFilter: searchDocumentFilter,
    collapsedAuthors: searchCollapsedAuthors,
    groupedDocs: searchGroupedDocs,
    docFilterLower: searchDocFilterLower,
    toggleFilter,
    clearFilters,
    removeFilter,
    toggleAuthor: toggleSearchAuthor,
    toggleAllInGroup,
    setDocumentFilter: setSearchDocumentFilter,
  } = searchFilters

  const {
    showDocuments,
    documentFilter: libraryDocumentFilter,
    collapsedAuthors: libraryCollapsedAuthors,
    groupedDocs: libraryGroupedDocs,
    docFilterLower: libraryDocFilterLower,
    toggleAuthor: toggleLibraryAuthor,
    setShowDocuments,
    setDocumentFilter: setLibraryDocumentFilter,
  } = libraryFilters 

  const audioFilteredResults = filterResults(results)

  const handleViewDocument = useCallback(async (url: string) => {
    try {
      const html = await loadHtmlDocument(url)
      prepareDocumentOpen()
      setDocContent(html)
      setSelectedDoc(url)
      window.scrollTo({ top: 0 })
    } catch (err) {
      console.error('Failed to load document:', err)
    }
  }, [loadHtmlDocument, prepareDocumentOpen]) // 

  const handleCloseDocument = useCallback(() => {
    closeDocumentAudio()
    clearSelectedDocument()
  }, [clearSelectedDocument, closeDocumentAudio])

  const handleTabChange = useCallback((tab: AppTab) => {
    setActiveTab(tab)
  }, [])

  const selectedTitle = useMemo(
    () => (selectedDoc ? libraryDocuments.find((doc) => doc.url === selectedDoc)?.title : undefined),
    [selectedDoc, libraryDocuments],
  )

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

  const handleImportAudiobook = useCallback(async () => {
    await importAudiobookBundle(handleViewDocument)
  }, [handleViewDocument, importAudiobookBundle])

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
        title={selectedTitle}
        content={docContent}
        className={hasFloatingAudioControls ? 'app-audio-floating' : ''}
        headerControls={<AudioControls {...audioControlsProps} />}
        beforeDocument={<TtsDiagnosticsPanel />}
        ttsHighlight={ttsHighlight}
        onClose={handleCloseDocument}
      />
    )
  }

  return (
    <div className="app">
      <header className="header">
        <h1 className="app-title">
          <img className="app-title-icon" src={papercutIcon} alt="" aria-hidden="true" />
          <span>Papercut</span>
        </h1>
        <p className="app-subtitle">Search, Read, & Listen Offline</p>
      </header>

      <TabNav
        active={activeTab}
        busyTabs={{ audiobooks: audiobooksPanelProps.isSaving }}
        onChange={handleTabChange}
      />

      {activeTab === 'search' && (
        <section className="tab-panel" role="tabpanel" aria-label="Search">
          <SearchBar
            query={query}
            disabled={!pagefindReady && uploadedDocuments.length === 0}
            onChange={handleSearch}
            onSubmit={submitSearch}
          />

          <SearchScope
            groupedDocs={searchGroupedDocs}
            collapsedAuthors={searchCollapsedAuthors}
            docFilterLower={searchDocFilterLower}
            documentFilter={searchDocumentFilter}
            selectedFilters={selectedFilters}
            onFilterChange={setSearchDocumentFilter}
            onToggleFilter={toggleFilter}
            onToggleAllInGroup={toggleAllInGroup}
            onToggleAuthor={toggleSearchAuthor}
            onClearFilters={clearFilters}
          />

          <SearchResults
            results={audioFilteredResults}
            loading={loading}
            submittedQuery={submittedQuery}
            lastSearchInfo={lastSearchInfo}
            selectedFilters={selectedFilters}
            onViewResult={(result) => handleViewDocument(result.url)}
          />
        </section>
      )}

      {activeTab === 'library' && (
        <section className="tab-panel" role="tabpanel" aria-label="Library">
          <DocumentsPanel
            documentsLoading={documentsLoading}
            showDocuments={showDocuments}
            allDocuments={libraryDocuments}
            audioSavedOnly={audioSavedOnly}
            documentFilter={libraryDocumentFilter}
            groupedDocs={libraryGroupedDocs}
            docFilterLower={libraryDocFilterLower}
            importOptions={[
              {
                id: 'html',
                label: 'HTML',
                detail: 'Import a local .html or .htm document',
                statusLabel: documentImport.status === 'importing' ? 'Importing HTML' : undefined,
                disabled: documentImport.status === 'importing',
                onSelect: handleImportHtmlDocument,
              },
              // { id: 'epub', label: 'EPUB', detail: 'Import EPUB books when parser support lands', future: true },
              // { id: 'pdf', label: 'PDF', detail: 'Import PDFs when text extraction support lands', future: true },
            ]}
            importStatuses={[documentImport]}
            collapsedAuthors={libraryCollapsedAuthors}
            onToggleShow={() => setShowDocuments((v) => !v)}
            onFilterChange={setLibraryDocumentFilter}
            onAudioSavedOnlyChange={setAudioSavedOnly}
            onDeleteDocument={handleDeleteUploadedDocument}
            onToggleAuthor={toggleLibraryAuthor}
            onViewDocument={handleViewDocument}
          />
        </section>
      )}

      {activeTab === 'audiobooks' && (
        <section className="tab-panel" role="tabpanel" aria-label="Audiobooks">
          <AudiobooksPanel
            {...audiobooksPanelProps}
            audioSetup={audioSetupProps}
            importState={audiobookImport}
            onImportAudiobook={handleImportAudiobook}
            onOpenSaved={(record) => {
              void openSavedAudiobook(record, handleViewDocument)
            }}
          />

          <TtsDiagnosticsPanel />
        </section>
      )}
    </div>
  )
}

export default App
