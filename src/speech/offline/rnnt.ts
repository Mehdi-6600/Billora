/**
 * Greedy RNNT (transducer) decoding for NeMo FastConformer models.
 *
 * This is a faithful port of sherpa-onnx's NeMo greedy-search decoder, which is the reference
 * runtime this model was exported for:
 * https://github.com/k2-fsa/sherpa-onnx/blob/master/sherpa-onnx/csrc/offline-transducer-greedy-search-nemo-decoder.cc
 *
 *   - the blank token is the last id (`vocab_size - 1`; `tokens.txt` ends with `<blk>`)
 *   - at most `max_symbols_per_frame` (10) tokens are emitted per encoder frame
 *   - the loop breaks out of a frame on the first blank
 *
 * Model I/O is injected, so the loop itself is unit-testable without ONNX Runtime.
 */

export interface NemoTransducerRuntime {
  /** Vocabulary size *including* the blank token. */
  readonly vocabSize: number
  /** Resets prediction-network state and seeds it with the blank token. */
  reset(): Promise<void>
  /** Runs the prediction network for one token and returns its output vector. */
  predict(tokenId: number): Promise<Float32Array>
  /** Runs the joint network for one encoder frame and the current predictor state. */
  join(encoderFrame: Float32Array, decoderOut: Float32Array): Promise<Float32Array>
}

export interface GreedyDecodeOptions {
  /** sherpa-onnx uses 10 for RNNT models. */
  maxSymbolsPerFrame?: number
  /** Subtracted from the blank logit before the arg-max (sherpa-onnx `blank_penalty`). */
  blankPenalty?: number
}

export interface GreedyDecodeResult {
  tokenIds: number[]
  timestamps: number[]
  blankId: number
  frames: number
}

export const DEFAULT_MAX_SYMBOLS_PER_FRAME = 10

export async function greedyDecodeNemo(
  encoderOut: Float32Array,
  frames: number,
  dim: number,
  runtime: NemoTransducerRuntime,
  options: GreedyDecodeOptions = {},
): Promise<GreedyDecodeResult> {
  const vocabSize = runtime.vocabSize
  if (!Number.isInteger(vocabSize) || vocabSize <= 1) throw new Error('vocabSize must be greater than 1')
  const blankId = vocabSize - 1
  const maxSymbolsPerFrame = options.maxSymbolsPerFrame ?? DEFAULT_MAX_SYMBOLS_PER_FRAME
  const blankPenalty = options.blankPenalty ?? 0
  const tokenIds: number[] = []
  const timestamps: number[] = []

  if (frames <= 0) return { tokenIds, timestamps, blankId, frames: 0 }
  if (encoderOut.length < frames * dim) {
    throw new Error(`encoder output has ${encoderOut.length} values but ${frames * dim} were expected`)
  }

  await runtime.reset()
  let decoderOut = await runtime.predict(blankId)
  const logitsScratch = new Float32Array(vocabSize)

  for (let t = 0; t < frames; t += 1) {
    const frame = encoderOut.subarray(t * dim, (t + 1) * dim)
    for (let q = 0; q < maxSymbolsPerFrame; q += 1) {
      const logits = await runtime.join(frame, decoderOut)
      let best = 0
      let bestScore = Number.NEGATIVE_INFINITY
      for (let i = 0; i < vocabSize; i += 1) {
        const score = i === blankId ? logits[i]! - blankPenalty : logits[i]!
        logitsScratch[i] = logits[i]!
        if (score > bestScore) {
          bestScore = score
          best = i
        }
      }
      if (best === blankId) break
      tokenIds.push(best)
      timestamps.push(t)
      decoderOut = await runtime.predict(best)
    }
  }

  return { tokenIds, timestamps, blankId, frames }
}

/** Index of the highest value in a logit slice; used by tests and diagnostics. */
export function argMax(values: ArrayLike<number>, length = values.length): number {
  let best = 0
  let bestValue = Number.NEGATIVE_INFINITY
  for (let i = 0; i < length; i += 1) {
    const value = values[i]!
    if (value > bestValue) {
      bestValue = value
      best = i
    }
  }
  return best
}
