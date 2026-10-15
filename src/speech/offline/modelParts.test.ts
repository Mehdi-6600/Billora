import { describe, expect, it, vi } from 'vitest'

import { assembleModelParts } from './modelParts'

/** Minimal stand-in for one chunk response. */
function respond(body: Uint8Array, { ok = true, status = 200 } = {}) {
  return { ok, status, arrayBuffer: async () => body.buffer.slice(0) as ArrayBuffer }
}

describe('assembleModelParts', () => {
  const parts = [
    { name: 'encoder.int8.onnx.part0', bytes: 4 },
    { name: 'encoder.int8.onnx.part1', bytes: 4 },
    { name: 'encoder.int8.onnx.part2', bytes: 2 },
  ]
  const chunks = {
    'encoder.int8.onnx.part0': new Uint8Array([1, 2, 3, 4]),
    'encoder.int8.onnx.part1': new Uint8Array([5, 6, 7, 8]),
    'encoder.int8.onnx.part2': new Uint8Array([9, 10]),
  }

  it('تکه‌ها را به ترتیب به هم می‌چسباند', async () => {
    const fetcher = vi.fn(async (url: string) => respond(chunks[url.split('/').pop() as keyof typeof chunks]))
    const bytes = await assembleModelParts({
      fileName: 'encoder.int8.onnx',
      bytes: 10,
      parts,
      urlFor: (name) => `https://app.example/models/shenava/${name}`,
      fetcher,
    })

    expect(Array.from(bytes)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(fetcher.mock.calls.map(([url]) => url.split('/').pop())).toEqual(parts.map((part) => part.name))
  })

  it('وقتی جمع تکه‌ها با حجم اعلام‌شده یکی نیست، پیش از هر درخواستی خطا می‌دهد', async () => {
    const fetcher = vi.fn()
    await expect(
      assembleModelParts({
        fileName: 'encoder.int8.onnx',
        bytes: 999,
        parts,
        urlFor: (name) => name,
        fetcher,
      }),
    ).rejects.toThrow(/add up to 10 bytes, 999 expected/)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('تکهٔ کوتاه‌تر از فهرست رد می‌شود (دانلود ناقص بی‌صدا وارد مدل نمی‌شود)', async () => {
    const fetcher = vi.fn(async (url: string) =>
      url.endsWith('part1') ? respond(new Uint8Array([5, 6])) : respond(chunks[url.split('/').pop() as keyof typeof chunks]),
    )

    await expect(
      assembleModelParts({
        fileName: 'encoder.int8.onnx',
        bytes: 10,
        parts,
        urlFor: (name) => name,
        fetcher,
      }),
    ).rejects.toThrow(/part1: 2 bytes received, 4 expected/)
  })

  it('پاسخ ناموفق (SPA fallback یا ۴۰۴) خطا می‌دهد', async () => {
    const fetcher = vi.fn(async () => respond(new Uint8Array([60, 104, 116, 109, 108]), { ok: false, status: 404 }))

    await expect(
      assembleModelParts({ fileName: 'encoder.int8.onnx', bytes: 10, parts, urlFor: (name) => name, fetcher }),
    ).rejects.toThrow(/part0: HTTP 404/)
  })

  it('بررسی نهایی (حجم و SHA-256) روی بافر چسبیده‌شده اجرا می‌شود', async () => {
    const verify = vi.fn(async (_bytes: Uint8Array<ArrayBuffer>) => undefined)
    const fetcher = vi.fn(async (url: string) => respond(chunks[url.split('/').pop() as keyof typeof chunks]))

    await assembleModelParts({
      fileName: 'encoder.int8.onnx',
      bytes: 10,
      parts,
      urlFor: (name) => name,
      fetcher,
      verify,
    })

    expect(verify).toHaveBeenCalledTimes(1)
    const passed = verify.mock.calls[0]?.[0]
    expect(passed).toBeDefined()
    expect(Array.from(passed!)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  })

  it('خطای بررسی نهایی به بالا منتقل می‌شود', async () => {
    const fetcher = vi.fn(async (url: string) => respond(chunks[url.split('/').pop() as keyof typeof chunks]))

    await expect(
      assembleModelParts({
        fileName: 'encoder.int8.onnx',
        bytes: 10,
        parts,
        urlFor: (name) => name,
        fetcher,
        verify: async () => {
          throw new Error('encoder.int8.onnx: SHA-256 mismatch (got deadbeef…)')
        },
      }),
    ).rejects.toThrow(/SHA-256 mismatch/)
  })

  it('فهرست خالی تکه‌ها خطا می‌دهد', async () => {
    await expect(
      assembleModelParts({ fileName: 'encoder.int8.onnx', bytes: 0, parts: [], urlFor: (name) => name }),
    ).rejects.toThrow(/no chunks listed/)
  })
})
