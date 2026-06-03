import { KOKORO_VOICES, type KokoroVoice } from './types'

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0:00'
  const rounded = Math.round(seconds)
  const hours = Math.floor(rounded / 3600)
  const minutes = Math.floor((rounded % 3600) / 60)
  const remainingSeconds = rounded % 60
  if (hours > 0) {
    return hours + ':' + String(minutes).padStart(2, '0') + ':' + String(remainingSeconds).padStart(2, '0')
  }
  return minutes + ':' + String(remainingSeconds).padStart(2, '0')
}

export function formatStorageSize(bytes: number | undefined): string | null {
  if (!bytes || !Number.isFinite(bytes) || bytes <= 0) return null
  if (bytes >= 1024 * 1024 * 1024) {
    const gb = bytes / 1024 / 1024 / 1024
    return gb.toFixed(gb >= 10 ? 1 : 2) + ' GB'
  }
  return Math.max(1, Math.ceil(bytes / 1024 / 1024)) + ' MB'
}

export function formatAudiobookVoiceMeta(voice: string, speed: number, dtype: string): string {
  const voiceName = KOKORO_VOICES[voice as KokoroVoice] ?? voice
  const speedLabel = Number.isFinite(speed) ? speed.toFixed(speed % 1 === 0 ? 0 : 2).replace(/0$/, '').replace(/\.$/, '') + 'x' : '1x'
  return 'Voice ' + voiceName + ' • ' + speedLabel + ' • ' + dtype
}

export function formatDownloadSavedStatus(seconds: number | undefined, percent: number, bytes?: number): string {
  const boundedPercent = Math.min(Math.max(percent, 0), 100)
  const parts = seconds && seconds > 0
    ? ['Saved duration ' + formatDuration(seconds), boundedPercent + '% saved']
    : [boundedPercent + '% saved']
  const storage = formatStorageSize(bytes)
  if (storage) parts.push(storage + ' stored')
  return parts.join(' • ')
}

export function formatAudiobookExportMessage(path: string): string {
  if (path.startsWith('content://')) {
    return 'Exported bundle to the selected file.'
  }
  return 'Exported bundle to ' + path
}
