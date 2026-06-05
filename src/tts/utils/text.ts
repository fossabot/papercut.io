import {
  extractReadableSegmentsFromHtml,
  extractReadableTextFromSegments,
  normalizeSegmentText,
  normalizeSpeechText,
  type ReadableSegment,
  type ReadableSegmentKind,
} from '../alignment/readableSegments'

export interface SpeechChunkProfile {
  maxChunkLength: number
  minChunkLength: number
}

interface SpeechChunkCandidate {
  text: string
  kind: ReadableSegmentKind
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

// Compatibility wrapper for callers that still need one normalized readable string.
export function extractReadableTextFromHtml(html: string): string {
  return extractReadableTextFromSegments(extractReadableSegmentsFromHtml(html))
}

export { normalizeSpeechText }

// Chunks already-extracted plain text; HTML callers should prefer segment-aware
// chunking so visual block boundaries are not lost.
export function chunkSpeechText(
  text: string,
  profile: SpeechChunkProfile = PLAYBACK_CHUNK_PROFILE,
): string[] {
  const normalized = normalizeSpeechText(text)
  if (!normalized) return []

  return chunkReadableSegments([{ text: normalized, kind: 'paragraph' }], profile)
}

export function chunkAudiobookSaveText(text: string): string[] {
  return chunkSpeechText(text, AUDIOBOOK_SAVE_CHUNK_PROFILE)
}

// Builds save-time audiobook chunks from HTML segments so headings, paragraphs,
// and lists stay aligned with the viewer highlight map.
export function chunkAudiobookSaveHtml(html: string): string[] {
  return chunkReadableSegments(extractReadableSegmentsFromHtml(html), AUDIOBOOK_SAVE_CHUNK_PROFILE)
}

// Shared chunking entry point for format adapters. EPUB/PDF should emit
// ReadableSegment[] and reuse this instead of adding format logic to playback.
export function chunkReadableSegments(
  segments: ReadableSegment[],
  profile: SpeechChunkProfile = PLAYBACK_CHUNK_PROFILE,
): string[] {
  const chunks: SpeechChunkCandidate[] = []

  for (const segment of segments) {
    appendSegmentChunks(segment, chunks, profile)
  }

  return mergeShortChunks(chunks, profile).map((chunk) => chunk.text)
}

// Merges tiny adjacent chunks only when their segment kinds are compatible; this
// avoids folding headings into paragraphs just to satisfy a minimum length.
function mergeShortChunks(chunks: SpeechChunkCandidate[], profile: SpeechChunkProfile): SpeechChunkCandidate[] {
  const merged: SpeechChunkCandidate[] = []

  for (const chunk of chunks) {
    const previous = merged[merged.length - 1]
    if (
      previous &&
      canMergeChunks(previous.kind, chunk.kind) &&
      previous.text.length < profile.minChunkLength &&
      previous.text.length + chunk.text.length + 1 <= profile.maxChunkLength
    ) {
      merged[merged.length - 1] = {
        ...previous,
        text: previous.text + ' ' + chunk.text,
      }
    } else {
      merged.push(chunk)
    }
  }

  return merged
}

// Splits one readable segment into sentence-sized TTS requests while preserving
// the segment kind for later merge decisions.
function appendSegmentChunks(
  segment: ReadableSegment,
  chunks: SpeechChunkCandidate[],
  profile: SpeechChunkProfile,
): void {
  const paragraph = normalizeSegmentText(segment.text)
  if (!paragraph) return

  const sentences = paragraph
    .match(/[^.!?]+[.!?]+["')\]]*|[^.!?]+$/g)
    ?.map((sentence) => sentence.trim())
    .filter(Boolean) ?? [paragraph]

  let current = ''
  for (const sentence of sentences) {
    if (sentence.length > profile.maxChunkLength) {
      flushChunk(chunks, current, segment.kind)
      current = ''
      splitLongSentence(sentence, profile).forEach((part) => flushChunk(chunks, part, segment.kind))
      continue
    }

    const next = current ? current + ' ' + sentence : sentence
    if (next.length > profile.maxChunkLength) {
      if (current) flushChunk(chunks, current, segment.kind)
      current = sentence
    } else {
      current = next
    }
  }

  flushChunk(chunks, current, segment.kind)
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

// Normalizes the final chunk text at the boundary where it becomes cache-keyed
// audiobook input.
function flushChunk(chunks: SpeechChunkCandidate[], text: string, kind: ReadableSegmentKind): void {
  const normalized = normalizeSegmentText(text)
  if (normalized) chunks.push({ text: normalized, kind })
}

// Encodes the UX rule for structural boundaries: headings stand alone, and list
// items only merge with other list items.
function canMergeChunks(previous: ReadableSegmentKind, next: ReadableSegmentKind): boolean {
  if (previous === 'heading' || next === 'heading') return false
  if (previous === 'listItem' || next === 'listItem') return previous === next
  return true
}
