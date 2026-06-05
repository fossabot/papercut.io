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

// Finds nested readable blocks below a candidate container so callers can treat
// only true leaf blocks as text owners.
export function hasReadableHtmlBlockDescendant(
  element: Element,
  hasReadableText: (text: string) => boolean,
): boolean {
  const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_ELEMENT, {
    acceptNode(node) {
      if (node === element) return NodeFilter.FILTER_SKIP

      const candidate = node as Element
      if (candidate.matches(HTML_SKIP_SELECTOR)) return NodeFilter.FILTER_REJECT
      if (!isReadableHtmlBlock(candidate)) return NodeFilter.FILTER_SKIP

      return hasReadableText(candidate.textContent ?? '')
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_SKIP
    },
  })

  return Boolean(walker.nextNode())
}

// Reduces HTML-specific tags into format-neutral segment kinds used by chunking.
export function htmlSegmentKind(element: Element): ReadableSegmentKind {
  if (/^H[1-6]$/.test(element.tagName)) return 'heading'
  if (element.tagName === 'P') return 'paragraph'
  if (element.tagName === 'LI') return 'listItem'
  return 'block'
}
