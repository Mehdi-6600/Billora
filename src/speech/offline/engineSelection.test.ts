import { describe, expect, it } from 'vitest'
import { detectIosLike, resolveActiveEngine, shouldUseOfflineEngine, type SpeechEnvironment } from './engineSelection'

const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'
const IPAD_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15'
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36'

function environment(overrides: Partial<SpeechEnvironment> = {}): SpeechEnvironment {
  return {
    userAgent: ANDROID_UA,
    platform: 'Linux armv8l',
    maxTouchPoints: 5,
    webSpeechAvailable: true,
    webSpeechServiceUnavailable: false,
    offlineAvailable: true,
    preference: 'auto',
    ...overrides,
  }
}

describe('انتخاب موتور گفتار', () => {
  it('آیفون و آیپد را می‌شناسد (آیپد خودش را Mac معرفی می‌کند)', () => {
    expect(detectIosLike({ userAgent: IPHONE_UA, platform: 'iPhone', maxTouchPoints: 5 })).toBe(true)
    expect(detectIosLike({ userAgent: IPAD_UA, platform: 'MacIntel', maxTouchPoints: 5 })).toBe(true)
    expect(detectIosLike({ userAgent: ANDROID_UA, platform: 'Linux armv8l', maxTouchPoints: 5 })).toBe(false)
    expect(detectIosLike({ userAgent: IPAD_UA, platform: 'MacIntel', maxTouchPoints: 0 })).toBe(false)
  })

  it('روی iOS موتور آفلاین را ترجیح می‌دهد چون Web Speech فارسی ندارد', () => {
    expect(resolveActiveEngine(environment({ userAgent: IPHONE_UA, platform: 'iPhone' }))).toBe('offline')
  })

  it('روی اندروید کروم، Web Speech را نگه می‌دارد', () => {
    expect(resolveActiveEngine(environment())).toBe('browser')
  })

  it('اگر سرویس گفتار فارسی در دسترس نبود، به موتور آفلاین می‌رود', () => {
    expect(shouldUseOfflineEngine(environment({ webSpeechServiceUnavailable: true }))).toBe(true)
    expect(shouldUseOfflineEngine(environment({ webSpeechAvailable: false }))).toBe(true)
  })

  it('اگر مدل آفلاین موجود نباشد هرگز موتور آفلاین انتخاب نمی‌شود', () => {
    expect(shouldUseOfflineEngine(environment({ offlineAvailable: false, userAgent: IPHONE_UA, preference: 'offline' }))).toBe(false)
    expect(shouldUseOfflineEngine(environment({ offlineAvailable: false, webSpeechAvailable: false }))).toBe(false)
  })

  it('انتخاب دستی کاربر بر تشخیص خودکار مقدم است', () => {
    expect(shouldUseOfflineEngine(environment({ preference: 'offline' }))).toBe(true)
    expect(shouldUseOfflineEngine(environment({ preference: 'browser', userAgent: IPHONE_UA, platform: 'iPhone' }))).toBe(false)
  })
})
