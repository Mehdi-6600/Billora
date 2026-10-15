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
 *   SHENAVA_MODEL_MIRROR=https://github.com/…/releases/download/<tag> node scripts/…   # flat mirror
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
import { copyFile, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { pathToFileURL } from 'node:url'

export const MODEL_REPO = 'Reza2kn/Shenava-Koochik-v1.5-RNNT-sherpa-onnx'
export const MODEL_REVISION = 'main'
export const DEFAULT_ENDPOINT = 'https://huggingface.co'

/**
 * Hosts with a per-file size limit (Vercel Hobby: 100 MB for static uploads) would reject the
 * 125 MiB encoder and fail the whole deployment. Instead of dropping that file — which forces every
 * browser to fetch it from a third party — it is split into byte-identical chunks below the limit
 * and the app reassembles it in memory (see `src/speech/offline/shenavaModel.ts`). The chunks are
 * ordinary static files, so the model still comes from the app's own origin.
 */
export const DEFAULT_CHUNK_BYTES = 64 * 1024 * 1024
export const DEFAULT_HOST_FILE_LIMIT = 100_000_000
/** Name of the manifest that describes split files; served next to the model files. */
export const MODEL_PARTS_FILE = 'model-parts.json'

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

/**
 * Flat mirror URL (`<base>/<file>`), e.g. a GitHub Release created by `.github/workflows/shenava-model.yml`:
 *   SHENAVA_MODEL_MIRROR=https://github.com/<owner>/<repo>/releases/download/shenava-model-v1.5-int8
 *
 * Mirrors are tried after the Hugging Face endpoints and every download is verified against the same
 * size + SHA-256, so a stale or wrong mirror can never poison a build.
 */
export function mirrorFileUrl(fileName, mirrorBase) {
  return `${mirrorBase.replace(/\/+$/, '')}/${fileName}`
}

/**
 * Splits `totalBytes` into consecutive chunks. The result is deterministic: same input, same part
 * names and sizes, which keeps the browser cache and the deployment verifier stable.
 */
export function planParts(fileName, totalBytes, chunkBytes = DEFAULT_CHUNK_BYTES) {
  if (!Number.isFinite(totalBytes) || totalBytes <= 0) throw new Error(`invalid size for ${fileName}`)
  const size = Number.isFinite(chunkBytes) && chunkBytes > 0 ? Math.floor(chunkBytes) : DEFAULT_CHUNK_BYTES
  const parts = []
  let offset = 0
  let index = 0
  while (offset < totalBytes) {
    const bytes = Math.min(size, totalBytes - offset)
    parts.push({ index, name: `${fileName}.part${index}`, bytes, offset })
    offset += bytes
    index += 1
  }
  return parts
}

/**
 * Writes the chunks of `sourcePath` into `targetDir` (one read of at most `chunkBytes` at a time, so
 * even a 131 MB file never has to sit in memory twice) and returns their exact sizes and hashes.
 */
export async function splitFileIntoParts({ sourcePath, targetDir, spec, parts, hashFile = sha256File }) {
  const handle = await open(sourcePath, 'r')
  const written = []
  try {
    for (const part of parts) {
      const buffer = Buffer.alloc(part.bytes)
      const { bytesRead } = await handle.read(buffer, 0, part.bytes, part.offset)
      if (bytesRead !== part.bytes) {
        throw new Error(`${spec.name}: only ${bytesRead} of ${part.bytes} bytes read while splitting`)
      }
      const partPath = join(targetDir, part.name)
      await writeFile(partPath, buffer)
      const sha256 = await hashFile(partPath)
      written.push({ name: part.name, bytes: bytesRead, sha256 })
    }
  } finally {
    await handle.close()
  }
  return written
}

/** Removes stale chunks (`*.part3`, …) of a file whose split layout changed. */
export async function removeStaleParts(targetDir, fileName, keepNames = []) {
  const keep = new Set(keepNames)
  for (const entry of await readdir(targetDir)) {
    if (!entry.startsWith(`${fileName}.part`)) continue
    if (keep.has(entry)) continue
    await rm(join(targetDir, entry), { force: true }).catch(() => undefined)
  }
}

/** Manifest the browser (and `verify:deployed`) reads to know how a file is split. */
export function buildPartsManifest(entries, chunkBytes = DEFAULT_CHUNK_BYTES) {
  return {
    version: 1,
    chunkBytes,
    files: Object.fromEntries(
      entries.map((entry) => [
        entry.name,
        {
          bytes: entry.bytes,
          sha256: entry.sha256 ?? null,
          parts: entry.parts.map((part) => ({ name: part.name, bytes: part.bytes, sha256: part.sha256 ?? null })),
        },
      ]),
    ),
  }
}

export async function writePartsManifest(targetDir, manifest, { writeFileImpl = writeFile } = {}) {
  await writeFileImpl(join(targetDir, MODEL_PARTS_FILE), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
}

export async function readPartsManifest(targetDir, { readFileImpl = readFile } = {}) {
  try {
    return JSON.parse(await readFileImpl(join(targetDir, MODEL_PARTS_FILE), 'utf8'))
  } catch {
    return null
  }
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '?'
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

export function parseArgs(argv = []) {
  const flags = { check: false, force: false, strict: false, quiet: false }
  const options = { dir: null, endpoints: [], mirrors: [], maxBytes: null, reportPath: null }
  for (const arg of argv) {
    if (arg === '--check') flags.check = true
    else if (arg === '--force') flags.force = true
    else if (arg === '--strict') flags.strict = true
    else if (arg === '--quiet') flags.quiet = true
    else if (arg.startsWith('--dir=')) options.dir = arg.slice('--dir='.length)
    else if (arg.startsWith('--endpoint=')) options.endpoints.push(arg.slice('--endpoint='.length))
    else if (arg.startsWith('--mirror=')) options.mirrors.push(arg.slice('--mirror='.length))
    else if (arg.startsWith('--max-bytes=')) options.maxBytes = Number(arg.slice('--max-bytes='.length))
    else if (arg.startsWith('--report=')) options.reportPath = arg.slice('--report='.length)
    else if (arg === '--help' || arg === '-h') flags.help = true
    else throw new Error(`unknown argument: ${arg}`)
  }
  return { flags, options }
}

export function mirrorsFromEnv(env = {}) {
  const raw = env.SHENAVA_MODEL_MIRROR ?? env.SHENAVA_MODEL_MIRRORS ?? ''
  return raw
    .split(',')
    .map((mirror) => mirror.trim().replace(/\/+$/, ''))
    .filter((mirror) => mirror.length > 0)
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
  /** Flat mirror directories, tried after `endpoints`. */
  mirrors = [],
  /**
   * Optional budget for the files that end up next to the app (Vercel's static upload limit).
   * Files above it stay in the cache and are fetched by the browser from Hugging Face instead —
   * `probeShenavaModel` accepts that mixed setup, and the engine caches them on the device.
   * `null` ships everything.
   */
  maxBytes = DEFAULT_HOST_FILE_LIMIT,
  /**
   * When `true` (default) a file above `maxBytes` is split into chunks below it instead of being
   * left out of the build: the model then still comes from the app's own origin, which is the only
   * route that works on networks where the third-party host is blocked. `SHENAVA_MODEL_SPLIT=0`
   * restores the old "leave it to the browser" behaviour.
   */
  split = true,
  chunkBytes = DEFAULT_CHUNK_BYTES,
  /** `--check` never touches the network or the disk: existing files/chunks are verified only. */
  check = false,
  splitFile = splitFileIntoParts,
} = {}) {
  await mkdir(targetDir, { recursive: true })
  if (cacheDir && resolve(cacheDir) !== resolve(targetDir)) await mkdir(cacheDir, { recursive: true })

  const splitEntries = []

  /** Every source a file can come from, in order: Hugging Face hosts first, then flat mirrors. */
  const sourcesFor = (name) => [
    ...endpoints.map((endpoint) => ({ label: endpoint, url: modelFileUrl(name, { endpoint }) })),
    ...mirrors.map((mirror) => ({ label: mirror, url: mirrorFileUrl(name, mirror) })),
  ]

  /**
   * Downloads `spec` into the build cache when the copy there is missing or broken.
   *
   * This runs before splitting, so an oversized file must be obtainable from *any* configured host —
   * a mirror-only setup (Hugging Face blocked) would otherwise fail right here.
   */
  const ensureCached = async (path, spec, required = false) => {
    if (!path) return false
    const cached = await describeLocalFile(path, spec, { hashFile })
    if (cached.status === 'ok') return true
    if (check) return false
    let lastError = null
    for (const candidate of sourcesFor(spec.name)) {
      logger.log(`GET   ${spec.name} (${formatBytes(spec.bytes)}) از ${candidate.label}`)
      try {
        await downloadFile({
          url: candidate.url,
          targetPath: path,
          spec,
          fetchImpl,
          hashFile,
          attempts,
          sleep,
        })
        return true
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))
        logger.warn(`FAIL  ${spec.name} از ${candidate.label}: ${lastError.message}`)
      }
    }
    if (required) {
      summary.errors.push(`${spec.name}: ${lastError?.message ?? 'no source could serve the file'}`)
    }
    return false
  }

  const summary = {
    downloaded: 0,
    copied: 0,
    skipped: 0,
    failed: 0,
    excluded: 0,
    split: 0,
    errors: [],
    files: [],
    bytes: 0,
    /** Per-file details for the build report: bytes, milliseconds, SHA-256, source. */
    report: [],
    startedAt: Date.now(),
  }

  for (const spec of files) {
    const targetPath = join(targetDir, spec.name)
    const cachedPath = cacheDir && resolve(cacheDir) !== resolve(targetDir) ? join(cacheDir, spec.name) : null

    if (maxBytes !== null && spec.bytes > maxBytes) {
      const parts = split ? planParts(spec.name, spec.bytes, chunkBytes) : []

      if (!split) {
        // Old behaviour: keep the file out of the shipped files, the browser downloads it once.
        if (cachedPath) await ensureCached(cachedPath, spec)
        await rm(targetPath, { force: true }).catch(() => undefined)
        await removeStaleParts(targetDir, spec.name)
        summary.excluded += 1
        summary.files.push({ name: spec.name, status: 'excluded', size: spec.bytes })
        summary.report.push({ name: spec.name, status: 'excluded', bytes: spec.bytes, ms: 0, sha256: spec.sha256 })
        logger.warn(
          `SKIP  ${spec.name} (${formatBytes(spec.bytes)}) از حد مجاز میزبان بزرگ‌تر است؛ ` +
            'مرورگر آن را در اولین استفاده از Hugging Face می‌گیرد و روی دستگاه کش می‌کند',
        )
        continue
      }

      if (check) {
        const manifest = await readPartsManifest(targetDir)
        const listed = manifest?.files?.[spec.name]
        const expectedParts = listed?.parts?.length === parts.length ? listed.parts : parts.map((part) => ({ name: part.name, bytes: part.bytes }))
        const wrong = []
        for (const part of expectedParts) {
          const partPath = join(targetDir, part.name)
          const info = await describeLocalFile(partPath, { name: part.name, bytes: part.bytes, sha256: part.sha256 ?? null }, { hashFile })
          if (info.status !== 'ok') wrong.push(part.name)
        }
        if (wrong.length === 0) {
          summary.split += 1
          summary.bytes += spec.bytes
          summary.files.push({ name: spec.name, status: 'split', size: spec.bytes, parts: expectedParts.length })
          summary.report.push({ name: spec.name, status: 'split', bytes: spec.bytes, ms: 0, sha256: spec.sha256, parts: expectedParts.length })
          logger.log(`OK    ${spec.name} به ${expectedParts.length} تکه تقسیم شده و سالم است (${formatBytes(spec.bytes)})`)
        } else {
          summary.failed += 1
          summary.errors.push(`${spec.name}: تکه‌های ناقص → ${wrong.join(', ')}`)
          summary.files.push({ name: spec.name, status: 'failed', size: spec.bytes })
          logger.error(`FAIL  ${spec.name}: تکه‌های ناقص یا غایب → ${wrong.join(', ')}`)
        }
        continue
      }

      // The full file is needed once, to be cut into chunks. It stays in the build cache, never in
      // `public/` (Vite copies that into `dist/`, and the host would reject the 125 MiB file).
      let sourcePath = null
      for (const candidate of [cachedPath, targetPath]) {
        if (!candidate) continue
        const info = await describeLocalFile(candidate, spec, { hashFile })
        if (info.status === 'ok') {
          sourcePath = candidate
          break
        }
      }
      if (!sourcePath) {
        const downloadTarget = cachedPath ?? targetPath
        if (await ensureCached(downloadTarget, spec, true)) sourcePath = downloadTarget
      }
      if (!sourcePath) {
        summary.failed += 1
        if (!summary.errors.some((entry) => entry.startsWith(`${spec.name}:`))) {
          summary.errors.push(`${spec.name}: نسخهٔ کامل برای تقسیم در دسترس نیست`)
        }
        summary.files.push({ name: spec.name, status: 'failed', size: spec.bytes })
        logger.error(`FAIL  ${spec.name}: نسخهٔ کامل برای تقسیم در دسترس نیست؛ موتور آفلاین غیرفعال می‌ماند`)
        continue
      }

      try {
        const startedAt = Date.now()
        const written = await splitFile({ sourcePath, targetDir, spec, parts, hashFile })
        await removeStaleParts(targetDir, spec.name, written.map((part) => part.name))
        await rm(targetPath, { force: true }).catch(() => undefined)
        const elapsedMs = Date.now() - startedAt
        summary.split += 1
        summary.bytes += spec.bytes
        summary.files.push({ name: spec.name, status: 'split', size: spec.bytes, parts: written.length })
        summary.report.push({ name: spec.name, status: 'split', bytes: spec.bytes, ms: elapsedMs, sha256: spec.sha256, parts: written.length })
        splitEntries.push({ name: spec.name, bytes: spec.bytes, sha256: spec.sha256, parts: written })
        logger.log(
          `SPLIT ${spec.name} به ${written.length} تکهٔ هم‌مبدأ تقسیم شد ` +
            `(${written.map((part) => formatBytes(part.bytes)).join(' + ')} در ${(elapsedMs / 1000).toFixed(1)} ثانیه)`,
        )
      } catch (error) {
        summary.failed += 1
        summary.errors.push(`${spec.name}: ${error instanceof Error ? error.message : String(error)}`)
        summary.files.push({ name: spec.name, status: 'failed', size: spec.bytes })
        logger.error(`FAIL  ${spec.name}: تقسیم‌کردن فایل ناموفق بود — ${error instanceof Error ? error.message : error}`)
      }
      continue
    }

    const existing = force ? { status: 'force' } : await describeLocalFile(targetPath, spec, { hashFile })
    if (existing.status === 'ok') {
      summary.skipped += 1
      summary.bytes += existing.size
      summary.files.push({ name: spec.name, status: 'skipped', size: existing.size })
      summary.report.push({ name: spec.name, status: 'skipped', bytes: existing.size, ms: 0, sha256: spec.sha256 })
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
        summary.report.push({ name: spec.name, status: 'copied', bytes: cached.size, ms: 0, sha256: spec.sha256 })
        logger.log(`CACHE ${spec.name} از کش build کپی شد (${formatBytes(cached.size)})`)
        continue
      }
    }

    if (existing.status !== 'missing') {
      logger.warn(`WARN  ${spec.name} ناقص است (${existing.status})؛ دوباره دانلود می‌شود`)
      await rm(targetPath, { force: true }).catch(() => undefined)
    }

    let lastError = null
    const sources = [
      ...endpoints.map((endpoint) => ({ label: endpoint, url: modelFileUrl(spec.name, { endpoint }), source: 'network' })),
      ...mirrors.map((mirror) => ({ label: mirror, url: mirrorFileUrl(spec.name, mirror), source: 'mirror' })),
    ].filter((entry, index, all) => all.findIndex((other) => other.url === entry.url) === index)
    for (const candidate of sources) {
      const { url, label, source } = candidate
      logger.log(`GET   ${spec.name} (${formatBytes(spec.bytes)}) از ${label}`)
      const startedAt = Date.now()
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
        const elapsedMs = Date.now() - startedAt
        summary.downloaded += 1
        summary.bytes += size
        summary.files.push({ name: spec.name, status: 'downloaded', size })
        summary.report.push({ name: spec.name, status: 'downloaded', bytes: size, ms: elapsedMs, sha256: spec.sha256, endpoint: label, source })
        logger.log(`OK    ${spec.name} دانلود و تأیید شد (${formatBytes(size)} در ${(elapsedMs / 1000).toFixed(1)} ثانیه)`)
        lastError = null
        break
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))
        logger.warn(`FAIL  ${spec.name} از ${label}: ${lastError.message}`)
      }
    }

    if (lastError) {
      summary.failed += 1
      summary.errors.push(`${spec.name}: ${lastError.message}`)
      summary.files.push({ name: spec.name, status: 'failed' })
      await rm(targetPath, { force: true }).catch(() => undefined)
    }
  }

  // The manifest is the only thing the browser needs to know a file is split; a stale one would make
  // the probe believe in chunks that are no longer there, so its absence is written explicitly.
  try {
    if (splitEntries.length > 0) {
      await writePartsManifest(targetDir, buildPartsManifest(splitEntries, chunkBytes))
      summary.partsManifest = MODEL_PARTS_FILE
    } else {
      await rm(join(targetDir, MODEL_PARTS_FILE), { force: true }).catch(() => undefined)
    }
  } catch (error) {
    summary.errors.push(`${MODEL_PARTS_FILE}: ${error instanceof Error ? error.message : String(error)}`)
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
  // Without an explicit budget the two documented host limits still apply: a single file above
  // 100 MB would fail the deployment outright, so anything bigger is split instead of shipped whole.
  const maxBytes = Number.isFinite(options.maxBytes)
    ? options.maxBytes
    : Number.isFinite(envMaxBytes) && envMaxBytes > 0
      ? envMaxBytes
      : DEFAULT_HOST_FILE_LIMIT
  const envChunkBytes = Number(env.SHENAVA_MODEL_CHUNK_BYTES ?? '')
  const chunkBytes = Number.isFinite(envChunkBytes) && envChunkBytes > 0 ? envChunkBytes : DEFAULT_CHUNK_BYTES
  const split = env.SHENAVA_MODEL_SPLIT !== '0' && env.SHENAVA_MODEL_SPLIT !== 'false'
  const endpoints = options.endpoints.length > 0 ? options.endpoints : endpointsFromEnv(env)
  const mirrors = options.mirrors.length > 0 ? options.mirrors : mirrorsFromEnv(env)
  const disabled = env.SHENAVA_MODEL_DOWNLOAD === '0' || env.SHENAVA_MODEL_DOWNLOAD === 'false'
  const explicitToggle = env.SHENAVA_MODEL_DOWNLOAD === '1' || env.SHENAVA_MODEL_DOWNLOAD === 'true'
  // GitHub Pages cannot send COOP/COEP and would have to ship ~137 MB in its artifact, so the
  // download stays off there unless it was explicitly requested.
  const skippedForPages = env.GITHUB_PAGES === 'true' && !explicitToggle
  return {
    flags,
    endpoints,
    mirrors,
    disabled,
    skippedForPages,
    maxBytes,
    chunkBytes,
    split,
    targetDir: resolvePath(options.dir ?? env.SHENAVA_MODEL_DIR ?? DEFAULT_TARGET_DIR, cwd),
    cacheDir: resolvePath(env.SHENAVA_MODEL_CACHE_DIR ?? DEFAULT_CACHE_DIR, cwd),
    manifestPath: resolvePath(env.SHENAVA_MODEL_MANIFEST, cwd),
    reportPath: resolvePath(options.reportPath ?? env.SHENAVA_MODEL_REPORT, cwd),
  }
}

const HELP = `نصب مدل گفتار آفلاین شنوا کوچیک ۱.۵ (int8)

  node scripts/download-shenava-model.mjs [گزینه‌ها]

  --check      فقط بررسی فایل‌های موجود (خروج با کد ۱ در صورت ناقص‌بودن)
  --force      دانلود مجدد همهٔ فایل‌ها
  --strict     در صورت شکست دانلود، build را متوقف کن
  --quiet      کم‌ترین خروجی
  --dir=...    مسیر مقصد (پیش‌فرض public/models/shenava)
  --report=... نوشتن گزارش JSON (حجم، زمان، SHA-256 هر فایل)
  --endpoint=...  میزبان جایگزین با ساختار Hugging Face (چند بار قابل تکرار)
  --mirror=...    پوشهٔ flat مدل (مثلاً GitHub Release؛ چند بار قابل تکرار)

  فایل بزرگ‌تر از سقف میزبان (پیش‌فرض ۱۰۰ مگابایت) به تکه‌های ۶۴ مگابایتی تقسیم می‌شود و
  مرورگر آن‌ها را در حافظه به هم می‌چسباند؛ فایل «model-parts.json» این تقسیم را توصیف می‌کند.

  متغیرهای محیطی: HF_ENDPOINT، SHENAVA_MODEL_MIRROR، SHENAVA_MODEL_DOWNLOAD،
  SHENAVA_MODEL_DIR، SHENAVA_MODEL_CACHE_DIR، SHENAVA_MODEL_MANIFEST،
  SHENAVA_MODEL_MAX_BUILD_BYTES، SHENAVA_MODEL_CHUNK_BYTES، SHENAVA_MODEL_SPLIT،
  SHENAVA_MODEL_REPORT`

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
  logger.log(`حجم کل: ${formatBytes(total)} · منابع: ${[...config.endpoints, ...config.mirrors].join(', ')}`)

  const summary = await runDownload({
    targetDir: config.targetDir,
    cacheDir: config.cacheDir,
    files,
    endpoints: config.endpoints,
    mirrors: config.mirrors,
    force: config.flags.force && !config.flags.check,
    maxBytes: config.maxBytes,
    split: config.split,
    chunkBytes: config.chunkBytes,
    check: config.flags.check,
    logger: config.flags.quiet ? { log: () => {}, warn: () => {} } : logger,
  })

  logger.log(
    `خلاصه: ${summary.downloaded} دانلود، ${summary.copied} از کش، ${summary.skipped} از قبل موجود، ` +
      `${summary.split} تقسیم‌شده، ${summary.excluded} خارج از build، ${summary.failed} ناموفق`,
  )

  if (config.reportPath) {
    const report = {
      generatedAt: new Date().toISOString(),
      totalMs: Date.now() - summary.startedAt,
      totalBytes: summary.bytes,
      endpoints: config.endpoints,
      mirrors: config.mirrors,
      counts: {
        downloaded: summary.downloaded,
        copied: summary.copied,
        skipped: summary.skipped,
        split: summary.split,
        excluded: summary.excluded,
        failed: summary.failed,
      },
      files: summary.report,
      errors: summary.errors,
    }
    await writeFile(config.reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    logger.log(`گزارش نصب مدل نوشته شد: ${config.reportPath}`)
  }

  const shipped = summary.bytes
  if (shipped > VERCEL_HOBBY_STATIC_LIMIT && summary.split === 0 && summary.excluded === 0) {
    logger.warn(
      `⚠️  حجم مدلی که همراه build منتشر می‌شود ${formatBytes(shipped)} است و از حد ۱۰۰ مگابایتی ` +
        'آپلود فایل استاتیک در پلن Hobby ورسل بیشتر است.',
    )
    logger.warn('    یکی از این دو راه: در build تقسیم شود (پیش‌فرض) یا با SHENAVA_MODEL_MAX_BUILD_BYTES فایل بزرگ بیرون بماند')
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
