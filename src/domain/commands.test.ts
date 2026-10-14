import { describe, expect, it } from 'vitest'
import { parseCommand, supportedCommandExamples } from './commands'

describe('دستورهای فارسیِ صریح و محلی', () => {
  it.each([
    ['قیمت روغن را ۱۰ درصد افزایش بده', { type: 'changeProductPrice', productName: 'روغن', percent: 10, direction: 'increase' }],
    ['سه عدد شیر به فاکتور اضافه کن', { type: 'addInvoiceItem', productName: 'شیر', quantity: 3 }],
    ['تعداد برنج را به دو تغییر بده', { type: 'setInvoiceQuantity', productName: 'برنج', quantity: 2 }],
    ['محصول روغن را حذف کن', { type: 'deleteProduct', productName: 'روغن' }],
  ])('نمونهٔ پشتیبانی‌شده را می‌خواند: %s', (input, expected) => {
    expect(parseCommand(input)).toEqual(expected)
  })

  it('واحد «کیسه» را از نام محصول جدا می‌کند و همان تعداد فارسی را می‌خواند', () => {
    expect(parseCommand('دو کیسه برنج هاشمی به فاکتور اضافه کن')).toEqual({
      type: 'addInvoiceItem',
      productName: 'برنج هاشمی',
      quantity: 2,
    })
  })

  it('اعداد عربی و صورت بی‌نام «این محصول» را تشخیص می‌دهد', () => {
    expect(parseCommand('قیمت روغن را ١٠ درصد افزایش بده')).toMatchObject({ percent: 10, direction: 'increase' })
    expect(parseCommand('این محصول را حذف کن')).toEqual({ type: 'deleteProduct', productName: '' })
  })

  it('تغییر قیمت را به درصد معتبر محدود می‌کند و عبارت نامشخص را اجراشدنی جلوه نمی‌دهد', () => {
    expect(parseCommand('قیمت روغن را ۱۲۰ درصد افزایش بده')).toBeNull()
    expect(parseCommand('همهٔ کارها را انجام بده')).toBeNull()
    expect(supportedCommandExamples).toHaveLength(4)
  })
})
