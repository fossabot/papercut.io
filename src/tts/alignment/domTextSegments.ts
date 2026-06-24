import type { TtsChunkSourceSpan } from '../types'
import { collectReadableHtmlSegments, type ReadableHtmlSegment } from './htmlStructure'

export interface ReadableDomSegmentIndex {
  segments: ReadableHtmlSegment[]
}

interface NormalizedTextPoint {
  node: Text
  offset: number
}

interface NormalizedRangePoints {
  start: NormalizedTextPoint
  end: NormalizedTextPoint
}

// Build ordered text-owner references below the reader root. No document-wide
// text concatenation or per-character arrays, keeping startup proportional to DOM nodes.
export function buildReadableDomSegmentIndex(root: Element | Document): ReadableDomSegmentIndex {
  const element = root instanceof Document ? root.body : root
  if (!element) return { segments: [] }

  return { segments: collectReadableHtmlSegments(element) }
}

// Convert chunker-owned normalized segment offsets back to live DOM points. Only
// start/end segments are scanned, so one highlight does not scale with book size.
export function createRangeForSourceSpan(
  doc: Document,
  index: ReadableDomSegmentIndex,
  span: TtsChunkSourceSpan,
): Range | null {
  const startSegment = index.segments[span.startSegmentIndex]
  const endSegment = index.segments[span.endSegmentIndex]
  if (
    !startSegment?.owner.isConnected ||
    !endSegment?.owner.isConnected ||
    span.endOffset <= 0
  ) return null

  const startPoints = findNormalizedRangePoints(
    startSegment.textNodes,
    span.startOffset,
    span.startSegmentIndex === span.endSegmentIndex ? span.endOffset : span.startOffset + 1,
  )
  const endPoints = span.startSegmentIndex === span.endSegmentIndex
    ? startPoints
    : findNormalizedRangePoints(endSegment.textNodes, Math.max(0, span.endOffset - 1), span.endOffset)
  if (!startPoints || !endPoints) return null

  const range = doc.createRange()
  range.setStart(startPoints.start.node, Math.min(startPoints.start.offset, startPoints.start.node.length))
  range.setEnd(endPoints.end.node, Math.min(endPoints.end.offset + 1, endPoints.end.node.length))
  return range
}

// Replay segment whitespace normalization while retaining original Text-node offsets.
// Stops immediately after requested end, avoiding a full segment mapping table.
function findNormalizedRangePoints(
  textNodes: Text[],
  startOffset: number,
  endOffset: number,
): NormalizedRangePoints | null {
  if (startOffset < 0 || endOffset <= startOffset) return null

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

  for (const node of textNodes) {
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
