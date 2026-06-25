import { useState, useCallback, useMemo } from 'react'
import type { DocumentInfo } from '../types/search'
import { deriveAuthor, UNCATEGORIZED } from '../utils/documentUtils'

export interface AuthorGroup {
  author: string
  docs: DocumentInfo[]
}

interface UseDocumentFiltersOptions {
  includeDocument?: (doc: DocumentInfo) => boolean
}

interface UseDocumentFiltersReturn {
  selectedFilters: Set<string>
  showDocuments: boolean
  documentFilter: string
  collapsedAuthors: Set<string>
  groupedDocs: AuthorGroup[]
  docFilterLower: string
  toggleFilter: (title: string) => void
  clearFilters: () => void
  removeFilter: (title: string) => void
  toggleAuthor: (author: string) => void
  toggleAllInGroup: (docs: DocumentInfo[]) => void
  setShowDocuments: React.Dispatch<React.SetStateAction<boolean>>
  setDocumentFilter: React.Dispatch<React.SetStateAction<string>>
}

export function useDocumentFilters(
  allDocuments: DocumentInfo[],
  options: UseDocumentFiltersOptions = {},
): UseDocumentFiltersReturn {
  const [selectedFilters, setSelectedFilters] = useState<Set<string>>(new Set())
  const [showDocuments, setShowDocuments] = useState(true)
  const [documentFilter, setDocumentFilter] = useState('')
  const [collapsedAuthors, setCollapsedAuthors] = useState<Set<string>>(new Set())

  const { includeDocument } = options
  const docFilterLower = documentFilter.trim().toLowerCase()

  const groupedDocs = useMemo<AuthorGroup[]>(() => {
    const groups = new Map<string, DocumentInfo[]>()
    for (const doc of allDocuments) {
      if (includeDocument && !includeDocument(doc)) continue

      const author = doc.source === 'audiobook-upload' ? 'Imported Audiobooks' : deriveAuthor(doc.url)
      if (
        docFilterLower.length > 0 &&
        !doc.title.toLowerCase().includes(docFilterLower) &&
        !author.toLowerCase().includes(docFilterLower)
      ) {
        continue
      }
      const list = groups.get(author)
      if (list) list.push(doc)
      else groups.set(author, [doc])
    }
    return Array.from(groups.entries())
      .map(([author, docs]) => ({
        author,
        docs: docs.slice().sort((a, b) => a.title.localeCompare(b.title)),
      }))
      .sort((a, b) => {
        if (a.author === UNCATEGORIZED) return 1
        if (b.author === UNCATEGORIZED) return -1
        return a.author.localeCompare(b.author)
      })
  }, [allDocuments, docFilterLower, includeDocument])

  const toggleFilter = useCallback((title: string) => {
    setSelectedFilters((prev) => {
      const next = new Set(prev)
      if (next.has(title)) next.delete(title)
      else next.add(title)
      return next
    })
  }, [])

  const clearFilters = useCallback(() => {
    setSelectedFilters(new Set())
  }, [])

  const removeFilter = useCallback((title: string) => {
    setSelectedFilters((prev) => {
      if (!prev.has(title)) return prev
      const next = new Set(prev)
      next.delete(title)
      return next
    })
  }, [])

  const toggleAuthor = useCallback((author: string) => {
    setCollapsedAuthors((prev) => {
      const next = new Set(prev)
      if (next.has(author)) next.delete(author)
      else next.add(author)
      return next
    })
  }, [])

  const toggleAllInGroup = useCallback((docs: DocumentInfo[]) => {
    setSelectedFilters((prev) => {
      const next = new Set(prev)
      const allSelected = docs.every((d) => next.has(d.title))
      if (allSelected) docs.forEach((d) => next.delete(d.title))
      else docs.forEach((d) => next.add(d.title))
      return next
    })
  }, [])

  return {
    selectedFilters,
    showDocuments,
    documentFilter,
    collapsedAuthors,
    groupedDocs,
    docFilterLower,
    toggleFilter,
    clearFilters,
    removeFilter,
    toggleAuthor,
    toggleAllInGroup,
    setShowDocuments,
    setDocumentFilter,
  }
}
