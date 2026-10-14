import { describe, expect, it } from 'vitest'
import { calculateLineAmounts } from './calculations'
import { parseCommand } from './commands'
import { planCommand, productConfirmation } from './command-execution'
import type { InvoiceLineForm } from './invoice-form'
import type { Product } from './types'

const oil: Product = { id: 'oil-1', name: 'روغن', unit: 'بطری', price: 1_000, createdAt: '2026-01-01', updatedAt: '2026-01-01' }
const milk: Product = { id: 'milk-1', name: 'شیر', unit: 'عدد', price: 25_000, createdAt: '2026-01-01', updatedAt: '2026-01-01' }
const riceLine: InvoiceLineForm = { id: 'rice-line', productId: null, name: 'برنج', unit: 'کیلو', quantity: '1', unitPrice: '80', discountPercent: '0' }

function parse(input: string) {
  const command = parseCommand(input)
  if (!command) throw new Error(`Test command did not parse: ${input}`)
  return command
}

describe('برنامه‌ریزی اثر دستورهای فارسی', () => {
  it('«سه عدد شیر به فاکتور اضافه کن» را به قلمِ دارای قیمت پیش‌فرض تبدیل می‌کند', () => {
    const plan = planCommand(parse('سه عدد شیر به فاکتور اضافه کن'), [], [milk], () => 'new-line')
    expect(plan.kind).toBe('addInvoiceItem')
    if (plan.kind !== 'addInvoiceItem') return
    expect(plan.catalogProductFound).toBe(true)
    expect(plan.line).toMatchObject({ id: 'new-line', productId: 'milk-1', name: 'شیر', quantity: '3', unitPrice: '25000' })
    expect(calculateLineAmounts({ quantity: Number(plan.line.quantity), unitPrice: Number(plan.line.unitPrice), discountPercent: 0 }).total).toBe(75_000)
  })

  it('محصول ناشناخته را به شکل قلم دستیِ قیمت‌صفر می‌سازد تا کاربر آن را بررسی کند', () => {
    const plan = planCommand(parse('سه عدد ماست به فاکتور اضافه کن'), [], [milk], () => 'manual-line')
    expect(plan).toMatchObject({ kind: 'addInvoiceItem', catalogProductFound: false, line: { name: 'ماست', unitPrice: '0' } })
  })

  it('«تعداد برنج را به دو تغییر بده» فقط تعداد ردیف یکتای منطبق را عوض می‌کند', () => {
    expect(planCommand(parse('تعداد برنج را به دو تغییر بده'), [riceLine], [oil])).toEqual({
      kind: 'setInvoiceQuantity', lineId: 'rice-line', lineName: 'برنج', quantity: 2,
    })
    expect(planCommand(parse('تعداد برنج را به دو تغییر بده'), [], [oil])).toMatchObject({ kind: 'error' })
    expect(planCommand(parse('تعداد برنج را به دو تغییر بده'), [riceLine, { ...riceLine, id: 'rice-2' }], [oil])).toMatchObject({ kind: 'error' })
  })

  it('«قیمت روغن را ۱۰ درصد افزایش بده» را بدون اجرا به مرحلهٔ تأیید با مبلغ دقیق می‌برد', () => {
    const plan = planCommand(parse('قیمت روغن را ۱۰ درصد افزایش بده'), [], [oil])
    expect(plan.kind).toBe('confirmation')
    if (plan.kind !== 'confirmation') return
    expect(plan.matchKind).toBe('exact')
    expect(plan.action).toMatchObject({ type: 'changeProductPrice', newPrice: 1_100, product: oil })
    expect(oil.price).toBe(1_000)
  })

  it('حذف محصول را به تأیید می‌سپارد و هدف مبهم «این محصول» را انتخابی می‌کند', () => {
    const deletePlan = planCommand(parse('محصول روغن را حذف کن'), [], [oil])
    expect(deletePlan).toMatchObject({ kind: 'confirmation', action: { type: 'deleteProduct', product: oil } })
    const vaguePlan = planCommand(parse('این محصول را حذف کن'), [], [oil, milk])
    expect(vaguePlan).toMatchObject({ kind: 'chooseProduct', candidates: [oil, milk] })
    expect(productConfirmation(parse('محصول شیر را حذف کن'), milk)).toEqual({ type: 'deleteProduct', product: milk })
  })
})
