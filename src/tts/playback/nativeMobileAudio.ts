import type {
  NativeAudioSetSourcePayload,
  NativeAudioState,
} from 'tauri-plugin-native-audio-api'

let initializePromise: Promise<NativeAudioState> | null = null
let lifecyclePromise: Promise<void> = Promise.resolve()

async function loadPlugin() {
  return import('tauri-plugin-native-audio-api')
}

function runLifecycleOperation<T>(operation: () => Promise<T>): Promise<T> {
  const result = lifecyclePromise.catch(() => {}).then(operation)
  lifecyclePromise = result.then(() => undefined, () => undefined)
  return result
}

export function initializeNativeAudio(): Promise<NativeAudioState> {
  initializePromise ??= runLifecycleOperation(async () => {
    const plugin = await loadPlugin()
    return plugin.initialize()
  })
  return initializePromise
}

export async function setNativeAudioSource(payload: NativeAudioSetSourcePayload): Promise<NativeAudioState> {
  await initializeNativeAudio()
  return runLifecycleOperation(async () => {
    const plugin = await loadPlugin()
    return plugin.setSource(payload)
  })
}

export async function playNativeAudio(): Promise<NativeAudioState> {
  const plugin = await loadPlugin()
  return plugin.play()
}

export async function pauseNativeAudio(): Promise<NativeAudioState> {
  const plugin = await loadPlugin()
  return plugin.pause()
}

export async function seekNativeAudio(position: number): Promise<NativeAudioState> {
  const plugin = await loadPlugin()
  return plugin.seekTo(position)
}

export async function getNativeAudioState(): Promise<NativeAudioState> {
  const plugin = await loadPlugin()
  return plugin.getState()
}

export function stopNativeAudio(): Promise<void> {
  return runLifecycleOperation(async () => {
    const plugin = await loadPlugin()
    await plugin.pause()
    await plugin.seekTo(0)
  })
}

export function disposeNativeAudio(): Promise<void> {
  initializePromise = null
  return runLifecycleOperation(async () => {
    const plugin = await loadPlugin()
    await plugin.dispose()
  })
}

export async function listenNativeAudioState(
  handler: (state: NativeAudioState) => void,
): Promise<() => void> {
  const plugin = await loadPlugin()
  const registration: unknown = await plugin.addStateListener(handler)
  if (typeof registration === 'function') return registration as () => void
  if (isPluginListener(registration)) {
    return () => {
      void registration.unregister().catch(() => {})
    }
  }
  throw new Error('Native audio listener registration returned an unsupported handle')
}

export type { NativeAudioState }

function isPluginListener(value: unknown): value is { unregister: () => Promise<void> } {
  return typeof value === 'object' &&
    value !== null &&
    'unregister' in value &&
    typeof value.unregister === 'function'
}
