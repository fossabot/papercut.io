import type { TtsChunkSourceSpan } from '../types'
import { HTML_SKIP_SELECTOR, collectReadableHtmlBlocks } from './htmlStructure'

export interface ReadableDomSegmentIndex {
  elements: Element[]
}

interface NormalizedTextPoint {
  node: Text
  offset: number
}

interface NormalizedRangePoints {
  start: NormalizedTextPoint
  end: NormalizedTextPoint
}

// Build only ordered leaf-element references. No document-wide text concatenation
// or per-character arrays, keeping startup proportional to DOM nodes.
export function buildReadableDomSegmentIndex(doc: Document): ReadableDomSegmentIndex {
  const body = doc.body
  if (!body) return { elements: [] }

  const elements = collectReadableHtmlBlocks(body)
  return { elements: elements.length > 0 ? elements : [body] }
}

// Convert chunker-owned normalized segment offsets back to live DOM points. Only
// start/end segments are scanned, so one highlight does not scale with book size.
export function createRangeForSourceSpan(
  doc: Document,
  index: ReadableDomSegmentIndex,
  span: TtsChunkSourceSpan,
): Range | null {
  const startElement = index.elements[span.startSegmentIndex]
  const endElement = index.elements[span.endSegmentIndex]
  if (!startElement?.isConnected || !endElement?.isConnected || span.endOffset <= 0) return null

  const startPoints = findNormalizedRangePoints(
    startElement,
    span.startOffset,
    span.startSegmentIndex === span.endSegmentIndex ? span.endOffset : span.startOffset + 1,
  )
  const endPoints = span.startSegmentIndex === span.endSegmentIndex
    ? startPoints
    : findNormalizedRangePoints(endElement, Math.max(0, span.endOffset - 1), span.endOffset)
  if (!startPoints || !endPoints) return null

  const range = doc.createRange()
  range.setStart(startPoints.start.node, Math.min(startPoints.start.offset, startPoints.start.node.length))
  range.setEnd(endPoints.end.node, Math.min(endPoints.end.offset + 1, endPoints.end.node.length))
  return range
}

// Replay segment whitespace normalization while retaining original Text-node offsets.
// Stops immediately after requested end, avoiding a full segment mapping table.
function findNormalizedRangePoints(
  root: Element,
  startOffset: number,
  endOffset: number,
): NormalizedRangePoints | null {
  if (startOffset < 0 || endOffset <= startOffset) return null

  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement
      if (parent?.closest(HTML_SKIP_SELECTOR)) return NodeFilter.FILTER_REJECT
      return NodeFilter.FILTER_ACCEPT
    },
  })

  let normalizedOffset = 0
  let pendingWhitespace: NormalizedTextPoint | null = null
  let start: NormalizedTextPoint | null = null

  const emit = (point: NormalizedTextPoint): NormalizedRangePoints | null => {
    if (normalizedOffset === startOffset) start = point
    if (normalizedOffset === endOffset - 1) {
      return start ? { start, end: point } : null
    }
    normalizedOffset += 1
    return null
  }

  let current: Node | null
  while ((current = walker.nextNode())) {
    const node = current as Text
    const raw = node.data
    for (let offset = 0; offset < raw.length; offset++) {
      if (/\s/.test(raw[offset])) {
        if (normalizedOffset > 0) pendingWhitespace = { node, offset }
        continue
      }

      if (pendingWhitespace) {
        const points = emit(pendingWhitespace)
        if (points) return points
        pendingWhitespace = null
      }

      const points = emit({ node, offset })
      if (points) return points
    }
  }

  return null
}
