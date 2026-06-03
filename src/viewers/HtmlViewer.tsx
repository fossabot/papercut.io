import type { ViewerProps, ViewerPlugin } from './types'

function HtmlViewerComponent({ content, iframeRef, onLoad }: ViewerProps) {
  return (
    <iframe
      ref={iframeRef}
      className="document-iframe"
      srcDoc={content}
      sandbox="allow-same-origin"
      title="Document viewer"
      onLoad={onLoad}
    />
  )
}

export const HtmlViewer: ViewerPlugin = {
  id: 'html',
  canHandle: (url) => /\.html?$/i.test(url) || !url.includes('.'),
  Component: HtmlViewerComponent,
}
