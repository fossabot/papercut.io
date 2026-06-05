import {
  KOKORO_AUDIO_CACHE_VERSION,
  KOKORO_MODEL_DTYPE,
  KOKORO_MODEL_ID,
  resolveKokoroDtype,
  type KokoroTtsOptions,
} from '../types'

// This registry stores completed-audiobook metadata only. Generated WAV
// chunks live in native app data under the audiobook cache directory.
const STORAGE_KEY = 'papercut.savedAudiobooks.v1'

export interface SavedAudiobookRecord {
  id: string
  documentUrl: string
  title: string
  voice: string
  speed: number
  modelId: string
  cacheVersion?: string
  dtype: string
  savedAt: number
  chunks: number
  audioDurationSec?: number
  wavBytes?: number
  recovered?: boolean
}

export function createAudiobookId(documentUrl: string, options: KokoroTtsOptions): string {
  const dtype = resolveKokoroDtype(options)
  // Include model identity and playback options so saved-audio records invalidate
  // when the Kokoro model, dtype, voice, speed, or source document changes.
  return [
    KOKORO_MODEL_ID,
    KOKORO_AUDIO_CACHE_VERSION,
    dtype,
    options.voice,
    options.speed.toFixed(2),
    normalizeDocumentUrl(documentUrl),
  ].join('|')
}

export function getSavedAudiobooks(): SavedAudiobookRecord[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed)
      ? parsed.filter(isSavedAudiobookRecord).map((record) => ({
        ...record,
        modelId: record.modelId || KOKORO_MODEL_ID,
        cacheVersion: record.cacheVersion || 'legacy',
        dtype: record.dtype || KOKORO_MODEL_DTYPE,
      }))
      : []
  } catch {
    return []
  }
}

export function isCurrentAudiobookRecord(record: SavedAudiobookRecord): boolean {
  if (record.modelId !== KOKORO_MODEL_ID || record.cacheVersion !== KOKORO_AUDIO_CACHE_VERSION) {
    return false
  }

  return record.id === createAudiobookId(record.documentUrl, {
    voice: record.voice as KokoroTtsOptions['voice'],
    speed: record.speed,
    dtype: record.dtype as KokoroTtsOptions['dtype'],
  })
}

export function markAudiobookSaved(record: Omit<SavedAudiobookRecord, 'id' | 'modelId' | 'savedAt'>): SavedAudiobookRecord {
  const dtype = record.dtype || KOKORO_MODEL_DTYPE
  const saved: SavedAudiobookRecord = {
    ...record,
    id: createAudiobookId(record.documentUrl, {
      voice: record.voice as KokoroTtsOptions['voice'],
      speed: record.speed,
      dtype: dtype as KokoroTtsOptions['dtype'],
    }),
    modelId: KOKORO_MODEL_ID,
    cacheVersion: KOKORO_AUDIO_CACHE_VERSION,
    dtype,
    savedAt: Date.now(),
  }

  const records = getSavedAudiobooks().filter((item) => item.id !== saved.id)
  records.push(saved)
  localStorage.setItem(STORAGE_KEY, JSON.stringify(records))
  return saved
}

export function removeSavedAudiobook(id: string): void {
  const records = getSavedAudiobooks().filter((item) => item.id !== id)
  localStorage.setItem(STORAGE_KEY, JSON.stringify(records))
}

export function hasSavedAudiobook(documentUrl: string, options: KokoroTtsOptions): boolean {
  const id = createAudiobookId(documentUrl, options)
  return getSavedAudiobooks().some((item) => isCurrentAudiobookRecord(item) && item.id === id)
}

function normalizeDocumentUrl(documentUrl: string): string {
  try {
    return new URL(documentUrl, window.location.href).pathname
  } catch {
    return documentUrl.split('#')[0].split('?')[0]
  }
}

function isSavedAudiobookRecord(value: unknown): value is SavedAudiobookRecord {
  if (!value || typeof value !== 'object') return false
  const record = value as Partial<SavedAudiobookRecord>
  return typeof record.id === 'string' &&
    typeof record.documentUrl === 'string' &&
    typeof record.title === 'string' &&
    typeof record.voice === 'string' &&
    typeof record.speed === 'number' &&
    (typeof record.cacheVersion === 'string' || record.cacheVersion === undefined) &&
    typeof record.savedAt === 'number' &&
    typeof record.chunks === 'number' &&
    (typeof record.audioDurationSec === 'number' || record.audioDurationSec === undefined) &&
    (typeof record.wavBytes === 'number' || record.wavBytes === undefined)
}
