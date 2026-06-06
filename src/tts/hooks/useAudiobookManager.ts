import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DocumentInfo, SearchResult } from '../../types/search'
import type { UploadedDocument } from '../../uploads/DocumentUploads'
import {
  createAudiobookId,
  getSavedAudiobooks,
  markAudiobookSaved,
  removeSavedAudiobook,
  type SavedAudiobookRecord,
} from '../storage/AudiobookLibrary'
import {
  clearCompletedAudiobookDownload,
  createAudiobookDownloadId,
  getAudiobookDownloads,
  removeAudiobookDownload,
  upsertAudiobookDownload,
  type AudiobookDownloadInput,
  type AudiobookDownloadRecord,
} from '../storage/AudiobookDownloadQueue'
import { getAudioPreferences, saveAudioPreferences } from '../storage/audioPreferences'
import { formatAudiobookExportMessage, formatStorageSize } from '../utils/format'
import {
  deleteNativeAudiobook,
  exportNativeAudiobook,
  getNativeTtsModelStatus,
  importNativeAudiobook,
  installNativeTtsModel,
  listenNativeTtsModelInstallProgress,
  type NativeTtsModelInstallProgress,
  type NativeTtsModelStatus,
} from '../api/nativeTts'
import { chunkAudiobookSaveHtml } from '../utils/text'
import type { KokoroDtype, KokoroVoice, TtsChunk } from '../types'
import { isUserUploadUrl, removeUserUpload, upsertUserUpload, type UserUploadDocument } from '../storage/UserUploads'
import { useAudiobookCache } from './useAudiobookCache'
import { useTtsPlayer } from './useTtsPlayer'

interface AudiobookManagerOptions {
  allDocuments: DocumentInfo[]
  docContent: string
  loadHtmlDocument: (url: string) => Promise<string>
  selectedDoc: string | null
  uploadedDocuments: UploadedDocument[]
  userUploads: UserUploadDocument[]
  onClearDocument: () => void
  onUserUploadsChanged: () => void
}

export function useAudiobookManager({
  allDocuments,
  docContent,
  loadHtmlDocument,
  selectedDoc,
  uploadedDocuments,
  userUploads,
  onClearDocument,
  onUserUploadsChanged,
}: AudiobookManagerOptions) {
  const initialAudioPreferences = getAudioPreferences()
  const [ttsVoice, setTtsVoice] = useState<KokoroVoice>(initialAudioPreferences.voice)
  const [ttsSpeed, setTtsSpeed] = useState(initialAudioPreferences.speed)
  const [ttsThreadCount, setTtsThreadCount] = useState(initialAudioPreferences.threadCount)
  const ttsDtype: KokoroDtype = initialAudioPreferences.dtype
  const [ttsSaveChunks, setTtsSaveChunks] = useState<TtsChunk[] | null>(null)
  const [ttsModelStatus, setTtsModelStatus] = useState<NativeTtsModelStatus | null>(null)
  const [ttsModelProgress, setTtsModelProgress] = useState<NativeTtsModelInstallProgress | null>(null)
  const [savedAudiobooks, setSavedAudiobooks] = useState<SavedAudiobookRecord[]>(() => getSavedAudiobooks())
  const [audioSavedOnly, setAudioSavedOnly] = useState(initialAudioPreferences.audioSavedOnly)
  const [audiobookDownloads, setAudiobookDownloads] = useState<AudiobookDownloadRecord[]>(() => getAudiobookDownloads())
  const [audiobookDownload, setAudiobookDownload] = useState<{ title: string; url: string; voice: KokoroVoice; speed: number; dtype: KokoroDtype } | null>(null)
  const [audiobookExport, setAudiobookExport] = useState<{ id: string; status: 'exporting' | 'exported' | 'cancelled' | 'error'; message: string } | null>(null)
  const [audiobookDelete, setAudiobookDelete] = useState<{ id: string; status: 'deleting' | 'deleted' | 'error'; message: string } | null>(null)
  const [audiobookImport, setAudiobookImport] = useState<{ status: 'idle' | 'importing' | 'imported' | 'cancelled' | 'error'; message: string }>({ status: 'idle', message: '' })
  const pendingDownloadPersistRef = useRef<AudiobookDownloadInput | null>(null)
  const downloadPersistTimerRef = useRef<number | null>(null)

  const {
    state: ttsState,
    preload: preloadTts,
    speak: speakTts,
    pause: pauseTts,
    resume: resumeTts,
    jumpToChunk: jumpTtsToChunk,
    skipBackward: skipTtsBackward,
    skipForward: skipTtsForward,
    stop: stopTts,
  } = useTtsPlayer()
  const {
    state: selectedAudiobookState,
    check: checkSelectedAudiobook,
    reset: resetSelectedAudiobookState,
  } = useAudiobookCache()
  const {
    state: downloadAudiobookState,
    save: saveAudiobook,
    cancel: cancelAudiobookSave,
  } = useAudiobookCache()

  const savedAudiobookIds = useMemo(() => new Set(savedAudiobooks.map((record) => record.id)), [savedAudiobooks])

  const getDocumentTitle = useCallback((url: string): string => {
    return uploadedDocuments.find((doc) => doc.url === url)?.title
      ?? userUploads.find((doc) => doc.url === url)?.title
      ?? allDocuments.find((doc) => doc.url === url)?.title
      ?? decodeURIComponent(url.split('/').pop() ?? url)
  }, [allDocuments, uploadedDocuments, userUploads])

  const refreshAudiobookDownloads = useCallback(() => {
    setAudiobookDownloads(getAudiobookDownloads())
  }, [])

  const flushAudiobookDownloadPersist = useCallback(() => {
    if (downloadPersistTimerRef.current !== null) {
      window.clearTimeout(downloadPersistTimerRef.current)
      downloadPersistTimerRef.current = null
    }

    const pending = pendingDownloadPersistRef.current
    if (!pending) return

    pendingDownloadPersistRef.current = null
    upsertAudiobookDownload(pending)
    refreshAudiobookDownloads()
  }, [refreshAudiobookDownloads])

  const scheduleAudiobookDownloadPersist = useCallback((input: AudiobookDownloadInput, immediate = false) => {
    pendingDownloadPersistRef.current = input
    if (immediate) {
      flushAudiobookDownloadPersist()
      return
    }

    if (downloadPersistTimerRef.current !== null) return
    downloadPersistTimerRef.current = window.setTimeout(() => {
      flushAudiobookDownloadPersist()
    }, 1200)
  }, [flushAudiobookDownloadPersist])

  const refreshTtsModelStatus = useCallback(async () => {
    const status = await getNativeTtsModelStatus()
    setTtsModelStatus(status)
    return status
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refreshTtsModelStatus()
    let cancelled = false
    let unlisten: (() => void) | null = null
    listenNativeTtsModelInstallProgress((progress) => {
      if (!cancelled) setTtsModelProgress(progress)
    }).then((value) => {
      if (cancelled) value()
      else unlisten = value
    })
    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [refreshTtsModelStatus])

  const handleInstallTtsModel = useCallback(async () => {
    setTtsModelProgress({
      status: 'starting',
      message: 'Preparing offline voice model download',
      downloadedBytes: 0,
      totalBytes: ttsModelStatus?.archiveBytes ?? 0,
      percent: 0,
    })
    try {
      await installNativeTtsModel()
      await refreshTtsModelStatus()
      setTtsModelProgress((prev) => ({
        status: 'installed',
        message: 'Offline voice model installed',
        downloadedBytes: prev?.totalBytes ?? ttsModelStatus?.archiveBytes ?? 0,
        totalBytes: prev?.totalBytes ?? ttsModelStatus?.archiveBytes ?? 0,
        percent: 100,
      }))
      preloadTts()
    } catch (err) {
      setTtsModelProgress({
        status: 'error',
        message: err instanceof Error ? err.message : String(err),
        downloadedBytes: 0,
        totalBytes: ttsModelStatus?.archiveBytes ?? 0,
        percent: 0,
      })
      void refreshTtsModelStatus()
    }
  }, [preloadTts, refreshTtsModelStatus, ttsModelStatus?.archiveBytes])

  useEffect(() => {
    if (window.requestIdleCallback) {
      const handle = window.requestIdleCallback(() => preloadTts(), { timeout: 4000 })
      return () => window.cancelIdleCallback(handle)
    }

    const timeout = window.setTimeout(() => preloadTts(), 1500)
    return () => window.clearTimeout(timeout)
  }, [preloadTts])

  useEffect(() => {
    if (!selectedDoc || !docContent) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setTtsSaveChunks(null)
      return
    }

    setTtsSaveChunks(audiobookSaveChunksFromHtml(docContent))
  }, [docContent, selectedDoc])

  useEffect(() => {
    if (!selectedDoc || !ttsSaveChunks) return

    checkSelectedAudiobook(ttsSaveChunks, {
      voice: ttsVoice,
      speed: ttsSpeed,
      dtype: ttsDtype,
      threadCount: ttsThreadCount,
      documentUrl: selectedDoc,
      title: getDocumentTitle(selectedDoc),
    })
  }, [checkSelectedAudiobook, getDocumentTitle, selectedDoc, ttsDtype, ttsSaveChunks, ttsSpeed, ttsThreadCount, ttsVoice])

  useEffect(() => {
    saveAudioPreferences({ voice: ttsVoice })
  }, [ttsVoice])

  useEffect(() => {
    saveAudioPreferences({ speed: ttsSpeed })
  }, [ttsSpeed])

  useEffect(() => {
    saveAudioPreferences({ threadCount: ttsThreadCount })
  }, [ttsThreadCount])

  useEffect(() => {
    saveAudioPreferences({ audioSavedOnly })
  }, [audioSavedOnly])

  useEffect(() => {
    if (!audiobookDownload || downloadAudiobookState.complete) return

    if (downloadAudiobookState.status === 'checking' || downloadAudiobookState.status === 'saving') {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      scheduleAudiobookDownloadPersist({
        documentUrl: audiobookDownload.url,
        title: audiobookDownload.title,
        voice: audiobookDownload.voice,
        speed: audiobookDownload.speed,
        dtype: audiobookDownload.dtype,
        status: 'saving',
        cachedChunks: downloadAudiobookState.cachedChunks,
        totalChunks: downloadAudiobookState.totalChunks,
        message: downloadAudiobookState.message,
        audioDurationSec: downloadAudiobookState.audioDurationSec,
        wavBytes: downloadAudiobookState.wavBytes,
      })
      return
    }

    if (downloadAudiobookState.status === 'partial') {
      scheduleAudiobookDownloadPersist({
        documentUrl: audiobookDownload.url,
        title: audiobookDownload.title,
        voice: audiobookDownload.voice,
        speed: audiobookDownload.speed,
        dtype: audiobookDownload.dtype,
        status: 'paused',
        cachedChunks: downloadAudiobookState.cachedChunks,
        totalChunks: downloadAudiobookState.totalChunks,
        message: downloadAudiobookState.message || 'Ready to resume',
        audioDurationSec: downloadAudiobookState.audioDurationSec,
        wavBytes: downloadAudiobookState.wavBytes,
      }, true)
      return
    }

    if (downloadAudiobookState.status === 'error') {
      scheduleAudiobookDownloadPersist({
        documentUrl: audiobookDownload.url,
        title: audiobookDownload.title,
        voice: audiobookDownload.voice,
        speed: audiobookDownload.speed,
        dtype: audiobookDownload.dtype,
        status: 'error',
        cachedChunks: downloadAudiobookState.cachedChunks,
        totalChunks: downloadAudiobookState.totalChunks,
        message: downloadAudiobookState.message,
        audioDurationSec: downloadAudiobookState.audioDurationSec,
        wavBytes: downloadAudiobookState.wavBytes,
      }, true)
    }
  }, [audiobookDownload, downloadAudiobookState, scheduleAudiobookDownloadPersist])

  useEffect(() => {
    if (!downloadAudiobookState.complete || !audiobookDownload) return

    // eslint-disable-next-line react-hooks/set-state-in-effect
    flushAudiobookDownloadPersist()
    markAudiobookSaved({
      documentUrl: audiobookDownload.url,
      title: audiobookDownload.title,
      voice: audiobookDownload.voice,
      speed: audiobookDownload.speed,
      dtype: audiobookDownload.dtype,
      chunks: downloadAudiobookState.totalChunks,
      audioDurationSec: downloadAudiobookState.audioDurationSec,
      wavBytes: downloadAudiobookState.wavBytes,
    })
    clearCompletedAudiobookDownload(audiobookDownload.url, {
      voice: audiobookDownload.voice,
      speed: audiobookDownload.speed,
      dtype: audiobookDownload.dtype,
    })
    setSavedAudiobooks(getSavedAudiobooks())
    refreshAudiobookDownloads()
  }, [audiobookDownload, downloadAudiobookState.audioDurationSec, downloadAudiobookState.complete, downloadAudiobookState.totalChunks, downloadAudiobookState.wavBytes, flushAudiobookDownloadPersist, refreshAudiobookDownloads])

  useEffect(() => {
    function flushPendingDownload() {
      flushAudiobookDownloadPersist()
    }

    document.addEventListener('visibilitychange', flushPendingDownload)
    window.addEventListener('pagehide', flushPendingDownload)
    return () => {
      document.removeEventListener('visibilitychange', flushPendingDownload)
      window.removeEventListener('pagehide', flushPendingDownload)
      flushAudiobookDownloadPersist()
    }
  }, [flushAudiobookDownloadPersist])

  useEffect(() => {
    if (!selectedDoc) return
    const timeout = window.setTimeout(() => preloadTts(), 250)
    return () => window.clearTimeout(timeout)
  }, [preloadTts, selectedDoc])

  const prepareDocumentOpen = useCallback(() => {
    setTtsSaveChunks(null)
    resetSelectedAudiobookState()
  }, [resetSelectedAudiobookState])

  const closeDocumentAudio = useCallback(() => {
    stopTts()
    setTtsSaveChunks(null)
  }, [stopTts])

  const getAudiobookSaveChunksForDocument = useCallback(async (documentUrl: string): Promise<TtsChunk[]> => {
    const html = await loadHtmlDocument(documentUrl)
    return audiobookSaveChunksFromHtml(html)
  }, [loadHtmlDocument])

  const getSelectedAudiobookSaveChunks = useCallback(async (): Promise<TtsChunk[]> => {
    if (!selectedDoc) return []
    return ttsSaveChunks ?? getAudiobookSaveChunksForDocument(selectedDoc)
  }, [getAudiobookSaveChunksForDocument, selectedDoc, ttsSaveChunks])

  const handleReadDocument = useCallback(async () => {
    if (!selectedAudiobookState.complete) return

    const chunks = await getSelectedAudiobookSaveChunks()
    speakTts(chunks, {
      voice: ttsVoice,
      speed: ttsSpeed,
      dtype: ttsDtype,
      threadCount: ttsThreadCount,
      documentUrl: selectedDoc ?? undefined,
      title: selectedDoc ? getDocumentTitle(selectedDoc) : undefined,
    })
  }, [getDocumentTitle, getSelectedAudiobookSaveChunks, selectedAudiobookState.complete, selectedDoc, speakTts, ttsDtype, ttsSpeed, ttsThreadCount, ttsVoice])

  useEffect(() => {
    if (!selectedDoc || !selectedAudiobookState.complete) return

    markAudiobookSaved({
      documentUrl: selectedDoc,
      title: getDocumentTitle(selectedDoc),
      voice: ttsVoice,
      speed: ttsSpeed,
      dtype: ttsDtype,
      chunks: selectedAudiobookState.totalChunks,
      audioDurationSec: selectedAudiobookState.audioDurationSec,
      wavBytes: selectedAudiobookState.wavBytes,
    })
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSavedAudiobooks(getSavedAudiobooks())
  }, [getDocumentTitle, selectedAudiobookState.audioDurationSec, selectedAudiobookState.complete, selectedAudiobookState.totalChunks, selectedAudiobookState.wavBytes, selectedDoc, ttsDtype, ttsSpeed, ttsVoice])

  const startAudiobookSave = useCallback((input: {
    documentUrl: string
    title: string
    chunks: TtsChunk[]
    voice: KokoroVoice
    speed: number
    dtype: KokoroDtype
  }) => {
    const speakableChunks = input.chunks.filter((chunk) => chunk.text.trim())
    if (speakableChunks.length === 0) return

    // Queue state is persisted before the native save starts so interrupted saves can resume.
    scheduleAudiobookDownloadPersist({
      documentUrl: input.documentUrl,
      title: input.title,
      voice: input.voice,
      speed: input.speed,
      dtype: input.dtype,
      status: 'queued',
      cachedChunks: 0,
      totalChunks: speakableChunks.length,
      message: 'Queued',
      audioDurationSec: 0,
    }, true)
    setAudiobookDownload({ title: input.title, url: input.documentUrl, voice: input.voice, speed: input.speed, dtype: input.dtype })
    saveAudiobook(input.chunks, {
      voice: input.voice,
      speed: input.speed,
      dtype: input.dtype,
      threadCount: ttsThreadCount,
      documentUrl: input.documentUrl,
      title: input.title,
    })
  }, [saveAudiobook, scheduleAudiobookDownloadPersist, ttsThreadCount])

  const handleSaveAudiobook = useCallback(async () => {
    if (!selectedDoc) return

    startAudiobookSave({
      documentUrl: selectedDoc,
      title: getDocumentTitle(selectedDoc),
      chunks: await getSelectedAudiobookSaveChunks(),
      voice: ttsVoice,
      speed: ttsSpeed,
      dtype: ttsDtype,
    })
  }, [getDocumentTitle, getSelectedAudiobookSaveChunks, selectedDoc, startAudiobookSave, ttsDtype, ttsSpeed, ttsVoice])

  const handleResumeAudiobookDownload = useCallback(async (record: AudiobookDownloadRecord) => {
    startAudiobookSave({
      documentUrl: record.documentUrl,
      title: record.title,
      chunks: await getAudiobookSaveChunksForDocument(record.documentUrl),
      voice: record.voice,
      speed: record.speed,
      dtype: record.dtype,
    })
  }, [getAudiobookSaveChunksForDocument, startAudiobookSave])

  const handleCancelAudiobookSave = useCallback(() => {
    if (audiobookDownload) {
      scheduleAudiobookDownloadPersist({
        documentUrl: audiobookDownload.url,
        title: audiobookDownload.title,
        voice: audiobookDownload.voice,
        speed: audiobookDownload.speed,
        dtype: audiobookDownload.dtype,
        status: 'paused',
        cachedChunks: downloadAudiobookState.cachedChunks,
        totalChunks: downloadAudiobookState.totalChunks,
        message: 'Paused. Ready to resume.',
        audioDurationSec: downloadAudiobookState.audioDurationSec,
        wavBytes: downloadAudiobookState.wavBytes,
      }, true)
    }
    cancelAudiobookSave()
  }, [audiobookDownload, cancelAudiobookSave, downloadAudiobookState.audioDurationSec, downloadAudiobookState.cachedChunks, downloadAudiobookState.totalChunks, downloadAudiobookState.wavBytes, scheduleAudiobookDownloadPersist])

  const handleRemoveAudiobookDownload = useCallback((id: string) => {
    removeAudiobookDownload(id)
    refreshAudiobookDownloads()
  }, [refreshAudiobookDownloads])

  const handleExportSavedAudiobook = useCallback(async (record: SavedAudiobookRecord) => {
    setAudiobookExport({ id: record.id, status: 'exporting', message: 'Exporting bundle' })
    try {
      const chunks = await getAudiobookSaveChunksForDocument(record.documentUrl)
      const sourceHtml = await loadHtmlDocument(record.documentUrl)
      const result = await exportNativeAudiobook({
        documentUrl: record.documentUrl,
        title: record.title,
        sourceHtml,
        chunks,
        options: {
          voice: record.voice as KokoroVoice,
          speed: record.speed,
          dtype: record.dtype as KokoroDtype,
        },
      })
      setAudiobookExport({
        id: record.id,
        status: 'exported',
        message: formatAudiobookExportMessage(result.path),
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const cancelled = message.toLowerCase().includes('cancelled')
      setAudiobookExport({
        id: record.id,
        status: cancelled ? 'cancelled' : 'error',
        message: cancelled ? 'Export cancelled.' : message,
      })
    }
  }, [getAudiobookSaveChunksForDocument, loadHtmlDocument])

  const handleDeleteSavedAudiobook = useCallback(async (record: SavedAudiobookRecord) => {
    const deleteUserUpload = isUserUploadUrl(record.documentUrl)
    const confirmed = window.confirm(
      deleteUserUpload
        ? 'Delete this saved audiobook and imported User Upload from this device?'
        : 'Delete this saved audiobook audio from this device?',
    )
    if (!confirmed) return

    setAudiobookDelete({ id: record.id, status: 'deleting', message: 'Deleting saved audio' })
    try {
      const result = await deleteNativeAudiobook({
        audiobookId: record.id,
        documentUrl: record.documentUrl,
        deleteUserUpload,
      })

      removeSavedAudiobook(record.id)
      if (deleteUserUpload) removeUserUpload(record.documentUrl)
      setSavedAudiobooks(getSavedAudiobooks())
      onUserUploadsChanged()
      if (selectedDoc === record.documentUrl) {
        stopTts()
        resetSelectedAudiobookState()
        if (deleteUserUpload) {
          onClearDocument()
          setTtsSaveChunks(null)
        }
      }

      const storage = formatStorageSize(result.bytesFreed)
      setAudiobookDelete({
        id: record.id,
        status: 'deleted',
        message: storage ? 'Deleted saved audio and freed ' + storage + '.' : 'Deleted saved audio.',
      })
    } catch (err) {
      setAudiobookDelete({
        id: record.id,
        status: 'error',
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }, [onClearDocument, onUserUploadsChanged, resetSelectedAudiobookState, selectedDoc, stopTts])

  const importAudiobook = useCallback(async (openDocument: (url: string) => Promise<void>) => {
    setAudiobookImport({ status: 'importing', message: 'Importing audiobook bundle' })
    try {
      const result = await importNativeAudiobook()
      upsertUserUpload({
        url: result.documentUrl,
        title: result.title,
        voice: result.voice,
        speed: result.speed,
        dtype: result.dtype,
        chunks: result.chunks,
        audioDurationSec: result.audioDurationSec,
        wavBytes: result.wavBytes,
      })
      markAudiobookSaved({
        documentUrl: result.documentUrl,
        title: result.title,
        voice: result.voice,
        speed: result.speed,
        dtype: result.dtype,
        chunks: result.chunks,
        audioDurationSec: result.audioDurationSec,
        wavBytes: result.wavBytes,
      })
      onUserUploadsChanged()
      setSavedAudiobooks(getSavedAudiobooks())
      setTtsVoice(result.voice as KokoroVoice)
      setTtsSpeed(result.speed)
      setAudiobookImport({ status: 'imported', message: 'Imported ' + result.title })
      await openDocument(result.documentUrl)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const cancelled = message.toLowerCase().includes('cancelled')
      setAudiobookImport({
        status: cancelled ? 'cancelled' : 'error',
        message: cancelled ? 'Import cancelled.' : message,
      })
    }
  }, [onUserUploadsChanged])

  const openSavedAudiobook = useCallback(async (record: SavedAudiobookRecord, openDocument: (url: string) => Promise<void>) => {
    setTtsVoice(record.voice as KokoroVoice)
    setTtsSpeed(record.speed)
    await openDocument(record.documentUrl)
  }, [])

  const includeDocumentInList = useCallback((doc: DocumentInfo) => (
    !audioSavedOnly || savedAudiobookIds.has(createAudiobookId(doc.url, { voice: ttsVoice, speed: ttsSpeed, dtype: ttsDtype }))
  ), [audioSavedOnly, savedAudiobookIds, ttsDtype, ttsSpeed, ttsVoice])

  const filterResults = useCallback((results: SearchResult[]) => (
    audioSavedOnly
      ? results.filter((result) => savedAudiobookIds.has(createAudiobookId(result.url, { voice: ttsVoice, speed: ttsSpeed, dtype: ttsDtype })))
      : results
  ), [audioSavedOnly, savedAudiobookIds, ttsDtype, ttsSpeed, ttsVoice])

  const ttsIsNavigable = ttsState.status === 'playing' ||
    ttsState.status === 'loading' ||
    ttsState.status === 'paused'
  const ttsCurrentChunkIndex = ttsState.pendingChunkIndex ?? ttsState.currentChunkIndex ?? ttsState.chunksPlayed
  const ttsCanSkipBackward = ttsIsNavigable && ttsCurrentChunkIndex > 0
  const ttsCanSkipForward = ttsIsNavigable &&
    ttsState.chunksTotal > 0 &&
    ttsCurrentChunkIndex < ttsState.chunksTotal - 1
  const selectedAudiobookId = selectedDoc
    ? createAudiobookDownloadId(selectedDoc, { voice: ttsVoice, speed: ttsSpeed, dtype: ttsDtype })
    : null
  const activeDownloadId = audiobookDownload
    ? createAudiobookDownloadId(audiobookDownload.url, { voice: audiobookDownload.voice, speed: audiobookDownload.speed, dtype: audiobookDownload.dtype })
    : null
  const downloadIsForSelectedDoc = Boolean(selectedAudiobookId && activeDownloadId === selectedAudiobookId)
  const activeDownloadIsRunning = downloadAudiobookState.status === 'checking' ||
    downloadAudiobookState.status === 'saving'
  const audioControlsAudiobookState = downloadIsForSelectedDoc && downloadAudiobookState.status !== 'idle'
    ? downloadAudiobookState
    : selectedAudiobookState
  const isDifferentAudiobookSaving = Boolean(
    activeDownloadId &&
    activeDownloadId !== selectedAudiobookId &&
    activeDownloadIsRunning,
  )
  const canSaveAudiobook = audioControlsAudiobookState.status !== 'checking' &&
    !isDifferentAudiobookSaving
  const isSavingAudiobook = activeDownloadIsRunning
  const activeDownloadTitle = audiobookDownload?.title ?? 'Audiobook'
  const queuedAudiobookDownloads = audiobookDownloads.filter((record) => (
    !(activeDownloadIsRunning && activeDownloadId === record.id)
  ))
  const visibleSavedAudiobooks = savedAudiobooks.slice().sort((a, b) => b.savedAt - a.savedAt)

  return {
    audioControlsProps: {
      audiobookState: audioControlsAudiobookState,
      canPlayAudiobook: audioControlsAudiobookState.complete,
      canSaveAudiobook,
      canSkipBackward: ttsCanSkipBackward,
      canSkipForward: ttsCanSkipForward,
      isPdf: false,
      saveInProgress: downloadIsForSelectedDoc && activeDownloadIsRunning,
      onCancelSave: handleCancelAudiobookSave,
      onPause: pauseTts,
      onRead: handleReadDocument,
      onResume: resumeTts,
      onJumpToChunk: jumpTtsToChunk,
      onSave: handleSaveAudiobook,
      onSkipBackward: skipTtsBackward,
      onSkipForward: skipTtsForward,
      onStop: stopTts,
      playbackDurationSec: audioControlsAudiobookState.audioDurationSec,
      ttsState,
    },
    audioSetupProps: {
      modelInstallProgress: ttsModelProgress,
      modelStatus: ttsModelStatus,
      onInstallModel: handleInstallTtsModel,
      onSpeedChange: setTtsSpeed,
      onThreadCountChange: setTtsThreadCount,
      onVoiceChange: setTtsVoice,
      speed: ttsSpeed,
      threadCount: ttsThreadCount,
      voice: ttsVoice,
      voices: ttsState.voices,
    },
    audiobookImport,
    audioSavedOnly,
    closeDocumentAudio,
    audiobooksPanelProps: {
      activeDownload: audiobookDownload,
      activeDownloadTitle,
      deleteState: audiobookDelete,
      downloadState: downloadAudiobookState,
      exportState: audiobookExport,
      isSaving: isSavingAudiobook,
      queuedDownloads: queuedAudiobookDownloads,
      savedAudiobooks: visibleSavedAudiobooks,
      onCancelSave: handleCancelAudiobookSave,
      onDeleteSaved: handleDeleteSavedAudiobook,
      onExportSaved: handleExportSavedAudiobook,
      onRemoveQueued: handleRemoveAudiobookDownload,
      onResumeQueued: handleResumeAudiobookDownload,
    },
    filterResults,
    hasFloatingAudioControls: ttsIsNavigable,
    importAudiobook,
    includeDocumentInList,
    openSavedAudiobook,
    prepareDocumentOpen,
    setAudioSavedOnly,
    ttsHighlight: {
      enabled: Boolean(ttsState.currentText),
      currentChunkIndex: ttsState.currentChunkIndex,
      chunkTexts: ttsState.chunkTexts,
    },
  }
}

function audiobookSaveChunksFromHtml(html: string): TtsChunk[] {
  return buildRuntimeChunks(chunkAudiobookSaveHtml(html), 'save-c')
}

function buildRuntimeChunks(texts: string[], prefix: string): TtsChunk[] {
  return texts.map((chunk, index) => ({
    id: prefix + String(index + 1).padStart(5, '0'),
    text: chunk,
  }))
}
