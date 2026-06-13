import {
  KOKORO_DEFAULT_SPEED,
  KOKORO_DEFAULT_VOICE,
  KOKORO_MODEL_DTYPE,
  KOKORO_VOICES,
  type KokoroDtype,
  type KokoroVoice,
} from '../types'

// Durable UI preferences for the offline audio experience. These are separate
// from generated audio so clearing the cache does not reset user choices.
const STORAGE_KEY = 'papercut.audioPreferences.v1'

export interface AudioPreferences {
  voice: KokoroVoice
  speed: number
  dtype: KokoroDtype
  audioSavedOnly: boolean
}

export const DEFAULT_AUDIO_PREFERENCES: AudioPreferences = {
  voice: KOKORO_DEFAULT_VOICE,
  speed: KOKORO_DEFAULT_SPEED,
  dtype: KOKORO_MODEL_DTYPE,
  audioSavedOnly: false,
}

export function getAudioPreferences(): AudioPreferences {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_AUDIO_PREFERENCES

    const parsed = JSON.parse(raw) as Partial<AudioPreferences>
    return {
      voice: isKokoroVoice(parsed.voice) ? parsed.voice : DEFAULT_AUDIO_PREFERENCES.voice,
      speed: isValidSpeed(parsed.speed) ? parsed.speed : DEFAULT_AUDIO_PREFERENCES.speed,
      dtype: parsed.dtype === KOKORO_MODEL_DTYPE ? parsed.dtype : DEFAULT_AUDIO_PREFERENCES.dtype,
      audioSavedOnly: typeof parsed.audioSavedOnly === 'boolean'
        ? parsed.audioSavedOnly
        : DEFAULT_AUDIO_PREFERENCES.audioSavedOnly,
    }
  } catch {
    return DEFAULT_AUDIO_PREFERENCES
  }
}

export function saveAudioPreferences(preferences: Partial<AudioPreferences>): void {
  try {
    const next = {
      ...getAudioPreferences(),
      ...preferences,
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    // Preferences are nice-to-have; audio generation should still work if storage is unavailable.
  }
}

function isKokoroVoice(value: unknown): value is KokoroVoice {
  return typeof value === 'string' && value in KOKORO_VOICES
}

function isValidSpeed(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}
