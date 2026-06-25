import { useCallback, useMemo, useState, type CSSProperties } from 'react'

const READER_SETTINGS_KEY = 'papercut.readerSettings.v1'

export interface ReaderSettingsState {
  fontFamily: string
  fontSizePx: number
  lineHeight: number
  widthCh: number
}

export interface ReaderRangeConfig {
  min: number
  max: number
  step: number
  suffix: string
}

export const DEFAULT_READER_SETTINGS: ReaderSettingsState = {
  fontFamily: 'Georgia, serif',
  fontSizePx: 16,
  lineHeight: 1.65,
  widthCh: 72,
}

// Single source of truth for slider UI and persisted-value validation.
export const READER_SETTING_LIMITS = {
  fontSizePx: { min: 8, max: 24, step: 1, suffix: 'px' },
  lineHeight: { min: 0.5, max: 2.2, step: 0.05, suffix: '' },
  widthCh: { min: 40, max: 100, step: 4, suffix: 'ch' },
} satisfies Record<'fontSizePx' | 'lineHeight' | 'widthCh', ReaderRangeConfig>

export const FONT_FAMILY_OPTIONS = [
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
  return clampReaderNumber(value, min, max, fallback)
}

export function clampReaderNumber(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}
