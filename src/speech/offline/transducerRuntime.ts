/**
 * The transducer decode runtime: prediction network + joint network, driven purely by the *declared*
 * input signature of the loaded ONNX sessions.
 *
 * This module is the fix for the on-device failure
 *
 *   failed to call OrtRun(). ERROR_CODE: 2, ERROR_MESSAGE: Got invalid dimensions for input:
 *   decoder_outputs for the following indices index: 1 Got: 1 Expected: 640
 *
 * The old code fed hard-coded shapes (`[1, 1]` targets, `[1, 1, hidden]` decoder output). NeMo's
 * exported joint network declares both inputs channel-first as `('B','D','T')`, so for a 640-wide
 * predictor `decoder_outputs` must be `[1, 640, 1]`; `transducerShape.ts` derives that from
 * `InferenceSession.inputMetadata` and this module feeds it.
 *
 * It lives outside the worker so a test can run the *real* ONNX Runtime over tiny stand-in models
 * with the same code path the browser uses (`transducerRuntime.test.ts`).
 */

import * as ort from 'onnxruntime-web/wasm'
import type { OnnxMetadata } from './onnxMetadata'
import { readMetadataInt } from './onnxMetadata'
import type { NemoTransducerRuntime } from './rnnt'
import {
  appendContextToken,
  blankContextWindow,
  describeSignature,
  planDecoderFeed,
  planJoinerFeed,
  type TensorDtype,
  type TensorSpec,
} from './transducerShape'

export function makeTensor(
  values: ArrayLike<number>,
  dims: readonly number[],
  dtype: 'int32' | 'int64' | 'float32',
): ort.Tensor {
  if (dtype === 'float32') return new ort.Tensor('float32', Float32Array.from(values), dims)
  if (dtype === 'int64') {
    return new ort.Tensor('int64', BigInt64Array.from(Array.from(values, (value) => BigInt(value))), dims)
  }
  return new ort.Tensor('int32', Int32Array.from(values), dims)
}

/** Copies any float view into a plain ArrayBuffer-backed array (keeps TypeScript happy). */
export function copyFloat32(source: ArrayLike<number>): Float32Array {
  const out = new Float32Array(source.length)
  out.set(source)
  return out
}

export function typedOutput(output: ort.Tensor): Float32Array {
  const data = output.data
  if (data instanceof Float32Array) return data
  return Float32Array.from(data as ArrayLike<number>)
}

/**
 * Narrows `InferenceSession.inputMetadata`/`outputMetadata` down to the plain specs the shape planner
 * consumes. ONNX Runtime Web reports dynamic dimensions as `4294967295`, which the planner turns
 * into `?` (see `transducerShape.ts`).
 */
export function tensorSpecs(session: ort.InferenceSession, direction: 'input' | 'output'): TensorSpec[] {
  const names = direction === 'input' ? session.inputNames : session.outputNames
  const metadata = (direction === 'input' ? session.inputMetadata : session.outputMetadata) as
    | readonly { name?: string; type?: string; shape?: readonly (number | string)[] }[]
    | undefined
  return names.map((name, index) => {
    const entry = metadata?.[index]
    return { name, type: entry?.type ?? 'float32', shape: entry?.shape ? [...entry.shape] : [] }
  })
}

export function feedText(feeds: Record<string, ort.Tensor>): string {
  return Object.entries(feeds)
    .map(([name, tensor]) => `${name}: ${tensor.type}[${(tensor.dims as readonly number[]).join(', ')}]`)
    .join(' · ')
}

/**
 * Logs every model signature: a `failed to call OrtRun()` report names the input but never the shape
 * it expected, so the browser console has to print the signature up front (see the diagnostic page).
 */
export function logSignatures(decoder: ort.InferenceSession, joiner: ort.InferenceSession): void {
  console.info(`[shenava] decoder.int8.onnx inputs: ${describeSignature(tensorSpecs(decoder, 'input'))}`)
  console.info(`[shenava] decoder.int8.onnx outputs: ${describeSignature(tensorSpecs(decoder, 'output'))}`)
  console.info(`[shenava] joiner.int8.onnx inputs: ${describeSignature(tensorSpecs(joiner, 'input'))}`)
  console.info(`[shenava] joiner.int8.onnx outputs: ${describeSignature(tensorSpecs(joiner, 'output'))}`)
}

export interface TransducerRuntimeOptions {
  decoder: ort.InferenceSession
  joiner: ort.InferenceSession
  encoderDim: number
  /** Blank token id (`vocab_size - 1` for NeMo exports, or the decoder metadata's `blank_id`). */
  blankId: number
  /** `pred_rnn_layers` from the encoder metadata; fills a dynamic state dimension. */
  layers: number
  /** `pred_hidden` from the encoder metadata; fills a dynamic predictor dimension. */
  hidden: number
  /** `metadata_props` of `decoder.int8.onnx` (`context_size`, `blank_id`, …). */
  decoderMetadata?: OnnxMetadata
  /** Injectable for tests; defaults to the worker console. */
  logger?: Pick<Console, 'info' | 'warn' | 'error'>
}

export function createTransducerRuntime(options: TransducerRuntimeOptions): NemoTransducerRuntime {
  const { decoder, joiner, encoderDim, blankId, layers, hidden } = options
  const log = options.logger ?? console
  const decoderMetadata = options.decoderMetadata ?? {}
  const vocabulary = blankId + 1

  // `context_size` (NeMo's stateless predictor) is written to the decoder's own metadata when it
  // exists; the declared input shape comes first, metadata second. Which one won is logged.
  const metadataContextSize =
    readMetadataInt(decoderMetadata, 'context_size') ?? readMetadataInt(decoderMetadata, 'context') ?? undefined
  const plan = planDecoderFeed(tensorSpecs(decoder, 'input'), {
    layers,
    hidden,
    blankId,
    metadataContextSize,
    outputs: tensorSpecs(decoder, 'output'),
  })
  const joinerPlan = planJoinerFeed(tensorSpecs(joiner, 'input'), { dim: encoderDim, hidden })
  log.info(
    `[shenava] predictor: ${plan.kind} · context=${plan.contextSize} (from ${plan.contextSource}) · ` +
      `targets ${plan.targetDtype}[${plan.targetShape.join(', ')}] · states ${
        plan.stateShapes.map((shape) => `[${shape.join(', ')}]`).join(' ') || 'none'
      }`,
  )
  log.info(
    `[shenava] joiner shapes: ${joinerPlan.inputs[0]!.name} [${joinerPlan.encoderShapes[0]!.join(', ')}] · ` +
      `${joinerPlan.inputs[1]!.name} [${joinerPlan.decoderShapes[0]!.join(', ')}]`,
  )

  let states: Float32Array[] = plan.stateShapes.map((shape) => new Float32Array(shape.reduce((a, b) => a * b, 1)))
  const context = blankContextWindow(plan.contextSize, blankId)
  let decoderOut: Float32Array = new Float32Array(plan.decoderOutSize ?? hidden)
  let predictorLogged = false
  let joinerLogged = false
  let int64Targets = plan.targetDtype === 'int64'
  let joinerCombo = 0

  // Every (encoder_outputs, decoder_outputs) layout worth trying: the preferred decoder shape with
  // each encoder shape, then the preferred encoder shape with the remaining decoder shapes. Only the
  // first one is normally built — the alternatives exist for exports whose dimensions are all dynamic.
  const combinations: Array<[number, number]> = []
  for (let index = 0; index < joinerPlan.decoderShapes.length; index += 1) combinations.push([0, index])
  for (let index = 1; index < joinerPlan.encoderShapes.length; index += 1) combinations.push([index, 0])

  function buildDecoderFeeds(dtype: TensorDtype): Record<string, ort.Tensor> {
    const targetValues = plan.kind === 'context' ? Array.from(context) : [context[context.length - 1]!]
    const feeds: Record<string, ort.Tensor> = {
      [plan.inputs[0]!.name]: makeTensor(targetValues, plan.targetShape, dtype),
    }
    if (plan.inputs.length > 1) {
      feeds[plan.inputs[1]!.name] = makeTensor([1], plan.lengthShape, plan.lengthDtype)
    }
    plan.stateShapes.forEach((shape, index) => {
      const spec = plan.inputs[index + (plan.inputs.length > 1 ? 2 : 1)]
      const state = states[index] ?? new Float32Array(0)
      if (spec) feeds[spec.name] = new ort.Tensor('float32', Float32Array.from(state), shape)
    })
    return feeds
  }

  async function runPredictor(tokenId: number): Promise<Float32Array> {
    if (plan.kind === 'context') appendContextToken(context, tokenId)
    else context[0] = tokenId

    const dtype: TensorDtype = int64Targets ? 'int64' : plan.targetDtype
    let outputs: ort.InferenceSession.OnnxValueMapType
    try {
      outputs = await decoder.run(buildDecoderFeeds(dtype))
    } catch (error) {
      if (dtype === 'int32') {
        // Some exports declare int64 targets; retry once and remember.
        int64Targets = true
        outputs = await decoder.run(buildDecoderFeeds('int64'))
      } else {
        log.error(`[shenava] predictor failed · ${feedText(buildDecoderFeeds(dtype))}`)
        throw error
      }
    }
    if (!predictorLogged) {
      predictorLogged = true
      log.info(`[shenava] predictor run · ${feedText(buildDecoderFeeds(dtype))}`)
    }

    const out = typedOutput(outputs[decoder.outputNames[0]!] as ort.Tensor)
    const size = plan.decoderOutSize ?? hidden
    decoderOut = copyFloat32(out.length === size ? out : out.subarray(Math.max(0, out.length - size)))
    for (let index = 0; index < states.length; index += 1) {
      // NeMo's decoder returns `outputs`, `prednet_lengths`, then the states — same layout sherpa-onnx
      // reads (`decoder_out[i + 2]` in offline-transducer-nemo-model.cc).
      const tensor = outputs[decoder.outputNames[index + 2]!] as ort.Tensor | undefined
      if (tensor) states[index] = copyFloat32(typedOutput(tensor))
    }
    return decoderOut
  }

  async function runJoiner(encoderFrame: Float32Array, currentDecoderOut: Float32Array): Promise<Float32Array> {
    const [encoderIndex, decoderIndex] = combinations[joinerCombo] ?? [0, 0]
    const encoderShape = joinerPlan.encoderShapes[encoderIndex] ?? [1, encoderDim, 1]
    const decoderShape = joinerPlan.decoderShapes[decoderIndex] ?? [1, hidden, 1]
    const build = (): Record<string, ort.Tensor> => ({
      [joinerPlan.inputs[0]!.name]: new ort.Tensor('float32', Float32Array.from(encoderFrame), encoderShape),
      [joinerPlan.inputs[1]!.name]: new ort.Tensor('float32', Float32Array.from(currentDecoderOut), decoderShape),
    })

    let outputs: ort.InferenceSession.OnnxValueMapType
    try {
      outputs = await joiner.run(build())
    } catch (error) {
      const next = joinerCombo + 1
      if (next < combinations.length) {
        const [nextEncoder, nextDecoder] = combinations[next]!
        log.warn(
          `[shenava] joiner rejected ${feedText(build())}; trying ${joinerPlan.inputs[0]!.name} ` +
            `[${joinerPlan.encoderShapes[nextEncoder]!.join(', ')}] + ${joinerPlan.inputs[1]!.name} ` +
            `[${joinerPlan.decoderShapes[nextDecoder]!.join(', ')}]`,
        )
        joinerCombo = next
        return runJoiner(encoderFrame, currentDecoderOut)
      }
      log.error(`[shenava] joiner failed · ${feedText(build())}`)
      throw error
    }
    if (!joinerLogged) {
      joinerLogged = true
      log.info(`[shenava] joiner run · ${feedText(build())}`)
    }
    const logits = typedOutput(outputs[joiner.outputNames[0]!] as ort.Tensor)
    return logits.length > vocabulary ? logits.subarray(logits.length - vocabulary) : logits
  }

  return {
    vocabSize: vocabulary,
    async reset() {
      states = plan.stateShapes.map((shape) => new Float32Array(shape.reduce((a, b) => a * b, 1)))
      context.fill(blankId)
      decoderOut = await runPredictor(blankId)
    },
    predict: runPredictor,
    join: runJoiner,
  }
}

/** The runtime's own shape plan, exposed so the diagnostic page can print it. */
export function describeTransducerPlan(options: {
  decoder: ort.InferenceSession
  joiner: ort.InferenceSession
  encoderDim: number
  blankId: number
  layers: number
  hidden: number
  decoderMetadata?: OnnxMetadata
}): string {
  const plan = planDecoderFeed(tensorSpecs(options.decoder, 'input'), {
    layers: options.layers,
    hidden: options.hidden,
    blankId: options.blankId,
    metadataContextSize:
      readMetadataInt(options.decoderMetadata ?? {}, 'context_size') ??
      readMetadataInt(options.decoderMetadata ?? {}, 'context') ??
      undefined,
    outputs: tensorSpecs(options.decoder, 'output'),
  })
  const joinerPlan = planJoinerFeed(tensorSpecs(options.joiner, 'input'), {
    dim: options.encoderDim,
    hidden: options.hidden,
  })
  return (
    `predictor ${plan.kind} context=${plan.contextSize}(${plan.contextSource}) ` +
    `targets=${plan.targetDtype}[${plan.targetShape.join(',')}] ` +
    `states=${plan.stateShapes.map((shape) => `[${shape.join(',')}]`).join('') || 'none'} · ` +
    `joiner ${joinerPlan.inputs[0]!.name}[${joinerPlan.encoderShapes[0]!.join(',')}] ` +
    `${joinerPlan.inputs[1]!.name}[${joinerPlan.decoderShapes[0]!.join(',')}]`
  )
}
