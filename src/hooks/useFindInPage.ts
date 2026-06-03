import { useState, useEffect, useCallback, useRef } from 'react'

interface UseFindInPageReturn {
  showFind: boolean
  findQuery: string
  findMatchCount: number
  findCurrentIndex: number
  findInputRef: React.RefObject<HTMLInputElement | null>
  handleFind: (searchQuery: string) => void
  findNext: () => void
  findPrev: () => void
  closeFind: () => void
  setShowFind: React.Dispatch<React.SetStateAction<boolean>>
}

export function useFindInPage(
  iframeRef: React.RefObject<HTMLIFrameElement | null>,
): UseFindInPageReturn {
  const [showFind, setShowFind] = useState(false)
  const [findQuery, setFindQuery] = useState('')
  const [findMatchCount, setFindMatchCount] = useState(0)
  const [findCurrentIndex, setFindCurrentIndex] = useState(0)
  const findInputRef = useRef<HTMLInputElement | null>(null)

  const clearFindHighlights = useCallback(() => {
    const iframeDoc = iframeRef.current?.contentDocument
    if (!iframeDoc) return
    const marks = iframeDoc.querySelectorAll('mark[data-find]')
    marks.forEach((mark) => {
      const parent = mark.parentNode
      if (parent) {
        parent.replaceChild(iframeDoc.createTextNode(mark.textContent ?? ''), mark)
        parent.normalize()
      }
    })
  }, [iframeRef])

  const highlightFindMatches = useCallback((searchQuery: string): number => {
    clearFindHighlights()
    const iframeDoc = iframeRef.current?.contentDocument
    if (!iframeDoc || !searchQuery.trim()) return 0

    if (!iframeDoc.getElementById('find-styles')) {
      const style = iframeDoc.createElement('style')
      style.id = 'find-styles'
      style.textContent = `
        mark[data-find] { background: #fef08a; color: inherit; padding: 0; border-radius: 2px; }
        mark[data-find].current { background: #f97316; color: #fff; }
      `
      iframeDoc.head.appendChild(style)
    }

    const body = iframeDoc.body
    if (!body) return 0
    const lowerQuery = searchQuery.toLowerCase()
    const textNodes: Node[] = []
    const treeWalker = iframeDoc.createTreeWalker(body, NodeFilter.SHOW_TEXT)
    let node: Node | null
    while ((node = treeWalker.nextNode())) {
      textNodes.push(node)
    }

    let count = 0
    for (const textNode of textNodes) {
      const text = textNode.textContent ?? ''
      const lowerText = text.toLowerCase()
      if (!lowerText.includes(lowerQuery)) continue

      const fragment = iframeDoc.createDocumentFragment()
      let lastIdx = 0
      let searchIdx = lowerText.indexOf(lowerQuery, lastIdx)
      while (searchIdx !== -1) {
        if (searchIdx > lastIdx) {
          fragment.appendChild(iframeDoc.createTextNode(text.slice(lastIdx, searchIdx)))
        }
        const mark = iframeDoc.createElement('mark')
        mark.setAttribute('data-find', String(count))
        mark.textContent = text.slice(searchIdx, searchIdx + searchQuery.length)
        fragment.appendChild(mark)
        count++
        lastIdx = searchIdx + searchQuery.length
        searchIdx = lowerText.indexOf(lowerQuery, lastIdx)
      }
      if (lastIdx < text.length) {
        fragment.appendChild(iframeDoc.createTextNode(text.slice(lastIdx)))
      }
      textNode.parentNode?.replaceChild(fragment, textNode)
    }
    return count
  }, [iframeRef, clearFindHighlights])

  const scrollToMatch = useCallback((index: number) => {
    const iframe = iframeRef.current
    const iframeDoc = iframe?.contentDocument
    if (!iframeDoc || !iframe) return
    const prev = iframeDoc.querySelector('mark[data-find].current')
    prev?.classList.remove('current')
    const target = iframeDoc.querySelector(`mark[data-find="${index}"]`)
    if (target) {
      target.classList.add('current')
      const iframeRect = iframe.getBoundingClientRect()
      const targetRect = target.getBoundingClientRect()
      const absoluteTop = window.scrollY + iframeRect.top + targetRect.top
      window.scrollTo({ top: absoluteTop - window.innerHeight / 2, behavior: 'smooth' })
    }
  }, [iframeRef])

  const closeFind = useCallback(() => {
    setShowFind(false)
    setFindQuery('')
    setFindMatchCount(0)
    setFindCurrentIndex(0)
    clearFindHighlights()
  }, [clearFindHighlights])

  const handleFind = useCallback((searchQuery: string) => {
    setFindQuery(searchQuery)
    if (!searchQuery.trim()) {
      clearFindHighlights()
      setFindMatchCount(0)
      setFindCurrentIndex(0)
      return
    }
    const count = highlightFindMatches(searchQuery)
    setFindMatchCount(count)
    if (count > 0) {
      setFindCurrentIndex(0)
      scrollToMatch(0)
    } else {
      setFindCurrentIndex(0)
    }
  }, [clearFindHighlights, highlightFindMatches, scrollToMatch])

  const findNext = useCallback(() => {
    if (findMatchCount === 0) return
    const next = (findCurrentIndex + 1) % findMatchCount
    setFindCurrentIndex(next)
    scrollToMatch(next)
  }, [findMatchCount, findCurrentIndex, scrollToMatch])

  const findPrev = useCallback(() => {
    if (findMatchCount === 0) return
    const prev = (findCurrentIndex - 1 + findMatchCount) % findMatchCount
    setFindCurrentIndex(prev)
    scrollToMatch(prev)
  }, [findMatchCount, findCurrentIndex, scrollToMatch])

  // Ctrl+F / Escape keyboard handler
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault()
        setShowFind(true)
        setTimeout(() => findInputRef.current?.focus(), 0)
      }
      if (e.key === 'Escape') closeFind()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [closeFind])

  return {
    showFind,
    findQuery,
    findMatchCount,
    findCurrentIndex,
    findInputRef,
    handleFind,
    findNext,
    findPrev,
    closeFind,
    setShowFind,
  }
}
