/**
 * Slaney-normalised mel filterbank, computed at runtime.
 *
 * The Shenava Koochik models are NeMo FastConformer models whose preprocessor builds its
 * filterbank with `librosa.filters.mel(sr=16000, n_fft=512, n_mels=80, fmin=0, fmax=8000,
 * norm='slaney')` — see
 * https://github.com/NVIDIA/NeMo/blob/main/nemo/collections/asr/parts/preprocessing/features.py
 * (`FilterbankFeatures.__init__`). This module reproduces that matrix with the same maths so no
 * 90 KB JSON table has to be shipped (and so the values are unit-testable).
 */

export interface MelFilterBankOptions {
  sampleRate: number
  nFft: number
  nMels: number
  fmin: number
  fmax: number
}

/** Slaney's mel scale: linear below 1 kHz, logarithmic above (librosa `hz_to_mel`, htk=False). */
export function hzToMelSlaney(hz: number): number {
  const fSp = 200 / 3
  const minLogHz = 1000
  const minLogMel = minLogHz / fSp
  const logstep = Math.log(6.4) / 27
  return hz < minLogHz ? hz / fSp : minLogMel + Math.log(hz / minLogHz) / logstep
}

export function melToHzSlaney(mel: number): number {
  const fSp = 200 / 3
  const minLogHz = 1000
  const minLogMel = minLogHz / fSp
  const logstep = Math.log(6.4) / 27
  return mel < minLogMel ? mel * fSp : minLogHz * Math.exp(logstep * (mel - minLogMel))
}

/**
 * `librosa.filters.mel` equivalent (htk=False, norm='slaney').
 * Returns `nMels` rows of `nFft / 2 + 1` weights, row-major.
 */
export function melFilterBank({ sampleRate, nFft, nMels, fmin, fmax }: MelFilterBankOptions): Float32Array[] {
  if (!(nFft > 0) || nFft % 2 !== 0) throw new Error('nFft must be a positive even number')
  if (!(nMels > 0)) throw new Error('nMels must be positive')
  if (!(fmax > fmin)) throw new Error('fmax must be greater than fmin')

  const numFreqs = nFft / 2 + 1
  // librosa: fftfreqs = linspace(0, sr / 2, 1 + n_fft // 2)
  const fftFreqs = new Float64Array(numFreqs)
  for (let k = 0; k < numFreqs; k += 1) {
    fftFreqs[k] = (k * (sampleRate / 2)) / (numFreqs - 1)
  }

  const melMin = hzToMelSlaney(fmin)
  const melMax = hzToMelSlaney(fmax)
  const melPoints = new Float64Array(nMels + 2)
  for (let i = 0; i < nMels + 2; i += 1) {
    melPoints[i] = melMin + ((melMax - melMin) * i) / (nMels + 1)
  }

  const hzPoints = new Float64Array(nMels + 2)
  for (let i = 0; i < nMels + 2; i += 1) hzPoints[i] = melToHzSlaney(melPoints[i]!)

  // librosa builds the ramps from the *Hz* band edges (`mel_frequencies` returns Hz values).
  const hzDiff = new Float64Array(nMels + 1)
  for (let i = 0; i < nMels + 1; i += 1) hzDiff[i] = hzPoints[i + 1]! - hzPoints[i]!

  const filters: Float32Array[] = []
  for (let m = 0; m < nMels; m += 1) {
    const row = new Float32Array(numFreqs)
    for (let k = 0; k < numFreqs; k += 1) {
      const freq = fftFreqs[k]!
      const lower = (freq - hzPoints[m]!) / hzDiff[m]!
      const upper = (hzPoints[m + 2]! - freq) / hzDiff[m + 1]!
      row[k] = Math.max(0, Math.min(lower, upper))
    }
    // Slaney normalisation: 2 / (mel_f[m + 2] - mel_f[m]) in Hz.
    const enorm = 2 / (hzPoints[m + 2]! - hzPoints[m]!)
    for (let k = 0; k < numFreqs; k += 1) row[k] = row[k]! * enorm
    filters.push(row)
  }

  return filters
}

export const SHENAVA_SAMPLE_RATE = 16_000
export const SHENAVA_N_FFT = 512
export const SHENAVA_N_MELS = 80

let cachedFilters: Float32Array[] | null = null

/** The 80×257 filterbank used by Shenava Koochik (16 kHz, n_fft 512, 0–8000 Hz, slaney). */
export function shenavaMelFilterBank(): Float32Array[] {
  if (!cachedFilters) {
    cachedFilters = melFilterBank({
      sampleRate: SHENAVA_SAMPLE_RATE,
      nFft: SHENAVA_N_FFT,
      nMels: SHENAVA_N_MELS,
      fmin: 0,
      fmax: SHENAVA_SAMPLE_RATE / 2,
    })
  }
  return cachedFilters
}
