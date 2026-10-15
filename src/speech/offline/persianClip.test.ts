/**
 * The committed Persian clip is the input of the real-model test, so its properties are asserted
 * here — this test runs everywhere (no model files needed) and fails if the fixture is truncated,
 * replaced with silence, or resampled by accident.
 *
 * `persian-command.wav`: 16 kHz · mono · 16-bit PCM, the sentence
 * «یک فاکتور برای آقای رضایی به مبلغ دویست هزار تومان ثبت کن. موجودی انبار را هم نشان بده.»
 */

import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { decodeWavPcm16 } from './__fixtures__/wav'
import { computeLogMel, frameCount } from './features'
import { SHENAVA_SAMPLE_RATE } from './melFilters'

const bytes = new Uint8Array(readFileSync(new URL('./__fixtures__/persian-command.wav', import.meta.url)))

describe('کلیپ فارسی موجود در مخزن', () => {
  const audio = decodeWavPcm16(bytes)

  it('۱۶ کیلوهرتز، تک‌کاناله و حدود ۶ ثانیه است', () => {
    expect(audio.sampleRate).toBe(SHENAVA_SAMPLE_RATE)
    expect(audio.channels).toBe(1)
    const seconds = audio.samples.length / audio.sampleRate
    expect(seconds).toBeGreaterThan(5)
    expect(seconds).toBeLessThan(8)
  })

  it('سکوت نیست (اوج و انرژی واقعی دارد)', () => {
    let peak = 0
    let sumSquares = 0
    for (const sample of audio.samples) {
      peak = Math.max(peak, Math.abs(sample))
      sumSquares += sample * sample
    }
    const rms = Math.sqrt(sumSquares / audio.samples.length)
    expect(peak).toBeGreaterThan(0.05)
    expect(rms).toBeGreaterThan(0.01)
    expect(rms).toBeLessThan(0.9)
  })

  it('با همان کد مرورگر به ویژگی ۸۰ بُعدی تبدیل می‌شود', () => {
    const { features, frames, dim } = computeLogMel(audio.samples)
    expect(dim).toBe(80)
    expect(frames).toBe(frameCount(audio.samples.length))
    expect(frames).toBeGreaterThan(600)
    expect(features).toHaveLength(frames * dim)
    expect(features.every((value) => Number.isFinite(value))).toBe(true)
  })
})
