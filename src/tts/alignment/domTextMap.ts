import { HTML_SKIP_SELECTOR, hasReadableHtmlBlockDescendant, isReadableHtmlBlock } from './htmlStructure'
import { normalizeSegmentText } from './readableSegments'

export interface NormalizedTextPoint {
  node: Text
  offset: number
}

export interface NormalizedDomTextMap {
  text: string
  map: NormalizedTextPoint[]
}

interface DomTextMapBuilder extends NormalizedDomTextMap {
  pendingWhitespace: NormalizedTextPoint | null
}

// Normalizes playback chunk text with the same rules used by the DOM text map.
export function normalizeForTextAlignment(text: string): string {
  return normalizeSegmentText(text).toLowerCase()
}

// Builds the searchable text stream used by TTS highlighting while preserving a
// map back to iframe Text nodes so matched chunks can become real DOM ranges.
export function buildReadableDomTextMap(doc: Document): NormalizedDomTextMap {
  const body = doc.body
  if (!body) return { text: '', map: [] }

  const state: DomTextMapBuilder = { text: '', map: [], pendingWhitespace: null }
  appendReadableElement(body, state)
  if (state.text.length === 0) appendTextNodes(body, state)
  return { text: state.text, map: state.map }
}

// Traverses readable leaf blocks and inserts stable boundaries between them so
// headings and paragraphs align with the chunk text generated from segments.
function appendReadableElement(element: Element, state: DomTextMapBuilder): void {
  if (element.matches(HTML_SKIP_SELECTOR)) return

  if (isReadableLeafBlock(element)) {
    appendBoundary(state)
    appendTextNodes(element, state)
    appendBoundary(state)
    return
  }

  for (const child of Array.from(element.children)) {
    appendReadableElement(child, state)
  }
}

// Adds text nodes under one readable block without crossing into skipped content.
function appendTextNodes(root: Element, state: DomTextMapBuilder): void {
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.textContent?.trim()) return NodeFilter.FILTER_REJECT
      const parent = node.parentElement
      if (parent?.closest(HTML_SKIP_SELECTOR)) return NodeFilter.FILTER_REJECT
      return NodeFilter.FILTER_ACCEPT
    },
  })

  let node: Node | null
  while ((node = walker.nextNode())) {
    appendTextNode(node as Text, state)
  }
}

// Appends normalized text one character at a time so every searchable character
// can point back to the original text node and offset.
function appendTextNode(node: Text, state: DomTextMapBuilder): void {
  const raw = node.textContent ?? ''

  for (let offset = 0; offset < raw.length; offset++) {
    const char = raw[offset]
    if (/\s/.test(char)) {
      if (state.text.length > 0) state.pendingWhitespace = { node, offset }
      continue
    }

    if (state.pendingWhitespace) {
      appendMappedSpace(state, state.pendingWhitespace)
      state.pendingWhitespace = null
    }

    state.text += char.toLowerCase()
    state.map.push({ node, offset })
  }
}

// Represents a block boundary as one mapped space so chunk text can span blocks
// without losing the ability to construct a highlight range.
function appendBoundary(state: DomTextMapBuilder): void {
  if (state.text.length === 0 || state.text.endsWith(' ')) return
  const lastPoint = state.map[state.map.length - 1]
  if (!lastPoint) return
  appendMappedSpace(state, lastPoint)
}

// Adds a normalized space while preserving a nearby DOM point for range math.
function appendMappedSpace(state: DomTextMapBuilder, point: NormalizedTextPoint): void {
  if (state.text.endsWith(' ')) return
  state.text += ' '
  state.map.push(point)
}

// Mirrors readable-segment extraction: only leaf readable blocks own text.
function isReadableLeafBlock(element: Element): boolean {
  if (!isReadableHtmlBlock(element)) return false
  if (!normalizeSegmentText(element.textContent ?? '')) return false
  return !hasReadableHtmlBlockDescendant(element, (text) => Boolean(normalizeSegmentText(text)))
}
