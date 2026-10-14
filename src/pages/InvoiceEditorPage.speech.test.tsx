// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { blankInvoiceForm, type InvoiceForm } from '../domain/invoice-form'
import type { Product } from '../domain/types'
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
  emitEnd() { this.onend?.(new Event('end')) }
  emitResult(transcript: string) {
    const alternative = { transcript }
    const result = { 0: alternative, length: 1 }
    const results = { 0: result, length: 1 }
    this.onresult?.({ results })
  }
  emitError(error: string) { this.onerror?.({ error }) }
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

function renderEditor(products: Product[] = []) {
  mountedContainer = document.createElement('div')
  document.body.appendChild(mountedContainer)
  mountedRoot = createRoot(mountedContainer)
  const props = {
    form: blankInvoiceForm(),
    products,
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

  it('transcript فارسی را پس از بازبینی ویرایش‌شده از همان مسیر دکمهٔ اجرای دستور عبور می‌دهد', () => {
    const rice: Product = {
      id: 'rice-hashemi',
      name: 'برنج هاشمی',
      unit: 'کیسه',
      price: 1_250_000,
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
    }
    setSpeechConstructors(MockRecognition)
    const { container, props } = renderEditor([rice])
    const micButton = container.querySelector<HTMLButtonElement>('.voice-button')!
    act(() => { micButton.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const recognition = MockRecognition.instances[0]
    const transcript = 'دو کیسه برنج هاشمی به فاکتور اضافه کن'
    act(() => {
      recognition.emitStart()
      recognition.emitResult(transcript)
    })

    const input = container.querySelector<HTMLInputElement>('[aria-label="نوشتن دستور فارسی"]')!
    expect(input.value).toBe(transcript)
    expect(input.disabled).toBe(false)
    expect(props.onChange).not.toHaveBeenCalled()

    // The transcript stays editable; punctuation is a harmless user edit for this command.
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    act(() => {
      setter?.call(input, `${transcript}؟`)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(input.value).toBe(`${transcript}؟`)
    expect(props.onChange).not.toHaveBeenCalled()

    act(() => { container.querySelector<HTMLButtonElement>('.command-run')?.click() })
    expect(props.onChange).toHaveBeenCalledTimes(1)
    const updatedForm = props.onChange.mock.calls[0][0] as InvoiceForm
    expect(updatedForm.items).toHaveLength(1)
    expect(updatedForm.items[0]).toMatchObject({
      productId: 'rice-hashemi',
      name: 'برنج هاشمی',
      unit: 'کیسه',
      quantity: '2',
      unitPrice: '1250000',
    })
    expect(props.onSave).not.toHaveBeenCalled()
  })

  it('متن خالی، دستور ناشناخته و خطای سرویس را با پیام‌های جدا نشان می‌دهد', () => {
    setSpeechConstructors(MockRecognition)
    const { container } = renderEditor()
    const micButton = container.querySelector<HTMLButtonElement>('.voice-button')!
    const commandInput = container.querySelector<HTMLInputElement>('[aria-label="نوشتن دستور فارسی"]')!
    const commandRunButton = container.querySelector<HTMLButtonElement>('.command-run')!
    const feedback = () => container.querySelector<HTMLElement>('[role="status"]')?.textContent ?? ''

    act(() => { micButton.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const firstRecognition = MockRecognition.instances[0]
    act(() => {
      firstRecognition.emitStart()
      firstRecognition.emitResult('   ')
    })
    expect(feedback()).toContain('متن قابل‌فهمی از گفتار دریافت نشد')
    expect(feedback()).not.toContain('این دستور را نمی‌شناسم')

    act(() => { commandRunButton.click() })
    expect(feedback()).toContain('متنی برای پردازش دریافت نشد')
    expect(feedback()).not.toContain('این دستور را نمی‌شناسم')

    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    act(() => {
      setter?.call(commandInput, 'این دستور ناشناخته است')
      commandInput.dispatchEvent(new Event('input', { bubbles: true }))
    })
    act(() => { commandRunButton.click() })
    expect(feedback()).toContain('این دستور را نمی‌شناسم')

    act(() => { firstRecognition.emitEnd() })
    act(() => { micButton.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const secondRecognition = MockRecognition.instances[1]
    act(() => { secondRecognition.emitError('network') })
    expect(feedback()).toContain('سرویس تشخیص گفتار به شبکه وصل نشد')
    expect(feedback()).not.toContain('این دستور را نمی‌شناسم')
    expect(feedback()).not.toContain('متنی برای پردازش دریافت نشد')
  })

  it('در مرورگر فاقد API پیام می‌دهد و دستور تایپی همچنان از همان موتور اجرا می‌شود', () => {
    const rice: Product = {
      id: 'rice-hashemi',
      name: 'برنج هاشمی',
      unit: 'کیسه',
      price: 1_250_000,
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
    }
    setSpeechConstructors()
    const { container, props } = renderEditor([rice])
    const micButton = container.querySelector<HTMLButtonElement>('[aria-label="گفتن دستور با میکروفن"]')!
    act(() => { micButton.dispatchEvent(new MouseEvent('click', { bubbles: true })) })

    const input = container.querySelector<HTMLInputElement>('[aria-label="نوشتن دستور فارسی"]')!
    expect(container.textContent).toContain('این مرورگر Web Speech API را پشتیبانی نمی‌کند')
    expect(input.disabled).toBe(false)
    const typedCommand = 'دو کیسه برنج هاشمی به فاکتور اضافه کن'
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    act(() => {
      setter?.call(input, typedCommand)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(input.value).toBe(typedCommand)
    expect(props.onChange).not.toHaveBeenCalled()

    act(() => { container.querySelector<HTMLButtonElement>('.command-run')?.click() })
    expect(props.onChange).toHaveBeenCalledTimes(1)
    const updatedForm = props.onChange.mock.calls[0][0] as InvoiceForm
    expect(updatedForm.items[0]).toMatchObject({ productId: 'rice-hashemi', quantity: '2' })
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
