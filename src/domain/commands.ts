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

// ---------------------------------------------------------------------------
// Spoken item lists — «دو تا لنت ترمز پراید، چهار تا لاستیک دنا سمند، یک جفت چراغ …»
//
// The single-command parser above cannot describe a shopping sentence with several
// items, prices per item, or the pair unit «جفت». These helpers parse exactly that
// shape: items separated by «،» / «و» / «، و», each with a quantity (words, Persian
// digits or Arabic digits), an optional unit («تا»، «عدد»، «جفت» = 2، …) and an
// optional spoken price. Anything unclear becomes a `review` entry that the UI must
// show to the user instead of guessing and registering it.
// ---------------------------------------------------------------------------

export type SpokenItemEntry =
  | {
      status: 'ok'
      raw: string
      productName: string
      quantity: number
      /** Real unit word («کیسه»، «بسته»، …) or `null` for counters like «تا» / «جفت». */
      unit: string | null
      /** Unit price in toman when the user said it; `null` means "use the catalog price". */
      unitPrice: number | null
    }
  | { status: 'review'; raw: string; reason: string }

export interface SpokenItemList {
  items: SpokenItemEntry[]
}

/** «جفت» multiplies the count: «یک جفت چراغ» = 2 چراغ. */
const UNIT_MULTIPLIERS: Record<string, number> = { جفت: 2 }
const SPOKEN_SCALES = new Set(['هزار', 'میلیون', 'میلیارد'])
const PRICE_MARKERS = new Set(['قیمت', 'قیمتش', 'قیمته', 'قیمتی', 'عددی'])
const CURRENCY_WORDS = new Set(['تومان', 'تومن'])

const REVIEW_NO_QUANTITY = 'تعداد این قلم معلوم نیست؛ تعداد را در متن بگویید (مثلاً «دو تا …»).'
const REVIEW_NO_NAME = 'نام کالا در این قلم معلوم نیست.'
const REVIEW_BAD_PRICE = 'قیمت گفته‌شده برای این قلم نامعتبر است. قیمت را عددی بنویسید (مثلاً «به قیمت ۲۵۰۰۰۰»).'

function isNumberToken(token: string): boolean {
  if (smallNumberWords[token] !== undefined || SPOKEN_SCALES.has(token)) return true
  if (/^\d+(?:\.\d+)?$/.test(token)) return true
  // Hundreds («دویست»، «پانصد»، …) and their colloquial variants live in the spoken-number
  // tables, not in `smallNumberWords`; ask the shared parser so runs stay unbroken.
  return parseSpokenNumber([token]) !== null
}

function isUnitToken(token: string): boolean {
  return unitWords.has(token) || token in UNIT_MULTIPLIERS
}

/** Like `normalizeCommand`, but keeps «،» / commas so items stay separable. */
function normalizeListText(value: string): string {
  return normalizeDigits(value)
    .toLocaleLowerCase('fa-IR')
    .replace(/[يى]/g, 'ی')
    .replace(/ك/g, 'ک')
    .replace(/[\u064b-\u065f\u0670]/g, '')
    .replace(/[\u200c\u200f\u200e]/g, ' ')
    // Thousands separators between digits are not item separators: «۲۵۰٬۰۰۰» → «۲۵۰۰۰۰».
    .replace(/(?<=\d)[,،٬](?=\d)/g, '')
    .replace(/[؛;.!?؟:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const LIST_TRAILING_IMPERATIVES = [
  /\s+(?:را|رو)?\s*(?:به|توی|تو|در|روی)\s+فاکتور(?:م)?\s+(?:اضافه|اضافهه|ثبت|وارد|بذار|بزن|بنویس|بنداز|افزودن)\s*(?:کن(?:ید|ین|یم)?|بده(?:ید)?|بذار(?:ید)?)?$/,
  /\s+(?:را|رو)\s+(?:به|توی|تو|در|روی)?\s*فاکتور(?:م)?\s*(?:اضافه|اضافهه|ثبت|وارد|بذار|بزن|بنویس|بنداز|افزودن)?\s*(?:کن(?:ید|ین|یم)?|بده(?:ید)?)?$/,
  /\s+(?:را|رو)?\s*(?:اضافه|اضافهه|ثبت|وارد|بذار|بزن|بنویس|بنداز|افزودن)\s+(?:کن(?:ید|ین|یم)?|بده(?:ید)?|بذار(?:ید)?)$/,
  /\s+(?:را|رو)\s+(?:ثبت|بزن|اضافه)$/,
  /\s+(?:ثبت|بزن)$/,
]

function stripListImperatives(value: string): string {
  let text = value
  let prev = ''
  for (let i = 0; i < 3 && text !== prev; i += 1) {
    prev = text
    for (const pattern of LIST_TRAILING_IMPERATIVES) {
      text = text.replace(pattern, '').trim()
    }
  }
  return text
}

/** Split on «،» (and ASCII commas). A following «و» (the «، و» form) is dropped too. */
function splitListSegments(text: string): string[] {
  return text
    .split(/[،,]/)
    .map((segment) => segment.replace(/^و\s+/, '').replace(/\s+و$/, '').trim())
    .filter((segment) => segment.length > 0)
}

interface SegmentParse {
  entry: SpokenItemEntry
  /** Quantity structure or an explicit price phrase was seen — this is really an item, not chat. */
  signal: boolean
  hasQuantity: boolean
}

interface PriceExtraction {
  price: number | null
  error: string | null
  restTokens: string[]
  /** An explicit price phrase («قیمت»/«هر کدام»/«تومان») was present. */
  markerFound: boolean
}

function parsePriceValue(text: string): number | null {
  const cleaned = normalizeDigits(text).replace(/[،,٬]/g, '').replace(/\s+/g, ' ').trim()
  if (!cleaned) return null
  const value = parseCommandNumber(cleaned)
  return value !== null && Number.isSafeInteger(value) && value > 0 ? value : null
}

function extractPrice(tokens: string[]): PriceExtraction {
  const work = [...tokens]
  let sawCurrency = false
  while (work.length > 0 && CURRENCY_WORDS.has(work[work.length - 1]!)) {
    work.pop()
    sawCurrency = true
  }

  // Explicit markers: «قیمت …» / «عددی …» / «هر کدام …». Scan from the end so the last
  // price phrase wins («به قیمت …» after a name).
  let markerIndex = -1
  let afterMarker = -1
  for (let i = work.length - 1; i >= 0; i -= 1) {
    const token = work[i]!
    if (PRICE_MARKERS.has(token)) {
      markerIndex = i
      afterMarker = i + 1
      if (work[afterMarker] === 'هر' && (work[afterMarker + 1] === 'کدام' || work[afterMarker + 1] === 'عدد' || work[afterMarker + 1] === 'دانه')) {
        afterMarker += 2
      } else if (work[afterMarker] === 'هرکدام') {
        afterMarker += 1
      }
      break
    }
    if (token === 'هرکدام' || (token === 'هر' && work[i + 1] === 'کدام')) {
      markerIndex = i
      afterMarker = token === 'هر' ? i + 2 : i + 1
      break
    }
  }

  if (markerIndex >= 0) {
    const priceTokens = work.slice(afterMarker)
    const restTokens = work.slice(0, markerIndex)
    while (restTokens.length > 0 && (restTokens[restTokens.length - 1] === 'به' || restTokens[restTokens.length - 1] === 'با')) {
      restTokens.pop()
    }
    const price = parsePriceValue(priceTokens.join(' '))
    if (price === null) return { price: null, error: REVIEW_BAD_PRICE, restTokens: work, markerFound: true }
    return { price, error: null, restTokens, markerFound: true }
  }

  if (sawCurrency) {
    // «… صد و بیست هزار تومان» — take the longest trailing run of number words/digits.
    let start = work.length
    while (start > 0 && isNumberToken(work[start - 1]!)) start -= 1
    const priceTokens = work.slice(start)
    // A «و» between two number words is part of the number run («صد و بیست»).
    while (start > 0 && work[start - 1] === 'و' && start >= 2 && isNumberToken(work[start - 2]!)) {
      start -= 1
      priceTokens.unshift('و')
    }
    const price = parsePriceValue(priceTokens.join(' '))
    if (price === null) return { price: null, error: REVIEW_BAD_PRICE, restTokens: work, markerFound: true }
    return { price, error: null, restTokens: work.slice(0, start), markerFound: true }
  }

  return { price: null, error: null, restTokens: work, markerFound: false }
}

interface QuantityLead {
  quantity: number
  unit: string | null
  nameTokens: string[]
}

function quantityFromStart(tokens: string[]): QuantityLead | null {
  if (tokens.length === 0) return null
  if (tokens[0] === 'جفت') return { quantity: 2, unit: null, nameTokens: tokens.slice(1) }

  let index = 0
  const run: string[] = []
  while (index < tokens.length) {
    const token = tokens[index]!
    if (token === 'و' && run.length > 0 && index + 1 < tokens.length && isNumberToken(tokens[index + 1]!)) {
      run.push(token)
      index += 1
      continue
    }
    if (isNumberToken(token)) {
      run.push(token)
      index += 1
      continue
    }
    break
  }
  if (run.length === 0) return null
  const parsed = parseCommandNumber(run.join(' '))
  if (parsed === null || parsed <= 0) return null

  let quantity = parsed
  let unit: string | null = null
  if (index < tokens.length && isUnitToken(tokens[index]!)) {
    const marker = tokens[index]!
    index += 1
    const multiplier = UNIT_MULTIPLIERS[marker]
    if (multiplier) quantity *= multiplier
    else if (marker !== 'تا') unit = marker
  }
  return { quantity, unit, nameTokens: tokens.slice(index) }
}

/**
 * Reverse order («شیر سه عدد»). A trailing count is only accepted next to a unit word,
 * so product names that end in digits («چراغ خطر پژو ۴۰۵») are never eaten as a quantity.
 */
function quantityFromEnd(tokens: string[]): QuantityLead | null {
  if (tokens.length < 2) return null
  const last = tokens[tokens.length - 1]!
  if (!isUnitToken(last)) return null

  let index = tokens.length - 2
  const run: string[] = []
  while (index >= 0) {
    const token = tokens[index]!
    if (token === 'و' && run.length > 0 && index - 1 >= 0 && isNumberToken(tokens[index - 1]!)) {
      run.unshift(token)
      index -= 1
      continue
    }
    if (isNumberToken(token)) {
      run.unshift(token)
      index -= 1
      continue
    }
    break
  }
  if (run.length === 0) return null
  const parsed = parseCommandNumber(run.join(' '))
  if (parsed === null || parsed <= 0) return null

  const multiplier = UNIT_MULTIPLIERS[last]
  return {
    quantity: multiplier ? parsed * multiplier : parsed,
    unit: multiplier || last === 'تا' ? null : last,
    nameTokens: tokens.slice(0, index + 1),
  }
}

function cleanItemName(tokens: string[]): string {
  let name = tokens.join(' ').trim()
  name = name.replace(/\s+(?:به|با)$/, '')
  name = name.replace(/\s+را$/, '')
  return cleanProductName(name)
}

function parseItemSegment(segment: string): SegmentParse {
  const raw = segment.trim()
  const tokens = raw.split(/\s+/).filter(Boolean)
  const price = extractPrice(tokens)
  if (price.error) {
    return { entry: { status: 'review', raw, reason: price.error }, signal: true, hasQuantity: false }
  }

  const lead = quantityFromStart(price.restTokens) ?? quantityFromEnd(price.restTokens)
  const signal = Boolean(lead) || price.markerFound
  if (!lead) {
    return { entry: { status: 'review', raw, reason: REVIEW_NO_QUANTITY }, signal, hasQuantity: false }
  }
  const productName = cleanItemName(lead.nameTokens)
  if (!productName) {
    return { entry: { status: 'review', raw, reason: REVIEW_NO_NAME }, signal, hasQuantity: true }
  }
  return {
    entry: {
      status: 'ok',
      raw,
      productName,
      quantity: lead.quantity,
      unit: lead.unit,
      unitPrice: price.price,
    },
    signal,
    hasQuantity: true,
  }
}

/**
 * Split one comma-segment on bare «و» between items («دو تا لنت و چهار تا لاستیک»).
 * A «و» between two number words belongs to the number («بیست و سه»)، and the split is
 * only accepted when every part can stand alone as an item; otherwise «و» stays inside
 * the product name («دو تا روغن و فیلتر»). This keeps prices like «صد و بیست هزار» whole.
 */
function splitOnConnectors(segment: string): string[] {
  const tokens = segment.split(/\s+/).filter(Boolean)
  const cutPoints: number[] = []
  for (let i = 1; i < tokens.length - 1; i += 1) {
    if (tokens[i] !== 'و') continue
    const prev = tokens[i - 1]!
    const next = tokens[i + 1]!
    if (isNumberToken(prev) && isNumberToken(next)) continue
    cutPoints.push(i)
  }
  if (cutPoints.length === 0) return [segment]

  const parts: string[] = []
  let start = 0
  for (const point of cutPoints) {
    parts.push(tokens.slice(start, point).join(' '))
    start = point + 1
  }
  parts.push(tokens.slice(start).join(' '))

  const everyPartStandsAlone = parts.every((part) => parseItemSegment(part).hasQuantity)
  return everyPartStandsAlone ? parts.filter((part) => part.length > 0) : [segment]
}

/**
 * Parse a spoken shopping sentence into invoice items.
 * Returns `null` when the text does not look like an item list at all (so the caller can
 * fall back to the single-command parser / “unknown command” message).
 */
export function parseSpokenItems(input: string): SpokenItemList | null {
  const normalized = normalizeListText(input)
  if (!normalized) return null
  const cleaned = stripListImperatives(stripFillers(normalized))
  if (!cleaned) return null

  const segments = splitListSegments(cleaned)
  if (segments.length === 0) return null

  const parses: SegmentParse[] = []
  for (const segment of segments) {
    for (const part of splitOnConnectors(segment)) {
      parses.push(parseItemSegment(part))
    }
  }

  if (!parses.some((parse) => parse.signal)) return null
  return { items: parses.map((parse) => parse.entry) }
}

/**
 * Combined parse used to guard Persian ITN: a transcript may be a single command or an
 * item list. Semantic fields only — raw segment text must not affect the comparison.
 * For add-item text the item-list parse wins, because the single-command parser folds
 * commas away and can misread a multi-item sentence as one item.
 */
export function parseSpeechText(value: string): unknown {
  const command = parseCommand(value)
  if (command && command.type !== 'addInvoiceItem') return command
  const list = parseSpokenItems(value)
  if (list) {
    return {
      items: list.items.map((entry) => (entry.status === 'ok'
        ? { status: 'ok', productName: entry.productName, quantity: entry.quantity, unit: entry.unit, unitPrice: entry.unitPrice }
        : { status: 'review', reason: entry.reason })),
    }
  }
  return command
}
