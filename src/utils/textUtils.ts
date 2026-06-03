export function normalizeForDisplay(s: string): string {
  return s
    .replace(/['']/g, "'")
    .replace(/[""]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
}

export function normalizeForPhraseMatch(s: string): string {
  return normalizeForDisplay(s).toLowerCase()
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
