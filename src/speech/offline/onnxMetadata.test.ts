import { describe, expect, it } from 'vitest'
import { readMetadataInt, readOnnxMetadata } from './onnxMetadata'

function varint(value: number): number[] {
  const bytes: number[] = []
  let current = value
  do {
    const byte = current & 0x7f
    current = Math.floor(current / 128)
    bytes.push(current > 0 ? byte | 0x80 : byte)
  } while (current > 0)
  return bytes
}

function lengthDelimited(field: number, payload: number[]): number[] {
  return [...varint((field << 3) | 2), ...varint(payload.length), ...payload]
}

function varintField(field: number, value: number): number[] {
  return [...varint(field << 3), ...varint(value)]
}

function utf8(value: string): number[] {
  return Array.from(new TextEncoder().encode(value))
}

function metadataEntry(key: string, value: string): number[] {
  return lengthDelimited(14, [...lengthDelimited(1, utf8(key)), ...lengthDelimited(2, utf8(value))])
}

describe('خواندن metadata_props از فایل ONNX', () => {
  it('کلید/مقدارهای متادیتا را از پروتوباف مدل بیرون می‌کشد', () => {
    const model = Uint8Array.from([
      ...varintField(1, 8), // ir_version
      ...lengthDelimited(2, utf8('pytorch')), // producer_name
      ...metadataEntry('vocab_size', '1024'),
      ...metadataEntry('normalize_type', ''),
      ...metadataEntry('pred_hidden', '640'),
      ...lengthDelimited(4, utf8('ai.onnx')), // domain
      ...varintField(5, 7), // model_version
      ...metadataEntry('subsampling_factor', '8'),
    ])

    const metadata = readOnnxMetadata(model)
    expect(metadata).toMatchObject({
      vocab_size: '1024',
      normalize_type: '',
      pred_hidden: '640',
      subsampling_factor: '8',
    })
    expect(readMetadataInt(metadata, 'vocab_size')).toBe(1024)
    expect(readMetadataInt(metadata, 'normalize_type')).toBeNull()
    expect(readMetadataInt(metadata, 'missing')).toBeNull()
  })

  it('مدل بدون متادیتا نقشهٔ خالی می‌دهد', () => {
    expect(readOnnxMetadata(Uint8Array.from([...varintField(1, 8), ...lengthDelimited(4, utf8('ai.onnx'))]))).toEqual({})
  })

  it('دادهٔ ناقص یا خراب را رد می‌کند', () => {
    expect(() => readOnnxMetadata(Uint8Array.from([0x72, 0xff]))).toThrow()
    const truncated = Uint8Array.from([...lengthDelimited(14, utf8('abcdefghij'))]).slice(0, 5)
    expect(() => readOnnxMetadata(truncated)).toThrow()
  })
})
