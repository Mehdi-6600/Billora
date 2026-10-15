/**
 * Tests for the model installer used by `npm run build` (Vercel) and `npm run model:download`.
 *
 * Run with: `node --test scripts/download-shenava-model.test.mjs` (also part of `npm test`).
 * No network access to Hugging Face is needed: a local HTTP server serves tiny stand-in files that
 * have the same shape (size + SHA-256 verified) as the real model.
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import {
  DEFAULT_CACHE_DIR,
  DEFAULT_TARGET_DIR,
  MODEL_PARTS_FILE,
  buildPartsManifest,
  describeLocalFile,
  endpointsFromEnv,
  mirrorFileUrl,
  mirrorsFromEnv,
  formatBytes,
  main,
  modelFileUrl,
  parseArgs,
  planParts,
  readPartsManifest,
  resolveConfiguration,
  runDownload,
} from './download-shenava-model.mjs'

const silentLogger = { log: () => {}, warn: () => {}, error: () => {} }
const collectLogger = () => {
  const lines = []
  return { lines, log: (line) => lines.push(String(line)), warn: (line) => lines.push(String(line)), error: (line) => lines.push(String(line)) }
}

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex')

/** A tiny stand-in for the real model: same manifest shape, ~1 KB per file. */
async function makeFixture({ files = 3, size = 1024 } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'shenava-test-'))
  const manifest = []
  const payloads = new Map()
  for (let index = 0; index < files; index += 1) {
    const name = `file-${index}.int8.onnx`
    const body = Buffer.alloc(size, index + 1)
    payloads.set(name, body)
    manifest.push({ name, bytes: body.length, sha256: sha256(body) })
  }
  const manifestPath = join(root, 'manifest.json')
  await writeFile(manifestPath, JSON.stringify({ files: manifest }), 'utf8')
  return { root, manifestPath, manifest, payloads }
}

/** Local stand-in for `huggingface.co/<repo>/resolve/<rev>/<file>`. */
function startServer(payloads, { failures = {} } = {}) {
  const state = { requests: [], failNext: new Map(Object.entries(failures)) }
  const server = createServer((request, response) => {
    const name = decodeURIComponent(request.url.split('/').pop())
    state.requests.push(name)
    const pendingFailures = state.failNext.get(name) ?? 0
    if (pendingFailures > 0) {
      state.failNext.set(name, pendingFailures - 1)
      response.writeHead(503).end('try again')
      return
    }
    const body = payloads.get(name)
    if (!body) {
      response.writeHead(404).end('not found')
      return
    }
    response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(body.length) })
    response.end(body)
  })
  return new Promise((resolvePromise) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolvePromise({
        endpoint: `http://127.0.0.1:${port}`,
        state,
        requestsOf: (name) => state.requests.filter((entry) => entry === name).length,
        close: () => new Promise((done) => server.close(done)),
      })
    })
  })
}

const cleanups = []
after(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
})

describe('نصب‌کنندهٔ مدل شنوا — توابع کمکی', () => {
  it('آدرس فایل را از مخزن و میزبان می‌سازد', () => {
    assert.equal(
      modelFileUrl('encoder.int8.onnx'),
      'https://huggingface.co/Reza2kn/Shenava-Koochik-v1.5-RNNT-sherpa-onnx/resolve/main/encoder.int8.onnx',
    )
    assert.equal(
      modelFileUrl('tokens.txt', { endpoint: 'https://hf-mirror.com/', revision: 'abc123' }),
      'https://hf-mirror.com/Reza2kn/Shenava-Koochik-v1.5-RNNT-sherpa-onnx/resolve/abc123/tokens.txt',
    )
  })

  it('حجم فایل را خوانا نشان می‌دهد', () => {
    assert.equal(formatBytes(512), '512 B')
    assert.equal(formatBytes(2048), '2.0 KB')
    assert.equal(formatBytes(131_342_912), '125.3 MB')
    assert.equal(formatBytes(Number.NaN), '?')
  })

  it('گزینه‌های خط فرمان را می‌فهمد', () => {
    const { flags, options } = parseArgs(['--check', '--strict', '--dir=/tmp/x', '--endpoint=https://a.test'])
    assert.deepEqual(flags, { check: true, force: false, strict: true, quiet: false })
    assert.equal(options.dir, '/tmp/x')
    assert.deepEqual(options.endpoints, ['https://a.test'])
    assert.throws(() => parseArgs(['--nope']), /unknown argument/)
  })

  it('آدرس mirror با ساختار flat ساخته می‌شود', () => {
    assert.equal(
      mirrorFileUrl('encoder.int8.onnx', 'https://github.com/o/r/releases/download/shenava-model-v1.5-int8/'),
      'https://github.com/o/r/releases/download/shenava-model-v1.5-int8/encoder.int8.onnx',
    )
    assert.deepEqual(mirrorsFromEnv({}), [])
    assert.deepEqual(mirrorsFromEnv({ SHENAVA_MODEL_MIRROR: 'https://a.test/x/, https://b.test/y' }), [
      'https://a.test/x',
      'https://b.test/y',
    ])
  })

  it('میزبان‌ها را از HF_ENDPOINT می‌خواند', () => {
    assert.deepEqual(endpointsFromEnv({}), ['https://huggingface.co'])
    assert.deepEqual(endpointsFromEnv({ HF_ENDPOINT: 'https://hf-mirror.com/, https://second.test' }), [
      'https://hf-mirror.com',
      'https://second.test',
    ])
  })

  it('پیکربندی پیش‌فرض و غیرفعال‌سازی را درست می‌سازد', () => {
    const defaults = resolveConfiguration({ argv: [], env: {}, cwd: '/repo' })
    assert.equal(defaults.targetDir, `/repo/${DEFAULT_TARGET_DIR}`)
    assert.equal(defaults.cacheDir, `/repo/${DEFAULT_CACHE_DIR}`)
    assert.equal(defaults.disabled, false)

    const custom = resolveConfiguration({
      argv: [],
      env: { SHENAVA_MODEL_DIR: 'out/models', SHENAVA_MODEL_CACHE_DIR: '/tmp/cache', SHENAVA_MODEL_DOWNLOAD: '0' },
      cwd: '/repo',
    })
    assert.equal(custom.targetDir, '/repo/out/models')
    assert.equal(custom.cacheDir, '/tmp/cache')
    assert.equal(custom.disabled, true)
  })

  it('ساخت GitHub Pages مدل را دانلود نمی‌کند، مگر با اجبار', () => {
    assert.equal(resolveConfiguration({ argv: [], env: { GITHUB_PAGES: 'true' }, cwd: '/repo' }).skippedForPages, true)
    assert.equal(
      resolveConfiguration({ argv: [], env: { GITHUB_PAGES: 'true', SHENAVA_MODEL_DOWNLOAD: '1' }, cwd: '/repo' })
        .skippedForPages,
      false,
    )
  })

  it('وضعیت فایل محلی را با حجم و هش تشخیص می‌دهد', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shenava-status-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const spec = { name: 'encoder.int8.onnx', bytes: 10, sha256: sha256(Buffer.alloc(10, 7)) }

    assert.equal((await describeLocalFile(join(root, 'missing'), spec)).status, 'missing')

    await writeFile(join(root, 'short'), Buffer.alloc(4))
    assert.equal((await describeLocalFile(join(root, 'short'), spec)).status, 'incomplete')

    await writeFile(join(root, 'wrong'), Buffer.alloc(10, 9))
    assert.equal((await describeLocalFile(join(root, 'wrong'), spec)).status, 'corrupt')

    await writeFile(join(root, 'good'), Buffer.alloc(10, 7))
    assert.equal((await describeLocalFile(join(root, 'good'), spec)).status, 'ok')

    // فایل بدون هش منتشرشده (tokens.txt) فقط با حجم بررسی می‌شود
    await writeFile(join(root, 'noh'), Buffer.alloc(10, 1))
    assert.equal(
      (await describeLocalFile(join(root, 'noh'), { name: 'tokens.txt', bytes: 10, sha256: null })).status,
      'ok',
    )
  })
})

describe('نصب‌کنندهٔ مدل شنوا — دانلود و کش', () => {
  it('همهٔ فایل‌ها را دانلود و با SHA-256 تأیید می‌کند', async () => {
    const fixture = await makeFixture({ files: 3 })
    const server = await startServer(fixture.payloads)
    cleanups.push(() => server.close(), () => rm(fixture.root, { recursive: true, force: true }))
    const targetDir = join(fixture.root, 'public/models/shenava')

    const summary = await runDownload({
      targetDir,
      files: fixture.manifest,
      endpoints: [server.endpoint],
      logger: silentLogger,
      sleep: async () => {},
    })

    assert.equal(summary.downloaded, 3)
    assert.equal(summary.failed, 0)
    assert.equal(summary.bytes, 3 * 1024)
    for (const file of fixture.manifest) {
      const written = await readFile(join(targetDir, file.name))
      assert.equal(written.length, file.bytes)
      assert.equal(sha256(written), file.sha256)
    }
  })

  it('در اجرای بعدی چیزی دوباره دانلود نمی‌کند (idempotent)', async () => {
    const fixture = await makeFixture({ files: 2 })
    const server = await startServer(fixture.payloads)
    cleanups.push(() => server.close(), () => rm(fixture.root, { recursive: true, force: true }))
    const targetDir = join(fixture.root, 'public/models/shenava')

    await runDownload({
      targetDir,
      files: fixture.manifest,
      endpoints: [server.endpoint],
      logger: silentLogger,
      sleep: async () => {},
    })
    const requestsAfterFirstRun = server.state.requests.length

    const second = await runDownload({
      targetDir,
      files: fixture.manifest,
      endpoints: [server.endpoint],
      logger: silentLogger,
      sleep: async () => {},
    })

    assert.equal(second.skipped, 2)
    assert.equal(second.downloaded, 0)
    assert.equal(server.state.requests.length, requestsAfterFirstRun)
  })

  it('فایل ناقص را دوباره کامل دانلود می‌کند', async () => {
    const fixture = await makeFixture({ files: 1 })
    const server = await startServer(fixture.payloads)
    cleanups.push(() => server.close(), () => rm(fixture.root, { recursive: true, force: true }))
    const targetDir = join(fixture.root, 'public/models/shenava')
    await mkdir(targetDir, { recursive: true })
    const [spec] = fixture.manifest
    await writeFile(join(targetDir, spec.name), Buffer.alloc(64, 1))

    const summary = await runDownload({
      targetDir,
      files: fixture.manifest,
      endpoints: [server.endpoint],
      logger: silentLogger,
      sleep: async () => {},
    })

    assert.equal(summary.downloaded, 1)
    assert.equal((await stat(join(targetDir, spec.name))).size, spec.bytes)
  })

  it('فایل خراب (هش ناهمخوان) را کنار می‌گذارد و از نو می‌گیرد', async () => {
    const fixture = await makeFixture({ files: 1 })
    const server = await startServer(fixture.payloads)
    cleanups.push(() => server.close(), () => rm(fixture.root, { recursive: true, force: true }))
    const targetDir = join(fixture.root, 'public/models/shenava')
    await mkdir(targetDir, { recursive: true })
    const [spec] = fixture.manifest
    await writeFile(join(targetDir, spec.name), Buffer.alloc(spec.bytes, 42))

    const summary = await runDownload({
      targetDir,
      files: fixture.manifest,
      endpoints: [server.endpoint],
      logger: silentLogger,
      sleep: async () => {},
    })

    assert.equal(summary.downloaded, 1)
    assert.equal(sha256(await readFile(join(targetDir, spec.name))), spec.sha256)
  })

  it('از کش build بدون درخواست شبکه استفاده می‌کند', async () => {
    const fixture = await makeFixture({ files: 2 })
    const server = await startServer(fixture.payloads)
    cleanups.push(() => server.close(), () => rm(fixture.root, { recursive: true, force: true }))
    const targetDir = join(fixture.root, 'public/models/shenava')
    const cacheDir = join(fixture.root, '.cache/shenava-model')
    await mkdir(cacheDir, { recursive: true })
    for (const spec of fixture.manifest) {
      await writeFile(join(cacheDir, spec.name), fixture.payloads.get(spec.name))
    }

    const summary = await runDownload({
      targetDir,
      cacheDir,
      files: fixture.manifest,
      endpoints: [server.endpoint],
      logger: silentLogger,
      sleep: async () => {},
    })

    assert.equal(summary.copied, 2)
    assert.equal(summary.downloaded, 0)
    assert.equal(server.state.requests.length, 0)
    for (const spec of fixture.manifest) {
      assert.equal(sha256(await readFile(join(targetDir, spec.name))), spec.sha256)
    }
  })

  it('دانلود موفق را در کش ذخیره می‌کند تا build بعدی سریع شود', async () => {
    const fixture = await makeFixture({ files: 1 })
    const server = await startServer(fixture.payloads)
    cleanups.push(() => server.close(), () => rm(fixture.root, { recursive: true, force: true }))
    const targetDir = join(fixture.root, 'public/models/shenava')
    const cacheDir = join(fixture.root, '.cache/shenava-model')

    await runDownload({
      targetDir,
      cacheDir,
      files: fixture.manifest,
      endpoints: [server.endpoint],
      logger: silentLogger,
      sleep: async () => {},
    })

    const cached = await readFile(join(cacheDir, fixture.manifest[0].name))
    assert.equal(sha256(cached), fixture.manifest[0].sha256)
  })

  it('خطای موقت سرور را دوباره تلاش می‌کند', async () => {
    const fixture = await makeFixture({ files: 1 })
    const name = fixture.manifest[0].name
    const server = await startServer(fixture.payloads, { failures: { [name]: 2 } })
    cleanups.push(() => server.close(), () => rm(fixture.root, { recursive: true, force: true }))

    const summary = await runDownload({
      targetDir: join(fixture.root, 'out'),
      files: fixture.manifest,
      endpoints: [server.endpoint],
      logger: silentLogger,
      sleep: async () => {},
    })

    assert.equal(summary.downloaded, 1)
    assert.equal(summary.failed, 0)
    assert.equal(server.requestsOf(name), 3)
  })

  it('اگر میزبان اول کار نکند، میزبان دوم را امتحان می‌کند', async () => {
    const fixture = await makeFixture({ files: 1 })
    const working = await startServer(fixture.payloads)
    const dead = await startServer(new Map())
    cleanups.push(() => working.close(), () => dead.close(), () => rm(fixture.root, { recursive: true, force: true }))

    const summary = await runDownload({
      targetDir: join(fixture.root, 'out'),
      files: fixture.manifest,
      endpoints: [dead.endpoint, working.endpoint],
      logger: silentLogger,
      sleep: async () => {},
      attempts: 1,
    })

    assert.equal(summary.downloaded, 1)
    assert.equal(dead.state.requests.length, 1)
    assert.equal(working.state.requests.length, 1)
  })

  it('وقتی میزبان‌های Hugging Face کار نکنند، از mirror دانلود می‌کند', async () => {
    const fixture = await makeFixture({ files: 2 })
    const mirror = await startServer(fixture.payloads)
    const dead = await startServer(new Map())
    cleanups.push(
      () => mirror.close(),
      () => dead.close(),
      () => rm(fixture.root, { recursive: true, force: true }),
    )
    const logger = collectLogger()

    const summary = await runDownload({
      targetDir: join(fixture.root, 'out'),
      files: fixture.manifest,
      endpoints: [dead.endpoint],
      mirrors: [mirror.endpoint],
      logger,
      sleep: async () => {},
      attempts: 1,
    })

    assert.equal(summary.downloaded, 2)
    assert.equal(summary.failed, 0)
    assert.ok(summary.report.every((entry) => entry.source === 'mirror'))
    assert.ok(summary.report.every((entry) => entry.endpoint === mirror.endpoint))
    for (const spec of fixture.manifest) {
      assert.equal(sha256(await readFile(join(fixture.root, 'out', spec.name))), spec.sha256)
    }
  })

  it('mirror خراب (هش ناهمخوان) پذیرفته نمی‌شود', async () => {
    const fixture = await makeFixture({ files: 1 })
    const [spec] = fixture.manifest
    // همان نام فایل، محتوای غلط: باید رد شود و build از آن استفاده نکند
    const badMirror = await startServer(new Map([[spec.name, Buffer.alloc(spec.bytes, 99)]]))
    cleanups.push(() => badMirror.close(), () => rm(fixture.root, { recursive: true, force: true }))

    const summary = await runDownload({
      targetDir: join(fixture.root, 'out'),
      files: fixture.manifest,
      endpoints: [],
      mirrors: [badMirror.endpoint],
      logger: silentLogger,
      sleep: async () => {},
      attempts: 1,
    })

    assert.equal(summary.failed, 1)
    assert.equal(summary.downloaded, 0)
    assert.match(summary.errors[0], /SHA-256 mismatch/)
  })

  it('شکست کامل دانلود، استثنا نمی‌دهد و فایل نیمه‌کاره باقی نمی‌گذارد', async () => {
    const fixture = await makeFixture({ files: 2 })
    const dead = await startServer(new Map())
    cleanups.push(() => dead.close(), () => rm(fixture.root, { recursive: true, force: true }))
    const targetDir = join(fixture.root, 'out')
    const logger = collectLogger()

    const summary = await runDownload({
      targetDir,
      files: fixture.manifest,
      endpoints: [dead.endpoint],
      logger,
      sleep: async () => {},
      attempts: 2,
    })

    assert.equal(summary.failed, 2)
    assert.equal(summary.downloaded, 0)
    assert.equal(summary.errors.length, 2)
    assert.match(summary.errors[0], /HTTP 404/)
    assert.deepEqual(await readdir(targetDir), [])
    assert.ok(logger.lines.some((line) => line.startsWith('FAIL')))
  })
})

describe('نصب‌کنندهٔ مدل شنوا — خط فرمان (npm run build)', () => {
  it('با --check در نبود مدل، کد خروج ۱ می‌دهد', async () => {
    const fixture = await makeFixture({ files: 1 })
    cleanups.push(() => rm(fixture.root, { recursive: true, force: true }))
    const code = await main({
      argv: ['--check'],
      env: {
        SHENAVA_MODEL_DIR: join(fixture.root, 'empty'),
        SHENAVA_MODEL_MANIFEST: fixture.manifestPath,
        HF_ENDPOINT: 'http://127.0.0.1:1',
      },
      logger: silentLogger,
    })
    assert.equal(code, 1)
  })

  it('با --check در حضور فایل‌های سالم، کد خروج ۰ می‌دهد و به شبکه دست نمی‌زند', async () => {
    const fixture = await makeFixture({ files: 2 })
    const targetDir = join(fixture.root, 'installed')
    await mkdir(targetDir, { recursive: true })
    for (const spec of fixture.manifest) {
      await writeFile(join(targetDir, spec.name), fixture.payloads.get(spec.name))
    }
    cleanups.push(() => rm(fixture.root, { recursive: true, force: true }))

    const code = await main({
      argv: ['--check'],
      env: { SHENAVA_MODEL_DIR: targetDir, SHENAVA_MODEL_MANIFEST: fixture.manifestPath, HF_ENDPOINT: 'http://127.0.0.1:1' },
      logger: silentLogger,
    })
    assert.equal(code, 0)
  })

  it('شکست دانلود بدون --strict باعث شکست build نمی‌شود', async () => {
    const fixture = await makeFixture({ files: 1 })
    cleanups.push(() => rm(fixture.root, { recursive: true, force: true }))
    const logger = collectLogger()

    const code = await main({
      argv: [],
      env: {
        SHENAVA_MODEL_DIR: join(fixture.root, 'missing-model'),
        SHENAVA_MODEL_CACHE_DIR: join(fixture.root, 'cache'),
        SHENAVA_MODEL_MANIFEST: fixture.manifestPath,
        HF_ENDPOINT: 'http://127.0.0.1:1',
      },
      logger,
    })

    assert.equal(code, 0, 'build باید ادامه پیدا کند')
    assert.ok(logger.lines.some((line) => line.includes('موتور گفتار آفلاین غیرفعال می‌ماند')))
  })

  it('شکست دانلود با --strict کد خروج ۱ می‌دهد', async () => {
    const fixture = await makeFixture({ files: 1 })
    cleanups.push(() => rm(fixture.root, { recursive: true, force: true }))
    const code = await main({
      argv: ['--strict'],
      env: {
        SHENAVA_MODEL_DIR: join(fixture.root, 'missing-model'),
        SHENAVA_MODEL_CACHE_DIR: join(fixture.root, 'cache'),
        SHENAVA_MODEL_MANIFEST: fixture.manifestPath,
        HF_ENDPOINT: 'http://127.0.0.1:1',
      },
      logger: silentLogger,
    })
    assert.equal(code, 1)
  })

  it('SHENAVA_MODEL_DOWNLOAD=0 کار را کاملاً متوقف می‌کند', async () => {
    const logger = collectLogger()
    const code = await main({
      argv: [],
      env: { SHENAVA_MODEL_DOWNLOAD: '0', SHENAVA_MODEL_DIR: join(tmpdir(), 'never-used') },
      logger,
    })
    assert.equal(code, 0)
    assert.ok(logger.lines.some((line) => line.includes('غیرفعال')))
  })

  it('ساخت GitHub Pages بدون دانلود رد می‌شود', async () => {
    const logger = collectLogger()
    const code = await main({ argv: [], env: { GITHUB_PAGES: 'true' }, logger })
    assert.equal(code, 0)
    assert.ok(logger.lines.some((line) => line.includes('GitHub Pages')))
  })

  it('گزارش JSON با حجم، زمان و SHA-256 هر فایل می‌نویسد', async () => {
    const fixture = await makeFixture({ files: 2 })
    const server = await startServer(fixture.payloads)
    cleanups.push(() => server.close(), () => rm(fixture.root, { recursive: true, force: true }))
    const reportPath = join(fixture.root, 'report.json')

    const code = await main({
      argv: [`--report=${reportPath}`],
      env: {
        SHENAVA_MODEL_DIR: join(fixture.root, 'installed'),
        SHENAVA_MODEL_CACHE_DIR: join(fixture.root, 'cache'),
        SHENAVA_MODEL_MANIFEST: fixture.manifestPath,
        HF_ENDPOINT: server.endpoint,
      },
      logger: silentLogger,
    })

    assert.equal(code, 0)
    const report = JSON.parse(await readFile(reportPath, 'utf8'))
    assert.equal(report.files.length, 2)
    assert.equal(report.counts.downloaded, 2)
    assert.equal(report.endpoints[0], server.endpoint)
    for (const file of report.files) {
      assert.equal(file.status, 'downloaded')
      assert.equal(file.bytes, 1024)
      assert.equal(typeof file.ms, 'number')
      assert.match(file.sha256, /^[0-9a-f]{64}$/)
      assert.equal(file.endpoint, server.endpoint)
    }
    assert.deepEqual(report.errors, [])
  })

  it('گزارش، فایل‌های از قبل موجود را با زمان صفر ثبت می‌کند', async () => {
    const fixture = await makeFixture({ files: 1 })
    const targetDir = join(fixture.root, 'installed')
    await mkdir(targetDir, { recursive: true })
    await writeFile(join(targetDir, fixture.manifest[0].name), fixture.payloads.get(fixture.manifest[0].name))
    cleanups.push(() => rm(fixture.root, { recursive: true, force: true }))
    const reportPath = join(fixture.root, 'report.json')

    await main({
      argv: [`--report=${reportPath}`],
      env: {
        SHENAVA_MODEL_DIR: targetDir,
        SHENAVA_MODEL_MANIFEST: fixture.manifestPath,
        HF_ENDPOINT: 'http://127.0.0.1:1',
      },
      logger: silentLogger,
    })

    const report = JSON.parse(await readFile(reportPath, 'utf8'))
    assert.equal(report.counts.skipped, 1)
    assert.equal(report.files[0].status, 'skipped')
    assert.equal(report.files[0].ms, 0)
  })

  it('از یک سرور محلی (شبیه‌ساز میزبان) کامل نصب می‌کند', async () => {
    const fixture = await makeFixture({ files: 2 })
    const server = await startServer(fixture.payloads)
    cleanups.push(() => server.close(), () => rm(fixture.root, { recursive: true, force: true }))
    const targetDir = join(fixture.root, 'installed')
    const logger = collectLogger()

    const code = await main({
      argv: [],
      env: {
        SHENAVA_MODEL_DIR: targetDir,
        SHENAVA_MODEL_CACHE_DIR: join(fixture.root, 'cache'),
        SHENAVA_MODEL_MANIFEST: fixture.manifestPath,
        HF_ENDPOINT: server.endpoint,
      },
      logger,
    })

    assert.equal(code, 0)
    assert.ok(logger.lines.some((line) => line.startsWith('خلاصه: 2 دانلود')))
    for (const spec of fixture.manifest) {
      assert.equal(sha256(await readFile(join(targetDir, spec.name))), spec.sha256)
    }
  })
})

describe('نصب‌کنندهٔ مدل شنوا — سازگاری با برنامه', () => {
  it('حجم و SHA-256 همان‌هایی است که سمت مرورگر بررسی می‌شود', async () => {
    const scriptManifest = await import('./download-shenava-model.mjs')
    const appSource = await readFile(new URL('../src/speech/offline/shenavaModel.ts', import.meta.url), 'utf8')
    for (const file of scriptManifest.MODEL_FILES) {
      assert.ok(appSource.includes(file.name), `${file.name} در shenavaModel.ts نیست`)
      assert.ok(
        appSource.includes(String(file.bytes).replace(/\B(?=(\d{3})+(?!\d))/g, '_')),
        `حجم ${file.name} با اپ هم‌خوان نیست`,
      )
      if (file.sha256) assert.ok(appSource.includes(file.sha256), `هش ${file.name} با اپ هم‌خوان نیست`)
    }
  })
})

describe('نصب‌کنندهٔ مدل شنوا — تقسیم فایل بزرگ (سقف میزبان)', () => {
  const joined = (buffers) => Buffer.concat(buffers)

  it('تکه‌ها قطعی و پشت‌سرهم ساخته می‌شوند', () => {
    const parts = planParts('encoder.int8.onnx', 131_342_912, 64 * 1024 * 1024)
    assert.deepEqual(
      parts.map((part) => [part.name, part.bytes, part.offset]),
      [
        ['encoder.int8.onnx.part0', 67_108_864, 0],
        ['encoder.int8.onnx.part1', 64_234_048, 67_108_864],
      ],
    )
    // تکهٔ آخر کوچک‌تر است و جمع همه برابر حجم کل
    assert.equal(parts.reduce((sum, part) => sum + part.bytes, 0), 131_342_912)
    assert.deepEqual(planParts('x.onnx', 5, 100).map((part) => part.bytes), [5])
    assert.throws(() => planParts('x.onnx', 0), /invalid size/)
  })

  it('فایل بالای سقف به تکه‌های هم‌مبدأ تقسیم می‌شود و فایل کامل کنار برنامه نمی‌ماند', async () => {
    const fixture = await makeFixture({ files: 1, size: 10 })
    const server = await startServer(fixture.payloads)
    cleanups.push(
      () => server.close(),
      () => rm(fixture.root, { recursive: true, force: true }),
    )
    const targetDir = join(fixture.root, 'out')
    const [spec] = fixture.manifest

    const summary = await runDownload({
      targetDir,
      files: fixture.manifest,
      endpoints: [server.endpoint],
      maxBytes: 4,
      chunkBytes: 4,
      logger: silentLogger,
      sleep: async () => {},
      attempts: 1,
    })

    assert.equal(summary.split, 1)
    assert.equal(summary.failed, 0)
    assert.equal(summary.excluded, 0)
    assert.equal(summary.report[0].status, 'split')
    assert.equal(summary.report[0].parts, 3)

    const entries = await readdir(targetDir)
    assert.deepEqual(entries.sort(), [`${spec.name}.part0`, `${spec.name}.part1`, `${spec.name}.part2`, MODEL_PARTS_FILE])
    // فایل کامل نباید کنار برنامه باشد، وگرنه استقرار به سقف میزبان می‌خورد
    await assert.rejects(() => stat(join(targetDir, spec.name)), /ENOENT/)

    const manifest = await readPartsManifest(targetDir)
    assert.equal(manifest.version, 1)
    assert.equal(manifest.chunkBytes, 4)
    const entry = manifest.files[spec.name]
    assert.equal(entry.bytes, spec.bytes)
    assert.equal(entry.sha256, spec.sha256)
    assert.deepEqual(entry.parts.map((part) => part.bytes), [4, 4, 2])

    // چسباندن تکه‌ها باید بایت‌به‌بایت همان فایل اصلی باشد
    const buffers = []
    for (const part of entry.parts) {
      const bytes = await readFile(join(targetDir, part.name))
      assert.equal(sha256(bytes), part.sha256)
      buffers.push(bytes)
    }
    assert.equal(sha256(joined(buffers)), spec.sha256)
  })

  it('--check تکه‌ها را بدون شبکه بررسی می‌کند و تکهٔ غایب را خطا می‌داند', async () => {
    const fixture = await makeFixture({ files: 1, size: 9 })
    const server = await startServer(fixture.payloads)
    cleanups.push(
      () => server.close(),
      () => rm(fixture.root, { recursive: true, force: true }),
    )
    const targetDir = join(fixture.root, 'out')
    const options = {
      targetDir,
      files: fixture.manifest,
      endpoints: [server.endpoint],
      maxBytes: 3,
      chunkBytes: 3,
      logger: silentLogger,
      sleep: async () => {},
      attempts: 1,
    }
    await runDownload(options)

    const checked = await runDownload({ ...options, check: true, endpoints: ['http://127.0.0.1:1'] })
    assert.equal(checked.failed, 0)
    assert.equal(checked.split, 1)
    assert.equal(checked.report[0].status, 'split')

    const [spec] = fixture.manifest
    await rm(join(targetDir, `${spec.name}.part1`))
    const broken = await runDownload({ ...options, check: true, endpoints: ['http://127.0.0.1:1'] })
    assert.equal(broken.failed, 1)
    assert.match(broken.errors[0], /تکه‌های ناقص/)
  })

  it('با SHENAVA_MODEL_SPLIT=0 رفتار قبلی برمی‌گردد و manifest قدیمی پاک می‌شود', async () => {
    const fixture = await makeFixture({ files: 1, size: 8 })
    const server = await startServer(fixture.payloads)
    cleanups.push(
      () => server.close(),
      () => rm(fixture.root, { recursive: true, force: true }),
    )
    const targetDir = join(fixture.root, 'out')
    const options = {
      targetDir,
      files: fixture.manifest,
      endpoints: [server.endpoint],
      maxBytes: 2,
      chunkBytes: 2,
      logger: silentLogger,
      sleep: async () => {},
      attempts: 1,
    }
    await runDownload(options)
    assert.ok(await readPartsManifest(targetDir))

    const excluded = await runDownload({ ...options, split: false })
    assert.equal(excluded.excluded, 1)
    assert.equal(excluded.split, 0)
    assert.equal(await readPartsManifest(targetDir), null)
    const entries = await readdir(targetDir)
    assert.deepEqual(entries.filter((name) => name.includes('.part')), [])
  })

  it('وقتی فایلی تقسیم نمی‌شود، manifest تازه نوشته نمی‌شود', async () => {
    const fixture = await makeFixture({ files: 1, size: 6 })
    const server = await startServer(fixture.payloads)
    cleanups.push(
      () => server.close(),
      () => rm(fixture.root, { recursive: true, force: true }),
    )
    const targetDir = join(fixture.root, 'out')
    const summary = await runDownload({
      targetDir,
      files: fixture.manifest,
      endpoints: [server.endpoint],
      maxBytes: 1024,
      logger: silentLogger,
      sleep: async () => {},
      attempts: 1,
    })
    assert.equal(summary.split, 0)
    assert.equal(summary.downloaded, 1)
    assert.equal(summary.partsManifest, undefined)
    assert.equal(await readPartsManifest(targetDir), null)
    const [spec] = fixture.manifest
    assert.equal((await stat(join(targetDir, spec.name))).size, spec.bytes)
  })

  it('buildPartsManifest شکل مورد انتظار مرورگر را می‌سازد', () => {
    const manifest = buildPartsManifest(
      [{ name: 'encoder.int8.onnx', bytes: 10, sha256: 'aa', parts: [{ name: 'encoder.int8.onnx.part0', bytes: 10, sha256: 'bb' }] }],
      4,
    )
    assert.deepEqual(manifest, {
      version: 1,
      chunkBytes: 4,
      files: { 'encoder.int8.onnx': { bytes: 10, sha256: 'aa', parts: [{ name: 'encoder.int8.onnx.part0', bytes: 10, sha256: 'bb' }] } },
    })
  })
})
