/**
 * Main-thread facade for the Shenava Koochik v1.5 offline engine.
 *
 * The recognizer never touches ONNX Runtime itself: it owns the worker, validates that the model
 * is actually installed, forwards micro-buffers for transcription and reports metrics. It is
 * deliberately free of DOM/React dependencies so it can be unit-tested with a fake worker.
 */

import { OFFLINE_SPEECH_MESSAGES, describeMissingFiles } from './offlineSpeechMessages'
import {
  probeShenavaModel,
  shenavaHubUrl,
  shenavaModelUrl,
  shenavaRuntimeSupported,
  SHENAVA_HUB_ENDPOINT,
  SHENAVA_MODEL_FILES,
  type ShenavaModelAvailability,
} from './shenavaModel'
import {
  ShenavaError,
  type ShenavaEngineInfo,
  type ShenavaMetrics,
  type ShenavaWorkerRequest,
  type ShenavaWorkerResponse,
} from './shenavaProtocol'

export type ShenavaRecognizerStatus =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'transcribing'
  | 'error'
  | 'disposed'
  | 'unsupported'

export interface ShenavaTranscript {
  /** Raw SentencePiece decoding of the recognized tokens. */
  text: string
  tokenIds: number[]
  metrics: ShenavaMetrics
}

export interface ShenavaRecognizerOptions {
  /** Vite base URL (`import.meta.env.BASE_URL`); used to build same-origin model URLs. */
  baseUrl?: string
  /** Absolute directory that holds the model files; overrides `baseUrl` when provided. */
  modelBaseUrl?: string
  createWorker?: () => Worker
  fetcher?: typeof fetch
  /**
   * Fetch the model from the Hugging Face copy when it is not installed next to the app.
   * Model weights only — it never sends audio anywhere. Disable to stay strictly same-origin.
   */
  allowRemoteModel?: boolean
  /** Overrides `https://huggingface.co` (mirrors, private staging). */
  hubEndpoint?: string
  useCache?: boolean
  /** Thread count handed to ONNX Runtime Web; forced to 1 without cross-origin isolation. */
  threads?: number
  logger?: (message: string, details?: Record<string, unknown>) => void
}

const INIT_TIMEOUT_MS = 10 * 60 * 1000
const TRANSCRIBE_TIMEOUT_MS = 5 * 60 * 1000

interface PendingJob {
  resolve: (response: Extract<ShenavaWorkerResponse, { type: 'result' }>) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

function defaultThreads(): number {
  const isolated = typeof globalThis.crossOriginIsolated === 'boolean' ? globalThis.crossOriginIsolated : false
  if (!isolated) return 1
  const hardware = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency ?? 1 : 1
  return Math.max(1, Math.min(4, hardware))
}

export class ShenavaRecognizer {
  private worker: Worker | null = null
  private currentStatus: ShenavaRecognizerStatus = 'idle'
  private engineInfo: ShenavaEngineInfo | null = null
  private metrics: ShenavaMetrics | null = null
  private nextId = 1
  private readonly jobs = new Map<number, PendingJob>()
  private initPromise: Promise<ShenavaEngineInfo> | null = null
  private initResolve: ((info: ShenavaEngineInfo) => void) | null = null
  private initReject: ((error: Error) => void) | null = null
  private initTimer: ReturnType<typeof setTimeout> | null = null
  private readonly log: (message: string, details?: Record<string, unknown>) => void

  constructor(private readonly options: ShenavaRecognizerOptions = {}) {
    this.log = options.logger ?? ((message, details) => console.info(message, details ?? ''))
  }

  get status(): ShenavaRecognizerStatus {
    return this.currentStatus
  }

  get info(): ShenavaEngineInfo | null {
    return this.engineInfo
  }

  get lastMetrics(): ShenavaMetrics | null {
    return this.metrics
  }

  /** `local` when the app serves the files, `hub` when they must be downloaded once. */
  get modelSource(): 'local' | 'hub' | null {
    return this.availability?.source ?? null
  }

  private availability: ShenavaModelAvailability | null = null

  /**
   * True when the engine can run here. An explicitly injected worker factory (tests, the
   * diagnostic page) always counts as supported, because the caller owns the environment check.
   */
  isSupported(): boolean {
    if (this.options.createWorker) return true
    return shenavaRuntimeSupported()
  }

  /** Checks the four model files without touching the (large) engine. */
  probe(): Promise<ShenavaModelAvailability> {
    const fetcher = this.options.fetcher
    return probeShenavaModel(
      fetcher ?? (globalThis.fetch as unknown as Parameters<typeof probeShenavaModel>[0]),
      this.options.baseUrl ?? '/',
      undefined,
      this.isSupported(),
      { allowRemote: this.allowRemoteModel(), hubEndpoint: this.options.hubEndpoint },
    )
  }

  private allowRemoteModel(): boolean {
    return this.options.allowRemoteModel ?? true
  }

  /** File name → upstream URL, handed to the worker so it can fall back when a file is absent. */
  private remoteModelUrls(): Record<string, string> | undefined {
    if (!this.allowRemoteModel()) return undefined
    const endpoint = this.options.hubEndpoint ?? SHENAVA_HUB_ENDPOINT
    return Object.fromEntries(SHENAVA_MODEL_FILES.map((file) => [file.name, shenavaHubUrl(file.name, endpoint)]))
  }

  async init(): Promise<ShenavaEngineInfo> {
    if (this.currentStatus === 'disposed') throw new ShenavaError('init-failed', 'engine was disposed')
    if (this.initPromise) return this.initPromise

    this.initPromise = this.performInit().catch((error: unknown) => {
      this.initPromise = null
      const shenavaError = error instanceof ShenavaError
        ? error
        : new ShenavaError('init-failed', OFFLINE_SPEECH_MESSAGES.initFailed)
      // Keep «unsupported» (missing runtime/model) distinct from a real initialisation failure.
      if (shenavaError.code !== 'unsupported' && shenavaError.code !== 'model-missing') this.setStatus('error')
      throw shenavaError
    })
    return this.initPromise
  }

  private async performInit(): Promise<ShenavaEngineInfo> {
    if (!this.isSupported()) {
      this.setStatus('unsupported')
      throw new ShenavaError('unsupported', OFFLINE_SPEECH_MESSAGES.unsupported)
    }

    const availability = await this.probe()
    this.availability = availability
    if (!availability.available) {
      this.setStatus('unsupported')
      throw new ShenavaError('model-missing', describeMissingFiles(availability.missing))
    }

    this.setStatus('loading')
    const worker = this.options.createWorker
      ? this.options.createWorker()
      : new Worker(new URL('./shenava.worker.ts', import.meta.url), { type: 'module', name: 'shenava-worker' })
    this.worker = worker

    return await new Promise<ShenavaEngineInfo>((resolve, reject) => {
      this.initResolve = resolve
      this.initReject = reject
      worker.onmessage = (event: MessageEvent<ShenavaWorkerResponse>) => this.handleMessage(event.data)
      worker.onerror = (event: ErrorEvent) => {
        this.failAll(new ShenavaError('init-failed', `${OFFLINE_SPEECH_MESSAGES.initFailed} (${event.message || 'worker error'})`))
      }
      this.initTimer = setTimeout(() => {
        this.failAll(new ShenavaError('init-failed', OFFLINE_SPEECH_MESSAGES.initFailed))
      }, INIT_TIMEOUT_MS)

      const request: ShenavaWorkerRequest = {
        type: 'init',
        baseUrl: this.options.baseUrl ?? '/',
        modelBaseUrl: this.options.modelBaseUrl ?? this.modelDirectoryUrl(),
        remoteModelUrls: this.remoteModelUrls(),
        useCache: this.options.useCache ?? true,
        threads: this.options.threads ?? defaultThreads(),
      }
      worker.postMessage(request)
    })
  }

  private modelDirectoryUrl(): string {
    const base = this.options.baseUrl ?? '/'
    const encoded = shenavaModelUrl('tokens.txt', base)
    return encoded.slice(0, encoded.lastIndexOf('/') + 1)
  }

  private handleMessage(message: ShenavaWorkerResponse): void {
    if (message.type === 'ready') {
      if (this.initTimer !== null) clearTimeout(this.initTimer)
      this.initTimer = null
      this.engineInfo = message.info
      this.setStatus('ready')
      this.log('[Shenava] engine ready', {
        ...message.info,
        hardwareConcurrency: message.info.hardwareConcurrency,
      })
      if (!message.info.crossOriginIsolated) {
        this.log('[Shenava] Cross-origin isolation missing. WASM runs on a single thread.', {
          threads: message.info.threads,
        })
      }
      this.initResolve?.(message.info)
      this.initResolve = null
      this.initReject = null
      return
    }

    if (message.type === 'init-error') {
      this.failAll(new ShenavaError('init-failed', `${OFFLINE_SPEECH_MESSAGES.initFailed} ${message.message}`.trim()))
      return
    }

    if (message.type === 'result') {
      const job = this.jobs.get(message.id)
      if (!job) return
      this.jobs.delete(message.id)
      clearTimeout(job.timer)
      this.metrics = message.metrics
      this.log('[Shenava] inference', {
        ...message.metrics,
        crossOriginIsolated: this.engineInfo?.crossOriginIsolated ?? false,
        hardwareConcurrency: this.engineInfo?.hardwareConcurrency ?? null,
      })
      this.setStatus('ready')
      job.resolve(message)
      return
    }

    if (message.type === 'decode-error') {
      const job = this.jobs.get(message.id)
      if (job) {
        this.jobs.delete(message.id)
        clearTimeout(job.timer)
        this.setStatus('ready')
        job.reject(new ShenavaError('decode-failed', `${OFFLINE_SPEECH_MESSAGES.decodeFailed} ${message.message}`.trim()))
      }
      return
    }

    if (message.type === 'disposed') {
      this.worker = null
      this.setStatus('disposed')
    }
  }

  private failAll(error: Error): void {
    if (this.initTimer !== null) clearTimeout(this.initTimer)
    this.initTimer = null
    this.initReject?.(error)
    this.initResolve = null
    this.initReject = null
    for (const [id, job] of this.jobs) {
      clearTimeout(job.timer)
      this.jobs.delete(id)
      job.reject(error)
    }
    this.setStatus('error')
  }

  private setStatus(status: ShenavaRecognizerStatus): void {
    this.currentStatus = status
  }

  /** Transcribes 16 kHz mono PCM. Rejects with `Not initialized` until `init()` has resolved. */
  async transcribe(pcm: Float32Array): Promise<ShenavaTranscript> {
    if (!this.worker || !this.engineInfo || this.currentStatus === 'disposed' || this.currentStatus === 'idle') {
      throw new ShenavaError('not-initialized', 'Not initialized')
    }
    if (pcm.length === 0) throw new ShenavaError('empty-audio', OFFLINE_SPEECH_MESSAGES.noAudio)
    if (this.jobs.size > 0) throw new ShenavaError('busy', OFFLINE_SPEECH_MESSAGES.busy)

    const id = this.nextId
    this.nextId += 1
    this.setStatus('transcribing')

    const response = await new Promise<Extract<ShenavaWorkerResponse, { type: 'result' }>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.jobs.delete(id)
        reject(new ShenavaError('decode-failed', OFFLINE_SPEECH_MESSAGES.decodeFailed))
      }, TRANSCRIBE_TIMEOUT_MS)
      this.jobs.set(id, { resolve, reject, timer })
      const request: ShenavaWorkerRequest = { type: 'transcribe', id, pcm }
      this.worker?.postMessage(request, [pcm.buffer])
    })

    return { text: response.text, tokenIds: response.tokenIds, metrics: response.metrics }
  }

  dispose(): void {
    const worker = this.worker
    this.worker = null
    for (const [id, job] of this.jobs) {
      clearTimeout(job.timer)
      this.jobs.delete(id)
      job.reject(new ShenavaError('decode-failed', OFFLINE_SPEECH_MESSAGES.decodeFailed))
    }
    if (this.initTimer !== null) clearTimeout(this.initTimer)
    this.initTimer = null
    this.initReject?.(new ShenavaError('init-failed', 'engine was disposed'))
    this.initResolve = null
    this.initReject = null
    this.initPromise = null
    this.engineInfo = null
    this.setStatus('disposed')
    try {
      worker?.postMessage({ type: 'dispose' } satisfies ShenavaWorkerRequest)
      worker?.terminate()
    } catch {
      // Terminating an already-dead worker is fine.
    }
  }
}
