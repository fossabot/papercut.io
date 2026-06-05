import type { KokoroDtype } from '../types'

const STORAGE_KEY = 'papercut.userUploads.v1'

export interface UserUploadDocument {
  url: string
  title: string
  importedAt: number
  voice: string
  speed: number
  dtype: string
  chunks: number
  audioDurationSec?: number
  wavBytes?: number
}

export function isUserUploadUrl(url: string): boolean {
  return /^\/user-uploads\/[a-fA-F0-9]+\.html(?:[#?].*)?$/.test(url)
}

export function getUserUploads(): UserUploadDocument[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed)
      ? parsed.filter(isUserUploadDocument).sort((a, b) => b.importedAt - a.importedAt)
      : []
  } catch {
    return []
  }
}

export function upsertUserUpload(input: Omit<UserUploadDocument, 'importedAt'>): UserUploadDocument {
  const upload: UserUploadDocument = {
    ...input,
    dtype: (input.dtype || 'native') as KokoroDtype,
    importedAt: Date.now(),
  }
  const records = getUserUploads().filter((record) => record.url !== upload.url)
  records.push(upload)
  localStorage.setItem(STORAGE_KEY, JSON.stringify(records))
  return upload
}

export function removeUserUpload(url: string): void {
  const records = getUserUploads().filter((record) => record.url !== url)
  localStorage.setItem(STORAGE_KEY, JSON.stringify(records))
}

function isUserUploadDocument(value: unknown): value is UserUploadDocument {
  if (!value || typeof value !== 'object') return false
  const record = value as Partial<UserUploadDocument>
  return typeof record.url === 'string' &&
    typeof record.title === 'string' &&
    typeof record.importedAt === 'number' &&
    typeof record.voice === 'string' &&
    typeof record.speed === 'number' &&
    typeof record.dtype === 'string' &&
    typeof record.chunks === 'number' &&
    (typeof record.audioDurationSec === 'number' || record.audioDurationSec === undefined) &&
    (typeof record.wavBytes === 'number' || record.wavBytes === undefined)
}
