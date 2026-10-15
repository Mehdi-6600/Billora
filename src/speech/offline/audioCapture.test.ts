import { describe, expect, it } from 'vitest'
import { concatFloat32, resampleLinear } from './audioCapture'

describe('تبدیل نرخ نمونه‌برداری و ادغام قطعه‌های صوتی', () => {
  it('نرخ یکسان را بدون کپی برمی‌گرداند', () => {
    const input = Float32Array.from([0, 1, 2, 3])
    expect(resampleLinear(input, 16_000, 16_000)).toBe(input)
  })

  it('۴۸ کیلوهرتز را به ۱۶ کیلوهرتز با طول درست کاهش می‌دهد', () => {
    const input = new Float32Array(48_000)
    for (let i = 0; i < input.length; i += 1) input[i] = i / 48_000
    const output = resampleLinear(input, 48_000, 16_000)
    expect(output).toHaveLength(16_000)
    expect(output[0]).toBeCloseTo(0, 6)
    // The last output sample maps to input index 47997.
    expect(output[15_999]).toBeCloseTo(47_997 / 48_000, 4)
    expect(output[1_600]).toBeCloseTo(4_800 / 48_000, 5)
  })

  it('ورودی خالی را بدون خطا مدیریت می‌کند', () => {
    expect(resampleLinear(new Float32Array(0), 44_100, 16_000)).toHaveLength(0)
  })

  it('قطعه‌ها را به هم می‌چسباند و طول را دقیق رعایت می‌کند', () => {
    const first = Float32Array.from([1, 2, 3])
    const second = Float32Array.from([4, 5])
    expect(Array.from(concatFloat32([first, second], 5))).toEqual([1, 2, 3, 4, 5])
    expect(Array.from(concatFloat32([first, second], 4))).toEqual([1, 2, 3, 4])
    expect(Array.from(concatFloat32([first], 2))).toEqual([1, 2])
    expect(concatFloat32([], 0)).toHaveLength(0)
  })
})
