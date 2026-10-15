/**
 * Reads the `metadata_props` map of an ONNX `ModelProto` without pulling in a protobuf runtime.
 *
 * The Shenava export writes the numbers a decoder needs into `encoder.onnx`
 * (`vocab_size`, `subsampling_factor`, `pred_rnn_layers`, `pred_hidden`, `normalize_type`) — see
 * `export-rnnt-sherpa.py` in the model repository and sherpa-onnx's
 * `offline-transducer-nemo-model.cc`, which reads them with `SHERPA_ONNX_READ_META_DATA`.
 * ONNX Runtime Web does not expose model metadata, so the fields are read straight from the bytes.
 *
 * Only the top-level `ModelProto` fields are walked: `metadata_props` is field 14 and every other
 * field is skipped by wire type. Nested messages are never fully decoded.
 */

export type OnnxMetadata = Record<string, string>

const METADATA_PROPS_FIELD = 14

interface VarintRead {
  value: number
  offset: number
}

function readVarint(bytes: Uint8Array, offset: number): VarintRead {
  let value = 0
  let shift = 0
  let cursor = offset
  while (cursor < bytes.length) {
    const byte = bytes[cursor]!
    cursor += 1
    value += (byte & 0x7f) * 2 ** shift
    if ((byte & 0x80) === 0) return { value, offset: cursor }
    shift += 7
    if (shift > 49) throw new Error('protobuf varint is too long')
  }
  throw new Error('unexpected end of protobuf data')
}

function readEntry(bytes: Uint8Array, start: number, end: number, decoder: TextDecoder): [string, string] | null {
  let key = ''
  let value = ''
  let cursor = start
  while (cursor < end) {
    const tag = readVarint(bytes, cursor)
    cursor = tag.offset
    const field = tag.value >>> 3
    const wireType = tag.value & 7
    if (wireType !== 2) {
      // metadata_props only carries length-delimited strings; skip anything else defensively.
      if (wireType === 0) {
        cursor = readVarint(bytes, cursor).offset
      } else if (wireType === 1) {
        cursor += 8
      } else if (wireType === 5) {
        cursor += 4
      } else {
        return null
      }
      continue
    }
    const length = readVarint(bytes, cursor)
    cursor = length.offset
    const slice = bytes.subarray(cursor, cursor + length.value)
    cursor += length.value
    if (field === 1) key = decoder.decode(slice)
    else if (field === 2) value = decoder.decode(slice)
  }
  if (!key) return null
  return [key, value]
}

export function readOnnxMetadata(bytes: Uint8Array): OnnxMetadata {
  const decoder = new TextDecoder('utf-8', { fatal: false })
  const metadata: OnnxMetadata = {}
  let cursor = 0

  while (cursor < bytes.length) {
    const tag = readVarint(bytes, cursor)
    cursor = tag.offset
    const field = tag.value >>> 3
    const wireType = tag.value & 7

    if (wireType === 0) {
      cursor = readVarint(bytes, cursor).offset
      continue
    }
    if (wireType === 1) {
      cursor += 8
      continue
    }
    if (wireType === 5) {
      cursor += 4
      continue
    }
    if (wireType !== 2) throw new Error(`unsupported protobuf wire type ${wireType} in ONNX model`)

    const length = readVarint(bytes, cursor)
    cursor = length.offset
    const end = cursor + length.value
    if (end > bytes.length) throw new Error('unexpected end of ONNX model data')
    if (field === METADATA_PROPS_FIELD) {
      const entry = readEntry(bytes, cursor, end, decoder)
      if (entry) metadata[entry[0]] = entry[1]
    }
    cursor = end
  }

  return metadata
}

export function readMetadataInt(metadata: OnnxMetadata, key: string): number | null {
  const raw = metadata[key]
  // An empty value is meaningful (NeMo's `normalize_type=NA` is exported as ""), but it is not a number.
  if (raw === undefined || raw.trim() === '') return null
  const value = Number(raw)
  return Number.isFinite(value) ? value : null
}
