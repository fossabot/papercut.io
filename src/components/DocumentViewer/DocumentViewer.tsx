import { useState, useRef, useEffect, type ReactNode } from 'react'
import { resolveViewer } from '../../viewers/registry'
import { FindBar } from '../FindBar/FindBar'
import { ScrollTopButton } from '../ScrollTopButton/ScrollTopButton'
import { useFindInPage } from '../../hooks/useFindInPage'
import { useTtsHighlight } from '../../tts/useTtsHighlight'

interface TtsHighlightOptions {
  enabled: boolean
  currentText: string
  currentChunkIndex: number | null
}

interface DocumentViewerProps {
  url: string
  content: string
  className?: string
  headerControls?: ReactNode
  beforeDocument?: ReactNode
  ttsHighlight?: TtsHighlightOptions
  onClose: () => void
}

export function DocumentViewer({
  url,
  content,
  className = '',
  headerControls,
  beforeDocument,
  ttsHighlight,
  onClose,
}: DocumentViewerProps) {
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
  } = useFindInPage(iframeRef)

  useTtsHighlight(iframeRef, ttsHighlight ?? {
    enabled: false,
    currentText: '',
    currentChunkIndex: null,
  })

  useEffect(() => {
    const iframe = iframeRef.current
    if (!iframe) return

    function resizeIframe() {
      try {
        const doc = iframe!.contentDocument
        if (doc?.body) iframe!.style.height = doc.body.scrollHeight + 'px'
      } catch {
        // Cross-origin access may fail in production Tauri builds.
      }
    }

    iframe.addEventListener('load', resizeIframe)
    const frame = window.requestAnimationFrame(resizeIframe)
    return () => {
      iframe.removeEventListener('load', resizeIframe)
      window.cancelAnimationFrame(frame)
    }
  }, [content, url])

  useEffect(() => {
    function handleScroll() {
      setShowScrollTop(window.scrollY > 300)
    }

    handleScroll()
    window.addEventListener('scroll', handleScroll)
    return () => window.removeEventListener('scroll', handleScroll)
  }, [url])

  const plugin = resolveViewer(url)
  const ViewerComponent = plugin.Component
  const appClassName = ['app', className].filter(Boolean).join(' ')

  return (
    <div className={appClassName}>
      <header className="header doc-header">
        <div className="header-left">
          <button className="back-button" onClick={onClose}>&larr; Back</button>
        </div>
        <div className="header-center">
          <h1 className="app-title">Papercut</h1>
        </div>
        <div className="header-right">
          {headerControls}
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

      {beforeDocument}

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
