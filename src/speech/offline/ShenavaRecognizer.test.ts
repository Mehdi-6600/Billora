import { afterEach, describe, expect, it, vi } from 'vitest'
import { ShenavaRecognizer } from './ShenavaRecognizer'
import { SHENAVA_MODEL_FILES } from './shenavaModel'
import { ShenavaError, type ShenavaEngineInfo, type ShenavaWorkerRequest, type ShenavaWorkerResponse } from './shenavaProtocol'

interface FakeResponse {
  ok: boolean
  status: number
  headers: { get(name: string): string | null }
}

function okResponse(bytes: number): FakeResponse {
  const headers = new Map<string, string>([['content-length', String(bytes)]])
  return { ok: true, status: 200, headers: { get: (name) => headers.get(name.toLowerCase()) ?? null } }
}

/** The engine's probe only looks at sizes, so a fake fetcher is enough to "install" the model. */
function installedModelFetcher(): ReturnType<typeof vi.fn> {
  return vi.fn(async (url: string) => {
    const file = SHENAVA_MODEL_FILES.find((entry) => url.endsWith(entry.name))
    return file ? okResponse(file.bytes) : { ok: false, status: 404, headers: { get: () => null } }
  })
}

class FakeWorker {
  static instances: FakeWorker[] = []
  onmessage: ((event: MessageEvent<ShenavaWorkerResponse>) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  posted: ShenavaWorkerRequest[] = []
  terminated = false

  constructor() {
    FakeWorker.instances.push(this)
  }

  postMessage(message: ShenavaWorkerRequest): void {
    this.posted.push(message)
  }

  terminate(): void {
    this.terminated = true
  }

  emit(message: ShenavaWorkerResponse): void {
    this.onmessage?.({ data: message } as MessageEvent<ShenavaWorkerResponse>)
  }
}

const ENGINE_INFO: ShenavaEngineInfo = {
  vocabSize: 1025,
  blankId: 1024,
  subsamplingFactor: 8,
  predRnnLayers: 1,
  predHidden: 640,
  encoderDim: 512,
  threads: 1,
  crossOriginIsolated: false,
  hardwareConcurrency: 4,
  sources: {
    'encoder.int8.onnx': 'cache',
    'decoder.int8.onnx': 'cache',
    'joiner.int8.onnx': 'cache',
    'tokens.txt': 'network',
  },
}

const METRICS = {
  audioMs: 1_200,
  featureMs: 12,
  encoderMs: 700,
  decodeMs: 90,
  totalMs: 810,
  featureFrames: 121,
  encoderFrames: 16,
  tokens: 6,
  firstTokenMs: 4,
}

function createRecognizer(overrides: { fetcher?: ReturnType<typeof vi.fn> } = {}) {
  const logger = vi.fn()
  const fetcher = overrides.fetcher ?? installedModelFetcher()
  const recognizer = new ShenavaRecognizer({
    baseUrl: '/',
    createWorker: () => new FakeWorker() as unknown as Worker,
    fetcher: fetcher as unknown as typeof fetch,
    logger,
  })
  return { recognizer, fetcher, logger }
}

const flush = () => new Promise<void>((resolve) => { setTimeout(resolve, 0) })

async function readyRecognizer() {
  const context = createRecognizer()
  const initPromise = context.recognizer.init()
  await flush()
  const worker = FakeWorker.instances.at(-1)!
  expect(worker.posted[0]).toMatchObject({ type: 'init', useCache: true, threads: 1 })
  worker.emit({ type: 'ready', info: ENGINE_INFO })
  await expect(initPromise).resolves.toMatchObject({ blankId: 1024 })
  return { ...context, worker }
}

afterEach(() => {
  FakeWorker.instances = []
  vi.restoreAllMocks()
})

describe('ShenavaRecognizer: راه‌اندازی و گاردهای خطا', () => {
  it('پیش از init، transcribe با پیام Not initialized رد می‌شود', async () => {
    const { recognizer } = createRecognizer()
    await expect(recognizer.transcribe(new Float32Array(16_000))).rejects.toThrow('Not initialized')
    recognizer.dispose()
  })

  it('اگر فایل‌های مدل نصب نباشند، init با کد model-missing رد می‌شود و Worker ساخته نمی‌شود', async () => {
    const fetcher = vi.fn(async () => ({ ok: false, status: 404, headers: { get: () => null } }))
    const { recognizer } = createRecognizer({ fetcher })
    await expect(recognizer.init()).rejects.toMatchObject({ code: 'model-missing' })
    await expect(recognizer.init()).rejects.toBeInstanceOf(ShenavaError)
    expect(FakeWorker.instances).toHaveLength(0)
    expect(recognizer.status).toBe('unsupported')
    recognizer.dispose()
  })

  it('با مدل نصب‌شده و Worker شبیه‌سازی‌شده، init بدون خطا تمام می‌شود', async () => {
    const { recognizer, logger } = await readyRecognizer()
    expect(recognizer.status).toBe('ready')
    expect(recognizer.info).toMatchObject({ vocabSize: 1025, threads: 1 })
    expect(logger).toHaveBeenCalledWith('[Shenava] engine ready', expect.anything())
    expect(logger).toHaveBeenCalledWith(
      '[Shenava] Cross-origin isolation missing. WASM runs on a single thread.',
      expect.anything(),
    )
    recognizer.dispose()
  })

  it('خطای init از سمت Worker پیام فارسی می‌دهد', async () => {
    const { recognizer } = createRecognizer()
    const initPromise = recognizer.init()
    await flush()
    FakeWorker.instances.at(-1)!.emit({ type: 'init-error', code: 'init-failed', message: 'onnxruntime: bad model' })

    await expect(initPromise).rejects.toMatchObject({ code: 'init-failed' })
    await expect(initPromise).rejects.toThrow(/راه‌اندازی موتور تشخیص گفتار آفلاین ناموفق بود/)
    recognizer.dispose()
  })
})

describe('ShenavaRecognizer: تبدیل گفتار به متن', () => {
  it('متن، شناسهٔ توکن‌ها و متریک‌ها را برمی‌گرداند و وضعیت را به ready برمی‌گرداند', async () => {
    const { recognizer, worker, logger } = await readyRecognizer()
    const pcm = new Float32Array(16_000)
    const promise = recognizer.transcribe(pcm)
    await flush()
    const request = worker.posted.find((entry) => entry.type === 'transcribe')!
    expect(request).toMatchObject({ type: 'transcribe', id: 1 })
    expect(recognizer.status).toBe('transcribing')

    worker.emit({ type: 'result', id: 1, text: 'سلام حال شما خوبه', tokenIds: [1, 2, 3], metrics: METRICS })
    await expect(promise).resolves.toMatchObject({ text: 'سلام حال شما خوبه', tokenIds: [1, 2, 3] })
    expect(recognizer.status).toBe('ready')
    expect(recognizer.lastMetrics).toMatchObject({ totalMs: 810, encoderFrames: 16 })
    expect(logger).toHaveBeenCalledWith('[Shenava] inference', expect.objectContaining({ tokens: 6 }))
    recognizer.dispose()
  })

  it('صوت خالی بدون فرستادن پیام به Worker رد می‌شود', async () => {
    const { recognizer, worker } = await readyRecognizer()
    await expect(recognizer.transcribe(new Float32Array(0))).rejects.toMatchObject({ code: 'empty-audio' })
    expect(worker.posted.some((entry) => entry.type === 'transcribe')).toBe(false)
    recognizer.dispose()
  })

  it('درخواست هم‌زمان دوم با کد busy رد می‌شود', async () => {
    const { recognizer, worker } = await readyRecognizer()
    const first = recognizer.transcribe(new Float32Array(16_000))
    await flush()
    await expect(recognizer.transcribe(new Float32Array(16_000))).rejects.toMatchObject({ code: 'busy' })

    worker.emit({ type: 'result', id: 1, text: 'x', tokenIds: [], metrics: METRICS })
    await first
    recognizer.dispose()
  })

  it('خطای دیکود از سمت Worker به پیام فارسی تبدیل می‌شود', async () => {
    const { recognizer, worker } = await readyRecognizer()
    const promise = recognizer.transcribe(new Float32Array(16_000))
    await flush()
    worker.emit({ type: 'decode-error', id: 1, message: 'encoder failed' })
    await expect(promise).rejects.toMatchObject({ code: 'decode-failed' })
    expect(recognizer.status).toBe('ready')
    recognizer.dispose()
  })

  it('dispose پردازش در جریان را رد می‌کند و Worker را خاتمه می‌دهد', async () => {
    const { recognizer, worker } = await readyRecognizer()
    const promise = recognizer.transcribe(new Float32Array(16_000))
    await flush()
    recognizer.dispose()
    await expect(promise).rejects.toBeInstanceOf(ShenavaError)
    expect(worker.terminated).toBe(true)
    expect(recognizer.status).toBe('disposed')
    await expect(recognizer.transcribe(new Float32Array(16_000))).rejects.toThrow('Not initialized')
  })
})
