import { calculateInvoiceTotals } from './calculations'
import { DEFAULT_SETTINGS } from './defaults'
import type { AppSettings, AppSnapshot, Invoice, InvoiceLine, Product } from './types'

const BACKUP_VERSION = 1
const MAX_PRODUCTS = 10_000
const MAX_INVOICES = 50_000
const MAX_LINES_PER_INVOICE = 2_000
const MAX_LOGO_LENGTH = 2_500_000

export class BackupError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BackupError'
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requiredString(value: unknown, label: string, maxLength = 10_000): string {
  if (typeof value !== 'string' || value.length > maxLength) {
    throw new BackupError(`فیلد «${label}» در پشتیبان معتبر نیست.`)
  }
  return value
}

function safeNonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new BackupError(`مقدار «${label}» باید عدد صحیح نامنفی باشد.`)
  }
  return value
}

function parseProduct(value: unknown): Product {
  if (!isObject(value)) throw new BackupError('ساختار یکی از محصولات معتبر نیست.')
  const price = safeNonNegativeInteger(value.price, 'قیمت محصول')
  const id = requiredString(value.id, 'شناسه محصول', 200)
  const name = requiredString(value.name, 'نام محصول', 500).trim()
  if (!id || !name) throw new BackupError('شناسه و نام محصول نباید خالی باشند.')
  return {
    id,
    name,
    unit: requiredString(value.unit, 'واحد محصول', 100) || 'عدد',
    price,
    createdAt: requiredString(value.createdAt, 'تاریخ ساخت محصول', 100),
    updatedAt: requiredString(value.updatedAt, 'تاریخ ویرایش محصول', 100),
  }
}

function parseLine(value: unknown): InvoiceLine {
  if (!isObject(value)) throw new BackupError('ساختار یکی از ردیف‌های فاکتور معتبر نیست.')
  const id = requiredString(value.id, 'شناسه ردیف', 200)
  const productId = value.productId === null ? null : requiredString(value.productId, 'شناسه محصول ردیف', 200)
  const name = requiredString(value.name, 'نام قلم فاکتور', 500).trim()
  const unit = requiredString(value.unit, 'واحد قلم فاکتور', 100) || 'عدد'
  const quantity = value.quantity
  if (typeof quantity !== 'number' || !Number.isFinite(quantity) || quantity <= 0 || quantity > 1_000_000) {
    throw new BackupError('تعداد یکی از ردیف‌های فاکتور معتبر نیست.')
  }
  const unitPrice = safeNonNegativeInteger(value.unitPrice, 'قیمت واحد')
  const discountPercent = value.discountPercent
  if (typeof discountPercent !== 'number' || !Number.isFinite(discountPercent) || discountPercent < 0 || discountPercent > 100) {
    throw new BackupError('درصد تخفیف یکی از ردیف‌های فاکتور معتبر نیست.')
  }
  if (!id || !name) throw new BackupError('شناسه و نام ردیف فاکتور نباید خالی باشند.')
  return { id, productId, name, unit, quantity, unitPrice, discountPercent }
}

function parseInvoice(value: unknown): Invoice {
  if (!isObject(value)) throw new BackupError('ساختار یکی از فاکتورها معتبر نیست.')
  const id = requiredString(value.id, 'شناسه فاکتور', 200)
  const number = requiredString(value.number, 'شماره فاکتور', 200)
  const status = value.status
  if (status !== 'draft' && status !== 'paid') throw new BackupError('وضعیت یکی از فاکتورها معتبر نیست.')
  const discountPercent = value.discountPercent
  if (typeof discountPercent !== 'number' || !Number.isFinite(discountPercent) || discountPercent < 0 || discountPercent > 100) {
    throw new BackupError('درصد تخفیف کلی فاکتور معتبر نیست.')
  }
  if (!Array.isArray(value.items) || value.items.length > MAX_LINES_PER_INVOICE) {
    throw new BackupError('فهرست اقلام یکی از فاکتورها معتبر نیست.')
  }
  const items = value.items.map(parseLine)
  const totals = calculateInvoiceTotals(items, discountPercent)
  if (!id || !number) throw new BackupError('شناسه و شماره فاکتور نباید خالی باشند.')
  return {
    id,
    number,
    customerName: requiredString(value.customerName, 'نام مشتری', 500),
    customerPhone: requiredString(value.customerPhone, 'شماره تماس مشتری', 100),
    notes: requiredString(value.notes, 'یادداشت فاکتور', 5_000),
    status,
    discountPercent,
    items,
    totals,
    createdAt: requiredString(value.createdAt, 'تاریخ ساخت فاکتور', 100),
    updatedAt: requiredString(value.updatedAt, 'تاریخ ویرایش فاکتور', 100),
  }
}

function parseSettings(value: unknown): AppSettings {
  if (!isObject(value)) throw new BackupError('اطلاعات فروشگاه در فایل پشتیبان معتبر نیست.')
  const nextInvoiceNumber = safeNonNegativeInteger(value.nextInvoiceNumber, 'شماره فاکتور بعدی')
  if (nextInvoiceNumber < 1) throw new BackupError('شماره فاکتور بعدی باید دست‌کم یک باشد.')
  const logo = value.logoDataUrl
  if (logo !== null && (typeof logo !== 'string' || logo.length > MAX_LOGO_LENGTH || !/^data:image\/(?:png|jpeg|webp);base64,/i.test(logo))) {
    throw new BackupError('لوگوی ذخیره‌شده باید تصویر PNG، JPEG یا WebP معتبر باشد.')
  }
  return {
    id: 'settings',
    storeName: requiredString(value.storeName, 'نام فروشگاه', 500),
    phone: requiredString(value.phone, 'تلفن فروشگاه', 100),
    address: requiredString(value.address, 'نشانی فروشگاه', 2_000),
    logoDataUrl: logo,
    nextInvoiceNumber,
  }
}

export function serializeBackup(snapshot: AppSnapshot): string {
  return JSON.stringify(
    {
      app: 'Billora',
      schemaVersion: BACKUP_VERSION,
      exportedAt: new Date().toISOString(),
      settings: snapshot.settings,
      products: snapshot.products,
      invoices: snapshot.invoices,
    },
    null,
    2,
  )
}

export function parseBackup(contents: string): AppSnapshot {
  let data: unknown
  try {
    data = JSON.parse(contents)
  } catch {
    throw new BackupError('فایل انتخاب‌شده JSON معتبر نیست.')
  }
  if (!isObject(data) || data.app !== 'Billora') {
    throw new BackupError('این فایل، پشتیبان معتبر Billora نیست.')
  }
  if (data.schemaVersion !== BACKUP_VERSION) {
    throw new BackupError(`نسخهٔ پشتیبان پشتیبانی نمی‌شود (نسخهٔ مورد انتظار ${BACKUP_VERSION}).`)
  }
  if (!Array.isArray(data.products) || data.products.length > MAX_PRODUCTS) {
    throw new BackupError('فهرست محصولات در فایل پشتیبان معتبر نیست یا بیش از اندازه بزرگ است.')
  }
  if (!Array.isArray(data.invoices) || data.invoices.length > MAX_INVOICES) {
    throw new BackupError('فهرست فاکتورها در فایل پشتیبان معتبر نیست یا بیش از اندازه بزرگ است.')
  }

  const settings = data.settings === undefined ? { ...DEFAULT_SETTINGS } : parseSettings(data.settings)
  const products = data.products.map(parseProduct)
  const invoices = data.invoices.map(parseInvoice)
  const productIds = new Set(products.map((product) => product.id))
  const invoiceIds = new Set(invoices.map((invoice) => invoice.id))
  const invoiceNumbers = new Set(invoices.map((invoice) => invoice.number))
  if (productIds.size !== products.length || invoiceIds.size !== invoices.length || invoiceNumbers.size !== invoices.length) {
    throw new BackupError('فایل پشتیبان دارای شناسه یا شمارهٔ تکراری است.')
  }

  const highestNumber = invoices.reduce((highest, invoice) => {
    const parsed = Number(invoice.number.match(/(\d+)$/)?.[1] ?? 0)
    return Number.isSafeInteger(parsed) ? Math.max(highest, parsed) : highest
  }, 0)
  settings.nextInvoiceNumber = Math.max(settings.nextInvoiceNumber, highestNumber + 1)

  return { settings, products, invoices }
}
