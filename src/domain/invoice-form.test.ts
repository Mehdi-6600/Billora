import { describe, expect, it } from 'vitest'
import { parseLocalizedNumber } from './calculations'
import { toInvoiceDraft } from './invoice-form'

describe('تبدیل فرم فاکتور', () => {
  it('ارقام فارسی را به عددهای محاسباتی تبدیل می‌کند و شناسهٔ ردیف را نگه می‌دارد', () => {
    const draft = toInvoiceDraft({
      customerName: 'مشتری', customerPhone: '', notes: '', status: 'draft', discountPercent: '۵',
      items: [{ id: 'l1', productId: null, name: 'شیر', unit: 'عدد', quantity: '۳', unitPrice: '۱۲٬۵۰۰', discountPercent: '۰' }],
    }, parseLocalizedNumber)
    expect(draft.discountPercent).toBe(5)
    expect(draft.items[0]).toMatchObject({ id: 'l1', quantity: 3, unitPrice: 12500, name: 'شیر' })
  })
})
