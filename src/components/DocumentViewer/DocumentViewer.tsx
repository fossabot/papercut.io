import { useState, useRef, useEffect } from 'react'
import { resolveViewer } from '../../viewers/registry'
import { FindBar } from '../FindBar/FindBar'
import { ScrollTopButton } from '../ScrollTopButton/ScrollTopButton'
import { useFindInPage } from '../../hooks/useFindInPage'

interface DocumentViewerProps {
  url: string
  content: string
  onClose: () => void
}

export function DocumentViewer({ url, content, onClose }: DocumentViewerProps) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const [showScrollTop, setShowScrollTop] = useState(false)

  const {
    showFind,
    findQuery,
    findMatchCount,
    findCurrentIndex,
    findInputRef,
    handleFind,
    findNext,
    findPrev,
    closeFind,
    setShowFind,
  } = useFindInPage(iframeRef, true)

  // Auto-resize iframe to match content height so the main window scrolls
  useEffect(() => {
    const iframe = iframeRef.current
    if (!iframe) return
    function resizeIframe() {
      try {
        const doc = iframe!.contentDocument
        if (doc?.body) iframe!.style.height = doc.body.scrollHeight + 'px'
      } catch {
        // Cross-origin access may fail in production Tauri builds
      }
    }
    iframe.addEventListener('load', resizeIframe)
    return () => iframe.removeEventListener('load', resizeIframe)
  }, [])

  useEffect(() => {
    function handleScroll() { setShowScrollTop(window.scrollY > 300) }
    window.addEventListener('scroll', handleScroll)
    return () => window.removeEventListener('scroll', handleScroll)
  }, [])

  const plugin = resolveViewer(url)
  const ViewerComponent = plugin.Component

  return (
    <div className="app">
      <header className="header doc-header">
        <div className="header-left">
          <button className="back-button" onClick={onClose}>&larr; Back</button>
        </div>
        <div className="header-center">
          <h1 className="app-title">Papercut</h1>
        </div>
        <div className="header-right">
          <button
            className="find-btn"
            onClick={() => {
              setShowFind(true)
              setTimeout(() => findInputRef.current?.focus(), 0)
            }}
          >
            &#128269; Find
          </button>
        </div>
      </header>

      {showFind && (
        <FindBar
          query={findQuery}
          matchCount={findMatchCount}
          currentIndex={findCurrentIndex}
          inputRef={findInputRef}
          onChange={handleFind}
          onNext={findNext}
          onPrev={findPrev}
          onClose={closeFind}
        />
      )}

      <main className="document-view">
        <ViewerComponent url={url} content={content} iframeRef={iframeRef} />
      </main>

      <ScrollTopButton
        visible={showScrollTop}
        onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
      />
    </div>
  )
}
