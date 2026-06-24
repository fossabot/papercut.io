import { useEffect } from 'react'
import './ExternalLinkPrompt.css'

interface ExternalLinkPromptProps {
  url: string
  onCancel: () => void
  onOpen: () => void
}

export function ExternalLinkPrompt({ url, onCancel, onOpen }: ExternalLinkPromptProps) {
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onCancel()
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onCancel])

  return (
    <div className="external-link-modal-backdrop" role="presentation" onClick={onCancel}>
      <div
        className="external-link-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="external-link-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="external-link-title">⚠️ Open External Link?</h2>
        <p>This link will open outside Papercut.</p>
        <code>{url}</code>
        <div className="external-link-actions">
          <button type="button" className="external-link-cancel" onClick={onCancel}>Cancel</button>
          <button type="button" className="external-link-open" onClick={onOpen}>Open</button>
        </div>
      </div>
    </div>
  )
}
