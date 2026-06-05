import { useEffect, useRef } from 'react'
import { buildReadableDomTextMap, normalizeForTextAlignment, type NormalizedTextPoint } from '../alignment/domTextMap'

interface TtsHighlightResult {
  normalizedIndex: number
  normalizedEndIndex: number
  mark: HTMLElement
}

interface HighlightTextRange {
  node: Text
  startOffset: number
  endOffset: number
}

interface UseTtsHighlightOptions {
  enabled: boolean
  currentText: string
  currentChunkIndex: number | null
}

// Highlights the chunk currently being spoken inside the sandboxed document iframe.
export function useTtsHighlight(
  iframeRef: React.RefObject<HTMLIFrameElement | null>,
  { enabled, currentText, currentChunkIndex }: UseTtsHighlightOptions,
): void {
  const searchStartRef = useRef(0)

  useEffect(() => {
    const iframe = iframeRef.current

    if (!enabled || !currentText) {
      const doc = iframe?.contentDocument
      if (doc) clearTtsHighlight(doc)
      searchStartRef.current = 0
      return
    }

    let frame: number | null = null
    const attemptHighlight = () => {
      if (frame !== null) window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(() => {
        frame = null
        try {
          const result = highlightTtsChunk(iframeRef.current, currentText, searchStartRef.current)
          if (!result) return

          searchStartRef.current = result.normalizedEndIndex + 1
          result.mark.scrollIntoView({ behavior: 'smooth', block: 'center' })
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
      if (shouldRetryOnLoad) iframe.removeEventListener('load', attemptHighlight)
    }
  }, [currentChunkIndex, currentText, enabled, iframeRef])
}


function clearTtsHighlight(doc: Document): void {
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
  startAt: number,
): TtsHighlightResult | null {
  const doc = iframe?.contentDocument
  if (!doc || !chunkText.trim()) return null

  clearTtsHighlight(doc)
  ensureTtsHighlightStyles(doc)

  const target = normalizeForTextAlignment(chunkText)
  if (!target) return null

  const { text, map } = buildReadableDomTextMap(doc)
  const boundedStart = Math.min(Math.max(startAt, 0), Math.max(text.length - 1, 0))
  let index = text.indexOf(target, boundedStart)
  if (index === -1 && boundedStart > 0) index = text.indexOf(target)
  if (index === -1) return null

  const normalizedEndIndex = index + target.length - 1
  const mark = markTextMapRange(doc, map, index, normalizedEndIndex)
  if (!mark) return null

  return { normalizedIndex: index, normalizedEndIndex, mark }
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
