import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  blobPathFor,
  importBlobPut,
  main,
  parseArgs,
  publicBaseUrlFor,
  resolveConfiguration,
  uploadModel,
} from './upload-shenava-model.mjs'

const cleanups = []
after(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

const silentLogger = { log() {}, warn() {}, error() {} }

async function makeDir(files) {
  const root = await mkdtemp(join(tmpdir(), 'shenava-upload-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  await mkdir(root, { recursive: true })
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(root, name), content)
  }
  return root
}

describe('آپلود مدل در Vercel Blob — توابع پایه', () => {
  test('مسیر Blob از پیشوند و نام فایل ساخته می‌شود', () => {
    assert.equal(blobPathFor('shenava-model', 'encoder.int8.onnx'), 'shenava-model/encoder.int8.onnx')
    assert.equal(blobPathFor('/shenava-model/', 'encoder.int8.onnx'), 'shenava-model/encoder.int8.onnx')
    assert.equal(blobPathFor('', 'tokens.txt'), 'tokens.txt')
    // نام فایل هرگز نباید مسیر را عوض کند (پیشوند تزریق‌شده توسط کاربر نادیده گرفته می‌شود)
    assert.equal(blobPathFor('p', '../../etc/passwd'), 'p/passwd')
    assert.throws(() => blobPathFor('p', '   '), /نام فایل خالی است/)
  })

  test('آدرس پایهٔ عمومی از آدرس فایل ساخته می‌شود', () => {
    assert.equal(
      publicBaseUrlFor('https://abc.public.blob.vercel-storage.com/shenava-model/encoder.int8.onnx'),
      'https://abc.public.blob.vercel-storage.com/shenava-model',
    )
    assert.equal(
      publicBaseUrlFor('https://cdn.example.com/models/x.onnx?token=1#frag'),
      'https://cdn.example.com/models',
    )
  })

  test('گزینه‌های خط فرمان خوانده می‌شوند و گزینهٔ ناشناخته خطا می‌دهد', () => {
    const options = parseArgs(['--dir=public/models/shenava', '--prefix=p', '--report=r.json', '--strict', '--quiet'])
    assert.equal(options.dir, 'public/models/shenava')
    assert.equal(options.prefix, 'p')
    assert.equal(options.report, 'r.json')
    assert.equal(options.strict, true)
    assert.equal(options.quiet, true)
    assert.throws(() => parseArgs(['--nope']), /گزینهٔ ناشناخته/)
  })

  test('توکن از محیط خوانده می‌شود', () => {
    const config = resolveConfiguration({ argv: [], env: { BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_x' }, cwd: '/tmp' })
    assert.equal(config.token, 'vercel_blob_rw_x')
    const empty = resolveConfiguration({ argv: [], env: {}, cwd: '/tmp' })
    assert.equal(empty.token, '')
  })

  test('نبود @vercel/blob خطای روشن می‌دهد', async () => {
    await assert.rejects(
      () => importBlobPut({ importer: async () => ({}) }),
      /@vercel\/blob نصب نیست/,
    )
  })
})

describe('آپلود مدل در Vercel Blob — اجرا', () => {
  const files = [{ name: 'tiny.onnx', bytes: 3, sha256: null }]

  test('بدون توکن، پیام روشن می‌دهد و خطا نمی‌دهد', async () => {
    const dir = await makeDir({ 'tiny.onnx': 'abc' })
    const report = await uploadModel({ files, dir, token: '', logger: silentLogger })
    assert.equal(report.files.length, 0)
    assert.equal(report.errors.length, 1)
    assert.match(report.errors[0].message, /BLOB_READ_WRITE_TOKEN/)

    await assert.rejects(
      () => uploadModel({ files, dir, token: '', logger: silentLogger, strict: true }),
      /BLOB_READ_WRITE_TOKEN/,
    )
  })

  test('هر فایل آپلود می‌شود، آدرس پایه و هش گزارش می‌شوند', async () => {
    const dir = await makeDir({ 'tiny.onnx': 'abc' })
    const calls = []
    const put = async (pathname, body, options) => {
      calls.push({ pathname, size: body?.size ?? null, options })
      return { url: `https://store.public.blob.vercel-storage.com/${pathname}`, pathname }
    }

    const report = await uploadModel({ files, dir, token: 'tok', put, logger: silentLogger })

    assert.equal(report.errors.length, 0)
    assert.equal(report.files.length, 1)
    assert.equal(report.files[0].bytes, 3)
    assert.equal(report.files[0].sha256, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    assert.equal(report.baseUrl, 'https://store.public.blob.vercel-storage.com/shenava-model')
    assert.equal(calls[0].pathname, 'shenava-model/tiny.onnx')
    assert.equal(calls[0].options.access, 'public')
    assert.equal(calls[0].options.multipart, true)
    assert.equal(calls[0].options.addRandomSuffix, false)
  })

  test('حجم ناهمخوان رد می‌شود (و با strict استثنا می‌دهد)', async () => {
    const dir = await makeDir({ 'tiny.onnx': 'abcd' })
    const put = async (pathname) => ({ url: `https://store.example/${pathname}` })

    const report = await uploadModel({ files, dir, token: 'tok', put, logger: silentLogger })
    assert.equal(report.files.length, 0)
    assert.match(report.errors[0].message, /حجم ناهمخوان/)

    await assert.rejects(
      () => uploadModel({ files, dir, token: 'tok', put, logger: silentLogger, strict: true }),
      /حجم ناهمخوان/,
    )
  })

  test('پاسخ بدون url به‌عنوان خطا ثبت می‌شود', async () => {
    const dir = await makeDir({ 'tiny.onnx': 'abc' })
    const report = await uploadModel({ files, dir, token: 'tok', put: async () => ({}), logger: silentLogger })
    assert.equal(report.errors.length, 1)
    assert.match(report.errors[0].message, /بدون url/)
  })

  test('حالت --dry-run بدون توکن هم فهرست فایل‌ها را می‌سازد', async () => {
    const dir = await makeDir({ 'tiny.onnx': 'abc' })
    const report = await main({
      argv: ['--dir=.', '--dry-run', '--quiet'],
      env: {},
      cwd: dir,
      logger: { log() {}, warn() {}, error() {} },
    })
    assert.equal(report.dryRun, true)
    assert.equal(report.files.length, 0)
    // پوشهٔ خالی است: هر چهار فایل واقعی مدل غایب‌اند و به‌جای آپلود، خطای روشن ثبت می‌شود
    assert.equal(report.errors.length, 4)
    assert.deepEqual(
      report.errors.map((entry) => entry.name).sort(),
      ['decoder.int8.onnx', 'encoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt'],
    )
    assert.match(report.errors[0].message, /ENOENT/)
    assert.equal(report.baseUrl, null)
  })
})
