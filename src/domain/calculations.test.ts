import { describe, expect, it } from 'vitest'
import {
  applyPercentageChange,
  calculateInvoiceTotals,
  calculateLineAmounts,
  CalculationError,
  parseLocalizedNumber,
} from './calculations'

describe('محاسبات مبلغ و تخفیف', () => {
  it('تعداد اعشاری و تخفیف هر ردیف را با گردکردن تومان محاسبه می‌کند', () => {
    expect(calculateLineAmounts({ quantity: 2.5, unitPrice: 1_000, discountPercent: 10 })).toEqual({
      subtotal: 2_500,
      discount: 250,
      total: 2_250,
    })
    expect(calculateLineAmounts({ quantity: 0.333, unitPrice: 333, discountPercent: 0 })).toEqual({
      subtotal: 111,
      discount: 0,
      total: 111,
    })
  })

  it('تخفیف اقلام و تخفیف کلی را به‌ترتیب و بر مبنای تومان صحیح اعمال می‌کند', () => {
    expect(calculateInvoiceTotals([
      { quantity: 2, unitPrice: 1_000, discountPercent: 10 },
      { quantity: 1, unitPrice: 500, discountPercent: 0 },
    ], 10)).toEqual({
      subtotal: 2_500,
      itemDiscount: 200,
      invoiceDiscount: 230,
      total: 2_070,
    })
  })

  it('ورودی‌های نامعتبر را بی‌صدا به مبلغ تبدیل نمی‌کند', () => {
    expect(() => calculateLineAmounts({ quantity: 0, unitPrice: 100, discountPercent: 0 })).toThrow(CalculationError)
    expect(() => calculateLineAmounts({ quantity: 0.0001, unitPrice: 100, discountPercent: 0 })).toThrow(/سه رقم اعشار/)
    expect(calculateLineAmounts({ quantity: 1, unitPrice: 125, discountPercent: 10 })).toEqual({ subtotal: 125, discount: 13, total: 112 })
    expect(() => calculateLineAmounts({ quantity: 1, unitPrice: 10.5, discountPercent: 0 })).toThrow(/عدد صحیح/)
    expect(() => calculateInvoiceTotals([], 100.01)).toThrow(/بین صفر تا صد/)
  })

  it('افزایش و کاهش درصدی قیمت را با گردکردن صحیح انجام می‌دهد', () => {
    expect(applyPercentageChange(1_000, 10, 'increase')).toBe(1_100)
    expect(applyPercentageChange(1_000, 10, 'decrease')).toBe(900)
    expect(applyPercentageChange(125, 10, 'increase')).toBe(138)
    expect(applyPercentageChange(125, 10, 'decrease')).toBe(113)
    expect(() => applyPercentageChange(Number.MAX_SAFE_INTEGER, 100, 'increase')).toThrow(CalculationError)
  })

  it('ارقام فارسی و جداکننده‌های رایج را برای ورود عدد می‌خواند', () => {
    expect(parseLocalizedNumber('۱۲۳٬۴۵۶')).toBe(123456)
    expect(parseLocalizedNumber('٢٥٫٥')).toBe(25.5)
    expect(parseLocalizedNumber('')).toBeNull()
    expect(parseLocalizedNumber('۱۲abc')).toBeNull()
  })
})
