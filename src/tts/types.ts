export const KOKORO_MODEL_ID = 'sherpa-onnx/kokoro-multi-lang-v1_0'
export const KOKORO_AUDIO_CACHE_VERSION = 'native-save-v3-360-sanitized'
export const KOKORO_MODEL_DTYPE = 'native'
export const KOKORO_DEFAULT_VOICE = 'af_heart'
export const KOKORO_DEFAULT_SPEED = 1
export const KOKORO_DEFAULT_THREAD_COUNT = 1

export const KOKORO_VOICES = {
  af_heart: 'Heart',
  af_bella: 'Bella',
  af_nicole: 'Nicole',
  af_sarah: 'Sarah',
  af_sky: 'Sky',
  af_nova: 'Nova',
  af_alloy: 'Alloy',
  af_aoede: 'Aoede',
  af_kore: 'Kore',
  af_jessica: 'Jessica',
  af_river: 'River',
  am_fenrir: 'Fenrir',
  am_michael: 'Michael',
  am_puck: 'Puck',
  am_liam: 'Liam',
  am_onyx: 'Onyx',
  am_echo: 'Echo',
  am_eric: 'Eric',
  am_santa: 'Santa',
  bf_emma: 'Emma',
  bf_isabella: 'Isabella',
  bf_alice: 'Alice',
  bf_lily: 'Lily',
  bm_george: 'George',
  bm_lewis: 'Lewis',
  bm_daniel: 'Daniel',
  bm_fable: 'Fable',
} as const

export type KokoroVoice = keyof typeof KOKORO_VOICES
export type KokoroDtype = 'native'

export interface KokoroTtsOptions {
  voice: KokoroVoice
  speed: number
  dtype?: KokoroDtype
  threadCount?: number
  documentUrl?: string
  title?: string
}

export function resolveKokoroDtype(options: Pick<KokoroTtsOptions, 'dtype'>): KokoroDtype {
  return options.dtype ?? KOKORO_MODEL_DTYPE
}

export interface TtsChunk {
  id: string
  text: string
  textHash?: string
}

export interface KokoroVoiceInfo {
  id: KokoroVoice
  name: string
}
