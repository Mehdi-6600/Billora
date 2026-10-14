// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { blankInvoiceForm } from '../domain/invoice-form'
import type {
  SpeechErrorEventLike,
  SpeechRecognitionLike,
  SpeechResultEventLike,
} from '../domain/speech-recognition'
import { InvoiceEditorPage } from './InvoiceEditorPage'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

class MockRecognition implements SpeechRecognitionLike {
  static instances: MockRecognition[] = []
  lang = ''
  continuous = true
  interimResults = true
  maxAlternatives = 2
  onstart: ((event: Event) => void) | null = null
  onresult: ((event: SpeechResultEventLike) => void) | null = null
  onerror: ((event: SpeechErrorEventLike) => void) | null = null
  onend: ((event: Event) => void) | null = null
  startCalls = 0
  stopCalls = 0
  abortCalls = 0

  constructor() { MockRecognition.instances.push(this) }
  start() { this.startCalls += 1 }
  stop() { this.stopCalls += 1 }
  abort() { this.abortCalls += 1 }
  emitStart() { this.onstart?.(new Event('start')) }
  emitResult(transcript: string) {
    const alternative = { transcript }
    const result = { 0: alternative, length: 1 }
    const results = { 0: result, length: 1 }
    this.onresult?.({ results })
  }
}

const originalSpeechDescriptor = Object.getOwnPropertyDescriptor(window, 'SpeechRecognition')
const originalWebkitDescriptor = Object.getOwnPropertyDescriptor(window, 'webkitSpeechRecognition')
let mountedRoot: Root | null = null
let mountedContainer: HTMLDivElement | null = null

function setSpeechConstructors(standard?: Window['SpeechRecognition'], webkit?: Window['webkitSpeechRecognition']) {
  if (standard) Object.defineProperty(window, 'SpeechRecognition', { configurable: true, writable: true, value: standard })
  else delete window.SpeechRecognition
  if (webkit) Object.defineProperty(window, 'webkitSpeechRecognition', { configurable: true, writable: true, value: webkit })
  else delete window.webkitSpeechRecognition
}

function renderEditor() {
  mountedContainer = document.createElement('div')
  document.body.appendChild(mountedContainer)
  mountedRoot = createRoot(mountedContainer)
  const props = {
    form: blankInvoiceForm(),
    products: [],
    saving: false,
    hasSaved: false,
    onChange: vi.fn(),
    onSave: vi.fn().mockResolvedValue(undefined),
    onBack: vi.fn(),
    onPrint: vi.fn(),
    onUpdateProduct: vi.fn().mockResolvedValue(undefined),
    onDeleteProduct: vi.fn().mockResolvedValue(undefined),
    onNotify: vi.fn(),
  }
  act(() => { mountedRoot?.render(<InvoiceEditorPage {...props} />) })
  return { container: mountedContainer, props }
}

afterEach(() => {
  if (mountedRoot) act(() => mountedRoot?.unmount())
  mountedRoot = null
  mountedContainer?.remove()
  mountedContainer = null
  MockRecognition.instances = []
  if (originalSpeechDescriptor) Object.defineProperty(window, 'SpeechRecognition', originalSpeechDescriptor)
  else delete window.SpeechRecognition
  if (originalWebkitDescriptor) Object.defineProperty(window, 'webkitSpeechRecognition', originalWebkitDescriptor)
  else delete window.webkitSpeechRecognition
  vi.restoreAllMocks()
})

describe('ورود گفتاری در فرم فاکتور', () => {
  it('از کلیک مستقیم شروع می‌کند و نتیجهٔ فارسی را فقط در ورودی دستور می‌گذارد', () => {
    setSpeechConstructors(MockRecognition)
    const { container, props } = renderEditor()
    const micButton = container.querySelector<HTMLButtonElement>('[aria-label="گفتن دستور با میکروفن"]')!

    act(() => { micButton.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const recognition = MockRecognition.instances[0]
    expect(recognition.startCalls).toBe(1)
    expect(recognition.lang).toBe('fa-IR')
    expect(recognition.continuous).toBe(false)
    expect(recognition.interimResults).toBe(false)

    act(() => {
      recognition.emitStart()
      recognition.emitResult('سه عدد شیر به فاکتور اضافه کن')
    })
    expect(container.querySelector<HTMLInputElement>('[aria-label="نوشتن دستور فارسی"]')?.value).toBe('سه عدد شیر به فاکتور اضافه کن')
    expect(container.textContent).toContain('تا وقتی «اجرای دستور» را نزنید تغییری انجام نمی‌شود')
    expect(props.onChange).not.toHaveBeenCalled()
    expect(props.onSave).not.toHaveBeenCalled()
    expect(props.onUpdateProduct).not.toHaveBeenCalled()
    expect(props.onDeleteProduct).not.toHaveBeenCalled()
  })

  it('در مرورگر فاقد API پیام می‌دهد و ورودی دستی همچنان قابل استفاده است', () => {
    setSpeechConstructors()
    const { container } = renderEditor()
    const micButton = container.querySelector<HTMLButtonElement>('[aria-label="گفتن دستور با میکروفن"]')!
    act(() => { micButton.dispatchEvent(new MouseEvent('click', { bubbles: true })) })

    const input = container.querySelector<HTMLInputElement>('[aria-label="نوشتن دستور فارسی"]')!
    expect(container.textContent).toContain('این مرورگر Web Speech API را پشتیبانی نمی‌کند')
    expect(input.disabled).toBe(false)
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    act(() => {
      setter?.call(input, 'دستور تایپی فارسی')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(input.value).toBe('دستور تایپی فارسی')
  })

  it('در خروج از فرم نشست گفتار را لغو می‌کند', () => {
    setSpeechConstructors(MockRecognition)
    const { container } = renderEditor()
    const micButton = container.querySelector<HTMLButtonElement>('[aria-label="گفتن دستور با میکروفن"]')!
    act(() => { micButton.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const recognition = MockRecognition.instances[0]
    act(() => { mountedRoot?.unmount() })
    mountedRoot = null
    expect(recognition.abortCalls).toBe(1)
    expect(recognition.onresult).toBeNull()
  })
})
