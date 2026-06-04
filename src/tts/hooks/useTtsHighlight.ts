import { useEffect, useRef } from 'react'

interface NormalizedTextPoint {
  node: Text
  offset: number
}

interface TtsHighlightResult {
  normalizedIndex: number
  mark: HTMLElement
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
    if (!enabled || !currentText) {
      const doc = iframeRef.current?.contentDocument
      if (doc) clearTtsHighlight(doc)
      searchStartRef.current = 0
      return
    }

    const frame = window.requestAnimationFrame(() => {
      try {
        const result = highlightTtsChunk(iframeRef.current, currentText, searchStartRef.current)
        if (!result) return

        searchStartRef.current = result.normalizedIndex + 1
        result.mark.scrollIntoView({ behavior: 'smooth', block: 'center' })
      } catch (err) {
        console.warn('Unable to highlight current TTS chunk:', err)
      }
    })

    return () => window.cancelAnimationFrame(frame)
  }, [currentChunkIndex, currentText, enabled, iframeRef])
}

function normalizeForTtsHighlight(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase()
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

function collectReadableTextNodes(doc: Document): Text[] {
  const body = doc.body
  if (!body) return []

  const textNodes: Text[] = []
  const walker = doc.createTreeWalker(body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.textContent?.trim()) return NodeFilter.FILTER_REJECT
      const parent = node.parentElement
      if (parent?.closest('script, style, noscript')) return NodeFilter.FILTER_REJECT
      return NodeFilter.FILTER_ACCEPT
    },
  })

  let node: Node | null
  while ((node = walker.nextNode())) {
    textNodes.push(node as Text)
  }

  return textNodes
}

// Normalized text loses whitespace details, so this map lets us convert a
// normalized match index back to the original Text node and character offset.
function buildNormalizedTextMap(textNodes: Text[]): {
  text: string
  map: NormalizedTextPoint[]
} {
  let text = ''
  const map: NormalizedTextPoint[] = []
  let pendingWhitespace: NormalizedTextPoint | null = null

  for (const node of textNodes) {
    const raw = node.textContent ?? ''
    for (let offset = 0; offset < raw.length; offset++) {
      const char = raw[offset]
      if (/\s/.test(char)) {
        if (text.length > 0) pendingWhitespace = { node, offset }
        continue
      }

      if (pendingWhitespace) {
        text += ' '
        map.push(pendingWhitespace)
        pendingWhitespace = null
      }

      text += char.toLowerCase()
      map.push({ node, offset })
    }
  }

  return { text, map }
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

  const target = normalizeForTtsHighlight(chunkText)
  if (!target) return null

  const { text, map } = buildNormalizedTextMap(collectReadableTextNodes(doc))
  const boundedStart = Math.min(Math.max(startAt, 0), Math.max(text.length - 1, 0))
  let index = text.indexOf(target, boundedStart)
  if (index === -1 && boundedStart > 0) index = text.indexOf(target)
  if (index === -1) return null

  const start = map[index]
  const end = map[index + target.length - 1]
  if (!start || !end) return null

  const range = doc.createRange()
  range.setStart(start.node, start.offset)
  range.setEnd(end.node, end.offset + 1)

  const mark = doc.createElement('mark')
  mark.setAttribute('data-tts-current', 'true')
  mark.appendChild(range.extractContents())
  range.insertNode(mark)

  return { normalizedIndex: index, mark }
}
