import { describe, expect, it } from 'vitest'
import { parseSpeechText, parseSpokenItems } from './commands'
import { itnForCommand } from '../speech/offline/persianItn'
import { matchProduct, planSpokenItems } from './command-execution'
import type { Product } from './types'

describe('اقلام گفتاری چندقلمی — جمله‌های نمونه', () => {
  it('جملهٔ نمونهٔ کاربر را به سه قلم با تعداد درست تبدیل می‌کند', () => {
    const list = parseSpokenItems('دو تا لنت ترمز پراید، چهار تا لاستیک دنا سمند، یک جفت چراغ خطر پژو ۴۰۵')
    expect(list).not.toBeNull()
    expect(list!.items).toHaveLength(3)
    expect(list!.items[0]).toMatchObject({ status: 'ok', productName: 'لنت ترمز پراید', quantity: 2, unit: null, unitPrice: null })
    expect(list!.items[1]).toMatchObject({ status: 'ok', productName: 'لاستیک دنا سمند', quantity: 4 })
    // «یک جفت» = ۲ عدد؛ ارقام فارسی داخل نام کالا حفظ می‌شوند (پس از نرمال‌سازی به ۴۰۵).
    expect(list!.items[2]).toMatchObject({ status: 'ok', productName: 'چراغ خطر پژو 405', quantity: 2 })
  })

  it.each([
    ['دو تا لنت ترمز پراید', 2, 'لنت ترمز پراید'],
    ['چهار تا لاستیک دنا سمند', 4, 'لاستیک دنا سمند'],
    ['یک جفت چراغ خطر پژو ۴۰۵', 2, 'چراغ خطر پژو 405'],
  ])('سناریوی تک‌قلمی: «%s» → %s عدد %s', (input, quantity, productName) => {
    const list = parseSpokenItems(input)
    expect(list!.items).toHaveLength(1)
    expect(list!.items[0]).toMatchObject({ status: 'ok', productName, quantity, unit: null, unitPrice: null })
    expect(list!.items[0]!.raw).toContain(' ')
  })
})

describe('تبدیل عدد فارسی و عربی و حروفی به عدد', () => {
  it.each([
    ['دو تا شیر', 2],
    ['۲ تا شیر', 2],
    ['٤ تا ماست', 4],
    ['سه تا برنج', 3],
    ['یک عدد روغن', 1],
    ['۱ عدد روغن', 1],
    ['یک جفت چراغ', 2],
    ['دو جفت چراغ', 4],
    ['جفت چراغ', 2],
    ['بیست و سه عدد شیر', 23],
    ['پنج تا تخم مرغ', 5],
  ])('«%s» را با تعداد %s می‌خواند', (input, quantity) => {
    const list = parseSpokenItems(input)
    expect(list!.items[0]).toMatchObject({ status: 'ok', quantity })
  })

  it('ترتیب معکوس (نام و سپس تعداد + واحد) را می‌خواند ولی شمارهٔ پایانی نام کالا را تعداد حساب نمی‌کند', () => {
    expect(parseSpokenItems('شیر سه عدد')!.items[0]).toMatchObject({ status: 'ok', productName: 'شیر', quantity: 3 })
    expect(parseSpokenItems('لنت ترمز ۲ عدد')!.items[0]).toMatchObject({ status: 'ok', productName: 'لنت ترمز', quantity: 2 })
    // «پژو ۴۰۵» — پایانِ نام کالا بدون واحد، تعداد نیست؛ نام تنها = ۱ عدد با نام کامل:
    expect(parseSpokenItems('چراغ خطر پژو ۴۰۵، دو تا لنت')!.items[0]).toMatchObject({ status: 'ok', productName: 'چراغ خطر پژو 405', quantity: 1, implicitQuantity: true })
  })
})

describe('جداکننده‌های «،» و «و» و «، و»', () => {
  it('«و» بین دو قلم دارای تعداد جدا می‌کند', () => {
    const list = parseSpokenItems('دو تا لنت و چهار تا لاستیک')
    expect(list!.items).toHaveLength(2)
    expect(list!.items[0]).toMatchObject({ productName: 'لنت', quantity: 2 })
    expect(list!.items[1]).toMatchObject({ productName: 'لاستیک', quantity: 4 })
  })

  it('«، و» را مانند «،» جدا می‌کند', () => {
    const list = parseSpokenItems('دو تا لنت، و چهار تا لاستیک')
    expect(list!.items).toHaveLength(2)
  })

  it('«و» داخل عدد («بیست و سه») و داخل نام کالا («روغن و فیلتر») را نمی‌شکند', () => {
    const one = parseSpokenItems('بیست و سه عدد شیر')!
    expect(one.items).toHaveLength(1)
    expect(one.items[0]).toMatchObject({ quantity: 23, productName: 'شیر' })

    const named = parseSpokenItems('دو تا روغن و فیلتر')!
    expect(named.items).toHaveLength(1)
    expect(named.items[0]).toMatchObject({ quantity: 2, productName: 'روغن و فیلتر' })
  })

  it('«و» داخل قیمت («صد و بیست هزار») را نمی‌شکند', () => {
    const list = parseSpokenItems('دو تا شیر به قیمت صد و بیست هزار')
    expect(list!.items).toHaveLength(1)
    expect(list!.items[0]).toMatchObject({ quantity: 2, productName: 'شیر', unitPrice: 120_000 })
  })
})

describe('قیمت گفتاری هر قلم', () => {
  it.each([
    ['دو تا لنت به قیمت هر کدام صد و بیست هزار تومان', 120_000],
    ['دو تا لنت به قیمت دویست و پنجاه هزار', 250_000],
    ['یک عدد روغن ۲۵۰۰۰۰ تومان', 250_000],
    ['سه تا فیلتر به قیمت ٢٥٠٠٠', 25_000],
    ['یک عدد شیر ۳۵٬۰۰۰ تومان', 35_000],
    ['دو تا لنت قیمتش ۱۲۰۰۰۰۰', 1_200_000],
  ])('«%s» → قیمت واحد %s', (input, unitPrice) => {
    const list = parseSpokenItems(input)
    expect(list!.items[0]).toMatchObject({ status: 'ok', unitPrice })
  })

  it('قیمت گفته‌شدهٔ نامعتبر را حدس نمی‌زند و به بازبینی می‌سپارد', () => {
    const list = parseSpokenItems('دو تا لنت به قیمت گران')
    expect(list!.items).toHaveLength(1)
    expect(list!.items[0]).toMatchObject({ status: 'review' })
    expect(list!.items[0]).toHaveProperty('reason')
    expect(parseSpokenItems('دو تا لنت تومان')!.items[0]).toMatchObject({ status: 'review' })
  })
})

describe('نام تنها کالا (بدون گفتن تعداد)', () => {
  it('قلم بدون تعداد، تعداد پیش‌فرض ۱ می‌گیرد (قابل ویرایش) و حدس پنهان نیست', () => {
    const list = parseSpokenItems('دو تا لنت ترمز پراید، چراغ خطر')
    expect(list!.items).toHaveLength(2)
    expect(list!.items[0]).toMatchObject({ status: 'ok', productName: 'لنت ترمز پراید', implicitQuantity: false })
    expect(list!.items[1]).toMatchObject({ status: 'ok', raw: 'چراغ خطر', productName: 'چراغ خطر', quantity: 1, implicitQuantity: true })
  })

  it('نام تنها با کلمات تازه هم قلم می‌شود: «سیب‌زمینی»، «شکر»، «قند»', () => {
    // نرمال‌سازیِ مشترک، نیم‌فاصله را به فاصله تبدیل می‌کند
    expect(parseSpokenItems('سیب‌زمینی')!.items[0]).toMatchObject({ status: 'ok', productName: 'سیب زمینی', quantity: 1, implicitQuantity: true })
    const two = parseSpokenItems('شکر، قند')!
    expect(two.items).toHaveLength(2)
    expect(two.items[0]).toMatchObject({ productName: 'شکر', quantity: 1, implicitQuantity: true })
    expect(two.items[1]).toMatchObject({ productName: 'قند', quantity: 1, implicitQuantity: true })
  })

  it('نام تنها با قیمت گفته‌شده، قیمت را می‌گیرد', () => {
    expect(parseSpokenItems('ماکارونی به قیمت ۲۵۰۰۰۰')!.items[0]).toMatchObject({ status: 'ok', productName: 'ماکارونی', quantity: 1, unitPrice: 250_000 })
  })

  it('قلم بدون نام کالا را با دلیل نشان می‌دهد', () => {
    const list = parseSpokenItems('دو تا')
    expect(list!.items[0]).toMatchObject({ status: 'review' })
    expect((list!.items[0] as { reason: string }).reason).toContain('نام کالا')
  })
})

describe('متن‌هایی که فهرست اقلام نیستند', () => {
  it.each([
    [''],
    ['   '],
    ['همه کارها را انجام بده'],
    ['این‌ها را برایم تغییر بده'],
  ])('برای «%s» null برمی‌گرداند تا مسیر پیام «دستور ناشناخته» دست‌نخورده بماند', (input) => {
    expect(parseSpokenItems(input)).toBeNull()
  })
})

describe('تطبیق محصول و ردیف‌های آماده/نیازمند تکمیل (planSpokenItems)', () => {
  const now = '2026-10-17'
  const products: Product[] = [
    { id: 'p-chickpea', name: 'نخود', unit: 'کیلو', price: 90_000, createdAt: now, updatedAt: now },
    { id: 'p-lentil', name: 'عدس', unit: 'کیلو', price: 75_000, createdAt: now, updatedAt: now },
    { id: 'p-red-bean', name: 'لوبیا قرمز', unit: 'کیلو', price: 110_000, createdAt: now, updatedAt: now },
    { id: 'p-white-bean', name: 'لوبیا سفید', unit: 'کیلو', price: 120_000, createdAt: now, updatedAt: now },
  ]

  it('matchProduct: دقیق بر جزئی می‌چربد و چند جزئی، مبهم است', () => {
    expect(matchProduct('عدس', products)).toMatchObject({ matchKind: 'exact', product: { id: 'p-lentil' } })
    expect(matchProduct('لوبیا', products).matchKind).toBe('ambiguous')
    expect(matchProduct('لوبیا', products).candidates).toHaveLength(2)
    expect(matchProduct('عدس ریز', products)).toMatchObject({ matchKind: 'partial', product: { id: 'p-lentil' } })
    expect(matchProduct('ماکارونی', products).matchKind).toBe('none')
  })

  it('planSpokenItems: قیمتِ گفته‌شده از قیمت کاتالوگ جلوتر است و ردیفِ بدون قیمت، دلیلِ تکمیل می‌گیرد', () => {
    const ready = planSpokenItems(parseSpokenItems('دو تا نخود به قیمت ۱۰۰۰۰۰')!.items, products)
    expect(ready).toHaveLength(1)
    expect(ready[0]).toMatchObject({ productName: 'نخود', quantity: 2, unitPrice: 100_000, reason: null, product: { id: 'p-chickpea' } })

    const missingPrice = planSpokenItems(parseSpokenItems('لوبیا قرمز')!.items, products)
    expect(missingPrice[0]).toMatchObject({ productName: 'لوبیا قرمز', quantity: 1, unitPrice: 110_000, reason: null })

    const noPriceNoCatalog = planSpokenItems(parseSpokenItems('عدس')!.items, [])
    expect(noPriceNoCatalog[0]!.reason).toContain('قیمت')
    expect(noPriceNoCatalog[0]).toMatchObject({ unitPrice: null, quantity: 1 })

    const ambiguous = planSpokenItems(parseSpokenItems('لوبیا')!.items, products)
    expect(ambiguous[0]!.reason).toContain('چند محصول مشابه')
    expect(ambiguous[0]).toMatchObject({ unitPrice: null, product: null })
  })
})

describe('پشتیبان گارد ITN فارسی', () => {
  it('اعداد حروفی جملهٔ اقلام را با حفظ همان معنا به رقم تبدیل می‌کند', () => {
    expect(itnForCommand('دو تا لنت ترمز پراید', parseSpeechText)).toBe('۲ تا لنت ترمز پراید')
    expect(itnForCommand('دو تا لنت، چهار تا لاستیک', parseSpeechText)).toBe('۲ تا لنت، ۴ تا لاستیک')
  })
})
