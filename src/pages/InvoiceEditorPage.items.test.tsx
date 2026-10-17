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
