export interface SpeechChunkProfile {
  maxChunkLength: number
  minChunkLength: number
}

// Playback-sized chunks keep skip/highlight interactions responsive.
export const PLAYBACK_CHUNK_PROFILE: SpeechChunkProfile = {
  maxChunkLength: 900,
  minChunkLength: 120,
}

// Save chunks favor native stability over minimum chunk count. Long Android
// save jobs can repeatedly hit the same native failure point if one request is
// too large or thermally stressful, so keep each synthesis request modest.
export const AUDIOBOOK_SAVE_CHUNK_PROFILE: SpeechChunkProfile = {
  maxChunkLength: 360,
  minChunkLength: 80,
}

export function extractReadableTextFromHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  doc.querySelectorAll('script, style, noscript, svg').forEach((el) => el.remove())

  return normalizeSpeechText(doc.body?.textContent ?? doc.documentElement.textContent ?? '')
}

export function normalizeSpeechText(text: string): string {
  return text
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

export function chunkSpeechText(
  text: string,
  profile: SpeechChunkProfile = PLAYBACK_CHUNK_PROFILE,
): string[] {
  const normalized = normalizeSpeechText(text)
  if (!normalized) return []

  const paragraphs = normalized
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean)

  const chunks: string[] = []
  for (const paragraph of paragraphs) {
    appendParagraphChunks(paragraph, chunks, profile)
  }

  return mergeShortChunks(chunks, profile)
}

export function chunkAudiobookSaveText(text: string): string[] {
  return chunkSpeechText(text, AUDIOBOOK_SAVE_CHUNK_PROFILE)
}

function mergeShortChunks(chunks: string[], profile: SpeechChunkProfile): string[] {
  const merged: string[] = []

  for (const chunk of chunks) {
    const previous = merged[merged.length - 1]
    if (
      previous &&
      previous.length < profile.minChunkLength &&
      previous.length + chunk.length + 1 <= profile.maxChunkLength
    ) {
      merged[merged.length - 1] = previous + ' ' + chunk
    } else {
      merged.push(chunk)
    }
  }

  return merged
}

function appendParagraphChunks(
  paragraph: string,
  chunks: string[],
  profile: SpeechChunkProfile,
): void {
  const sentences = paragraph
    .match(/[^.!?]+[.!?]+["')\]]*|[^.!?]+$/g)
    ?.map((sentence) => sentence.trim())
    .filter(Boolean) ?? [paragraph]

  let current = ''
  for (const sentence of sentences) {
    if (sentence.length > profile.maxChunkLength) {
      flushChunk(chunks, current)
      current = ''
      splitLongSentence(sentence, profile).forEach((part) => flushChunk(chunks, part))
      continue
    }

    const next = current ? current + ' ' + sentence : sentence
    if (next.length > profile.maxChunkLength && current.length >= profile.minChunkLength) {
      flushChunk(chunks, current)
      current = sentence
    } else {
      current = next
    }
  }

  flushChunk(chunks, current)
}

function splitLongSentence(sentence: string, profile: SpeechChunkProfile): string[] {
  // Fall back to clause boundaries for unusually long sentences that would make
  // one Kokoro request slow and hard to interrupt.
  const parts = sentence
    .split(/([,;:]\s+)/)
    .reduce<string[]>((acc, part, idx, source) => {
      if (idx % 2 === 0) {
        acc.push(part + (source[idx + 1] ?? ''))
      }
      return acc
    }, [])
    .map((part) => part.trim())
    .filter(Boolean)

  const chunks: string[] = []
  let current = ''
  for (const part of parts) {
    const next = current ? current + ' ' + part : part
    if (next.length > profile.maxChunkLength && current) {
      chunks.push(current)
      current = part
    } else {
      current = next
    }
  }

  if (current) chunks.push(current)
  return chunks
}

function flushChunk(chunks: string[], text: string): void {
  const normalized = normalizeSpeechText(text)
  if (normalized) chunks.push(normalized)
}
