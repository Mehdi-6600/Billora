/**
 * React owner for one offline speech session: model probing, lazy engine start, microphone
 * capture, transcription and the Persian status copy. The command pipeline is untouched — the hook
 * only produces a transcript string, exactly like `PersianSpeechSession` does for Web Speech.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createMicCapture, type MicCapture, type MicCaptureFactory } from './audioCapture'
import { OFFLINE_SPEECH_MESSAGES, captureErrorMessage } from './offlineSpeechMessages'
import { ShenavaRecognizer, type ShenavaTranscript } from './ShenavaRecognizer'
import { shenavaRuntimeSupported, type ShenavaModelAvailability } from './shenavaModel'
import type { ShenavaMetrics } from './shenavaProtocol'

export type OfflineSpeechStatus =
  | 'unsupported'
  | 'checking'
  | 'unavailable'
  | 'ready'
  | 'preparing'
  | 'listening'
  | 'transcribing'
  | 'result'
  | 'error'

export interface OfflineSpeechOptions {
  onTranscript: (text: string) => void
  baseUrl?: string
  createRecognizer?: () => ShenavaRecognizer
  captureFactory?: MicCaptureFactory
  probe?: () => Promise<ShenavaModelAvailability>
  /** Allow the one-time download from the remote copy when the files are not installed. */
  allowRemoteModel?: boolean
  hubEndpoint?: string
  /** Directory holding the remote copies (GitHub Release, Vercel Blob, R2, …). */
  remoteBaseUrl?: string | null
  /** Post-processing of the raw transcript (the editor applies parser-guarded Persian ITN). */
  transformTranscript?: (text: string) => string
  /** Skips the initial HEAD probe; used by the standalone diagnostic page. */
  skipProbe?: boolean
}

export interface OfflineSpeechState {
  supported: boolean
  /** `null` while the probe is running. */
  available: boolean | null
  status: OfflineSpeechStatus
  message: string
  missingFiles: string[]
  metrics: ShenavaMetrics | null
  crossOriginIsolated: boolean
  /** Where the model bytes come from: the app itself, a one-time download, or a mix of both. */
  modelSource: 'local' | 'hub' | 'mixed' | null
  /** True once the engine has been initialized at least once this session — subsequent starts are fast. */
  initializedOnce: boolean
  canStart: boolean
  start: () => void
  stop: () => void
  cancel: () => void
  progressSeconds: number
}

function isIsolated(): boolean {
  return typeof globalThis.crossOriginIsolated === 'boolean' ? globalThis.crossOriginIsolated : false
}

// The offline engine is a heavy wasm blob; once it has successfully initialized in this tab, subsequent
// starts (even after unmounting the editor) are essentially instant. Track this at module scope so the
// "first load" copy only appears once per page lifetime, not every time the user reopens the editor.
let engineInitializedThisSession = false

export function useOfflineSpeech(options: OfflineSpeechOptions): OfflineSpeechState {
  const [status, setStatus] = useState<OfflineSpeechStatus>('checking')
  const [message, setMessage] = useState<string>('')
  const [available, setAvailable] = useState<boolean | null>(null)
  const [missingFiles, setMissingFiles] = useState<string[]>([])
  const [metrics, setMetrics] = useState<ShenavaMetrics | null>(null)
  const [modelSource, setModelSource] = useState<'local' | 'hub' | 'mixed' | null>(null)
  const [progressSeconds, setProgressSeconds] = useState(0)

  const recognizerRef = useRef<ShenavaRecognizer | null>(null)
  const captureRef = useRef<MicCapture | null>(null)
  const statusRef = useRef<OfflineSpeechStatus>('checking')
  const mountedRef = useRef(true)
  const optionsRef = useRef(options)
  optionsRef.current = options

  // An injected engine factory (tests, the diagnostic page) owns its own environment check.
  const hasInjectedRecognizer = Boolean(options.createRecognizer)
  const supported = useMemo(
    () => hasInjectedRecognizer || shenavaRuntimeSupported(),
    [hasInjectedRecognizer],
  )

  const applyStatus = useCallback((next: OfflineSpeechStatus, nextMessage?: string) => {
    statusRef.current = next
    if (!mountedRef.current) return
    setStatus(next)
    if (nextMessage !== undefined) setMessage(nextMessage)
  }, [])

  const recognizer = useCallback(() => {
    if (!recognizerRef.current) {
      recognizerRef.current = optionsRef.current.createRecognizer
        ? optionsRef.current.createRecognizer()
        : new ShenavaRecognizer({
            baseUrl: optionsRef.current.baseUrl,
            allowRemoteModel: optionsRef.current.allowRemoteModel,
            hubEndpoint: optionsRef.current.hubEndpoint,
            remoteBaseUrl: optionsRef.current.remoteBaseUrl,
          })
    }
    return recognizerRef.current
  }, [])

  useEffect(() => {
    mountedRef.current = true
    if (!supported) {
      applyStatus('unsupported', OFFLINE_SPEECH_MESSAGES.unsupported)
      setAvailable(false)
      return () => { mountedRef.current = false }
    }

    if (!isIsolated()) {
      console.error('[Shenava] Cross-origin isolation missing. WASM will run on 1 thread.')
    }

    if (options.skipProbe) {
      applyStatus('unavailable', OFFLINE_SPEECH_MESSAGES.modelMissing)
      setAvailable(false)
      return () => { mountedRef.current = false }
    }

    applyStatus('checking', OFFLINE_SPEECH_MESSAGES.checking)
    let cancelled = false
    const run = async () => {
      try {
        const result = options.probe ? await options.probe() : await recognizer().probe()
        if (cancelled) return
        setAvailable(result.available)
        setMissingFiles(result.missing)
        setModelSource(result.source ?? null)
        if (result.available) {
          // A remote model is downloaded once into the Cache API, then everything is offline.
          const readyMessage =
            result.source === 'hub'
              ? OFFLINE_SPEECH_MESSAGES.remoteModelDownload
              : result.source === 'mixed'
                ? OFFLINE_SPEECH_MESSAGES.remoteModelPartial
                : OFFLINE_SPEECH_MESSAGES.ready
          applyStatus('ready', readyMessage)
        } else {
          applyStatus('unavailable', `${OFFLINE_SPEECH_MESSAGES.modelMissing}${result.missing.length ? ` (${result.missing.join('، ')})` : ''}`)
        }
      } catch {
        if (cancelled) return
        setAvailable(false)
        applyStatus('unavailable', OFFLINE_SPEECH_MESSAGES.modelMissing)
      }
    }
    void run()

    return () => {
      cancelled = true
      mountedRef.current = false
      captureRef.current?.cancel()
      captureRef.current = null
      recognizerRef.current?.dispose()
      recognizerRef.current = null
    }
  }, [applyStatus, recognizer, supported, options.skipProbe, options.probe])

  const finish = useCallback((transcript: ShenavaTranscript) => {
    const text = transcript.text.trim()
    setMetrics(transcript.metrics)
    if (!text) {
      applyStatus('error', OFFLINE_SPEECH_MESSAGES.noSpeech)
      return
    }
    const transform = optionsRef.current.transformTranscript
    optionsRef.current.onTranscript(transform ? transform(text) : text)
    applyStatus('result', OFFLINE_SPEECH_MESSAGES.done)
  }, [applyStatus])

  const stopRef = useRef<(() => Promise<void>) | null>(null)

  const start = useCallback(() => {
    if (statusRef.current === 'listening') {
      void stopRef.current?.()
      return
    }
    if (statusRef.current === 'preparing' || statusRef.current === 'transcribing') {
      applyStatus(statusRef.current, OFFLINE_SPEECH_MESSAGES.busy)
      return
    }
    if (available === false) {
      applyStatus('unavailable', message || OFFLINE_SPEECH_MESSAGES.modelMissing)
      return
    }

    const begin = async () => {
      const engine = recognizer()
      if (engine.status !== 'ready') {
        // Only show the "first time" warning before the engine has ever finished init this session.
        // After that, init is instant and the long copy is misleading.
        applyStatus('preparing', engineInitializedThisSession
          ? OFFLINE_SPEECH_MESSAGES.preparing
          : OFFLINE_SPEECH_MESSAGES.preparingFirstTime)
        await engine.init()
        engineInitializedThisSession = true
      }
      const captureFactory = optionsRef.current.captureFactory ?? createMicCapture
      const capture = await captureFactory({
        onProgress: (sampleCount) => {
          if (mountedRef.current) setProgressSeconds(sampleCount / 16_000)
        },
      })
      captureRef.current = capture
      setProgressSeconds(0)
      applyStatus('listening', OFFLINE_SPEECH_MESSAGES.listening)
    }

    void begin().catch((error: unknown) => {
      const engine = recognizerRef.current
      if (engine && engine.status !== 'ready' && engine.status !== 'transcribing') {
        applyStatus('error', error instanceof Error && error.message.includes('آفلاین') ? error.message : OFFLINE_SPEECH_MESSAGES.initFailed)
        return
      }
      applyStatus('error', captureErrorMessage(error))
    })
  }, [applyStatus, available, message, recognizer])

  const stop = useCallback(async () => {
    const capture = captureRef.current
    if (!capture) return
    captureRef.current = null
    applyStatus('transcribing', OFFLINE_SPEECH_MESSAGES.transcribing)
    try {
      const pcm = await capture.stop()
      if (pcm.length < 1_600) {
        applyStatus('error', OFFLINE_SPEECH_MESSAGES.noAudio)
        return
      }
      const transcript = await recognizer().transcribe(pcm)
      if (mountedRef.current) finish(transcript)
    } catch (error) {
      if (mountedRef.current) {
        applyStatus('error', error instanceof Error && error.message ? error.message : OFFLINE_SPEECH_MESSAGES.decodeFailed)
      }
    }
  }, [applyStatus, finish, recognizer])

  stopRef.current = stop

  const cancel = useCallback(() => {
    captureRef.current?.cancel()
    captureRef.current = null
    applyStatus('ready', OFFLINE_SPEECH_MESSAGES.ready)
  }, [applyStatus])

  const handleStop = useCallback(() => {
    void stop()
  }, [stop])

  return {
    supported,
    available,
    status,
    message,
    missingFiles,
    metrics,
    crossOriginIsolated: isIsolated(),
    modelSource,
    initializedOnce: engineInitializedThisSession,
    canStart: available === true,
    start,
    stop: handleStop,
    cancel,
    progressSeconds,
  }
}
