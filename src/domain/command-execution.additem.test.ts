import { describe, expect, it } from 'vitest'
import { planCommand } from './command-execution'
import { blankInvoiceForm } from './invoice-form'
import { parseCommand } from './commands'
import type { Product } from './types'

const milk: Product = {
  id: 'milk-pak',
  name: 'شیر',
  unit: 'عدد',
  price: 35_000,
  createdAt: '2026-01-01',
  updatedAt: '2026-01-01',
}

describe('مسیر کامل «اجرای دستور» برای یک دستور افزودنی ساده', () => {
  it('دستور کوتاه «سه عدد شیر» با وجود محصول «شیر» در کاتالوگ باید یک ردیف اضافه کند', () => {
    const form = blankInvoiceForm()
    expect(form.items).toHaveLength(0)

    const text = 'سه عدد شیر'
    const command = parseCommand(text)
    expect(command).not.toBeNull()
    expect(command?.type).toBe('addInvoiceItem')

    const plan = planCommand(command!, form.items, [milk])
    expect(plan.kind).toBe('addInvoiceItem')
    if (plan.kind !== 'addInvoiceItem') throw new Error('plan was not addInvoiceItem')
    expect(plan.line).toMatchObject({
      productId: 'milk-pak',
      name: 'شیر',
      unit: 'عدد',
      quantity: '3',
      unitPrice: '35000',
    })
    expect(plan.catalogProductFound).toBe(true)
  })

  it('با عبارت محاوره‌ای «شیر سه عدد» و «شیر ۳ عدد» هم ردیف درست اضافه می‌شود', () => {
    const command = parseCommand('شیر سه عدد')
    expect(command).toMatchObject({ type: 'addInvoiceItem', productName: 'شیر', quantity: 3 })
    const command2 = parseCommand('شیر ۳ عدد')
    expect(command2).toMatchObject({ type: 'addInvoiceItem', productName: 'شیر', quantity: 3 })
  })
})
