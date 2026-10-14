import { calculateInvoiceTotals } from '../domain/calculations'
import { DEFAULT_SETTINGS, formatInvoiceNumber } from '../domain/defaults'
import type {
  AppSettings,
  AppSnapshot,
  Invoice,
  InvoiceDraft,
  Product,
  ProductDraft,
} from '../domain/types'

export const DATABASE_NAME = 'billora-local'
const DATABASE_VERSION = 1

let databasePromise: Promise<IDBDatabase> | null = null

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new Error('این مرورگر ذخیره‌سازی محلی (IndexedDB) را پشتیبانی نمی‌کند.'))
  }
  if (databasePromise) return databasePromise

  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION)
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains('settings')) {
        database.createObjectStore('settings', { keyPath: 'id' })
      }
      if (!database.objectStoreNames.contains('products')) {
        database.createObjectStore('products', { keyPath: 'id' })
      }
      if (!database.objectStoreNames.contains('invoices')) {
        const invoices = database.createObjectStore('invoices', { keyPath: 'id' })
        invoices.createIndex('number', 'number', { unique: true })
        invoices.createIndex('createdAt', 'createdAt')
      }
    }
    request.onsuccess = () => {
      const database = request.result
      database.onversionchange = () => {
        database.close()
        databasePromise = null
      }
      resolve(database)
    }
    request.onerror = () => {
      databasePromise = null
      reject(request.error ?? new Error('پایگاه داده باز نشد.'))
    }
    request.onblocked = () => {
      databasePromise = null
      reject(new Error('پایگاه داده توسط زبانهٔ دیگری قفل شده است؛ زبانه‌های دیگر Billora را ببندید.'))
    }
  })

  return databasePromise
}

function makeId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `b-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 11)}`
}

function transactionResult<T>(transaction: IDBTransaction, result: () => T): Promise<T> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve(result())
    transaction.onerror = () => reject(transaction.error ?? new Error('ذخیره‌سازی انجام نشد.'))
    transaction.onabort = () => reject(transaction.error ?? new Error('تراکنش ذخیره‌سازی لغو شد.'))
  })
}

export async function initializeDatabase(): Promise<void> {
  const database = await openDatabase()
  const transaction = database.transaction('settings', 'readwrite')
  const store = transaction.objectStore('settings')
  const done = transactionResult(transaction, () => undefined)
  const request = store.get('settings')
  request.onsuccess = () => {
    if (!request.result) store.put({ ...DEFAULT_SETTINGS })
  }
  await done
}

export async function loadSnapshot(): Promise<AppSnapshot> {
  await initializeDatabase()
  const database = await openDatabase()
  const transaction = database.transaction(['settings', 'products', 'invoices'], 'readonly')
  const done = transactionResult(transaction, () => ({
    settings: settingsResult ?? { ...DEFAULT_SETTINGS },
    products: (productsResult ?? []) as Product[],
    invoices: (invoicesResult ?? []) as Invoice[],
  }))
  let settingsResult: AppSettings | undefined
  let productsResult: Product[] | undefined
  let invoicesResult: Invoice[] | undefined

  transaction.objectStore('settings').get('settings').onsuccess = (event) => {
    settingsResult = (event.target as IDBRequest<AppSettings>).result
  }
  transaction.objectStore('products').getAll().onsuccess = (event) => {
    productsResult = (event.target as IDBRequest<Product[]>).result
  }
  transaction.objectStore('invoices').getAll().onsuccess = (event) => {
    invoicesResult = (event.target as IDBRequest<Invoice[]>).result
  }

  const snapshot = await done
  snapshot.products.sort((a, b) => a.name.localeCompare(b.name, 'fa'))
  snapshot.invoices.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  return snapshot
}

export async function saveProduct(input: ProductDraft): Promise<Product> {
  const name = input.name.trim()
  const unit = input.unit.trim() || 'عدد'
  if (!name) throw new Error('نام محصول را وارد کنید.')
  if (!Number.isSafeInteger(input.price) || input.price < 0) {
    throw new Error('قیمت باید عدد صحیح و نامنفی به تومان باشد.')
  }

  const database = await openDatabase()
  const transaction = database.transaction('products', 'readwrite')
  const store = transaction.objectStore('products')
  const id = input.id ?? makeId()
  let saved: Product
  const done = transactionResult(transaction, () => saved)
  const request = store.get(id)
  request.onsuccess = () => {
    const existing = request.result as Product | undefined
    const now = new Date().toISOString()
    saved = {
      id,
      name,
      unit,
      price: input.price,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }
    store.put(saved)
  }
  return done
}

export async function saveSettings(input: AppSettings): Promise<void> {
  const storeName = input.storeName.trim()
  if (!storeName) throw new Error('نام فروشگاه را وارد کنید.')
  if (!Number.isSafeInteger(input.nextInvoiceNumber) || input.nextInvoiceNumber < 1) {
    throw new Error('شمارهٔ فاکتور بعدی معتبر نیست.')
  }
  if (input.logoDataUrl && !/^data:image\/(?:png|jpeg|webp);base64,/i.test(input.logoDataUrl)) {
    throw new Error('لوگو باید تصویر PNG، JPEG یا WebP باشد.')
  }
  const database = await openDatabase()
  const transaction = database.transaction('settings', 'readwrite')
  const done = transactionResult(transaction, () => undefined)
  transaction.objectStore('settings').put({ ...input, id: 'settings', storeName })
  await done
}

export async function deleteProduct(id: string): Promise<void> {
  const database = await openDatabase()
  const transaction = database.transaction('products', 'readwrite')
  const done = transactionResult(transaction, () => undefined)
  transaction.objectStore('products').delete(id)
  await done
}

function validateInvoiceDraft(input: InvoiceDraft): void {
  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw new Error('برای ذخیره، دست‌کم یک قلم به فاکتور اضافه کنید.')
  }
  for (const item of input.items) {
    if (!item.name.trim()) throw new Error('نام همهٔ اقلام فاکتور را کامل کنید.')
  }
  calculateInvoiceTotals(input.items, input.discountPercent)
}

export async function saveInvoice(input: InvoiceDraft): Promise<Invoice> {
  validateInvoiceDraft(input)
  const database = await openDatabase()
  const transaction = database.transaction(['invoices', 'settings'], 'readwrite')
  const invoices = transaction.objectStore('invoices')
  const settings = transaction.objectStore('settings')
  const id = input.id ?? makeId()
  const now = new Date().toISOString()
  let existing: Invoice | undefined
  let currentSettings: AppSettings = { ...DEFAULT_SETTINGS }
  let invoiceRequestDone = input.id === undefined
  let settingsRequestDone = false
  let saved: Invoice
  let started = false
  const done = transactionResult(transaction, () => saved)

  const commitWhenReady = () => {
    if (!invoiceRequestDone || !settingsRequestDone || started) return
    started = true
    const isNew = !existing
    const nextNumber = Number.isSafeInteger(currentSettings.nextInvoiceNumber) && currentSettings.nextInvoiceNumber > 0
      ? currentSettings.nextInvoiceNumber
      : 1
    saved = {
      id,
      number: existing?.number ?? formatInvoiceNumber(nextNumber),
      customerName: input.customerName.trim(),
      customerPhone: input.customerPhone.trim(),
      notes: input.notes.trim(),
      status: input.status,
      discountPercent: input.discountPercent,
      items: input.items.map((item) => ({ ...item, name: item.name.trim(), unit: item.unit.trim() || 'عدد' })),
      totals: calculateInvoiceTotals(input.items, input.discountPercent),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }
    invoices.put(saved)
    if (isNew) {
      settings.put({ ...currentSettings, id: 'settings', nextInvoiceNumber: nextNumber + 1 })
    }
  }

  const settingRequest = settings.get('settings')
  settingRequest.onsuccess = () => {
    currentSettings = settingRequest.result ?? { ...DEFAULT_SETTINGS }
    settingsRequestDone = true
    commitWhenReady()
  }

  if (input.id) {
    const invoiceRequest = invoices.get(input.id)
    invoiceRequest.onsuccess = () => {
      existing = invoiceRequest.result as Invoice | undefined
      invoiceRequestDone = true
      commitWhenReady()
    }
  } else {
    commitWhenReady()
  }

  return done
}

export async function deleteInvoice(id: string): Promise<void> {
  const database = await openDatabase()
  const transaction = database.transaction('invoices', 'readwrite')
  const done = transactionResult(transaction, () => undefined)
  transaction.objectStore('invoices').delete(id)
  await done
}

export async function replaceAllData(snapshot: AppSnapshot): Promise<void> {
  const database = await openDatabase()
  const transaction = database.transaction(['settings', 'products', 'invoices'], 'readwrite')
  const settings = transaction.objectStore('settings')
  const products = transaction.objectStore('products')
  const invoices = transaction.objectStore('invoices')
  const done = transactionResult(transaction, () => undefined)

  settings.clear()
  products.clear()
  invoices.clear()
  settings.put({ ...snapshot.settings, id: 'settings' })
  for (const product of snapshot.products) products.put(product)
  for (const invoice of snapshot.invoices) invoices.put(invoice)
  await done
}
