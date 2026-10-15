#!/usr/bin/env node
/**
 * Shenava model → Vercel Blob (میزبان جایگزین برای فایل ۱۳۱ مگابایتی انکودر).
 *
 * چرا لازم است: پلن Hobby ورسل برای «فایل استاتیک» سقف ۱۰۰ مگابایت دارد، پس انکودر
 * ۱۲۵٫۳ مبی‌بایتی نمی‌تواند در `dist` باشد. این اسکریپت همان چهار فایل را در یک
 * Blob Store عمومی می‌گذارد و آدرس پایهٔ عمومی را چاپ می‌کند؛ کافی است آن آدرس در
 * Environment Variable ورسل به‌عنوان `VITE_SHENAVA_MODEL_BASE_URL` ست شود تا موتور
 * آفلاین، مدل را از همان میزبان بگیرد (مسیر `allowRemoteModel` و probe مدل همین را
 * می‌فهمند). خروجی JSON گزارش (حجم، زمان، آدرس و SHA-256 هر فایل) برای ثبت شواهد است.
 *
 * استفاده:
 *   BLOB_READ_WRITE_TOKEN=vercel_blob_rw_… node scripts/upload-shenava-model.mjs \
 *     --dir=public/models/shenava --prefix=shenava-model --report=blob-report.json
 *
 * نکته: این اسکریپت هیچ‌وقت build یا گردش‌کار را نمی‌شکند؛ بدون توکن با پیام روشن
 * رد می‌شود (کد خروج ۰) و فقط با `--strict` خطا می‌دهد.
 */
import { readFile, stat, writeFile } from 'node:fs/promises'
import * as nodeFs from 'node:fs'
import { join, basename } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  MODEL_FILES,
  formatBytes,
  sha256File,
} from './download-shenava-model.mjs'

export const DEFAULT_PREFIX = 'shenava-model'

/** نام تابع وردی برای تست‌پذیری: بدنهٔ SDK را در تست‌ها جعل می‌کنیم. */
export async function importBlobPut({ importer = (specifier) => import(specifier) } = {}) {
  const mod = await importer('@vercel/blob')
  if (!mod || typeof mod.put !== 'function') {
    throw new Error('@vercel/blob نصب نیست یا تابع put را ندارد')
  }
  return mod.put
}

/**
 * مسیر داخل Blob را می‌سازد (بدون اسلش ابتدایی/انتهایی).
 */
export function blobPathFor(prefix, fileName) {
  const cleanPrefix = String(prefix ?? '')
    .trim()
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
  const cleanName = basename(String(fileName ?? '').trim())
  if (!cleanName) throw new Error('نام فایل خالی است')
  return cleanPrefix ? `${cleanPrefix}/${cleanName}` : cleanName
}

/**
 * از آدرس یک فایل، آدرس پایهٔ پوشه را می‌سازد؛ چیزی که باید در
 * `VITE_SHENAVA_MODEL_BASE_URL` بنشیند (`<base>/<fileName>` باید کار کند).
 */
export function publicBaseUrlFor(fileUrl) {
  const url = new URL(String(fileUrl))
  const segments = url.pathname.split('/').filter(Boolean)
  if (segments.length > 0) segments.pop()
  url.pathname = `/${segments.join('/')}`
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/+$/, '')
}

export function parseArgs(argv = []) {
  const options = {
    dir: 'public/models/shenava',
    prefix: DEFAULT_PREFIX,
    token: undefined,
    report: undefined,
    strict: false,
    quiet: false,
    dryRun: false,
    help: false,
  }

  for (const raw of argv) {
    const arg = String(raw)
    const [flag, ...rest] = arg.split('=')
    const value = rest.join('=')

    switch (flag) {
      case '--dir':
        options.dir = value
        break
      case '--prefix':
        options.prefix = value
        break
      case '--token':
        options.token = value
        break
      case '--report':
        options.report = value
        break
      case '--strict':
        options.strict = true
        break
      case '--quiet':
        options.quiet = true
        break
      case '--dry-run':
        options.dryRun = true
        break
      case '--help':
      case '-h':
        options.help = true
        break
      default:
        throw new Error(`گزینهٔ ناشناخته: ${arg}`)
    }
  }

  return options
}

export function resolveConfiguration({ argv = process.argv.slice(2), env = process.env, cwd = process.cwd() } = {}) {
  const options = parseArgs(argv)
  const token = options.token ?? env.BLOB_READ_WRITE_TOKEN ?? env.VERCEL_BLOB_READ_WRITE_TOKEN ?? ''
  return {
    ...options,
    token,
    dir: join(cwd, options.dir),
    reportPath: options.report ? join(cwd, options.report) : undefined,
  }
}

async function bodyFor(filePath) {
  // لیست تنبل روی فایل (بدون خواندن ۱۳۱ مگابایت در حافظه) وقتی نود پشتیبانی می‌کند.
  if (typeof nodeFs.openAsBlob === 'function') {
    return nodeFs.openAsBlob(filePath, { type: 'application/octet-stream' })
  }
  return new Blob([await readFile(filePath)], { type: 'application/octet-stream' })
}

export async function uploadModel({
  files = MODEL_FILES,
  dir,
  prefix = DEFAULT_PREFIX,
  token,
  put,
  logger = console,
  now = () => Date.now(),
  hashFile = sha256File,
  strict = false,
} = {}) {
  const report = {
    generatedAt: new Date().toISOString(),
    prefix,
    files: [],
    errors: [],
  }
  let baseUrl = null

  if (!token) {
    const message =
      'BLOB_READ_WRITE_TOKEN تنظیم نشده است؛ از Vercel → Storage → Blob یک Store بسازید و توکن را به‌عنوان Secret بگذارید.'
    report.errors.push({ name: '*', message })
    logger.warn(`SKIP  ${message}`)
    if (strict) throw new Error(message)
    return report
  }

  for (const spec of files) {
    const filePath = join(dir, spec.name)
    try {
      const info = await stat(filePath)
      if (!info.isFile()) throw new Error('فایل نیست')
      if (spec.bytes && info.size !== spec.bytes) {
        throw new Error(`حجم ناهمخوان: ${info.size} ≠ ${spec.bytes}`)
      }
      const startedAt = now()
      const body = await bodyFor(filePath)
      const result = await put(blobPathFor(prefix, spec.name), body, {
        access: 'public',
        token,
        contentType: 'application/octet-stream',
        addRandomSuffix: false,
        multipart: true,
        allowOverwrite: true,
      })
      const ms = Math.max(0, now() - startedAt)
      const url = result?.url ?? result?.downloadUrl ?? ''
      if (!url) throw new Error('پاسخ Blob بدون url بود')
      if (!baseUrl) baseUrl = publicBaseUrlFor(url)
      const sha256 = await hashFile(filePath)
      report.files.push({
        name: spec.name,
        bytes: info.size,
        ms,
        sha256,
        url,
        pathname: result?.pathname ?? blobPathFor(prefix, spec.name),
      })
      logger.log(`OK    ${spec.name} → ${url} (${formatBytes(info.size)} در ${ms} ms)`)
    } catch (error) {
      report.errors.push({ name: spec.name, message: error?.message ?? String(error) })
      logger.error(`FAIL  ${spec.name}: ${error?.message ?? error}`)
      if (strict) throw error
    }
  }

  report.baseUrl = baseUrl
  return report
}

const HELP = `
آپلود مدل شنوا در Vercel Blob (میزبان جایگزین برای انکودر بزرگ)

  node scripts/upload-shenava-model.mjs [گزینه‌ها]

  --dir=...      پوشهٔ فایل‌های مدل (پیش‌فرض: public/models/shenava)
  --prefix=...   پیشوند مسیر داخل Blob (پیش‌فرض: shenava-model)
  --token=...    توکن Blob (پیش‌فرض: BLOB_READ_WRITE_TOKEN)
  --report=...   نوشتن گزارش JSON (حجم، زمان، SHA-256، آدرس)
  --dry-run      فقط بررسی فایل‌های محلی و ساخت گزارش، بدون آپلود
  --strict       در صورت خطا با کد ۱ خارج شود
  --quiet        کمترین چاپ
  --help

پس از آپلود، آدرس پایهٔ چاپ‌شده را در Vercel به‌عنوان VITE_SHENAVA_MODEL_BASE_URL ست
کنید و مجدداً deploy کنید؛ سپس «npm run verify:deployed -- <آدرس برنامه>» را اجرا کنید.
`.trim()

export async function main({ argv = process.argv.slice(2), env = process.env, cwd = process.cwd(), logger = console } = {}) {
  const options = resolveConfiguration({ argv, env, cwd })

  if (options.help) {
    logger.log(HELP)
    return { help: true }
  }

  const log = options.quiet
    ? { log() {}, warn: logger.warn.bind(logger), error: logger.error.bind(logger) }
    : logger

  let report
  if (options.dryRun) {
    report = { generatedAt: new Date().toISOString(), prefix: options.prefix, files: [], errors: [], dryRun: true }
    for (const spec of MODEL_FILES) {
      const filePath = join(options.dir, spec.name)
      try {
        const info = await stat(filePath)
        const url = `https://blob.example/${blobPathFor(options.prefix, spec.name)}`
        report.files.push({ name: spec.name, bytes: info.size, ms: 0, sha256: null, url, pathname: blobPathFor(options.prefix, spec.name) })
        log.log(`PLAN  ${spec.name} (${formatBytes(info.size)})`)
      } catch (error) {
        report.errors.push({ name: spec.name, message: error?.message ?? String(error) })
        log.warn(`MISS  ${spec.name}`)
      }
    }
    report.baseUrl = report.files.length > 0 ? publicBaseUrlFor(report.files[0].url) : null
  } else {
    const put = await importBlobPut()
    report = await uploadModel({
      dir: options.dir,
      prefix: options.prefix,
      token: options.token,
      put,
      logger: log,
      strict: options.strict,
    })
  }

  if (options.reportPath) {
    await writeFile(options.reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    logger.log(`نوشته شد: ${options.reportPath}`)
  }

  if (report.baseUrl) {
    logger.log('')
    logger.log('این را در Vercel به‌عنوان Environment Variable بگذارید و دوباره deploy کنید:')
    logger.log(`VITE_SHENAVA_MODEL_BASE_URL=${report.baseUrl}`)
  }
  if (report.errors.length > 0) {
    logger.warn(`${report.errors.length} خطا: ${report.errors.map((entry) => `${entry.name}: ${entry.message}`).join(' | ')}`)
  }

  return report
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href

if (invokedDirectly) {
  main()
    .then((report) => {
      if (report?.errors?.length > 0 && process.argv.includes('--strict')) process.exitCode = 1
    })
    .catch((error) => {
      console.error(error?.message ?? error)
      process.exitCode = 1
    })
}
