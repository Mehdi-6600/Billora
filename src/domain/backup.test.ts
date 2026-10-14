import { describe, expect, it } from 'vitest'
import { parseBackup, serializeBackup } from './backup'
import { DEFAULT_SETTINGS } from './defaults'
import type { AppSnapshot } from './types'

const sample: AppSnapshot = {
  settings: { ...DEFAULT_SETTINGS, storeName: 'فروشگاه نمونه', nextInvoiceNumber: 2 },
  products: [{ id: 'p1', name: 'روغن', unit: 'عدد', price: 100_000, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }],
  invoices: [{
    id: 'i1', number: 'BL-0001', customerName: 'مشتری', customerPhone: '', notes: '', status: 'draft', discountPercent: 0,
    items: [{ id: 'l1', productId: 'p1', name: 'روغن', unit: 'عدد', quantity: 2, unitPrice: 100_000, discountPercent: 0 }],
    totals: { subtotal: 200_000, itemDiscount: 0, invoiceDiscount: 0, total: 200_000 },
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  }],
}

describe('پشتیبان محلی Billora', () => {
  it('دادهٔ معتبر را سریال و با جمع‌های محاسبه‌شده بازیابی می‌کند', () => {
    const restored = parseBackup(serializeBackup(sample))
    expect(restored.settings.storeName).toBe('فروشگاه نمونه')
    expect(restored.products[0].price).toBe(100_000)
    expect(restored.invoices[0].totals.total).toBe(200_000)
    expect(restored.settings.nextInvoiceNumber).toBe(2)
  })

  it('دادهٔ نامعتبر، نسخهٔ ناآشنا و شناسهٔ تکراری را رد می‌کند', () => {
    expect(() => parseBackup('{')).toThrow(/JSON معتبر نیست/)
    expect(() => parseBackup(JSON.stringify({ app: 'Other', schemaVersion: 1, products: [], invoices: [] }))).toThrow(/Billora/)
    expect(() => parseBackup(JSON.stringify({ app: 'Billora', schemaVersion: 99, products: [], invoices: [] }))).toThrow(/نسخهٔ پشتیبان/)
    const duplicate = { ...sample, products: [...sample.products, { ...sample.products[0] }] }
    expect(() => parseBackup(serializeBackup(duplicate))).toThrow(/تکراری/)
  })

  it('اگر شمارندهٔ پشتیبان عقب‌تر باشد از شمارهٔ فاکتور موجود جلو می‌رود', () => {
    const behind = { ...sample, settings: { ...sample.settings, nextInvoiceNumber: 1 } }
    expect(parseBackup(serializeBackup(behind)).settings.nextInvoiceNumber).toBe(2)
  })
})
