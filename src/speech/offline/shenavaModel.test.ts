import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  configuredRemoteBaseUrl,
  loadPartsManifest,
  parsePartsManifest,
  partsForFile,
  partsTotalBytes,
  SHENAVA_PARTS_FILE,
  currentBaseHref,
  probeShenavaModelFiles,
  resolveAbsoluteUrl,
  resolveShenavaWorkerUrls,
  shenavaRemoteFileUrl,
  SHENAVA_MODEL_FILES,
  shenavaModelDirectoryUrl,
  shenavaModelUrl,
  shenavaOrtDirectoryUrl,
  shenavaRuntimeSupported,
  probeShenavaModel,
} from './shenavaModel'

interface FakeResponse {
  ok: boolean
  status: number
  headers: { get(name: string): string | null }
}

function response(headers: Record<string, string>, ok = true, status = 200): FakeResponse {
  const lower = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]))
  return { ok, status, headers: { get: (name) => lower.get(name.toLowerCase()) ?? null } }
}

function stubRuntime(available: boolean): void {
  if (available) {
    vi.stubGlobal('Worker', class {})
    vi.stubGlobal('WebAssembly', {})
  } else {
    vi.stubGlobal('Worker', undefined)
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('آدرس و مشخصات فایل‌های مدل شنوا', () => {
  it('مسیر فایل‌ها با base ویت هم درست ساخته می‌شود', () => {
    expect(shenavaModelUrl('tokens.txt')).toBe('/models/shenava/tokens.txt')
    expect(shenavaModelUrl('encoder.int8.onnx', '/Billora/')).toBe('/Billora/models/shenava/encoder.int8.onnx')
    expect(shenavaModelUrl('encoder.int8.onnx', '/Billora')).toBe('/Billora/models/shenava/encoder.int8.onnx')
  })

  it('حجم و هش فایل‌ها مطابق متادیتای Hugging Face است', () => {
    expect(SHENAVA_MODEL_FILES.map((file) => file.name)).toEqual([
      'encoder.int8.onnx',
      'decoder.int8.onnx',
      'joiner.int8.onnx',
      'tokens.txt',
    ])
    expect(SHENAVA_MODEL_FILES[0]!.bytes).toBe(131_342_912)
    expect(SHENAVA_MODEL_FILES[0]!.sha256).toHaveLength(64)
    expect(SHENAVA_MODEL_FILES[3]!.sha256).toBeNull()
  })
})

describe('شناسایی نصب‌بودن مدل روی دستگاه', () => {
  it('وقتی هر چهار فایل با حجم درست سرو شوند، مدل موجود است', async () => {
    stubRuntime(true)
    const seen: string[] = []
    const fetcher = vi.fn(async (url: string) => {
      seen.push(url)
      const file = SHENAVA_MODEL_FILES.find((entry) => url.endsWith(entry.name))!
      return response({ 'content-length': String(file.bytes) })
    })

    const result = await probeShenavaModel(fetcher, '/')
    expect(result).toEqual({ available: true, missing: [], source: 'local' })
    expect(seen).toHaveLength(4)
  })

  it('فایل ناموجود یا کم‌حجم را گزارش می‌دهد', async () => {
    stubRuntime(true)
    const fetcher = vi.fn(async (url: string) => {
      if (url.endsWith('decoder.int8.onnx')) return response({ 'content-length': '10' })
      if (url.endsWith('joiner.int8.onnx')) return response({}, false, 404)
      const file = SHENAVA_MODEL_FILES.find((entry) => url.endsWith(entry.name))!
      return response({ 'content-length': String(file.bytes) })
    })

    const result = await probeShenavaModel(fetcher, '/')
    expect(result.available).toBe(false)
    expect(result.missing).toEqual(['decoder.int8.onnx', 'joiner.int8.onnx'])
    expect(result.reason).toBe('missing')
  })

  it('اگر هدر content-length نبود، از درخواست بازه‌ای استفاده می‌کند', async () => {
    stubRuntime(true)
    const fetcher = vi.fn(async (url: string, init?: { method?: string; headers?: Record<string, string> }) => {
      const file = SHENAVA_MODEL_FILES.find((entry) => url.endsWith(entry.name))!
      if (init?.method === 'HEAD') return response({})
      expect(init?.headers?.Range).toBe('bytes=0-0')
      return response({ 'content-range': `bytes 0-0/${file.bytes}` })
    })

    await expect(probeShenavaModel(fetcher, '/')).resolves.toEqual({ available: true, missing: [], source: 'local' })
  })

  it('پاسخ ۲۰۰ صفحهٔ SPA با حجم نامناسب را «فایل ناموجود» می‌داند', async () => {
    stubRuntime(true)
    // Exactly what `vite dev` does for a missing asset: 200 + the index.html fallback.
    const fetcher = vi.fn(async (_url: string, init?: { method?: string }) =>
      init?.method === 'HEAD'
        ? ({ ok: true, status: 200, headers: { get: () => null } } as never)
        : ({ ok: true, status: 200, headers: { get: (name: string) => (name === 'content-length' ? '1074' : null) } } as never),
    )
    const result = await probeShenavaModel(fetcher as never, '/')
    expect(result.available).toBe(false)
    expect(result.reason).toBe('missing')
    expect(result.missing).toHaveLength(SHENAVA_MODEL_FILES.length)
  })

  it('اگر هیچ فایلی پاسخ نداد دلیل network/unreachable گزارش می‌شود', async () => {
    stubRuntime(true)
    const fetcher = vi.fn(async () => { throw new Error('offline') })
    const result = await probeShenavaModel(fetcher, '/')
    expect(result.available).toBe(false)
    expect(result.reason).toBe('unreachable')
  })

  it('اگر فایل‌ها کنار برنامه نباشند ولی روی Hugging Face موجود باشند، منبع hub گزارش می‌شود', async () => {
    stubRuntime(true)
    const hubRequests: string[] = []
    const fetcher = vi.fn(async (url: string) => {
      if (url.startsWith('https://huggingface.co/')) {
        hubRequests.push(url)
        const file = SHENAVA_MODEL_FILES.find((entry) => url.endsWith(entry.name))!
        return response({ 'content-length': String(file.bytes) })
      }
      return { ok: false, status: 404, headers: { get: () => null } }
    })

    const result = await probeShenavaModel(fetcher, '/', undefined, true, { allowRemote: true })
    expect(result).toEqual({ available: true, missing: [], source: 'hub' })
    expect(hubRequests).toHaveLength(SHENAVA_MODEL_FILES.length)
    expect(hubRequests[0]).toContain('Reza2kn/Shenava-Koochik-v1.5-RNNT-sherpa-onnx/resolve/main/')
  })

  it('وقتی دانلود از Hub مجاز نیست، فقط فایل‌های محلی بررسی می‌شوند', async () => {
    stubRuntime(true)
    const fetcher = vi.fn(async (url: string) => ({ ok: false, status: 404, headers: { get: () => null }, url }))
    const result = await probeShenavaModel(fetcher, '/')
    expect(result).toMatchObject({ available: false, reason: 'missing' })
    expect(fetcher.mock.calls.every(([url]) => String(url).startsWith('/'))).toBe(true)
  })

  it('اگر بخشی از مدل همراه برنامه و بقیه روی Hub باشد، منبع mixed و موتور در دسترس است', async () => {
    stubRuntime(true)
    const encoder = SHENAVA_MODEL_FILES[0]
    const fetcher = vi.fn(async (url: string) => {
      const file = SHENAVA_MODEL_FILES.find((entry) => url.endsWith(entry.name))!
      if (url.startsWith('/models/')) {
        // مثل حالتی که میزبان فایل بزرگ را همراه build نمی‌پذیرد و فقط فایل‌های کوچک منتشر شده‌اند
        return file.name === encoder.name ? { ok: false, status: 404, headers: { get: () => null } } : response({ 'content-length': String(file.bytes) })
      }
      return response({ 'content-length': String(file.bytes) })
    })

    const result = await probeShenavaModel(fetcher, '/', undefined, true, { allowRemote: true })
    expect(result).toEqual({ available: true, missing: [], source: 'mixed' })
  })

  it('فایلی که نه محلی است و نه روی Hub، با نام در فهرست ناموجودها می‌آید', async () => {
    stubRuntime(true)
    const missingFile = SHENAVA_MODEL_FILES[2]
    const fetcher = vi.fn(async (url: string) => {
      const file = SHENAVA_MODEL_FILES.find((entry) => url.endsWith(entry.name))!
      if (file.name === missingFile.name) return { ok: false, status: 404, headers: { get: () => null } }
      return response({ 'content-length': String(file.bytes) })
    })

    const result = await probeShenavaModel(fetcher, '/', undefined, true, { allowRemote: true })
    expect(result).toMatchObject({ available: false, missing: [missingFile.name], reason: 'missing' })
  })

  it('گزارش هر فایل (محلی/بیرونی + حجم اندازه‌گیری‌شده) را برمی‌گرداند', async () => {
    stubRuntime(true)
    const encoder = SHENAVA_MODEL_FILES[0]
    const fetcher = vi.fn(async (url: string) => {
      const file = SHENAVA_MODEL_FILES.find((entry) => url.endsWith(entry.name))!
      if (url.includes('/models/')) {
        if (file.name === encoder.name) return { ok: false, status: 404, headers: { get: () => null } }
        const length = file.name === 'tokens.txt' ? file.bytes : file.bytes
        return response({ 'content-length': String(length) })
      }
      return response({ 'content-length': String(file.bytes) })
    })

    const detailed = await probeShenavaModelFiles(fetcher, '/', undefined, true, { allowRemote: true })
    expect(detailed.source).toBe('mixed')
    expect(detailed.files).toHaveLength(SHENAVA_MODEL_FILES.length)
    const encoderReport = detailed.files.find((report) => report.name === encoder.name)!
    expect(encoderReport).toMatchObject({ local: 'absent', localBytes: null, remote: 'ok', remoteBytes: encoder.bytes })
    expect(encoderReport.localUrl).toBe(`/models/shenava/${encoder.name}`)
    expect(encoderReport.remoteUrl).toContain('huggingface.co')
    const decoderReport = detailed.files.find((report) => report.name === 'decoder.int8.onnx')!
    expect(decoderReport).toMatchObject({ local: 'ok', remote: 'not-checked' })
    expect(decoderReport.localBytes).toBe(SHENAVA_MODEL_FILES[1].bytes)
  })

  it('در حالت پشتیبانی‌نشده، گزارش هر فایل «غایب» است و درخواستی فرستاده نمی‌شود', async () => {
    stubRuntime(false)
    const fetcher = vi.fn()
    const detailed = await probeShenavaModelFiles(fetcher as never, '/')
    expect(detailed.available).toBe(false)
    expect(detailed.reason).toBe('unsupported')
    expect(detailed.files.every((report) => report.local === 'absent' && report.remote === 'not-checked')).toBe(true)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('میزبان بیرونی از متغیر build خوانده می‌شود و Hugging Face را جایگزین می‌کند', () => {
    expect(configuredRemoteBaseUrl({})).toBeNull()
    expect(configuredRemoteBaseUrl({ VITE_SHENAVA_MODEL_BASE_URL: '   ' })).toBeNull()
    const base = 'https://github.com/Mehdi-6600/Billora/releases/download/shenava-model-v1.5-int8/'
    expect(configuredRemoteBaseUrl({ VITE_SHENAVA_MODEL_BASE_URL: base })).toBe(base.replace(/\/+$/, ''))
    expect(shenavaRemoteFileUrl('encoder.int8.onnx', { remoteBaseUrl: base.replace(/\/+$/, '') }))
      .toBe('https://github.com/Mehdi-6600/Billora/releases/download/shenava-model-v1.5-int8/encoder.int8.onnx')
    // بدون تنظیم، پیش‌فرض همان Hugging Face است
    expect(shenavaRemoteFileUrl('tokens.txt')).toContain('huggingface.co/Reza2kn/')
  })

  it('probe با میزبان بیرونی تنظیم‌شده، همان آدرس را بررسی می‌کند', async () => {
    stubRuntime(true)
    const seen: string[] = []
    const fetcher = vi.fn(async (url: string) => {
      seen.push(url)
      if (url.startsWith('/models/')) return { ok: false, status: 404, headers: { get: () => null } }
      const file = SHENAVA_MODEL_FILES.find((entry) => url.endsWith(entry.name))!
      return response({ 'content-length': String(file.bytes) })
    })

    const result = await probeShenavaModelFiles(fetcher as never, '/', undefined, true, {
      allowRemote: true,
      remoteBaseUrl: 'https://mirror.example/models',
    })
    expect(result.source).toBe('hub')
    expect(seen.every((url) => !url.includes('huggingface.co'))).toBe(true)
    expect(seen).toContain('https://mirror.example/models/encoder.int8.onnx')
  })

  it('بدون Web Worker یا WebAssembly حتی درخواستی فرستاده نمی‌شود', async () => {
    stubRuntime(false)
    const fetcher = vi.fn()
    const result = await probeShenavaModel(fetcher, '/')
    expect(result).toMatchObject({ available: false, reason: 'unsupported' })
    expect(fetcher).not.toHaveBeenCalled()
    expect(shenavaRuntimeSupported()).toBe(false)
  })
})

describe('ساخت آدرس مطلق برای worker (باگ «Invalid base URL»)', () => {
  const PAGE_VERCEL = 'https://billora.vercel.app/'
  const WORKER_SCRIPT = 'https://billora.vercel.app/assets/shenava.worker-B8Il634R.js'
  const PAGE_PAGES = 'https://mehdi-6600.github.io/Billora/'

  it('پایهٔ نسبی همان چیزی است که در مرورگر خطا می‌داد و نباید دوباره استفاده شود', () => {
    // سند این باگ: مرورگرها (و Node) پایهٔ نسبی را نمی‌پذیرند، پس `new URL(name, '/models/.../')`
    // بلافاصله خطا می‌داد و موتور آفلاین هرگز شروع نمی‌شد.
    expect(() => new URL('encoder.int8.onnx', '/models/shenava/')).toThrow()
    expect(resolveAbsoluteUrl('encoder.int8.onnx', '/models/shenava/')).toBeNull()
    expect(resolveAbsoluteUrl('encoder.int8.onnx', null)).toBeNull()
  })

  it('مسیرهای نسبی/مطلق را با href صفحه به آدرس مطلق تبدیل می‌کند', () => {
    expect(shenavaModelDirectoryUrl()).toBe('/models/shenava/')
    expect(shenavaModelDirectoryUrl('/Billora')).toBe('/Billora/models/shenava/')
    expect(shenavaOrtDirectoryUrl('/Billora/')).toBe('/Billora/ort/')
    expect(resolveAbsoluteUrl('/models/shenava/encoder.int8.onnx', PAGE_VERCEL))
      .toBe('https://billora.vercel.app/models/shenava/encoder.int8.onnx')
    expect(resolveAbsoluteUrl('models/shenava/tokens.txt', PAGE_PAGES))
      .toBe('https://mehdi-6600.github.io/Billora/models/shenava/tokens.txt')
    expect(resolveAbsoluteUrl('https://cdn.example.com/a.onnx', null)).toBe('https://cdn.example.com/a.onnx')
  })

  it('worker با baseUrl ویت، همهٔ آدرس‌ها را مطلق می‌سازد', () => {
    const urls = resolveShenavaWorkerUrls({ baseUrl: '/', baseHref: WORKER_SCRIPT })
    expect(urls.ortDirectoryUrl).toBe('https://billora.vercel.app/ort/')
    expect(urls.modelFileUrl('encoder.int8.onnx')).toBe('https://billora.vercel.app/models/shenava/encoder.int8.onnx')
    expect(urls.candidatesFor('tokens.txt')).toEqual([
      { url: 'https://billora.vercel.app/models/shenava/tokens.txt', source: 'network' },
    ])
  })

  it('مسیر مدلی که از thread اصلی می‌آید (مطلق یا نسبی) درست ترکیب می‌شود', () => {
    const absolute = resolveShenavaWorkerUrls({
      baseHref: WORKER_SCRIPT,
      modelBaseUrl: '/models/shenava/',
    })
    expect(absolute.modelFileUrl('joiner.int8.onnx')).toBe('https://billora.vercel.app/models/shenava/joiner.int8.onnx')

    // مسیر بدون اسلش پایانی هم باید درست ترکیب شود (thread اصلی همیشه اسلش پایانی می‌فرستد).
    const noSlash = resolveShenavaWorkerUrls({ baseHref: WORKER_SCRIPT, modelBaseUrl: '/models/shenava' })
    expect(noSlash.modelFileUrl('joiner.int8.onnx')).toBe('https://billora.vercel.app/models/shenava/joiner.int8.onnx')

    // مسیر کاملاً نسبی، طبق قانون URL، نسبت به محل اسکریپت worker حل می‌شود (نه ریشهٔ سایت).
    const relative = resolveShenavaWorkerUrls({ baseHref: WORKER_SCRIPT, modelBaseUrl: 'models/shenava/' })
    expect(relative.modelFileUrl('joiner.int8.onnx'))
      .toBe('https://billora.vercel.app/assets/models/shenava/joiner.int8.onnx')

    const alreadyAbsolute = resolveShenavaWorkerUrls({
      baseHref: WORKER_SCRIPT,
      modelBaseUrl: 'https://billora.vercel.app/models/shenava/',
    })
    expect(alreadyAbsolute.modelFileUrl('decoder.int8.onnx'))
      .toBe('https://billora.vercel.app/models/shenava/decoder.int8.onnx')
  })

  it('روی GitHub Pages مسیر پروژه حفظ می‌شود', () => {
    const urls = resolveShenavaWorkerUrls({ baseUrl: '/Billora/', baseHref: PAGE_PAGES })
    expect(urls.ortDirectoryUrl).toBe('https://mehdi-6600.github.io/Billora/ort/')
    expect(urls.modelFileUrl('tokens.txt')).toBe('https://mehdi-6600.github.io/Billora/models/shenava/tokens.txt')
  })

  it('فایل محلی اول و کپی Hub دوم می‌آید', () => {
    const urls = resolveShenavaWorkerUrls({
      baseHref: WORKER_SCRIPT,
      remoteModelUrls: { 'tokens.txt': 'https://huggingface.co/Reza2kn/Shenava-Koochik-v1.5-RNNT-sherpa-onnx/resolve/main/tokens.txt' },
    })
    expect(urls.candidatesFor('tokens.txt')).toEqual([
      { url: 'https://billora.vercel.app/models/shenava/tokens.txt', source: 'network' },
      { url: 'https://huggingface.co/Reza2kn/Shenava-Koochik-v1.5-RNNT-sherpa-onnx/resolve/main/tokens.txt', source: 'hub' },
    ])
  })

  it('بدون پایهٔ مطلق، به‌جای آدرس خراب خطا می‌دهد', () => {
    expect(() => resolveShenavaWorkerUrls({ baseHref: null })).toThrow('base URL is unknown')
    expect(() => resolveShenavaWorkerUrls({ baseHref: '/index.html' })).toThrow(/cannot resolve/)
  })

  it('currentBaseHref فقط href غیرخالی را برمی‌گرداند', () => {
    expect(currentBaseHref({ location: { href: PAGE_VERCEL } })).toBe(PAGE_VERCEL)
    expect(currentBaseHref({ location: { href: '' } })).toBeNull()
    expect(currentBaseHref({ location: {} })).toBeNull()
    expect(currentBaseHref({})).toBeNull()
  })
})

describe('تقسیم فایل بزرگ به تکه‌های هم‌مبدأ (سقف حجم میزبان)', () => {
  const encoder = SHENAVA_MODEL_FILES[0]!
  const chunkBytes = 64 * 1024 * 1024
  const manifest = {
    version: 1,
    chunkBytes,
    files: {
      [encoder.name]: {
        bytes: encoder.bytes,
        sha256: encoder.sha256,
        parts: [
          { name: `${encoder.name}.part0`, bytes: chunkBytes, sha256: 'aa' },
          { name: `${encoder.name}.part1`, bytes: encoder.bytes - chunkBytes, sha256: 'bb' },
        ],
      },
    },
  }

  /** Same-origin server: the encoder is missing, but its two chunks are there. */
  function partsFetcher({ partsOk = true, manifestBody = manifest as unknown } = {}) {
    return vi.fn(async (url: string, init?: { method?: string }) => {
      if (url.endsWith(SHENAVA_PARTS_FILE)) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: async () => manifestBody,
        } as never
      }
      const part = manifest.files[encoder.name]!.parts.find((entry) => url.endsWith(entry.name))
      if (part && partsOk) return response({ 'content-length': String(part.bytes) })
      const file = SHENAVA_MODEL_FILES.find((entry) => url.endsWith(entry.name))
      if (file && file.name !== encoder.name) return response({ 'content-length': String(file.bytes) })
      if (part) return response({}, partsOk, 404)
      void init
      return response({}, false, 404)
    })
  }

  it('manifest و تکه‌ها درست تجزیه می‌شوند', () => {
    const parsed = parsePartsManifest(manifest)!
    expect(parsed.files[encoder.name]!.parts).toHaveLength(2)
    expect(partsForFile(parsed, encoder.name, encoder.bytes)).toHaveLength(2)
    // حجم کل تکه‌ها باید با حجم اعلام‌شدهٔ فایل یکی باشد
    expect(partsForFile(parsed, encoder.name, encoder.bytes - 1)).toBeNull()
    expect(partsForFile(parsed, 'decoder.int8.onnx')).toBeNull()
    expect(partsTotalBytes(parsed.files[encoder.name]!.parts)).toBe(encoder.bytes)

    // manifest خراب (بدون files یا با ورودی ناقص) یعنی «تکه‌ای وجود ندارد»، نه خطا
    expect(parsePartsManifest(null)).toBeNull()
    expect(parsePartsManifest({})).toBeNull()
    expect(parsePartsManifest({ files: { x: { bytes: 1, parts: [] } } })).toBeNull()
    expect(parsePartsManifest({ files: { x: { bytes: 1, parts: [{ name: 'x.part0', bytes: 0 }] } } })).toBeNull()
    // تکهٔ متعلق به فایل دیگر پذیرفته نمی‌شود
    expect(partsForFile({ files: { 'a.onnx': { bytes: 4, parts: [{ name: 'b.onnx.part0', bytes: 4 }] } } }, 'a.onnx')).toBeNull()
  })

  it('وقتی انکودر تکه‌تکه سرو می‌شود، موتور در دسترس و منبع local است', async () => {
    stubRuntime(true)
    const fetcher = partsFetcher()
    const detailed = await probeShenavaModelFiles(fetcher, '/', undefined, true)

    expect(detailed.available).toBe(true)
    expect(detailed.source).toBe('local')
    expect(detailed.missing).toEqual([])
    const encoderReport = detailed.files.find((report) => report.name === encoder.name)!
    expect(encoderReport).toMatchObject({ local: 'ok', localBytes: encoder.bytes, parts: 2, remote: 'not-checked' })
    expect(encoderReport.partsUrl).toBe(`/models/shenava/${encoder.name}.part0`)
  })

  it('نبود یک تکه یعنی فایل نصب‌شده نیست (و دیگر به میزبان بیرونی تکیه نمی‌کند)', async () => {
    stubRuntime(true)
    const fetcher = partsFetcher({ partsOk: false })
    const detailed = await probeShenavaModelFiles(fetcher, '/', undefined, true)

    const encoderReport = detailed.files.find((report) => report.name === encoder.name)!
    expect(encoderReport.parts).toBe(2)
    expect(encoderReport.partsState).toBe('absent')
    expect(detailed.available).toBe(false)
    expect(detailed.missing).toEqual([encoder.name])
  })

  it('manifest با جمع ناهمخوان نادیده گرفته می‌شود (تکه‌ها فایل دیگری‌اند)', async () => {
    stubRuntime(true)
    const wrong = JSON.parse(JSON.stringify(manifest)) as typeof manifest
    wrong.files[encoder.name]!.parts[1]!.bytes = encoder.bytes - chunkBytes - 1
    const fetcher = partsFetcher({ manifestBody: wrong })
    const detailed = await probeShenavaModelFiles(fetcher, '/', undefined, true)

    const encoderReport = detailed.files.find((report) => report.name === encoder.name)!
    expect(encoderReport.parts).toBeUndefined()
    expect(encoderReport.local).toBe('absent')
    expect(detailed.available).toBe(false)
  })

  it('نبود manifest (۴۰۴ در SPA یا سرور قدیمی) رفتار قبلی را حفظ می‌کند', async () => {
    stubRuntime(true)
    const fetcher = vi.fn(async (url: string) => {
      if (url.endsWith(SHENAVA_PARTS_FILE)) return response({ 'content-type': 'text/html' }, true, 200) as never
      const file = SHENAVA_MODEL_FILES.find((entry) => url.endsWith(entry.name))
      if (file) return response({ 'content-length': String(file.bytes) })
      return response({}, false, 404)
    })

    const detailed = await probeShenavaModelFiles(fetcher, '/', undefined, true)
    // پاسخ HTML برای manifest یعنی JSON ندارد → null → همهٔ فایل‌ها مثل قبل محلی‌اند
    expect(detailed.available).toBe(true)
    expect(detailed.source).toBe('local')
  })

  it('loadPartsManifest خطای شبکه را بی‌صدا null می‌کند', async () => {
    const failing = vi.fn(async () => {
      throw new Error('offline')
    })
    expect(await loadPartsManifest(failing as never, '/')).toBeNull()

    const loader = vi.fn(async (_url: string) => ({
      ok: true,
      status: 200,
      headers: { get: (): string | null => null },
      json: async () => manifest,
    }))
    const loaded = await loadPartsManifest(loader as never, '/Billora/')
    expect(loader.mock.calls[0]?.[0]).toBe(`/Billora/models/shenava/${SHENAVA_PARTS_FILE}`)
    expect(loaded?.files[encoder.name]?.parts).toHaveLength(2)
  })
})
