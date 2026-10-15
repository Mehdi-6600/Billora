/**
 * NeMo-compatible 80-dim log-mel front end for Shenava Koochik (16 kHz mono float32).
 *
 * Verified against:
 *  - NeMo `FilterbankFeatures` (preemph 0.97, hann window with `periodic=False` padded into
 *    n_fft=512, `torch.stft(center=True)`, `abs()**2`, `log(x + 2**-24)`, `normalize="NA"`):
 *    https://github.com/NVIDIA/NeMo/blob/main/nemo/collections/asr/parts/preprocessing/features.py
 *  - The model repository's own description ("16 kHz · 80-dim log-mel", `normalize=NA`) and the
 *    `preprocessor.json` published by the independent browser implementation `setbap/shenava`.
 *
 * No mean/variance normalisation is applied: the encoder metadata sets `normalize_type=""`
 * (NeMo `NA`) and sherpa-onnx explicitly skips normalisation for these models
 * (`offline-recognizer-transducer-nemo-impl.h`: `feat_config.nemo_normalize_type = ""`).
 */

import { SHENAVA_N_FFT, SHENAVA_N_MELS, SHENAVA_SAMPLE_RATE, shenavaMelFilterBank } from './melFilters'

export const SHENAVA_WIN_LENGTH = 400
export const SHENAVA_HOP_LENGTH = 160
export const SHENAVA_PREEMPHASIS = 0.97
export const SHENAVA_LOG_ZERO_GUARD = 2 ** -24

/**
 * NeMo pads the signal with `n_fft / 2` samples on both sides of the STFT. Current NeMo passes
 * `pad_mode="constant"` to `torch.stft`; the third-party implementation that ships the sibling
 * CTC model uses mirrored (reflect) padding. Both only affect the very first/last frames, so the
 * mode stays configurable to allow an on-device A/B test.
 */
export type PadMode = 'constant' | 'reflect'

export interface LogMelOptions {
  nMels?: number
  preemphasis?: number
  logZeroGuard?: number
  padMode?: PadMode
}

export interface LogMelResult {
  /** Row-major features with shape `frames × nMels`, the layout NeMo's encoder expects. */
  features: Float32Array
  frames: number
  dim: number
}

/** `torch.hann_window(n, periodic=False)`. */
export function hannWindowPeriodicFalse(length: number): Float32Array {
  const window = new Float32Array(length)
  if (length <= 1) {
    window[0] = 1
    return window
  }
  const denominator = length - 1
  for (let i = 0; i < length; i += 1) {
    window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / denominator)
  }
  return window
}

/** The 400-sample window centred inside an n_fft-long frame, exactly like `torch.stft`. */
export function paddedWindow(winLength: number, nFft: number): Float32Array {
  const window = hannWindowPeriodicFalse(winLength)
  const padded = new Float32Array(nFft)
  padded.set(window, Math.floor((nFft - winLength) / 2))
  return padded
}

/** Normalised-in-place radix-2 FFT (`real`/`imag` must have a power-of-two length). */
export function fftRadix2(real: Float32Array, imag: Float32Array): void {
  const n = real.length
  if (n !== imag.length || (n & (n - 1)) !== 0) throw new Error('FFT size must be a power of two')

  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      const tr = real[i]!
      real[i] = real[j]!
      real[j] = tr
      const ti = imag[i]!
      imag[i] = imag[j]!
      imag[j] = ti
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const angle = (-2 * Math.PI) / len
    const wLenRe = Math.cos(angle)
    const wLenIm = Math.sin(angle)
    const half = len >> 1
    for (let start = 0; start < n; start += len) {
      let wRe = 1
      let wIm = 0
      for (let j = 0; j < half; j += 1) {
        const oddIndex = start + j + half
        const evenRe = real[start + j]!
        const evenIm = imag[start + j]!
        const oddRe = real[oddIndex]!
        const oddIm = imag[oddIndex]!
        const vRe = oddRe * wRe - oddIm * wIm
        const vIm = oddRe * wIm + oddIm * wRe
        real[start + j] = evenRe + vRe
        imag[start + j] = evenIm + vIm
        real[oddIndex] = evenRe - vRe
        imag[oddIndex] = evenIm - vIm
        const nextRe = wRe * wLenRe - wIm * wLenIm
        wIm = wRe * wLenIm + wIm * wLenRe
        wRe = nextRe
      }
    }
  }
}

/** NeMo applies preemphasis with `out[0] = x[0]`, `out[i] = x[i] - coeff * x[i - 1]`. */
export function applyPreemphasis(pcm: Float32Array, coefficient: number): Float32Array {
  const out = new Float32Array(pcm.length)
  if (pcm.length === 0) return out
  out[0] = pcm[0]!
  for (let i = 1; i < pcm.length; i += 1) out[i] = pcm[i]! - coefficient * pcm[i - 1]!
  return out
}

function reflectIndex(index: number, length: number): number {
  if (length <= 1) return 0
  const period = 2 * (length - 1)
  let value = index % period
  if (value < 0) value += period
  return value >= length ? period - value : value
}

/** `center=True` padding of `pad` samples on both sides. */
export function padSignal(pcm: Float32Array, pad: number, mode: PadMode): Float32Array {
  if (pad <= 0 || pcm.length === 0) return pcm
  const out = new Float32Array(pcm.length + pad * 2)
  out.set(pcm, pad)
  for (let i = 0; i < pad; i += 1) {
    if (mode === 'constant') {
      out[i] = 0
      out[pad + pcm.length + i] = 0
    } else {
      out[i] = pcm[reflectIndex(i - pad, pcm.length)]!
      out[pad + pcm.length + i] = pcm[reflectIndex(pcm.length + i, pcm.length)]!
    }
  }
  return out
}

/** `1 + floor(numSamples / hop)` frames, matching `torch.stft(center=True)` on a 1-D signal. */
export function frameCount(numSamples: number, hopLength = SHENAVA_HOP_LENGTH): number {
  if (!(numSamples > 0)) return 0
  return 1 + Math.floor(numSamples / hopLength)
}

/**
 * Computes log-mel features for 16 kHz mono PCM.
 *
 * @param pcm Samples in [-1, 1]. Longer input than ~20 s should be chunked by the caller.
 */
export function computeLogMel(pcm: Float32Array, options: LogMelOptions = {}): LogMelResult {
  const dim = options.nMels ?? SHENAVA_N_MELS
  const preemphasis = options.preemphasis ?? SHENAVA_PREEMPHASIS
  const logZeroGuard = options.logZeroGuard ?? SHENAVA_LOG_ZERO_GUARD
  const padMode = options.padMode ?? 'constant'
  const filters = dim === SHENAVA_N_MELS ? shenavaMelFilterBank() : shenavaMelFilterBank().slice(0, dim)

  const frames = frameCount(pcm.length)
  const features = new Float32Array(frames * dim)
  if (frames === 0) return { features, frames: 0, dim }

  const emphasised = applyPreemphasis(pcm, preemphasis)
  const padded = padSignal(emphasised, SHENAVA_N_FFT / 2, padMode)
  const window = paddedWindow(SHENAVA_WIN_LENGTH, SHENAVA_N_FFT)
  const numFreqs = SHENAVA_N_FFT / 2 + 1
  const real = new Float32Array(SHENAVA_N_FFT)
  const imag = new Float32Array(SHENAVA_N_FFT)
  const power = new Float32Array(numFreqs)

  for (let t = 0; t < frames; t += 1) {
    const start = t * SHENAVA_HOP_LENGTH
    real.fill(0)
    imag.fill(0)
    for (let i = 0; i < SHENAVA_N_FFT; i += 1) {
      real[i] = (padded[start + i] ?? 0) * window[i]!
    }
    fftRadix2(real, imag)
    for (let k = 0; k < numFreqs; k += 1) {
      const re = real[k]!
      const im = imag[k]!
      power[k] = re * re + im * im
    }
    for (let m = 0; m < dim; m += 1) {
      const filter = filters[m]!
      let sum = 0
      for (let k = 0; k < numFreqs; k += 1) sum += power[k]! * filter[k]!
      features[t * dim + m] = Math.log(sum + logZeroGuard)
    }
  }

  return { features, frames, dim }
}

export const FEATURE_FRAME_SHIFT_SECONDS = SHENAVA_HOP_LENGTH / SHENAVA_SAMPLE_RATE
