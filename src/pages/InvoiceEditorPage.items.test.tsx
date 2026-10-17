// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { calculateInvoiceTotals, formatToman } from '../domain/calculations'
import { blankInvoiceForm, type InvoiceForm, type InvoiceLineForm } from '../domain/invoice-form'
import type { Product } from '../domain/types'
import { InvoiceEditorPage } from './InvoiceEditorPage'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const now = '2026-10-17'
const brakePad: Product = { id: 'p-pad', name: 'لنت ترمز پراید', unit: 'عدد', price: 1_200_000, createdAt: now, updatedAt: now }
const tire: Product = { id: 'p-tire', name: 'لاستیک دنا سمند', unit: 'عدد', price: 3_500_000, createdAt: now, updatedAt: now }
const lamp: Product = { id: 'p-lamp', name: 'چراغ خطر پژو ۴۰۵', unit: 'عدد', price: 450_000, createdAt: now, updatedAt: now }

let mountedRoot: Root | null = null
let mountedContainer: HTMLDivElement | null = null

function renderEditor(products: Product[] = [], form: InvoiceForm = blankInvoiceForm()) {
  mountedContainer = document.createElement('div')
  document.body.appendChild(mountedContainer)
  mountedRoot = createRoot(mountedContainer)
  const props = {
    form,
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
    offlineSpeech: {
      probe: async () => ({ available: false, missing: ['encoder.int8.onnx'] as string[] }),
      skipProbe: true,
    },
  }
  act(() => { mountedRoot?.render(<InvoiceEditorPage {...props} />) })
  return { container: mountedContainer, props }
}

function typeCommand(container: HTMLElement, text: string) {
  const input = container.querySelector<HTMLInputElement>('[aria-label="نوشتن دستور فارسی"]')!
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  act(() => {
    setter?.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  return input
}

function pressRegister(container: HTMLElement) {
  act(() => { container.querySelector<HTMLButtonElement>('.command-run')!.click() })
}

afterEach(() => {
  if (mountedRoot) act(() => mountedRoot?.unmount())
  mountedRoot = null
  mountedContainer?.remove()
  mountedContainer = null
  vi.restoreAllMocks()
})

describe('ثبت اقلام گفتاری در فاکتور با دکمهٔ «ثبت»', () => {
  it('جملهٔ چندقلمی نمونه را با تعداد، قیمت واحد از فهرست و جمع کل ثبت می‌کند', () => {
    const { container, props } = renderEditor([brakePad, tire, lamp])
    const input = typeCommand(container, 'دو تا لنت ترمز پراید، چهار تا لاستیک دنا سمند، یک جفت چراغ خطر پژو ۴۰۵')
    expect(input.value).toContain('لنت ترمز پراید')
    expect(props.onChange).not.toHaveBeenCalled()

    pressRegister(container)
    expect(props.onChange).toHaveBeenCalledTimes(1)
    const updated = props.onChange.mock.calls[0][0] as InvoiceForm
    expect(updated.items).toHaveLength(3)
    expect(updated.items[0]).toMatchObject({ productId: 'p-pad', name: 'لنت ترمز پراید', quantity: '2', unitPrice: '1200000', discountPercent: '0' })
    expect(updated.items[1]).toMatchObject({ productId: 'p-tire', name: 'لاستیک دنا سمند', quantity: '4', unitPrice: '3500000' })
    // «یک جفت» = ۲ عدد
    expect(updated.items[2]).toMatchObject({ productId: 'p-lamp', name: 'چراغ خطر پژو ۴۰۵', quantity: '2', unitPrice: '450000' })

    // جمع کل با قیمت‌های فرضی: ۲×۱٬۲۰۰٬۰۰۰ + ۴×۳٬۵۰۰٬۰۰۰ + ۲×۴۵۰٬۰۰۰ = ۱۷٬۳۰۰٬۰۰۰
    const totals = calculateInvoiceTotals(updated.items.map((item: InvoiceLineForm) => ({
      quantity: Number(item.quantity),
      unitPrice: Number(item.unitPrice),
      discountPercent: 0,
    })), 0)
    expect(totals.subtotal).toBe(17_300_000)
    expect(totals.total).toBe(17_300_000)

    // پیام ثبت هم جمع مبلغ اقلام تازه را نشان می‌دهد
    expect(container.textContent).toContain('۳ قلم در فاکتور ثبت شد')
    expect(container.textContent).toContain(formatToman(17_300_000))
    // پس از ثبت، ورودی پاک می‌شود
    expect(container.querySelector<HTMLInputElement>('[aria-label="نوشتن دستور فارسی"]')?.value).toBe('')
    expect(props.onSave).not.toHaveBeenCalled()
  })

  it('«یک جفت چراغ خطر پژو ۴۰۵» را ۲ عدد ثبت می‌کند', () => {
    const { container, props } = renderEditor([lamp])
    typeCommand(container, 'یک جفت چراغ خطر پژو ۴۰۵')
    pressRegister(container)
    const updated = props.onChange.mock.calls[0][0] as InvoiceForm
    expect(updated.items).toHaveLength(1)
    expect(updated.items[0]).toMatchObject({ productId: 'p-lamp', name: 'چراغ خطر پژو ۴۰۵', quantity: '2' })
  })

  it('قیمت گفته‌شده در متن بر قیمت فهرست مقدم است و بدون فهرست هم کار می‌کند', () => {
    const { container, props } = renderEditor([])
    typeCommand(container, 'دو تا لنت ترمز پراید به قیمت ۲۵۰۰۰۰')
    pressRegister(container)
    const updated = props.onChange.mock.calls[0][0] as InvoiceForm
    expect(updated.items).toHaveLength(1)
    expect(updated.items[0]).toMatchObject({ productId: null, name: 'لنت ترمز پراید', quantity: '2', unitPrice: '250000' })
  })
})

describe('اقلام مبهم به کاربر نشان داده می‌شوند و چیزی ثبت نمی‌شود', () => {
  it('قلم بدون تعداد را نشان می‌دهد و هیچ ردیفی ثبت نمی‌کند', () => {
    const { container, props } = renderEditor([brakePad])
    const input = typeCommand(container, 'دو تا لنت ترمز پراید، چراغ خطر')
    pressRegister(container)

    expect(props.onChange).not.toHaveBeenCalled()
    const alert = container.querySelector<HTMLElement>('[role="alert"]')
    expect(alert).not.toBeNull()
    expect(alert?.textContent).toContain('چراغ خطر')
    expect(alert?.textContent).toContain('تعداد')
    // متن برای اصلاح کاربر باقی می‌ماند
    expect(input.value).toBe('دو تا لنت ترمز پراید، چراغ خطر')
  })

  it('قلم بدون قیمت (نه در متن، نه در فهرست) را حدس نمی‌زند و برای اصلاح نشان می‌دهد', () => {
    const { container, props } = renderEditor([])
    typeCommand(container, 'دو تا لنت ترمز پراید')
    pressRegister(container)

    expect(props.onChange).not.toHaveBeenCalled()
    const alert = container.querySelector<HTMLElement>('[role="alert"]')
    expect(alert?.textContent).toContain('قیمت')
    expect(alert?.textContent).toContain('لنت ترمز پراید')
  })

  it('با اصلاح متن و واردکردن قیمت، همان فرمان دوباره ثبت می‌شود', () => {
    const { container, props } = renderEditor([])
    typeCommand(container, 'دو تا لنت ترمز پراید')
    pressRegister(container)
    expect(props.onChange).not.toHaveBeenCalled()

    typeCommand(container, 'دو تا لنت ترمز پراید به قیمت ۲۵۰۰۰۰')
    pressRegister(container)
    expect(props.onChange).toHaveBeenCalledTimes(1)
    const updated = props.onChange.mock.calls[0][0] as InvoiceForm
    expect(updated.items[0]).toMatchObject({ name: 'لنت ترمز پراید', quantity: '2', unitPrice: '250000' })
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })
})

describe('دکمهٔ «ثبت» و مسیرهای قبلی', () => {
  it('دکمهٔ اجرای فرمان «ثبت» نام دارد', () => {
    const { container } = renderEditor()
    const runButton = container.querySelector<HTMLButtonElement>('.command-run')
    expect(runButton?.textContent).toBe('ثبت')
  })

  it('دستورهای تکی قبلی مثل «تعداد … را به دو تغییر بده» همچنان از مسیر تکی اجرا می‌شوند', () => {
    const form = blankInvoiceForm()
    form.items = [{ id: 'row-1', productId: 'p-pad', name: 'لنت ترمز پراید', unit: 'عدد', quantity: '1', unitPrice: '1200000', discountPercent: '0' }]
    const { container, props } = renderEditor([brakePad], form)
    typeCommand(container, 'تعداد لنت ترمز پراید را به دو تغییر بده')
    pressRegister(container)
    expect(props.onChange).toHaveBeenCalledTimes(1)
    const updated = props.onChange.mock.calls[0][0] as InvoiceForm
    expect(updated.items[0]).toMatchObject({ id: 'row-1', quantity: '2' })
    expect(updated.items).toHaveLength(1)
  })
})

describe('نام تنها کالا: ثبت سریع یا پنل تکمیل قیمت (با واژه‌های تازه)', () => {
  const setNativeValue = (element: HTMLInputElement, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    act(() => {
      setter?.call(element, value)
      element.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }
  const reviewButton = (container: HTMLElement, text: string) =>
    [...container.querySelector<HTMLElement>('[role="alert"]')!.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === text)!
  const feedback = (container: HTMLElement) => container.querySelector<HTMLElement>('[role="status"]')?.textContent ?? ''
  const reviewInput = (container: HTMLElement, label: string) =>
    container.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!
  const reviewName = (container: HTMLElement, row: number) => reviewInput(container, `نام قلم ${row} در بازبینی`)
  const reviewQty = (container: HTMLElement, row: number) => reviewInput(container, `تعداد قلم ${row} در بازبینی`)
  const reviewPrice = (container: HTMLElement, row: number) => reviewInput(container, `قیمت قلم ${row} در بازبینی`)

  it('نام تنها با تطبیق دقیقِ کاتالوگ، بلافاصله با تعداد ۱ ثبت می‌شود', () => {
    const saffron: Product = { id: 'p-saffron', name: 'زعفران', unit: 'بسته', price: 1_800_000, createdAt: now, updatedAt: now }
    const { container, props } = renderEditor([saffron])
    typeCommand(container, 'زعفران')
    pressRegister(container)
    expect(props.onChange).toHaveBeenCalledTimes(1)
    const form = props.onChange.mock.calls[0][0] as InvoiceForm
    expect(form.items).toHaveLength(1)
    expect(form.items[0]).toMatchObject({ productId: 'p-saffron', name: 'زعفران', quantity: '1', unitPrice: '1800000', discountPercent: '0' })
    expect(feedback(container)).toContain('۱ قلم در فاکتور ثبت شد')
    expect(container.querySelector<HTMLInputElement>('[aria-label="نوشتن دستور فارسی"]')?.value).toBe('')
  })

  it('نام تنها بدون قیمت، پنل تکمیل باز می‌کند؛ با پرکردن قیمت و «ثبت اقلام»، قلم با تعداد ۱ ثبت می‌شود', () => {
    const { container, props } = renderEditor([])
    typeCommand(container, 'ماکارونی')
    pressRegister(container)
    expect(props.onChange).not.toHaveBeenCalled()
    const alert = container.querySelector<HTMLElement>('[role="alert"]')
    expect(alert?.textContent).toContain('ماکارونی')
    expect(alert?.textContent).toContain('هنوز چیزی ثبت نشده است')
    setNativeValue(reviewPrice(container, 1), '250000')
    act(() => { reviewButton(container, 'ثبت اقلام').click() })
    const form = props.onChange.mock.calls[0][0] as InvoiceForm
    expect(form.items).toHaveLength(1)
    expect(form.items[0]).toMatchObject({ name: 'ماکارونی', quantity: '1', unitPrice: '250000' })
    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(feedback(container)).toContain('۱ قلم در فاکتور ثبت شد')
  })

  it('دو نام تنها، دو ردیف تکمیل می‌شوند و هر دو با «ثبت اقلام» ثبت می‌شوند', () => {
    const { container, props } = renderEditor([])
    typeCommand(container, 'شکر، قند')
    pressRegister(container)
    expect(reviewName(container, 1).value).toBe('شکر')
    expect(reviewName(container, 2).value).toBe('قند')
    setNativeValue(reviewPrice(container, 1), '45000')
    setNativeValue(reviewPrice(container, 2), '52000')
    act(() => { reviewButton(container, 'ثبت اقلام').click() })
    const form = props.onChange.mock.calls[0][0] as InvoiceForm
    expect(form.items).toHaveLength(2)
    expect(form.items[0]).toMatchObject({ name: 'شکر', quantity: '1', unitPrice: '45000' })
    expect(form.items[1]).toMatchObject({ name: 'قند', quantity: '1', unitPrice: '52000' })
  })

  it('نام و تعداد در پنل قابل اصلاح است (تعداد پیش‌فرض ۱ حدس پنهان نیست)', () => {
    const { container, props } = renderEditor([])
    typeCommand(container, 'سیب‌زمینی')
    pressRegister(container)
    expect(reviewQty(container, 1).value).toBe('1')
    setNativeValue(reviewQty(container, 1), '3')
    setNativeValue(reviewName(container, 1), 'سیب‌زمینی سرخ‌کرده')
    setNativeValue(reviewPrice(container, 1), '80000')
    act(() => { reviewButton(container, 'ثبت اقلام').click() })
    const form = props.onChange.mock.calls[0][0] as InvoiceForm
    expect(form.items[0]).toMatchObject({ name: 'سیب‌زمینی سرخ‌کرده', quantity: '3', unitPrice: '80000' })
  })

  it('قیمتِ تطبیق دقیقِ کاتالوگ هنگام تایپ نام، خودکار پر می‌شود', () => {
    const whiteSugar: Product = { id: 'p-white-sugar', name: 'شکر سفید', unit: 'کیلو', price: 40_000, createdAt: now, updatedAt: now }
    const brownSugar: Product = { id: 'p-brown-sugar', name: 'شکر قهوه‌ای', unit: 'کیلو', price: 55_000, createdAt: now, updatedAt: now }
    const { container, props } = renderEditor([whiteSugar, brownSugar])
    typeCommand(container, 'شکر')
    pressRegister(container)
    // دو تطبیق جزئی و بدون تطبیق دقیق → ابهام؛ حدس زده نمی‌شود
    const alert = container.querySelector<HTMLElement>('[role="alert"]')
    expect(alert?.textContent).toContain('چند محصول مشابه')
    expect(alert?.textContent).toContain('شکر قهوه‌ای')
    setNativeValue(reviewName(container, 1), 'شکر قهوه‌ای')
    expect(reviewPrice(container, 1).value).toBe('55000')
    act(() => { reviewButton(container, 'ثبت اقلام').click() })
    const form = props.onChange.mock.calls[0][0] as InvoiceForm
    expect(form.items[0]).toMatchObject({ productId: 'p-brown-sugar', name: 'شکر قهوه‌ای', quantity: '1', unitPrice: '55000' })
  })

  it('«انصراف» هیچ قلمی ثبت نمی‌کند و «ثبت اقلام» بدون قیمت، پیام اصلاح می‌دهد', () => {
    const { container, props } = renderEditor([])
    typeCommand(container, 'ماکارونی')
    pressRegister(container)
    act(() => { reviewButton(container, 'ثبت اقلام').click() })
    expect(props.onChange).not.toHaveBeenCalled()
    expect(feedback(container)).toContain('قیمت واحد را به‌صورت عدد صحیح')
    act(() => { reviewButton(container, 'انصراف').click() })
    expect(props.onChange).not.toHaveBeenCalled()
    expect(feedback(container)).toContain('ثبت اقلام لغو شد.')
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })
})
