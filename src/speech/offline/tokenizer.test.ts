import { describe, expect, it } from 'vitest'
import { decodeTokens, parseTokens } from './tokenizer'

const TOKENS = [
  '▁سلام 0',
  '▁حال 1',
  '▁شما 2',
  '▁خوب 3',
  'ه 4',
  '<blk> 5',
  '',
].join('\n')

describe('خواندن tokens.txt و بازسازی متن', () => {
  it('شناسه‌ها، توکن خالی و <blk> را درست می‌خواند', () => {
    const table = parseTokens(TOKENS)
    expect(table.size).toBe(6)
    expect(table.pieces[0]).toBe('▁سلام')
    expect(table.pieces[5]).toBe('<blk>')
    expect(table.blankId).toBe(5)
    expect(table.hasBlankToken).toBe(true)
  })

  it('حرف اضافهٔ محل واژه (▁) را به فاصله تبدیل می‌کند', () => {
    const table = parseTokens(TOKENS)
    expect(decodeTokens([0, 1, 2, 3], table)).toBe('سلام حال شما خوب')
    expect(decodeTokens([0, 4, 1], table)).toBe('سلامه حال')
  })

  it('توکن‌های کنترلی مثل <blk> در متن ظاهر نمی‌شوند', () => {
    const table = parseTokens(TOKENS)
    expect(decodeTokens([0, 5, 1, 5], table)).toBe('سلام حال')
    expect(decodeTokens([], table)).toBe('')
  })

  it('خط‌های نامعتبر نادیده گرفته می‌شوند', () => {
    const table = parseTokens('▁الف 0\nخط بدون شناسه\n▁ب x\n▁ج 2')
    expect(table.pieces[0]).toBe('▁الف')
    expect(table.pieces[2]).toBe('▁ج')
    expect(table.size).toBe(3)
    expect(table.hasBlankToken).toBe(false)
  })
})
