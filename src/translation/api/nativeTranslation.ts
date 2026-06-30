export interface TranslationCapabilities {
  available: boolean
  backend: string
  reason: string
  platform: string
  defaultQualityMode: string
  models: TranslationModelInfo[]
}

export interface TranslationModelInfo {
  id: string
  name: string
  engine: string
  tier: string
  sourceLanguages: string[]
  targetLanguages: string[]
  defaultQualityMode: string
  recommendedPlatforms: string[]
  notes: string
}

export interface TranslationModelStatus {
  modelId: string
  installed: boolean
  installing: boolean
  modelDir?: string | null
  sourceUrl: string
  sourceLabel: string
  archiveBytes: number
  installedBytes: number
  sha256: string
  message: string
}

export interface TranslationStartRequest {
  documentUrl: string
  sourceLanguage: string
  targetLanguage: string
  modelId: string
  qualityMode: string
}

export interface TranslationStartResult {
  jobId: string
  status: string
  message: string
}

export interface TranslatedDocumentInfo {
  id: string
  sourceDocumentUrl: string
  title: string
  sourceLanguage: string
  targetLanguage: string
  modelId: string
  status: string
  createdAtMs: number
  updatedAtMs: number
}

export interface TranslationDeleteResult {
  id: string
  deleted: boolean
  bytesFreed: number
  message: string
}

let capabilitiesPromise: Promise<TranslationCapabilities> | null = null

export function isNativeTranslationRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

export function resetTranslationCapabilities(): void {
  capabilitiesPromise = null
}

export async function getTranslationCapabilities(): Promise<TranslationCapabilities> {
  if (!capabilitiesPromise) capabilitiesPromise = loadTranslationCapabilities()
  return capabilitiesPromise
}

export async function getTranslationModelStatus(modelId: string): Promise<TranslationModelStatus> {
  if (!isNativeTranslationRuntime()) {
    return {
      modelId,
      installed: false,
      installing: false,
      modelDir: null,
      sourceUrl: '',
      sourceLabel: 'Offline translation model catalog',
      archiveBytes: 0,
      installedBytes: 0,
      sha256: '',
      message: 'Offline translation is only available in the desktop or Android app.',
    }
  }
  const invoke = await loadTauriInvoke()
  return invoke<TranslationModelStatus>('translation_model_status', { request: { modelId } })
}

export async function startTranslationJob(request: TranslationStartRequest): Promise<TranslationStartResult> {
  if (!isNativeTranslationRuntime()) {
    throw new Error('Offline translation is only available in the desktop or Android app.')
  }
  const invoke = await loadTauriInvoke()
  return invoke<TranslationStartResult>('translation_start', { request })
}

export async function cancelTranslationJob(jobId: string): Promise<void> {
  if (!isNativeTranslationRuntime()) return
  const invoke = await loadTauriInvoke()
  await invoke('translation_cancel', { request: { jobId } })
}

export async function listTranslatedDocuments(): Promise<TranslatedDocumentInfo[]> {
  if (!isNativeTranslationRuntime()) return []
  const invoke = await loadTauriInvoke()
  return invoke<TranslatedDocumentInfo[]>('translation_list_documents')
}

export async function deleteTranslatedDocument(id: string): Promise<TranslationDeleteResult> {
  if (!isNativeTranslationRuntime()) {
    return {
      id,
      deleted: false,
      bytesFreed: 0,
      message: 'Offline translation is only available in the desktop or Android app.',
    }
  }
  const invoke = await loadTauriInvoke()
  return invoke<TranslationDeleteResult>('translation_delete_document', { request: { id } })
}

async function loadTranslationCapabilities(): Promise<TranslationCapabilities> {
  if (!isNativeTranslationRuntime()) {
    return {
      available: false,
      backend: 'translation-unavailable',
      reason: 'Offline translation is only available in the desktop or Android app.',
      platform: 'browser',
      defaultQualityMode: 'balanced',
      models: [],
    }
  }

  try {
    const invoke = await loadTauriInvoke()
    return await invoke<TranslationCapabilities>('translation_capabilities')
  } catch (err) {
    return {
      available: false,
      backend: 'translation-unavailable',
      reason: err instanceof Error ? err.message : String(err),
      platform: 'unknown',
      defaultQualityMode: 'balanced',
      models: [],
    }
  }
}

async function loadTauriInvoke(): Promise<<T>(cmd: string, args?: Record<string, unknown>) => Promise<T>> {
  const mod = await import('@tauri-apps/api/core')
  return mod.invoke
}
