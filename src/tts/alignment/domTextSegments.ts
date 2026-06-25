import type { TtsChunkSourceSpan } from '../types'
import { collectReadableHtmlSegments, type ReadableHtmlSegment } from './htmlStructure'

export interface ReadableDomSegmentIndex {
  segments: ReadableHtmlSegment[]
}

export interface ReadableDomTextLocatorIndex {
  text: string
  segmentTexts: string[]
  segmentStarts: number[]
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

// Build a compact searchable text map from the existing readable segment index.
// This is only needed as an imported-bundle fallback when old bundles lack
// durable locators or their reconstructed spans no longer match the live DOM.
// Segment starts point into the joined normalized text, so a match can be
// converted back into the same segment/offset coordinates used by sourceSpan.
export function buildReadableDomTextLocatorIndex(
  index: ReadableDomSegmentIndex,
): ReadableDomTextLocatorIndex {
  const segmentTexts: string[] = []
  const segmentStarts: number[] = []
  let text = ''

  for (const segment of index.segments) {
    const segmentText = normalizeLocatorText(segment.textNodes.map((node) => node.data).join(''))
    segmentTexts.push(segmentText)
    const segmentStart = segmentText && text ? text.length + 1 : text.length
    segmentStarts.push(segmentStart)
    if (!segmentText) continue
    text += (text ? ' ' : '') + segmentText
  }

  return { text, segmentTexts, segmentStarts }
}

// Locate a chunk in the normalized live-reader text and return ordinary source
// span coordinates so the existing Range creation/scroller can stay unchanged.
// A numeric hint means "search from here only", which keeps fallback recovery
// ordered for repeated phrases when jumping directly to a later audiobook chunk.
// A sourceSpan hint is looser: try near that old span first, then fall back to
// the first match because legacy spans may be stale after browser HTML repair.
export function createSourceSpanFromTextMatch(
  locator: ReadableDomTextLocatorIndex,
  chunkText: string,
  hintOrFromOffset?: TtsChunkSourceSpan | number,
): TtsChunkSourceSpan | null {
  const text = normalizeLocatorText(chunkText)
  if (!text) return null

  const fromOffset = typeof hintOrFromOffset === 'number'
    ? hintOrFromOffset
    : hintOrFromOffset
      ? globalOffsetForSpan(locator, hintOrFromOffset)
      : -1
  const hintedAt = fromOffset >= 0 ? locator.text.indexOf(text, fromOffset) : -1
  if (typeof hintOrFromOffset === 'number' && hintedAt < 0) return null
  const at = hintedAt >= 0 ? hintedAt : locator.text.indexOf(text)
  if (at < 0) return null

  const start = globalOffsetToSegmentOffset(locator, at, 'forward')
  const end = globalOffsetToSegmentOffset(locator, at + text.length - 1, 'backward')
  if (!start || !end) return null

  return {
    startSegmentIndex: start.segmentIndex,
    startOffset: start.offset,
    endSegmentIndex: end.segmentIndex,
    endOffset: end.offset + 1,
  }
}

// Return the global joined-text offset immediately after a recovered sourceSpan.
// The fallback builder uses this as its next search cursor so chunks are matched
// in audiobook order instead of repeatedly matching the first repeated phrase.
export function sourceSpanEndGlobalOffset(
  locator: ReadableDomTextLocatorIndex,
  span: TtsChunkSourceSpan,
): number {
  const segmentStart = locator.segmentStarts[span.endSegmentIndex]
  const segmentText = locator.segmentTexts[span.endSegmentIndex]
  if (segmentStart === undefined || segmentText === undefined) return -1
  return segmentStart + Math.min(Math.max(span.endOffset, 0), segmentText.length)
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

function normalizeLocatorText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function globalOffsetForSpan(
  locator: ReadableDomTextLocatorIndex,
  span: TtsChunkSourceSpan,
): number {
  const segmentStart = locator.segmentStarts[span.startSegmentIndex]
  const segmentText = locator.segmentTexts[span.startSegmentIndex]
  if (segmentStart === undefined || segmentText === undefined) return -1
  return segmentStart + Math.min(Math.max(span.startOffset, 0), segmentText.length)
}

function globalOffsetToSegmentOffset(
  locator: ReadableDomTextLocatorIndex,
  globalOffset: number,
  bias: 'forward' | 'backward',
): { segmentIndex: number; offset: number } | null {
  if (!Number.isFinite(globalOffset) || globalOffset < 0) return null

  const segmentIndex = findSegmentForGlobalOffset(locator, globalOffset)
  if (segmentIndex !== null) {
    return {
      segmentIndex,
      offset: globalOffset - locator.segmentStarts[segmentIndex],
    }
  }

  return bias === 'forward'
    ? findNearestNonEmptySegment(locator, globalOffset, 1)
    : findNearestNonEmptySegment(locator, globalOffset, -1)
}

function findSegmentForGlobalOffset(
  locator: ReadableDomTextLocatorIndex,
  globalOffset: number,
): number | null {
  let low = 0
  let high = locator.segmentStarts.length - 1
  let candidate = -1

  while (low <= high) {
    const mid = Math.floor((low + high) / 2)
    if (locator.segmentStarts[mid] <= globalOffset) {
      candidate = mid
      low = mid + 1
    } else {
      high = mid - 1
    }
  }

  if (candidate < 0) return null
  const segmentStart = locator.segmentStarts[candidate]
  const segmentText = locator.segmentTexts[candidate]
  if (globalOffset >= segmentStart && globalOffset < segmentStart + segmentText.length) {
    return candidate
  }
  return null
}

function findNearestNonEmptySegment(
  locator: ReadableDomTextLocatorIndex,
  globalOffset: number,
  direction: 1 | -1,
): { segmentIndex: number; offset: number } | null {
  const starts = locator.segmentStarts
  let index = direction > 0
    ? starts.findIndex((start) => start > globalOffset)
    : starts.length - 1

  if (direction < 0) {
    while (index >= 0 && starts[index] > globalOffset) index--
  }

  while (index >= 0 && index < locator.segmentTexts.length) {
    const segmentText = locator.segmentTexts[index]
    if (segmentText) {
      return {
        segmentIndex: index,
        offset: direction > 0 ? 0 : segmentText.length,
      }
    }
    index += direction
  }

  return null
}
