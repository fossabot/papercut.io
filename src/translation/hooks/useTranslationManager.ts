import { useCallback, useEffect, useState } from 'react'
import {
  deleteTranslatedDocument,
  getTranslationCapabilities,
  listTranslatedDocuments,
  type TranslatedDocumentInfo,
  type TranslationCapabilities,
  type TranslationDeleteResult,
} from '../api/nativeTranslation'

interface TranslationManagerState {
  capabilities: TranslationCapabilities | null
  deleteState: TranslationDeleteResult | null
  error: string
  loading: boolean
  translatedDocuments: TranslatedDocumentInfo[]
  onDeleteTranslatedDocument: (id: string) => Promise<void>
  refresh: () => Promise<void>
}

interface TranslationManagerOptions {
  enabled: boolean
}

export function useTranslationManager({ enabled }: TranslationManagerOptions): TranslationManagerState {
  const [capabilities, setCapabilities] = useState<TranslationCapabilities | null>(null)
  const [translatedDocuments, setTranslatedDocuments] = useState<TranslatedDocumentInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [deleteState, setDeleteState] = useState<TranslationDeleteResult | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [nextCapabilities, nextDocuments] = await Promise.all([
        getTranslationCapabilities(),
        listTranslatedDocuments(),
      ])
      setCapabilities(nextCapabilities)
      setTranslatedDocuments(nextDocuments)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!enabled) return
    void refresh()
  }, [enabled, refresh])

  const onDeleteTranslatedDocument = useCallback(async (id: string) => {
    setDeleteState(null)
    try {
      const result = await deleteTranslatedDocument(id)
      setDeleteState(result)
      await refresh()
    } catch (err) {
      setDeleteState({
        id,
        deleted: false,
        bytesFreed: 0,
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }, [refresh])

  return {
    capabilities,
    deleteState,
    error,
    loading,
    translatedDocuments,
    onDeleteTranslatedDocument,
    refresh,
  }
}
