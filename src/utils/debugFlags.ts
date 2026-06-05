// Lightweight, dependency-free debug gate for developer-only UI.
// Enable with `?debug` in the URL, or `localStorage.setItem('papercut.debug', '1')`.

const STORAGE_KEY = 'papercut.debug'

function isFalsy(value: string | null): boolean {
  return value === '0' || value === 'false' || value === 'off'
}

export function isDebugEnabled(): boolean {
  if (typeof window === 'undefined') return false

  try {
    const param = new URLSearchParams(window.location.search).get('debug')
    if (param !== null) return !isFalsy(param)
  } catch {
    // Ignore malformed URLs.
  }

  try {
    return window.localStorage.getItem(STORAGE_KEY) === '1'
  } catch {
    return false
  }
}
