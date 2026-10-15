// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useOfflineSpeech, type OfflineSpeechOptions, type OfflineSpeechState } from './useOfflineSpeech'
import type { MicCapture, MicCaptureFactory } from './audioCapture'
import type { ShenavaRecognizer } from './ShenavaRecognizer'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const METRICS = {
  audioMs: 1_000,
  featureMs: 10,
  encoderMs: 600,
  decodeMs: 80,
  totalMs: 700,
  featureFrames: 101,
  encoderFrames: 13,
  tokens: 6,
  firstTokenMs: 5,
}

function fakeRecognizer(transcriptText = 'سه عدد شیر به فاکتور اضافه کن') {
  const recognizer = {
    status: 'idle' as string,
    probe: vi.fn(async () => ({ available: true, missing: [], source: 'local' as const })),
    init: vi.fn(async () => {
      recognizer.status = 'ready'
      return {}
    }),
    transcribe: vi.fn(async () => ({ text: transcriptText, tokenIds: [1, 2], metrics: METRICS })),
    dispose: vi.fn(),
  }
  return recognizer
}

function fakeCapture(stopResult: Float32Array = new Float32Array(16_000)) {
  const capture: MicCapture = {
    sampleCount: stopResult.length,
    sampleRate: 16_000,
    stop: vi.fn(async () => stopResult),
    cancel: vi.fn(),
  }
  return capture
}

let root: Root | null = null
let container: HTMLDivElement | null = null
let latest: OfflineSpeechState | null = null

function renderHook(options: OfflineSpeechOptions) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  function Harness({ current }: { current: OfflineSpeechOptions }) {
    latest = useOfflineSpeech(current)
    return (
      <button className="start" onClick={() => latest?.start()}>start</button>
    )
  }
  act(() => { root?.render(<Harness current={options} />) })
}

const flush = async () => {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}

async function clickStart() {
  await act(async () => {
    container!.querySelector<HTMLButtonElement>('.start')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

afterEach(() => {
  if (root) act(() => root?.unmount())
  root = null
  container?.remove()
  container = null
  latest = null
  vi.restoreAllMocks()
})

describe('useOfflineSpeech: چرخهٔ کامل موتور آفلاین', () => {
  it('با موجود بودن مدل، وضعیت ready و پیام آماده‌بودن می‌دهد', async () => {
    const recognizer = fakeRecognizer()
    renderHook({ onTranscript: vi.fn(), createRecognizer: () => recognizer as unknown as ShenavaRecognizer })
    await flush()
    expect(latest!.status).toBe('ready')
    expect(latest!.available).toBe(true)
    expect(latest!.canStart).toBe(true)
    expect(latest!.modelSource).toBe('local')
    expect(latest!.message).toContain('صدا روی همین دستگاه')
  })

  it('اگر مدل فقط روی Hub موجود باشد، پیام دانلود یک‌بار و منبع hub را گزارش می‌کند', async () => {
    renderHook({
      onTranscript: vi.fn(),
      createRecognizer: () => fakeRecognizer() as unknown as ShenavaRecognizer,
      probe: async () => ({ available: true, missing: [], source: 'hub' }),
    })
    await flush()
    expect(latest!.status).toBe('ready')
    expect(latest!.modelSource).toBe('hub')
    expect(latest!.message).toContain('بار اول')
    expect(latest!.message).toContain('آفلاین')
  })

  it('اگر مدل نصب نباشد، پیام «از ورودی متنی استفاده کنید» می‌دهد و شروع نمی‌کند', async () => {
    const recognizer = fakeRecognizer()
    renderHook({
      onTranscript: vi.fn(),
      createRecognizer: () => recognizer as unknown as ShenavaRecognizer,
      probe: async () => ({ available: false, missing: ['encoder.int8.onnx'], reason: 'missing' }),
    })
    await flush()
    expect(latest!.status).toBe('unavailable')
    expect(latest!.canStart).toBe(false)
    expect(latest!.message).toContain('از ورودی متنی استفاده کنید')
    await clickStart()
    expect(recognizer.init).not.toHaveBeenCalled()
  })

  it('شروع، ضبط و سپس تبدیل گفتار به متن را انجام می‌دهد و متن را با تبدیل دلخواه تحویل می‌دهد', async () => {
    const recognizer = fakeRecognizer('سه عدد شیر به فاکتور اضافه کن')
    const capture = fakeCapture()
    const captureFactory = vi.fn(async () => capture) as unknown as MicCaptureFactory
    const onTranscript = vi.fn()
    renderHook({
      onTranscript,
      createRecognizer: () => recognizer as unknown as ShenavaRecognizer,
      captureFactory,
      transformTranscript: (text) => `[${text}]`,
    })
    await flush()

    await clickStart()
    expect(recognizer.init).toHaveBeenCalledTimes(1)
    expect(captureFactory).toHaveBeenCalledTimes(1)
    expect(latest!.status).toBe('listening')
    expect(latest!.message).toContain('در حال شنیدن')

    await act(async () => {
      latest!.stop()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(capture.stop).toHaveBeenCalledTimes(1)
    expect(recognizer.transcribe).toHaveBeenCalledTimes(1)
    expect(onTranscript).toHaveBeenCalledWith('[سه عدد شیر به فاکتور اضافه کن]')
    expect(latest!.status).toBe('result')
    expect(latest!.metrics).toMatchObject({ tokens: 6 })
    expect(latest!.message).toContain('اجرای دستور')
  })

  it('کلیک دوم روی دکمه، ضبط را متوقف می‌کند', async () => {
    const capture = fakeCapture()
    renderHook({
      onTranscript: vi.fn(),
      createRecognizer: () => fakeRecognizer() as unknown as ShenavaRecognizer,
      captureFactory: async () => capture,
    })
    await flush()
    await clickStart()
    expect(latest!.status).toBe('listening')
    await clickStart()
    expect(capture.stop).toHaveBeenCalledTimes(1)
  })

  it('خطای میکروفن (رد شدن مجوز) پیام فارسی مجوز می‌دهد', async () => {
    renderHook({
      onTranscript: vi.fn(),
      createRecognizer: () => fakeRecognizer() as unknown as ShenavaRecognizer,
      captureFactory: async () => {
        throw Object.assign(new Error('denied'), { name: 'NotAllowedError' })
      },
    })
    await flush()
    await clickStart()
    expect(latest!.status).toBe('error')
    expect(latest!.message).toContain('اجازهٔ میکروفن رد شد')
  })

  it('ضبط بی‌صدا پیام «صدایی ضبط نشد» می‌دهد و متن خالی تولید نمی‌کند', async () => {
    const onTranscript = vi.fn()
    renderHook({
      onTranscript,
      createRecognizer: () => fakeRecognizer() as unknown as ShenavaRecognizer,
      captureFactory: async () => fakeCapture(new Float32Array(100)),
    })
    await flush()
    await clickStart()
    await act(async () => {
      latest!.stop()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(latest!.status).toBe('error')
    expect(latest!.message).toContain('صدایی ضبط نشد')
    expect(onTranscript).not.toHaveBeenCalled()
  })

  it('خطای تبدیل گفتار، متن را وارد نمی‌کند و پیام خطا می‌دهد', async () => {
    const recognizer = fakeRecognizer()
    recognizer.transcribe = vi.fn(async () => { throw new Error('encoder blew up') })
    const onTranscript = vi.fn()
    renderHook({
      onTranscript,
      createRecognizer: () => recognizer as unknown as ShenavaRecognizer,
      captureFactory: async () => fakeCapture(),
    })
    await flush()
    await clickStart()
    await act(async () => {
      latest!.stop()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(onTranscript).not.toHaveBeenCalled()
    expect(latest!.message).toContain('encoder blew up')
  })

  it('در محیط بدون Worker، موتور پشتیبانی نمی‌شود و پیام متنی می‌دهد', async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'Worker')
    vi.stubGlobal('Worker', undefined)
    vi.stubGlobal('WebAssembly', undefined)
    renderHook({ onTranscript: vi.fn() })
    await flush()
    expect(latest!.supported).toBe(false)
    expect(latest!.status).toBe('unsupported')
    expect(latest!.message).toContain('از ورودی متنی استفاده کنید')
    if (original) Object.defineProperty(globalThis, 'Worker', original)
    else delete (globalThis as { Worker?: unknown }).Worker
  })

  it('خروج از صفحه، موتور را آزاد می‌کند', async () => {
    const recognizer = fakeRecognizer()
    renderHook({ onTranscript: vi.fn(), createRecognizer: () => recognizer as unknown as ShenavaRecognizer })
    await flush()
    act(() => { root?.unmount() })
    root = null
    expect(recognizer.dispose).toHaveBeenCalledTimes(1)
  })
})
