import type { ViewerProps, ViewerPlugin } from './types'

// Stub — implement with pdf.js or similar when PDF support is needed.
// Receives `url` (the PDF URL), `onLoad`, and optional scroll/zoom callbacks via ViewerProps.
function PdfViewerComponent({ url }: ViewerProps) {
  return (
    <div className="viewer-stub">
      <p>PDF viewer not yet implemented.</p>
      <p><code>{url}</code></p>
    </div>
  )
}

export const PdfViewer: ViewerPlugin = {
  id: 'pdf',
  canHandle: (url) => /\.pdf$/i.test(url),
  Component: PdfViewerComponent,
}
