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
  currentChunkId: string | null
  currentChunkProgress: number
  currentChunkTime: number
  currentChunkDuration: number
  chunkSummaries: TtsChunkSummary[]
  voices: KokoroVoiceInfo[]
}

const DEFAULT_VOICES = Object.entries(KOKORO_VOICES).map(([id, name]) => ({
  id,
  name,
})) as KokoroVoiceInfo[]

const EMPTY_PLAYBACK_STATE = {
  currentText: '',
  currentChunkIndex: null,
  currentChunkId: null,
  currentChunkProgress: 0,
  currentChunkTime: 0,
  currentChunkDuration: 0,
} satisfies Pick<
  TtsPlayerState,
  | 'currentText'
  | 'currentChunkIndex'
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
    voices: DEFAULT_VOICES,
  })

  const audioRef = useRef<HTMLAudioElement | null>(null)
  const audioByIndexRef = useRef(new Map<number, QueuedAudio>())
  const loadedIndexesRef = useRef(new Set<number>())
  const loadingByIndexRef = useRef(new Map<number, Promise<void>>())
  const chunksRef = useRef<TtsChunk[]>([])
  const optionsRef = useRef<KokoroTtsOptions | null>(null)
  const jobIdRef = useRef(0)
  const nextPlayIndexRef = useRef(0)
  const currentPlayingIndexRef = useRef<number | null>(null)
  const totalChunksRef = useRef(0)
  const pausedRef = useRef(false)
  const playingRef = useRef(false)
  const playbackAttemptRef = useRef(0)
  const navigationRequestRef = useRef(0)
  const navigationInFlightRef = useRef(false)
  const queuedTargetIndexRef = useRef<number | null>(null)
  const pendingTargetIndexRef = useRef<number | null>(null)

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

  const loadChunk = useCallback(async (index: number, jobId: number): Promise<void> => {
    const chunks = chunksRef.current
    const options = optionsRef.current
    if (audioByIndexRef.current.has(index)) return
    if (!options || index < 0 || index >= chunks.length) return

    const existing = loadingByIndexRef.current.get(index)
    if (existing) {
      await existing
      return
    }

    const promise = (async () => {
      const chunk = chunks[index]
      setState((prev) => ({
        ...prev,
        status: playingRef.current ? prev.status : 'loading',
        message: playingRef.current ? prev.message : 'Loading chunk ' + (index + 1) + '/' + chunks.length,
      }))

      if (!options.documentUrl) throw new Error('Saved audiobook playback requires a document URL')

      const nativeSaved = await getNativeSavedAudiobookChunk(options.documentUrl, chunk, index, options)
      if (jobIdRef.current !== jobId) return

      if (!nativeSaved) {
        throw new Error('Saved audiobook chunk missing. Save this audiobook before playback.')
      }

      enqueueAudio({
        index,
        chunkId: chunk.id,
        text: chunk.text,
        url: URL.createObjectURL(new Blob([nativeSaved.wav], { type: 'audio/wav' })),
      })
    })().finally(() => {
      loadingByIndexRef.current.delete(index)
    })

    loadingByIndexRef.current.set(index, promise)
    await promise
  }, [enqueueAudio])

  const preloadAround = useCallback((anchorIndex: number, jobId: number) => {
    for (let offset = 1; offset <= 2; offset++) {
      const index = anchorIndex + offset
      if (index < totalChunksRef.current) void loadChunk(index, jobId)
    }
  }, [loadChunk])

  const clampChunkIndex = useCallback((index: number) => Math.min(
    Math.max(index, 0),
    Math.max(totalChunksRef.current - 1, 0),
  ), [])

  // Android WebView can deliver touch skips faster than audio.pause(), src
  // changes, and audio.play() promises settle. This queue keeps exactly one
  // navigation worker alive and lets rapid taps update the latest target chunk.
  const startPlaybackAt = useCallback(async (index: number) => {
    if (totalChunksRef.current === 0) return
    queuedTargetIndexRef.current = clampChunkIndex(index)

    if (navigationInFlightRef.current) return
    navigationInFlightRef.current = true

    try {
      while (queuedTargetIndexRef.current !== null && totalChunksRef.current > 0) {
        const targetIndex = queuedTargetIndexRef.current
        queuedTargetIndexRef.current = null

        const audio = audioRef.current
        if (!audio) return

        const jobId = jobIdRef.current
        const requestId = navigationRequestRef.current + 1
        navigationRequestRef.current = requestId
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
          chunksPlayed: targetIndex,
          currentChunkIndex: targetIndex,
          currentChunkProgress: 0,
          currentChunkTime: 0,
          currentChunkDuration: 0,
        }))

        await loadChunk(targetIndex, jobId)
        if (jobIdRef.current !== jobId || navigationRequestRef.current !== requestId || pausedRef.current) continue

        pruneAudioWindow(targetIndex)
        const didStart = playIndex(targetIndex)
        if (navigationRequestRef.current === requestId) {
          pendingTargetIndexRef.current = didStart ? null : targetIndex
        }
        if (didStart) preloadAround(targetIndex, jobId)
      }
    } finally {
      navigationInFlightRef.current = false
    }
  }, [clampChunkIndex, loadChunk, playIndex, preloadAround, pruneAudioWindow])

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
    navigationRequestRef.current += 1
    navigationInFlightRef.current = false
    queuedTargetIndexRef.current = null
    pendingTargetIndexRef.current = null
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
      ...EMPTY_PLAYBACK_STATE,
    }))

    void (async () => {
      try {
        if (jobIdRef.current !== nextJobId) return

        await startPlaybackAt(0)
      } catch (err) {
        if (jobIdRef.current !== nextJobId) return
        pausedRef.current = false
        playingRef.current = false
        setState((prev) => ({
          ...prev,
          status: 'error',
          message: err instanceof Error ? err.message : String(err),
        }))
      }
    })()
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
    queuedTargetIndexRef.current = targetIndex
    void startPlaybackAt(targetIndex)
  }, [startPlaybackAt])

  const jumpToChunk = useCallback((index: number) => {
    if (totalChunksRef.current === 0) return
    void startPlaybackAt(index)
  }, [startPlaybackAt])

  const stop = useCallback(() => {
    jobIdRef.current += 1
    nextPlayIndexRef.current = 0
    currentPlayingIndexRef.current = null
    totalChunksRef.current = 0
    pausedRef.current = false
    playingRef.current = false
    playbackAttemptRef.current += 1
    navigationRequestRef.current += 1
    navigationInFlightRef.current = false
    queuedTargetIndexRef.current = null
    pendingTargetIndexRef.current = null
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
