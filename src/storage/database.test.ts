import { describe, expect, it } from 'vitest'
import { parseBackup, serializeBackup } from '../domain/backup'
import type { InvoiceDraft } from '../domain/types'
import {
  deleteInvoice,
  deleteProduct,
  initializeDatabase,
  loadSnapshot,
  replaceAllData,
  saveInvoice,
  saveProduct,
  saveSettings,
} from './database'

describe('ذخیره‌سازی محلی IndexedDB', () => {
  it('محصول و فاکتور را می‌سازد، ویرایش می‌کند، پس از بازخوانی نگه می‌دارد، پشتیبان می‌گیرد و حذف می‌کند', async () => {
    await initializeDatabase()
    expect((await loadSnapshot()).invoices).toHaveLength(0)

    const product = await saveProduct({ name: 'روغن', unit: 'بطری', price: 125_000 })
    expect(product.name).toBe('روغن')
    const editedProduct = await saveProduct({ id: product.id, name: 'روغن ممتاز', unit: 'بطری', price: 137_500 })
    expect(editedProduct.createdAt).toBe(product.createdAt)
    expect(editedProduct.price).toBe(137_500)

    const draft: InvoiceDraft = {
      customerName: 'مریم رضایی',
      customerPhone: '۰۹۱۲۱۲۳۴۵۶۷',
      notes: 'تحویل حضوری',
      status: 'draft',
      discountPercent: 5,
      items: [{ id: 'line-1', productId: product.id, name: 'روغن ممتاز', unit: 'بطری', quantity: 2, unitPrice: 137_500, discountPercent: 10 }],
    }
    const created = await saveInvoice(draft)
    expect(created.number).toBe('BL-0001')
    expect(created.totals.subtotal).toBe(275_000)
    expect(created.totals.itemDiscount).toBe(27_500)
    expect(created.totals.invoiceDiscount).toBe(12_375)
    expect(created.totals.total).toBe(235_125)

    const reloaded = await loadSnapshot()
    expect(reloaded.invoices).toHaveLength(1)
    expect(reloaded.invoices[0].customerPhone).toBe('۰۹۱۲۱۲۳۴۵۶۷')
    expect(reloaded.products[0].price).toBe(137_500)

    const edited = await saveInvoice({ ...draft, id: created.id, status: 'paid', customerName: 'مریم رضایی‌پور', items: [{ ...draft.items[0], quantity: 3 }] })
    expect(edited.number).toBe('BL-0001')
    expect(edited.status).toBe('paid')
    expect(edited.items[0].quantity).toBe(3)
    expect((await loadSnapshot()).invoices[0].totals.total).toBe(352_687)

    const beforeSettings = await loadSnapshot()
    await saveSettings({ ...beforeSettings.settings, storeName: 'فروشگاه محلی', phone: '۰۲۱۱۲۳۴۵۶', address: 'تهران' })
    expect((await loadSnapshot()).settings.storeName).toBe('فروشگاه محلی')

    const parsed = parseBackup(serializeBackup(await loadSnapshot()))
    await replaceAllData(parsed)
    const afterRestore = await loadSnapshot()
    expect(afterRestore.invoices[0].number).toBe('BL-0001')
    expect(afterRestore.invoices[0].items[0].quantity).toBe(3)
    expect(afterRestore.settings.nextInvoiceNumber).toBe(2)

    await deleteProduct(product.id)
    expect((await loadSnapshot()).products).toHaveLength(0)
    expect((await loadSnapshot()).invoices[0].items[0].name).toBe('روغن ممتاز')

    await deleteInvoice(created.id)
    expect((await loadSnapshot()).invoices).toHaveLength(0)
    const next = await saveInvoice({ ...draft, items: [{ ...draft.items[0], productId: null }] })
    expect(next.number).toBe('BL-0002')
  })
})
