import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import './ReaderSettings.css'

const READER_SETTINGS_KEY = 'papercut.readerSettings.v1'

interface ReaderSettingsState {
  fontFamily: string
  fontSizePx: number
  lineHeight: number
  widthCh: number
}

interface ReaderSettingsProps {
  disabled?: boolean
  settings: ReaderSettingsState
  onChange: (next: Partial<ReaderSettingsState>) => void
  onReset: () => void
}

interface ReaderRangeConfig {
  min: number
  max: number
  step: number
  suffix: string
}

const DEFAULT_READER_SETTINGS: ReaderSettingsState = {
  fontFamily: 'Georgia, serif',
  fontSizePx: 16,
  lineHeight: 1.65,
  widthCh: 72,
}

// Single source of truth for slider UI and persisted-value validation.
const READER_SETTING_LIMITS = {
  fontSizePx: { min: 8, max: 24, step: 1, suffix: 'px' },
  lineHeight: { min: 0.5, max: 2.2, step: 0.05, suffix: '' },
  widthCh: { min: 40, max: 100, step: 4, suffix: 'ch' },
} satisfies Record<'fontSizePx' | 'lineHeight' | 'widthCh', ReaderRangeConfig>

const FONT_FAMILY_OPTIONS = [
  { label: 'Georgia', value: 'Georgia, serif' },
  { label: 'Times New Roman', value: '"Times New Roman", Times, serif' },
  { label: 'Palatino', value: 'Palatino, "Palatino Linotype", serif' },
  { label: 'System Sans', value: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' },
  { label: 'Verdana', value: 'Verdana, Geneva, sans-serif' },
]

export function useReaderSettings() {
  const [settings, setSettings] = useState<ReaderSettingsState>(() => loadReaderSettings())
  const readerSettingsStyle = useMemo(() => ({
    '--reader-font-family': settings.fontFamily,
    '--reader-font-size': `${settings.fontSizePx}px`,
    '--reader-line-height': String(settings.lineHeight),
    '--reader-width': `${settings.widthCh}ch`,
  }) as CSSProperties, [settings])

  const onChange = useCallback((next: Partial<ReaderSettingsState>) => {
    setSettings((current) => {
      const updated = clampReaderSettings({ ...current, ...next })
      saveReaderSettings(updated)
      return updated
    })
  }, [])

  const onReset = useCallback(() => {
    saveReaderSettings(DEFAULT_READER_SETTINGS)
    setSettings(DEFAULT_READER_SETTINGS)
  }, [])

  return {
    readerSettingsStyle,
    readerSettingsProps: { settings, onChange, onReset },
  }
}

export function ReaderSettings({
  disabled = false,
  settings,
  onChange,
  onReset,
}: ReaderSettingsProps) {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (disabled) setOpen(false)
  }, [disabled])

  useEffect(() => {
    if (!open) return

    function handlePointerDown(event: PointerEvent) {
      const root = rootRef.current
      if (!root || root.contains(event.target as Node)) return
      setOpen(false)
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false)
    }

    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open])

  return (
    <div className="reader-settings" ref={rootRef}>
      <button
        className="reader-settings-btn"
        aria-label="Reader settings"
        aria-expanded={open}
        title="Reader settings"
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        <span aria-hidden="true">⚙</span>
      </button>
      {open && (
        <div className="reader-settings-popover" role="dialog" aria-label="Reader settings">
          <label className="reader-setting-row">
            <span>Font</span>
            <select
              className="reader-setting-select"
              value={settings.fontFamily}
              onChange={(event) => onChange({ fontFamily: event.target.value })}
            >
              {FONT_FAMILY_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>

          <ReaderRange
            label="Size"
            value={settings.fontSizePx}
            config={READER_SETTING_LIMITS.fontSizePx}
            onChange={(value) => onChange({ fontSizePx: value })}
          />
          <ReaderRange
            label="Line"
            value={settings.lineHeight}
            config={READER_SETTING_LIMITS.lineHeight}
            onChange={(value) => onChange({ lineHeight: value })}
          />
          <ReaderRange
            label="Width"
            value={settings.widthCh}
            config={READER_SETTING_LIMITS.widthCh}
            onChange={(value) => onChange({ widthCh: value })}
          />

          <button className="reader-settings-reset" type="button" onClick={onReset}>Reset</button>
        </div>
      )}
    </div>
  )
}

function ReaderRange({
  label,
  value,
  config,
  onChange,
}: {
  label: string
  value: number
  config: ReaderRangeConfig
  onChange: (value: number) => void
}) {
  const labelId = `reader-setting-${label.toLowerCase()}`

  return (
    <div className="reader-setting-row reader-setting-range" role="group" aria-labelledby={labelId}>
      <span id={labelId}>{label}</span>
      <button
        type="button"
        className="reader-setting-step"
        onClick={() => onChange(stepReaderValue(value, config, -1))}
        disabled={value <= config.min}
        aria-label={`Decrease ${label}`}
        title={`Decrease ${label}`}
      >
        &minus;
      </button>
      <input
        className="reader-setting-slider"
        type="range"
        min={config.min}
        max={config.max}
        step={config.step}
        value={value}
        aria-labelledby={labelId}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <button
        type="button"
        className="reader-setting-step"
        onClick={() => onChange(stepReaderValue(value, config, 1))}
        disabled={value >= config.max}
        aria-label={`Increase ${label}`}
        title={`Increase ${label}`}
      >
        +
      </button>
      <output>{formatReaderValue(value, config.suffix)}</output>
    </div>
  )
}

// Load preferences defensively because old app versions, edited localStorage, or
// future bound changes can leave persisted values outside the current UI contract.
function loadReaderSettings(): ReaderSettingsState {
  if (typeof window === 'undefined') return DEFAULT_READER_SETTINGS
  try {
    const raw = window.localStorage.getItem(READER_SETTINGS_KEY)
    if (!raw) return DEFAULT_READER_SETTINGS
    return clampReaderSettings({ ...DEFAULT_READER_SETTINGS, ...JSON.parse(raw) })
  } catch {
    return DEFAULT_READER_SETTINGS
  }
}

// Preference persistence is best effort. Reader styling should still work in
// browser previews or restricted WebViews where localStorage writes fail.
function saveReaderSettings(settings: ReaderSettingsState): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(READER_SETTINGS_KEY, JSON.stringify(settings))
  } catch {
    // Non-critical preference persistence can fail in restricted previews.
  }
}

// Normalize every setting before it reaches CSS variables, preventing unsupported
// font values or stale numeric bounds from leaking into the reader surface.
function clampReaderSettings(settings: ReaderSettingsState): ReaderSettingsState {
  const fontFamily = FONT_FAMILY_OPTIONS.some((option) => option.value === settings.fontFamily)
    ? settings.fontFamily
    : DEFAULT_READER_SETTINGS.fontFamily
  return {
    fontFamily,
    fontSizePx: clampSettingNumber('fontSizePx', settings.fontSizePx, DEFAULT_READER_SETTINGS.fontSizePx),
    lineHeight: clampSettingNumber('lineHeight', settings.lineHeight, DEFAULT_READER_SETTINGS.lineHeight),
    widthCh: clampSettingNumber('widthCh', settings.widthCh, DEFAULT_READER_SETTINGS.widthCh),
  }
}

// Clamp against the shared range table so slider limits and saved-value repair
// cannot drift apart again.
function clampSettingNumber(
  key: keyof typeof READER_SETTING_LIMITS,
  value: number,
  fallback: number,
): number {
  const { min, max } = READER_SETTING_LIMITS[key]
  return clampNumber(value, min, max, fallback)
}

function clampNumber(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

// Buttons use the same step as sliders, with decimal cleanup so line-height
// clicks do not accumulate floating point tails such as 0.8500000001.
function stepReaderValue(value: number, config: ReaderRangeConfig, direction: -1 | 1): number {
  const stepped = value + config.step * direction
  const clamped = clampNumber(stepped, config.min, config.max, value)
  return Number.parseFloat(clamped.toFixed(decimalPlaces(config.step)))
}

function decimalPlaces(value: number): number {
  const [, fraction = ''] = String(value).split('.')
  return fraction.length
}

// Keep range outputs readable across integer and decimal controls without
// showing noisy values like 1.50 for line height.
function formatReaderValue(value: number, suffix: string): string {
  const rounded = Number.isInteger(value) ? String(value) : String(Number.parseFloat(value.toFixed(2)))
  return rounded + suffix
}
