/**
 * Minimal RIFF/WAVE reader for the committed Persian test clip (`persian-command.wav`).
 *
 * Test-only: the app never decodes WAV files — the browser microphone path uses `decodeAudioData`
 * (`audioCapture.ts`). This reader exists so the real-model test can run the *shipped* pipeline
 * (log-mel → encoder → RNNT decoding) on a real recording without any extra dependency.
 */

export interface WavAudio {
  sampleRate: number
  channels: number
  /** Mono float samples in [-1, 1); stereo input is averaged down. */
  samples: Float32Array
}

const readAscii = (bytes: Uint8Array, offset: number, length: number): string =>
  String.fromCharCode(...bytes.subarray(offset, offset + length))

export function decodeWavPcm16(bytes: Uint8Array): WavAudio {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bytes.byteLength < 44) throw new Error('WAV is shorter than its header')
  if (readAscii(bytes, 0, 4) !== 'RIFF' || readAscii(bytes, 8, 4) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE file')
  }

  let format = -1
  let channels = 0
  let sampleRate = 0
  let bitsPerSample = 0
  let data: Uint8Array | null = null

  let offset = 12
  while (offset + 8 <= bytes.byteLength) {
    const id = readAscii(bytes, offset, 4)
    const size = view.getUint32(offset + 4, true)
    const body = offset + 8
    if (id === 'fmt ') {
      format = view.getUint16(body, true)
      channels = view.getUint16(body + 2, true)
      sampleRate = view.getUint32(body + 4, true)
      bitsPerSample = view.getUint16(body + 14, true)
    } else if (id === 'data') {
      data = bytes.subarray(body, Math.min(body + size, bytes.byteLength))
    }
    offset = body + size + (size % 2)
  }

  if (format !== 1) throw new Error(`unsupported WAV format ${format} (only PCM is read here)`)
  if (bitsPerSample !== 16) throw new Error(`unsupported bit depth ${bitsPerSample} (only 16-bit PCM)`)
  if (!data || channels < 1) throw new Error('WAV has no data chunk')

  const frames = Math.floor(data.byteLength / 2 / channels)
  const samples = new Float32Array(frames)
  const pcm = new DataView(data.buffer, data.byteOffset, data.byteLength)
  for (let frame = 0; frame < frames; frame += 1) {
    let sum = 0
    for (let channel = 0; channel < channels; channel += 1) {
      sum += pcm.getInt16((frame * channels + channel) * 2, true)
    }
    samples[frame] = sum / channels / 32_768
  }

  return { sampleRate, channels, samples }
}
