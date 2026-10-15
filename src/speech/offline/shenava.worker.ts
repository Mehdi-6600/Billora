/**
 * Offline Persian speech recognition worker (Shenava Koochik v1.5 RNNT, int8, onnxruntime-web).
 *
 * Everything runs on-device: the 132 MB int8 transducer is read from same-origin URLs (and cached
 * in the Cache API so a reload does not download it again), then ONNX Runtime Web executes
 * encoder + prediction network + joiner inside this worker, so the UI thread never blocks.
 *
 * Pipeline (ported from sherpa-onnx's NeMo transducer implementation, which this export targets):
 *   1. NeMo log-mel features, 80 bins, 16 kHz  → `features.ts`
 *   2. `encoder.onnx`: [1, frames, 80] → [1, dim, encodedFrames]
 *   3. greedy RNNT decode with `decoder.onnx` + `joiner.onnx`, blank = last token → `rnnt.ts`
 *   4. SentencePiece pieces joined into text → `tokenizer.ts`
 */

import * as ort from 'onnxruntime-web/wasm'
import { computeLogMel } from './features'
import { assembleModelParts } from './modelParts'
import { readMetadataInt, readOnnxMetadata, type OnnxMetadata } from './onnxMetadata'
import { greedyDecodeNemo } from './rnnt'
import {
  currentBaseHref,
  SHENAVA_PARTS_FILE,
  parsePartsManifest,
  partsForFile,
  resolveShenavaWorkerUrls,
  SHENAVA_CACHE_NAME,
  SHENAVA_MODEL_FILES,
  type ShenavaModelFile,
} from './shenavaModel'
import { decodeTokens, parseTokens, type TokenTable } from './tokenizer'
import {
  createTransducerRuntime,
  describeTransducerPlan,
  logSignatures,
  makeTensor,
  typedOutput,
} from './transducerRuntime'
import type { ShenavaEngineInfo, ShenavaMetrics, ShenavaWorkerRequest, ShenavaWorkerResponse } from './shenavaProtocol'

declare const self: {
  onmessage: ((event: MessageEvent<ShenavaWorkerRequest>) => void) | null
  postMessage: (message: ShenavaWorkerResponse) => void
  close: () => void
  crossOriginIsolated?: boolean
  location?: { origin?: string; href?: string }
  navigator?: { hardwareConcurrency?: number }
}

/** Long utterances are cut off; Billora commands are a few words. */
const MAX_AUDIO_SECONDS = 30

type ModelOrigin = 'cache' | 'network' | 'hub'

interface LoadedBytes {
  /** Plain (non-shared) buffer: `Response` bodies and ONNX Runtime both need `ArrayBuffer`. */
  bytes: Uint8Array<ArrayBuffer>
  source: ModelOrigin
}

interface ByteCandidate {
  url: string
  source: 'network' | 'hub'
}

function manifestFile(name: string): ShenavaModelFile {
  const entry = SHENAVA_MODEL_FILES.find((file) => file.name === name)
  if (!entry) throw new Error(`unknown model file: ${name}`)
  return entry
}

async function sha256Hex(bytes: Uint8Array): Promise<string | null> {
  try {
    if (typeof crypto === 'undefined' || !crypto.subtle) return null
    // `bytes.buffer` is a plain ArrayBuffer here (the worker never uses SharedArrayBuffer views).
    const digest = await crypto.subtle.digest('SHA-256', bytes.buffer as ArrayBuffer)
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
  } catch {
    return null
  }
}

/**
 * A truncated or swapped download would silently produce garbage transcriptions, so the size is
 * always checked and the SHA-256 (taken from the Hub's LFS metadata) as well whenever the browser
 * exposes WebCrypto.
 */
async function verifyModelBytes(bytes: Uint8Array, file: ShenavaModelFile): Promise<void> {
  if (bytes.byteLength !== file.bytes) {
    throw new Error(`${file.name}: ${bytes.byteLength} bytes received, ${file.bytes} expected`)
  }
  if (!file.sha256) return
  const digest = await sha256Hex(bytes)
  if (digest && digest !== file.sha256) {
    throw new Error(`${file.name}: SHA-256 mismatch (got ${digest.slice(0, 12)}…)`)
  }
}

let encoder: ort.InferenceSession | null = null
let decoder: ort.InferenceSession | null = null
let joiner: ort.InferenceSession | null = null
let tokenTable: TokenTable | null = null
let info: ShenavaEngineInfo | null = null
let int64Lengths = false
/** `metadata_props` of `decoder.int8.onnx`: NeMo writes `context_size`/`blank_id` there. */
let decoderMetadata: OnnxMetadata = {}

async function openCache(): Promise<Cache | null> {
  try {
    if (typeof caches === 'undefined') return null
    return await caches.open(SHENAVA_CACHE_NAME)
  } catch {
    return null
  }
}

/**
 * Fetches one URL and returns its bytes, with the same size/hash verification every source gets.
 */
async function fetchCandidate(candidate: ByteCandidate, file: ShenavaModelFile): Promise<LoadedBytes> {
  const response = await fetch(candidate.url)
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  await verifyModelBytes(bytes, file)
  return { bytes, source: candidate.source === 'hub' ? 'hub' : 'network' }
}

async function loadBytes(
  fileName: string,
  candidates: readonly ByteCandidate[],
  useCache: boolean,
  parts: readonly { name: string; bytes: number }[] | null = null,
): Promise<LoadedBytes> {
  const file = manifestFile(fileName)
  const cacheKey = candidates[0]!.url
  const cache = useCache ? await openCache() : null

  // A cache hit is the normal path once the model has been installed or downloaded once.
  if (cache) {
    const hit = await cache.match(cacheKey)
    if (hit) {
      const buffer = await hit.arrayBuffer()
      if (buffer.byteLength === file.bytes) return { bytes: new Uint8Array(buffer), source: 'cache' }
      await cache.delete(cacheKey).catch(() => undefined)
    }
  }

  const store = async (bytes: Uint8Array<ArrayBuffer>) => {
    if (!cache) return
    try {
      await cache.put(cacheKey, new Response(bytes, { headers: { 'Content-Type': 'application/octet-stream' } }))
    } catch {
      // Quota or private-mode failures are not fatal: inference still works from this copy.
    }
  }

  const local = candidates.filter((candidate) => candidate.source !== 'hub')
  const remote = candidates.filter((candidate) => candidate.source === 'hub')
  let lastError: Error | null = null

  for (const candidate of local) {
    try {
      const loaded = await fetchCandidate(candidate, file)
      await store(loaded.bytes)
      return loaded
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
    }
  }

  // Same-origin chunks come before any third-party host: they are the offline-safe route and they
  // are what makes a split install work even where the upstream host is unreachable.
  if (parts && parts.length > 0 && local.length > 0) {
    try {
      // `verify` is the very same size + SHA-256 check a single-file download gets.
      const bytes = await assembleModelParts({
        fileName: file.name,
        bytes: file.bytes,
        parts,
        urlFor: (name) => local[0]!.url.replace(/[^/]*$/, name),
        verify: (assembled) => verifyModelBytes(assembled, file),
      })
      await store(bytes)
      return { bytes, source: 'network' }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
    }
  }

  for (const candidate of remote) {
    try {
      const loaded = await fetchCandidate(candidate, file)
      await store(loaded.bytes)
      return loaded
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
    }
  }

  throw new Error(`${fileName}: ${lastError?.message ?? 'could not be loaded'}`)
}

async function loadText(
  fileName: string,
  candidates: readonly ByteCandidate[],
  useCache: boolean,
): Promise<{ text: string; source: ModelOrigin }> {
  const file = manifestFile(fileName)
  const cacheKey = candidates[0]!.url
  const cache = useCache ? await openCache() : null
  if (cache) {
    const hit = await cache.match(cacheKey)
    if (hit) {
      const text = await hit.text()
      if (text.split('\n').filter((line) => line.trim().length > 0).length > 100) {
        return { text, source: 'cache' }
      }
      await cache.delete(cacheKey).catch(() => undefined)
    }
  }

  let lastError: Error | null = null
  for (const candidate of candidates) {
    try {
      const response = await fetch(candidate.url)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const text = await response.text()
      if (text.trim().length === 0) throw new Error('empty response')
      if (file.bytes > 0) {
        const bytes = new TextEncoder().encode(text)
        if (bytes.byteLength !== file.bytes) {
          throw new Error(`${bytes.byteLength} bytes received, ${file.bytes} expected`)
        }
      }
      if (cache) {
        try {
          await cache.put(cacheKey, new Response(text, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } }))
        } catch {
          // Ignored: see above.
        }
      }
      return { text, source: candidate.source === 'hub' ? 'hub' : 'network' }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
    }
  }
  throw new Error(`${fileName}: ${lastError?.message ?? 'could not be loaded'}`)
}

function tensorDtype(session: ort.InferenceSession, inputName: string): 'int32' | 'int64' | 'float32' | null {
  try {
    const metadata = session.inputMetadata as readonly { name?: string; type?: string }[] | undefined
    const entry = metadata?.find((item) => item.name === inputName)
    const type = entry?.type
    if (!type) return null
    if (type.includes('int64')) return 'int64'
    if (type.includes('int32')) return 'int32'
    if (type.includes('float')) return 'float32'
    return null
  } catch {
    return null
  }
}

/** [1, frames, dim] row-major → [1, dim, frames] (NeMo encoders take channel-first features). */
function transposeFeatures(features: Float32Array, frames: number, dim: number): Float32Array {
  const out = new Float32Array(frames * dim)
  for (let t = 0; t < frames; t += 1) {
    for (let d = 0; d < dim; d += 1) out[d * frames + t] = features[t * dim + d]!
  }
  return out
}

async function runEncoder(features: Float32Array, frames: number, dim: number): Promise<{ data: Float32Array; frames: number; dim: number }> {
  if (!encoder) throw new Error('encoder session is not ready')
  const inputNames = encoder.inputNames
  const outputNames = encoder.outputNames
  const lengthDtype = int64Lengths ? 'int64' : 'int32'

  const feeds: Record<string, ort.Tensor> = {
    [inputNames[0]!]: new ort.Tensor('float32', transposeFeatures(features, frames, dim), [1, dim, frames]),
    [inputNames[1]!]: makeTensor([frames], [1], lengthDtype),
  }
  let outputs: ort.InferenceSession.OnnxValueMapType
  try {
    outputs = await encoder.run(feeds)
  } catch (error) {
    if (lengthDtype === 'int32') {
      int64Lengths = true
      feeds[inputNames[1]!] = makeTensor([frames], [1], 'int64')
      outputs = await encoder.run(feeds)
    } else {
      throw error
    }
  }

  const encoded = outputs[outputNames[0]!] as ort.Tensor
  const lengths = outputs[outputNames[1]!] as ort.Tensor
  const shape = encoded.dims as readonly number[]
  if (shape.length !== 3) throw new Error(`unexpected encoder output rank: [${shape.join(', ')}]`)

  // NeMo encoders return channel-first output: [batch, dim, time].
  const channels = shape[1]!
  const encodedFrames = shape[2]!
  const flat = typedOutput(encoded)
  const rowMajor = new Float32Array(encodedFrames * channels)
  for (let t = 0; t < encodedFrames; t += 1) {
    for (let d = 0; d < channels; d += 1) rowMajor[t * channels + d] = flat[d * encodedFrames + t]!
  }

  const lengthsData = lengths.data as ArrayLike<bigint | number>
  const declared = Math.min(encodedFrames, Math.max(1, Number(lengthsData[0] ?? encodedFrames)))
  return { data: rowMajor, frames: declared, dim: channels }
}

function numberFromMetadata(metadata: OnnxMetadata, key: string, fallback: number): number {
  const value = readMetadataInt(metadata, key)
  return value !== null && value > 0 ? value : fallback
}

async function loadPartsManifest(urlFor: (fileName: string) => string) {
  try {
    const response = await fetch(urlFor(SHENAVA_PARTS_FILE))
    if (!response.ok) return null
    return parsePartsManifest(await response.json())
  } catch {
    // No manifest (or an unreachable one) simply means every file is a single static file.
    return null
  }
}

async function initialise(request: Extract<ShenavaWorkerRequest, { type: 'init' }>): Promise<ShenavaEngineInfo> {
  ort.env.logLevel = 'error'
  ort.env.wasm.numThreads = request.threads

  // URL building lives in `shenavaModel.ts` so it is unit tested; it resolves everything against an
  // ABSOLUTE base (a relative base such as `/models/shenava/` is rejected by browsers and used to
  // break the engine before it fetched anything).
  const urls = resolveShenavaWorkerUrls({
    baseUrl: request.baseUrl ?? '/',
    baseHref: request.baseHref ?? currentBaseHref(self) ?? currentBaseHref(),
    modelBaseUrl: request.modelBaseUrl,
    remoteModelUrls: request.remoteModelUrls,
  })
  // The runtime files are copied into `<base>ort/` by the Vite plugin in `vite.config.ts`, so the
  // engine never falls back to a CDN (which would break offline use and cross-origin isolation).
  ort.env.wasm.wasmPaths = urls.ortDirectoryUrl
  const candidates = (name: string): ByteCandidate[] => urls.candidatesFor(name)

  // Chunks are described by a tiny same-origin manifest that the build writes next to the model;
  // without it (an ordinary build) every file is simply a single static file.
  const partsManifest = await loadPartsManifest(urls.modelFileUrl)
  const partsOf = (name: string): { name: string; bytes: number }[] | null => {
    const file = manifestFile(name)
    return partsForFile(partsManifest, name, file.bytes)
  }

  const encoderFile = await loadBytes('encoder.int8.onnx', candidates('encoder.int8.onnx'), request.useCache, partsOf('encoder.int8.onnx'))
  const decoderFile = await loadBytes('decoder.int8.onnx', candidates('decoder.int8.onnx'), request.useCache, partsOf('decoder.int8.onnx'))
  const joinerFile = await loadBytes('joiner.int8.onnx', candidates('joiner.int8.onnx'), request.useCache, partsOf('joiner.int8.onnx'))
  const tokens = await loadText('tokens.txt', candidates('tokens.txt'), request.useCache)
  tokenTable = parseTokens(tokens.text)

  const metadata = readOnnxMetadata(encoderFile.bytes)
  const sessionOptions: ort.InferenceSession.SessionOptions = {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
  }

  encoder = await ort.InferenceSession.create(encoderFile.bytes, sessionOptions)
  decoder = await ort.InferenceSession.create(decoderFile.bytes, sessionOptions)
  joiner = await ort.InferenceSession.create(joinerFile.bytes, sessionOptions)

  // ONNX Runtime Web can load a model's `metadata_props`, but the runtime API never exposes them, so
  // they are read straight from the bytes (NeMo writes `context_size`, `blank_id`, `vocab_size`, …).
  decoderMetadata = readOnnxMetadata(decoderFile.bytes)
  logSignatures(decoder, joiner)
  console.info(`[shenava] decoder.int8.onnx metadata: ${JSON.stringify(decoderMetadata)}`)

  const subsamplingFactor = numberFromMetadata(metadata, 'subsampling_factor', 8)
  const predRnnLayers = numberFromMetadata(metadata, 'pred_rnn_layers', 1)
  const predHidden = numberFromMetadata(metadata, 'pred_hidden', 640)
  const metadataVocab = readMetadataInt(metadata, 'vocab_size')
  const vocabSize = metadataVocab !== null && metadataVocab > 0 ? metadataVocab + 1 : tokenTable.size
  if (vocabSize < 2) throw new Error('could not determine the vocabulary size from encoder.int8.onnx or tokens.txt')

  let blankId = vocabSize - 1
  const metadataBlankId = readMetadataInt(decoderMetadata, 'blank_id') ?? readMetadataInt(decoderMetadata, 'blank_idx')
  if (metadataBlankId !== null && metadataBlankId >= 0 && metadataBlankId < vocabSize) {
    if (metadataBlankId !== blankId) {
      console.warn(
        `[shenava] decoder metadata says blank_id=${metadataBlankId} but the last token id is ${blankId}; ` +
          'using the metadata value (it describes how the model was trained).',
      )
    }
    blankId = metadataBlankId
  }
  if (tokenTable.size !== vocabSize) {
    // sherpa-onnx refuses such files, so report the mismatch instead of decoding nonsense.
    throw new Error(`tokens.txt has ${tokenTable.size} entries but the encoder metadata expects ${vocabSize}`)
  }

  const encoderDim = numberFromMetadata(metadata, 'encoder_dim', 512)

  int64Lengths = tensorDtype(encoder, encoder.inputNames[1]!) === 'int64'

  info = {
    vocabSize,
    blankId,
    subsamplingFactor,
    predRnnLayers,
    predHidden,
    encoderDim,
    threads: request.threads,
    crossOriginIsolated: self.crossOriginIsolated === true,
    hardwareConcurrency: self.navigator?.hardwareConcurrency ?? 1,
    sources: {
      'encoder.int8.onnx': encoderFile.source,
      'decoder.int8.onnx': decoderFile.source,
      'joiner.int8.onnx': joinerFile.source,
      'tokens.txt': tokens.source,
    },
    // Printed on the diagnostic page: the shapes the runtime will feed, read from the model itself.
    transducerPlan: describeTransducerPlan({
      decoder,
      joiner,
      encoderDim,
      blankId,
      layers: predRnnLayers,
      hidden: predHidden,
      decoderMetadata,
    }),
  }
  return info
}

async function transcribe(pcm: Float32Array): Promise<{ text: string; tokenIds: number[]; metrics: ShenavaMetrics }> {
  if (!encoder || !decoder || !joiner || !info || !tokenTable) throw new Error('engine is not initialised')

  const startedAt = performance.now()
  const maxSamples = MAX_AUDIO_SECONDS * 16_000
  const samples = pcm.length > maxSamples ? pcm.subarray(0, maxSamples) : pcm

  const featureStart = performance.now()
  const { features, frames, dim } = computeLogMel(samples)
  if (frames === 0) throw new Error('audio is empty')
  const featureMs = performance.now() - featureStart

  const encoderStart = performance.now()
  const encoded = await runEncoder(features, frames, dim)
  const encoderMs = performance.now() - encoderStart

  const decodeStart = performance.now()
  const runtime = createTransducerRuntime({
    decoder,
    joiner,
    encoderDim: encoded.dim,
    blankId: info.blankId,
    layers: info.predRnnLayers,
    hidden: info.predHidden,
    decoderMetadata,
  })
  let firstTokenMs: number | null = null
  const result = await greedyDecodeNemo(
    encoded.data,
    encoded.frames,
    encoded.dim,
    {
      vocabSize: info.vocabSize,
      reset: runtime.reset,
      predict: (tokenId: number) => runtime.predict(tokenId),
      join: async (frame: Float32Array, decoderOut: Float32Array) => {
        const logits = await runtime.join(frame, decoderOut)
        if (firstTokenMs === null) firstTokenMs = performance.now() - decodeStart
        return logits
      },
    },
    { blankId: info.blankId },
  )
  const decodeMs = performance.now() - decodeStart

  const text = decodeTokens(result.tokenIds, tokenTable)
  return {
    text,
    tokenIds: result.tokenIds,
    metrics: {
      audioMs: (samples.length / 16_000) * 1000,
      featureMs,
      encoderMs,
      decodeMs,
      totalMs: performance.now() - startedAt,
      featureFrames: frames,
      encoderFrames: encoded.frames,
      tokens: result.tokenIds.length,
      firstTokenMs,
    },
  }
}

self.onmessage = async (event: MessageEvent<ShenavaWorkerRequest>) => {
  const request = event.data
  try {
    if (request.type === 'init') {
      const engineInfo = await initialise(request)
      self.postMessage({ type: 'ready', info: engineInfo })
      return
    }
    if (request.type === 'transcribe') {
      const outcome = await transcribe(request.pcm)
      self.postMessage({ type: 'result', id: request.id, text: outcome.text, tokenIds: outcome.tokenIds, metrics: outcome.metrics })
      return
    }
    if (request.type === 'dispose') {
      await encoder?.release()
      await decoder?.release()
      await joiner?.release()
      encoder = null
      decoder = null
      joiner = null
      info = null
      tokenTable = null
      self.postMessage({ type: 'disposed' })
      self.close()
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (request.type === 'init') self.postMessage({ type: 'init-error', code: 'init-failed', message })
    else if (request.type === 'transcribe') self.postMessage({ type: 'decode-error', id: request.id, message })
    else self.postMessage({ type: 'disposed' })
  }
}
