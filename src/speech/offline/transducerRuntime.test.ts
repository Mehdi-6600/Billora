/**
 * Runs the *real* ONNX Runtime (the same `onnxruntime-web/wasm` build the worker imports) over tiny
 * stand-in models that declare the signatures of the shipped Shenava files, and over real log-mel
 * features from a synthetic audio buffer.
 *
 * This is the test the device failure asked for:
 *
 *   failed to call OrtRun(). ERROR_CODE: 2, ERROR_MESSAGE: Got invalid dimensions for input:
 *   decoder_outputs for the following indices index: 1 Got: 1 Expected: 640
 *
 * It asserts both halves of the fix: the feed that broke the phone is rejected by a model with the
 * real signature, and the feed the worker now builds (derived from `inputMetadata`) is accepted and
 * decodes a short utterance end to end.
 */

import * as ort from 'onnxruntime-web/wasm'
import { beforeAll, describe, expect, it, vi } from 'vitest'

import { computeLogMel } from './features'
import { greedyDecodeNemo } from './rnnt'
import { createTransducerRuntime, tensorSpecs } from './transducerRuntime'
import { planJoinerFeed } from './transducerShape'
import { tinyDecoderSpec, tinyEncoderSpec, tinyJoinerSpec, tinyOnnxModel } from './__fixtures__/tinyOnnx'

ort.env.wasm.numThreads = 1

const HIDDEN = 640
/** NeMo log-mel bins; the stand-in encoder passes `[1, 80, T]` through, so this is also its output dim. */
const ENCODER_DIM = 80

const quiet = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

async function session(spec: Parameters<typeof tinyOnnxModel>[0]): Promise<ort.InferenceSession> {
  return ort.InferenceSession.create(tinyOnnxModel(spec), { executionProviders: ['wasm'] })
}

/** 0.4 s of a quiet synthetic tone: enough for a couple of log-mel frames. */
function syntheticAudio(samples = 6400): Float32Array {
  const pcm = new Float32Array(samples)
  for (let i = 0; i < samples; i += 1) pcm[i] = 0.05 * Math.sin((2 * Math.PI * 220 * i) / 16_000)
  return pcm
}

describe('createTransducerRuntime با ONNX Runtime واقعی', () => {
  let decoder: ort.InferenceSession
  let joiner: ort.InferenceSession
  let encoder: ort.InferenceSession

  beforeAll(async () => {
    decoder = await session(tinyDecoderSpec({ hidden: HIDDEN, layers: 1 }))
    joiner = await session(tinyJoinerSpec({ dim: ENCODER_DIM, hidden: HIDDEN }))
    encoder = await session(tinyEncoderSpec({ dim: ENCODER_DIM }))
  }, 60_000)

  it('امضای واقعی مدل را همان‌طور که هست گزارش می‌کند', () => {
    expect(decoder.inputNames).toEqual(['targets', 'target_length', 'input_states_1', 'input_states_2'])
    expect(joiner.inputNames).toEqual(['encoder_outputs', 'decoder_outputs'])
    const specs = tensorSpecs(joiner, 'input')
    // NeMo declares both joint inputs channel-first: (`B`, `D`, `T`).
    expect(specs.map((item) => item.shape.join(','))).toEqual(['B,80,T', 'B,640,T'])
  })

  it('خوراک قدیمی ([1, 1, 640]) را رد می‌کند — همان خطای گوشی', async () => {
    const feeds = {
      encoder_outputs: new ort.Tensor('float32', new Float32Array(ENCODER_DIM), [1, ENCODER_DIM, 1]),
      decoder_outputs: new ort.Tensor('float32', new Float32Array(HIDDEN), [1, 1, HIDDEN]),
    }

    // The device error, character for character.
    await expect(joiner.run(feeds)).rejects.toThrow(
      /failed to call OrtRun\(\)\. ERROR_CODE: 2, ERROR_MESSAGE: Got invalid dimensions for input: decoder_outputs[\s\S]*index: 1 Got: 1 Expected: 640/,
    )
  })

  it('خوراک ساخته‌شده از inputMetadata ([1, 640, 1]) را می‌پذیرد', async () => {
    const plan = planJoinerFeed(tensorSpecs(joiner, 'input'), { dim: ENCODER_DIM, hidden: HIDDEN })
    expect(plan.decoderShapes[0]).toEqual([1, HIDDEN, 1])

    const outputs = await joiner.run({
      encoder_outputs: new ort.Tensor('float32', new Float32Array(ENCODER_DIM), [1, ENCODER_DIM, 1]),
      decoder_outputs: new ort.Tensor('float32', new Float32Array(HIDDEN), plan.decoderShapes[0]!),
    })
    expect((outputs.logits as ort.Tensor).dims).toEqual([1, ENCODER_DIM, 1])
  })

  it('روی ویژگی‌های mel یک صدای کوتاه، کل مسیر را با شکل‌های درست اجرا می‌کند', async () => {
    const { features, frames, dim } = computeLogMel(syntheticAudio())
    expect(frames).toBeGreaterThan(0)

    // Step 1: the encoder, exactly like `runEncoder` in the worker ([1, frames, dim] → [1, dim, frames]).
    const channelFirst = new Float32Array(frames * dim)
    for (let t = 0; t < frames; t += 1) {
      for (let d = 0; d < dim; d += 1) channelFirst[d * frames + t] = features[t * dim + d]!
    }
    const encoded = await encoder.run({
      audio_signal: new ort.Tensor('float32', channelFirst, [1, dim, frames]),
      length: new ort.Tensor('int32', Int32Array.from([frames]), [1]),
    })
    const encodedOut = encoded.outputs as ort.Tensor
    expect(encodedOut.dims).toEqual([1, dim, frames])

    // Step 2: greedy RNNT decoding across those frames, with the metadata-driven runtime.
    const runtime = createTransducerRuntime({
      decoder,
      joiner,
      encoderDim: ENCODER_DIM,
      blankId: ENCODER_DIM - 1,
      layers: 1,
      hidden: HIDDEN,
      logger: quiet,
    })
    const result = await greedyDecodeNemo(new Float32Array(encodedOut.data as Float32Array), frames, dim, runtime, {
      blankId: ENCODER_DIM - 1,
    })

    expect(result.blankId).toBe(ENCODER_DIM - 1)
    expect(result.frames).toBe(frames)
    expect(result.tokenIds.every((id) => id >= 0 && id < ENCODER_DIM)).toBe(true)
    // The stand-in decoder only ever feeds `[1, 1]` targets and `[1, 1, 640]` states, i.e. the shapes
    // that were wrong before; ONNX Runtime validating every call is what makes this meaningful.
    expect(quiet.error).not.toHaveBeenCalled()
  }, 60_000)

  it('دیکودر با پنجرهٔ context را با شکل [1, window] می‌خورد', async () => {
    const windowed = await session(tinyDecoderSpec({ hidden: 8, layers: 1, contextWindow: 4 }))
    const runtime = createTransducerRuntime({
      decoder: windowed,
      joiner,
      encoderDim: ENCODER_DIM,
      blankId: ENCODER_DIM - 1,
      layers: 1,
      hidden: HIDDEN,
      logger: quiet,
    })

    await runtime.reset()
    const out = await runtime.predict(3)
    expect(out.length).toBeGreaterThan(0)
    expect(quiet.error).not.toHaveBeenCalled()
    expect(quiet.warn).not.toHaveBeenCalled()
  }, 60_000)
})
