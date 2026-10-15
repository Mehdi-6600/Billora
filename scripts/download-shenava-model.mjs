#!/usr/bin/env node
/**
 * Downloads the Shenava Koochik v1.5 RNNT (int8) speech model into `public/models/shenava/`.
 *
 * Why: the offline engine must serve its own model files — no CDN, no per-user download. Vercel
 * (and any other build machine with internet access) therefore fetches them once during the build,
 * Vite copies `public/` into `dist/`, and the app serves them like any other asset.
 *
 * The script is deliberately forgiving for build pipelines:
 *   • idempotent — files that already exist and match size + SHA-256 are skipped,
 *   • cached — a previously downloaded copy in `node_modules/.cache/shenava-model` is reused
 *     (that directory is part of Vercel's build cache, so later builds skip the network),
 *   • never fatal — a failed download logs a warning and the build continues; the app then simply
 *     runs without the offline engine (text input and Web Speech API keep working),
 *   • verifiable — every file is checked against the size and SHA-256 published in the Hugging Face
 *     LFS metadata, so a truncated file or a wrong mirror is caught instead of silently producing
 *     garbage transcriptions.
 *
 * Usage:
 *   node scripts/download-shenava-model.mjs                 # install what is missing (build step)
 *   node scripts/download-shenava-model.mjs --check         # verify only, non-zero exit when broken
 *   node scripts/download-shenava-model.mjs --force         # re-download everything
 *   node scripts/download-shenava-model.mjs --strict        # fail the build when something is missing
 *   HF_ENDPOINT=https://hf-mirror.com node scripts/...      # restricted networks / mirrors
 *
 * Environment:
 *   HF_ENDPOINT                 one or more comma-separated mirrors (default https://huggingface.co)
 *   SHENAVA_MODEL_DOWNLOAD      `0` disables the download completely
 *   SHENAVA_MODEL_DIR           target directory (default public/models/shenava)
 *   SHENAVA_MODEL_CACHE_DIR     cache directory (default node_modules/.cache/shenava-model)
 *   SHENAVA_MODEL_MANIFEST      JSON file overriding the manifest below (mirrors, tests)
 *   GITHUB_PAGES=true           skipped by default: GitHub Pages cannot send the COOP/COEP headers
 */

import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { copyFile, mkdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { pathToFileURL } from 'node:url'

export const MODEL_REPO = 'Reza2kn/Shenava-Koochik-v1.5-RNNT-sherpa-onnx'
export const MODEL_REVISION = 'main'
export const DEFAULT_ENDPOINT = 'https://huggingface.co'

/**
 * Sizes and SHA-256 values come from the Hugging Face LFS metadata
 * (`GET /api/models/<repo>/tree/main?recursive=true`) and are mirrored in
 * `src/speech/offline/shenavaModel.ts`, which verifies the same files in the browser.
 */
export const MODEL_FILES = [
  {
    name: 'encoder.int8.onnx',
    bytes: 131_342_912,
    sha256: 'b9d975c1af77002f83897017e3adaaa6510148c6ba332df92b8d281369f2fdd3',
  },
  {
    name: 'decoder.int8.onnx',
    bytes: 3_956_194,
    sha256: '0adaad326a536dfbb30c67287e909b4e6f0775fccb8c3ca47270890364824947',
  },
  {
    name: 'joiner.int8.onnx',
    bytes: 1_408_514,
    sha256: 'e441ed265c961ff4a2436aa8bc36638e65849445e7a1f65cf263f0c310593dde',
  },
  { name: 'tokens.txt', bytes: 12_236, sha256: null },
]

const DEFAULT_TARGET_DIR = 'public/models/shenava'
const DEFAULT_CACHE_DIR = 'node_modules/.cache/shenava-model'
/**
 * Vercel's documented limit for static uploads on the Hobby plan (vercel.com/docs/limits).
 * Files above it may make the deployment fail, so the installer warns and offers `--max-bytes`.
 */
const VERCEL_HOBBY_STATIC_LIMIT = 100 * 1024 * 1024
const ATTEMPTS_PER_ENDPOINT = 3
const REQUEST_TIMEOUT_MS = 15 * 60 * 1000

export function modelFileUrl(fileName, { endpoint = DEFAULT_ENDPOINT, revision = MODEL_REVISION } = {}) {
  return `${endpoint.replace(/\/+$/, '')}/${MODEL_REPO}/resolve/${revision}/${fileName}`
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '?'
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

export function parseArgs(argv = []) {
  const flags = { check: false, force: false, strict: false, quiet: false }
  const options = { dir: null, endpoints: [], maxBytes: null }
  for (const arg of argv) {
    if (arg === '--check') flags.check = true
    else if (arg === '--force') flags.force = true
    else if (arg === '--strict') flags.strict = true
    else if (arg === '--quiet') flags.quiet = true
    else if (arg.startsWith('--dir=')) options.dir = arg.slice('--dir='.length)
    else if (arg.startsWith('--endpoint=')) options.endpoints.push(arg.slice('--endpoint='.length))
    else if (arg.startsWith('--max-bytes=')) options.maxBytes = Number(arg.slice('--max-bytes='.length))
    else if (arg === '--help' || arg === '-h') flags.help = true
    else throw new Error(`unknown argument: ${arg}`)
  }
  return { flags, options }
}

export function endpointsFromEnv(env = {}) {
  const raw = env.HF_ENDPOINT ?? env.HF_ENDPOINTS ?? ''
  const list = raw
    .split(',')
    .map((endpoint) => endpoint.trim().replace(/\/+$/, ''))
    .filter((endpoint) => endpoint.length > 0)
  return list.length > 0 ? list : [DEFAULT_ENDPOINT]
}

export function sha256File(path) {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolvePromise(hash.digest('hex')))
  })
}

async function sizeOf(path) {
  try {
    const info = await stat(path)
    return info.isFile() ? info.size : null
  } catch {
    return null
  }
}

/**
 * `ok` | `missing` | `incomplete` (wrong size) | `corrupt` (SHA-256 mismatch).
 * Hash verification is skipped for files without a published SHA-256 (e.g. `tokens.txt`).
 */
export async function describeLocalFile(path, spec, { hashFile = sha256File } = {}) {
  const size = await sizeOf(path)
  if (size === null) return { status: 'missing', size: 0 }
  if (size !== spec.bytes) return { status: 'incomplete', size }
  if (spec.sha256) {
    const digest = await hashFile(path)
    if (digest !== spec.sha256) return { status: 'corrupt', size, digest }
  }
  return { status: 'ok', size }
}

export async function downloadFile({
  url,
  targetPath,
  spec,
  fetchImpl = fetch,
  attempts = ATTEMPTS_PER_ENDPOINT,
  sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms)),
  hashFile = sha256File,
  timeoutMs = REQUEST_TIMEOUT_MS,
}) {
  let lastError = new Error('download failed')
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const temporaryPath = `${targetPath}.part`
    try {
      const response = await fetchImpl(url, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) })
      if (!response.ok || !response.body) {
        throw new Error(`HTTP ${response.status} ${response.statusText ?? ''}`.trim())
      }
      await pipeline(Readable.fromWeb(response.body), createWriteStream(temporaryPath))
      const verified = await describeLocalFile(temporaryPath, spec, { hashFile })
      if (verified.status !== 'ok') {
        throw new Error(
          verified.status === 'incomplete'
            ? `${verified.size} bytes received, ${spec.bytes} expected`
            : `SHA-256 mismatch (${verified.digest ?? 'unknown'})`,
        )
      }
      await rename(temporaryPath, targetPath)
      return { size: verified.size }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      await rm(temporaryPath, { force: true }).catch(() => undefined)
      if (attempt < attempts) await sleep(attempt * 1_000)
    }
  }
  throw lastError
}

export async function loadManifest(manifestPath, { readFileImpl = readFile } = {}) {
  if (!manifestPath) return MODEL_FILES
  const parsed = JSON.parse(await readFileImpl(manifestPath, 'utf8'))
  const files = Array.isArray(parsed) ? parsed : parsed.files
  if (!Array.isArray(files) || files.length === 0) throw new Error(`manifest has no files: ${manifestPath}`)
  return files
}

/**
 * One pass over the manifest: verify → reuse cache → download. Never throws for network problems;
 * the caller decides whether the summary is fatal (`--strict`, `--check`).
 */
export async function runDownload({
  targetDir,
  cacheDir = null,
  files = MODEL_FILES,
  endpoints = [DEFAULT_ENDPOINT],
  force = false,
  logger = console,
  fetchImpl = fetch,
  hashFile = sha256File,
  sleep,
  attempts = ATTEMPTS_PER_ENDPOINT,
  /**
   * Optional budget for the files that end up next to the app (Vercel's static upload limit).
   * Files above it stay in the cache and are fetched by the browser from Hugging Face instead —
   * `probeShenavaModel` accepts that mixed setup, and the engine caches them on the device.
   * `null` ships everything.
   */
  maxBytes = null,
} = {}) {
  await mkdir(targetDir, { recursive: true })
  if (cacheDir && resolve(cacheDir) !== resolve(targetDir)) await mkdir(cacheDir, { recursive: true })

  const summary = { downloaded: 0, copied: 0, skipped: 0, failed: 0, excluded: 0, errors: [], files: [], bytes: 0 }

  for (const spec of files) {
    const targetPath = join(targetDir, spec.name)
    const cachedPath = cacheDir && resolve(cacheDir) !== resolve(targetDir) ? join(cacheDir, spec.name) : null

    if (maxBytes !== null && spec.bytes > maxBytes) {
      // Still download it into the cache so a later build (or a manual copy) has it, but keep it out
      // of the shipped files: the browser loads it straight from Hugging Face on first use.
      if (cachedPath) {
        const cached = await describeLocalFile(cachedPath, spec, { hashFile })
        if (cached.status !== 'ok') {
          try {
            await downloadFile({
              url: modelFileUrl(spec.name, { endpoint: endpoints[0] }),
              targetPath: cachedPath,
              spec,
              fetchImpl,
              hashFile,
              attempts,
              sleep,
            })
          } catch (error) {
            summary.errors.push(`${spec.name}: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
      }
      await rm(targetPath, { force: true }).catch(() => undefined)
      summary.excluded += 1
      summary.files.push({ name: spec.name, status: 'excluded', size: spec.bytes })
      logger.warn(
        `SKIP  ${spec.name} (${formatBytes(spec.bytes)}) از حد مجاز میزبان بزرگ‌تر است؛ ` +
          'مرورگر آن را در اولین استفاده از Hugging Face می‌گیرد و روی دستگاه کش می‌کند',
      )
      continue
    }

    const existing = force ? { status: 'force' } : await describeLocalFile(targetPath, spec, { hashFile })
    if (existing.status === 'ok') {
      summary.skipped += 1
      summary.bytes += existing.size
      summary.files.push({ name: spec.name, status: 'skipped', size: existing.size })
      logger.log(`OK    ${spec.name} از قبل سالم است (${formatBytes(existing.size)})`)
      continue
    }

    if (cachedPath) {
      const cached = await describeLocalFile(cachedPath, spec, { hashFile })
      if (cached.status === 'ok') {
        await copyFile(cachedPath, targetPath)
        summary.copied += 1
        summary.bytes += cached.size
        summary.files.push({ name: spec.name, status: 'copied', size: cached.size })
        logger.log(`CACHE ${spec.name} از کش build کپی شد (${formatBytes(cached.size)})`)
        continue
      }
    }

    if (existing.status !== 'missing') {
      logger.warn(`WARN  ${spec.name} ناقص است (${existing.status})؛ دوباره دانلود می‌شود`)
      await rm(targetPath, { force: true }).catch(() => undefined)
    }

    let lastError = null
    for (const endpoint of endpoints) {
      const url = modelFileUrl(spec.name, { endpoint })
      logger.log(`GET   ${spec.name} (${formatBytes(spec.bytes)}) از ${endpoint}`)
      try {
        const { size } = await downloadFile({
          url,
          targetPath,
          spec,
          fetchImpl,
          hashFile,
          attempts,
          sleep,
        })
        if (cachedPath) await copyFile(targetPath, cachedPath).catch(() => undefined)
        summary.downloaded += 1
        summary.bytes += size
        summary.files.push({ name: spec.name, status: 'downloaded', size })
        logger.log(`OK    ${spec.name} دانلود و تأیید شد (${formatBytes(size)})`)
        lastError = null
        break
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))
        logger.warn(`FAIL  ${spec.name} از ${endpoint}: ${lastError.message}`)
      }
    }

    if (lastError) {
      summary.failed += 1
      summary.errors.push(`${spec.name}: ${lastError.message}`)
      summary.files.push({ name: spec.name, status: 'failed' })
      await rm(targetPath, { force: true }).catch(() => undefined)
    }
  }

  return summary
}

function resolvePath(value, cwd) {
  if (!value) return null
  return isAbsolute(value) ? value : resolve(cwd, value)
}

export function resolveConfiguration({ argv = process.argv.slice(2), env = process.env, cwd = process.cwd() } = {}) {
  const { flags, options } = parseArgs(argv)
  const envMaxBytes = Number(env.SHENAVA_MODEL_MAX_BUILD_BYTES ?? '')
  const maxBytes = Number.isFinite(options.maxBytes)
    ? options.maxBytes
    : Number.isFinite(envMaxBytes) && envMaxBytes > 0
      ? envMaxBytes
      : null
  const endpoints = options.endpoints.length > 0 ? options.endpoints : endpointsFromEnv(env)
  const disabled = env.SHENAVA_MODEL_DOWNLOAD === '0' || env.SHENAVA_MODEL_DOWNLOAD === 'false'
  const explicitToggle = env.SHENAVA_MODEL_DOWNLOAD === '1' || env.SHENAVA_MODEL_DOWNLOAD === 'true'
  // GitHub Pages cannot send COOP/COEP and would have to ship ~137 MB in its artifact, so the
  // download stays off there unless it was explicitly requested.
  const skippedForPages = env.GITHUB_PAGES === 'true' && !explicitToggle
  return {
    flags,
    endpoints,
    disabled,
    skippedForPages,
    maxBytes,
    targetDir: resolvePath(options.dir ?? env.SHENAVA_MODEL_DIR ?? DEFAULT_TARGET_DIR, cwd),
    cacheDir: resolvePath(env.SHENAVA_MODEL_CACHE_DIR ?? DEFAULT_CACHE_DIR, cwd),
    manifestPath: resolvePath(env.SHENAVA_MODEL_MANIFEST, cwd),
  }
}

const HELP = `نصب مدل گفتار آفلاین شنوا کوچیک ۱.۵ (int8)

  node scripts/download-shenava-model.mjs [گزینه‌ها]

  --check      فقط بررسی فایل‌های موجود (خروج با کد ۱ در صورت ناقص‌بودن)
  --force      دانلود مجدد همهٔ فایل‌ها
  --strict     در صورت شکست دانلود، build را متوقف کن
  --quiet      کم‌ترین خروجی
  --dir=...    مسیر مقصد (پیش‌فرض public/models/shenava)
  --endpoint=...  میزبان جایگزین (چند بار قابل تکرار)

  متغیرهای محیطی: HF_ENDPOINT، SHENAVA_MODEL_DOWNLOAD، SHENAVA_MODEL_DIR،
  SHENAVA_MODEL_CACHE_DIR، SHENAVA_MODEL_MANIFEST`

export async function main({ argv = process.argv.slice(2), env = process.env, cwd = process.cwd(), logger = console } = {}) {
  const config = resolveConfiguration({ argv, env, cwd })

  if (config.flags.help) {
    logger.log(HELP)
    return 0
  }

  if (config.disabled) {
    logger.log('SKIP  دانلود مدل با SHENAVA_MODEL_DOWNLOAD=0 غیرفعال شده است')
    return 0
  }

  if (config.skippedForPages && !config.flags.check) {
    logger.log('SKIP  ساخت GitHub Pages است؛ مدل دانلود نمی‌شود (می‌توان با SHENAVA_MODEL_DOWNLOAD=1 اجبار کرد)')
    return 0
  }

  const files = await loadManifest(config.manifestPath)
  const total = files.reduce((sum, file) => sum + (file.bytes ?? 0), 0)
  logger.log(`مدل: ${MODEL_REPO}`)
  logger.log(`مقصد: ${config.targetDir}${config.flags.check ? ' (فقط بررسی)' : ''}`)
  logger.log(`حجم کل: ${formatBytes(total)} · منابع: ${config.endpoints.join(', ')}`)

  const summary = await runDownload({
    targetDir: config.targetDir,
    cacheDir: config.cacheDir,
    files,
    endpoints: config.endpoints,
    force: config.flags.force && !config.flags.check,
    maxBytes: config.maxBytes,
    logger: config.flags.quiet ? { log: () => {}, warn: () => {} } : logger,
  })

  logger.log(
    `خلاصه: ${summary.downloaded} دانلود، ${summary.copied} از کش، ${summary.skipped} از قبل موجود، ` +
      `${summary.excluded} خارج از build، ${summary.failed} ناموفق`,
  )

  const shipped = summary.bytes
  if (config.maxBytes === null && shipped > VERCEL_HOBBY_STATIC_LIMIT) {
    logger.warn(
      `⚠️  حجم مدلی که همراه build منتشر می‌شود ${formatBytes(shipped)} است و از حد ۱۰۰ مگابایتی ` +
        'آپلود فایل استاتیک در پلن Hobby ورسل بیشتر است.',
    )
    logger.warn('    اگر استقرار Vercel با خطای حجم شکست خورد، یکی از این دو راه:')
    logger.warn('    • SHENAVA_MODEL_MAX_BUILD_BYTES=100000000 — فایل بزرگ در build نمی‌آید و مرورگر آن را از Hugging Face می‌گیرد')
    logger.warn('    • SHENAVA_MODEL_DOWNLOAD=0 — هیچ فایلی همراه build نمی‌آید')
  }

  if (summary.failed > 0) {
    logger.warn('⚠️  بخشی از فایل‌های مدل نصب نشد؛ اپ کار می‌کند ولی موتور گفتار آفلاین غیرفعال می‌ماند.')
    logger.warn('    ورودی متنی و Web Speech API دست‌نخورده‌اند. برای نصب دستی: npm run model:download')
    for (const error of summary.errors) logger.warn(`    - ${error}`)
    const fatal = config.flags.strict || config.flags.check
    if (fatal) {
      logger.error('BUILD FAILED (--strict/--check): مدل کامل نصب نشد')
      return 1
    }
  } else if (config.flags.check) {
    logger.log('✅  همهٔ فایل‌های مدل سالم هستند')
  }

  return 0
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href

if (invokedDirectly) {
  // A build step must never break the app: unexpected errors are reported, not thrown.
  const exitCode = await main().catch((error) => {
    console.error(`⚠️  نصب مدل با خطای غیرمنتظره متوقف شد: ${error?.message ?? error}`)
    console.error('    build ادامه می‌یابد؛ موتور گفتار آفلاین غیرفعال می‌ماند.')
    return process.env.SHENAVA_MODEL_STRICT === '1' || process.argv.includes('--strict') ? 1 : 0
  })
  process.exitCode = exitCode
}

export { DEFAULT_TARGET_DIR, DEFAULT_CACHE_DIR }
