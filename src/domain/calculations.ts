import type { InvoiceLine, InvoiceTotals } from './types'

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER)
const QUANTITY_SCALE = 1_000n
const BASIS_POINT_SCALE = 10_000n

export class CalculationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CalculationError'
  }
}

function safeInteger(value: bigint, label: string): number {
  if (value < 0n || value > MAX_SAFE) {
    throw new CalculationError(`${label} از محدودهٔ مجاز خارج است.`)
  }
  return Number(value)
}

function quantityMilli(quantity: number): bigint {
  if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 1_000_000) {
    throw new CalculationError('تعداد باید عددی بزرگ‌تر از صفر باشد.')
  }
  const scaled = quantity * Number(QUANTITY_SCALE)
  const rounded = Math.round(scaled)
  if (rounded < 1 || Math.abs(scaled - rounded) > 1e-7) {
    throw new CalculationError('تعداد را حداکثر تا سه رقم اعشار وارد کنید.')
  }
  return BigInt(rounded)
}

function validatePrice(price: number): bigint {
  if (!Number.isSafeInteger(price) || price < 0) {
    throw new CalculationError('قیمت واحد باید یک عدد صحیح و نامنفی به تومان باشد.')
  }
  return BigInt(price)
}

function percentBasisPoints(percent: number): bigint {
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
    throw new CalculationError('درصد تخفیف باید بین صفر تا صد باشد.')
  }
  return BigInt(Math.round(percent * 100))
}

function roundedRatio(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator / 2n) / denominator
}

export interface LineAmounts {
  subtotal: number
  discount: number
  total: number
}

export function calculateLineAmounts(line: Pick<InvoiceLine, 'quantity' | 'unitPrice' | 'discountPercent'>): LineAmounts {
  const gross = roundedRatio(validatePrice(line.unitPrice) * quantityMilli(line.quantity), QUANTITY_SCALE)
  const discountRate = percentBasisPoints(line.discountPercent)
  const discount = roundedRatio(gross * discountRate, BASIS_POINT_SCALE)
  const net = gross - discount
  return {
    subtotal: safeInteger(gross, 'جمع ردیف'),
    discount: safeInteger(discount, 'تخفیف ردیف'),
    total: safeInteger(net, 'مبلغ ردیف'),
  }
}

export function calculateInvoiceTotals(
  items: Array<Pick<InvoiceLine, 'quantity' | 'unitPrice' | 'discountPercent'>>,
  invoiceDiscountPercent = 0,
): InvoiceTotals {
  const invoiceDiscountRate = percentBasisPoints(invoiceDiscountPercent)
  let subtotal = 0n
  let afterLineDiscounts = 0n

  for (const item of items) {
    const line = calculateLineAmounts(item)
    subtotal += BigInt(line.subtotal)
    afterLineDiscounts += BigInt(line.total)
  }

  const lineDiscount = subtotal - afterLineDiscounts
  const invoiceDiscount = roundedRatio(afterLineDiscounts * invoiceDiscountRate, BASIS_POINT_SCALE)
  const total = afterLineDiscounts - invoiceDiscount

  return {
    subtotal: safeInteger(subtotal, 'جمع جزء'),
    itemDiscount: safeInteger(lineDiscount, 'تخفیف اقلام'),
    invoiceDiscount: safeInteger(invoiceDiscount, 'تخفیف فاکتور'),
    total: safeInteger(total, 'جمع کل'),
  }
}

export function applyPercentageChange(price: number, percent: number, direction: 'increase' | 'decrease'): number {
  const current = validatePrice(price)
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
    throw new CalculationError('درصد تغییر باید بین صفر تا صد باشد.')
  }
  const changeRate = BigInt(Math.round(percent * 100))
  const multiplier = direction === 'increase' ? BASIS_POINT_SCALE + changeRate : BASIS_POINT_SCALE - changeRate
  return safeInteger(roundedRatio(current * multiplier, BASIS_POINT_SCALE), 'قیمت جدید')
}

export function formatToman(amount: number): string {
  if (!Number.isFinite(amount)) return '—'
  return `${new Intl.NumberFormat('fa-IR', { maximumFractionDigits: 0 }).format(amount)} تومان`
}

export function formatNumber(value: number, maximumFractionDigits = 3): string {
  if (!Number.isFinite(value)) return '—'
  return new Intl.NumberFormat('fa-IR', { maximumFractionDigits }).format(value)
}

export function parseLocalizedNumber(value: string): number | null {
  const converted = normalizeDigits(value)
    .replace(/[٬،,]/g, '')
    .replace(/٫/g, '.')
    .replace(/\s/g, '')
  if (!converted || !/^-?\d+(?:\.\d+)?$/.test(converted)) return null
  const result = Number(converted)
  return Number.isFinite(result) ? result : null
}

export function normalizeDigits(value: string): string {
  return value
    .replace(/[۰-۹]/g, (digit) => String(digit.charCodeAt(0) - 0x06f0))
    .replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 0x0660))
}
