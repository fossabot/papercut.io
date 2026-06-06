import { useCallback, useEffect, useRef, useState } from 'react'
import {
  getNativeSavedAudiobookChunk,
  getNativeTtsCapabilities,
  resetNativeTtsCapabilities,
} from '../api/nativeTts'
import { logTtsDiagnostic } from '../diagnostics/TtsDiagnostics'
import {
  KOKORO_VOICES,
  type KokoroTtsOptions,
  type KokoroVoiceInfo,
  type TtsChunk,
} from '../types'

type TtsStatus = 'idle' | 'loading' | 'playing' | 'paused' | 'error'

interface QueuedAudio {
  index: number
  chunkId: string
  text: string
  url: string
}

interface LoadedAudio {
  index: number
  chunkId: string
  text: string
  wav: ArrayBuffer
}

interface PreloadTarget {
  anchorIndex: number
  jobId: number
  navigationIntent: number
}

export interface TtsChunkSummary {
  index: number
  chunkId: string
  textPreview: string
}

export interface TtsPlayerState {
  status: TtsStatus
  message: string
  progress?: number
  chunksGenerated: number
  chunksPlayed: number
  chunksTotal: number
  currentText: string
  currentChunkIndex: number | null
  pendingChunkIndex: number | null
  currentChunkId: string | null
  currentChunkProgress: number
  currentChunkTime: number
  currentChunkDuration: number
  chunkSummaries: TtsChunkSummary[]
  chunkTexts: string[]
  voices: KokoroVoiceInfo[]
}

const DEFAULT_VOICES = Object.entries(KOKORO_VOICES).map(([id, name]) => ({
  id,
  name,
})) as KokoroVoiceInfo[]

const EMPTY_PLAYBACK_STATE = {
  currentText: '',
  currentChunkIndex: null,
  pendingChunkIndex: null,
  currentChunkId: null,
  currentChunkProgress: 0,
  currentChunkTime: 0,
  currentChunkDuration: 0,
} satisfies Pick<
  TtsPlayerState,
  | 'currentText'
  | 'currentChunkIndex'
  | 'pendingChunkIndex'
  | 'currentChunkId'
  | 'currentChunkProgress'
  | 'currentChunkTime'
  | 'currentChunkDuration'
>

export function useTtsPlayer() {
  const [state, setState] = useState<TtsPlayerState>({
    status: 'idle',
    message: '',
    chunksGenerated: 0,
    chunksPlayed: 0,
    chunksTotal: 0,
    ...EMPTY_PLAYBACK_STATE,
    chunkSummaries: [],
    chunkTexts: [],
    voices: DEFAULT_VOICES,
  })

  const audioRef = useRef<HTMLAudioElement | null>(null)
  const audioByIndexRef = useRef(new Map<number, QueuedAudio>())
  const loadedIndexesRef = useRef(new Set<number>())
  const loadingByIndexRef = useRef(new Map<number, Promise<LoadedAudio | null>>())
  const chunksRef = useRef<TtsChunk[]>([])
  const optionsRef = useRef<KokoroTtsOptions | null>(null)
  const jobIdRef = useRef(0)
  const nextPlayIndexRef = useRef(0)
  const currentPlayingIndexRef = useRef<number | null>(null)
  const totalChunksRef = useRef(0)
  const pausedRef = useRef(false)
  const playingRef = useRef(false)
  const playbackAttemptRef = useRef(0)
  const navigationIntentRef = useRef(0)
  const navigationInFlightRef = useRef(false)
  const navigationFrameRef = useRef<number | null>(null)
  const queuedTargetIndexRef = useRef<number | null>(null)
  const pendingTargetIndexRef = useRef<number | null>(null)
  const preloadTargetRef = useRef<PreloadTarget | null>(null)
  const preloadInFlightRef = useRef(false)

  const revokeAudioUrls = useCallback(() => {
    for (const item of audioByIndexRef.current.values()) {
      URL.revokeObjectURL(item.url)
    }
    audioByIndexRef.current.clear()
    loadedIndexesRef.current.clear()
    loadingByIndexRef.current.clear()
  }, [])

  const finishPlayback = useCallback(() => {
    playingRef.current = false
    currentPlayingIndexRef.current = null
    navigationInFlightRef.current = false
    queuedTargetIndexRef.current = null
    pendingTargetIndexRef.current = null
    preloadTargetRef.current = null
    setState((prev) => ({
      ...prev,
      status: 'idle',
      message: '',
      ...EMPTY_PLAYBACK_STATE,
    }))
  }, [])

  const playIndex = useCallback((index: number) => {
    const audio = audioRef.current
    if (!audio || pausedRef.current) return false

    if (index >= totalChunksRef.current) {
      nextPlayIndexRef.current = totalChunksRef.current
      finishPlayback()
      return true
    }

    const item = audioByIndexRef.current.get(index)
    if (!item) {
      nextPlayIndexRef.current = index
      playingRef.current = false
      setState((prev) => ({
        ...prev,
        status: 'loading',
        message: 'Loading chunk ' + (index + 1) + '/' + totalChunksRef.current,
      }))
      return false
    }

    const playJobId = jobIdRef.current
    const playAttemptId = playbackAttemptRef.current + 1
    playbackAttemptRef.current = playAttemptId

    nextPlayIndexRef.current = index + 1
    currentPlayingIndexRef.current = index
    playingRef.current = true
    audio.src = item.url
    audio.currentTime = 0

    setState((prev) => ({
      ...prev,
      status: 'playing',
      message: '',
      chunksPlayed: index,
      currentText: item.text,
      currentChunkIndex: item.index,
      pendingChunkIndex: null,
      currentChunkId: item.chunkId,
      currentChunkProgress: 0,
      currentChunkTime: 0,
      currentChunkDuration: Number.isFinite(audio.duration) ? audio.duration : 0,
    }))

    audio.play().catch((err: unknown) => {
      // Rapid skip/jump actions intentionally replace the audio source. Browsers
      // reject the superseded play() promise; ignore it unless it is still the
      // newest playback attempt for the current job and chunk.
      if (jobIdRef.current !== playJobId) return
      if (playbackAttemptRef.current !== playAttemptId) return
      if (currentPlayingIndexRef.current !== index) return
      if (pausedRef.current) return

      if (isTransientPlaybackInterruption(err)) {
        playingRef.current = false
        setState((prev) => ({
          ...prev,
          status: 'loading',
          message: 'Switching audiobook chunk',
        }))
        return
      }

      pausedRef.current = true
      playingRef.current = false
      setState((prev) => ({
        ...prev,
        status: 'error',
        message: err instanceof Error ? err.message : String(err),
      }))
    })

    return true
  }, [finishPlayback])

  const pruneAudioWindow = useCallback((anchorIndex: number) => {
    const min = Math.max(anchorIndex - 2, 0)
    const max = Math.min(anchorIndex + 4, Math.max(totalChunksRef.current - 1, 0))

    for (const item of audioByIndexRef.current.values()) {
      if (item.index >= min && item.index <= max) continue
      if (item.index === currentPlayingIndexRef.current) continue
      URL.revokeObjectURL(item.url)
      audioByIndexRef.current.delete(item.index)
    }
  }, [])

  const enqueueAudio = useCallback((item: QueuedAudio) => {
    const previous = audioByIndexRef.current.get(item.index)
    if (previous && previous.url !== item.url) URL.revokeObjectURL(previous.url)

    audioByIndexRef.current.set(item.index, item)
    loadedIndexesRef.current.add(item.index)
    setState((prev) => ({
      ...prev,
      chunksGenerated: loadedIndexesRef.current.size,
    }))
  }, [])

  const loadChunk = useCallback(async (
    index: number,
    jobId: number,
    shouldAccept: () => boolean,
  ): Promise<boolean> => {
    const chunks = chunksRef.current
    const options = optionsRef.current
    if (audioByIndexRef.current.has(index)) return true
    if (!options || index < 0 || index >= chunks.length) return false

    let promise = loadingByIndexRef.current.get(index)
    if (!promise) {
      const chunk = chunks[index]
      if (!options.documentUrl) throw new Error('Saved audiobook playback requires a document URL')

      promise = getNativeSavedAudiobookChunk(options.documentUrl, chunk, index, options).then((nativeSaved) => {
        if (!nativeSaved) return null
        return {
          index,
          chunkId: chunk.id,
          text: chunk.text,
          wav: nativeSaved.wav,
        }
      })
      loadingByIndexRef.current.set(index, promise)
      const clearLoading = () => {
        if (loadingByIndexRef.current.get(index) === promise) {
          loadingByIndexRef.current.delete(index)
        }
      }
      void promise.then(clearLoading, clearLoading)
    }

    const loaded = await promise
    if (jobIdRef.current !== jobId || !shouldAccept()) return false
    if (!loaded) {
      throw new Error('Saved audiobook chunk missing. Save this audiobook before playback.')
    }
    if (audioByIndexRef.current.has(index)) return true

    enqueueAudio({
      index: loaded.index,
      chunkId: loaded.chunkId,
      text: loaded.text,
      url: URL.createObjectURL(new Blob([loaded.wav], { type: 'audio/wav' })),
    })
    return true
  }, [enqueueAudio])

  const runPreloadWorker = useCallback(async () => {
    if (preloadInFlightRef.current) return
    preloadInFlightRef.current = true

    try {
      while (preloadTargetRef.current) {
        const target = preloadTargetRef.current
        preloadTargetRef.current = null

        for (let offset = 1; offset <= 2; offset++) {
          const index = target.anchorIndex + offset
          const isCurrentTarget = () => (
            jobIdRef.current === target.jobId &&
            navigationIntentRef.current === target.navigationIntent
          )
          if (index >= totalChunksRef.current || !isCurrentTarget()) break
          try {
            await loadChunk(index, target.jobId, isCurrentTarget)
          } catch {
            break
          }
        }
      }
    } finally {
      preloadInFlightRef.current = false
    }
  }, [loadChunk])

  const preloadAround = useCallback((
    anchorIndex: number,
    jobId: number,
    navigationIntent: number,
  ) => {
    preloadTargetRef.current = { anchorIndex, jobId, navigationIntent }
    void runPreloadWorker()
  }, [runPreloadWorker])

  const clampChunkIndex = useCallback((index: number) => Math.min(
    Math.max(index, 0),
    Math.max(totalChunksRef.current - 1, 0),
  ), [])

  // Android WebView can deliver touch skips faster than audio.pause(), src
  // changes, and audio.play() promises settle. Keep one foreground loader and
  // commit a target only if it is still the newest navigation intent.
  const runNavigationWorker = useCallback(async () => {
    if (navigationInFlightRef.current || totalChunksRef.current === 0) return
    navigationInFlightRef.current = true

    try {
      while (queuedTargetIndexRef.current !== null && totalChunksRef.current > 0) {
        const targetIndex = queuedTargetIndexRef.current
        queuedTargetIndexRef.current = null

        const audio = audioRef.current
        if (!audio) return

        const jobId = jobIdRef.current
        const navigationIntent = navigationIntentRef.current
        pendingTargetIndexRef.current = targetIndex

        pausedRef.current = false
        playingRef.current = false
        playbackAttemptRef.current += 1
        audio.pause()
        nextPlayIndexRef.current = targetIndex

        setState((prev) => ({
          ...prev,
          status: 'loading',
          message: 'Loading chunk ' + (targetIndex + 1) + '/' + totalChunksRef.current,
          pendingChunkIndex: targetIndex,
          currentChunkProgress: 0,
          currentChunkTime: 0,
          currentChunkDuration: 0,
        }))

        const isCurrentTarget = () => (
          jobIdRef.current === jobId &&
          navigationIntentRef.current === navigationIntent &&
          !pausedRef.current
        )
        const loaded = await loadChunk(targetIndex, jobId, isCurrentTarget)
        if (!loaded || !isCurrentTarget()) continue

        pruneAudioWindow(targetIndex)
        const didStart = playIndex(targetIndex)
        if (navigationIntentRef.current === navigationIntent) {
          pendingTargetIndexRef.current = didStart ? null : targetIndex
        }
        if (didStart) preloadAround(targetIndex, jobId, navigationIntent)
      }
    } finally {
      navigationInFlightRef.current = false
    }
  }, [loadChunk, playIndex, preloadAround, pruneAudioWindow])

  const startPlaybackAt = useCallback((index: number) => {
    if (totalChunksRef.current === 0) return
    queuedTargetIndexRef.current = clampChunkIndex(index)
    navigationIntentRef.current += 1
    preloadTargetRef.current = null

    if (navigationInFlightRef.current || navigationFrameRef.current !== null) return
    navigationFrameRef.current = window.requestAnimationFrame(() => {
      navigationFrameRef.current = null
      void runNavigationWorker().catch((err: unknown) => {
        pausedRef.current = false
        playingRef.current = false
        setState((prev) => ({
          ...prev,
          status: 'error',
          message: err instanceof Error ? err.message : String(err),
        }))
      })
    })
  }, [clampChunkIndex, runNavigationWorker])

  useEffect(() => {
    const audio = new Audio()
    audio.preload = 'auto'
    audioRef.current = audio

    const updateProgress = () => {
      const duration = Number.isFinite(audio.duration) ? audio.duration : 0
      const currentTime = Number.isFinite(audio.currentTime) ? audio.currentTime : 0
      setState((prev) => ({
        ...prev,
        currentChunkTime: currentTime,
        currentChunkDuration: duration,
        currentChunkProgress: duration > 0 ? Math.min(currentTime / duration, 1) : 0,
      }))
    }

    const handleEnded = () => {
      const finishedIndex = currentPlayingIndexRef.current
      setState((prev) => ({
        ...prev,
        chunksPlayed: finishedIndex === null
          ? prev.chunksPlayed + 1
          : Math.max(prev.chunksPlayed, finishedIndex + 1),
        currentChunkProgress: 1,
      }))
      const nextIndex = (finishedIndex ?? nextPlayIndexRef.current - 1) + 1
      if (nextIndex >= totalChunksRef.current) {
        finishPlayback()
        return
      }
      void startPlaybackAt(nextIndex)
    }

    audio.addEventListener('timeupdate', updateProgress)
    audio.addEventListener('durationchange', updateProgress)
    audio.addEventListener('loadedmetadata', updateProgress)
    audio.addEventListener('ended', handleEnded)
    return () => {
      audio.pause()
      audio.removeEventListener('timeupdate', updateProgress)
      audio.removeEventListener('durationchange', updateProgress)
      audio.removeEventListener('loadedmetadata', updateProgress)
      audio.removeEventListener('ended', handleEnded)
      if (navigationFrameRef.current !== null) {
        window.cancelAnimationFrame(navigationFrameRef.current)
        navigationFrameRef.current = null
      }
      audioRef.current = null
      revokeAudioUrls()
    }
  }, [finishPlayback, revokeAudioUrls, startPlaybackAt])

  const preload = useCallback(() => {
    setState((prev) => (prev.status === 'idle'
      ? {
        ...prev,
        status: 'loading',
        message: 'Checking native TTS',
        progress: undefined,
      }
      : prev))

    void getNativeTtsCapabilities().then((capabilities) => {
      logTtsDiagnostic('[tts-native] capabilities', { ...capabilities })
      setState((prev) => ({
        ...prev,
        status: prev.status === 'loading' ? (capabilities.available ? 'idle' : 'error') : prev.status,
        message: prev.status === 'loading' ? (capabilities.available ? '' : capabilities.reason) : prev.message,
      }))
    })
  }, [])

  const speak = useCallback((chunks: TtsChunk[], options: KokoroTtsOptions) => {
    const speakableChunks = chunks.filter((chunk) => chunk.text.trim())
    if (speakableChunks.length === 0) return

    const nextJobId = jobIdRef.current + 1
    jobIdRef.current = nextJobId
    nextPlayIndexRef.current = 0
    currentPlayingIndexRef.current = null
    totalChunksRef.current = speakableChunks.length
    pausedRef.current = false
    playingRef.current = false
    playbackAttemptRef.current += 1
    navigationIntentRef.current += 1
    if (navigationFrameRef.current !== null) {
      window.cancelAnimationFrame(navigationFrameRef.current)
      navigationFrameRef.current = null
    }
    queuedTargetIndexRef.current = null
    pendingTargetIndexRef.current = null
    preloadTargetRef.current = null
    chunksRef.current = speakableChunks
    optionsRef.current = options
    audioRef.current?.pause()
    revokeAudioUrls()

    setState((prev) => ({
      ...prev,
      status: 'loading',
      message: 'Checking saved audio',
      progress: undefined,
      chunksGenerated: 0,
      chunksPlayed: 0,
      chunksTotal: speakableChunks.length,
      chunkSummaries: speakableChunks.map((chunk, index) => ({
        index,
        chunkId: chunk.id,
        textPreview: textPreview(chunk.text),
      })),
      chunkTexts: speakableChunks.map((chunk) => chunk.text),
      ...EMPTY_PLAYBACK_STATE,
    }))

    if (jobIdRef.current === nextJobId) startPlaybackAt(0)
  }, [revokeAudioUrls, startPlaybackAt])

  const pause = useCallback(() => {
    pausedRef.current = true
    playingRef.current = false
    playbackAttemptRef.current += 1
    audioRef.current?.pause()
    setState((prev) => ({ ...prev, status: 'paused' }))
  }, [])

  const resume = useCallback(() => {
    pausedRef.current = false
    const audio = audioRef.current
    if (audio?.src && !audio.ended) {
      audio.play()
        .then(() => {
          playingRef.current = true
          setState((prev) => ({ ...prev, status: 'playing' }))
        })
        .catch((err: unknown) => {
          setState((prev) => ({
            ...prev,
            status: 'error',
            message: err instanceof Error ? err.message : String(err),
          }))
        })
      return
    }
    void startPlaybackAt(nextPlayIndexRef.current)
  }, [startPlaybackAt])

  const skipByChunks = useCallback((delta: number) => {
    if (totalChunksRef.current === 0) return

    const currentIndex = queuedTargetIndexRef.current ?? pendingTargetIndexRef.current ?? currentPlayingIndexRef.current ?? Math.max(nextPlayIndexRef.current - 1, 0)
    const targetIndex = Math.min(
      Math.max(currentIndex + delta, 0),
      Math.max(totalChunksRef.current - 1, 0),
    )

    pausedRef.current = false
    startPlaybackAt(targetIndex)
  }, [startPlaybackAt])

  const jumpToChunk = useCallback((index: number) => {
    if (totalChunksRef.current === 0) return
    startPlaybackAt(index)
  }, [startPlaybackAt])

  const stop = useCallback(() => {
    jobIdRef.current += 1
    nextPlayIndexRef.current = 0
    currentPlayingIndexRef.current = null
    totalChunksRef.current = 0
    pausedRef.current = false
    playingRef.current = false
    playbackAttemptRef.current += 1
    navigationIntentRef.current += 1
    if (navigationFrameRef.current !== null) {
      window.cancelAnimationFrame(navigationFrameRef.current)
      navigationFrameRef.current = null
    }
    queuedTargetIndexRef.current = null
    pendingTargetIndexRef.current = null
    preloadTargetRef.current = null
    chunksRef.current = []
    optionsRef.current = null
    audioRef.current?.pause()
    revokeAudioUrls()
    setState((prev) => ({
      ...prev,
      status: 'idle',
      message: '',
      progress: undefined,
      chunksGenerated: 0,
      chunksPlayed: 0,
      chunksTotal: 0,
      chunkSummaries: [],
      chunkTexts: [],
      ...EMPTY_PLAYBACK_STATE,
    }))
  }, [revokeAudioUrls])

  return {
    state,
    preload,
    speak,
    pause,
    resume,
    jumpToChunk,
    skipBackward: () => skipByChunks(-1),
    skipForward: () => skipByChunks(1),
    stop,
    resetNativeTtsCapabilities,
  }
}

function isTransientPlaybackInterruption(err: unknown): boolean {
  // Mobile browsers reject play() with AbortError/interruption messages when a
  // user quickly replaces the audio source. Those are navigation noise, not a
  // real TTS failure, so they should not collapse the floating controls.
  if (!(err instanceof Error)) return false
  const name = err.name.toLowerCase()
  const message = err.message.toLowerCase()
  return name === 'aborterror' ||
    message.includes('interrupted') ||
    message.includes('new load request') ||
    message.includes('pause')
}

function textPreview(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (normalized.length <= 96) return normalized
  return normalized.slice(0, 95).trimEnd() + '...'
}
