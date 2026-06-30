import { useCallback, useEffect, useState } from 'react'
import {
  deleteTranslatedDocument,
  getTranslationModelStatus,
  installTranslationModel,
  listenTranslationModelInstallProgress,
  getTranslationCapabilities,
  listTranslatedDocuments,
  startTranslationJob,
  type TranslatedDocumentInfo,
  type TranslationCapabilities,
  type TranslationDeleteResult,
  type TranslationModelInstallProgress,
  type TranslationModelInstallResult,
  type TranslationModelStatus,
  type TranslationStartRequest,
  type TranslationStartResult,
} from '../api/nativeTranslation'

interface TranslationStartState {
  checking: boolean
  result: TranslationStartResult | null
  message: string
}

interface TranslationModelInstallState {
  installingModelId: string
  progress: TranslationModelInstallProgress | null
  result: TranslationModelInstallResult | null
  message: string
}

interface TranslationManagerState {
  capabilities: TranslationCapabilities | null
  deleteState: TranslationDeleteResult | null
  error: string
  loading: boolean
  modelInstallState: TranslationModelInstallState
  modelStatuses: Record<string, TranslationModelStatus>
  startState: TranslationStartState
  translatedDocuments: TranslatedDocumentInfo[]
  onDeleteTranslatedDocument: (id: string) => Promise<void>
  onInstallTranslationModel: (modelId: string) => Promise<void>
  onStartTranslationPreflight: (request: TranslationStartRequest) => Promise<void>
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
  const [modelStatuses, setModelStatuses] = useState<Record<string, TranslationModelStatus>>({})
  const [modelInstallState, setModelInstallState] = useState<TranslationModelInstallState>({
    installingModelId: '',
    progress: null,
    result: null,
    message: '',
  })
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
      const statusEntries = await Promise.all(
        nextCapabilities.models.map(async (model) => [model.id, await getTranslationModelStatus(model.id)] as const),
      )
      setCapabilities(nextCapabilities)
      setTranslatedDocuments(nextDocuments)
      setModelStatuses(Object.fromEntries(statusEntries))
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

  useEffect(() => {
    if (!enabled) return
    let disposed = false
    let unlisten: (() => void) | null = null
    void listenTranslationModelInstallProgress((progress) => {
      if (disposed) return
      setModelInstallState((current) => ({
        ...current,
        installingModelId: progress.status === 'installed' ? '' : progress.modelId,
        progress,
        message: progress.message,
      }))
      setModelStatuses((current) => {
        const existing = current[progress.modelId]
        if (!existing) return current
        return {
          ...current,
          [progress.modelId]: {
            ...existing,
            installing: progress.status !== 'installed',
            installed: progress.status === 'installed' ? true : existing.installed,
            installedBytes: progress.status === 'installed' ? progress.totalBytes : existing.installedBytes,
          },
        }
      })
    }).then((cleanup) => {
      if (disposed) cleanup()
      else unlisten = cleanup
    }).catch((err) => {
      if (!disposed) setError(err instanceof Error ? err.message : String(err))
    })
    return () => {
      disposed = true
      if (unlisten) unlisten()
    }
  }, [enabled])

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

  const onInstallTranslationModel = useCallback(async (modelId: string) => {
    setModelInstallState({
      installingModelId: modelId,
      progress: null,
      result: null,
      message: 'Preparing translation model download',
    })
    try {
      const result = await installTranslationModel(modelId)
      setModelInstallState({
        installingModelId: '',
        progress: {
          modelId,
          status: 'installed',
          message: 'Translation model installed',
          downloadedBytes: result.bytes,
          totalBytes: result.bytes,
          percent: 100,
        },
        result,
        message: 'Translation model installed',
      })
      await refresh()
    } catch (err) {
      setModelInstallState({
        installingModelId: '',
        progress: null,
        result: null,
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }, [refresh])

  const onStartTranslationPreflight = useCallback(async (request: TranslationStartRequest) => {
    setStartState({ checking: true, result: null, message: '' })
    try {
      const result = await startTranslationJob(request)
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
  }, [])

  return {
    capabilities,
    deleteState,
    error,
    loading,
    modelInstallState,
    modelStatuses,
    startState,
    translatedDocuments,
    onDeleteTranslatedDocument,
    onInstallTranslationModel,
    onStartTranslationPreflight,
    refresh,
  }
}
