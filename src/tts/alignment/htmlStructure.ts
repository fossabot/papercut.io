import type { ReadableSegmentKind } from './readableSegments'

const READABLE_BLOCK_TAGS = new Set([
  'ADDRESS',
  'ARTICLE',
  'ASIDE',
  'BLOCKQUOTE',
  'CAPTION',
  'DD',
  'DETAILS',
  'DIALOG',
  'DIV',
  'DL',
  'DT',
  'FIELDSET',
  'FIGCAPTION',
  'FIGURE',
  'FOOTER',
  'FORM',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'HEADER',
  'HGROUP',
  'HR',
  'LI',
  'MAIN',
  'NAV',
  'OL',
  'P',
  'PRE',
  'SECTION',
  'TABLE',
  'TBODY',
  'TD',
  'TFOOT',
  'TH',
  'THEAD',
  'TR',
  'UL',
])

export const HTML_SKIP_SELECTOR = 'script, style, noscript, svg'

// Centralizes the HTML block vocabulary so extraction and highlighting agree on
// where readable boundaries exist.
export function isReadableHtmlBlock(element: Element): boolean {
  return READABLE_BLOCK_TAGS.has(element.tagName)
}

// Finds readable leaf blocks in document order with one DOM traversal. Returning
// leaf owners keeps wrapper text from being narrated or highlighted twice.
export function collectReadableHtmlBlocks(root: Element | null): Element[] {
  if (!root) return []

  const blocks: Element[] = []
  collectReadableSubtree(root, blocks)
  return blocks
}

interface ReadableSubtree {
  hasText: boolean
  hasReadableBlock: boolean
}

// Post-order traversal returns whether descendants already own readable text. A
// readable wrapper becomes a segment only when no nested readable block owns it.
function collectReadableSubtree(element: Element, blocks: Element[]): ReadableSubtree {
  if (element.matches(HTML_SKIP_SELECTOR)) {
    return { hasText: false, hasReadableBlock: false }
  }

  let hasText = false
  let hasReadableDescendant = false
  for (const child of Array.from(element.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      if (/\S/.test(child.textContent ?? '')) hasText = true
      continue
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue

    const result = collectReadableSubtree(child as Element, blocks)
    if (result.hasText) hasText = true
    if (result.hasReadableBlock) hasReadableDescendant = true
  }

  const isReadable = hasText && isReadableHtmlBlock(element)
  if (isReadable && !hasReadableDescendant) blocks.push(element)

  return {
    hasText,
    hasReadableBlock: isReadable || hasReadableDescendant,
  }
}

// Reduces HTML-specific tags into format-neutral segment kinds used by chunking.
export function htmlSegmentKind(element: Element): ReadableSegmentKind {
  if (/^H[1-6]$/.test(element.tagName)) return 'heading'
  if (element.tagName === 'P') return 'paragraph'
  if (element.tagName === 'LI') return 'listItem'
  return 'block'
}
