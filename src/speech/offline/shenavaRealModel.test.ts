/**
 * Runs the **real** Shenava files (no stand-ins) and prints/asserts the shapes the engine feeds.
 *
 * Skipped unless the model files are on disk, so `npm test` stays offline-friendly. CI runs it after
 * downloading the model:
 *
 *   SHENAVA_MODEL_DIR=public/models/shenava SHENAVA_REAL_ENCODER=1 \
 *     npx vitest run src/speech/offline/shenavaRealModel.test.ts
 *
 * What it proves, on real bytes:
 *   1. the decoder/joiner signatures (`inputNames`, `inputMetadata`, `outputNames`, `outputMetadata`) —
 *      the same lines the browser worker logs before its first inference,
 *   2. the encoder's chunked parts join back into the exact 131 MB file (size + SHA-256 from
 *      `model-parts.json`, using the browser's `assembleModelParts`),
 *   3. one predictor + joint step runs against the real sessions (no `OrtRun` shape error),
 *   4. with `SHENAVA_REAL_ENCODER=1`: a real end-to-end transcription of a short synthetic signal —
 *      log-mel → the real encoder → greedy RNNT decoding with the real decoder and joiner.
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import * as ort from 'onnxruntime-web/wasm'
import { describe, expect, it } from 'vitest'

import { decodeWavPcm16 } from './__fixtures__/wav'
import { computeLogMel } from './features'
import { assembleModelParts } from './modelParts'
import { readMetadataInt, readOnnxMetadata } from './onnxMetadata'
import { greedyDecodeNemo } from './rnnt'
import { parsePartsManifest, partsForFile, SHENAVA_PARTS_FILE } from './shenavaModel'
import { decodeTokens, parseTokens } from './tokenizer'
import { createTransducerRuntime, describeTransducerPlan, tensorSpecs } from './transducerRuntime'

ort.env.wasm.numThreads = 1

const MODEL_DIR = process.env.SHENAVA_MODEL_DIR ?? 'public/models/shenava'
const has = (name: string): boolean => existsSync(join(MODEL_DIR, name))
const present = has('decoder.int8.onnx') && has('joiner.int8.onnx') && has('tokens.txt')
const withEncoder = process.env.SHENAVA_REAL_ENCODER === '1'

function readBytes(name: string): Uint8Array<ArrayBuffer> {
  const buffer = readFileSync(join(MODEL_DIR, name))
  return new Uint8Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer)
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function createSession(bytes: Uint8Array): Promise<ort.InferenceSession> {
  return ort.InferenceSession.create(bytes, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' })
}

function signatureOf(session: ort.InferenceSession): string {
  const input = tensorSpecs(session, 'input')
    .map((spec) => `${spec.name}:${spec.type}[${spec.shape.map((dim) => (typeof dim === 'number' ? dim : '?')).join(',')}]`)
    .join(' ')
  const output = tensorSpecs(session, 'output')
    .map((spec) => `${spec.name}:${spec.type}[${spec.shape.map((dim) => (typeof dim === 'number' ? dim : '?')).join(',')}]`)
    .join(' ')
  return `inputs { ${input} } outputs { ${output} }`
}

/** The encoder's own bytes: the single file when it exists, otherwise the parts the browser joins. */
async function loadEncoderBytes(): Promise<Uint8Array> {
  if (has('encoder.int8.onnx')) return readBytes('encoder.int8.onnx')
  const manifest = parsePartsManifest(JSON.parse(readFileSync(join(MODEL_DIR, SHENAVA_PARTS_FILE), 'utf8')))
  const parts = partsForFile(manifest, 'encoder.int8.onnx')
  const entry = manifest?.files?.['encoder.int8.onnx']
  if (!parts || !entry) throw new Error('encoder parts are missing')
  const joined = await assembleModelParts({
    fileName: 'encoder.int8.onnx',
    bytes: entry.bytes,
    parts,
    urlFor: (name) => join(MODEL_DIR, name),
    fetcher: async (url: string) => {
      const body = readBytes(url.split('/').pop()!)
      return { ok: true, status: 200, arrayBuffer: async () => body.buffer as ArrayBuffer }
    },
  })
  expect(joined.byteLength).toBe(entry.bytes)
  return joined
}

describe.skipIf(!present)('Shenava واقعی — امضای مدل و شکل تنسورها', () => {
  it('امضای decoder.int8.onnx و joiner.int8.onnx را چاپ می‌کند', async () => {
    const decoder = await createSession(readBytes('decoder.int8.onnx'))
    const joiner = await createSession(readBytes('joiner.int8.onnx'))

    console.info(`[real] decoder.int8.onnx ${signatureOf(decoder)}`)
    console.info(`[real] joiner.int8.onnx ${signatureOf(joiner)}`)
    console.info(`[real] decoder metadata ${JSON.stringify(readOnnxMetadata(readBytes('decoder.int8.onnx')))}`)

    expect(decoder.inputNames.length).toBeGreaterThanOrEqual(2)
    expect(joiner.inputNames).toHaveLength(2)
  }, 120_000)

  it('یک گام پیش‌بینی و یک گام joiner را روی مدل واقعی اجرا می‌کند', async () => {
    const encoderBytes = has('encoder.int8.onnx') ? readBytes('encoder.int8.onnx') : null
    const partsPath = join(MODEL_DIR, SHENAVA_PARTS_FILE)
    let encoderMetadata = encoderBytes ? readOnnxMetadata(encoderBytes) : {}

    if (!encoderBytes && existsSync(partsPath)) {
      // The browser joins the chunks the same way (`assembleModelParts`) — here the "fetch" reads disk.
      const manifest = parsePartsManifest(JSON.parse(readFileSync(partsPath, 'utf8')))
      const parts = partsForFile(manifest, 'encoder.int8.onnx')
      const entry = manifest?.files?.['encoder.int8.onnx']
      if (parts && entry) {
        const joined = await assembleModelParts({
          fileName: 'encoder.int8.onnx',
          bytes: entry.bytes,
          parts,
          urlFor: (name) => join(MODEL_DIR, name),
          fetcher: async (url: string) => {
            const body = readBytes(url.split('/').pop()!)
            return { ok: true, status: 200, arrayBuffer: async () => body.buffer as ArrayBuffer }
          },
        })
        expect(joined.byteLength).toBe(entry.bytes)
        expect(sha256(joined)).toBe(entry.sha256)
        console.info(`[real] encoder parts joined: ${joined.byteLength} B, sha256=${entry.sha256}`)
        encoderMetadata = readOnnxMetadata(joined)
      }
    }

    const hidden = readMetadataInt(encoderMetadata, 'pred_hidden') ?? 640
    const layers = readMetadataInt(encoderMetadata, 'pred_rnn_layers') ?? 1
    const encoderDim = readMetadataInt(encoderMetadata, 'encoder_dim') ?? 512
    console.info(
      `[real] encoder metadata: vocab_size=${readMetadataInt(encoderMetadata, 'vocab_size')} ` +
        `pred_hidden=${hidden} pred_rnn_layers=${layers} encoder_dim=${encoderDim} ` +
        `subsampling_factor=${readMetadataInt(encoderMetadata, 'subsampling_factor')}`,
    )

    const tokens = parseTokens(readFileSync(join(MODEL_DIR, 'tokens.txt'), 'utf8'))
    const vocabulary = readMetadataInt(encoderMetadata, 'vocab_size') ?? tokens.size - 1
    const vocabSize = vocabulary + 1
    const blankId = vocabSize - 1

    const decoder = await createSession(readBytes('decoder.int8.onnx'))
    const joiner = await createSession(readBytes('joiner.int8.onnx'))
    const runtime = createTransducerRuntime({
      decoder,
      joiner,
      encoderDim,
      blankId,
      layers,
      hidden,
      decoderMetadata: readOnnxMetadata(readBytes('decoder.int8.onnx')),
    })

    await runtime.reset()
    const decoderOut = await runtime.predict(blankId)
    expect(decoderOut.length).toBeGreaterThan(0)

    // One synthetic encoded frame, exactly the shape the encoder produces: [1, dim, 1].
    const frame = new Float32Array(encoderDim)
    const logits = await runtime.join(frame, decoderOut)
    expect(logits.length).toBe(vocabSize)
    console.info(`[real] predictor out=${decoderOut.length} · joiner logits=${logits.length} · blank=${blankId}`)
  }, 300_000)

  it.skipIf(!withEncoder)('روی یک صدای کوچک، کل مسیر را با مدل واقعی اجرا می‌کند', async () => {
    const encoderBytes = await loadEncoderBytes()

    const metadata = readOnnxMetadata(encoderBytes)
    const hidden = readMetadataInt(metadata, 'pred_hidden') ?? 640
    const layers = readMetadataInt(metadata, 'pred_rnn_layers') ?? 1
    const vocabulary = readMetadataInt(metadata, 'vocab_size') ?? parseTokens(readFileSync(join(MODEL_DIR, 'tokens.txt'), 'utf8')).size - 1
    const vocabSize = vocabulary + 1
    const blankId = vocabSize - 1

    // "Small audio": half a second of a quiet tone, no file needed.
    const samples = 8000
    const pcm = new Float32Array(samples)
    for (let i = 0; i < samples; i += 1) pcm[i] = 0.04 * Math.sin((2 * Math.PI * 180 * i) / 16_000)
    const { features, frames, dim } = computeLogMel(pcm)
    expect(frames).toBeGreaterThan(0)
    console.info(`[real] log-mel: frames=${frames} dim=${dim}`)

    const encoder = await createSession(encoderBytes)
    const channelFirst = new Float32Array(frames * dim)
    for (let t = 0; t < frames; t += 1) {
      for (let d = 0; d < dim; d += 1) channelFirst[d * frames + t] = features[t * dim + d]!
    }
    // The real encoder wants an int64 length (the worker retries int32 → int64 the same way).
    const runEncoder = async (dtype: 'int32' | 'int64') =>
      encoder.run({
        audio_signal: new ort.Tensor('float32', channelFirst, [1, dim, frames]),
        length:
          dtype === 'int64'
            ? new ort.Tensor('int64', BigInt64Array.from([BigInt(frames)]), [1])
            : new ort.Tensor('int32', Int32Array.from([frames]), [1]),
      })

    let encoded: ort.InferenceSession.OnnxValueMapType
    let lengthDtype: 'int32' | 'int64' = 'int32'
    try {
      encoded = await runEncoder('int32')
    } catch {
      lengthDtype = 'int64'
      encoded = await runEncoder('int64')
    }
    console.info(`[real] encoder length dtype: ${lengthDtype}`)
    const encodedOut = encoded[encoder.outputNames[0]!] as ort.Tensor
    const shape = (encodedOut.dims as readonly number[]).slice()
    console.info(`[real] encoder output: [${shape.join(', ')}]`)
    expect(shape).toHaveLength(3)
    expect(shape[1]).toBeGreaterThan(0)

    const encoderDim = shape[1]!
    const encoderFrames = shape[2]!
    const flat = encodedOut.data as Float32Array
    const rowMajor = new Float32Array(encoderFrames * encoderDim)
    for (let t = 0; t < encoderFrames; t += 1) {
      for (let d = 0; d < encoderDim; d += 1) rowMajor[t * encoderDim + d] = flat[d * encoderFrames + t]!
    }

    const decoder = await createSession(readBytes('decoder.int8.onnx'))
    const joiner = await createSession(readBytes('joiner.int8.onnx'))
    const runtime = createTransducerRuntime({
      decoder,
      joiner,
      encoderDim,
      blankId,
      layers,
      hidden,
      decoderMetadata: readOnnxMetadata(readBytes('decoder.int8.onnx')),
    })
    const result = await greedyDecodeNemo(rowMajor, encoderFrames, encoderDim, runtime, { blankId })
    console.info(
      `[real] greedy decode: ${result.tokenIds.length} token(s) over ${result.frames} frame(s) — ids=[${result.tokenIds.join(',')}]`,
    )

    expect(result.blankId).toBe(blankId)
    expect(result.tokenIds.every((id) => id >= 0 && id < vocabSize)).toBe(true)
  }, 900_000)

  it.skipIf(!withEncoder)('روی یک فایل صوتی واقعی فارسی متن تولید می‌کند (متن · توکن · زمان · شکل‌ها)', async () => {
    // A real Persian sentence, committed next to this test (`__fixtures__/persian-command.wav`):
    // «یک فاکتور برای آقای رضایی به مبلغ دویست هزار تومان ثبت کن. موجودی انبار را هم نشان بده.»
    const wavBytes = new Uint8Array(readFileSync(new URL('./__fixtures__/persian-command.wav', import.meta.url)))
    const audio = decodeWavPcm16(wavBytes)
    let peak = 0
    let sumSquares = 0
    for (const sample of audio.samples) {
      peak = Math.max(peak, Math.abs(sample))
      sumSquares += sample * sample
    }
    console.info(
      `[persian] wav: ${(audio.samples.length / audio.sampleRate).toFixed(2)} s · ${audio.sampleRate} Hz · ` +
        `${audio.channels}ch · ${audio.samples.length} samples · peak=${peak.toFixed(3)} · ` +
        `rms=${Math.sqrt(sumSquares / audio.samples.length).toFixed(3)}`,
    )

    const melStart = performance.now()
    const { features, frames, dim } = computeLogMel(audio.samples)
    const melMs = performance.now() - melStart
    console.info(`[persian] log-mel: [1, ${dim}, ${frames}] (${melMs.toFixed(1)} ms)`)
    expect(frames).toBeGreaterThan(0)
    expect(dim).toBe(80)

    const encoderBytes = await loadEncoderBytes()
    const encoderMetadata = readOnnxMetadata(encoderBytes)
    const hidden = readMetadataInt(encoderMetadata, 'pred_hidden') ?? 640
    const layers = readMetadataInt(encoderMetadata, 'pred_rnn_layers') ?? 1
    const tokens = parseTokens(readFileSync(join(MODEL_DIR, 'tokens.txt'), 'utf8'))
    const vocabulary = readMetadataInt(encoderMetadata, 'vocab_size') ?? tokens.size - 1
    const vocabSize = vocabulary + 1
    const blankId = vocabSize - 1

    const encoder = await createSession(encoderBytes)
    const channelFirst = new Float32Array(frames * dim)
    for (let t = 0; t < frames; t += 1) {
      for (let d = 0; d < dim; d += 1) channelFirst[d * frames + t] = features[t * dim + d]!
    }

    // The real encoder wants an int64 length (the worker retries int32 → int64 the same way).
    const runEncoder = async (dtype: 'int32' | 'int64') =>
      encoder.run({
        audio_signal: new ort.Tensor('float32', channelFirst, [1, dim, frames]),
        length:
          dtype === 'int64'
            ? new ort.Tensor('int64', BigInt64Array.from([BigInt(frames)]), [1])
            : new ort.Tensor('int32', Int32Array.from([frames]), [1]),
      })

    const encoderStart = performance.now()
    let encoded: ort.InferenceSession.OnnxValueMapType
    let lengthDtype: 'int32' | 'int64' = 'int32'
    try {
      encoded = await runEncoder('int32')
    } catch {
      lengthDtype = 'int64'
      encoded = await runEncoder('int64')
    }
    const encoderMs = performance.now() - encoderStart
    const encodedOut = encoded[encoder.outputNames[0]!] as ort.Tensor
    const shape = (encodedOut.dims as readonly number[]).slice()
    console.info(
      `[persian] encoder: audio_signal [1, ${dim}, ${frames}] + length ${lengthDtype} → out [${shape.join(', ')}] ` +
        `(${encoderMs.toFixed(1)} ms)`,
    )
    expect(shape).toHaveLength(3)
    expect(shape[0]).toBe(1)
    expect(shape[2]).toBeGreaterThan(0)

    const encoderDim = shape[1]!
    const encoderFrames = shape[2]!
    const flat = encodedOut.data as Float32Array
    const rowMajor = new Float32Array(encoderFrames * encoderDim)
    for (let t = 0; t < encoderFrames; t += 1) {
      for (let d = 0; d < encoderDim; d += 1) rowMajor[t * encoderDim + d] = flat[d * encoderFrames + t]!
    }

    const decoderBytes = readBytes('decoder.int8.onnx')
    const decoder = await createSession(decoderBytes)
    const joiner = await createSession(readBytes('joiner.int8.onnx'))
    const decoderMetadata = readOnnxMetadata(decoderBytes)
    const runtime = createTransducerRuntime({ decoder, joiner, encoderDim, blankId, layers, hidden, decoderMetadata })
    console.info(
      `[persian] plan: ${describeTransducerPlan({ decoder, joiner, encoderDim, blankId, layers, hidden, decoderMetadata })}`,
    )

    const decodeStart = performance.now()
    const result = await greedyDecodeNemo(rowMajor, encoderFrames, encoderDim, runtime, { blankId })
    const decodeMs = performance.now() - decodeStart

    const pieces = result.tokenIds.map((id) => tokens.pieces[id] ?? `<${id}>`)
    const meaningful = pieces.filter((piece) => !/^<[^>]*>$/.test(piece) && piece.replace(/▁/g, '').length > 0).length
    const text = decodeTokens(result.tokenIds, tokens)
    const words = text ? text.split(' ').filter(Boolean).length : 0

    console.info(
      `[persian] greedy decode: ${result.tokenIds.length} token(s) — ${meaningful} معنادار — over ${result.frames} frame(s) ` +
        `(${decodeMs.toFixed(1)} ms)`,
    )
    console.info(`[persian] ids: [${result.tokenIds.join(',')}]`)
    console.info(`[persian] pieces: [${pieces.join('|')}]`)
    console.info(`[persian] متن تشخیص‌داده‌شده: «${text}» (${words} واژه)`)
    console.info(
      `[persian] total: ${(melMs + encoderMs + decodeMs).toFixed(1)} ms · ` +
        `mel=[1,${dim},${frames}] encoder=[1,${encoderDim},${encoderFrames}] joiner decoder_outputs=[1,${hidden},1]`,
    )

    expect(result.frames).toBe(encoderFrames)
    expect(result.blankId).toBe(blankId)
    expect(result.tokenIds.every((id) => id >= 0 && id < vocabSize)).toBe(true)
    expect(result.tokenIds.length).toBeGreaterThan(0)
    expect(meaningful).toBeGreaterThan(0)
    expect(text).not.toBe('')
    expect(/[\u0600-\u06FF]/.test(text)).toBe(true)
  }, 900_000)
})
