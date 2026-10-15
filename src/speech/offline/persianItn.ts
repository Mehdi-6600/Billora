/**
 * Minimal Persian inverse text normalization (spoken numbers → digits).
 *
 * The Shenava RNNT head is trained on audio-faithful labels and therefore emits numbers in spoken
 * form («سه»، not «۳») — see the model card. Billora always shows the recognized text in the
 * ordinary command input, so a conservative ITN step keeps the transcript readable.
 *
 * Nothing here changes command semantics: `itnForCommand` only rewrites the text when the existing
 * Persian command parser produces the *identical* command for the rewritten text.
 */

const UNIT_VALUES: Record<string, number> = {
  صفر: 0,
  یک: 1,
  يک: 1,
  یه: 1,
  یکدانه: 1,
  دو: 2,
  سه: 3,
  چهار: 4,
  پنج: 5,
  شش: 6,
  هفت: 7,
  هشت: 8,
  نه: 9,
}

const TEEN_VALUES: Record<string, number> = {
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
}

const TENS_VALUES: Record<string, number> = {
  بیست: 20,
  سی: 30,
  چهل: 40,
  پنجاه: 50,
  شصت: 60,
  هفتاد: 70,
  هشتاد: 80,
  نود: 90,
}

const HUNDREDS_VALUES: Record<string, number> = {
  صد: 100,
  یکصد: 100,
  دویست: 200,
  سیصد: 300,
  چهارصد: 400,
  پانصد: 500,
  پونصد: 500,
  ششصد: 600,
  شصد: 600,
  هفتصد: 700,
  هشتصد: 800,
  نهصد: 900,
}

const SCALE_VALUES: Record<string, number> = {
  هزار: 1_000,
  میلیون: 1_000_000,
  میلیارد: 1_000_000_000,
}

const FA_DIGITS = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'] as const

export function toPersianDigits(value: number): string {
  return String(value).replace(/\d/g, (digit) => FA_DIGITS[Number(digit)]!)
}

function isNumberWord(word: string): boolean {
  return word in UNIT_VALUES || word in TEEN_VALUES || word in TENS_VALUES || word in HUNDREDS_VALUES || word in SCALE_VALUES
}

function wordValue(word: string): number | null {
  if (word in UNIT_VALUES) return UNIT_VALUES[word]!
  if (word in TEEN_VALUES) return TEEN_VALUES[word]!
  if (word in TENS_VALUES) return TENS_VALUES[word]!
  if (word in HUNDREDS_VALUES) return HUNDREDS_VALUES[word]!
  return null
}

/** Parses a maximal run of number words such as «بیست و سه» into 23. Returns null when unparsable. */
export function parseSpokenNumber(words: readonly string[]): number | null {
  let total = 0
  let current = 0
  let seen = false

  for (const word of words) {
    if (word === 'و') continue
    if (word in SCALE_VALUES) {
      const scale = SCALE_VALUES[word]!
      total += (current || 1) * scale
      current = 0
      seen = true
      continue
    }
    const value = wordValue(word)
    if (value === null) return null
    seen = true
    if (value >= 100) current += value
    else if (current >= 100) current += value
    else current = current === 0 ? value : current + value
  }

  if (!seen) return null
  const result = total + current
  return Number.isFinite(result) ? result : null
}

/**
 * Rewrites spoken Persian numbers inside `text` as Persian digits.
 * Non-number text is preserved verbatim, including spacing.
 */
export function applyPersianItn(text: string): string {
  const tokens = text.split(/(\s+)/)
  const out: string[] = []
  let index = 0

  while (index < tokens.length) {
    const token = tokens[index]!
    if (!isNumberWord(token)) {
      out.push(token)
      index += 1
      continue
    }

    const run: string[] = []
    let cursor = index
    while (cursor < tokens.length) {
      const candidate = tokens[cursor]!
      if (isNumberWord(candidate)) {
        run.push(candidate)
        cursor += 1
        continue
      }
      // A single «و» is only part of the number when another number word follows it.
      if (candidate === 'و' && cursor + 1 < tokens.length && isNumberWord(tokens[cursor + 1]!)) {
        run.push(candidate)
        cursor += 1
        continue
      }
      if (/^\s+$/.test(candidate) && cursor + 1 < tokens.length && (isNumberWord(tokens[cursor + 1]!) || tokens[cursor + 1] === 'و')) {
        run.push(candidate)
        cursor += 1
        continue
      }
      break
    }

    const words = run.filter((entry) => !/^\s+$/.test(entry))
    const value = parseSpokenNumber(words)
    if (value === null) {
      out.push(token)
      index += 1
      continue
    }
    out.push(` ${toPersianDigits(value)} `)
    index = cursor
  }

  return out.join('').replace(/[ \t]{2,}/g, ' ').replace(/ +([،؛,.!?؟:])/g, '$1').trim()
}

/**
 * ITN guarded by the existing command parser: the rewritten text is only used when Billora's own
 * parser turns both versions into exactly the same command. Otherwise the raw transcript is kept,
 * so offline speech can never change how a Persian command is understood.
 */
export function itnForCommand(
  text: string,
  parse: (value: string) => unknown,
): string {
  const rewritten = applyPersianItn(text)
  if (rewritten === text) return text
  const original = parse(text)
  const converted = parse(rewritten)
  if (converted === null || converted === undefined) return text
  if (original !== null && original !== undefined && JSON.stringify(original) !== JSON.stringify(converted)) return text
  return rewritten
}
