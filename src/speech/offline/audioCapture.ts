/**
 * Microphone capture for the offline engine.
 *
 * The engine needs 16 kHz mono float samples. Safari only exposes 44.1/48 kHz contexts, so a tiny
 * linear resampler runs on stop; the pure parts of that (`resampleLinear`, `concatFloat32`) are
 * tested without a browser. `ScriptProcessorNode` is used on purpose: `AudioWorklet` needs an extra
 * worklet file and is less predictable on iOS Safari, while the deprecated node works everywhere.
 */

export interface MicCapture {
  /** Stops the microphone and resolves with the recorded PCM at `sampleRate`. */
  stop(): Promise<Float32Array>
  /** Stops the microphone and discards the audio. */
  cancel(): void
  readonly sampleCount: number
  readonly sampleRate: number
}

export interface MicCaptureOptions {
  targetSampleRate?: number
  maxSeconds?: number
  onProgress?: (sampleCount: number) => void
  mediaDevices?: Pick<MediaDevices, 'getUserMedia'>
  audioContextFactory?: (sampleRate: number) => AudioContext
}

export type MicCaptureFactory = (options: MicCaptureOptions) => Promise<MicCapture>

export const TARGET_SAMPLE_RATE = 16_000
export const MAX_CAPTURE_SECONDS = 30

/** Simple linear resampler; good enough for a 30 s command clip. */
export function resampleLinear(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (input.length === 0) return new Float32Array(0)
  if (fromRate === toRate || fromRate <= 0 || toRate <= 0) return input
  const ratio = fromRate / toRate
  const outputLength = Math.max(1, Math.floor(input.length / ratio))
  const output = new Float32Array(outputLength)
  for (let i = 0; i < outputLength; i += 1) {
    const position = i * ratio
    const index = Math.floor(position)
    const fraction = position - index
    const current = input[index] ?? 0
    const next = input[Math.min(index + 1, input.length - 1)] ?? current
    output[i] = current + (next - current) * fraction
  }
  return output
}

export function concatFloat32(chunks: readonly Float32Array[], total: number): Float32Array {
  if (chunks.length === 1) return chunks[0]!.length === total ? chunks[0]! : Float32Array.from(chunks[0]!.subarray(0, total))
  const output = new Float32Array(total)
  let offset = 0
  for (const chunk of chunks) {
    const slice = offset + chunk.length > total ? chunk.subarray(0, Math.max(0, total - offset)) : chunk
    output.set(slice, offset)
    offset += slice.length
    if (offset >= total) break
  }
  return output
}

export const createMicCapture: MicCaptureFactory = async (options: MicCaptureOptions = {}): Promise<MicCapture> => {
  const targetSampleRate = options.targetSampleRate ?? TARGET_SAMPLE_RATE
  const maxSamples = Math.round((options.maxSeconds ?? MAX_CAPTURE_SECONDS) * targetSampleRate)
  const mediaDevices = options.mediaDevices ?? navigator.mediaDevices
  if (!mediaDevices?.getUserMedia) throw Object.assign(new Error('microphone unavailable'), { name: 'NotFoundError' })

  const stream = await mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  })

  let context: AudioContext
  try {
    context = options.audioContextFactory
      ? options.audioContextFactory(targetSampleRate)
      : new AudioContext({ sampleRate: targetSampleRate })
  } catch {
    context = options.audioContextFactory ? options.audioContextFactory(targetSampleRate) : new AudioContext()
  }
  if (context.state === 'suspended') {
    try {
      await context.resume()
    } catch {
      // A suspended context still delivers audio on some iOS versions once the user gesture lands.
    }
  }

  const source = context.createMediaStreamSource(stream)
  const processor = context.createScriptProcessor(4096, 1, 1)
  const silence = context.createGain()
  silence.gain.value = 0

  const chunks: Float32Array[] = []
  let total = 0
  let stopped = false

  processor.onaudioprocess = (event: AudioProcessingEvent) => {
    if (stopped || total >= maxSamples) return
    const channel = event.inputBuffer.getChannelData(0)
    const remaining = maxSamples - total
    const copy = Float32Array.from(remaining < channel.length ? channel.subarray(0, remaining) : channel)
    chunks.push(copy)
    total += copy.length
    options.onProgress?.(total)
  }

  source.connect(processor)
  processor.connect(silence)
  silence.connect(context.destination)

  const teardown = () => {
    if (stopped) return
    stopped = true
    processor.onaudioprocess = null
    try {
      processor.disconnect()
      source.disconnect()
      silence.disconnect()
    } catch {
      // Nodes may already be detached.
    }
    for (const track of stream.getTracks()) track.stop()
    void context.close().catch(() => undefined)
  }

  const captured = concatFloat32(chunks, total)
  return {
    get sampleCount() {
      return total
    },
    sampleRate: targetSampleRate,
    async stop() {
      const raw = concatFloat32(chunks, total)
      const sourceRate = context.sampleRate
      teardown()
      return sourceRate === targetSampleRate ? raw : resampleLinear(raw, sourceRate, targetSampleRate)
    },
    cancel() {
      teardown()
      captured.fill(0)
      chunks.length = 0
      total = 0
    },
  }
}
