import type { ViewerProps } from './types'

export function HtmlViewer({ content, iframeRef, onLoad }: ViewerProps) {
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
