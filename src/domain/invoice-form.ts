import type { Invoice, InvoiceDraft, InvoiceLine } from './types'

export interface InvoiceLineForm {
  id: string
  productId: string | null
  name: string
  unit: string
  quantity: string
  unitPrice: string
  discountPercent: string
}

export interface InvoiceForm {
  id?: string
  number?: string
  customerName: string
  customerPhone: string
  notes: string
  status: 'draft' | 'paid'
  discountPercent: string
  items: InvoiceLineForm[]
}

export function blankInvoiceForm(): InvoiceForm {
  return {
    customerName: '',
    customerPhone: '',
    notes: '',
    status: 'draft',
    discountPercent: '0',
    items: [],
  }
}

export function lineToForm(line: InvoiceLine): InvoiceLineForm {
  return {
    id: line.id,
    productId: line.productId,
    name: line.name,
    unit: line.unit,
    quantity: String(line.quantity),
    unitPrice: String(line.unitPrice),
    discountPercent: String(line.discountPercent),
  }
}

export function invoiceToForm(invoice: Invoice): InvoiceForm {
  return {
    id: invoice.id,
    number: invoice.number,
    customerName: invoice.customerName,
    customerPhone: invoice.customerPhone,
    notes: invoice.notes,
    status: invoice.status,
    discountPercent: String(invoice.discountPercent),
    items: invoice.items.map(lineToForm),
  }
}

export function toInvoiceDraft(form: InvoiceForm, parseNumber: (value: string) => number | null): InvoiceDraft {
  const discountPercent = parseNumber(form.discountPercent)
  if (discountPercent === null) throw new Error('درصد تخفیف کلی را به‌صورت عدد معتبر وارد کنید.')
  const items: InvoiceLine[] = form.items.map((item) => {
    const quantity = parseNumber(item.quantity)
    const unitPrice = parseNumber(item.unitPrice)
    const discount = parseNumber(item.discountPercent)
    if (quantity === null || unitPrice === null || discount === null) {
      throw new Error(`تعداد، قیمت یا تخفیف «${item.name || 'قلم بدون نام'}» معتبر نیست.`)
    }
    return {
      id: item.id,
      productId: item.productId,
      name: item.name.trim(),
      unit: item.unit.trim() || 'عدد',
      quantity,
      unitPrice,
      discountPercent: discount,
    }
  })
  return {
    ...(form.id ? { id: form.id } : {}),
    ...(form.number ? { number: form.number } : {}),
    customerName: form.customerName,
    customerPhone: form.customerPhone,
    notes: form.notes,
    status: form.status,
    discountPercent,
    items,
  }
}
