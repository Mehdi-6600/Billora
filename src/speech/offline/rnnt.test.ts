import { describe, expect, it } from 'vitest'
import { argMax, greedyDecodeNemo, type NemoTransducerRuntime } from './rnnt'

/**
 * Scripted stand-in for the ONNX graphs: the joiner returns logits from a queue, the predictor
 * records every token it was asked for, exactly like sherpa-onnx's greedy NeMo decoder would.
 */
function createRuntime(vocabSize: number, logitQueue: number[][]): { runtime: NemoTransducerRuntime; predictions: number[]; resets: number } {
  const state = { predictions: [] as number[], resets: 0 }
  const runtime: NemoTransducerRuntime = {
    vocabSize,
    async reset() {
      state.resets += 1
    },
    async predict(tokenId: number) {
      state.predictions.push(tokenId)
      return new Float32Array([tokenId, 0, 0])
    },
    async join() {
      const next = logitQueue.shift()
      if (!next) throw new Error('joiner was called more often than the script allows')
      return Float32Array.from(next)
    },
  }
  return { runtime, ...state, get predictions() { return state.predictions }, get resets() { return state.resets } }
}

describe('گشتی‌گَردی (greedy) دیکودر RNNT نِمو', () => {
  it('توکن‌ها را تا رسیدن به توکن خالی می‌خواند و شناسهٔ خالی آخرین توکن واژگان است', async () => {
    // vocabSize 4 → blank id 3.
    const queue = [
      [0, 5, 0, 0], // frame 0 → token 1
      [0, 0, 0, 7], // frame 0 → blank, frame ends
      [0, 0, 9, 0], // frame 1 → token 2
      [0, 0, 0, 5], // frame 1 → blank, frame ends
    ]
    const context = createRuntime(4, queue)
    const result = await greedyDecodeNemo(new Float32Array(2 * 3), 2, 3, context.runtime)
    expect(result.blankId).toBe(3)
    expect(result.tokenIds).toEqual([1, 2])
    expect(result.timestamps).toEqual([0, 1])
    expect(context.resets).toBe(1)
    // The predictor sees the blank token first, then every emitted token (blank is not re-fed).
    expect(context.predictions).toEqual([3, 1, 2])
  })

  it('در هر فریم بیشتر از maxSymbolsPerFrame توکن تولید نمی‌کند', async () => {
    const queue = Array.from({ length: 3 }, () => [0, 5, 0, 0])
    const { runtime } = createRuntime(4, queue)
    const result = await greedyDecodeNemo(new Float32Array(3), 1, 3, runtime, { maxSymbolsPerFrame: 3 })
    expect(result.tokenIds).toEqual([1, 1, 1])
  })

  it('جریمهٔ توکن خالی می‌تواند گزینهٔ بعدی را انتخاب کند', async () => {
    // vocabSize 3 → blank id 2 with the highest logit.
    const plain = createRuntime(3, [[1, 9, 20]])
    expect((await greedyDecodeNemo(new Float32Array(3), 1, 3, plain.runtime)).tokenIds).toEqual([])

    // With the penalty the first two joint calls pick token 1; the third still blanks out.
    const penalized = createRuntime(3, [[1, 9, 20], [1, 9, 20], [1, 9, 60]])
    const result = await greedyDecodeNemo(new Float32Array(3), 1, 3, penalized.runtime, { blankPenalty: 30 })
    expect(result.tokenIds).toEqual([1, 1])
  })

  it('برای صوت خالی هیچ توکنی برنمی‌گرداند و reset را صدا نمی‌زند', async () => {
    const context = createRuntime(4, [])
    const result = await greedyDecodeNemo(new Float32Array(0), 0, 3, context.runtime)
    expect(result).toMatchObject({ tokenIds: [], timestamps: [], frames: 0, blankId: 3 })
    expect(context.resets).toBe(0)
  })

  it('ورودی ناسازگار را تشخیص می‌دهد', async () => {
    const { runtime } = createRuntime(4, [])
    await expect(greedyDecodeNemo(new Float32Array(2), 3, 3, runtime)).rejects.toThrow(/were expected/)
    const broken = createRuntime(1, [])
    await expect(greedyDecodeNemo(new Float32Array(3), 1, 3, broken.runtime)).rejects.toThrow(/vocabSize/)
  })

  it('argMax بزرگ‌ترین لاجیت را برمی‌گرداند', () => {
    expect(argMax(Float32Array.from([1, 9, 3]))).toBe(1)
    expect(argMax(Float32Array.from([1, 9, 3]), 1)).toBe(0)
  })
})
