/**
 * All user-facing Persian copy for the offline engine lives here, so the wording is testable and
 * never drifts between the invoice editor and the standalone diagnostic page.
 */

export const OFFLINE_SPEECH_MESSAGES = {
  unsupported:
    'موتور تشخیص گفتار آفلاین در این مرورگر در دسترس نیست (WebAssembly یا Web Worker پشتیبانی نمی‌شود). از ورودی متنی استفاده کنید.',
  modelMissing:
    'موتور تشخیص گفتار آفلاین در دسترس نیست؛ فایل‌های مدل روی این دستگاه نصب نشده‌اند. از ورودی متنی استفاده کنید.',
  checking: 'در حال بررسی موتور تشخیص گفتار آفلاین…',
  remoteModelDownload:
    'مدل گفتار آفلاین روی این دامنه نصب نشده است؛ بار اول حدود ۱۳۷ مگابایت دانلود می‌شود و پس از آن تشخیص گفتار کاملاً آفلاین و روی همین دستگاه انجام می‌شود.',
  remoteModelPartial:
    'بخشی از مدل گفتار آفلاین روی این دامنه نیست؛ بار اول همان بخش از Hugging Face دانلود می‌شود و پس از آن تشخیص گفتار کاملاً آفلاین و روی همین دستگاه انجام می‌شود.',
  preparing: 'در حال آماده‌سازی موتور گفتار روی دستگاه…',
  preparingFirstTime: 'در حال آماده‌سازی موتور گفتار روی دستگاه (بار اول چند لحظه طول می‌کشد و پس از آن سریع می‌شود)…',
  ready: 'موتور گفتار آماده است؛ صدا روی همین دستگاه پردازش می‌شود و به اینترنت فرستاده نمی‌شود.',
  listening: 'در حال شنیدن… پس از نمایش متن، آن را بررسی کنید.',
  transcribing: 'در حال تبدیل گفتار به متن روی دستگاه…',
  done: 'متن شنیده‌شده را بازبینی کنید؛ تا وقتی «اجرای دستور» را نزنید تغییری انجام نمی‌شود.',
  noSpeech: 'متنی از گفتار تشخیص داده نشد. دوباره صحبت کنید یا دستور را تایپ کنید.',
  stopped: 'ضبط متوقف شد. متن روی دستگاه پردازش می‌شود…',
  busy: 'پردازش گفتار قبلی هنوز تمام نشده است؛ چند لحظه صبر کنید.',
  permissionDenied: 'اجازهٔ میکروفن رد شد. در تنظیمات مرورگر دسترسی Microphone این سایت را مجاز کنید و دوباره تلاش کنید.',
  noMicrophone: 'میکروفن یا ورودی صوتی در دسترس نیست. اتصال میکروفن و مجوز سایت را بررسی کنید.',
  initFailed: 'راه‌اندازی موتور تشخیص گفتار آفلاین ناموفق بود. از ورودی متنی استفاده کنید یا صفحه را دوباره باز کنید.',
  decodeFailed: 'تبدیل گفتار به متن انجام نشد. دوباره تلاش کنید یا دستور را تایپ کنید.',
  noAudio: 'صدایی ضبط نشد. نزدیک میکروفن صحبت کنید و دوباره تلاش کنید.',
  crossOriginIsolatedMissing:
    'این صفحه چندرشته‌ای اجرا نمی‌شود، بنابراین پردازش آفلاین کندتر است. برای عملکرد بهتر صفحه را رفرش کنید (هدرهای Cross-Origin Isolation).',
  engineBrowser: 'موتور مرورگر',
  engineOffline: 'موتور آفلاین (شنوا)',
} as const

export function describeMissingFiles(files: readonly string[]): string {
  if (files.length === 0) return OFFLINE_SPEECH_MESSAGES.modelMissing
  return `${OFFLINE_SPEECH_MESSAGES.modelMissing} فایل‌های ناموجود: ${files.join('، ')}`
}

/** Maps `getUserMedia` / media errors to the same tone as the existing Web Speech messages. */
export function captureErrorMessage(error: unknown): string {
  const name = error instanceof Error ? error.name : ''
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return OFFLINE_SPEECH_MESSAGES.permissionDenied
    case 'NotFoundError':
    case 'NotReadableError':
    case 'OverconstrainedError':
      return OFFLINE_SPEECH_MESSAGES.noMicrophone
    default:
      return OFFLINE_SPEECH_MESSAGES.noMicrophone
  }
}
