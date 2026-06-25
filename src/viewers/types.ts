import type React from 'react'

export interface ViewerProps {
  url: string
  format?: string
  content?: string
  contentRef?: React.RefObject<HTMLElement | null>
}

export interface ViewerPlugin {
  id: string
  canHandle: (url: string) => boolean
  Component: React.FC<ViewerProps>
}
