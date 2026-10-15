import { describe, expect, it } from 'vitest'

import {
  appendContextToken,
  blankContextWindow,
  describeSignature,
  planDecoderFeed,
  planJoinerFeed,
  staticDim,
  type TensorSpec,
} from './transducerShape'

const spec = (name: string, type: string, shape: (number | string)[]): TensorSpec => ({ name, type, shape })

/** ONNX Runtime Web reports a dynamic dimension as `-1` cast to uint32. */
const DYNAMIC = 4294967295

describe('staticDim', () => {
  it('یک بعد ثابت را برمی‌گرداند', () => {
    expect(staticDim(640)).toBe(640)
    expect(staticDim(1)).toBe(1)
  })

  it('بعد پویا و نمادین را ناشناخته می‌داند', () => {
    expect(staticDim(DYNAMIC)).toBeNull()
    expect(staticDim(-1)).toBeNull()
    expect(staticDim(0)).toBeNull()
    expect(staticDim('batch')).toBeNull()
    expect(staticDim(undefined)).toBeNull()
  })
})

describe('planDecoderFeed', () => {
  it('شبکهٔ پیش‌بینی با حالت LSTM را مثل sherpa-onnx می‌سازد', () => {
    const plan = planDecoderFeed(
      [
        spec('targets', 'int32', ['B', 'T']),
        spec('target_length', 'int32', ['B']),
        spec('input_states_1', 'float32', [1, 'B', 640]),
        spec('input_states_2', 'float32', [1, 'B', 640]),
      ],
      { layers: 1, hidden: 640, outputs: [spec('decoder_outputs', 'float32', ['B', 'D', 'T'])] },
    )

    expect(plan.kind).toBe('states')
    expect(plan.contextSize).toBe(1)
    // `targets` is `['B', 'T']` (both dynamic), so nothing in the signature fixes the window: the
    // one-token-per-step default applies and the states carry the history.
    expect(plan.contextSource).toBe('default')
    expect(plan.targetShape).toEqual([1, 1])
    expect(plan.lengthShape).toEqual([1])
    expect(plan.stateShapes).toEqual([
      [1, 1, 640],
      [1, 1, 640],
    ])
    expect(plan.targetDtype).toBe('int32')
  })

  it('پنجرهٔ context را از شکل ورودی می‌خواند (خطای واقعی دستگاه: ۶۴۰)', () => {
    const plan = planDecoderFeed([spec('targets', 'int32', [1, 640]), spec('target_length', 'int32', [1])], {
      layers: 1,
      hidden: 640,
    })

    expect(plan.kind).toBe('context')
    expect(plan.contextSize).toBe(640)
    expect(plan.contextSource).toBe('shape')
    expect(plan.targetShape).toEqual([1, 640])
  })

  it('اگر شکل پویا باشد، context_size از متادیتای دیکودر می‌آید', () => {
    const plan = planDecoderFeed([spec('targets', 'int32', ['B', 'T']), spec('target_length', 'int32', ['B'])], {
      layers: 1,
      hidden: 640,
      metadataContextSize: 5,
    })

    expect(plan.kind).toBe('context')
    expect(plan.contextSize).toBe(5)
    expect(plan.contextSource).toBe('metadata')
  })

  it('شکل ثابت بر متادیتا اولویت دارد و dtype را از خود مدل می‌گیرد', () => {
    const plan = planDecoderFeed([spec('targets', 'int64', [1, 3]), spec('target_length', 'int64', [1])], {
      layers: 1,
      hidden: 640,
      metadataContextSize: 9,
    })

    expect(plan.contextSize).toBe(3)
    expect(plan.contextSource).toBe('shape')
    expect(plan.targetDtype).toBe('int64')
    expect(plan.lengthDtype).toBe('int64')
  })

  it('اندازهٔ بردار پیش‌بینی‌کننده را از خروجی دیکودر می‌خواند', () => {
    const plan = planDecoderFeed([spec('targets', 'int32', [1, 1]), spec('target_length', 'int32', [1])], {
      layers: 1,
      hidden: 256,
      outputs: [spec('decoder_outputs', 'float32', [1, 640, 1])],
    })

    expect(plan.decoderOutSize).toBe(640)
  })

  it('ورودی بدون نام/شکل را رد می‌کند', () => {
    expect(() => planDecoderFeed([], { layers: 1, hidden: 640 })).toThrow(/no inputs/)
    expect(() =>
      planDecoderFeed([spec('targets', 'int32', [1, 1, 1, 1])], { layers: 1, hidden: 640 }),
    ).toThrow(/unsupported decoder input rank/)
  })

  it('حالت با رتبهٔ نامعتبر را گزارش می‌کند', () => {
    expect(() =>
      planDecoderFeed(
        [
          spec('targets', 'int32', [1, 1]),
          spec('target_length', 'int32', [1]),
          spec('input_states_1', 'float32', [1, 1, 640, 1]),
        ],
        { layers: 1, hidden: 640 },
      ),
    ).toThrow(/unsupported state rank for input_states_1/)
  })
})

describe('planJoinerFeed', () => {
  it('decoder_outputs را کانال‌اول می‌سازد ([1, 640, 1]) — علت خطای OrtRun', () => {
    const plan = planJoinerFeed(
      [
        spec('encoder_outputs', 'float32', ['B', 512, 'T']),
        spec('decoder_outputs', 'float32', ['B', 640, 'T']),
      ],
      { dim: 512, hidden: 640 },
    )

    expect(plan.encoderShapes[0]).toEqual([1, 512, 1])
    expect(plan.decoderShapes[0]).toEqual([1, 640, 1])
  })

  it('رتبهٔ ۲ را برای joiner هایی که [1, hidden] می‌خواهند نگه می‌دارد', () => {
    const plan = planJoinerFeed(
      [
        spec('encoder_outputs', 'float32', [1, 512, 1]),
        spec('decoder_outputs', 'float32', [1, 640]),
      ],
      { dim: 512, hidden: 640 },
    )

    expect(plan.encoderShapes[0]).toEqual([1, 512, 1])
    expect(plan.decoderShapes[0]).toEqual([1, 640])
  })

  it('اگر همهٔ ابعاد پویا باشند، ترتیب دیگر را هم به‌عنوان گزینهٔ بعدی نگه می‌دارد', () => {
    const plan = planJoinerFeed(
      [
        spec('encoder_outputs', 'float32', ['B', 'T', 'D']),
        spec('decoder_outputs', 'float32', ['B', 'T', 'D']),
      ],
      { dim: 512, hidden: 640 },
    )

    expect(plan.decoderShapes[0]).toEqual([1, 640, 1])
    expect(plan.decoderShapes).toContainEqual([1, 1, 640])
  })

  it('امضاهایی که هیچ قالبی برایشان نیست را با پیام روشن رد می‌کند', () => {
    expect(() => planJoinerFeed([spec('encoder_outputs', 'float32', [1, 512, 1])], { dim: 512, hidden: 640 })).toThrow(
      /must take encoder_outputs and decoder_outputs/,
    )
    expect(() =>
      planJoinerFeed(
        [
          spec('encoder_outputs', 'float32', [1, 512, 1]),
          spec('decoder_outputs', 'float32', [1, 999]),
        ],
        { dim: 512, hidden: 640 },
      ),
    ).toThrow(/decoder_outputs: float32\[1, 999\] cannot be fed/)
  })
})

describe('پنجرهٔ context', () => {
  it('با توکن blank پر می‌شود', () => {
    const window = blankContextWindow(4, 1024)
    expect([...window]).toEqual([1024, 1024, 1024, 1024])
  })

  it('توکن‌های تازه را به انتها می‌برد و قدیمی‌ها را نگه می‌دارد', () => {
    const window = blankContextWindow(3, 9)
    appendContextToken(window, 5)
    appendContextToken(window, 6)
    expect([...window]).toEqual([9, 5, 6])
    appendContextToken(window, 7)
    appendContextToken(window, 8)
    expect([...window]).toEqual([6, 7, 8])
  })

  it('با پنجرهٔ تک‌توکنی فقط همان توکن را می‌گذارد', () => {
    const window = blankContextWindow(1, 0)
    appendContextToken(window, 4)
    expect([...window]).toEqual([4])
  })
})

describe('describeSignature', () => {
  it('ابعاد پویا را با ؟ نشان می‌دهد', () => {
    expect(describeSignature([spec('decoder_outputs', 'float32', ['B', 640, DYNAMIC])])).toBe(
      'decoder_outputs: float32[?, 640, ?]',
    )
  })
})
