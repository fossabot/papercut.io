import { useEffect, useRef } from 'react'
import {
  buildReadableDomTextLocatorIndex,
  buildReadableDomSegmentIndex,
  createRangeForSourceSpan,
  createSourceSpanFromTextMatch,
  locatorTextsMatch,
  sourceSpanEndGlobalOffset,
  type ReadableDomSegmentIndex,
  type ReadableDomTextLocatorIndex,
} from '../alignment/domTextSegments'
import { logTtsDiagnostic } from '../diagnostics/TtsDiagnostics'
import type { TtsChunk, TtsChunkSourceSpan } from '../types'

const TTS_HIGHLIGHT_NAME = 'tts-current'
const SCROLL_SETTLE_MS = 120
const MAX_CACHED_RANGES = 128

interface SegmentIndexCache {
  root: HTMLElement
  version: number
  index: ReadableDomSegmentIndex
}

interface AlignmentCache {
  root: HTMLElement
  doc: Document
  version: number
  chunks: TtsChunk[]
  allowDomFallback: boolean
  segmentIndex: ReadableDomSegmentIndex
  textLocatorIndex: ReadableDomTextLocatorIndex | null
  fallbackSourceSpans: Map<number, TtsChunkSourceSpan> | null
  ranges: Map<number, Range>
  failedRanges: Set<number>
  highlight: Highlight
}

interface UseTtsHighlightOptions {
  enabled: boolean
  currentChunkIndex: number | null
  chunks: TtsChunk[]
  allowDomFallback?: boolean
}

// Highlights the current saved-audiobook chunk inside the rendered reader DOM.
export function useTtsHighlight(
  rootRef: React.RefObject<HTMLElement | null>,
  { enabled, currentChunkIndex, chunks, allowDomFallback = false }: UseTtsHighlightOptions,
): void {
  const segmentIndexCacheRef = useRef<SegmentIndexCache | null>(null)
  const alignmentCacheRef = useRef<AlignmentCache | null>(null)
  const rootVersionRef = useRef(0)
  const observedRootRef = useRef<HTMLElement | null>(null)
  const mutationObserverRef = useRef<MutationObserver | null>(null)

  // Find highlights and reader content swaps replace Text nodes under the same
  // article root. Versioning invalidates cached DOM node indexes without
  // rescanning the whole book on every mutation.
  useEffect(() => {
    const root = rootRef.current
    if (observedRootRef.current === root) return

    mutationObserverRef.current?.disconnect()
    mutationObserverRef.current = null
    observedRootRef.current = root
    rootVersionRef.current += 1
    invalidateTtsDomCaches(root?.ownerDocument, segmentIndexCacheRef, alignmentCacheRef)

    if (!root) return

    const observer = new MutationObserver(() => {
      rootVersionRef.current += 1
      invalidateTtsDomCaches(root.ownerDocument, segmentIndexCacheRef, alignmentCacheRef)
    })
    observer.observe(root, { childList: true, subtree: true, characterData: true })
    mutationObserverRef.current = observer
  })

  // Pre-index only when highlight playback is active. Huge uploaded books should
  // not pay a full DOM text walk merely because the reader opened.
  useEffect(() => {
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
      const root = rootRef.current
      if (!root?.isConnected) return
      getOrBuildSegmentIndex(root, rootVersionRef.current, segmentIndexCacheRef)
    }

    const scheduleBuild = () => {
      cancelScheduledBuild()
      const root = rootRef.current
      if (
        segmentIndexCacheRef.current?.root !== root
        || segmentIndexCacheRef.current?.version !== rootVersionRef.current
      ) {
        segmentIndexCacheRef.current = null
      }
      if (window.requestIdleCallback) {
        idleHandle = window.requestIdleCallback(buildIndex, { timeout: 1000 })
      } else {
        timeoutHandle = window.setTimeout(buildIndex, 0)
      }
    }

    if (enabled && currentChunkIndex !== null) scheduleBuild()
    return () => {
      cancelScheduledBuild()
      segmentIndexCacheRef.current = null
    }
  }, [currentChunkIndex, enabled, rootRef])

  // CSS Highlight ranges retain DOM nodes; clear registry/cache on unmount.
  useEffect(
    () => () => {
      mutationObserverRef.current?.disconnect()
      mutationObserverRef.current = null
      observedRootRef.current = null
      const cache = alignmentCacheRef.current
      if (cache) clearTtsHighlight(cache.doc, cache)
      alignmentCacheRef.current = null
    },
    [],
  )

  // Update only active range. RAF coalesces rapid chunk changes; delayed scroll
  // prevents many smooth-scroll animations from competing during button spam.
  useEffect(() => {
    const root = rootRef.current
    const doc = root?.ownerDocument

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
            rootRef.current,
            currentChunkIndex,
            chunks,
            allowDomFallback,
            rootVersionRef.current,
            segmentIndexCacheRef,
            alignmentCacheRef,
          )
          if (!result) return

          scrollTimer = window.setTimeout(() => {
            scrollTimer = null
            scrollRangeIntoView(result.range)
          }, SCROLL_SETTLE_MS)
        } catch (err) {
          console.warn('Unable to highlight current TTS chunk:', err)
        }
      })
    }

    attemptHighlight()

    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame)
      if (scrollTimer !== null) window.clearTimeout(scrollTimer)
    }
  }, [allowDomFallback, chunks, currentChunkIndex, enabled, rootRef])
}

// Reuse document/chunk cache when valid, then replace single named Highlight range.
function highlightTtsChunk(
  root: HTMLElement | null,
  chunkIndex: number,
  chunks: TtsChunk[],
  allowDomFallback: boolean,
  rootVersion: number,
  segmentIndexCacheRef: React.MutableRefObject<SegmentIndexCache | null>,
  alignmentCacheRef: React.MutableRefObject<AlignmentCache | null>,
): { range: Range } | null {
  const doc = root?.ownerDocument
  const view = doc?.defaultView
  if (!root || !doc || !view) return null

  ensureTtsHighlightStyles(doc)

  let cache = alignmentCacheRef.current
  if (!isUsableAlignmentCache(cache, root, chunks, allowDomFallback, chunkIndex, rootVersion)) {
    clearTtsHighlight(doc, cache)
    cache = buildAlignmentCache(root, doc, view, chunks, allowDomFallback, rootVersion, segmentIndexCacheRef)
    alignmentCacheRef.current = cache
  }

  cache.highlight.clear()
  const range = getChunkRange(cache, chunkIndex)
  if (!range) return null

  cache.highlight.add(range)
  view.CSS.highlights.set(TTS_HIGHLIGHT_NAME, cache.highlight)
  return { range }
}

// Alignment cache is tied to both live reader root and exact chunk-array identity.
function buildAlignmentCache(
  root: HTMLElement,
  doc: Document,
  view: Window & typeof globalThis,
  chunks: TtsChunk[],
  allowDomFallback: boolean,
  rootVersion: number,
  segmentIndexCacheRef: React.MutableRefObject<SegmentIndexCache | null>,
): AlignmentCache {
  return {
    root,
    doc,
    version: rootVersion,
    chunks,
    allowDomFallback,
    segmentIndex: getOrBuildSegmentIndex(root, rootVersion, segmentIndexCacheRef),
    textLocatorIndex: null,
    fallbackSourceSpans: null,
    ranges: new Map(),
    failedRanges: new Set(),
    highlight: new view.Highlight(),
  }
}

// Synchronous fallback handles Play before idle pre-index completes.
function getOrBuildSegmentIndex(
  root: HTMLElement,
  rootVersion: number,
  cacheRef: React.MutableRefObject<SegmentIndexCache | null>,
): ReadableDomSegmentIndex {
  const cached = cacheRef.current
  if (cached?.root === root && cached.version === rootVersion) return cached.index

  const started = performance.now()
  const index = buildReadableDomSegmentIndex(root)
  cacheRef.current = { root, version: rootVersion, index }
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

  const chunk = cache.chunks[chunkIndex]
  const sourceSpan = chunk?.sourceSpan

  const started = performance.now()
  let range = sourceSpan
    ? createRangeForSourceSpan(cache.doc, cache.segmentIndex, sourceSpan)
    : null
  let strategy: 'source-span' | 'dom-fallback' = 'source-span'
  if (range && !rangeTextMatchesChunk(range, chunk)) {
    logHighlightRangeBuilt(cache, chunkIndex, range, performance.now() - started, 'source-span')
    range = null
  }

  if (!range && cache.allowDomFallback) {
    range = createFallbackRange(cache, chunkIndex)
    if (range) strategy = 'dom-fallback'
  }

  if (!range) {
    cache.failedRanges.add(chunkIndex)
    logTtsDiagnostic('[tts-highlight] chunk range unavailable', {
      chunkIndex,
      reason: sourceSpan ? 'source span does not match reader DOM' : 'missing source span',
      domFallback: cache.allowDomFallback,
    }, 'warn')
    return null
  }

  logHighlightRangeBuilt(cache, chunkIndex, range, performance.now() - started, strategy)
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

// Last-resort compatibility path for imported audiobook bundles. Old bundles
// preserve canonical chunk/audio metadata but not durable DOM locators, so a
// restored legacy HTML document may no longer produce trustworthy source spans.
// This recovers a span from the currently rendered reader text, then validates
// the resulting Range before allowing it to drive visible highlighting.
function createFallbackRange(cache: AlignmentCache, chunkIndex: number): Range | null {
  const chunk = cache.chunks[chunkIndex]
  if (!chunk?.text) return null

  const sourceSpan = getOrBuildFallbackSourceSpan(cache, chunkIndex)
  if (!sourceSpan) {
    logTtsDiagnostic('[tts-highlight] DOM fallback unavailable', {
      chunkIndex,
      chunkId: chunk.id,
      reason: 'chunk text not found in reader DOM',
      textLength: chunk.text.length,
    }, 'warn')
    return null
  }

  const range = createRangeForSourceSpan(cache.doc, cache.segmentIndex, sourceSpan)
  if (!range || !rangeTextMatchesChunk(range, chunk)) {
    logTtsDiagnostic('[tts-highlight] DOM fallback mismatch', {
      chunkIndex,
      chunkId: chunk.id,
      sourceSpan: `${sourceSpan.startSegmentIndex}:${sourceSpan.startOffset}-${sourceSpan.endSegmentIndex}:${sourceSpan.endOffset}`,
      chunkPreview: previewDiagnosticText(normalizeDiagnosticText(chunk.text)),
      rangePreview: previewDiagnosticText(normalizeDiagnosticText(range?.toString() ?? '')),
    }, 'warn')
    return null
  }

  logTtsDiagnostic('[tts-highlight] DOM fallback range built', {
    chunkIndex,
    chunkId: chunk.id,
    sourceSpan: `${sourceSpan.startSegmentIndex}:${sourceSpan.startOffset}-${sourceSpan.endSegmentIndex}:${sourceSpan.endOffset}`,
  })
  return range
}

// Return the recovered sourceSpan for any chunk, regardless of playback order.
// This matters for the chunk browser: a user can jump directly to chunk 40, so
// fallback highlighting cannot depend on chunks 1-39 having already played.
function getOrBuildFallbackSourceSpan(cache: AlignmentCache, chunkIndex: number): TtsChunkSourceSpan | undefined {
  if (!cache.fallbackSourceSpans) {
    cache.fallbackSourceSpans = buildFallbackSourceSpans(cache)
  }
  return cache.fallbackSourceSpans.get(chunkIndex)
}

// Build fallback spans in canonical audiobook order using a forward cursor. This
// avoids the classic repeated-text trap where every later chunk containing "the"
// or a common Arabic phrase would otherwise match an earlier occurrence. The
// work is cached per stable reader DOM and only runs when the normal sourceSpan
// path fails for imported bundles.
function buildFallbackSourceSpans(cache: AlignmentCache): Map<number, TtsChunkSourceSpan> {
  const started = performance.now()
  const locator = getOrBuildTextLocatorIndex(cache)
  const sourceSpans = new Map<number, TtsChunkSourceSpan>()
  let cursor = 0

  for (let index = 0; index < cache.chunks.length; index++) {
    const chunk = cache.chunks[index]
    if (!chunk?.text) continue
    const sourceSpan = createSourceSpanFromTextMatch(locator, chunk.text, cursor)
    if (!sourceSpan) continue
    sourceSpans.set(index, sourceSpan)
    const nextCursor = sourceSpanEndGlobalOffset(locator, sourceSpan)
    if (nextCursor >= 0) cursor = nextCursor
  }

  logTtsDiagnostic('[tts-highlight] DOM fallback source spans built', {
    chunks: cache.chunks.length,
    matched: sourceSpans.size,
    elapsedMs: Math.round(performance.now() - started),
  })
  return sourceSpans
}

// Build the normalized text map lazily because very large books should not pay
// this cost merely by opening or starting playback when ordinary spans are valid.
function getOrBuildTextLocatorIndex(cache: AlignmentCache): ReadableDomTextLocatorIndex {
  if (cache.textLocatorIndex) return cache.textLocatorIndex

  const started = performance.now()
  const locator = buildReadableDomTextLocatorIndex(cache.segmentIndex)
  cache.textLocatorIndex = locator
  logTtsDiagnostic('[tts-highlight] DOM text locator index built', {
    characters: locator.text.length,
    // matchCharacters is shorter when compatibility matching drops Arabic
    // visual marks; a big gap here explains why exact imported lookup failed.
    matchCharacters: locator.matchText.length,
    segments: locator.segmentTexts.length,
    elapsedMs: Math.round(performance.now() - started),
  })
  return locator
}

// Diagnostics compare the chunk text to the actual DOM Range text. If they
// match but the visible highlight looks wrong, the issue is likely platform
// rendering/scrolling. If they differ, source-span mapping is the culprit.
function logHighlightRangeBuilt(
  cache: AlignmentCache,
  chunkIndex: number,
  range: Range,
  elapsedMs: number,
  strategy: 'source-span' | 'dom-fallback',
): void {
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
    strategy,
    domFallback: cache.allowDomFallback,
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

function rangeTextMatchesChunk(range: Range, chunk: TtsChunk | undefined): boolean {
  return locatorTextsMatch(range.toString(), chunk?.text ?? '')
}

function previewDiagnosticText(text: string): string {
  return text.length <= 160 ? text : text.slice(0, 157).trimEnd() + '...'
}

// Detached range endpoints indicate reader navigation/mutation; rebuild cache then.
function isUsableAlignmentCache(
  cache: AlignmentCache | null,
  root: HTMLElement,
  chunks: TtsChunk[],
  allowDomFallback: boolean,
  chunkIndex: number,
  rootVersion: number,
): cache is AlignmentCache {
  if (
    !cache ||
    cache.root !== root ||
    cache.version !== rootVersion ||
    cache.chunks !== chunks ||
    cache.allowDomFallback !== allowDomFallback
  ) return false
  const range = cache.ranges.get(chunkIndex)
  return !range || Boolean(range.startContainer.isConnected && range.endContainer.isConnected)
}

function invalidateTtsDomCaches(
  doc: Document | undefined,
  segmentIndexCacheRef: React.MutableRefObject<SegmentIndexCache | null>,
  alignmentCacheRef: React.MutableRefObject<AlignmentCache | null>,
): void {
  segmentIndexCacheRef.current = null
  const cache = alignmentCacheRef.current
  if (cache) clearTtsHighlight(doc ?? cache.doc, cache)
  alignmentCacheRef.current = null
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
      background-color: var(--highlight-tts, #c7f9cc);
      color: inherit;
    }
  `
  doc.head.appendChild(style)
}

// Ranges now live in the app document, so their rects are already window-local.
function scrollRangeIntoView(range: Range): void {
  const rangeRect = range.getBoundingClientRect()
  if (!Number.isFinite(rangeRect.top)) return

  const top = window.scrollY + rangeRect.top - window.innerHeight / 2
  window.scrollTo({ top: Math.max(top, 0), behavior: 'smooth' })
}
