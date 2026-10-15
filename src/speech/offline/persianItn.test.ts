import { describe, expect, it } from 'vitest'
import { parseCommand } from '../../domain/commands'
import { applyPersianItn, itnForCommand, parseSpokenNumber, toPersianDigits } from './persianItn'

describe('تبدیل عدد گفتاری فارسی به رقم', () => {
  it('عددهای ساده و ترکیبی را می‌فهمد', () => {
    expect(parseSpokenNumber(['صفر'])).toBe(0)
    expect(parseSpokenNumber(['دو'])).toBe(2)
    expect(parseSpokenNumber(['بیست', 'و', 'سه'])).toBe(23)
    expect(parseSpokenNumber(['سی', 'و', 'چهار'])).toBe(34)
    expect(parseSpokenNumber(['صد', 'و', 'بیست'])).toBe(120)
    expect(parseSpokenNumber(['هزار', 'و', 'پنج'])).toBe(1005)
    expect(parseSpokenNumber(['سلام'])).toBeNull()
  })

  it('ارقام را فارسی می‌نویسد', () => {
    expect(toPersianDigits(1402)).toBe('۱۴۰۲')
  })

  it('جملهٔ دستور را با ارقام فارسی بازنویسی می‌کند', () => {
    expect(applyPersianItn('سه عدد شیر به فاکتور اضافه کن')).toBe('۳ عدد شیر به فاکتور اضافه کن')
    expect(applyPersianItn('تعداد برنج را به دو تغییر بده')).toBe('تعداد برنج را به ۲ تغییر بده')
    expect(applyPersianItn('دو کیسه برنج هاشمی به فاکتور اضافه کنید')).toBe('۲ کیسه برنج هاشمی به فاکتور اضافه کنید')
  })

  it('متنی که عدد گفتاری ندارد دست‌نخورده می‌ماند', () => {
    expect(applyPersianItn('سلام حال شما خوبه')).toBe('سلام حال شما خوبه')
    expect(applyPersianItn('')).toBe('')
    expect(applyPersianItn('قیمت روغن را ۱۰ درصد افزایش بده')).toBe('قیمت روغن را ۱۰ درصد افزایش بده')
  })
})

describe('گارد دستور: بازنویسی هرگز معنای فرمان را عوض نمی‌کند', () => {
  it('اگر هر دو نسخه یک فرمان بدهند، نسخهٔ رقمی نمایش داده می‌شود', () => {
    const raw = 'سه عدد شیر به فاکتور اضافه کن'
    const result = itnForCommand(raw, parseCommand)
    expect(result).toBe('۳ عدد شیر به فاکتور اضافه کن')
    expect(parseCommand(result)).toEqual(parseCommand(raw))
    expect(parseCommand(result)).toMatchObject({ type: 'addInvoiceItem', productName: 'شیر', quantity: 3 })
  })

  it('«دو کیسه برنج هاشمی» پس از بازنویسی همان فرمان را می‌دهد', () => {
    const raw = 'دو کیسه برنج هاشمی به فاکتور اضافه کن'
    const result = itnForCommand(raw, parseCommand)
    expect(parseCommand(result)).toMatchObject({ type: 'addInvoiceItem', productName: 'برنج هاشمی', quantity: 2 })
  })

  it('وقتی بازنویسی نام کالا را تغییر دهد، متن اصلی حفظ می‌شود', () => {
    const raw = 'دو عدد دو به فاکتور اضافه کن'
    expect(parseCommand(raw)).toMatchObject({ productName: 'دو' })
    expect(itnForCommand(raw, parseCommand)).toBe(raw)
  })

  it('متنی که فرمان شناخته‌شده نیست، بدون تغییر باقی می‌ماند', () => {
    const raw = 'سلام سه تا نان'
    expect(parseCommand(raw)).toBeNull()
    expect(itnForCommand(raw, parseCommand)).toBe(raw)
  })
})
