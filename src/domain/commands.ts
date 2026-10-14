import { normalizeDigits } from './calculations'

export type ParsedCommand =
  | { type: 'addInvoiceItem'; productName: string; quantity: number }
  | { type: 'setInvoiceQuantity'; productName: string; quantity: number }
  | { type: 'changeProductPrice'; productName: string; percent: number; direction: 'increase' | 'decrease' }
  | { type: 'deleteProduct'; productName: string }

const numberWords: Record<string, number> = {
  صفر: 0,
  یک: 1,
  يک: 1,
  یه: 1,
  دو: 2,
  سه: 3,
  چهار: 4,
  پنج: 5,
  شش: 6,
  هفت: 7,
  هشت: 8,
  نه: 9,
  ده: 10,
}

function normalizeCommand(value: string): string {
  return normalizeDigits(value)
    .toLocaleLowerCase('fa-IR')
    .replace(/[يى]/g, 'ی')
    .replace(/ك/g, 'ک')
    .replace(/[\u064b-\u065f\u0670]/g, '')
    .replace(/[\u200c\u200f\u200e]/g, ' ')
    .replace(/[،؛,.!?؟:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function parseCommandNumber(value: string): number | null {
  const normalized = normalizeCommand(value)
  const word = numberWords[normalized]
  if (word !== undefined) return word
  if (!/^\d+(?:\.\d+)?$/.test(normalized)) return null
  const parsed = Number(normalized)
  return Number.isFinite(parsed) ? parsed : null
}

function cleanProductName(value: string): string {
  return value
    .replace(/^(?:محصول|کالا)\s+/, '')
    .replace(/^\s*(?:این|همین)\s+(?:محصول|کالا)\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function normalizeProductName(value: string): string {
  return normalizeCommand(value).replace(/\s/g, '')
}

/** Parse a small, explicit set of local Persian invoice/catalog commands. */
export function parseCommand(input: string): ParsedCommand | null {
  const text = normalizeCommand(input)
  if (!text) return null

  const priceMatch = text.match(/^قیمت\s+(.+?)\s+را\s+(\d+(?:\.\d+)?)\s*درصد\s+(افزایش|زیاد|بالا|کاهش|کم)\s+(?:بده|کن)$/)
  if (priceMatch) {
    const percent = Number(priceMatch[2])
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) return null
    return {
      type: 'changeProductPrice',
      productName: cleanProductName(priceMatch[1]),
      percent,
      direction: ['کاهش', 'کم'].includes(priceMatch[3]) ? 'decrease' : 'increase',
    }
  }

  const addMatch = text.match(/^([^\s]+)\s+(.+?)\s+به\s+فاکتور\s+اضافه\s+کن$/)
  if (addMatch) {
    const quantity = parseCommandNumber(addMatch[1])
    const productName = cleanProductName(addMatch[2].replace(/^(?:عدد|دانه|بسته|کیسه|کیلو|کیلوگرم|لیتر)\s+/, ''))
    if (quantity !== null && quantity > 0 && productName) {
      return { type: 'addInvoiceItem', productName, quantity }
    }
  }

  const quantityMatch = text.match(/^تعداد\s+(.+?)\s+را\s+به\s+(.+?)\s+تغییر\s+بده$/)
  if (quantityMatch) {
    const quantity = parseCommandNumber(quantityMatch[2])
    const productName = cleanProductName(quantityMatch[1])
    if (quantity !== null && quantity > 0 && productName) {
      return { type: 'setInvoiceQuantity', productName, quantity }
    }
  }

  const deleteMatch = text.match(/^(?:(?:محصول|کالا)\s+)?(.+?)\s+را\s+حذف\s+کن$/)
  if (deleteMatch) {
    return { type: 'deleteProduct', productName: cleanProductName(deleteMatch[1]) }
  }

  return null
}

export const supportedCommandExamples = [
  'قیمت روغن را ۱۰ درصد افزایش بده',
  'سه عدد شیر به فاکتور اضافه کن',
  'تعداد برنج را به دو تغییر بده',
  'محصول روغن را حذف کن',
] as const
