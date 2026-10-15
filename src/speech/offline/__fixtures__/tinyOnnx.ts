/**
 * Builds *valid* (if minimal) ONNX models in memory, so a test can exercise the real ONNX Runtime
 * without downloading the 132 MB Shenava files.
 *
 * Each `nodes` entry is an `Identity` edge, which is enough to make ONNX Runtime validate the exact
 * tensor shapes the worker feeds — that is what the transducer bug was about
 * (`decoder_outputs` expected `[1, 640, 1]`, the worker fed `[1, 1, 640]`).
 *
 * The writer is a straight port of the protobuf structure of `ModelProto`:
 *
 *   1 ir_version · 3 producer_name · 7 graph · 8 opset_import · 14 metadata_props
 *   GraphProto: 1 node · 2 name · 11 input · 12 output
 *   OperatorSetIdProto: 1 domain · 2 version
 *   TensorShapeProto.Dimension: 1 dim_value · 2 dim_param
 */

export const ONNX_FLOAT = 1
export const ONNX_INT32 = 6
export const ONNX_INT64 = 7

export interface TinyOnnxIo {
  name: string
  elemType: number
  /** Numbers are static dimensions; strings become symbolic ones. */
  shape: readonly (number | string)[]
}

export interface TinyOnnxSpec {
  name: string
  /** `[from, to]` pairs, each emitted as an `Identity` node. */
  nodes: ReadonlyArray<readonly [string, string]>
  inputs: readonly TinyOnnxIo[]
  outputs: readonly TinyOnnxIo[]
  metadata?: Record<string, string>
}


function varint(value: number): Uint8Array {
  const out: number[] = []
  let remainder = value
  while (remainder > 0x7f) {
    out.push((remainder & 0x7f) | 0x80)
    remainder = Math.floor(remainder / 128)
  }
  out.push(remainder)
  return Uint8Array.from(out)
}

/** Every builder returns a flat list of encoded chunks, so callers can spread them together. */
function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0)
  const merged = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.length
  }
  return merged
}

function tag(field: number, wire: number): Uint8Array {
  return varint(field * 8 + wire)
}

function stringField(field: number, value: string): Uint8Array[] {
  const bytes = new TextEncoder().encode(value)
  return [tag(field, 2), varint(bytes.length), bytes]
}

function varintField(field: number, value: number): Uint8Array[] {
  return [tag(field, 0), varint(value)]
}

function messageField(field: number, chunks: readonly Uint8Array[]): Uint8Array[] {
  const body = concat(chunks)
  return [tag(field, 2), varint(body.length), body]
}

/**
 * The *contents* of a `TensorShapeProto.Dimension`: `dim_value` for a static size, `dim_param` for a
 * symbolic one. The caller wraps this in `TensorShapeProto.dim` (field 1) — wrapping it here as well
 * silently turns every dimension dynamic, which hides the very mismatches ONNX Runtime reports.
 */
function dimension(value: number | string): Uint8Array[] {
  return typeof value === 'number' ? varintField(1, value) : stringField(2, value)
}

/** `ValueInfoProto`; field 11 inside `GraphProto.input`, 12 for `GraphProto.output`. */
function valueInfo(field: number, io: TinyOnnxIo): Uint8Array[] {
  return messageField(field, [
    ...stringField(1, io.name),
    ...messageField(2, [
      ...messageField(1, [
        ...varintField(1, io.elemType),
        ...messageField(
          2,
          io.shape.flatMap((dim) => messageField(1, dimension(dim))),
        ),
      ]),
    ]),
  ])
}

export function tinyOnnxModel(spec: TinyOnnxSpec): Uint8Array {
  return concat([
    ...varintField(1, 8), // ir_version
    ...stringField(3, 'billora-tiny-onnx'), // producer_name
    ...messageField(7, [
      ...spec.nodes.flatMap(([from, to], index) =>
        messageField(1, [
          ...stringField(1, from),
          ...stringField(2, to),
          ...stringField(3, `identity_${index}`),
          ...stringField(4, 'Identity'),
        ]),
      ),
      ...stringField(2, spec.name),
      ...spec.inputs.flatMap((io) => valueInfo(11, io)),
      ...spec.outputs.flatMap((io) => valueInfo(12, io)),
    ]),
    ...messageField(8, varintField(2, 13)), // opset_import { version: 13 }
    ...Object.entries(spec.metadata ?? {}).flatMap(([key, value]) =>
      messageField(14, [...stringField(1, key), ...stringField(2, value)]),
    ),
  ])
}

export function tinyDecoderSpec(options: {
  states?: boolean
  /** Static window size for a stateless/context predictor (`targets` becomes `[1, window]`). */
  contextWindow?: number
  hidden: number
  layers: number
  metadata?: Record<string, string>
}): TinyOnnxSpec {
  const { hidden, layers } = options
  const includeStates = options.states ?? true
  const inputs: TinyOnnxIo[] = [
    { name: 'targets', elemType: ONNX_INT32, shape: options.contextWindow ? [1, options.contextWindow] : ['B', 'T'] },
    { name: 'target_length', elemType: ONNX_INT32, shape: ['B'] },
  ]
  if (includeStates) {
    inputs.push(
      { name: 'input_states_1', elemType: ONNX_FLOAT, shape: [layers, 'B', hidden] },
      { name: 'input_states_2', elemType: ONNX_FLOAT, shape: [layers, 'B', hidden] },
    )
  }
  return {
    name: 'decoder',
    nodes: [
      ['input_states_1', 'decoder_outputs'],
      ['target_length', 'prednet_lengths'],
      ...(includeStates
        ? ([
            ['input_states_1', 'output_states_1'],
            ['input_states_2', 'output_states_2'],
          ] as const)
        : []),
    ],
    inputs,
    outputs: [
      // The predictor vector is rank 3 in NeMo's exports; `Identity` keeps the state's shape, which
      // is the only thing this stand-in has to get right for the feed to be validated.
      { name: 'decoder_outputs', elemType: ONNX_FLOAT, shape: [layers, 'B', hidden] },
      { name: 'prednet_lengths', elemType: ONNX_INT32, shape: ['B'] },
      ...(includeStates
        ? ([
            { name: 'output_states_1', elemType: ONNX_FLOAT, shape: [layers, 'B', hidden] },
            { name: 'output_states_2', elemType: ONNX_FLOAT, shape: [layers, 'B', hidden] },
          ] as const)
        : []),
    ],
    metadata: options.metadata,
  }
}

/** The Shenava joint network: both inputs channel-first `('B','D','T')`, logits as its first output. */
export function tinyJoinerSpec(options: { dim: number; hidden: number; decoderRank?: number }): TinyOnnxSpec {
  const { dim, hidden } = options
  const decoderRank = options.decoderRank ?? 3
  const decoderShape: (number | string)[] =
    decoderRank === 3 ? ['B', hidden, 'T'] : decoderRank === 2 ? ['B', hidden] : [hidden, 'T']
  return {
    name: 'joiner',
    nodes: [
      ['encoder_outputs', 'logits'],
      ['decoder_outputs', 'decoder_passthrough'],
    ],
    inputs: [
      { name: 'encoder_outputs', elemType: ONNX_FLOAT, shape: ['B', dim, 'T'] },
      { name: 'decoder_outputs', elemType: ONNX_FLOAT, shape: decoderShape },
    ],
    outputs: [
      // The stand-in passes the encoded frame through, so the logits keep the encoder's dimensions;
      // the runtime slices the tail down to the vocabulary (as it does for the real joiner).
      { name: 'logits', elemType: ONNX_FLOAT, shape: ['B', dim, 'T'] },
      { name: 'decoder_passthrough', elemType: ONNX_FLOAT, shape: decoderShape },
    ],
  }
}

/** A stand-in for the acoustic encoder: `[1, dim, frames]` in, `[1, dim, frames]` out. */
export function tinyEncoderSpec(options: { dim: number }): TinyOnnxSpec {
  return {
    name: 'encoder',
    nodes: [
      ['audio_signal', 'outputs'],
      ['length', 'encoded_lengths'],
    ],
    inputs: [
      { name: 'audio_signal', elemType: ONNX_FLOAT, shape: ['B', options.dim, 'T'] },
      { name: 'length', elemType: ONNX_INT32, shape: ['B'] },
    ],
    outputs: [
      { name: 'outputs', elemType: ONNX_FLOAT, shape: ['B', options.dim, 'T'] },
      { name: 'encoded_lengths', elemType: ONNX_INT32, shape: ['B'] },
    ],
  }
}
