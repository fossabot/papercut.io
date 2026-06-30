import { useCallback, useEffect, useState } from 'react'
import {
  deleteTranslatedDocument,
  getTranslationCapabilities,
  listTranslatedDocuments,
  startTranslationJob,
  type TranslatedDocumentInfo,
  type TranslationCapabilities,
  type TranslationDeleteResult,
  type TranslationStartResult,
} from '../api/nativeTranslation'

interface TranslationStartDocument {
  url: string
}

interface TranslationStartState {
  checking: boolean
  result: TranslationStartResult | null
  message: string
}

interface TranslationManagerState {
  capabilities: TranslationCapabilities | null
  deleteState: TranslationDeleteResult | null
  error: string
  loading: boolean
  startState: TranslationStartState
  translatedDocuments: TranslatedDocumentInfo[]
  onDeleteTranslatedDocument: (id: string) => Promise<void>
  onStartTranslationPreflight: (document: TranslationStartDocument) => Promise<void>
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
  const [startState, setStartState] = useState<TranslationStartState>({
    checking: false,
    result: null,
    message: '',
  })

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

  const onStartTranslationPreflight = useCallback(async (document: TranslationStartDocument) => {
    setStartState({ checking: true, result: null, message: '' })
    try {
      const model = capabilities?.models[0]
      const result = await startTranslationJob({
        documentUrl: document.url,
        sourceLanguage: 'auto',
        targetLanguage: 'en',
        modelId: model?.id ?? 'planned-translation-model',
        qualityMode: model?.defaultQualityMode ?? capabilities?.defaultQualityMode ?? 'balanced',
      })
      setStartState({
        checking: false,
        result,
        message: result.message,
      })
    } catch (err) {
      setStartState({
        checking: false,
        result: null,
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }, [capabilities])

  return {
    capabilities,
    deleteState,
    error,
    loading,
    startState,
    translatedDocuments,
    onDeleteTranslatedDocument,
    onStartTranslationPreflight,
    refresh,
  }
}
