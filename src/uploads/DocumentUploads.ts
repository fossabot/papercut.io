export interface UploadedDocument {
  id: string
  url: string
  title: string
  format: 'html' | string
  importedAtMs: number
  bytes: number
  sections: number
}

export interface UploadedDocumentSearchResult {
  id: string
  documentId: string
  url: string
  title: string
  excerpt: string
  sectionTitle?: string | null
  sectionIndex: number
}

export interface UploadedDocumentDeleteResult {
  id: string
  url: string
  bytesFreed: number
}

export function isUploadedDocumentUrl(url: string): boolean {
  return /^\/uploads\/[a-fA-F0-9]+\.html(?:[#?].*)?$/.test(url)
}

export async function importHtmlDocument(): Promise<UploadedDocument> {
  const invoke = await loadTauriInvoke()
  return invoke<UploadedDocument>('document_uploads_import_html')
}

export async function importEpubDocument(): Promise<UploadedDocument> {
  const invoke = await loadTauriInvoke()
  return invoke<UploadedDocument>('document_uploads_import_epub')
}

export async function listUploadedDocuments(): Promise<UploadedDocument[]> {
  if (!isTauriRuntime()) return []
  const invoke = await loadTauriInvoke()
  return invoke<UploadedDocument[]>('document_uploads_list')
}

export async function searchUploadedDocuments(query: string, limit = 50): Promise<UploadedDocumentSearchResult[]> {
  if (!isTauriRuntime() || query.trim().length === 0) return []
  const invoke = await loadTauriInvoke()
  return invoke<UploadedDocumentSearchResult[]>('document_uploads_search', {
    request: { query, limit },
  })
}

export async function getUploadedDocumentSource(documentUrl: string): Promise<string> {
  const invoke = await loadTauriInvoke()
  return invoke<string>('document_uploads_get_source', {
    request: { documentUrl },
  })
}

export async function deleteUploadedDocument(documentUrl: string): Promise<UploadedDocumentDeleteResult> {
  const invoke = await loadTauriInvoke()
  return invoke<UploadedDocumentDeleteResult>('document_uploads_delete', {
    request: { documentUrl },
  })
}

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

async function loadTauriInvoke(): Promise<<T>(cmd: string, args?: Record<string, unknown>) => Promise<T>> {
  const mod = await import('@tauri-apps/api/core')
  return mod.invoke
}
