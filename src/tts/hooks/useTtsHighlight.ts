import { useEffect, useRef } from 'react'
import {
  buildReadableDomSegmentIndex,
  createRangeForSourceSpan,
  type ReadableDomSegmentIndex,
} from '../alignment/domTextSegments'
import { logTtsDiagnostic } from '../diagnostics/TtsDiagnostics'
import type { TtsChunk } from '../types'

const TTS_HIGHLIGHT_NAME = 'tts-current'
const SCROLL_SETTLE_MS = 120
const MAX_CACHED_RANGES = 128

interface SegmentIndexCache {
  doc: Document
  index: ReadableDomSegmentIndex
}

interface AlignmentCache {
  doc: Document
  chunks: TtsChunk[]
  segmentIndex: ReadableDomSegmentIndex
  ranges: Map<number, Range>
  failedRanges: Set<number>
  highlight: Highlight
}

interface UseTtsHighlightOptions {
  enabled: boolean
  currentChunkIndex: number | null
  chunks: TtsChunk[]
}

// Highlights the current saved-audiobook chunk inside the document iframe.
export function useTtsHighlight(
  iframeRef: React.RefObject<HTMLIFrameElement | null>,
  { enabled, currentChunkIndex, chunks }: UseTtsHighlightOptions,
): void {
  const segmentIndexCacheRef = useRef<SegmentIndexCache | null>(null)
  const alignmentCacheRef = useRef<AlignmentCache | null>(null)

  // Pre-index iframe during idle time so Play usually pays only active-range cost.
  // Load listener also invalidates indexes when srcDoc creates a new Document.
  useEffect(() => {
    const iframe = iframeRef.current
    if (!iframe) return

    let idleHandle: number | null = null
    let timeoutHandle: number | null = null

    const cancelScheduledBuild = () => {
      if (idleHandle !== null) {
        window.cancelIdleCallback(idleHandle)
        idleHandle = null
      }
      if (timeoutHandle !== null) {
        window.clearTimeout(timeoutHandle)
        timeoutHandle = null
      }
    }

    const buildIndex = () => {
      idleHandle = null
      timeoutHandle = null
      const doc = iframe.contentDocument
      if (!doc?.body || doc.readyState === 'loading') return
      getOrBuildSegmentIndex(doc, segmentIndexCacheRef)
    }

    const scheduleBuild = () => {
      cancelScheduledBuild()
      const doc = iframe.contentDocument
      if (segmentIndexCacheRef.current?.doc !== doc) segmentIndexCacheRef.current = null
      if (window.requestIdleCallback) {
        idleHandle = window.requestIdleCallback(buildIndex, { timeout: 1000 })
      } else {
        timeoutHandle = window.setTimeout(buildIndex, 0)
      }
    }

    iframe.addEventListener('load', scheduleBuild)
    scheduleBuild()
    return () => {
      cancelScheduledBuild()
      iframe.removeEventListener('load', scheduleBuild)
      segmentIndexCacheRef.current = null
    }
  }, [iframeRef])

  // CSS Highlight ranges retain DOM nodes; clear registry/cache on unmount.
  useEffect(
    () => () => {
      const cache = alignmentCacheRef.current
      if (cache) clearTtsHighlight(cache.doc, cache)
      alignmentCacheRef.current = null
    },
    [],
  )

  // Update only active range. RAF coalesces rapid chunk changes; delayed scroll
  // prevents many smooth-scroll animations from competing during button spam.
  useEffect(() => {
    const iframe = iframeRef.current
    const doc = iframe?.contentDocument

    if (!enabled || currentChunkIndex === null) {
      if (doc) clearTtsHighlight(doc, alignmentCacheRef.current)
      alignmentCacheRef.current = null
      return
    }

    let frame: number | null = null
    let scrollTimer: number | null = null
    const attemptHighlight = () => {
      if (frame !== null) window.cancelAnimationFrame(frame)
      if (scrollTimer !== null) window.clearTimeout(scrollTimer)

      frame = window.requestAnimationFrame(() => {
        frame = null
        try {
          const result = highlightTtsChunk(
            iframeRef.current,
            currentChunkIndex,
            chunks,
            segmentIndexCacheRef,
            alignmentCacheRef,
          )
          if (!result) return

          scrollTimer = window.setTimeout(() => {
            scrollTimer = null
            scrollRangeIntoView(result.iframe, result.range)
          }, SCROLL_SETTLE_MS)
        } catch (err) {
          console.warn('Unable to highlight current TTS chunk:', err)
        }
      })
    }

    const shouldRetryOnLoad = iframe && (!doc || doc.readyState === 'loading')
    if (shouldRetryOnLoad) iframe.addEventListener('load', attemptHighlight)
    attemptHighlight()

    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame)
      if (scrollTimer !== null) window.clearTimeout(scrollTimer)
      if (shouldRetryOnLoad) iframe.removeEventListener('load', attemptHighlight)
    }
  }, [chunks, currentChunkIndex, enabled, iframeRef])
}

// Reuse document/chunk cache when valid, then replace single named Highlight range.
function highlightTtsChunk(
  iframe: HTMLIFrameElement | null,
  chunkIndex: number,
  chunks: TtsChunk[],
  segmentIndexCacheRef: React.MutableRefObject<SegmentIndexCache | null>,
  alignmentCacheRef: React.MutableRefObject<AlignmentCache | null>,
): { iframe: HTMLIFrameElement; range: Range } | null {
  const doc = iframe?.contentDocument
  const view = doc?.defaultView
  if (!doc || !view || !iframe) return null

  ensureTtsHighlightStyles(doc)

  let cache = alignmentCacheRef.current
  if (!isUsableAlignmentCache(cache, doc, chunks, chunkIndex)) {
    clearTtsHighlight(doc, cache)
    cache = buildAlignmentCache(doc, view, chunks, segmentIndexCacheRef)
    alignmentCacheRef.current = cache
  }

  cache.highlight.clear()
  const range = getChunkRange(cache, chunkIndex)
  if (!range) return null

  cache.highlight.add(range)
  view.CSS.highlights.set(TTS_HIGHLIGHT_NAME, cache.highlight)
  return { iframe, range }
}

// Alignment cache is tied to both live iframe Document and exact chunk-array identity.
function buildAlignmentCache(
  doc: Document,
  view: Window & typeof globalThis,
  chunks: TtsChunk[],
  segmentIndexCacheRef: React.MutableRefObject<SegmentIndexCache | null>,
): AlignmentCache {
  return {
    doc,
    chunks,
    segmentIndex: getOrBuildSegmentIndex(doc, segmentIndexCacheRef),
    ranges: new Map(),
    failedRanges: new Set(),
    highlight: new view.Highlight(),
  }
}

// Synchronous fallback handles Play before idle pre-index completes.
function getOrBuildSegmentIndex(
  doc: Document,
  cacheRef: React.MutableRefObject<SegmentIndexCache | null>,
): ReadableDomSegmentIndex {
  const cached = cacheRef.current
  if (cached?.doc === doc) return cached.index

  const started = performance.now()
  const index = buildReadableDomSegmentIndex(doc)
  cacheRef.current = { doc, index }
  logTtsDiagnostic('[tts-highlight] DOM segment index built', {
    segments: index.segments.length,
    elapsedMs: Math.round(performance.now() - started),
  })
  return index
}

// Resolve/cache one chunk range. Map insertion order acts as small LRU; failed
// mappings are memoized to avoid repeated scans and duplicate diagnostics.
function getChunkRange(cache: AlignmentCache, chunkIndex: number): Range | null {
  const cached = cache.ranges.get(chunkIndex)
  if (cached) {
    cache.ranges.delete(chunkIndex)
    cache.ranges.set(chunkIndex, cached)
    return cached
  }
  if (cache.failedRanges.has(chunkIndex)) return null

  const sourceSpan = cache.chunks[chunkIndex]?.sourceSpan
  if (!sourceSpan) {
    cache.failedRanges.add(chunkIndex)
    logTtsDiagnostic('[tts-highlight] chunk range unavailable', {
      chunkIndex,
      reason: 'missing source span',
    }, 'warn')
    return null
  }

  const started = performance.now()
  const range = createRangeForSourceSpan(cache.doc, cache.segmentIndex, sourceSpan)
  if (!range) {
    cache.failedRanges.add(chunkIndex)
    logTtsDiagnostic('[tts-highlight] chunk range unavailable', {
      chunkIndex,
      reason: 'source span does not match iframe DOM',
    }, 'warn')
    return null
  }

  logHighlightRangeBuilt(cache, chunkIndex, range, performance.now() - started)
  cache.ranges.set(chunkIndex, range)
  if (cache.ranges.size > MAX_CACHED_RANGES) {
    const oldestIndex = cache.ranges.keys().next().value
    if (oldestIndex !== undefined) cache.ranges.delete(oldestIndex)
  }
  const elapsedMs = performance.now() - started
  if (elapsedMs >= 16) {
    logTtsDiagnostic('[tts-highlight] slow chunk range built', {
      chunkIndex,
      elapsedMs: Math.round(elapsedMs),
    })
  }
  return range
}

// Diagnostics compare the chunk text to the actual DOM Range text. If they
// match but the visible highlight looks wrong, the issue is likely platform
// rendering/scrolling. If they differ, source-span mapping is the culprit.
function logHighlightRangeBuilt(cache: AlignmentCache, chunkIndex: number, range: Range, elapsedMs: number): void {
  const chunk = cache.chunks[chunkIndex]
  const sourceSpan = chunk?.sourceSpan
  const chunkText = normalizeDiagnosticText(chunk?.text ?? '')
  const rangeText = normalizeDiagnosticText(range.toString())
  const rect = range.getBoundingClientRect()
  const matches = chunkText === rangeText

  logTtsDiagnostic(matches ? '[tts-highlight] chunk range built' : '[tts-highlight] chunk range mismatch', {
    chunkIndex,
    chunkId: chunk?.id ?? '',
    matches,
    chunkPreview: previewDiagnosticText(chunkText),
    rangePreview: previewDiagnosticText(rangeText),
    chunkLength: chunkText.length,
    rangeLength: rangeText.length,
    sourceSpan: sourceSpan
      ? `${sourceSpan.startSegmentIndex}:${sourceSpan.startOffset}-${sourceSpan.endSegmentIndex}:${sourceSpan.endOffset}`
      : '',
    segments: cache.segmentIndex.segments.length,
    elapsedMs: Math.round(elapsedMs),
    rectTop: Math.round(rect.top),
    rectHeight: Math.round(rect.height),
    documentLang: cache.doc.documentElement.lang || '',
    documentDir: cache.doc.documentElement.dir || cache.doc.body?.dir || '',
    cssHighlights: Boolean(cache.doc.defaultView?.CSS.highlights),
    userAgent: navigator.userAgent,
  }, matches ? 'info' : 'warn')
}

function normalizeDiagnosticText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function previewDiagnosticText(text: string): string {
  return text.length <= 160 ? text : text.slice(0, 157).trimEnd() + '...'
}

// Detached range endpoints indicate iframe navigation/mutation; rebuild cache then.
function isUsableAlignmentCache(
  cache: AlignmentCache | null,
  doc: Document,
  chunks: TtsChunk[],
  chunkIndex: number,
): cache is AlignmentCache {
  if (!cache || cache.doc !== doc || cache.chunks !== chunks) return false
  const range = cache.ranges.get(chunkIndex)
  return !range || Boolean(range.startContainer.isConnected && range.endContainer.isConnected)
}

// Clear both owned Highlight object and global registry entry, including old docs.
function clearTtsHighlight(doc: Document, cache: AlignmentCache | null): void {
  cache?.highlight.clear()
  clearTtsHighlightRegistry(cache?.doc)
  if (cache?.doc !== doc) clearTtsHighlightRegistry(doc)
}

function clearTtsHighlightRegistry(doc: Document | undefined): void {
  const registry = doc?.defaultView?.CSS.highlights
  if (!registry) return

  registry.get(TTS_HIGHLIGHT_NAME)?.clear()
  registry.delete(TTS_HIGHLIGHT_NAME)
}

function ensureTtsHighlightStyles(doc: Document): void {
  if (doc.getElementById('tts-current-styles')) return
  const style = doc.createElement('style')
  style.id = 'tts-current-styles'
  style.textContent = `
    ::highlight(${TTS_HIGHLIGHT_NAME}) {
      background-color: #c7f9cc;
      color: inherit;
    }
  `
  doc.head.appendChild(style)
}

// Translate iframe-local range coordinates into parent-window scroll coordinates.
function scrollRangeIntoView(iframe: HTMLIFrameElement, range: Range): void {
  const rangeRect = range.getBoundingClientRect()
  const iframeRect = iframe.getBoundingClientRect()
  if (!Number.isFinite(rangeRect.top) || !Number.isFinite(iframeRect.top)) return

  const top = window.scrollY + iframeRect.top + rangeRect.top - window.innerHeight / 2
  window.scrollTo({ top: Math.max(top, 0), behavior: 'smooth' })
}
