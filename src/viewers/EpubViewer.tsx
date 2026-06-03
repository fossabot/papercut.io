import type { ViewerProps, ViewerPlugin } from './types'

// Stub — implement with epub.js or similar when EPUB support is needed.
function EpubViewerComponent({ url }: ViewerProps) {
  return (
    <div className="viewer-stub">
      <p>EPUB viewer not yet implemented.</p>
      <p><code>{url}</code></p>
    </div>
  )
}

export const EpubViewer: ViewerPlugin = {
  id: 'epub',
  canHandle: (url) => /\.epub$/i.test(url),
  Component: EpubViewerComponent,
}
