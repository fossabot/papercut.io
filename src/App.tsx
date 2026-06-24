import {
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef
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
  importEpubDocument,
  importHtmlDocument,
  isUploadedDocumentUrl,
  listUploadedDocuments,
  type UploadedDocument,
} from './uploads/DocumentUploads'

type DocumentLoadState =
  | { status: 'idle' }
  | { status: 'loading'; url: string; message: string }
  | { status: 'error'; url: string; message: string }

function App() {
  const [selectedDoc, setSelectedDoc] = useState<string | null>(null)
  const [docContent, setDocContent] = useState('')
  const [documentLoad, setDocumentLoad] = useState<DocumentLoadState>({ status: 'idle' })
  const openDocumentRequestRef = useRef(0)
  const documentOpeningRef = useRef(false)
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
    openDocumentRequestRef.current += 1
    documentOpeningRef.current = false
    setSelectedDoc(null)
    setDocContent('')
    setDocumentLoad({ status: 'idle' })
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
    ...allDocuments.map((doc) => ({ ...doc, format: 'html', source: 'bundled' as const })),
    ...uploadedDocuments.map((upload) => ({ title: upload.title, url: upload.url, format: upload.format, source: 'upload' as const })),
    ...userUploads.map((upload) => ({ title: upload.title, url: upload.url, format: 'html', source: 'audiobook-upload' as const })),
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
  const documentOpening = documentLoad.status === 'loading'

  const handleViewDocument = useCallback(async (url: string) => {
    if (documentOpeningRef.current) return
    documentOpeningRef.current = true
    const requestId = openDocumentRequestRef.current + 1
    openDocumentRequestRef.current = requestId
    prepareDocumentOpen()
    setSelectedDoc(url)
    setDocContent('')
    setDocumentLoad({ status: 'loading', url, message: 'Opening document...' })
    window.scrollTo({ top: 0 })

    try {
      const html = await loadHtmlDocument(url)
      if (openDocumentRequestRef.current !== requestId) return
      documentOpeningRef.current = false
      setDocContent(html)
      setDocumentLoad({ status: 'idle' })
    } catch (err) {
      if (openDocumentRequestRef.current !== requestId) return
      const message = err instanceof Error ? err.message : String(err)
      documentOpeningRef.current = false
      setDocContent('')
      setDocumentLoad({ status: 'error', url, message })
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

  const selectedDocument = useMemo(
    () => (selectedDoc ? libraryDocuments.find((doc) => doc.url === selectedDoc) : undefined),
    [selectedDoc, libraryDocuments],
  )
  const selectedTitle = selectedDocument?.title
  const selectedFormat = selectedDocument?.format

  const runDocumentImport = useCallback(async (
    importingMessage: string,
    importer: () => Promise<UploadedDocument>,
  ) => {
    setDocumentImport({ status: 'importing', message: importingMessage })
    try {
      const result = await importer()
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

  const handleImportHtmlDocument = useCallback(
    () => runDocumentImport('Importing HTML document', importHtmlDocument),
    [runDocumentImport],
  )

  const handleImportEpubDocument = useCallback(
    () => runDocumentImport('Importing EPUB book', importEpubDocument),
    [runDocumentImport],
  )

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
        format={selectedFormat}
        content={docContent}
        className={hasFloatingAudioControls ? 'app-audio-floating' : ''}
        headerControls={<AudioControls {...audioControlsProps} />}
        beforeDocument={<TtsDiagnosticsPanel />}
        ttsHighlight={ttsHighlight}
        loading={documentLoad.status === 'loading' && documentLoad.url === selectedDoc}
        loadError={documentLoad.status === 'error' && documentLoad.url === selectedDoc ? documentLoad.message : undefined}
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
            openingDisabled={documentOpening}
            openingDocumentUrl={documentLoad.status === 'loading' ? documentLoad.url : undefined}
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
                statusLabel: documentImport.status === 'importing' && documentImport.message.includes('HTML') ? 'Importing HTML' : undefined,
                disabled: documentImport.status === 'importing',
                onSelect: handleImportHtmlDocument,
              },
              {
                id: 'epub',
                label: 'EPUB',
                detail: 'Import a local .epub book',
                statusLabel: documentImport.status === 'importing' && documentImport.message.includes('EPUB') ? 'Importing EPUB' : undefined,
                disabled: documentImport.status === 'importing',
                onSelect: handleImportEpubDocument,
              },
              // { id: 'pdf', label: 'PDF', detail: 'Import PDFs when text extraction support lands', future: true },
            ]}
            importStatuses={[documentImport]}
            documentOpening={documentOpening}
            openingDocumentUrl={documentLoad.status === 'loading' ? documentLoad.url : undefined}
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
            documentOpening={documentOpening}
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
