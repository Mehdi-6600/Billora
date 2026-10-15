#!/usr/bin/env node
/**
 * Downloads the Shenava Koochik v1.5 RNNT (int8) model files into `public/models/shenava/`.
 *
 * The files are large (~137 MB together) and are NOT committed to git: run this once on a machine
 * with internet access, then `npm run dev` / `npm run build` serves them from the app itself, which
 * is what makes the offline engine work without any network at inference time.
 *
 * Every file is verified against the size and SHA-256 published in the Hugging Face repository
 * (https://huggingface.co/Reza2kn/Shenava-Koochik-v1.5-RNNT-sherpa-onnx), so a truncated download
 * or a wrong mirror is detected instead of silently producing garbage transcriptions.
 *
 * Usage:
 *   node scripts/download-shenava-model.mjs           # download what is missing
 *   node scripts/download-shenava-model.mjs --check   # only verify what is already there
 *   HF_ENDPOINT=https://hf-mirror.com node scripts/...  # use a mirror when huggingface.co is blocked
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = 'Reza2kn/Shenava-Koochik-v1.5-RNNT-sherpa-onnx'
const REVISION = 'main'
const ENDPOINT = (process.env.HF_ENDPOINT || 'https://huggingface.co').replace(/\/$/, '')
const DESTINATION = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'models', 'shenava')

/** Sizes and SHA-256 values taken from the Hub's LFS metadata (`/api/models/<repo>/tree/main`). */
const FILES = [
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

const checkOnly = process.argv.includes('--check')

function formatBytes(bytes) {
  return bytes >= 1_048_576 ? `${(bytes / 1_048_576).toFixed(1)} MB` : `${(bytes / 1024).toFixed(1)} KB`
}

async function sha256Of(path) {
  const hash = createHash('sha256')
  hash.update(await readFile(path))
  return hash.digest('hex')
}

async function inspect(file) {
  const path = join(DESTINATION, file.name)
  try {
    const info = await stat(path)
    if (info.size !== file.bytes) return { ok: false, reason: `حجم ${formatBytes(info.size)} است، باید ${formatBytes(file.bytes)} باشد` }
    if (file.sha256) {
      const digest = await sha256Of(path)
      if (digest !== file.sha256) return { ok: false, reason: `SHA-256 ناهمخوان (${digest.slice(0, 16)}…)` }
    }
    return { ok: true, path }
  } catch {
    return { ok: false, reason: 'فایل موجود نیست' }
  }
}

async function describeRemote(url) {
  try {
    const response = await fetch(url, { method: 'HEAD' })
    return `${response.status} ${response.statusText}`.trim()
  } catch (error) {
    return `خطای شبکه: ${error?.message ?? error}`
  }
}

async function download(file) {
  const url = `${ENDPOINT}/${REPO}/resolve/${REVISION}/${file.name}`
  const target = join(DESTINATION, file.name)
  const temporary = `${target}.part`

  process.stdout.write(`⬇  ${file.name} (${formatBytes(file.bytes)}) … `)
  const response = await fetch(url)
  if (!response.ok || !response.body) {
    const status = await describeRemote(url)
    throw new Error(`${file.name}: HTTP ${response.status} از ${url}\n   پاسخ HEAD: ${status}`)
  }

  const chunks = []
  let loaded = 0
  for await (const chunk of response.body) {
    chunks.push(chunk)
    loaded += chunk.length
    if (loaded % (8 * 1024 * 1024) < chunk.length) process.stdout.write(`\r⬇  ${file.name} ${formatBytes(loaded)}`)
  }
  const buffer = Buffer.concat(chunks)
  process.stdout.write(`\r⬇  ${file.name} ${formatBytes(loaded)} → بررسی…\n`)

  if (buffer.length !== file.bytes) {
    throw new Error(`${file.name}: حجم دریافتی ${formatBytes(buffer.length)} است، انتظار ${formatBytes(file.bytes)} بود`)
  }
  if (file.sha256) {
    const digest = createHash('sha256').update(buffer).digest('hex')
    if (digest !== file.sha256) {
      throw new Error(`${file.name}: SHA-256 ناهمخوان\n   دریافت‌شده: ${digest}\n   انتظار:    ${file.sha256}`)
    }
    process.stdout.write(`   SHA-256 تأیید شد: ${digest}\n`)
  }

  await writeFile(temporary, buffer)
  await rename(temporary, target)
  return target
}

async function main() {
  await mkdir(DESTINATION, { recursive: true })
  console.log(`مخزن مدل: ${ENDPOINT}/${REPO}`)
  console.log(`مقصد:     ${DESTINATION}`)
  if (checkOnly) console.log('حالت: فقط بررسی فایل‌های موجود')

  let failed = false
  for (const file of FILES) {
    const current = await inspect(file)
    if (current.ok) {
      console.log(`✔  ${file.name} — از قبل سالم است (${formatBytes(file.bytes)})`)
      continue
    }
    if (checkOnly) {
      console.log(`✘  ${file.name} — ${current.reason}`)
      failed = true
      continue
    }
    console.log(`…  ${file.name} — ${current.reason}`)
    try {
      const path = await download(file)
      console.log(`✔  ذخیره شد: ${path}`)
    } catch (error) {
      failed = true
      console.error(`✘  ${file.name}: ${error.message}`)
      console.error('   اگر دسترسی به huggingface.co محدود است، HF_ENDPOINT را تنظیم کنید یا فایل را دستی در همین مسیر بگذارید.')
    }
  }

  if (failed) {
    console.error('\nبرخی فایل‌ها ناقص یا ناموجود هستند؛ موتور آفلاین تا تکمیل آن‌ها غیرفعال می‌ماند.')
    process.exitCode = 1
    return
  }
  console.log('\nهمهٔ فایل‌های مدل آماده‌اند. موتور آفلاین در صفحهٔ فاکتور فعال است.')
}

await main()
