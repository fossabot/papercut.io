import type React from 'react'

export interface ViewerProps {
  url: string
  content?: string
  iframeRef?: React.RefObject<HTMLIFrameElement | null>
  onLoad?: () => void
}

export interface ViewerPlugin {
  id: string
  canHandle: (url: string) => boolean
  Component: React.FC<ViewerProps>
}
