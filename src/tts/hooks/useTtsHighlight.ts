import { useEffect, useRef } from 'react'
import {
  buildReadableDomTextMap,
  normalizeForTextAlignment,
  type NormalizedTextPoint,
} from '../alignment/domTextMap'

const TTS_HIGHLIGHT_NAME = 'tts-current'
const SCROLL_SETTLE_MS = 120

interface TtsHighlightResult {
  scrollIntoView: () => void
}

interface HighlightTextRange {
  node: Text
  startOffset: number
  endOffset: number
}

interface ChunkAlignment {
  normalizedIndex: number
  normalizedEndIndex: number
}

interface AlignmentCache {
  doc: Document
  chunkTexts: string[]
  map: NormalizedTextPoint[]
  alignments: Map<number, ChunkAlignment>
  cssHighlight: HighlightLike | null
}

interface HighlightRegistryLike {
  delete(name: string): boolean
  get(name: string): HighlightLike | undefined
  set(name: string, highlight: HighlightLike): void
}

interface HighlightLike {
  add(range: Range): HighlightLike
  clear(): void
}

interface CssHighlightApi {
  createHighlight: () => HighlightLike
  registry: HighlightRegistryLike
}

interface UseTtsHighlightOptions {
  enabled: boolean
  currentText: string
  currentChunkIndex: number | null
  chunkTexts: string[]
}

// Highlights the chunk currently being spoken inside the sandboxed document iframe.
export function useTtsHighlight(
  iframeRef: React.RefObject<HTMLIFrameElement | null>,
  { enabled, currentText, currentChunkIndex, chunkTexts }: UseTtsHighlightOptions,
): void {
  const searchStartRef = useRef(0)
  const alignmentCacheRef = useRef<AlignmentCache | null>(null)

  useEffect(() => {
    const iframe = iframeRef.current

    if (!enabled || !currentText) {
      const doc = iframe?.contentDocument
      if (doc) clearTtsHighlight(doc)
      searchStartRef.current = 0
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
            currentText,
            currentChunkIndex,
            chunkTexts,
            searchStartRef,
            alignmentCacheRef,
          )
          if (!result) return

          // Repeated skip taps replace this timer, so smooth scrolling starts
          // only after the latest committed chunk has settled briefly.
          scrollTimer = window.setTimeout(() => {
            scrollTimer = null
            result.scrollIntoView()
          }, SCROLL_SETTLE_MS)
        } catch (err) {
          console.warn('Unable to highlight current TTS chunk:', err)
        }
      })
    }

    const doc = iframe?.contentDocument
    const shouldRetryOnLoad = iframe && (!doc || doc.readyState === 'loading')
    if (shouldRetryOnLoad) iframe.addEventListener('load', attemptHighlight)

    attemptHighlight()

    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame)
      if (scrollTimer !== null) window.clearTimeout(scrollTimer)
      if (shouldRetryOnLoad) iframe.removeEventListener('load', attemptHighlight)
    }
  }, [chunkTexts, currentChunkIndex, currentText, enabled, iframeRef])
}

function clearTtsHighlight(doc: Document): void {
  const cssHighlightApi = getCssHighlightApi(doc)
  const registeredHighlight = cssHighlightApi?.registry.get(TTS_HIGHLIGHT_NAME)
  registeredHighlight?.clear()
  cssHighlightApi?.registry.delete(TTS_HIGHLIGHT_NAME)

  const marks = doc.querySelectorAll('mark[data-tts-current]')
  marks.forEach((mark) => {
    const parent = mark.parentNode
    if (!parent) return
    const fragment = doc.createDocumentFragment()
    while (mark.firstChild) {
      fragment.appendChild(mark.firstChild)
    }
    parent.insertBefore(fragment, mark)
    parent.removeChild(mark)
    parent.normalize()
  })
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
    mark[data-tts-current] {
      background: #c7f9cc;
      color: inherit;
      border-radius: 3px;
      box-shadow: 0 0 0 2px rgba(22, 163, 74, 0.2);
      padding: 0.02em 0.08em;
      scroll-margin-block: 35vh;
    }
  `
  doc.head.appendChild(style)
}

function highlightTtsChunk(
  iframe: HTMLIFrameElement | null,
  chunkText: string,
  chunkIndex: number | null,
  chunkTexts: string[],
  searchStartRef: React.MutableRefObject<number>,
  alignmentCacheRef: React.MutableRefObject<AlignmentCache | null>,
): TtsHighlightResult | null {
  const doc = iframe?.contentDocument
  if (!doc || !iframe || !chunkText.trim()) return null

  clearTtsHighlight(doc)
  ensureTtsHighlightStyles(doc)

  const cssHighlightApi = getCssHighlightApi(doc)
  if (cssHighlightApi && chunkIndex !== null) {
    let cache = alignmentCacheRef.current
    if (!isUsableAlignmentCache(cache, doc, chunkTexts, chunkIndex)) {
      cache = buildAlignmentCache(doc, chunkTexts)
      alignmentCacheRef.current = cache
    }

    const alignment = cache.alignments.get(chunkIndex)
    if (alignment) {
      const range = createTextMapRange(doc, cache.map, alignment.normalizedIndex, alignment.normalizedEndIndex)
      if (range) {
        const highlight = cache.cssHighlight ?? cssHighlightApi.createHighlight()
        highlight.clear()
        highlight.add(range)
        cssHighlightApi.registry.set(TTS_HIGHLIGHT_NAME, highlight)
        cache.cssHighlight = highlight
        searchStartRef.current = alignment.normalizedEndIndex + 1
        return { scrollIntoView: () => scrollRangeIntoView(iframe, range) }
      }
    }
  }

  // Older WebViews without CSS Custom Highlight support retain the original
  // DOM-mark fallback. It rebuilds its map because wrapping text mutates nodes.
  alignmentCacheRef.current = null
  const target = normalizeForTextAlignment(chunkText)
  if (!target) return null

  const { text, map } = buildReadableDomTextMap(doc)
  const boundedStart = Math.min(Math.max(searchStartRef.current, 0), Math.max(text.length - 1, 0))
  let index = text.indexOf(target, boundedStart)
  if (index === -1 && boundedStart > 0) index = text.indexOf(target)
  if (index === -1) return null

  const normalizedEndIndex = index + target.length - 1
  const mark = markTextMapRange(doc, map, index, normalizedEndIndex)
  if (!mark) return null

  searchStartRef.current = normalizedEndIndex + 1
  return { scrollIntoView: () => mark.scrollIntoView({ behavior: 'smooth', block: 'center' }) }
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

  return { doc, chunkTexts, map, alignments, cssHighlight: null }
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

function getCssHighlightApi(doc: Document): CssHighlightApi | null {
  const view = doc.defaultView as (Window & {
    CSS?: { highlights?: HighlightRegistryLike }
    Highlight?: new (...ranges: Range[]) => HighlightLike
  }) | null
  const registry = view?.CSS?.highlights
  const HighlightConstructor = view?.Highlight
  if (!registry || !HighlightConstructor) return null
  return {
    registry,
    createHighlight: () => new HighlightConstructor(),
  }
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

function markTextMapRange(
  doc: Document,
  map: NormalizedTextPoint[],
  startIndex: number,
  endIndex: number,
): HTMLElement | null {
  const ranges = collectTextRanges(map, startIndex, endIndex)
  const marks: HTMLElement[] = []

  for (let index = ranges.length - 1; index >= 0; index--) {
    const textRange = ranges[index]
    const parent = textRange.node.parentNode
    const startOffset = Math.min(textRange.startOffset, textRange.node.length)
    const endOffset = Math.min(textRange.endOffset, textRange.node.length)
    if (!parent || startOffset >= endOffset) continue

    const range = doc.createRange()
    range.setStart(textRange.node, startOffset)
    range.setEnd(textRange.node, endOffset)

    const mark = doc.createElement('mark')
    mark.setAttribute('data-tts-current', 'true')
    mark.appendChild(range.extractContents())
    range.insertNode(mark)
    marks.unshift(mark)
  }

  return marks[0] ?? null
}

function collectTextRanges(
  map: NormalizedTextPoint[],
  startIndex: number,
  endIndex: number,
): HighlightTextRange[] {
  const ranges: HighlightTextRange[] = []

  for (let index = startIndex; index <= endIndex; index++) {
    const point = map[index]
    if (!point) continue

    const previous = ranges[ranges.length - 1]
    if (previous?.node === point.node) {
      previous.startOffset = Math.min(previous.startOffset, point.offset)
      previous.endOffset = Math.max(previous.endOffset, point.offset + 1)
      continue
    }

    ranges.push({
      node: point.node,
      startOffset: point.offset,
      endOffset: point.offset + 1,
    })
  }

  return ranges
}
