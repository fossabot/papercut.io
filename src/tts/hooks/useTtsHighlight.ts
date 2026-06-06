import { useEffect, useRef } from 'react'
import {
  buildReadableDomTextMap,
  normalizeForTextAlignment,
  type NormalizedTextPoint,
} from '../alignment/domTextMap'

const TTS_HIGHLIGHT_NAME = 'tts-current'
const SCROLL_SETTLE_MS = 120

interface ChunkAlignment {
  normalizedIndex: number
  normalizedEndIndex: number
}

interface AlignmentCache {
  doc: Document
  chunkTexts: string[]
  map: NormalizedTextPoint[]
  alignments: Map<number, ChunkAlignment>
  highlight: Highlight
}

interface UseTtsHighlightOptions {
  enabled: boolean
  currentChunkIndex: number | null
  chunkTexts: string[]
}

// Highlights the current saved-audiobook chunk inside the document iframe.
export function useTtsHighlight(
  iframeRef: React.RefObject<HTMLIFrameElement | null>,
  { enabled, currentChunkIndex, chunkTexts }: UseTtsHighlightOptions,
): void {
  const alignmentCacheRef = useRef<AlignmentCache | null>(null)

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
            chunkTexts,
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
  }, [chunkTexts, currentChunkIndex, enabled, iframeRef])
}

function highlightTtsChunk(
  iframe: HTMLIFrameElement | null,
  chunkIndex: number,
  chunkTexts: string[],
  alignmentCacheRef: React.MutableRefObject<AlignmentCache | null>,
): { iframe: HTMLIFrameElement; range: Range } | null {
  const doc = iframe?.contentDocument
  if (!doc || !iframe) return null

  ensureTtsHighlightStyles(doc)

  let cache = alignmentCacheRef.current
  if (!isUsableAlignmentCache(cache, doc, chunkTexts, chunkIndex)) {
    clearTtsHighlight(doc, cache)
    cache = buildAlignmentCache(doc, chunkTexts)
    alignmentCacheRef.current = cache
  }

  cache.highlight.clear()
  const alignment = cache.alignments.get(chunkIndex)
  if (!alignment) return null

  const range = createTextMapRange(doc, cache.map, alignment.normalizedIndex, alignment.normalizedEndIndex)
  if (!range) return null

  cache.highlight.add(range)
  doc.defaultView!.CSS.highlights.set(TTS_HIGHLIGHT_NAME, cache.highlight)
  return { iframe, range }
}

function buildAlignmentCache(doc: Document, chunkTexts: string[]): AlignmentCache {
  const { text, map } = buildReadableDomTextMap(doc)
  const alignments = new Map<number, ChunkAlignment>()
  let searchStart = 0

  chunkTexts.forEach((chunkText, index) => {
    const target = normalizeForTextAlignment(chunkText)
    if (!target) return

    let normalizedIndex = text.indexOf(target, searchStart)
    if (normalizedIndex === -1 && searchStart > 0) normalizedIndex = text.indexOf(target)
    if (normalizedIndex === -1) return

    const normalizedEndIndex = normalizedIndex + target.length - 1
    alignments.set(index, { normalizedIndex, normalizedEndIndex })
    searchStart = normalizedEndIndex + 1
  })

  return {
    doc,
    chunkTexts,
    map,
    alignments,
    highlight: new doc.defaultView!.Highlight(),
  }
}

function isUsableAlignmentCache(
  cache: AlignmentCache | null,
  doc: Document,
  chunkTexts: string[],
  chunkIndex: number,
): cache is AlignmentCache {
  if (!cache || cache.doc !== doc || cache.chunkTexts !== chunkTexts) return false
  const alignment = cache.alignments.get(chunkIndex)
  if (!alignment) return true
  const start = cache.map[alignment.normalizedIndex]
  const end = cache.map[alignment.normalizedEndIndex]
  return Boolean(start?.node.isConnected && end?.node.isConnected)
}

function clearTtsHighlight(doc: Document, cache: AlignmentCache | null): void {
  const registeredHighlight = doc.defaultView!.CSS.highlights.get(TTS_HIGHLIGHT_NAME)
  registeredHighlight?.clear()
  cache?.highlight.clear()
  doc.defaultView!.CSS.highlights.delete(TTS_HIGHLIGHT_NAME)
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

function createTextMapRange(
  doc: Document,
  map: NormalizedTextPoint[],
  startIndex: number,
  endIndex: number,
): Range | null {
  const start = map[startIndex]
  const end = map[endIndex]
  if (!start?.node.isConnected || !end?.node.isConnected) return null

  const range = doc.createRange()
  range.setStart(start.node, Math.min(start.offset, start.node.length))
  range.setEnd(end.node, Math.min(end.offset + 1, end.node.length))
  return range
}

function scrollRangeIntoView(iframe: HTMLIFrameElement, range: Range): void {
  const rangeRect = range.getBoundingClientRect()
  const iframeRect = iframe.getBoundingClientRect()
  if (!Number.isFinite(rangeRect.top) || !Number.isFinite(iframeRect.top)) return

  const top = window.scrollY + iframeRect.top + rangeRect.top - window.innerHeight / 2
  window.scrollTo({ top: Math.max(top, 0), behavior: 'smooth' })
}
