import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  SHENAVA_MODEL_FILES,
  probeShenavaModel,
  shenavaModelUrl,
  shenavaRuntimeSupported,
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

  it('بدون Web Worker یا WebAssembly حتی درخواستی فرستاده نمی‌شود', async () => {
    stubRuntime(false)
    const fetcher = vi.fn()
    const result = await probeShenavaModel(fetcher, '/')
    expect(result).toMatchObject({ available: false, reason: 'unsupported' })
    expect(fetcher).not.toHaveBeenCalled()
    expect(shenavaRuntimeSupported()).toBe(false)
  })
})
