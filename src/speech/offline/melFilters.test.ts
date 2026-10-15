import { describe, expect, it } from 'vitest'
import { MEL_REFERENCE_ROWS, MEL_REFERENCE_TOTAL } from './__fixtures__/melReference'
import { hzToMelSlaney, melFilterBank, melToHzSlaney, shenavaMelFilterBank } from './melFilters'

describe('فیلتربانک مل شنوا (کاملاً منطبق با librosa/NeMo)', () => {
  it('۹۶٪ مقادیر نمونهٔ مرجع librosa را با دقت float32 بازتولید می‌کند', () => {
    const filters = shenavaMelFilterBank()
    for (const { row, values } of MEL_REFERENCE_ROWS) {
      for (let k = 0; k < values.length; k += 1) {
        expect(Math.abs(filters[row]![k]! - values[k]!)).toBeLessThan(1e-6)
      }
    }
  })

  it('جمع کل وزن‌های ماتریس ۸۰×۲۵۷ با مرجع یکی است', () => {
    const filters = shenavaMelFilterBank()
    let total = 0
    for (const row of filters) for (const value of row) total += value
    expect(Math.abs(total - MEL_REFERENCE_TOTAL)).toBeLessThan(1e-3)
  })

  it('شکل ماتریس ۸۰ ردیف در ۲۵۷ ستون است و هر ردیف وزن مثبت دارد', () => {
    const filters = shenavaMelFilterBank()
    expect(filters).toHaveLength(80)
    for (const row of filters) {
      expect(row).toHaveLength(257)
      expect(row.some((value) => value > 0)).toBe(true)
    }
  })

  it('مقیاس مِل اسلَنی در ۱۰۰۰ هرتز به ۱۵ مِل می‌رسد و برگشت‌پذیر است', () => {
    expect(hzToMelSlaney(1000)).toBeCloseTo(15, 10)
    expect(melToHzSlaney(15)).toBeCloseTo(1000, 8)
    expect(melToHzSlaney(hzToMelSlaney(3000))).toBeCloseTo(3000, 6)
  })

  it('ورودی نامعتبر را رد می‌کند', () => {
    expect(() => melFilterBank({ sampleRate: 16000, nFft: 513, nMels: 80, fmin: 0, fmax: 8000 })).toThrow()
    expect(() => melFilterBank({ sampleRate: 16000, nFft: 512, nMels: 0, fmin: 0, fmax: 8000 })).toThrow()
    expect(() => melFilterBank({ sampleRate: 16000, nFft: 512, nMels: 80, fmin: 8000, fmax: 0 })).toThrow()
  })
})
