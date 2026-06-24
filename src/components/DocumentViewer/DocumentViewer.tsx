import { useState, useRef, useEffect, useCallback, type ReactNode } from 'react'
import { resolveViewer } from '../../viewers/registry'
import { FindBar } from '../FindBar/FindBar'
import { ScrollTopButton } from '../ScrollTopButton/ScrollTopButton'
import { useFindInPage } from '../../hooks/useFindInPage'
import { useTtsHighlight } from '../../tts/hooks/useTtsHighlight'
import type { TtsChunk } from '../../tts/types'

interface TtsHighlightOptions {
  enabled: boolean
  currentChunkIndex: number | null
  chunks: TtsChunk[]
}

interface DocumentViewerProps {
  url: string
  title?: string
  format?: string
  content: string
  className?: string
  headerControls?: ReactNode
  beforeDocument?: ReactNode
  ttsHighlight?: TtsHighlightOptions
  onClose: () => void
}

export function DocumentViewer({
  url,
  title,
  format,
  content,
  className = '',
  headerControls,
  beforeDocument,
  ttsHighlight,
  onClose,
}: DocumentViewerProps) {
  const readerRef = useRef<HTMLElement | null>(null)
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
  } = useFindInPage(readerRef)

  useTtsHighlight(readerRef, ttsHighlight ?? {
    enabled: false,
    currentChunkIndex: null,
    chunks: [],
  })

  // Uploaded HTML/EPUB is already sanitized by the backend and rendered in the
  // app DOM. Handle internal anchors here so ToC/footnote clicks do not mutate
  // the app URL and can account for the fixed document header offset.
  const scrollToHash = useCallback((hash: string) => {
    const root = readerRef.current
    if (!root || !hash.startsWith('#')) return

    const id = decodeHash(hash.slice(1))
    const doc = root.ownerDocument
    const idTarget = doc.getElementById(id)
    const namedTarget = Array.from(doc.getElementsByName(id)).find((node) => root.contains(node))
    const target = idTarget && root.contains(idTarget) ? idTarget : namedTarget
    if (!target) return

    const targetTop = window.scrollY + target.getBoundingClientRect().top
    window.scrollTo({ top: Math.max(targetTop - 120, 0), behavior: 'smooth' })
  }, [])

  // Direct rendering makes same-document links ordinary DOM events again. The
  // delegated handler covers generated EPUB ToCs, footnotes, and bundled HTML.
  useEffect(() => {
    const root = readerRef.current
    if (!root) return
    const readerRoot = root

    function handleReaderClick(event: MouseEvent) {
      const target = event.target
      if (!(target instanceof Element)) return
      const link = target.closest('a[href^="#"]')
      if (!link || !readerRoot.contains(link)) return

      event.preventDefault()
      scrollToHash(link.getAttribute('href') ?? '')
    }

    readerRoot.addEventListener('click', handleReaderClick)
    return () => readerRoot.removeEventListener('click', handleReaderClick)
  }, [content, scrollToHash, url])

  useEffect(() => {
    function handleScroll() {
      setShowScrollTop(window.scrollY > 300)
    }

    handleScroll()
    window.addEventListener('scroll', handleScroll)
    return () => window.removeEventListener('scroll', handleScroll)
  }, [url])

  const plugin = resolveViewer(url, format)
  const ViewerComponent = plugin.Component
  const appClassName = ['app', className].filter(Boolean).join(' ')

  return (
    <div className={appClassName}>
      <header className="header doc-header">
        <div className="header-left">
          <button className="back-button" onClick={onClose}>&larr; Back</button>
        </div>
        <div className="header-center">
          <h1 className="app-title doc-title" title={title}>{title ?? 'Papercut'}</h1>
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
        <ViewerComponent
          url={url}
          format={format}
          content={content}
          contentRef={readerRef}
        />
      </main>

      <ScrollTopButton
        visible={showScrollTop}
        onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
      />
    </div>
  )
}

function decodeHash(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}
