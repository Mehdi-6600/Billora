export type InvoiceStatus = 'draft' | 'paid'

export interface Product {
  id: string
  name: string
  unit: string
  price: number
  createdAt: string
  updatedAt: string
}

export interface InvoiceLine {
  id: string
  productId: string | null
  name: string
  unit: string
  quantity: number
  unitPrice: number
  discountPercent: number
}

export interface InvoiceTotals {
  subtotal: number
  itemDiscount: number
  invoiceDiscount: number
  total: number
}

export interface Invoice {
  id: string
  number: string
  customerName: string
  customerPhone: string
  notes: string
  status: InvoiceStatus
  discountPercent: number
  items: InvoiceLine[]
  totals: InvoiceTotals
  createdAt: string
  updatedAt: string
}

export interface InvoiceDraft {
  id?: string
  number?: string
  customerName: string
  customerPhone: string
  notes: string
  status: InvoiceStatus
  discountPercent: number
  items: InvoiceLine[]
}

export interface AppSettings {
  id: 'settings'
  storeName: string
  phone: string
  address: string
  logoDataUrl: string | null
  nextInvoiceNumber: number
}

export interface AppSnapshot {
  settings: AppSettings
  products: Product[]
  invoices: Invoice[]
}

export interface ProductDraft {
  id?: string
  name: string
  unit: string
  price: number
}
