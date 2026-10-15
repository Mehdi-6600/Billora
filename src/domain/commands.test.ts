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

  it('واحد «عدد» را از نام محصول جدا می‌کند و «دو عدد برنج هاشمی» را با تعداد ۲ می‌خواند', () => {
    expect(parseCommand('دو عدد برنج هاشمی به فاکتور اضافه کن')).toEqual({
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

describe('تنوع متن تشخیص‌داده‌شدهٔ گفتار برای دستور افزودن قلم', () => {
  it.each([
    ['دو عدد برنج هاشمی به فاکتور اضافه کن', 'برنج هاشمی', 2],
    ['دو کیسه برنج هاشمی به فاکتور اضافه کن', 'برنج هاشمی', 2],
    ['2 عدد برنج هاشمی به فاکتور اضافه کن', 'برنج هاشمی', 2],
    ['۲ کیسه برنج هاشمی به فاکتور اضافه کن', 'برنج هاشمی', 2],
    ['٢ کیسه برنج هاشمی به فاکتور اضافه کن', 'برنج هاشمی', 2],
    ['  دو   عدد  برنج   هاشمی   به   فاکتور   اضافه   کن  ', 'برنج هاشمی', 2],
    ['دو عدد برنج هاشمی به فاکتور اضافه کن.', 'برنج هاشمی', 2],
    ['دو عدد برنج هاشمی به فاکتور اضافه‌کن', 'برنج هاشمی', 2],
    ['دو عدد برنج هاشمي به فاكتور اضافه كن', 'برنج هاشمی', 2],
    ['دو عدد برنج هاشمی به فاکتور اضافه کنید', 'برنج هاشمی', 2],
    ['دو عدد برنج هاشمی توی فاکتور اضافه کن', 'برنج هاشمی', 2],
    ['دو عدد برنج هاشمی به فاکتورم اضافه کن', 'برنج هاشمی', 2],
    ['دو کیسه برنج هاشمی را به فاکتور اضافه کن', 'برنج هاشمی', 2],
  ])('«%s» را به «%s» با تعداد %s تبدیل می‌کند', (input, productName, quantity) => {
    expect(parseCommand(input)).toEqual({ type: 'addInvoiceItem', productName, quantity })
  })

  it('جمله‌های ناقص یا نامفهوم را دستور معتبر جلوه نمی‌دهد', () => {
    expect(parseCommand('این دستور ناشناخته است')).toBeNull()
    expect(parseCommand('دو عدد به فاکتور اضافه کن')).toBeNull()
    expect(parseCommand('برنج هاشمی')).toBeNull()
    expect(parseCommand('')).toBeNull()
  })

  it('اعداد گفتاری بزرگ‌تر از ده (مثلاً «بیست و سه») را هم تشخیص می‌دهد', () => {
    expect(parseCommand('بیست و سه عدد شیر به فاکتور اضافه کن')).toEqual({
      type: 'addInvoiceItem', productName: 'شیر', quantity: 23,
    })
    expect(parseCommand('صد و پنجاه عدد برنج به فاکتور اضافه کنید')).toEqual({
      type: 'addInvoiceItem', productName: 'برنج', quantity: 150,
    })
    expect(parseCommand('تعداد شیر را به سی تغییر بده')).toEqual({
      type: 'setInvoiceQuantity', productName: 'شیر', quantity: 30,
    })
  })

  it('پیشوندهای پرکنندهٔ ASR مثل «می‌کند»/«لطفاً»/«بزن»/«برام» را نادیده می‌گیرد', () => {
    expect(parseCommand('می کند دو عدد شیر به فاکتور اضافه کن')).toEqual({
      type: 'addInvoiceItem', productName: 'شیر', quantity: 2,
    })
    expect(parseCommand('لطفا سه عدد شیر رو ثبت کن')).toEqual({
      type: 'addInvoiceItem', productName: 'شیر', quantity: 3,
    })
    expect(parseCommand('بزن بیست و سه تا تخم مرغ رو اضافه کن')).toEqual({
      type: 'addInvoiceItem', productName: 'تخم مرغ', quantity: 23,
    })
    expect(parseCommand('همه چیز رو به فاکتور اضافه کن')).toBeNull()
  })

  it('«رو ثبت کن» / «رو اضافه کن» (بدون نام «فاکتور») را دستور افزودن می‌شناسد', () => {
    expect(parseCommand('سه عدد شیر رو اضافه کن')).toEqual({
      type: 'addInvoiceItem', productName: 'شیر', quantity: 3,
    })
    expect(parseCommand('پنج تا ماست رو ثبت کن')).toEqual({
      type: 'addInvoiceItem', productName: 'ماست', quantity: 5,
    })
  })

  it('«حذف کن» و «پاک کن» و «کنسل کن» مترادف‌اند', () => {
    expect(parseCommand('شیر رو حذف کن')).toEqual({ type: 'deleteProduct', productName: 'شیر' })
    expect(parseCommand('ماست رو پاک کنید')).toEqual({ type: 'deleteProduct', productName: 'ماست' })
  })
})
