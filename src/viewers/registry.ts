import type { ViewerPlugin } from './types'
import { PdfViewer } from './PdfViewer'
import { EpubViewer } from './EpubViewer'
import { HtmlViewer } from './HtmlViewer'

// Order matters: more specific formats before the HTML fallback.
const viewerPlugins: ViewerPlugin[] = [PdfViewer, EpubViewer, HtmlViewer]

export function resolveViewer(url: string): ViewerPlugin {
  return viewerPlugins.find((p) => p.canHandle(url)) ?? HtmlViewer
}
