import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getSpeechRecognitionConstructor,
  PersianSpeechSession,
  type SpeechErrorEventLike,
  type SpeechRecognitionLike,
  type SpeechResultEventLike,
  type SpeechStatus,
  type SpeechWindowLike,
} from './speech-recognition'

class FakeRecognition implements SpeechRecognitionLike {
  static instances: FakeRecognition[] = []
  static nextStartError: unknown = null

  lang = ''
  continuous = true
  interimResults = true
  maxAlternatives = 3
  onstart: ((event: Event) => void) | null = null
  onresult: ((event: SpeechResultEventLike) => void) | null = null
  onerror: ((event: SpeechErrorEventLike) => void) | null = null
  onend: ((event: Event) => void) | null = null
  startCalls = 0
  stopCalls = 0
  abortCalls = 0

  constructor() {
    FakeRecognition.instances.push(this)
  }

  start() {
    this.startCalls += 1
    if (FakeRecognition.nextStartError) throw FakeRecognition.nextStartError
  }

  stop() { this.stopCalls += 1 }
  abort() { this.abortCalls += 1 }
  emitStart() { this.onstart?.(new Event('start')) }
  emitResult(transcript: string) {
    const alternative = { transcript }
    const result = { 0: alternative, length: 1 }
    const results = { 0: result, length: 1 }
    this.onresult?.({ results })
  }
  emitError(error: string) { this.onerror?.({ error }) }
  emitEnd() { this.onend?.(new Event('end')) }
}

class WebkitOnlyRecognition extends FakeRecognition {
  static override instances: WebkitOnlyRecognition[] = []
  constructor() {
    super()
    WebkitOnlyRecognition.instances.push(this)
  }
}

function callbacks() {
  return {
    onStatusChange: vi.fn<(status: SpeechStatus) => void>(),
    onMessage: vi.fn<(message: string) => void>(),
    onTranscript: vi.fn<(transcript: string) => void>(),
  }
}

describe('سازگاری و چرخهٔ Web Speech API', () => {
  beforeEach(() => {
    FakeRecognition.instances = []
    FakeRecognition.nextStartError = null
    WebkitOnlyRecognition.instances = []
  })

  it('SpeechRecognition استاندارد را ترجیح می‌دهد و تنظیم فارسی را پیش از start اعمال می‌کند', () => {
    const host: SpeechWindowLike = { SpeechRecognition: FakeRecognition, webkitSpeechRecognition: WebkitOnlyRecognition }
    expect(getSpeechRecognitionConstructor(host)).toBe(FakeRecognition)
    const events: string[] = []
    const handlers = callbacks()
    handlers.onStatusChange.mockImplementation((status) => events.push(`status:${status}`))
    const session = new PersianSpeechSession(host, handlers)

    expect(session.start()).toBe(true)
    const recognition = FakeRecognition.instances[0]
    expect(recognition).toMatchObject({ lang: 'fa-IR', continuous: false, interimResults: false, maxAlternatives: 1, startCalls: 1 })
    expect(events).toContain('status:starting')
    recognition.emitStart()
    expect(session.status).toBe('listening')
  })

  it('اگر API استاندارد نباشد از webkitSpeechRecognition استفاده می‌کند', () => {
    const host: SpeechWindowLike = { webkitSpeechRecognition: WebkitOnlyRecognition }
    expect(getSpeechRecognitionConstructor(host)).toBe(WebkitOnlyRecognition)
    const session = new PersianSpeechSession(host, callbacks())
    expect(session.start()).toBe(true)
    expect(WebkitOnlyRecognition.instances).toHaveLength(1)
    expect(FakeRecognition.instances).toHaveLength(1)
  })

  it('بدون هر دو API خطای پشتیبانی‌نشدن می‌دهد و نشست صوتی نمی‌سازد', () => {
    const handlers = callbacks()
    const session = new PersianSpeechSession({}, handlers)
    expect(session.start()).toBe(false)
    expect(session.status).toBe('unsupported')
    expect(handlers.onMessage.mock.lastCall?.[0]).toContain('پشتیبانی نمی‌کند')
    expect(session.isActive).toBe(false)
  })

  it.each([
    ['not-allowed', 'اجازهٔ میکروفن', 'error'],
    ['service-not-allowed', 'سرویس تشخیص گفتار', 'error'],
    ['audio-capture', 'ورودی صوتی', 'error'],
    ['no-speech', 'صدایی دریافت نشد', 'error'],
    ['network', 'شبکه', 'error'],
  ] as const)('علت خطای %s را با پیام درست گزارش می‌کند', (errorCode, messagePart, expectedStatus) => {
    const handlers = callbacks()
    const session = new PersianSpeechSession({ SpeechRecognition: FakeRecognition }, handlers)
    session.start()
    const recognition = FakeRecognition.instances[0]
    recognition.emitError(errorCode)

    expect(session.status).toBe(expectedStatus)
    expect(handlers.onMessage.mock.lastCall?.[0]).toContain(messagePart)
    expect(session.isActive).toBe(false)
    expect(recognition.abortCalls).toBe(1)
    expect(recognition.onerror).toBeNull()
    recognition.emitEnd()
    expect(session.status).toBe(expectedStatus)
  })

  it('شروع هم‌زمان را رد می‌کند و یک نشست را فقط یک‌بار متوقف می‌کند', () => {
    const handlers = callbacks()
    const session = new PersianSpeechSession({ SpeechRecognition: FakeRecognition }, handlers)
    expect(session.start()).toBe(true)
    expect(session.start()).toBe(false)
    expect(FakeRecognition.instances).toHaveLength(1)
    const recognition = FakeRecognition.instances[0]
    expect(recognition.startCalls).toBe(1)

    expect(session.stop()).toBe(true)
    expect(recognition.stopCalls).toBe(1)
    recognition.emitEnd()
    expect(session.status).toBe('idle')
    expect(session.isActive).toBe(false)
    expect(session.start()).toBe(true)
    expect(FakeRecognition.instances).toHaveLength(2)
  })

  it('نتیجهٔ فارسی را تحویل ورودی می‌دهد، ولی خودش هیچ دستوری را اجرا نمی‌کند', () => {
    const handlers = callbacks()
    const session = new PersianSpeechSession({ SpeechRecognition: FakeRecognition }, handlers)
    session.start()
    const recognition = FakeRecognition.instances[0]
    recognition.emitStart()
    recognition.emitResult('سه عدد شیر به فاکتور اضافه کن')

    expect(handlers.onTranscript).toHaveBeenCalledExactlyOnceWith('سه عدد شیر به فاکتور اضافه کن')
    expect(session.status).toBe('result')
    expect(handlers.onMessage.mock.lastCall?.[0]).toContain('انجام نمی‌شود')
    expect(handlers.onStatusChange).not.toHaveBeenCalledWith('error')
  })

  it.each([
    ['NotAllowedError', 'مجاز ندانست'],
    ['SecurityError', 'HTTPS'],
    ['InvalidStateError', 'نشست قبلی'],
    ['NotSupportedError', 'پشتیبانی نمی‌کند'],
  ])('خطای هم‌زمانِ start با %s را دقیق تشخیص می‌دهد و نشست معلق باقی نمی‌گذارد', (name, messagePart) => {
    FakeRecognition.nextStartError = { name }
    const handlers = callbacks()
    const session = new PersianSpeechSession({ SpeechRecognition: FakeRecognition }, handlers)
    expect(session.start()).toBe(false)
    expect(session.status).toBe('error')
    expect(session.isActive).toBe(false)
    expect(handlers.onMessage.mock.lastCall?.[0]).toContain(messagePart)
    expect(FakeRecognition.instances[0].abortCalls).toBe(1)
    expect(FakeRecognition.instances[0].onend).toBeNull()
  })

  it('هنگام خروج از صفحه، نشست را abort و handlerها را پاک می‌کند', () => {
    const session = new PersianSpeechSession({ SpeechRecognition: FakeRecognition }, callbacks())
    session.start()
    const recognition = FakeRecognition.instances[0]
    session.dispose()
    expect(recognition.abortCalls).toBe(1)
    expect(recognition.onstart).toBeNull()
    expect(recognition.onresult).toBeNull()
    expect(recognition.onerror).toBeNull()
    expect(recognition.onend).toBeNull()
    expect(session.start()).toBe(false)
  })
})

describe('چرخهٔ توقف، پایان و بازیابی نشست', () => {
  beforeEach(() => {
    FakeRecognition.instances = []
    FakeRecognition.nextStartError = null
  })

  it('اگر مرورگر پس از stop پایان نفرستد، لمس دوم نشست را با abort روی همان نمونه می‌بندد', () => {
    const handlers = callbacks()
    const session = new PersianSpeechSession({ SpeechRecognition: FakeRecognition }, handlers)
    session.start()
    const recognition = FakeRecognition.instances[0]
    recognition.emitStart()

    expect(session.stop()).toBe(true)
    expect(session.status).toBe('stopping')
    expect(recognition.stopCalls).toBe(1)

    // No onend arrives here: the second press must not leave the UI in «در حال توقف» for ever.
    expect(session.stop()).toBe(true)
    expect(recognition.abortCalls).toBe(1)
    expect(session.status).toBe('idle')
    expect(session.isActive).toBe(false)
    expect(recognition.onend).toBeNull()

    expect(session.start()).toBe(true)
    expect(FakeRecognition.instances).toHaveLength(2)
  })

  it('onstart دیرهنگام پس از درخواست توقف، وضعیت را دوباره به «در حال شنیدن» برنمی‌گرداند', () => {
    const session = new PersianSpeechSession({ SpeechRecognition: FakeRecognition }, callbacks())
    session.start()
    const recognition = FakeRecognition.instances[0]
    session.stop()
    recognition.emitStart()
    expect(session.status).toBe('stopping')
    recognition.emitEnd()
    expect(session.status).toBe('idle')
    expect(session.isActive).toBe(false)
  })

  it('نتیجهٔ رسیده در حین توقف حفظ می‌شود و onend بعدی آن را پاک نمی‌کند', () => {
    const handlers = callbacks()
    const session = new PersianSpeechSession({ SpeechRecognition: FakeRecognition }, handlers)
    session.start()
    const recognition = FakeRecognition.instances[0]
    recognition.emitStart()
    session.stop()
    recognition.emitResult('دو عدد برنج هاشمی به فاکتور اضافه کن')
    recognition.emitEnd()
    expect(handlers.onTranscript).toHaveBeenCalledExactlyOnceWith('دو عدد برنج هاشمی به فاکتور اضافه کن')
    expect(session.status).toBe('result')
    expect(session.isActive).toBe(false)
  })

  it('اگر end هرگز نیامد و نتیجه هم داده شد، شروع بعدی نشست معلق را کنار می‌گذارد و نتیجهٔ قدیمی را دوباره نمی‌دهد', () => {
    const handlers = callbacks()
    const session = new PersianSpeechSession({ SpeechRecognition: FakeRecognition }, handlers)
    session.start()
    const first = FakeRecognition.instances[0]
    first.emitStart()
    first.emitResult('سه عدد شیر به فاکتور اضافه کن')

    expect(session.start()).toBe(true)
    expect(FakeRecognition.instances).toHaveLength(2)
    expect(first.abortCalls).toBe(1)
    expect(first.onresult).toBeNull()
    first.emitResult('سه عدد شیر به فاکتور اضافه کن')
    expect(handlers.onTranscript).toHaveBeenCalledTimes(1)
  })

  it('stop بعد از پایان نشست یا بدون نشست، هیچ دستور توقفی به مرورگر نمی‌فرستد', () => {
    const session = new PersianSpeechSession({ SpeechRecognition: FakeRecognition }, callbacks())
    expect(session.stop()).toBe(false)
    session.start()
    const recognition = FakeRecognition.instances[0]
    recognition.emitEnd()
    expect(session.stop()).toBe(false)
    expect(recognition.stopCalls).toBe(0)
    expect(recognition.abortCalls).toBe(0)
  })

  it('خطای stop از مرورگر نشست را پاک می‌کند و وضعیت خطا می‌دهد', () => {
    class ThrowingStop extends FakeRecognition {
      override stop() { throw { name: 'InvalidStateError' } }
    }
    const handlers = callbacks()
    const session = new PersianSpeechSession({ SpeechRecognition: ThrowingStop }, handlers)
    session.start()
    session.stop()
    expect(session.status).toBe('error')
    expect(session.isActive).toBe(false)
    expect(handlers.onMessage.mock.lastCall?.[0]).toContain('نشست قبلی')
  })

  it('خطای مجوز میکروفن در میانهٔ نشست، نشست را می‌بندد و اجرای مجدد را ممکن می‌کند', () => {
    const handlers = callbacks()
    const session = new PersianSpeechSession({ SpeechRecognition: FakeRecognition }, handlers)
    session.start()
    FakeRecognition.instances[0].emitError('not-allowed')
    expect(session.status).toBe('error')
    expect(handlers.onMessage.mock.lastCall?.[0]).toContain('اجازهٔ میکروفن')
    expect(session.start()).toBe(true)
  })
})

describe('تشخیص خطای سرویس گفتار از خطای مجوز و خطای شروع', () => {
  beforeEach(() => {
    FakeRecognition.instances = []
    FakeRecognition.nextStartError = null
  })

  it('service-not-allowed از onerror پیام مجوز میکروفن نمی‌دهد و کد خطا را نشان می‌دهد', () => {
    const handlers = callbacks()
    const session = new PersianSpeechSession({ SpeechRecognition: FakeRecognition }, handlers)
    session.start()
    const recognition = FakeRecognition.instances[0]
    expect(recognition.lang).toBe('fa-IR')
    recognition.emitError('service-not-allowed')

    const message = handlers.onMessage.mock.lastCall?.[0] ?? ''
    expect(session.status).toBe('error')
    expect(message).toContain('کد: service-not-allowed')
    expect(message).toContain('Dictation')
    expect(message).toContain('این خطا به مجوز میکروفن مربوط نیست')
    expect(message).not.toContain('اجازهٔ میکروفن')
    expect(message).not.toContain('Ask یا Allow')
    expect(session.isActive).toBe(false)
  })

  it('not-allowed همچنان پیام مجوز میکروفن می‌دهد؛ این دو خطا با هم اشتباه گرفته نمی‌شوند', () => {
    const handlers = callbacks()
    const session = new PersianSpeechSession({ SpeechRecognition: FakeRecognition }, handlers)
    session.start()
    FakeRecognition.instances[0].emitError('not-allowed')
    expect(handlers.onMessage.mock.lastCall?.[0]).toContain('اجازهٔ میکروفن')
    expect(handlers.onMessage.mock.lastCall?.[0]).not.toContain('کد: service-not-allowed')
    expect(session.status).toBe('error')
  })

  it('خطای خودِ start (پرتاب‌شده) پیام service-not-allowed را تولید نمی‌کند', () => {
    FakeRecognition.nextStartError = { name: 'NotAllowedError' }
    const handlers = callbacks()
    const session = new PersianSpeechSession({ SpeechRecognition: FakeRecognition }, handlers)
    session.start()
    const message = handlers.onMessage.mock.lastCall?.[0] ?? ''
    expect(message).toContain('مجاز ندانست')
    expect(message).not.toContain('کد: service-not-allowed')
  })
})
