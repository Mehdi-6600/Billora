import { describe, expect, it } from 'vitest'
import {
  SHENAVA_LOG_ZERO_GUARD,
  applyPreemphasis,
  computeLogMel,
  frameCount,
  hannWindowPeriodicFalse,
  paddedWindow,
  padSignal,
} from './features'

const SILENCE_LOG_VALUE = Math.log(SHENAVA_LOG_ZERO_GUARD)

describe('استخراج ویژگی log-mel سازگار با NeMo', () => {
  it('طول خروجی مطابق torch.stft با center=True است', () => {
    expect(frameCount(16_000)).toBe(101)
    expect(frameCount(0)).toBe(0)
    const { features, frames, dim } = computeLogMel(new Float32Array(16_000))
    expect(frames).toBe(101)
    expect(dim).toBe(80)
    expect(features).toHaveLength(101 * 80)
  })

  it('سکوت کامل به مقدار ثابت log(2^-24) می‌رسد (بدون نرمال‌سازی per-feature)', () => {
    const { features } = computeLogMel(new Float32Array(8_000))
    for (const value of features) expect(Math.abs(value - SILENCE_LOG_VALUE)).toBeLessThan(1e-6)
  })

  it('صوت بلندتر (انرژی بیشتر) مقدار log-mel بزرگ‌تری تولید می‌کند', () => {
    const quiet = new Float32Array(4_000)
    const loud = new Float32Array(4_000)
    for (let i = 0; i < quiet.length; i += 1) {
      quiet[i] = 0.02 * Math.sin((2 * Math.PI * 440 * i) / 16_000)
      loud[i] = 0.2 * Math.sin((2 * Math.PI * 440 * i) / 16_000)
    }
    const quietMel = computeLogMel(quiet).features
    const loudMel = computeLogMel(loud).features
    const mean = (values: Float32Array) => values.reduce((total, value) => total + value, 0) / values.length
    expect(mean(loudMel)).toBeGreaterThan(mean(quietMel))
    // Bins with energy must be louder; silent bins only see the log zero guard.
    let louderCount = 0
    for (let i = 0; i < quietMel.length; i += 1) if (loudMel[i]! > quietMel[i]!) louderCount += 1
    expect(louderCount / quietMel.length).toBeGreaterThan(0.7)
  })

  it('محاسبه قطعی است و در فراخوانی دوم نتیجهٔ یکسانی می‌دهد', () => {
    const pcm = new Float32Array(3_200)
    for (let i = 0; i < pcm.length; i += 1) pcm[i] = Math.sin(i / 7)
    const first = computeLogMel(pcm).features
    const second = computeLogMel(pcm).features
    expect(Array.from(second)).toEqual(Array.from(first))
  })

  it('پیش‌تأکید، پنجرهٔ periodic=False و padding را مثل NeMo می‌سازد', () => {
    const emphasized = applyPreemphasis(Float32Array.from([1, 1, 1, 1]), 0.97)
    expect(emphasized[0]).toBe(1)
    expect(emphasized[1]).toBeCloseTo(0.03, 6)
    expect(emphasized[3]).toBeCloseTo(0.03, 6)

    // torch.hann_window(400, periodic=False): zero at both ends, one in the middle.
    const window = hannWindowPeriodicFalse(400)
    expect(window[0]).toBeCloseTo(0, 10)
    expect(window[199]).toBeCloseTo(1, 4)
    expect(window[399]).toBeCloseTo(0, 10)
    const padded = paddedWindow(400, 512)
    expect(padded[0]).toBe(0)
    expect(padded[55]).toBe(0)
    expect(padded[56]).toBeCloseTo(0, 10)
    expect(padded[56 + 199]).toBeCloseTo(1, 4)
    expect(padded[511]).toBe(0)

    const signal = Float32Array.from([1, 2, 3, 4, 5, 6, 7, 8])
    const reflected = padSignal(signal, 2, 'reflect')
    expect(reflected[0]).toBe(3)
    expect(reflected[1]).toBe(2)
    expect(reflected[2]).toBe(1)
    expect(reflected[10]).toBe(7)
    expect(reflected[11]).toBe(6)
    const zeros = padSignal(signal, 2, 'constant')
    expect(zeros[0]).toBe(0)
    expect(zeros[1]).toBe(0)
    expect(zeros[2]).toBe(1)
  })

  it('حالت reflect فقط فریم‌های لبه را تغییر می‌دهد', () => {
    const pcm = new Float32Array(16_000)
    for (let i = 0; i < pcm.length; i += 1) pcm[i] = Math.sin(i / 11)
    const constant = computeLogMel(pcm, { padMode: 'constant' }).features
    const reflect = computeLogMel(pcm, { padMode: 'reflect' }).features
    // Frame 20 of 101 covers samples 3200–3712, far from both edges, so padding must not matter.
    const offset = 20 * 80
    for (let i = 0; i < 80; i += 1) expect(reflect[offset + i]).toBeCloseTo(constant[offset + i]!, 5)
  })
})
