import { parseSpokenNumber } from '../speech/offline/persianItn'
import { normalizeDigits } from './calculations'

export type ParsedCommand =
  | { type: 'addInvoiceItem'; productName: string; quantity: number }
  | { type: 'setInvoiceQuantity'; productName: string; quantity: number }
  | { type: 'changeProductPrice'; productName: string; percent: number; direction: 'increase' | 'decrease' }
  | { type: 'deleteProduct'; productName: string }

const smallNumberWords: Record<string, number> = {
  صفر: 0,
  یک: 1,
  يک: 1,
  یه: 1,
  یگ: 1,
  دو: 2,
  سه: 3,
  چهار: 4,
  پنج: 5,
  شش: 6,
  هفت: 7,
  هشت: 8,
  نه: 9,
  ده: 10,
  یازده: 11,
  دوازده: 12,
  سیزده: 13,
  چهارده: 14,
  پانزده: 15,
  پونزده: 15,
  شانزده: 16,
  شونزده: 16,
  هفده: 17,
  هیفده: 17,
  هجده: 18,
  هیجده: 18,
  نوزده: 19,
  بیست: 20,
  سی: 30,
  چهل: 40,
  پنجاه: 50,
  شصت: 60,
  هفتاد: 70,
  هشتاد: 80,
  نود: 90,
  صد: 100,
  یکصد: 100,
}

const unitWords = new Set(['عدد', 'دانه', 'بسته', 'کیسه', 'کیلو', 'کیلوگرم', 'لیتر', 'بطری', 'قوطی', 'پاکت', 'تا'])
const unitPrefix = /^(?:عدد|دانه|بسته|کیسه|کیلو|کیلوگرم|لیتر|بطری|قوطی|پاکت|تا)\s+/

function normalizeCommand(value: string): string {
  return normalizeDigits(value)
    .toLocaleLowerCase('fa-IR')
    .replace(/[يى]/g, 'ی')
    .replace(/ك/g, 'ک')
    // Speech engines mix «رو» and «را» as the Persian object marker.
    .replace(/\s+(رو|رو رو)\s+/g, ' را ')
    .replace(/\u064b-\u065f\u0670/g, '')
    .replace(/[\u064b-\u065f\u0670]/g, '')
    .replace(/[\u200c\u200f\u200e]/g, ' ')
    .replace(/[،؛,.!?؟:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Numbers in voice commands come in three forms and `parseSpokenNumber` already handles the
 * "بیست و سه" / "دویست هزار" cases for Shenava, so reuse it instead of only accepting 0-10.
 */
export function parseCommandNumber(value: string): number | null {
  const normalized = normalizeCommand(value)
  if (!normalized) return null
  const word = smallNumberWords[normalized]
  if (word !== undefined) return word
  if (/^\d+(?:\.\d+)?$/.test(normalized)) {
    const parsed = Number(normalized)
    return Number.isFinite(parsed) ? parsed : null
  }
  const run = normalized.split(/\s+/).filter((token) => token.length > 0)
  const spoken = parseSpokenNumber(run)
  return spoken === null ? null : spoken
}

function cleanProductName(value: string): string {
  return value
    .replace(/^(?:محصول|کالا)\s+/, '')
    .replace(/^چیز\s+/, '')
    .replace(/^چیزو\s+/, '')
    .replace(/^مورد\s+/, '')
    .replace(/^چی\s+/, '')
    .replace(/^چیزی\s+/, '')
    .replace(/^را\s+/, '')
    .replace(/\s+رو$/, '')
    .replace(/^چیز(?:و|\s+)?$/, '')
    .replace(/^\s*(?:این|همین)\s+(?:محصول|کالا|چیز)\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function normalizeProductName(value: string): string {
  return normalizeCommand(value).replace(/\s/g, '')
}

/**
 * ASR frequently prefaces a real command with a greeting, a filler verb («می کند») or a request phrase
 * like «بزن یک فاکتور…», «لطفاً…» — strip those so the core command is still found.
 */
const LEADING_FILLERS = [
  /^(?:سلام|درود|صبحتون?\s+بخیر|عصرتون?\s+بخیر|شب\s+بخیر|خواهش\s+می\s*کنم|لطفا?|بفرمایید?|بزن|برام?|برایم?|می\s*کند|می\s*کنه|می\s*خوام|میخوام|بیا|خوب|حالا)\s+/,
  /^(?:یک|یه|یگ)\s+دقیقه\s+/,
  /^(?:می\s*شه|میشه)\s+/,
]

function stripFillers(value: string): string {
  let text = value
  let prev = ''
  // A filler can repeat («بزن لطفاً دو عدد …»); keep stripping until stable.
  for (let i = 0; i < 6 && text !== prev; i += 1) {
    prev = text
    for (const filler of LEADING_FILLERS) {
      text = text.replace(filler, '').trim()
    }
  }
  return text
}

/** Parse a small, explicit set of local Persian invoice/catalog commands. */
export function parseCommand(input: string): ParsedCommand | null {
  const raw = normalizeCommand(input)
  if (!raw) return null

  // Try the raw text first (type-ahead, typed examples), then try after stripping ASR fillers.
  const candidates = [raw, stripFillers(raw)]
  for (const text of candidates) {
    if (!text) continue
    const parsed = tryParseClean(text)
    if (parsed) return parsed
  }
  return null
}

/** Split "<qty>[unit] <name>" — e.g. "دو عدد شیر" → qty=2 name="شیر". */
function splitQuantityAndName(text: string): { quantity: number; name: string } | null {
  const tokens = text.split(/\s+/)
  let i = 0
  // Consume number words (and the connector «و») greedily from the start.
  while (i < tokens.length) {
    const token = tokens[i]!
    if (token === 'و' && i > 0 && i + 1 < tokens.length) {
      const next = tokens[i + 1]!
      if (smallNumberWords[next] !== undefined) { i += 1; continue }
      break
    }
    if (smallNumberWords[token] !== undefined || /^\d+(?:\.\d+)?$/.test(token)) { i += 1; continue }
    break
  }
  if (i > 0) {
    const qtyText = tokens.slice(0, i).filter((t) => t !== 'و').join(' ')
    const quantity = parseCommandNumber(qtyText)
    if (quantity !== null && quantity > 0) {
      let rest = tokens.slice(i).join(' ').trim()
      rest = rest.replace(unitPrefix, '').trim()
      const productName = unitWords.has(rest) ? '' : cleanProductName(rest)
      if (productName) return { quantity, name: productName }
    }
  }
  // Reverse order: "<name> <qty>[unit]" — e.g. "شیر سه عدد" / "شیر 3".
  let j = tokens.length
  while (j > 0) {
    const idx = j - 1
    const token = tokens[idx]!
    if (token === 'و' && idx > 0 && idx + 1 < tokens.length) {
      const prev = tokens[idx - 1]!
      if (smallNumberWords[prev] !== undefined) { j = idx; continue }
      break
    }
    if (smallNumberWords[token] !== undefined || /^\d+(?:\.\d+)?$/.test(token)) { j = idx; continue }
    // Optional trailing unit: "شیر ۳ عدد".
    if (unitWords.has(token) && idx > 0) { j = idx; continue }
    break
  }
  if (j < tokens.length) {
    const qtyTokens = tokens.slice(j).filter((t) => t !== 'و' && !unitWords.has(t))
    const qtyText = qtyTokens.join(' ')
    const quantity = parseCommandNumber(qtyText)
    if (quantity !== null && quantity > 0) {
      const rest = tokens.slice(0, j).join(' ').trim()
      const productName = cleanProductName(rest)
      if (productName) return { quantity, name: productName }
    }
  }
  return null
}

function tryParseClean(text: string): ParsedCommand | null {
  const priceMatch = text.match(/^قیمت\s+(.+?)\s+را\s+(\d+(?:\.\d+)?)\s*درصد\s+(افزایش|زیاد|بالا|کاهش|کم)\s+(?:بده|کن|بزن|بدید|کنید)$/)
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

  // Speech engines vary between «به فاکتور»/«توی فاکتور»/«روی فاکتور»/«ثبت کن»/«بنویس»/«بزن».
  const addMatch = text.match(/^(.+?)\s+(?:به|توی|تو|در|روی)\s+فاکتور(?:م)?\s+(?:اضافه|اضافهه|ثبت|وارد|بذار|بزن|بنویس|بنداز)\s+کن(?:ید)?$/)
  if (addMatch) {
    const split = splitQuantityAndName(addMatch[1]!.replace(/\s+را$/, '').replace(/\s+رو$/, ''))
    if (split) return { type: 'addInvoiceItem', productName: split.name, quantity: split.quantity }
  }

  // Some speakers phrase it as «دو عدد شیر رو اضافه کن» / «دو عدد شیر ثبت کن» without naming the invoice.
  const bareAddMatch = text.match(/^(.+?)\s+(?:رو|را)\s+(?:اضافه|اضافهه|ثبت|وارد|بذار|بزن|بنویس|بنداز)\s+کن(?:ید)?$/)
  if (bareAddMatch) {
    const split = splitQuantityAndName(bareAddMatch[1]!.trim())
    if (split) return { type: 'addInvoiceItem', productName: split.name, quantity: split.quantity }
  }

  // Short imperative: just "<qty>[unit] <name>" / "<name> <qty>[unit]" — e.g. "دو عدد شیر" / "شیر ۳ عدد".
  // Matches the most common iPhone pattern where the user only names the item. Refuse if the text
  // contains keywords that belong to other commands or prepositions from the full-sentence patterns,
  // otherwise we'd misread "دو عدد به فاکتور اضافه کن" as "add «به» ×2".
  const nonBareKeywords = /(?:قیمت|حذف|پاک|کنسل|تعداد|درصد|تغییر|عوض|افزایش|کاهش|ذخیره|اضافه|ثبت|وارد|بذار|بزن|بنویس|بنداز|به|توی|روی|تو|در|رو\b|را\b|کن(?:ید)?|بدید|بده)/
  if (!nonBareKeywords.test(text)) {
    const bareSplit = splitQuantityAndName(text)
    if (bareSplit) {
      return { type: 'addInvoiceItem', productName: bareSplit.name, quantity: bareSplit.quantity }
    }
  }

  const quantityMatch = text.match(/^تعداد\s+(.+?)\s+را\s+به\s+(.+?)\s+(?:تغییر|عوض)\s+(?:بده|بدید|کن|کنید)$/)
  if (quantityMatch) {
    const quantity = parseCommandNumber(quantityMatch[2]!)
    const productName = cleanProductName(quantityMatch[1]!)
    if (quantity !== null && quantity > 0 && productName) {
      return { type: 'setInvoiceQuantity', productName, quantity }
    }
  }

  const deleteMatch = text.match(/^(?:(?:محصول|کالا)\s+)?(.+?)\s+را\s+(?:حذف|پاک|کنسل)\s+کن(?:ید)?$/)
  if (deleteMatch) {
    return { type: 'deleteProduct', productName: cleanProductName(deleteMatch[1]!) }
  }

  return null
}

export const supportedCommandExamples = [
  'قیمت روغن را ۱۰ درصد افزایش بده',
  'سه عدد شیر به فاکتور اضافه کن',
  'تعداد برنج را به دو تغییر بده',
  'محصول روغن را حذف کن',
] as const
