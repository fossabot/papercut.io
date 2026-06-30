export interface TranslationCapabilities {
  available: boolean
  backend: string
  reason: string
  platform: string
  defaultQualityMode: string
  models: TranslationModelInfo[]
}

const TRANSLATION_MODEL_INSTALL_PROGRESS_EVENT = 'translation-model-install-progress'
const TRANSLATION_PROGRESS_EVENT = 'translation-progress'

export interface TranslationModelInfo {
  id: string
  name: string
  engine: string
  tier: string
  manifestState: string
  sourceLanguages: string[]
  targetLanguages: string[]
  defaultQualityMode: string
  recommendedPlatforms: string[]
  licenseNotes: string
  sizeNotes: string
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

export interface TranslationModelInstallProgress {
  modelId: string
  status: 'starting' | 'downloading' | 'installed' | string
  message: string
  downloadedBytes: number
  totalBytes: number
  percent: number
}

export interface TranslationModelInstallResult {
  modelId: string
  modelDir: string
  bytes: number
}

export interface TranslationStartRequest {
  jobId?: string
  documentUrl: string
  sourceLanguage: string
  targetLanguage: string
  modelId: string
  qualityMode: string
  glossary?: TranslationGlossaryEntry[]
}

export interface TranslationGlossaryEntry {
  source: string
  target: string
  note?: string | null
}

export interface TranslationStartResult {
  jobId: string
  status: string
  message: string
}

export interface TranslationJobProgress {
  jobId: string
  status: 'starting' | 'translating' | 'completed' | 'cancelled' | string
  message: string
  completedSegments: number
  totalSegments: number
  cachedSegments: number
  translatedSegments: number
  reusedSegmentsInBatch: number
  completedBatches: number
  totalBatches: number
  percent: number
  preview: string
}

export interface TranslatedDocumentInfo {
  id: string
  documentUrl: string
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

export async function installTranslationModel(modelId: string): Promise<TranslationModelInstallResult> {
  if (!isNativeTranslationRuntime()) {
    throw new Error('Offline translation is only available in the desktop or Android app.')
  }
  const invoke = await loadTauriInvoke()
  return invoke<TranslationModelInstallResult>('translation_install_model', { modelId })
}

export async function listenTranslationModelInstallProgress(
  handler: (progress: TranslationModelInstallProgress) => void,
): Promise<() => void> {
  if (!isNativeTranslationRuntime()) return () => {}
  const mod = await import('@tauri-apps/api/event')
  return mod.listen<TranslationModelInstallProgress>(TRANSLATION_MODEL_INSTALL_PROGRESS_EVENT, (event) => {
    handler(event.payload)
  })
}

export async function listenTranslationProgress(
  handler: (progress: TranslationJobProgress) => void,
): Promise<() => void> {
  if (!isNativeTranslationRuntime()) return () => {}
  const mod = await import('@tauri-apps/api/event')
  return mod.listen<TranslationJobProgress>(TRANSLATION_PROGRESS_EVENT, (event) => {
    handler(event.payload)
  })
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
