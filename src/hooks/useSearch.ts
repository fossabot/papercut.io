import { useState, useCallback, useRef } from 'react'
import type { PagefindInstance, SearchResult } from '../types/search'
import { normalizeForPhraseMatch } from '../utils/textUtils'
import {
  extractQuotedPhrases,
  stripQuotes,
  docContainsAllPhrases,
  buildPhraseExcerpt,
} from '../utils/phraseSearch'

interface LastSearchInfo {
  phrases: string[]
  candidateCount: number
  resultCount: number
}

interface UseSearchReturn {
  query: string
  results: SearchResult[]
  loading: boolean
  submittedQuery: string
  lastSearchInfo: LastSearchInfo | null
  handleSearch: (searchQuery: string) => void
  submitSearch: () => void
}

export function useSearch(pagefindRef: React.MutableRefObject<PagefindInstance | null>): UseSearchReturn {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const [submittedQuery, setSubmittedQuery] = useState('')
  const [lastSearchInfo, setLastSearchInfo] = useState<LastSearchInfo | null>(null)

  const queryRef = useRef(query)
  queryRef.current = query
  const latestQueryRef = useRef<string>('')

  const performSearch = useCallback(async (rawQuery: string) => {
    const normalized = rawQuery.trim().toLowerCase()
    latestQueryRef.current = normalized
    setSubmittedQuery(normalized)
    if (!pagefindRef.current || normalized.length === 0) {
      setResults([])
      setLastSearchInfo(null)
      setLoading(false)
      return
    }
    const phrases = extractQuotedPhrases(normalized)
    const pagefindQuery = phrases.length > 0 ? stripQuotes(normalized) : normalized
    if (pagefindQuery.length === 0) {
      setResults([])
      setLastSearchInfo(null)
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const search = await pagefindRef.current.search(pagefindQuery)
      if (latestQueryRef.current !== normalized) return
      const data = await Promise.all(
        search.results.slice(0, 50).map((r) => r.data()),
      )
      if (latestQueryRef.current !== normalized) return
      let filtered = data
      if (phrases.length > 0) {
        const normalizedPhrases = phrases.map(normalizeForPhraseMatch)
        const verdicts = await Promise.all(
          data.map((d) => docContainsAllPhrases(d.url, normalizedPhrases)),
        )
        if (latestQueryRef.current !== normalized) return
        filtered = data.filter((_, i) => verdicts[i])
        const excerpts = await Promise.all(
          filtered.map((d) => buildPhraseExcerpt(d.url, normalizedPhrases)),
        )
        if (latestQueryRef.current !== normalized) return
        filtered = filtered.map((d, i) =>
          excerpts[i] ? { ...d, customExcerpt: excerpts[i] ?? undefined } : d,
        )
      }
      setResults(filtered)
      setLastSearchInfo({
        phrases,
        candidateCount: data.length,
        resultCount: filtered.length,
      })
    } catch (err) {
      console.error('Search failed:', err)
      if (latestQueryRef.current === normalized) {
        setResults([])
        setLastSearchInfo(null)
      }
    } finally {
      if (latestQueryRef.current === normalized) setLoading(false)
    }
  }, [pagefindRef])

  const handleSearch = useCallback((searchQuery: string) => {
    setQuery(searchQuery)
    queryRef.current = searchQuery
    if (searchQuery.trim().length === 0) {
      latestQueryRef.current = ''
      setResults([])
      setSubmittedQuery('')
      setLastSearchInfo(null)
      setLoading(false)
    }
  }, [])

  const submitSearch = useCallback(() => {
    performSearch(queryRef.current)
  }, [performSearch])

  return { query, results, loading, submittedQuery, lastSearchInfo, handleSearch, submitSearch }
}
