/**
 * Turns the *declared* input signature of the Shenava decoder/joiner into the concrete tensor shapes
 * the worker must feed.
 *
 * Why this exists: the first on-device run failed with
 *
 *   failed to call OrtRun(). ERROR_CODE: 2, ERROR_MESSAGE: Got invalid dimensions for input:
 *   decoder_outputs for the following indices index: 1 Got: 1 Expected: 640
 *
 * The shapes were hard-coded guesses before; here they are derived from `InferenceSession.inputMetadata`,
 * so the runtime always feeds what the model actually asks for. The offending feed was the joint
 * network's `decoder_outputs`: NeMo declares *both* joint inputs channel-first as `('B', 'D', 'T')`
 * (`RNNTJoint.input_types` in `nemo/collections/asr/modules/rnnt.py`), i.e. `[1, 640, 1]` for a
 * 640-wide predictor — the worker fed `[1, 1, 640]`, which is why ONNX Runtime reported
 * "index: 1 Got: 1 Expected: 640".
 *
 * Handled predictor layouts:
 *
 *   - LSTM-state predictor (`RNNTDecoder`): `targets [1, 1]`, `target_length [1]`,
 *     `states [layers, 1, hidden]` — what sherpa-onnx feeds for `nemo_transducer`,
 *   - context-window predictor (`StatelessTransducerDecoder`): `targets [1, context_size]` filled
 *     with the last `context_size` tokens and padded with the blank id.
 *
 * ONNX Runtime Web reports dynamic dimensions as `4294967295` (the signed `-1` as an unsigned 32-bit
 * number) and symbolic dimensions as strings, so both count as "unknown" here.
 *
 * Everything in this file is pure: no ONNX Runtime, no DOM. That is what makes the shapes unit
 * testable, and what lets `scripts/shenava-decoder-probe.mjs` reuse the same planner on the real
 * model files.
 */

/** One `InferenceSession.ValueMetadata` for a tensor input, narrowed for the plain-object API. */
export interface TensorSpec {
  name: string
  /** `Tensor.Type`, e.g. `float32`, `int32`, `int64`. */
  type: string
  shape: readonly (number | string)[]
}

export type TensorDtype = 'int32' | 'int64'

/** Sentinel ONNX Runtime uses for a dynamic dimension (`-1` as uint32). */
const DYNAMIC_DIM = 4294967295

/** A declared dimension, or `null` when the model leaves it dynamic/symbolic. */
export function staticDim(value: number | string | undefined): number | null {
  if (value === undefined) return null
  if (typeof value === 'string') {
    const parsed = Number(value)
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
  }
  if (!Number.isSafeInteger(value) || value <= 0 || value >= DYNAMIC_DIM) return null
  return value
}

function declaredShape(spec: TensorSpec | undefined): (number | string)[] {
  return spec ? [...spec.shape] : []
}

function elementCount(shape: readonly number[]): number {
  return shape.reduce((total, value) => total * value, 1)
}

/** `decoder_outputs: float32[1, 640, ?]` — used for logs and for error messages. */
export function describeTensor(spec: TensorSpec): string {
  const dims = spec.shape.map((dim) => staticDim(dim) ?? '?').join(', ')
  return `${spec.name}: ${spec.type}[${dims}]`
}

export function describeSignature(specs: readonly TensorSpec[]): string {
  return specs.map(describeTensor).join(', ') || '(no inputs)'
}

function dtypeOf(spec: TensorSpec | undefined, fallback: TensorDtype): TensorDtype {
  const type = spec?.type
  if (type === 'int64') return 'int64'
  if (type === 'int32') return 'int32'
  return fallback
}

export interface DecoderPlan {
  /** `states`: LSTM state inputs; `context`: a token window (`contextSize` > 1). */
  kind: 'states' | 'context'
  inputs: TensorSpec[]
  targetDtype: TensorDtype
  lengthDtype: TensorDtype
  targetShape: number[]
  lengthShape: number[]
  /** One shape per state input, in declaration order; empty when the predictor keeps no state. */
  stateShapes: number[][]
  /** Number of tokens the predictor expects per step (`1` for the LSTM-state form). */
  contextSize: number
  /** Where `contextSize` came from — logged so a bug report says which source won. */
  contextSource: 'shape' | 'metadata' | 'default'
  /** Values the predictor's first output holds, when the declaration fixes them. */
  decoderOutSize: number | null
}

export interface DecoderPlanOptions {
  layers: number
  hidden: number
  blankId?: number
  /** `context_size` / `context` from the decoder's own metadata, when present. */
  metadataContextSize?: number
  /** The decoder's declared outputs, used to size the predictor vector. */
  outputs?: readonly TensorSpec[]
}

/**
 * Rank-1..3 state shapes: every statically declared dimension is taken from the model, dynamic ones
 * are filled from the encoder metadata (`pred_rnn_layers`, `pred_hidden`).
 */
function stateShape(spec: TensorSpec, layers: number, hidden: number): number[] {
  const declared = declaredShape(spec)
  if (declared.length < 1 || declared.length > 3) {
    throw new Error(`unsupported state rank for ${describeTensor(spec)}; expected 1, 2 or 3 dimensions`)
  }
  const fallback =
    declared.length === 1 ? [layers * hidden] : declared.length === 2 ? [layers, hidden] : [layers, 1, hidden]
  return fallback.map((value, index) => staticDim(declared[index]) ?? value)
}

export function planDecoderFeed(
  inputs: readonly TensorSpec[],
  options: DecoderPlanOptions,
): DecoderPlan {
  const { layers, hidden } = options
  const targets = inputs[0]
  if (!targets) throw new Error('decoder.int8.onnx has no inputs')
  const declared = declaredShape(targets)
  if (declared.length < 1 || declared.length > 3) {
    throw new Error(`unsupported decoder input rank for ${describeTensor(targets)}; expected 1, 2 or 3 dimensions`)
  }

  // A statically declared window (`[1, 640]`) is the difference between "one token per step" and
  // "the last N tokens per step". Metadata only fills in for a dynamic dimension.
  const declaredWindow = declared.length >= 2 ? staticDim(declared[declared.length - 1]) : 1
  const metadataWindow =
    options.metadataContextSize && options.metadataContextSize > 1 ? options.metadataContextSize : null
  const contextSize = declaredWindow ?? metadataWindow ?? 1
  const contextSource: DecoderPlan['contextSource'] =
    declaredWindow !== null ? 'shape' : metadataWindow !== null ? 'metadata' : 'default'

  const targetShape =
    declared.length === 1 ? [contextSize] : declared.length === 2 ? [1, contextSize] : [1, 1, contextSize]

  const lengthSpec = inputs[1]
  const stateSpecs = lengthSpec ? inputs.slice(2) : inputs.slice(1)
  const stateShapes = stateSpecs.map((spec) => stateShape(spec, layers, hidden))

  const declaredOut = options.outputs?.[0]
  const outShape = declaredOut ? declaredShape(declaredOut) : []
  const outDims = outShape.map((dim) => staticDim(dim))
  const decoderOutSize = outDims.length > 0 && outDims.every((dim) => dim !== null)
    ? elementCount(outDims as number[])
    : null

  return {
    kind: contextSize > 1 ? 'context' : 'states',
    inputs: [...inputs],
    targetDtype: dtypeOf(targets, 'int32'),
    lengthDtype: dtypeOf(lengthSpec, dtypeOf(targets, 'int32')),
    targetShape,
    lengthShape: [1],
    stateShapes,
    contextSize,
    contextSource,
    decoderOutSize,
  }
}

export interface JoinerPlan {
  inputs: TensorSpec[]
  /** Candidate shapes for `encoder_outputs`, best guess first (retried in order on failure). */
  encoderShapes: number[][]
  /** Candidate shapes for `decoder_outputs`, best guess first (retried in order on failure). */
  decoderShapes: number[][]
}

/**
 * Keeps candidates that do not contradict a *static* declared dimension, in preference order. When
 * everything is dynamic every candidate survives and the first one (NeMo's `(B, D, T)`) is used.
 */
function rankCandidates(spec: TensorSpec, candidates: number[][]): number[][] {
  const declared = declaredShape(spec)
  const compatible = candidates.filter((shape) => {
    if (shape.length !== declared.length) return false
    return shape.every((value, index) => {
      const fixed = staticDim(declared[index])
      return fixed === null ? true : fixed === value
    })
  })
  if (compatible.length > 0) return compatible
  const tried = candidates.map((shape) => `[${shape.join(', ')}]`).join(' / ')
  throw new Error(`${describeTensor(spec)} cannot be fed; the worker can produce ${tried}`)
}

/**
 * Both joint inputs are `(B, D, T)` in NeMo — `encoder_outputs` `[1, dim, 1]` and `decoder_outputs`
 * `[1, hidden, 1]` for one frame — so those channel-first shapes are tried first, and the
 * time-major/rank-2 variants are kept as fallbacks for other exports.
 */
export function planJoinerFeed(inputs: readonly TensorSpec[], dims: { dim: number; hidden: number }): JoinerPlan {
  const [encoderSpec, decoderSpec] = inputs
  if (!encoderSpec || !decoderSpec) {
    throw new Error(`joiner.int8.onnx must take encoder_outputs and decoder_outputs, got ${describeSignature(inputs)}`)
  }
  const { dim, hidden } = dims
  return {
    inputs: [...inputs],
    encoderShapes: rankCandidates(encoderSpec, [
      [1, dim, 1],
      [1, 1, dim],
      [1, dim],
      [dim],
    ]),
    decoderShapes: rankCandidates(decoderSpec, [
      [1, hidden, 1],
      [1, 1, hidden],
      [1, hidden],
    ]),
  }
}

/**
 * Keeps the trailing `contextSize` tokens by shifting left and appending. This is the rolling window
 * NeMo's stateless predictor expects; with `contextSize === 1` it simply replaces the single token.
 */
export function appendContextToken(history: Int32Array, tokenId: number): Int32Array {
  const size = history.length
  if (size === 0) return history
  if (size === 1) {
    history[0] = tokenId
    return history
  }
  history.copyWithin(0, 1)
  history[size - 1] = tokenId
  return history
}

/** A blank-filled window: NeMo's stateless predictor pads its history with the blank token. */
export function blankContextWindow(contextSize: number, blankId: number): Int32Array {
  const window = new Int32Array(Math.max(1, contextSize))
  window.fill(blankId)
  return window
}
