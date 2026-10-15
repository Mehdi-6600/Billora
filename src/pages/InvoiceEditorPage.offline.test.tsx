// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { blankInvoiceForm, type InvoiceForm } from '../domain/invoice-form'
import type { SpeechErrorEventLike, SpeechRecognitionLike, SpeechResultEventLike } from '../domain/speech-recognition'
import type { Product } from '../domain/types'
import type { MicCapture } from '../speech/offline/audioCapture'
import { OFFLINE_SPEECH_MESSAGES } from '../speech/offline/offlineSpeechMessages'
import type { ShenavaRecognizer } from '../speech/offline/ShenavaRecognizer'
import { InvoiceEditorPage } from './InvoiceEditorPage'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36'

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

class MockRecognition implements SpeechRecognitionLike {
  static instances: MockRecognition[] = []
  static nextStartError: { name: string } | null = null
  lang = ''
  continuous = true
  interimResults = true
  onstart: ((event: Event) => void) | null = null
  onresult: ((event: SpeechResultEventLike) => void) | null = null
  onerror: ((event: SpeechErrorEventLike) => void) | null = null
  onend: ((event: Event) => void) | null = null

  constructor() { MockRecognition.instances.push(this) }
  start() { if (MockRecognition.nextStartError) throw MockRecognition.nextStartError }
  stop() {}
  abort() {}
  emitStart() { this.onstart?.(new Event('start')) }
  emitResult(transcript: string) {
    const alternative = { transcript }
    const result = { 0: alternative, length: 1 }
    const results = { 0: result, length: 1 }
    this.onresult?.({ results })
  }
}

function fakeRecognizer(transcriptText: string) {
  const recognizer = {
    status: 'idle' as string,
    probe: vi.fn(async () => ({ available: true, missing: [] })),
    init: vi.fn(async () => { recognizer.status = 'ready'; return {} }),
    transcribe: vi.fn(async () => ({ text: transcriptText, tokenIds: [1, 2, 3], metrics: METRICS })),
    dispose: vi.fn(),
  }
  return recognizer
}

function fakeCapture(pcm = new Float32Array(16_000)): MicCapture {
  return { sampleCount: pcm.length, sampleRate: 16_000, stop: vi.fn(async () => pcm), cancel: vi.fn() }
}

const riceHash: Product = {
  id: 'rice-hashemi',
  name: 'برنج هاشمی',
  unit: 'کیسه',
  price: 1_250_000,
  createdAt: '2026-01-01',
  updatedAt: '2026-01-01',
}

const milk: Product = {
  id: 'milk',
  name: 'شیر',
  unit: 'عدد',
  price: 35_000,
  createdAt: '2026-01-01',
  updatedAt: '2026-01-01',
}

const originalSpeechDescriptor = Object.getOwnPropertyDescriptor(window, 'SpeechRecognition')
const originalWebkitDescriptor = Object.getOwnPropertyDescriptor(window, 'webkitSpeechRecognition')
const originalUserAgent = Object.getOwnPropertyDescriptor(window.navigator, 'userAgent')
const originalPlatform = Object.getOwnPropertyDescriptor(window.navigator, 'platform')
const originalTouchPoints = Object.getOwnPropertyDescriptor(window.navigator, 'maxTouchPoints')

function setSpeechConstructors(standard?: Window['SpeechRecognition'], webkit?: Window['webkitSpeechRecognition']) {
  if (standard) Object.defineProperty(window, 'SpeechRecognition', { configurable: true, writable: true, value: standard })
  else delete window.SpeechRecognition
  if (webkit) Object.defineProperty(window, 'webkitSpeechRecognition', { configurable: true, writable: true, value: webkit })
  else delete window.webkitSpeechRecognition
}

function setPlatform(userAgent: string, platform: string, maxTouchPoints: number) {
  Object.defineProperty(window.navigator, 'userAgent', { configurable: true, value: userAgent })
  Object.defineProperty(window.navigator, 'platform', { configurable: true, value: platform })
  Object.defineProperty(window.navigator, 'maxTouchPoints', { configurable: true, value: maxTouchPoints })
}

let mountedRoot: Root | null = null
let mountedContainer: HTMLDivElement | null = null

function renderEditor(options: {
  products?: Product[]
  form?: InvoiceForm
  transcript?: string
  modelAvailable?: boolean
  withSafari?: boolean
} = {}) {
  if (options.withSafari !== false) setSpeechConstructors(undefined, MockRecognition)
  mountedContainer = document.createElement('div')
  document.body.appendChild(mountedContainer)
  mountedRoot = createRoot(mountedContainer)
  const recognizer = fakeRecognizer(options.transcript ?? 'سه عدد شیر به فاکتور اضافه کن')
  const capture = fakeCapture()
  const props = {
    form: options.form ?? blankInvoiceForm(),
    products: options.products ?? [],
    saving: false,
    hasSaved: false,
    onChange: vi.fn(),
    onSave: vi.fn().mockResolvedValue(undefined),
    onBack: vi.fn(),
    onPrint: vi.fn(),
    onUpdateProduct: vi.fn().mockResolvedValue(undefined),
    onDeleteProduct: vi.fn().mockResolvedValue(undefined),
    onNotify: vi.fn(),
    offlineSpeech: {
      createRecognizer: () => recognizer as unknown as ShenavaRecognizer,
      captureFactory: async () => capture,
      probe: async () => (options.modelAvailable === false
        ? { available: false, missing: ['encoder.int8.onnx'], reason: 'missing' as const }
        : { available: true, missing: [] }),
    },
  }
  act(() => { mountedRoot?.render(<InvoiceEditorPage {...props} />) })
  return { container: mountedContainer, props, recognizer, capture }
}

const flush = async () => {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}

const commandInput = (container: HTMLElement) => container.querySelector<HTMLInputElement>('[aria-label="نوشتن دستور فارسی"]')!
const micButton = (container: HTMLElement) => container.querySelector<HTMLButtonElement>('.voice-button')!
const offlineNote = (container: HTMLElement) => container.querySelector<HTMLElement>('.offline-engine-note') ?? null

async function clickMic(container: HTMLElement) {
  await act(async () => {
    micButton(container).dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function runCommand(container: HTMLElement) {
  act(() => { container.querySelector<HTMLButtonElement>('.command-run')!.click() })
}

afterEach(() => {
  if (mountedRoot) act(() => mountedRoot?.unmount())
  mountedRoot = null
  mountedContainer?.remove()
  mountedContainer = null
  MockRecognition.instances = []
  MockRecognition.nextStartError = null
  if (originalSpeechDescriptor) Object.defineProperty(window, 'SpeechRecognition', originalSpeechDescriptor)
  else delete window.SpeechRecognition
  if (originalWebkitDescriptor) Object.defineProperty(window, 'webkitSpeechRecognition', originalWebkitDescriptor)
  else delete window.webkitSpeechRecognition
  if (originalUserAgent) Object.defineProperty(window.navigator, 'userAgent', originalUserAgent)
  if (originalPlatform) Object.defineProperty(window.navigator, 'platform', originalPlatform)
  if (originalTouchPoints) Object.defineProperty(window.navigator, 'maxTouchPoints', originalTouchPoints)
  vi.restoreAllMocks()
})

describe('اتصال موتور آفلاین شنوا به فرم فاکتور', () => {
  it('روی iPhone میکروفن به موتور آفلاین وصل می‌شود و Web Speech شروع نمی‌شود', async () => {
    setPlatform(IPHONE_UA, 'iPhone', 5)
    const { container, recognizer } = renderEditor({ transcript: 'سلام حال شما خوبه' })
    await flush()
    expect(micButton(container).getAttribute('aria-label')).toBe('گفتن دستور با میکروفن آفلاین')

    await clickMic(container)
    expect(recognizer.init).toHaveBeenCalledTimes(1)
    expect(MockRecognition.instances).toHaveLength(0)
    expect(micButton(container).getAttribute('aria-label')).toBe('توقف ضبط موتور آفلاین')

    await clickMic(container)
    expect(commandInput(container).value).toBe('سلام حال شما خوبه')
    expect(container.textContent).toContain(OFFLINE_SPEECH_MESSAGES.done)
  })

  it('پس از تشخیص گفتار آفلاین، دستور خودکار اجرا نمی‌شود و ورودی متنی دست‌نخورده می‌ماند', async () => {
    setPlatform(IPHONE_UA, 'iPhone', 5)
    const { container, props } = renderEditor({ products: [milk], transcript: 'سه عدد شیر به فاکتور اضافه کن' })
    await flush()
    await clickMic(container)
    await clickMic(container)

    expect(props.onChange).not.toHaveBeenCalled()
    expect(props.onSave).not.toHaveBeenCalled()
    const input = commandInput(container)
    expect(input.value).toBe('۳ عدد شیر به فاکتور اضافه کن')
    expect(input.disabled).toBe(false)

    runCommand(container)
    expect(props.onChange).toHaveBeenCalledTimes(1)
    const updated = props.onChange.mock.calls[0][0] as InvoiceForm
    expect(updated.items).toHaveLength(1)
    expect(updated.items[0]).toMatchObject({ productId: 'milk', quantity: '3', name: 'شیر' })
  })

  it('«دو کیسه برنج هاشمی» را با موتور آفلاین می‌فهمد و ردیف‌های موجود فاکتور را حفظ می‌کند', async () => {
    setPlatform(IPHONE_UA, 'iPhone', 5)
    const form: InvoiceForm = {
      ...blankInvoiceForm(),
      items: [{
        id: 'row-1',
        productId: 'milk',
        name: 'شیر',
        unit: 'عدد',
        quantity: '4',
        unitPrice: '35000',
        discountPercent: '0',
      }],
    }
    const { container, props } = renderEditor({
      products: [riceHash, milk],
      form,
      transcript: 'دو کیسه برنج هاشمی به فاکتور اضافه کن',
    })
    await flush()
    await clickMic(container)
    await clickMic(container)

    expect(commandInput(container).value).toBe('۲ کیسه برنج هاشمی به فاکتور اضافه کن')
    expect(props.onChange).not.toHaveBeenCalled()

    runCommand(container)
    const updated = props.onChange.mock.calls[0][0] as InvoiceForm
    expect(updated.items).toHaveLength(2)
    expect(updated.items[0]).toMatchObject({ id: 'row-1', productId: 'milk', quantity: '4' })
    expect(updated.items[1]).toMatchObject({ productId: 'rice-hashemi', quantity: '2', unitPrice: '1250000' })
  })

  it('برای «دو عدد برنج هاشمی» تعداد ۲ را از متن گفتاری می‌سازد', async () => {
    setPlatform(IPHONE_UA, 'iPhone', 5)
    const { container, props } = renderEditor({
      products: [riceHash],
      transcript: 'دو عدد برنج هاشمی به فاکتور اضافه کن',
    })
    await flush()
    await clickMic(container)
    await clickMic(container)
    runCommand(container)
    const updated = props.onChange.mock.calls[0][0] as InvoiceForm
    expect(updated.items[0]).toMatchObject({ productId: 'rice-hashemi', quantity: '2' })
  })

  it('اگر بازنویسی عدد معنای فرمان را عوض کند، متن خام شنوا بدون تغییر می‌ماند', async () => {
    setPlatform(IPHONE_UA, 'iPhone', 5)
    const { container } = renderEditor({ products: [], transcript: 'دو عدد دو به فاکتور اضافه کن' })
    await flush()
    await clickMic(container)
    await clickMic(container)
    expect(commandInput(container).value).toBe('دو عدد دو به فاکتور اضافه کن')
  })

  it('روی اندروید، Web Speech موتور پیش‌فرض می‌ماند و گزینهٔ آفلاین به‌صورت دستی در دسترس است', async () => {
    setPlatform(ANDROID_UA, 'Linux armv8l', 5)
    const { container, recognizer } = renderEditor({ products: [milk] })
    await flush()

    const toggle = container.querySelector<HTMLButtonElement>('[aria-label="تشخیص گفتار آفلاین روی دستگاه"]')
    expect(toggle).not.toBeNull()
    expect(micButton(container).getAttribute('aria-label')).toBe('گفتن دستور با میکروفن')

    await clickMic(container)
    expect(MockRecognition.instances).toHaveLength(1)
    expect(recognizer.init).not.toHaveBeenCalled()

    await act(async () => {
      toggle!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(recognizer.init).toHaveBeenCalledTimes(1)
    expect(micButton(container).getAttribute('aria-label')).toBe('توقف ضبط موتور آفلاین')
    expect(container.querySelector('[aria-label="استفاده از تشخیص گفتار مرورگر"]')).not.toBeNull()
  })

  it('اگر مدل آفلاین نصب نباشد، دکمهٔ آفلاین غیرفعال است و پیام «از ورودی متنی استفاده کنید» نمایش داده می‌شود', async () => {
    setPlatform(IPHONE_UA, 'iPhone', 5)
    const { container, recognizer } = renderEditor({ modelAvailable: false })
    await flush()

    const disabled = container.querySelector<HTMLButtonElement>('[aria-label="موتور تشخیص گفتار آفلاین در دسترس نیست؛ متن را دستی وارد کنید"]')
    expect(disabled).not.toBeNull()
    expect(disabled!.disabled).toBe(true)
    expect(offlineNote(container)?.textContent).toContain('از ورودی متنی استفاده کنید')
    expect(offlineNote(container)?.textContent).toContain('encoder.int8.onnx')

    await clickMic(container)
    expect(recognizer.init).not.toHaveBeenCalled()
    expect(commandInput(container).disabled).toBe(false)
  })

  it('اگر موتور آفلاین به خطا بخورد، ورودی متنی و اجرای دستور دستی همچنان کار می‌کند', async () => {
    setPlatform(IPHONE_UA, 'iPhone', 5)
    const { container, props, recognizer } = renderEditor({ products: [milk] })
    recognizer.init = vi.fn(async () => { throw new Error('موتور تشخیص گفتار آفلاین در دسترس نیست') })
    await flush()

    await clickMic(container)
    expect(offlineNote(container)?.textContent).toContain('موتور تشخیص گفتار آفلاین در دسترس نیست')
    expect(props.onChange).not.toHaveBeenCalled()

    const input = commandInput(container)
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    act(() => {
      setter?.call(input, 'سه عدد شیر به فاکتور اضافه کن')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    runCommand(container)
    expect(props.onChange).toHaveBeenCalledTimes(1)
  })
})
