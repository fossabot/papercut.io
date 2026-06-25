import type { NativeTtsModelInstallProgress, NativeTtsModelStatus } from '../api/nativeTts'
import type { TextPreprocessorInfo, TtsModelInfo, TtsVoice, TtsVoiceInfo } from '../types'

const HIGH_THREAD_COUNT_WARNING_THRESHOLD = 4

const SPEED_MIN = 0.5
const SPEED_MAX = 2
const SPEED_STEP = 0.05

// Snap to the slider step and clamp to range. The saved-audiobook cache id buckets
// speed to 2 decimals on both the JS and Rust side, so values must round-trip cleanly
// at that precision; this also avoids float drift breaking equality checks on reload.
function snapSpeed(value: number): number {
  if (!Number.isFinite(value)) return 1
  const snapped = Math.round(value / SPEED_STEP) * SPEED_STEP
  const clamped = Math.min(SPEED_MAX, Math.max(SPEED_MIN, snapped))
  return Number(clamped.toFixed(2))
}

function formatSpeedLabel(speed: number): string {
  if (!Number.isFinite(speed)) return '1x'
  return speed.toFixed(speed % 1 === 0 ? 0 : 2).replace(/0$/, '').replace(/\.$/, '') + 'x'
}

export interface AudioSetupPanelProps {
  appliedThreadCount: number | null
  defaultThreadCount: number
  maxThreadCount: number
  modelId: string
  models: TtsModelInfo[]
  modelInstallProgress: NativeTtsModelInstallProgress | null
  modelStatus: NativeTtsModelStatus | null
  onInstallModel: () => void
  onModelChange: (modelId: string) => void
  onSpeedChange: (speed: number) => void
  onTextPreprocessorChange: (textPreprocessor: string) => void
  onThreadCountChange: (threadCount: number) => void
  onVoiceChange: (voice: TtsVoice) => void
  speed: number
  textPreprocessor: string
  textPreprocessors: TextPreprocessorInfo[]
  threadCount: number
  voice: TtsVoice
  voices: TtsVoiceInfo[]
}

export function AudioSetupPanel({
  appliedThreadCount,
  defaultThreadCount,
  maxThreadCount,
  modelId,
  models,
  modelInstallProgress,
  modelStatus,
  onInstallModel,
  onModelChange,
  onSpeedChange,
  onTextPreprocessorChange,
  onThreadCountChange,
  onVoiceChange,
  speed,
  textPreprocessor,
  textPreprocessors,
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
          <span>Model</span>
          <select
            className="tts-select"
            value={modelId}
            onChange={(event) => onModelChange(event.target.value)}
            title="Speech model"
          >
            {models.map((model) => (
              <option key={model.id} value={model.id}>
                {model.languageLabel + ' - ' + model.name}
              </option>
            ))}
          </select>
        </label>

        <label className="audio-field">
          <span>Voice</span>
          <select
            className="tts-select"
            value={voice}
            onChange={(event) => onVoiceChange(event.target.value as TtsVoice)}
            title="Voice"
          >
            {voices.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>

        <label className="audio-field audio-field-speed">
          <span>Speed</span>
          <div className="audio-speed-row">
            <button
              type="button"
              className="audio-speed-step"
              onClick={() => onSpeedChange(snapSpeed(speed - SPEED_STEP))}
              disabled={speed <= SPEED_MIN}
              aria-label="Decrease Speed"
              title="Decrease Speed"
            >
              &minus;
            </button>
            <input
              type="range"
              className="tts-speed-slider"
              min={SPEED_MIN}
              max={SPEED_MAX}
              step={SPEED_STEP}
              value={speed}
              onChange={(event) => onSpeedChange(snapSpeed(Number(event.target.value)))}
              title="Playback Speed"
              aria-label="Playback Speed"
            />
            <button
              type="button"
              className="audio-speed-step"
              onClick={() => onSpeedChange(snapSpeed(speed + SPEED_STEP))}
              disabled={speed >= SPEED_MAX}
              aria-label="Increase Speed"
              title="Increase Speed"
            >
              +
            </button>
            <span className="audio-speed-value">{formatSpeedLabel(speed)}</span>
          </div>
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

        {textPreprocessors.length > 1 && (
          <label className="audio-field">
            <span>Text Processing</span>
            <select
              className="tts-select"
              value={textPreprocessor}
              onChange={(event) => onTextPreprocessorChange(event.target.value)}
              title="Optional language preprocessing before speech synthesis"
            >
              {textPreprocessors.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
            <span className="audio-thread-meta">
              {textPreprocessors.find((item) => item.id === textPreprocessor)?.description}
            </span>
          </label>
        )}
      </div>

      <div className="audio-model-panel">
        <button
          className="tts-btn tts-save-btn"
          onClick={onInstallModel}
          disabled={Boolean(modelStatus?.installed) || modelInstalling}
          title={modelStatus?.installed ? 'Offline voice model is installed' : 'Download selected offline voice model'}
        >
          {modelStatus?.installed ? <CheckIcon /> : <DownloadIcon />}
          <span>{modelStatus?.installed ? 'Voice model installed' : modelInstalling ? 'Downloading Model...' : 'Download Voice Model'}</span>
        </button>
        <div className="audio-model-source" title={modelStatus?.sourceUrl}>
          <span>{'Source: ' + (modelStatus?.sourceLabel ?? 'sherpa-onnx offline TTS')}</span>
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

function CheckIcon() {
  return (
    <svg className="audio-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="m4 12 5 5L20 6" fill="none" stroke="currentcolor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function formatModelSize(bytes: number): string | null {
  if (!Number.isFinite(bytes) || bytes <= 0) return null
  if (bytes >= 1024 * 1024 * 1024) return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB'
  return Math.round(bytes / 1024 / 1024) + ' MB'
}
