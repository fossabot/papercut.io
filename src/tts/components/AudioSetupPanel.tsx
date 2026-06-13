import type { NativeTtsModelInstallProgress, NativeTtsModelStatus } from '../api/nativeTts'
import type { KokoroVoice, KokoroVoiceInfo } from '../types'

const HIGH_THREAD_COUNT_WARNING_THRESHOLD = 4

export interface AudioSetupPanelProps {
  appliedThreadCount: number | null
  defaultThreadCount: number
  maxThreadCount: number
  modelInstallProgress: NativeTtsModelInstallProgress | null
  modelStatus: NativeTtsModelStatus | null
  onInstallModel: () => void
  onSpeedChange: (speed: number) => void
  onThreadCountChange: (threadCount: number) => void
  onVoiceChange: (voice: KokoroVoice) => void
  speed: number
  threadCount: number
  voice: KokoroVoice
  voices: KokoroVoiceInfo[]
}

export function AudioSetupPanel({
  appliedThreadCount,
  defaultThreadCount,
  maxThreadCount,
  modelInstallProgress,
  modelStatus,
  onInstallModel,
  onSpeedChange,
  onThreadCountChange,
  onVoiceChange,
  speed,
  threadCount,
  voice,
  voices,
}: AudioSetupPanelProps) {
  const modelInstalling = modelStatus?.installing || (
    modelInstallProgress !== null &&
    modelInstallProgress.status !== 'installed' &&
    modelInstallProgress.status !== 'error'
  )
  const modelPercent = modelInstallProgress?.percent ?? 0
  const modelSize = formatModelSize(modelStatus?.archiveBytes ?? modelInstallProgress?.totalBytes ?? 0)
  const threadOptions = Array.from({ length: maxThreadCount }, (_, index) => index + 1)
  const showHighThreadWarning = threadCount > HIGH_THREAD_COUNT_WARNING_THRESHOLD

  return (
    <div className="audio-setup-panel">
      <div className="audio-settings-grid">
        <label className="audio-field">
          <span>Voice</span>
          <select
            className="tts-select"
            value={voice}
            onChange={(event) => onVoiceChange(event.target.value as KokoroVoice)}
            title="Voice"
          >
            {voices.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>

        <label className="audio-field">
          <span>Speed</span>
          <select
            className="tts-select tts-speed"
            value={speed}
            onChange={(event) => onSpeedChange(Number(event.target.value))}
            title="Speed"
          >
            <option value={0.85}>0.85x</option>
            <option value={1}>1x</option>
            <option value={1.1}>1.1x</option>
            <option value={1.2}>1.2x</option>
          </select>
        </label>

        <label className="audio-field">
          <span>Threads</span>
          <select
            className="tts-select tts-threads"
            value={threadCount}
            onChange={(event) => onThreadCountChange(Number(event.target.value))}
            title="Native TTS threads"
          >
            {threadOptions.map((count) => (
              <option key={count} value={count}>
                {count} {count === 1 ? 'thread' : 'threads'}
              </option>
            ))}
          </select>
          <span className="audio-thread-meta">
            Default {defaultThreadCount}, detected max {maxThreadCount}
            {appliedThreadCount !== null ? `, save applied ${appliedThreadCount}` : ''}
          </span>
          {showHighThreadWarning && (
            <span className="audio-thread-warning" role="alert">
              High thread counts can increase memory use, heat, battery drain, and thermal throttling. More threads may be slower.
            </span>
          )}
        </label>
      </div>

      <div className="audio-model-panel">
        <button
          className="tts-btn tts-save-btn"
          onClick={onInstallModel}
          disabled={Boolean(modelStatus?.installed) || modelInstalling}
          title={modelStatus?.installed ? 'Offline voice model is installed' : 'Download the pinned sherpa-onnx Kokoro model for offline TTS'}
        >
          <DownloadIcon />
          <span>{modelStatus?.installed ? 'Voice model installed' : modelInstalling ? 'Downloading Model...' : 'Download Voice Model'}</span>
        </button>
        <div className="audio-model-source" title={modelStatus?.sourceUrl}>
          <span>{'Source: ' + (modelStatus?.sourceLabel ?? 'k2-fsa/sherpa-onnx Kokoro multi-lang v1.0')}</span>
          <span>{modelSize ? modelSize + ' archive from k2-fsa/sherpa-onnx GitHub release' : 'Official k2-fsa/sherpa-onnx GitHub release asset'}</span>
        </div>
        {(modelInstallProgress || modelInstalling) && (
          <div className={'audiobook-status audiobook-status-' + (modelInstallProgress?.status === 'error' ? 'error' : modelStatus?.installed ? 'saved' : 'saving')}>
            <div className="audiobook-status-row">
              <span>{modelInstallProgress?.message ?? modelStatus?.message ?? 'Preparing model download'}</span>
              <span>{modelPercent}%</span>
            </div>
            {!modelStatus?.installed && modelInstallProgress?.status !== 'error' && (
              <div className="download-meter" aria-label={'Voice model download ' + modelPercent + '% complete'}>
                <span style={{ width: modelPercent + '%' }} />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function DownloadIcon() {
  return (
    <svg className="audio-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M12 3v10m0 0 4-4m-4 4-4-4M5 17v3h14v-3" fill="none" stroke="currentcolor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function formatModelSize(bytes: number): string | null {
  if (!Number.isFinite(bytes) || bytes <= 0) return null
  if (bytes >= 1024 * 1024 * 1024) return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB'
  return Math.round(bytes / 1024 / 1024) + ' MB'
}
