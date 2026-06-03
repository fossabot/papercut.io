import type { ViewerProps } from './types'

// Stub — implement with epub.js or similar when EPUB support is needed.
export function EpubViewer({ url }: ViewerProps) {
  return (
    <div className="viewer-stub">
      <p>EPUB viewer not yet implemented.</p>
      <p><code>{url}</code></p>
    </div>
  )
}
