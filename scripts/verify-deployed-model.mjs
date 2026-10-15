#!/usr/bin/env node
/**
 * Verifies that a **deployed** Billora instance really serves the offline speech model.
 *
 * Scope: does a green build actually mean the 131 MB encoder is served to browsers? This script
 * answers that with facts, one command, no expertise:
 *
 *   npm run verify:deployed -- https://your-app.vercel.app
 *   npm run verify:deployed -- https://your-app.vercel.app --json
 *
 * For every model file it reports HTTP status, `Content-Type`, `Content-Length` and whether the
 * length matches the manifest in `src/speech/offline/shenavaModel.ts`. `HEAD` is used first (so the
 * 131 MB file is never downloaded); when a host ignores `HEAD`, a 1-byte ranged `GET` is used, which
 * is exactly what the app's own probe does.
 *
 * It also checks the page headers the engine needs (COOP/COEP ⇒ `crossOriginIsolated === true`) and
 * that `/test-shenava.html` exists, so one run covers every acceptance criterion of the model rollout.
 *
 * Exit code: 0 when every check passes, 1 otherwise (usable in CI).
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** Kept in sync with `src/speech/offline/shenavaModel.ts` by the test suite. */
export const MODEL_FILES = [
  { name: 'encoder.int8.onnx', bytes: 131_342_912 },
  { name: 'decoder.int8.onnx', bytes: 3_956_194 },
  { name: 'joiner.int8.onnx', bytes: 1_408_514 },
  { name: 'tokens.txt', bytes: 12_236 },
]

export const MODEL_DIRECTORY = 'models/shenava'
export const DIAGNOSTIC_PAGE = 'test-shenava.html'
const TIMEOUT_MS = 60_000

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '?'
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

export function normalizeBaseUrl(value) {
  if (!value) throw new Error('base URL is required, e.g. `npm run verify:deployed -- https://app.vercel.app`')
  const withScheme = /^https?:\/\//i.test(value) ? value : `https://${value}`
  return withScheme.replace(/\/+$/, '')
}

export function parseArgs(argv = []) {
  const options = { baseUrl: null, json: false, quiet: false, timeoutMs: TIMEOUT_MS, manifestPath: null }
  for (const arg of argv) {
    if (arg === '--json') options.json = true
    else if (arg === '--quiet') options.quiet = true
    else if (arg.startsWith('--timeout=')) options.timeoutMs = Number(arg.slice('--timeout='.length))
    else if (arg.startsWith('--manifest=')) options.manifestPath = arg.slice('--manifest='.length)
    else if (arg.startsWith('--')) throw new Error(`unknown argument: ${arg}`)
    else if (!options.baseUrl) options.baseUrl = arg
    else throw new Error(`unexpected argument: ${arg}`)
  }
  return options
}

/**
 * Sizes are read from the app manifest so this script can never drift from the engine.
 * A JSON file (`{ "files": [...] }`) is accepted too, which the tests use for small stand-ins.
 */
export async function loadManifest(path = fileURLToPath(new URL('../src/speech/offline/shenavaModel.ts', import.meta.url))) {
  const source = await readFile(path, 'utf8')
  if (path.endsWith('.json')) {
    const parsed = JSON.parse(source)
    const files = Array.isArray(parsed) ? parsed : parsed.files
    if (!Array.isArray(files) || files.length === 0) throw new Error(`no model files found in ${path}`)
    return files.map((file) => ({ name: file.name, bytes: Number(file.bytes) }))
  }
  const files = []
  for (const match of source.matchAll(/name:\s*'([^']+)',\s*bytes:\s*([\d_]+)/g)) {
    files.push({ name: match[1], bytes: Number(match[2].replace(/_/g, '')) })
  }
  if (files.length === 0) throw new Error(`no model files found in ${path}`)
  return files
}

export function headerOf(response, name) {
  return response.headers?.get?.(name) ?? null
}

/**
 * `HEAD` first, ranged `GET` as fallback (some CDNs omit `Content-Length` on `HEAD`).
 * Returns a fully descriptive result instead of a bare boolean, because the report is the point.
 */
export async function describeRemote(
  url,
  { fetchImpl = fetch, timeoutMs = TIMEOUT_MS, expectedBytes = null } = {},
) {
  const attempt = async (init) => {
    const response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
    return response
  }

  let headError = null
  try {
    const response = await attempt({ method: 'HEAD' })
    const length = Number(headerOf(response, 'content-length') ?? '')
    if (response.ok && Number.isFinite(length) && length > 0) {
      return {
        ok: response.ok,
        status: response.status,
        method: 'HEAD',
        contentType: headerOf(response, 'content-type'),
        contentLength: length,
        crossOriginResourcePolicy: headerOf(response, 'cross-origin-resource-policy'),
        cacheControl: headerOf(response, 'cache-control'),
        matches: expectedBytes === null ? null : length === expectedBytes,
      }
    }
    if (!response.ok) {
      return { ok: false, status: response.status, method: 'HEAD', contentType: headerOf(response, 'content-type'), contentLength: null, matches: false }
    }
  } catch (error) {
    headError = error instanceof Error ? error.message : String(error)
  }

  try {
    const response = await attempt({ headers: { Range: 'bytes=0-0' } })
    const contentRange = headerOf(response, 'content-range')
    const total = contentRange ? Number(contentRange.split('/').pop() ?? '') : Number.NaN
    const length = Number(headerOf(response, 'content-length') ?? '')
    const resolved = Number.isFinite(total) && total > 0 ? total : Number.isFinite(length) && length > 0 ? length : null
    return {
      ok: response.ok,
      status: response.status,
      method: 'GET (Range: bytes=0-0)',
      contentType: headerOf(response, 'content-type'),
      contentLength: resolved,
      contentRange,
      crossOriginResourcePolicy: headerOf(response, 'cross-origin-resource-policy'),
      matches: resolved === null || expectedBytes === null ? false : resolved === expectedBytes,
      headError,
    }
  } catch (error) {
    return {
      ok: false,
      status: 0,
      method: 'GET (Range: bytes=0-0)',
      contentType: null,
      contentLength: null,
      matches: false,
      error: error instanceof Error ? error.message : String(error),
      headError,
    }
  }
}

export async function verifyDeployment({
  baseUrl,
  files = MODEL_FILES,
  fetchImpl = fetch,
  timeoutMs = TIMEOUT_MS,
  logger = console,
} = {}) {
  const base = normalizeBaseUrl(baseUrl)
  const results = { baseUrl: base, files: [], page: null, diagnostic: null, webSpeech: 'unknown', ok: true, failures: [] }

  logger.log(`بررسی استقرار: ${base}`)

  // 1) the page itself: cross-origin isolation headers are what make the engine multi-threaded
  const pageUrl = `${base}/index.html`
  const page = await describeRemote(pageUrl, { fetchImpl, timeoutMs, expectedBytes: null })
  let coop = null
  let coep = null
  try {
    const response = await fetchImpl(pageUrl, { signal: AbortSignal.timeout(timeoutMs) })
    coop = headerOf(response, 'cross-origin-opener-policy')
    coep = headerOf(response, 'cross-origin-embedder-policy')
  } catch (error) {
    results.failures.push(`index.html: ${error instanceof Error ? error.message : String(error)}`)
  }
  results.page = { status: page.status, coop, coep }
  const isolated = coop?.includes('same-origin') && coep?.includes('require-corp')
  if (page.status !== 200) results.failures.push(`index.html → HTTP ${page.status}`)
  if (!isolated) results.failures.push(`COOP/COEP headers missing or wrong (got ${coop ?? '—'} / ${coep ?? '—'})`)

  // 2) the diagnostic page (how a phone user checks the engine without a developer console)
  const diagnosticUrl = `${base}/${DIAGNOSTIC_PAGE}`
  const diagnostic = await describeRemote(diagnosticUrl, { fetchImpl, timeoutMs, expectedBytes: null })
  const diagnosticIsHtml = (diagnostic.contentType ?? '').includes('html')
  results.diagnostic = { status: diagnostic.status, contentType: diagnostic.contentType, isHtml: diagnosticIsHtml }
  if (!diagnostic.ok || !diagnosticIsHtml) {
    results.failures.push(`${DIAGNOSTIC_PAGE} → HTTP ${diagnostic.status} (${diagnostic.contentType ?? 'no content-type'})`)
  }

  // 3) every model file
  for (const file of files) {
    const url = `${base}/${MODEL_DIRECTORY}/${file.name}`
    const described = await describeRemote(url, { fetchImpl, timeoutMs, expectedBytes: file.bytes })
    // The dev server answers missing files with `index.html` + HTTP 200, so a wrong size must fail.
    const servedAsHtml = (described.contentType ?? '').includes('html')
    const passed = described.ok && described.matches === true && !servedAsHtml
    results.files.push({
      name: file.name,
      expectedBytes: file.bytes,
      status: described.status,
      method: described.method,
      contentType: described.contentType,
      contentLength: described.contentLength,
      matches: described.matches,
      passed,
      url,
    })
    if (!passed) {
      results.failures.push(
        `${file.name}: HTTP ${described.status}, content-type=${described.contentType ?? '—'}, ` +
          `length=${described.contentLength ?? '—'} (expected ${file.bytes})`,
      )
    }
    if (!results.quiet) logger.log(`  ${passed ? 'PASS' : 'FAIL'}  ${file.name} — ${formatBytes(described.contentLength)}`)
  }

  results.ok = results.failures.length === 0
  return results
}

function printReport(results, logger = console) {
  logger.log('')
  logger.log(`دامنه: ${results.baseUrl}`)
  logger.log(`صفحه: HTTP ${results.page.status} · COOP=${results.page.coop ?? '—'} · COEP=${results.page.coep ?? '—'}`)
  logger.log(
    `صفحهٔ تشخیص: HTTP ${results.diagnostic.status} · ${results.diagnostic.contentType ?? '—'}`,
  )
  logger.log('')
  logger.log('فایل                            وضعیت   Content-Type                 حجم گزارش‌شده   انتظار')
  logger.log('─'.repeat(96))
  for (const file of results.files) {
    logger.log(
      `${file.name.padEnd(30)} HTTP ${String(file.status).padEnd(4)} ${(file.contentType || '—').padEnd(28)} ` +
        `${formatBytes(file.contentLength).padEnd(14)} ${formatBytes(file.expectedBytes)}` +
        `${file.matches ? '' : '  ← ناهمخوان'}`,
    )
  }
  logger.log('')
  if (results.ok) {
    logger.log('✅ همهٔ بررسی‌ها موفق: مدل روی همین دامنه سرو می‌شود و موتور آفلاین قابل استفاده است.')
  } else {
    logger.log('❌ بررسی ناموفق بود:')
    for (const failure of results.failures) logger.log(`   - ${failure}`)
    logger.log('')
    logger.log('راه‌حل‌ها:')
    logger.log('   • SHENAVA_MODEL_MAX_BUILD_BYTES=100000000 — فایل بزرگ همراه build نیاید و مرورگر آن را از منبع بیرونی بگیرد')
    logger.log('   • VITE_SHENAVA_MODEL_BASE_URL=<آدرس پوشهٔ مدل> — مدل روی GitHub Release/Blob/R2/هر CDN دیگری باشد')
    logger.log('   • جزئیات: docs/shenava-offline-speech.md → «دانلود خودکار در Vercel»')
  }
}

export async function main({ argv = process.argv.slice(2), logger = console } = {}) {
  const options = parseArgs(argv)
  let files = MODEL_FILES
  try {
    files = await loadManifest(options.manifestPath ?? undefined)
  } catch (error) {
    logger.warn(`هشدار: خواندن فهرست مدل از اپ ممکن نشد (${error instanceof Error ? error.message : error})؛ از فهرست داخلی استفاده می‌شود.`)
  }
  const results = await verifyDeployment({ baseUrl: options.baseUrl, files, logger: options.quiet ? { log: () => {} } : logger })
  if (options.json) logger.log(JSON.stringify(results, null, 2))
  else printReport(results, logger)
  return results.ok ? 0 : 1
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  process.exitCode = await main().catch((error) => {
    console.error(`خطا: ${error instanceof Error ? error.message : error}`)
    return 1
  })
}
