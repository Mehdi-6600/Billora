/** Message contract between the main thread and `shenava.worker.ts`. */

export interface ShenavaMetrics {
  /** Audio length handed to the engine, in milliseconds. */
  audioMs: number
  featureMs: number
  encoderMs: number
  decodeMs: number
  totalMs: number
  featureFrames: number
  encoderFrames: number
  tokens: number
  firstTokenMs: number | null
}

export interface ShenavaEngineInfo {
  /** Encoder metadata: vocabulary size including the blank token. */
  vocabSize: number
  blankId: number
  subsamplingFactor: number
  predRnnLayers: number
  predHidden: number
  encoderDim: number
  /** Number of ONNX Runtime threads actually used (1 unless the page is cross-origin isolated). */
  threads: number
  crossOriginIsolated: boolean
  hardwareConcurrency: number
  /** Sources the model bytes came from, for diagnostics. */
  sources: Record<string, 'cache' | 'network' | 'hub'>
}

export type ShenavaWorkerRequest =
  | {
      type: 'init'
      baseUrl: string
      /** Absolute `location.href` used to resolve the paths below (workers reject relative bases). */
      baseHref?: string
      modelBaseUrl?: string
      /** Same-origin file name → upstream URL, used only when the local file is absent. */
      remoteModelUrls?: Record<string, string>
      useCache: boolean
      threads: number
    }
  | { type: 'transcribe'; id: number; pcm: Float32Array }
  | { type: 'dispose' }

export type ShenavaWorkerResponse =
  | { type: 'ready'; info: ShenavaEngineInfo }
  | { type: 'init-error'; code: string; message: string }
  | { type: 'result'; id: number; text: string; tokenIds: number[]; metrics: ShenavaMetrics }
  | { type: 'decode-error'; id: number; message: string }
  | { type: 'disposed' }

export type ShenavaErrorCode =
  | 'unsupported'
  | 'model-missing'
  | 'init-failed'
  | 'not-initialized'
  | 'busy'
  | 'decode-failed'
  | 'empty-audio'

export class ShenavaError extends Error {
  constructor(readonly code: ShenavaErrorCode, message: string) {
    super(message)
    this.name = 'ShenavaError'
  }
}
