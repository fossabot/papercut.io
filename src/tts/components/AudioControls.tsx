import { useEffect, useRef, useState } from 'react'
import type { AudiobookCacheState } from '../hooks/useAudiobookCache'
import type { TtsPlayerState } from '../hooks/useTtsPlayer'

interface AudioControlsProps {
  audiobookState: AudiobookCacheState
  canPlayAudiobook: boolean
  canSaveAudiobook: boolean
  canSkipBackward: boolean
  canSkipForward: boolean
  isPdf: boolean
  saveInProgress: boolean
  onCancelSave: () => void
  onPause: () => void
  onRead: () => void
  onResume: () => void
  onJumpToChunk: (index: number) => void
  onSave: () => void
  onSkipBackward: () => void
  onSkipForward: () => void
  onStop: () => void
  playbackDurationSec?: number
  ttsState: TtsPlayerState
}

type AudioIconName = 'play' | 'pause' | 'resume' | 'stop' | 'back' | 'forward' | 'save' | 'menu'

export function AudioControls({
  audiobookState,
  canPlayAudiobook,
  canSaveAudiobook,
  canSkipBackward,
  canSkipForward,
  isPdf,
  saveInProgress,
  onCancelSave,
  onPause,
  onRead,
  onResume,
  onJumpToChunk,
  onSave,
  onSkipBackward,
  onSkipForward,
  onStop,
  playbackDurationSec,
  ttsState,
}: AudioControlsProps) {
  const [chunkMenuOpen, setChunkMenuOpen] = useState(false)
  const currentChunkButtonRef = useRef<HTMLButtonElement | null>(null)
  const isActive = ttsState.status === 'playing' ||
    ttsState.status === 'loading'
  const isPaused = ttsState.status === 'paused'
  const showFloatingPlayback = isActive || isPaused
  const isPreparingSave = saveInProgress && audiobookState.status === 'checking'
  const isSaving = saveInProgress && audiobookState.status === 'saving'
  const audiobookPercent = audiobookState.totalChunks > 0
    ? Math.round((audiobookState.cachedChunks / audiobookState.totalChunks) * 100)
    : 0
  const visibleChunkIndex = ttsState.pendingChunkIndex ?? ttsState.currentChunkIndex
  const currentChunkNumber = visibleChunkIndex === null
    ? Math.min(ttsState.chunksPlayed + 1, ttsState.chunksTotal)
    : visibleChunkIndex + 1
  const chunkTotal = ttsState.chunksTotal || Math.max(ttsState.chunksGenerated, ttsState.chunksPlayed)
  const chunkPercent = Math.round(ttsState.currentChunkProgress * 100)
  const showChunkMenuButton = showFloatingPlayback && ttsState.chunkSummaries.length > 1
  const showPlaybackStatus = ttsState.status !== 'idle'

  useEffect(() => {
    if (!chunkMenuOpen) return
    currentChunkButtonRef.current?.scrollIntoView({ block: 'center' })
  }, [chunkMenuOpen, ttsState.currentChunkIndex])

  return (
    <section className="audio-controls" aria-label="Audiobook controls">
      <div className="audio-compact-row">
        {!showFloatingPlayback && canPlayAudiobook && (
          <button className="audio-icon-btn audio-primary-btn" onClick={onRead} aria-label="Play saved audiobook" title="Play saved audiobook">
            <AudioIcon name="play" />
          </button>
        )}
        {!isPdf && renderSaveButton()}
      </div>

      {showChunkMenuButton && chunkMenuOpen && (
        <div className="audio-chunk-menu" aria-label="Audiobook chunk list">
          <div className="audio-chunk-menu-header">
            <span>Chapters</span>
            <span>{ttsState.chunkSummaries.length} chunks</span>
          </div>
          <div className="audio-chunk-list">
            {ttsState.chunkSummaries.map((chunk) => {
              const isCurrent = chunk.index === ttsState.currentChunkIndex
              const estimatedStart = estimateChunkStart(chunk.index, ttsState.chunksTotal, playbackDurationSec)
              return (
                <button
                  key={chunk.chunkId}
                  ref={isCurrent ? currentChunkButtonRef : null}
                  className={'audio-chunk-item' + (isCurrent ? ' audio-chunk-item-current' : '')}
                  onClick={() => {
                    setChunkMenuOpen(false)
                    onJumpToChunk(chunk.index)
                  }}
                  title={chunk.textPreview}
                >
                  <span className="audio-chunk-time">{estimatedStart === null ? '--:--' : formatTtsTime(estimatedStart)}</span>
                  <span className="audio-chunk-text">{chunk.textPreview}</span>
                  <span className="audio-chunk-number">{chunk.index + 1}</span>
                </button>
              )
            })}
          </div>
        </div>
      )}

      {showFloatingPlayback && (
        <div className="audio-floating-playback" aria-label="Playback controls">
          <button className="audio-icon-btn" onClick={onSkipBackward} disabled={!canSkipBackward} aria-label="Previous audiobook chunk" title="Previous chunk">
            <AudioIcon name="back" />
          </button>
          {isPaused ? (
            <button className="audio-icon-btn audio-primary-btn" onClick={onResume} aria-label="Resume audiobook" title="Resume">
              <AudioIcon name="resume" />
            </button>
          ) : (
            <button className="audio-icon-btn audio-primary-btn" onClick={onPause} disabled={ttsState.status === 'loading'} aria-label="Pause audiobook" title="Pause">
              <AudioIcon name="pause" />
            </button>
          )}
          <button className="audio-icon-btn" onClick={onSkipForward} disabled={!canSkipForward} aria-label="Next audiobook chunk" title="Next chunk">
            <AudioIcon name="forward" />
          </button>
          {showChunkMenuButton && (
            <button
              className={'audio-icon-btn audio-menu-btn' + (chunkMenuOpen ? ' audio-menu-btn-open' : '')}
              onClick={() => setChunkMenuOpen((value) => !value)}
              aria-label={chunkMenuOpen ? 'Hide audiobook chunk list' : 'Show audiobook chunk list'}
              aria-expanded={chunkMenuOpen}
              title="Jump to chunk"
            >
              <AudioIcon name="menu" />
            </button>
          )}
          <button className="audio-icon-btn" onClick={onStop} aria-label="Stop audiobook" title="Stop">
            <AudioIcon name="stop" />
          </button>
          {showPlaybackStatus && (
            <div className={'audio-floating-status tts-status-' + ttsState.status}>
              <span>{ttsState.status === 'error' ? ttsState.message : 'Chunk ' + (currentChunkNumber || 0) + '/' + chunkTotal}</span>
              {ttsState.status !== 'error' && ttsState.currentChunkDuration > 0 && (
                <span>{formatTtsTime(ttsState.currentChunkTime)} / {formatTtsTime(ttsState.currentChunkDuration)}</span>
              )}
              {ttsState.status !== 'error' && (
                <div className="tts-meter" aria-label={'Current chunk ' + chunkPercent + '% complete'}>
                  <span style={{ width: chunkPercent + '%' }} />
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  )

  function renderSaveButton() {
    if (isPreparingSave) {
      return (
        <button className="audio-icon-btn" disabled aria-label="Preparing audiobook save" title="Preparing audiobook save">
          <AudioIcon name="save" />
        </button>
      )
    }

    if (isSaving) {
      return (
        <button className="audio-icon-btn" onClick={onCancelSave} aria-label={'Pause audiobook save at ' + audiobookPercent + '%'} title={'Saving ' + audiobookPercent + '%'}>
          <span className="spinner audio-save-spinner" />
        </button>
      )
    }

    return (
      <button
        className={'audio-icon-btn' + (audiobookState.complete ? ' audio-save-complete' : '')}
        onClick={onSave}
        disabled={!canSaveAudiobook || audiobookState.complete}
        aria-label={audiobookState.complete ? 'Audiobook saved for this voice and speed' : 'Save audiobook'}
        title={audiobookState.complete ? 'Audiobook saved for this voice and speed' : 'Save audiobook'}
      >
        <AudioIcon name="save" />
      </button>
    )
  }
}

function AudioIcon({ name }: { name: AudioIconName }) {
  return (
    <svg className="audio-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {renderIconPath(name)}
    </svg>
  )
}

function renderIconPath(name: AudioIconName) {
  switch (name) {
    case 'play':
    case 'resume':
      return <path d="M8 5v14l11-7z" />
    case 'pause':
      return <path d="M7 5h4v14H7zm6 0h4v14h-4z" />
    case 'stop':
      return <path d="M7 7h10v10H7z" />
    case 'back':
      return <path d="M11 6v12l-8.5-6zm10 0v12l-8.5-6z" />
    case 'forward':
      return <path d="M13 6v12l8.5-6zM3 6v12l8.5-6z" />
    case 'save':
      return <path d="M5 3h12l2 2v16H5zM8 3v6h8V3M8 18h8v-5H8z" fill="none" stroke="currentcolor" strokeWidth="2" strokeLinejoin="round" />
    case 'menu':
      return <path d="M4 6h16M4 12h16M4 18h16" fill="none" stroke="currentcolor" strokeWidth="2" strokeLinecap="round" />
  }
}

function formatTtsTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0:00'
  const rounded = Math.floor(seconds)
  const hours = Math.floor(rounded / 3600)
  const minutes = Math.floor((rounded % 3600) / 60)
  const remainingSeconds = rounded % 60
  if (hours > 0) return hours + ':' + String(minutes).padStart(2, '0') + ':' + String(remainingSeconds).padStart(2, '0')
  return minutes + ':' + String(remainingSeconds).padStart(2, '0')
}

function estimateChunkStart(index: number, totalChunks: number, totalDurationSec?: number): number | null {
  if (!totalDurationSec || totalDurationSec <= 0 || totalChunks <= 0) return null
  return Math.max(0, (totalDurationSec / totalChunks) * index)
}
