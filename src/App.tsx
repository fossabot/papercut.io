import { useState, useEffect, useCallback, useRef } from 'react'
import './App.css'

interface SearchResult {
  id: string
  url: string
  meta: { title: string }
  excerpt: string
}

interface PagefindInstance {
  search: (query: string) => Promise<{ results: { id: string; data: () => Promise<SearchResult> }[] }>
  destroy?: () => void
}

interface DocumentInfo {
  title: string
  url: string
}

function App() {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [selectedDoc, setSelectedDoc] = useState<string | null>(null)
  const [docContent, setDocContent] = useState('')
  const [loading, setLoading] = useState(false)
  const [pagefindReady, setPagefindReady] = useState(false)
  const [allDocuments, setAllDocuments] = useState<DocumentInfo[]>([])
  const [selectedFilters, setSelectedFilters] = useState<Set<string>>(new Set())
  const [showDocuments, setShowDocuments] = useState(false)
  const [documentFilter, setDocumentFilter] = useState('')
  const [showFind, setShowFind] = useState(false)
  const [findQuery, setFindQuery] = useState('')
  const [findMatchCount, setFindMatchCount] = useState(0)
  const [findCurrentIndex, setFindCurrentIndex] = useState(0)
  const [showScrollTop, setShowScrollTop] = useState(false)
  const pagefindRef = useRef<PagefindInstance | null>(null)
  const findInputRef = useRef<HTMLInputElement | null>(null)
  const iframeRef = useRef<HTMLIFrameElement | null>(null)

  const clearFindHighlights = useCallback(() => {
    const iframeDoc = iframeRef.current?.contentDocument
    if (!iframeDoc) return
    const marks = iframeDoc.querySelectorAll('mark[data-find]')
    marks.forEach((mark) => {
      const parent = mark.parentNode
      if (parent) {
        parent.replaceChild(iframeDoc.createTextNode(mark.textContent ?? ''), mark)
        parent.normalize()
      }
    })
  }, [])

  const highlightFindMatches = useCallback((searchQuery: string): number => {
    clearFindHighlights()
    const iframeDoc = iframeRef.current?.contentDocument
    if (!iframeDoc || !searchQuery.trim()) return 0

    // Inject highlight styles if not already present
    if (!iframeDoc.getElementById('find-styles')) {
      const style = iframeDoc.createElement('style')
      style.id = 'find-styles'
      style.textContent = `
        mark[data-find] { background: #fef08a; color: inherit; padding: 0; border-radius: 2px; }
        mark[data-find].current { background: #f97316; color: #fff; }
      `
      iframeDoc.head.appendChild(style)
    }

    const body = iframeDoc.body
    if (!body) return 0
    const lowerQuery = searchQuery.toLowerCase()
    const textNodes: Node[] = []
    const treeWalker = iframeDoc.createTreeWalker(body, NodeFilter.SHOW_TEXT)
    let node: Node | null
    while ((node = treeWalker.nextNode())) {
      textNodes.push(node)
    }

    let count = 0
    for (const textNode of textNodes) {
      const text = textNode.textContent ?? ''
      const lowerText = text.toLowerCase()
      if (!lowerText.includes(lowerQuery)) continue

      const fragment = iframeDoc.createDocumentFragment()
      let lastIdx = 0
      let searchIdx = lowerText.indexOf(lowerQuery, lastIdx)
      while (searchIdx !== -1) {
        if (searchIdx > lastIdx) {
          fragment.appendChild(iframeDoc.createTextNode(text.slice(lastIdx, searchIdx)))
        }
        const mark = iframeDoc.createElement('mark')
        mark.setAttribute('data-find', String(count))
        mark.textContent = text.slice(searchIdx, searchIdx + searchQuery.length)
        fragment.appendChild(mark)
        count++
        lastIdx = searchIdx + searchQuery.length
        searchIdx = lowerText.indexOf(lowerQuery, lastIdx)
      }
      if (lastIdx < text.length) {
        fragment.appendChild(iframeDoc.createTextNode(text.slice(lastIdx)))
      }
      textNode.parentNode?.replaceChild(fragment, textNode)
    }
    return count
  }, [clearFindHighlights])

  const scrollToMatch = useCallback((index: number) => {
    const iframe = iframeRef.current
    const iframeDoc = iframe?.contentDocument
    if (!iframeDoc || !iframe) return
    const prev = iframeDoc.querySelector('mark[data-find].current')
    prev?.classList.remove('current')
    const target = iframeDoc.querySelector(`mark[data-find="${index}"]`)
    if (target) {
      target.classList.add('current')
      // Calculate position relative to the main window since iframe doesn't scroll
      const iframeRect = iframe.getBoundingClientRect()
      const targetRect = target.getBoundingClientRect()
      const absoluteTop = window.scrollY + iframeRect.top + targetRect.top
      window.scrollTo({ top: absoluteTop - window.innerHeight / 2, behavior: 'smooth' })
    }
  }, [])

  const handleFind = useCallback((searchQuery: string) => {
    setFindQuery(searchQuery)
    if (!searchQuery.trim()) {
      clearFindHighlights()
      setFindMatchCount(0)
      setFindCurrentIndex(0)
      return
    }
    const count = highlightFindMatches(searchQuery)
    setFindMatchCount(count)
    if (count > 0) {
      setFindCurrentIndex(0)
      scrollToMatch(0)
    } else {
      setFindCurrentIndex(0)
    }
  }, [clearFindHighlights, highlightFindMatches, scrollToMatch])

  const findNext = useCallback(() => {
    if (findMatchCount === 0) return
    const next = (findCurrentIndex + 1) % findMatchCount
    setFindCurrentIndex(next)
    scrollToMatch(next)
  }, [findMatchCount, findCurrentIndex, scrollToMatch])

  const findPrev = useCallback(() => {
    if (findMatchCount === 0) return
    const prev = (findCurrentIndex - 1 + findMatchCount) % findMatchCount
    setFindCurrentIndex(prev)
    scrollToMatch(prev)
  }, [findMatchCount, findCurrentIndex, scrollToMatch])

  const closeFind = useCallback(() => {
    setShowFind(false)
    setFindQuery('')
    setFindMatchCount(0)
    setFindCurrentIndex(0)
    clearFindHighlights()
  }, [clearFindHighlights])

  // Ctrl+F find-in-page for document view
  useEffect(() => {
    if (!selectedDoc) {
      closeFind()
      return
    }
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault()
        setShowFind(true)
        setTimeout(() => findInputRef.current?.focus(), 0)
      }
      if (e.key === 'Escape') {
        closeFind()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [selectedDoc, closeFind])

  // Auto-resize iframe to match its content height so the main window scrolls
  useEffect(() => {
    if (!selectedDoc) return
    const iframe = iframeRef.current
    if (!iframe) return
    function resizeIframe() {
      try {
        const doc = iframe!.contentDocument
        if (doc?.body) {
          iframe!.style.height = doc.body.scrollHeight + 'px'
        }
      } catch {
        // Cross-origin access may fail in production Tauri builds
      }
    }
    iframe.addEventListener('load', resizeIframe)
    return () => iframe.removeEventListener('load', resizeIframe)
  }, [selectedDoc])

  // Scroll-to-top visibility — listen on main window since iframe auto-resizes
  useEffect(() => {
    if (!selectedDoc) {
      setShowScrollTop(false)
      return
    }
    function handleScroll() {
      setShowScrollTop(window.scrollY > 300)
    }
    window.addEventListener('scroll', handleScroll)
    return () => window.removeEventListener('scroll', handleScroll)
  }, [selectedDoc])

  useEffect(() => {
    async function loadPagefind() {
      try {
        const pagefindPath = '/pagefind/pagefind.js'
        const pagefind = await import(/* @vite-ignore */ pagefindPath) as unknown as PagefindInstance
        pagefindRef.current = pagefind
        setPagefindReady(true)

        // Load all documents by searching with a broad term
        // Pagefind doesn't support empty search, so we fetch the index directly
        const allResults = await pagefind.search('')
        if (allResults.results.length === 0) {
          // Fallback: try a single common character to discover documents
          const fallback = await pagefind.search('a')
          const docs = await Promise.all(fallback.results.map((r) => r.data()))
          setAllDocuments(docs.map((d) => ({ title: d.meta.title, url: d.url })))
        } else {
          const docs = await Promise.all(allResults.results.map((r) => r.data()))
          setAllDocuments(docs.map((d) => ({ title: d.meta.title, url: d.url })))
        }
      } catch {
        console.error('Pagefind index not found. Run `npm run build` first to generate the index.')
      }
    }
    loadPagefind()
  }, [])

  const handleSearch = useCallback(async (searchQuery: string) => {
    setQuery(searchQuery)
    if (!pagefindRef.current || searchQuery.trim().length === 0) {
      setResults([])
      return
    }

    setLoading(true)
    try {
      const search = await pagefindRef.current.search(searchQuery)
      const data = await Promise.all(
        search.results.slice(0, 50).map((r) => r.data())
      )
      setResults(data)
    } catch (err) {
      console.error('Search Failed:', err)
      setResults([])
    } finally {
      setLoading(false)
    }
  }, [])

  const handleViewDocument = useCallback(async (url: string) => {
    try {
      const response = await fetch(url)
      const html = await response.text()
      setDocContent(html)
      setSelectedDoc(url)
      window.scrollTo({ top: 0 })
    } catch (err) {
      console.error('Failed to load document:', err)
    }
  }, [])

  const toggleFilter = useCallback((title: string) => {
    setSelectedFilters((prev) => {
      const next = new Set(prev)
      if (next.has(title)) {
        next.delete(title)
      } else {
        next.add(title)
      }
      return next
    })
  }, [])

  const clearFilters = useCallback(() => {
    setSelectedFilters(new Set())
  }, [])

  const filteredResults = selectedFilters.size > 0
    ? results.filter((r) => selectedFilters.has(r.meta.title))
    : results

  if (selectedDoc) {
    return (
      <div className="app">
        <header className="header">
          <button className="back-button" onClick={() => setSelectedDoc(null)}>
            &larr; Back to results
          </button>
          <h1 className="app-title">Papercut</h1>
        </header>

        {showFind && (
          <div className="find-bar">
            <input
              ref={findInputRef}
              type="text"
              className="find-input"
              placeholder="Find..."
              value={findQuery}
              onChange={(e) => handleFind(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  closeFind()
                } else if (e.key === 'Enter' && e.shiftKey) {
                  e.preventDefault()
                  findPrev()
                } else if (e.key === 'Enter') {
                  e.preventDefault()
                  findNext()
                }
              }}
            />
            {findQuery.trim().length > 0 && (
              <span className="find-count">
                {findMatchCount === 0
                  ? 'No matches'
                  : `${findCurrentIndex + 1} of ${findMatchCount}`}
              </span>
            )}
            <button className="find-nav-btn" onClick={findPrev} disabled={findMatchCount === 0} title="Previous (Shift+Enter)">&#9650;</button>
            <button className="find-nav-btn" onClick={findNext} disabled={findMatchCount === 0} title="Next (Enter)">&#9660;</button>
            <button className="find-close" onClick={closeFind}>&times;</button>
          </div>
        )}

        <main className="document-view">
          <iframe
            ref={iframeRef}
            className="document-iframe"
            srcDoc={docContent}
            sandbox="allow-same-origin"
            title="Document viewer"
          />
        </main>

        {showScrollTop && (
          <button
            className="scroll-top-btn"
            onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
          >
            &uarr; Top
          </button>
        )}
      </div>
    )
  } else {
    return (
      <div className="app">
        <header className="header">
          <h1 className="app-title">Papercut</h1>
          <p className="app-subtitle">Full-Text Document Search</p>
        </header>

        <div className="search-container">
          <input
            type="text"
            className="search-input"
            placeholder={pagefindReady ? 'Search Documents...' : 'Loading Search Index...'}
            value={query}
            onChange={(e) => handleSearch(e.target.value)}
            disabled={!pagefindReady}
            autoFocus
          />
          {loading && <div className="search-loading">Searching...</div>}
        </div>

        {allDocuments.length > 0 && (
          <div className="documents-panel">
            <button
              className="documents-toggle"
              onClick={() => setShowDocuments((v) => !v)}
            >
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
                    onChange={(e) => setDocumentFilter(e.target.value)}
                  />
                  {selectedFilters.size > 0 && (
                    <button className="clear-filters" onClick={clearFilters}>
                      Clear Filters
                    </button>
                  )}
                </div>
                <div className="documents-scroll">
                {allDocuments
                  .filter((doc) =>
                    documentFilter.trim().length === 0 ||
                    doc.title.toLowerCase().includes(documentFilter.toLowerCase())
                  )
                  .map((doc) => (
                  <label key={doc.url} className="document-item">
                    <input
                      type="checkbox"
                      checked={selectedFilters.has(doc.title)}
                      onChange={() => toggleFilter(doc.title)}
                    />
                    <span className="document-item-title">{doc.title}</span>
                    <button
                      className="document-view-btn"
                      onClick={(e) => {
                        e.preventDefault()
                        handleViewDocument(doc.url)
                      }}
                    >
                      View
                    </button>
                  </label>
                ))}
                </div>
              </div>
            )}

            {selectedFilters.size > 0 && (
              <div className="active-filters">
                {Array.from(selectedFilters).map((title) => (
                  <span key={title} className="filter-tag">
                    {title}
                    <button
                      className="filter-tag-remove"
                      onClick={() => toggleFilter(title)}
                    >
                      &times;
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="results-container">
          {query.trim().length > 0 && filteredResults.length === 0 && !loading && (
            <p className="no-results">
              No documents found for &ldquo;{query}&rdquo;
              {selectedFilters.size > 0 && ' with the selected filters'}
            </p>
          )}

          {filteredResults.map((result) => (
            <div
              key={result.id}
              className="result-card"
              onClick={() => handleViewDocument(result.url)}
            >
              <h2 className="result-title">{result.meta.title}</h2>
              <p
                className="result-excerpt"
                dangerouslySetInnerHTML={{ __html: result.excerpt }}
              />
            </div>
          ))}

          {query.trim().length === 0 && (
            <div className="welcome">
              <p>Start typing to search across all indexed documents.</p>
            </div>
          )}
        </div>
      </div>
    )
  }
}

export default App
