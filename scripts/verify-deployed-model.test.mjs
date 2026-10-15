/**
 * Tests for `scripts/verify-deployed-model.mjs` — the tool that answers "is the model really served
 * by the deployment?". A local HTTP server stands in for the deployed host, including the two
 * failure modes that matter: an SPA fallback answering 200 + HTML for a missing model file, and a
 * host that ignores `HEAD` (then the ranged GET path is used).
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { after, describe, it } from 'node:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  describeRemote,
  formatBytes,
  loadManifest,
  main,
  normalizeBaseUrl,
  parseArgs,
  verifyDeployment,
} from './verify-deployed-model.mjs'

const silent = { log: () => {}, warn: () => {}, error: () => {} }

const FILES = [
  { name: 'encoder.int8.onnx', bytes: 4096 },
  { name: 'decoder.int8.onnx', bytes: 2048 },
  { name: 'joiner.int8.onnx', bytes: 1024 },
  { name: 'tokens.txt', bytes: 512 },
]

const INDEX_HTML = '<!doctype html><html lang="fa" dir="rtl"><body>Billora</body></html>'

/**
 * @param {object} options
 * @param {boolean} [options.modelPresent] serve the model files at all
 * @param {boolean} [options.spaFallback] answer unknown paths with 200 + index.html (like `vite dev`)
 * @param {boolean} [options.ignoreHead] ignore HEAD (force the ranged-GET path)
 * @param {boolean} [options.isolated] send COOP/COEP
 * @param {boolean} [options.diagnosticPage] serve /test-shenava.html
 * @param {Record<string, number>} [options.overrideSizes] serve a wrong size for a file
 * @param {object} [options.splitEncoder] the encoder is not served whole; its chunks are
 *   `{ parts: [{name, bytes}], manifest: boolean, breakPart: string|null }`
 */
function startHost(options = {}) {
  const {
    modelPresent = true,
    spaFallback = false,
    ignoreHead = false,
    isolated = true,
    diagnosticPage = true,
    overrideSizes = {},
    splitEncoder = null,
  } = options

  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost')
    const path = decodeURIComponent(url.pathname)

    const headers = { 'content-type': 'text/html; charset=utf-8' }
    if (isolated) {
      headers['cross-origin-opener-policy'] = 'same-origin'
      headers['cross-origin-embedder-policy'] = 'require-corp'
    }

    if (path === '/' || path === '/index.html') {
      response.writeHead(200, headers).end(INDEX_HTML)
      return
    }
    if (path === '/test-shenava.html') {
      if (!diagnosticPage) {
        response.writeHead(404).end('not found')
        return
      }
      response.writeHead(200, headers).end('<!doctype html><html lang="fa"><body>diag</body></html>')
      return
    }

    if (splitEncoder && path === '/models/shenava/model-parts.json') {
      if (!splitEncoder.manifest) {
        if (spaFallback) response.writeHead(200, headers).end(INDEX_HTML)
        else response.writeHead(404, headers).end('not found')
        return
      }
      const encoder = FILES.find((file) => file.name === 'encoder.int8.onnx')
      const body = Buffer.from(
        JSON.stringify({ version: 1, files: { [encoder.name]: { bytes: encoder.bytes, parts: splitEncoder.parts } } }),
      )
      response
        .writeHead(200, { 'content-type': 'application/json', 'content-length': String(body.length) })
        .end(body)
      return
    }
    if (splitEncoder) {
      const part = splitEncoder.parts.find((entry) => path === `/models/shenava/${entry.name}`)
      if (part) {
        if (part.name === splitEncoder.breakPart) {
          response.writeHead(404, { 'content-type': 'text/plain' }).end('gone')
          return
        }
        response
          .writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(part.bytes) })
          .end(Buffer.alloc(part.bytes, 3))
        return
      }
    }

    const wanted = FILES.find((file) => path === `/models/shenava/${file.name}`)
    if (splitEncoder && wanted?.name === 'encoder.int8.onnx') {
      // Not served whole: that is exactly the case the chunks exist for.
      if (spaFallback) response.writeHead(200, headers).end(INDEX_HTML)
      else response.writeHead(404, headers).end('not found')
      return
    }
    if (wanted) {
      if (!modelPresent) {
        if (spaFallback) response.writeHead(200, headers).end(INDEX_HTML)
        else response.writeHead(404, headers).end('not found')
        return
      }
      const size = overrideSizes[wanted.name] ?? wanted.bytes
      const binary = { 'content-type': 'application/octet-stream', 'content-length': String(size) }
      const wantsRange = request.headers.range?.startsWith('bytes=0-0')
      if (ignoreHead && request.method === 'HEAD') {
        // A host that answers HEAD without content-length (some CDNs do this)
        response.writeHead(200, { 'content-type': binary['content-type'] }).end()
        return
      }
      if (wantsRange) {
        response.writeHead(206, { ...binary, 'content-range': `bytes 0-0/${size}`, 'content-length': '1' }).end('x')
        return
      }
      response.writeHead(200, binary).end(Buffer.alloc(size, 7))
      return
    }

    if (spaFallback) response.writeHead(200, headers).end(INDEX_HTML)
    else response.writeHead(404, headers).end('not found')
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({ baseUrl: `http://127.0.0.1:${port}`, close: () => new Promise((done) => server.close(done)) })
    })
  })
}

/** The CLI reads the app manifest; tests point it at a JSON file with the stand-in sizes. */
let manifestPath = null
async function smallManifest() {
  if (manifestPath) return manifestPath
  const root = await mkdtemp(join(tmpdir(), 'verify-manifest-'))
  manifestPath = join(root, 'manifest.json')
  await writeFile(manifestPath, JSON.stringify({ files: FILES }))
  servers.push({ close: () => rm(root, { recursive: true, force: true }) })
  return manifestPath
}

const servers = []
async function host(options) {
  const created = await startHost(options)
  servers.push(created)
  return created
}
after(async () => {
  for (const created of servers) await created.close()
})

describe('بررسی استقرار — توابع کمکی', () => {
  it('آدرس دامنه را نرمال می‌کند', () => {
    assert.equal(normalizeBaseUrl('app.vercel.app'), 'https://app.vercel.app')
    assert.equal(normalizeBaseUrl('https://app.vercel.app/'), 'https://app.vercel.app')
    assert.throws(() => normalizeBaseUrl(''), /base URL is required/)
  })

  it('گزینه‌ها را می‌فهمد', () => {
    const defaults = parseArgs([])
    assert.deepEqual(parseArgs(['https://a.test', '--json']), {
      baseUrl: 'https://a.test',
      json: true,
      quiet: false,
      manifestPath: null,
      timeoutMs: defaults.timeoutMs,
    })
    assert.throws(() => parseArgs(['--nope']), /unknown argument/)
    assert.throws(() => parseArgs(['a', 'b']), /unexpected argument/)
  })

  it('فهرست فایل‌ها را از خود اپ می‌خواند (بدون واگرایی با موتور)', async () => {
    const files = await loadManifest()
    assert.equal(files.length, 4)
    assert.deepEqual(files[0], { name: 'encoder.int8.onnx', bytes: 131_342_912 })
    assert.equal(files.find((file) => file.name === 'tokens.txt').bytes, 12_236)
  })

  it('حجم را خوانا نشان می‌دهد', () => {
    assert.equal(formatBytes(512), '512 B')
    assert.equal(formatBytes(131_342_912), '125.3 MB')
  })
})

describe('بررسی استقرار — describeRemote', () => {
  it('با HEAD پاسخ می‌دهد و طول را برمی‌گرداند', async () => {
    const server = await host()
    const result = await describeRemote(`${server.baseUrl}/models/shenava/tokens.txt`, { expectedBytes: 512 })
    assert.equal(result.ok, true)
    assert.equal(result.method, 'HEAD')
    assert.equal(result.contentLength, 512)
    assert.equal(result.matches, true)
    assert.match(result.contentType, /octet-stream/)
  })

  it('وقتی میزبان HEAD را نادیده می‌گیرد، از درخواست بازه‌ای استفاده می‌کند', async () => {
    const server = await host({ ignoreHead: true })
    const result = await describeRemote(`${server.baseUrl}/models/shenava/tokens.txt`, { expectedBytes: 512 })
    assert.equal(result.method, 'GET (Range: bytes=0-0)')
    assert.equal(result.contentLength, 512)
    assert.equal(result.matches, true)
  })

  it('فایل ۴۰۴ را ناموجود گزارش می‌کند', async () => {
    const server = await host({ modelPresent: false })
    const result = await describeRemote(`${server.baseUrl}/models/shenava/encoder.int8.onnx`, { expectedBytes: 4096 })
    assert.equal(result.ok, false)
    assert.equal(result.status, 404)
    assert.equal(result.matches, false)
  })
})

describe('بررسی استقرار — verifyDeployment', () => {
  it('وقتی مدل، هدرها و صفحهٔ تشخیص درست سرو شوند، موفق است', async () => {
    const server = await host()
    const results = await verifyDeployment({ baseUrl: server.baseUrl, files: FILES, logger: silent })
    assert.equal(results.ok, true)
    assert.equal(results.failures.length, 0)
    assert.equal(results.files.every((file) => file.passed), true)
    assert.equal(results.page.coop, 'same-origin')
    assert.equal(results.page.coep, 'require-corp')
    assert.equal(results.diagnostic.isHtml, true)
  })

  it('اگر میزبان فایل نبود را با ۲۰۰ و HTML جواب دهد، شکست را تشخیص می‌دهد', async () => {
    // این همان رفتار سرور توسعه و بعضی CDNهاست که در تست قبلی یک باگ واقعی بود.
    const server = await host({ modelPresent: false, spaFallback: true })
    const results = await verifyDeployment({ baseUrl: server.baseUrl, files: FILES, logger: silent })
    assert.equal(results.ok, false)
    assert.equal(results.failures.length, FILES.length + 0)
    assert.match(results.failures[0], /content-type=text\/html/)
  })

  it('اندازهٔ ناهمخوان با فهرست را شکست می‌داند', async () => {
    const server = await host({ overrideSizes: { 'encoder.int8.onnx': 1024 } })
    const results = await verifyDeployment({ baseUrl: server.baseUrl, files: FILES, logger: silent })
    assert.equal(results.ok, false)
    const encoder = results.files.find((file) => file.name === 'encoder.int8.onnx')
    assert.equal(encoder.matches, false)
    assert.equal(encoder.passed, false)
  })

  it('نبودن هدرهای Cross-Origin Isolation را گزارش می‌کند', async () => {
    const server = await host({ isolated: false })
    const results = await verifyDeployment({ baseUrl: server.baseUrl, files: FILES, logger: silent })
    assert.equal(results.ok, false)
    assert.ok(results.failures.some((failure) => failure.includes('COOP/COEP')))
  })

  it('نبودن صفحهٔ تشخیص را گزارش می‌کند', async () => {
    const server = await host({ diagnosticPage: false })
    const results = await verifyDeployment({ baseUrl: server.baseUrl, files: FILES, logger: silent })
    assert.equal(results.ok, false)
    assert.ok(results.failures.some((failure) => failure.includes('test-shenava.html')))
  })

  it('خطای شبکه (دامنهٔ غیرقابل دسترس) باعث خطای کنترل‌نشده نمی‌شود', async () => {
    const results = await verifyDeployment({
      baseUrl: 'http://127.0.0.1:1',
      files: FILES,
      timeoutMs: 2_000,
      logger: silent,
    })
    assert.equal(results.ok, false)
    assert.ok(results.failures.length > 0)
  })
})

describe('بررسی استقرار — خط فرمان', () => {
  it('با دامنهٔ سالم کد خروج ۰ می‌دهد و گزارش می‌دهد', async () => {
    const server = await host()
    const lines = []
    const logger = { log: (line) => lines.push(String(line)), warn: () => {}, error: () => {} }
    const code = await main({ argv: [server.baseUrl, `--manifest=${await smallManifest()}`], logger })
    assert.equal(code, 0)
    assert.ok(lines.some((line) => line.includes('همهٔ بررسی‌ها موفق')))
  })

  it('با دامنهٔ خراب کد خروج ۱ می‌دهد و راه‌حل‌ها را چاپ می‌کند', async () => {
    const lines = []
    const logger = { log: (line) => lines.push(String(line)), warn: () => {}, error: () => {} }
    const code = await main({ argv: [`http://127.0.0.1:1`], logger })
    assert.equal(code, 1)
    assert.ok(lines.some((line) => line.includes('SHENAVA_MODEL_MAX_BUILD_BYTES')))
    assert.ok(lines.some((line) => line.includes('VITE_SHENAVA_MODEL_BASE_URL')))
  })

  it('حالت --json خروجی ماشین‌خوان می‌دهد', async () => {
    const server = await host()
    const lines = []
    const logger = { log: (line) => lines.push(String(line)), warn: () => {}, error: () => {} }
    const code = await main({ argv: [server.baseUrl, '--json', `--manifest=${await smallManifest()}`], logger })
    assert.equal(code, 0)
    const parsed = JSON.parse(lines.at(-1))
    assert.equal(parsed.ok, true)
    assert.equal(parsed.files.length, 4)
  })
})

describe('بررسی استقرار — فایل‌های تقسیم‌شده (سقف حجم میزبان)', () => {
  const parts = [
    { name: 'encoder.int8.onnx.part0', bytes: 3072 },
    { name: 'encoder.int8.onnx.part1', bytes: 1024 },
  ]

  it('فایلی که تکه‌تکه سرو می‌شود، قبول می‌شود و تکه‌ها گزارش می‌شوند', async () => {
    const host1 = await host({ splitEncoder: { parts, manifest: true, breakPart: null } })
    const results = await verifyDeployment({ baseUrl: host1.baseUrl, files: FILES, fetchImpl: fetch, logger: silent })

    assert.equal(results.ok, true, JSON.stringify(results.failures))
    assert.equal(results.parts.present, true)
    const encoder = results.files.find((file) => file.name === 'encoder.int8.onnx')
    assert.equal(encoder.servedAs, 'parts')
    assert.equal(encoder.passed, true)
    assert.equal(encoder.parts.length, 2)
    assert.ok(encoder.parts.every((part) => part.passed))
    // بقیهٔ فایل‌ها مثل قبل تک‌فایل هستند
    assert.equal(results.files.find((file) => file.name === 'tokens.txt').servedAs, 'file')
  })

  it('تکهٔ غایب باعث شکست بررسی می‌شود و نامش در خطا می‌آید', async () => {
    const host1 = await host({
      splitEncoder: { parts, manifest: true, breakPart: 'encoder.int8.onnx.part1' },
    })
    const results = await verifyDeployment({ baseUrl: host1.baseUrl, files: FILES, fetchImpl: fetch, logger: silent })

    assert.equal(results.ok, false)
    const encoder = results.files.find((file) => file.name === 'encoder.int8.onnx')
    assert.equal(encoder.servedAs, 'missing')
    assert.equal(encoder.parts.find((part) => part.name === 'encoder.int8.onnx.part1').passed, false)
    assert.match(results.failures.join('\n'), /encoder\.int8\.onnx\.part1/)
  })

  it('مانیفستی که جمع تکه‌هایش با حجم فایل یکی نیست، رد می‌شود', async () => {
    const host1 = await host({
      splitEncoder: { parts: [{ name: 'encoder.int8.onnx.part0', bytes: 100 }], manifest: true, breakPart: null },
    })
    const results = await verifyDeployment({ baseUrl: host1.baseUrl, files: FILES, fetchImpl: fetch, logger: silent })

    assert.equal(results.ok, false)
    const encoder = results.files.find((file) => file.name === 'encoder.int8.onnx')
    assert.equal(encoder.parts[0].passed, false)
    assert.match(encoder.parts[0].name, /manifest sums to 100 bytes, 4096 expected/)
  })

  it('نبود مانیفست یعنی build قدیمی است (بدون تکه) و خطایی نیست', async () => {
    const host1 = await host({ splitEncoder: { parts, manifest: false, breakPart: null } })
    const results = await verifyDeployment({ baseUrl: host1.baseUrl, files: FILES, fetchImpl: fetch, logger: silent })

    assert.equal(results.parts.present, false)
    // انکودر سرو نمی‌شود و تکه‌ای هم اعلام نشده → بررسی مثل قبل شکست می‌خورد
    assert.equal(results.ok, false)
    assert.equal(results.files.find((file) => file.name === 'decoder.int8.onnx').passed, true)
  })

  it('پاسخ HTML برای مانیفست (SPA fallback) نادیده گرفته می‌شود', async () => {
    const host1 = await host({ modelPresent: false, spaFallback: true })
    const results = await verifyDeployment({ baseUrl: host1.baseUrl, files: FILES, fetchImpl: fetch, logger: silent })

    assert.equal(results.parts.present, false)
    assert.equal(results.ok, false)
  })
})
