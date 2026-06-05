import { HTML_SKIP_SELECTOR, hasReadableHtmlBlockDescendant, htmlSegmentKind, isReadableHtmlBlock } from './htmlStructure'

export type ReadableSegmentKind = 'heading' | 'paragraph' | 'listItem' | 'block' | 'inline'

export interface ReadableSegment {
  text: string
  kind: ReadableSegmentKind
}

// Converts viewable HTML into ordered narration segments so chunking can respect
// visible document structure instead of relying on raw body.textContent.
export function extractReadableSegmentsFromHtml(html: string): ReadableSegment[] {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  doc.querySelectorAll(HTML_SKIP_SELECTOR).forEach((el) => el.remove())
  return extractReadableSegmentsFromElement(doc.body ?? doc.documentElement)
}

// Rebuilds plain readable text from segments for callers that need a document-
// level string while preserving block boundaries as paragraph breaks.
export function extractReadableTextFromSegments(segments: ReadableSegment[]): string {
  return segments
    .map((segment) => normalizeSegmentText(segment.text))
    .filter(Boolean)
    .join('\n\n')
}

// Keeps source text stable before chunking, hashing, and native synthesis.
export function normalizeSpeechText(text: string): string {
  return text
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

// Collapses a single segment to inline-like text while reusing the same document
// normalizer used for full readable-text extraction.
export function normalizeSegmentText(text: string): string {
  return normalizeSpeechText(text.replace(/\s+/g, ' '))
}

// Walks only leaf readable blocks so container elements do not duplicate text
// already represented by their child headings, paragraphs, or list items.
function extractReadableSegmentsFromElement(root: Element | null): ReadableSegment[] {
  if (!root) return []

  const segments: ReadableSegment[] = []
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
    acceptNode(node) {
      const element = node as Element
      if (element.matches(HTML_SKIP_SELECTOR)) return NodeFilter.FILTER_REJECT
      if (!isReadableHtmlBlock(element)) return NodeFilter.FILTER_SKIP
      if (hasReadableBlockChild(element)) return NodeFilter.FILTER_SKIP
      return NodeFilter.FILTER_ACCEPT
    },
  })

  let node: Node | null
  while ((node = walker.nextNode())) {
    const element = node as Element
    const text = normalizeSegmentText(element.textContent ?? '')
    if (!text) continue
    segments.push({ text, kind: htmlSegmentKind(element) })
  }

  if (segments.length > 0) return segments

  const text = normalizeSegmentText(root.textContent ?? '')
  return text ? [{ text, kind: 'block' }] : []
}

// Treats nested readable blocks as ownership boundaries; the parent is structure,
// not a second narration segment.
function hasReadableBlockChild(element: Element): boolean {
  return hasReadableHtmlBlockDescendant(element, (text) => Boolean(normalizeSegmentText(text)))
}
