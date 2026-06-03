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

function App() {
  const { pagefindRef, pagefindReady, allDocuments, documentsLoading } = usePagefind()
  const { query, results, loading, submittedQuery, lastSearchInfo, handleSearch, submitSearch } =
    useSearch(pagefindRef)
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
        disabled={!pagefindReady}
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
        selectedFilters={selectedFilters}
        collapsedAuthors={collapsedAuthors}
        onToggleShow={() => setShowDocuments((v) => !v)}
        onFilterChange={setDocumentFilter}
        onToggleFilter={toggleFilter}
        onClearFilters={clearFilters}
        onToggleAuthor={toggleAuthor}
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
