import { memo, useMemo } from 'react'
import type { ViewerProps } from './types'

export const HtmlViewer = memo(function HtmlViewer({ content, contentRef }: ViewerProps) {
  const bodyHtml = useMemo(() => extractBodyHtml(content ?? ''), [content])

  return (
    <article ref={contentRef} className="document-html-surface">
      <div className="document-html-content" dangerouslySetInnerHTML={{ __html: bodyHtml }} />
    </article>
  )
})

// Uploaded sources are stored as complete sanitized HTML documents. The app-owned
// surface renders only body content so imported head styles cannot leak globally.
function extractBodyHtml(content: string): string {
  if (typeof DOMParser === 'undefined') return content

  const doc = new DOMParser().parseFromString(content, 'text/html')
  return doc.body?.innerHTML || content
}
