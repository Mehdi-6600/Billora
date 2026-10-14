export type SpeechStatus = 'idle' | 'starting' | 'listening' | 'stopping' | 'result' | 'error' | 'unsupported'

export interface SpeechAlternativeLike {
  transcript?: string
}

export interface SpeechResultLike extends ArrayLike<SpeechAlternativeLike> {}
export interface SpeechResultsLike extends ArrayLike<SpeechResultLike> {}

export interface SpeechResultEventLike {
  results?: SpeechResultsLike
}

export interface SpeechErrorEventLike {
  error?: string
}

export interface SpeechRecognitionLike {
  lang: string
  continuous: boolean
  interimResults: boolean
  maxAlternatives?: number
  onstart: ((event: Event) => void) | null
  onresult: ((event: SpeechResultEventLike) => void) | null
  onerror: ((event: SpeechErrorEventLike) => void) | null
  onend: ((event: Event) => void) | null
  start(): void
  stop(): void
  abort?: () => void
}

export interface SpeechRecognitionConstructor {
  new (): SpeechRecognitionLike
}

export interface SpeechWindowLike {
  SpeechRecognition?: SpeechRecognitionConstructor
  webkitSpeechRecognition?: SpeechRecognitionConstructor
}

export interface SpeechSessionCallbacks {
  onStatusChange: (status: SpeechStatus) => void
  onMessage: (message: string) => void
  onTranscript: (transcript: string) => void
}

export function getSpeechRecognitionConstructor(host: SpeechWindowLike): SpeechRecognitionConstructor | undefined {
  return host.SpeechRecognition || host.webkitSpeechRecognition
}

export function speechErrorMessage(code: string): { status: 'idle' | 'error'; message: string } {
  switch (code) {
    case 'not-allowed':
      return {
        status: 'error',
        message: 'اجازهٔ میکروفن یا تشخیص گفتار رد شد. در تنظیمات Safari برای این وب‌سایت دسترسی Microphone را روی Ask یا Allow بگذارید و دوباره تلاش کنید.',
      }
    case 'service-not-allowed':
      return {
        status: 'error',
        message: 'Safari اجازهٔ استفاده از سرویس تشخیص گفتار را نداد. تنظیمات دسترسی سایت و محدودیت‌های Screen Time را بررسی کنید.',
      }
    case 'audio-capture':
      return {
        status: 'error',
        message: 'میکروفن یا ورودی صوتی در دسترس نیست. مجوز سایت و اتصال یا اشغال‌نبودن میکروفن را بررسی کنید.',
      }
    case 'no-speech':
      return {
        status: 'error',
        message: 'صدایی دریافت نشد. نزدیک میکروفن صحبت کنید و دوباره تلاش کنید.',
      }
    case 'network':
      return {
        status: 'error',
        message: 'سرویس تشخیص گفتار به شبکه وصل نشد. اتصال اینترنت را بررسی کنید؛ این قابلیت آفلاین نیست.',
      }
    case 'language-not-supported':
      return {
        status: 'error',
        message: 'مرورگر یا سرویس گفتار از فارسی پشتیبانی نمی‌کند. دستور را با صفحه‌کلید فارسی وارد کنید.',
      }
    case 'aborted':
      return { status: 'idle', message: 'تشخیص گفتار متوقف شد.' }
    case 'bad-grammar':
      return { status: 'error', message: 'سرویس گفتار نتوانست این جمله را پردازش کند. متن دستور را تایپ کنید.' }
    default:
      return {
        status: 'error',
        message: code
          ? `تشخیص گفتار با خطای «${code}» متوقف شد. دوباره تلاش کنید یا متن را تایپ کنید.`
          : 'تشخیص گفتار متوقف شد. دوباره تلاش کنید یا متن را تایپ کنید.',
      }
  }
}

function speechStartErrorMessage(error: unknown): string {
  const name = typeof error === 'object' && error !== null && 'name' in error
    ? String((error as { name?: unknown }).name ?? '')
    : ''
  switch (name) {
    case 'NotAllowedError':
      return 'مرورگر شروع میکروفن یا تشخیص گفتار را مجاز ندانست. مجوز میکروفن این وب‌سایت را در تنظیمات Safari بررسی کنید.'
    case 'SecurityError':
      return 'مرورگر دسترسی امن به گفتار را مسدود کرد. صفحه را مستقیماً با HTTPS در Safari باز کنید و مجوز سایت را بررسی کنید.'
    case 'InvalidStateError':
      return 'نشست قبلی گفتار هنوز فعال است. چند لحظه صبر کنید تا متوقف شود و دوباره تلاش کنید.'
    case 'NotSupportedError':
      return 'این نسخهٔ مرورگر سرویس تشخیص گفتار را پشتیبانی نمی‌کند. متن را دستی وارد کنید.'
    case 'AbortError':
      return 'مرورگر شروع تشخیص گفتار را لغو کرد. دوباره تلاش کنید یا متن را تایپ کنید.'
    default:
      return name
        ? `شروع تشخیص گفتار با خطای «${name}» ناموفق بود. متن را دستی وارد کنید.`
        : 'شروع تشخیص گفتار ناموفق بود. مجوز سایت و دسترسی میکروفن را بررسی کنید یا متن را دستی وارد کنید.'
  }
}

const openStatuses = new Set<SpeechStatus>(['starting', 'listening', 'stopping'])

/** A small, testable owner for one browser SpeechRecognition session. */
export class PersianSpeechSession {
  private recognition: SpeechRecognitionLike | null = null
  private disposed = false
  private currentStatus: SpeechStatus = 'idle'

  constructor(
    private readonly host: SpeechWindowLike,
    private readonly callbacks: SpeechSessionCallbacks,
  ) {}

  get status(): SpeechStatus {
    return this.currentStatus
  }

  get isActive(): boolean {
    return this.recognition !== null
  }

  start(): boolean {
    if (this.disposed) return false
    if (this.recognition) {
      if (openStatuses.has(this.currentStatus)) {
        this.publishMessage(this.currentStatus === 'stopping'
          ? 'در حال توقف نشست قبلی هستیم؛ برای لغو، دوباره دکمه را بزنید.'
          : 'تشخیص گفتار از قبل در حال اجراست. ابتدا همان نشست را متوقف کنید.')
        return false
      }
      // The previous instance already produced its result (or failed) but the browser has not reported `end` yet.
      // Retire that instance through the API so the user is never locked out, then start a fresh one.
      this.retire(this.recognition)
    }

    const Recognition = getSpeechRecognitionConstructor(this.host)
    if (!Recognition) {
      this.publishStatus('unsupported')
      this.publishMessage('این مرورگر Web Speech API را پشتیبانی نمی‌کند. می‌توانید دستور را با صفحه‌کلید فارسی وارد کنید.')
      return false
    }

    let recognition: SpeechRecognitionLike
    try {
      recognition = new Recognition()
    } catch (error) {
      this.publishStatus('error')
      this.publishMessage(speechStartErrorMessage(error))
      return false
    }

    this.recognition = recognition
    try {
      recognition.lang = 'fa-IR'
      recognition.continuous = false
      recognition.interimResults = false
      // One alternative is enough for command entry; browsers may omit this optional property.
      if ('maxAlternatives' in recognition) {
        try { recognition.maxAlternatives = 1 } catch { /* Keep the browser default if the setter is unsupported. */ }
      }

      recognition.onstart = () => {
        if (!this.isCurrent(recognition)) return
        // A late `start` after a stop request must not revive the listening UI, but the browser may still hold the microphone.
        if (this.currentStatus !== 'starting') {
          if (this.currentStatus === 'stopping') {
            this.publishMessage('میکروفن هنوز ممکن است فعال باشد؛ اگر پایان نیامد، دوباره دکمه را بزنید تا لغو شود.')
          }
          return
        }
        this.publishStatus('listening')
        this.publishMessage('در حال شنیدن… پس از نمایش متن، آن را بررسی کنید.')
      }
      recognition.onresult = (event) => {
        if (!this.isCurrent(recognition)) return
        const transcript = event.results?.[0]?.[0]?.transcript?.trim() ?? ''
        if (!transcript) {
          this.publishStatus('error')
          this.publishMessage('متن قابل‌فهمی از گفتار دریافت نشد. دوباره تلاش کنید یا متن را تایپ کنید.')
          return
        }
        this.publishStatus('result')
        this.callbacks.onTranscript(transcript)
        this.publishMessage('متن شنیده‌شده را بازبینی کنید؛ تا وقتی «اجرای دستور» را نزنید تغییری انجام نمی‌شود.')
      }
      recognition.onerror = (event) => {
        if (!this.isCurrent(recognition)) return
        const result = speechErrorMessage(event.error ?? '')
        this.release(recognition, true)
        this.publishStatus(result.status)
        this.publishMessage(result.message)
      }
      recognition.onend = () => {
        if (!this.isCurrent(recognition)) return
        this.release(recognition)
        if (openStatuses.has(this.currentStatus)) {
          const wasStopping = this.currentStatus === 'stopping'
          this.publishStatus('idle')
          this.publishMessage(wasStopping
            ? 'ضبط متوقف شد.'
            : 'نشست گفتار پایان یافت. اگر متنی دریافت نشد، دوباره صحبت کنید یا متن را تایپ کنید.')
        }
      }

      this.publishStatus('starting')
      this.publishMessage('در حال آماده‌سازی میکروفن…')
      // Keep start() synchronous in the click handler; do not await getUserMedia or a permission query here.
      recognition.start()
      return true
    } catch (error) {
      if (this.recognition === recognition) this.recognition = null
      this.clearHandlers(recognition)
      try { recognition.abort?.() } catch { /* start() may have failed before a native session existed. */ }
      this.publishStatus('error')
      this.publishMessage(speechStartErrorMessage(error))
      return false
    }
  }

  /**
   * First press asks the browser to stop and keep its result.
   * A second press while the browser has not reported `end` escalates to `abort()` on the same instance:
   * the session is discarded, handlers are detached, and the UI returns to idle without waiting for an event that may never come.
   */
  stop(): boolean {
    const recognition = this.recognition
    if (!recognition || this.disposed) return false

    if (this.currentStatus === 'stopping') {
      this.retire(recognition)
      this.publishStatus('idle')
      this.publishMessage('ضبط لغو شد؛ متنی ثبت نشد.')
      return true
    }

    this.publishStatus('stopping')
    this.publishMessage('در حال توقف تشخیص گفتار…')
    try {
      recognition.stop()
      return true
    } catch (error) {
      this.retire(recognition)
      this.publishStatus('error')
      this.publishMessage(speechStartErrorMessage(error))
      return false
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    const recognition = this.recognition
    this.recognition = null
    if (!recognition) return
    this.clearHandlers(recognition)
    try {
      if (recognition.abort) recognition.abort()
      else recognition.stop()
    } catch {
      // The user agent may already have ended the native session.
    }
  }

  private isCurrent(recognition: SpeechRecognitionLike): boolean {
    return !this.disposed && this.recognition === recognition
  }

  private release(recognition: SpeechRecognitionLike, cancelNative = false): void {
    if (this.recognition !== recognition) return
    this.recognition = null
    this.clearHandlers(recognition)
    if (!cancelNative) return
    try {
      if (recognition.abort) recognition.abort()
      else recognition.stop()
    } catch {
      // The user agent may already have ended the native session.
    }
  }

  /** Detach handlers first so late browser events cannot touch the UI, then abort the native instance. */
  private retire(recognition: SpeechRecognitionLike): void {
    if (this.recognition === recognition) this.recognition = null
    this.clearHandlers(recognition)
    try {
      if (recognition.abort) recognition.abort()
      else recognition.stop()
    } catch {
      // The user agent may already have ended the native session.
    }
  }

  private clearHandlers(recognition: SpeechRecognitionLike): void {
    recognition.onstart = null
    recognition.onresult = null
    recognition.onerror = null
    recognition.onend = null
  }

  private publishStatus(status: SpeechStatus): void {
    this.currentStatus = status
    this.callbacks.onStatusChange(status)
  }

  private publishMessage(message: string): void {
    this.callbacks.onMessage(message)
  }
}
