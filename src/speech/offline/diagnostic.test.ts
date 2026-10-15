// @vitest-environment jsdom
/**
 * The diagnostic page is what a phone user looks at (Q3 of the verification task), so its two claims
 * — "the model is served from this origin" and "the engine will use it" — must not be taken on
 * faith: the page is rendered here against a fake deployment that serves the encoder as chunks.
 *
 * The module renders itself on import (that is how `test-shenava.html` works), so every test resets
 * the module registry, provides a `#root` element and waits for the probe to finish.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SHENAVA_MODEL_FILES, SHENAVA_PARTS_FILE } from './shenavaModel'

const encoder = SHENAVA_MODEL_FILES[0]!
const CHUNK_BYTES = 64 * 1024 * 1024
const parts = [
  { name: `${encoder.name}.part0`, bytes: CHUNK_BYTES },
  { name: `${encoder.name}.part1`, bytes: encoder.bytes - CHUNK_BYTES },
]

function fakeResponse({ status = 200, headers = {}, body = null }: { status?: number; headers?: Record<string, string>; body?: unknown } = {}) {
  const lower = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]))
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => lower.get(name.toLowerCase()) ?? null },
    json: async () => body,
    arrayBuffer: async () => new ArrayBuffer(0),
  }
}

/** A deployment where the encoder is only available as same-origin chunks. */
function stubSplitFetch() {
  return vi.fn(async (input: string) => {
    const url = String(input)
    if (url.endsWith(SHENAVA_PARTS_FILE)) {
      return fakeResponse({
        headers: { 'content-type': 'application/json' },
        body: { version: 1, chunkBytes: CHUNK_BYTES, files: { [encoder.name]: { bytes: encoder.bytes, parts } } },
      })
    }
    const part = parts.find((entry) => url.endsWith(entry.name))
    if (part) return fakeResponse({ headers: { 'content-length': String(part.bytes) } })
    if (url.includes(encoder.name)) return fakeResponse({ status: 404, headers: { 'content-type': 'text/html' } })
    const file = SHENAVA_MODEL_FILES.find((entry) => url.endsWith(entry.name))
    if (file) return fakeResponse({ headers: { 'content-length': String(file.bytes) } })
    return fakeResponse({ status: 404 })
  })
}

async function renderPage() {
  document.body.innerHTML = '<div id="root"></div>'
  vi.stubGlobal('Worker', class {})
  vi.stubGlobal('WebAssembly', {})
  await import('./diagnostic')
  // The probe is asynchronous: six HEAD-ish requests per file.
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (document.body.textContent?.includes('منبع مدل')) {
      await new Promise((resolve) => setTimeout(resolve, 0))
      if (document.body.textContent?.includes('تکه')) return
    }
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
  document.body.innerHTML = ''
})

beforeEach(() => {
  // `crossOriginIsolated` is read at mount time; the page must not throw without it.
  Object.defineProperty(globalThis, 'crossOriginIsolated', { value: false, configurable: true })
})

describe('صفحهٔ تشخیص گفتار آفلاین', () => {
  it('تکه‌تکه بودن انکودر را نشان می‌دهد و مدل را «موجود» می‌داند', async () => {
    vi.stubGlobal('fetch', stubSplitFetch())
    await renderPage()

    const text = document.body.textContent ?? ''
    expect(text).toContain('موجود بودن مدل')
    expect(text).toContain('کنار خود برنامه')
    // جدول فایل‌ها و ستون تکه‌ها
    expect(text).toContain(`${parts.length} تکه`)
    expect(text).toContain(`${encoder.name}.part0`)
    expect(text).toContain('encoder.int8.onnx: 2 تکه')
    expect(text).toContain('Cross-Origin Isolated')
    expect(text).toContain('شروع ضبط')
  })

  it('وقتی مدل غایب است، نام فایل‌های ناموجود و وضعیت نهایی نمایش داده می‌شود', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => fakeResponse({ status: 404, headers: { 'content-type': 'text/html' } })),
    )
    await renderPage()

    const text = document.body.textContent ?? ''
    expect(text).toContain('ناقص')
    expect(text).toContain('encoder.int8.onnx')
    expect(text).toContain('ناموجود')
  })

  it('انتخاب موتور فعال و دلیل آن را نشان می‌دهد (اندروید → Web Speech، iOS → شنوا)', async () => {
    vi.stubGlobal('fetch', stubSplitFetch())
    await renderPage()

    const text = document.body.textContent ?? ''
    expect(text).toContain('موتور فعال')
    expect(text).toMatch(/شنوا|Web Speech|فقط متن/)
  })
})
