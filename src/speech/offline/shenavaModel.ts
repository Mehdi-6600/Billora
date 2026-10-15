/**
 * Which files the offline engine needs, how big they are, and where they are served from.
 *
 * Sizes and hashes come from the Hugging Face repository metadata (`tree/main` with `lfs` objects):
 * https://huggingface.co/Reza2kn/Shenava-Koochik-v1.5-RNNT-sherpa-onnx
 *
 * The files are **never committed** (see `.gitignore`) and never fetched from a CDN at runtime:
 * Billora must keep working offline, so the engine only ever reads same-origin URLs such as
 * `/models/shenava/encoder.int8.onnx`. `npm run model:download` fetches and verifies them locally.
 */

export interface ShenavaModelFile {
  readonly name: string
  readonly bytes: number
  /** SHA-256 taken from the Hugging Face LFS metadata; `null` when the file is not stored in LFS. */
  readonly sha256: string | null
}

export const SHENAVA_MODEL_DIRECTORY = 'models/shenava'

export const SHENAVA_MODEL_FILES: readonly ShenavaModelFile[] = [
  {
    name: 'encoder.int8.onnx',
    bytes: 131_342_912,
    sha256: 'b9d975c1af77002f83897017e3adaaa6510148c6ba332df92b8d281369f2fdd3',
  },
  {
    name: 'decoder.int8.onnx',
    bytes: 3_956_194,
    sha256: '0adaad326a536dfbb30c67287e909b4e6f0775fccb8c3ca47270890364824947',
  },
  {
    name: 'joiner.int8.onnx',
    bytes: 1_408_514,
    sha256: 'e441ed265c961ff4a2436aa8bc36638e65849445e7a1f65cf263f0c310593dde',
  },
  { name: 'tokens.txt', bytes: 12_236, sha256: null },
] as const

export const SHENAVA_CACHE_NAME = 'billora-shenava-koochik-1.5-int8'

/** Upstream source of the same files, used once when nobody put them next to the app. */
export const SHENAVA_HUB_REPO = 'Reza2kn/Shenava-Koochik-v1.5-RNNT-sherpa-onnx'
export const SHENAVA_HUB_REVISION = 'main'
export const SHENAVA_HUB_ENDPOINT = 'https://huggingface.co'

/**
 * Where a file lives when it is not installed locally. Hugging Face serves the LFS content with
 * permissive CORS headers, which is what makes a browser-side one-time download possible even on
 * a cross-origin isolated page (COEP allows CORS responses).
 */
export function shenavaHubUrl(fileName: string, endpoint = SHENAVA_HUB_ENDPOINT, revision = SHENAVA_HUB_REVISION): string {
  return `${endpoint.replace(/\/$/, '')}/${SHENAVA_HUB_REPO}/resolve/${revision}/${fileName}`
}

/** Joins a Vite base URL (`/` or `/Billora/`) with the model directory. */
export function shenavaModelUrl(fileName: string, baseUrl = '/'): string {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
  return `${base}${SHENAVA_MODEL_DIRECTORY}/${fileName}`
}

export interface ShenavaModelAvailability {
  available: boolean
  missing: string[]
  /** `unsupported` when the runtime cannot run it at all, `unreachable` when the probe failed. */
  reason?: 'missing' | 'unreachable' | 'unsupported'
  /** `local` when the files are served by the app itself, `hub` when they must be downloaded once. */
  source?: 'local' | 'hub'
}

export interface ShenavaProbeOptions {
  /** Also accept the upstream Hugging Face copies (one-time download on first use). */
  allowRemote?: boolean
  hubEndpoint?: string
}

export function shenavaRuntimeSupported(scope: { Worker?: unknown; WebAssembly?: unknown } = globalThis): boolean {
  return typeof scope.Worker !== 'undefined' && typeof scope.WebAssembly !== 'undefined'
}

type ResponseLike = {
  ok: boolean
  status?: number
  headers: { get(name: string): string | null }
}

type Fetcher = (input: string, init?: { method?: string; headers?: Record<string, string> }) => Promise<ResponseLike>

const PROBE_TIMEOUT_MS = 8_000

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), ms)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

type FileState = 'ok' | 'absent' | 'unreachable'

/**
 * HEAD first (cheap), then a 1-byte ranged GET for hosts that omit `Content-Length`.
 * A 404/403 means the file is genuinely absent; a thrown/aborted request means the host is down.
 */
async function describeFile(fetcher: Fetcher, url: string, expectedBytes: number): Promise<FileState> {
  let sawResponse = false
  try {
    const head = await withTimeout(fetcher(url, { method: 'HEAD' }), PROBE_TIMEOUT_MS)
    sawResponse = true
    if (head.ok) {
      const length = Number(head.headers.get('content-length') ?? '')
      if (Number.isFinite(length) && length > 0) return length === expectedBytes ? 'ok' : 'absent'
    }
  } catch {
    // Fall through to the ranged request below.
  }

  try {
    const ranged = await withTimeout(
      fetcher(url, { headers: { Range: 'bytes=0-0' } }),
      PROBE_TIMEOUT_MS,
    )
    sawResponse = true
    if (!ranged.ok) return 'absent'
    const contentRange = ranged.headers.get('content-range')
    if (contentRange) {
      const total = Number(contentRange.split('/').pop() ?? '')
      if (Number.isFinite(total) && total > 0) return total === expectedBytes ? 'ok' : 'absent'
    }
    // Servers that ignore `Range` answer 200; only accept them when the length matches, otherwise
    // an SPA fallback page (Vite dev server, some CDNs) would look like an installed model.
    const length = Number(ranged.headers.get('content-length') ?? '')
    if (Number.isFinite(length) && length > 0) return length === expectedBytes ? 'ok' : 'absent'
    return 'absent'
  } catch {
    return sawResponse ? 'absent' : 'unreachable'
  }
}

/**
 * Checks whether the four model files are served from the app itself.
 * Returns `available: false` when the runtime is unsupported or any file is missing/short.
 */
export async function probeShenavaModel(
  fetcher: Fetcher = globalThis.fetch as unknown as Fetcher,
  baseUrl = '/',
  files: readonly ShenavaModelFile[] = SHENAVA_MODEL_FILES,
  runtimeSupported: boolean = shenavaRuntimeSupported(),
  probeOptions: ShenavaProbeOptions = {},
): Promise<ShenavaModelAvailability> {
  if (!runtimeSupported) {
    return { available: false, missing: files.map((file) => file.name), reason: 'unsupported' }
  }

  const missing: string[] = []
  let unreachableCount = 0

  for (const file of files) {
    const state = await describeFile(fetcher, shenavaModelUrl(file.name, baseUrl), file.bytes)
    if (state === 'unreachable') unreachableCount += 1
    if (state !== 'ok') missing.push(file.name)
  }

  if (missing.length === 0) return { available: true, missing: [], source: 'local' }

  if (probeOptions.allowRemote) {
    const remoteMissing: string[] = []
    let remoteUnreachable = 0
    for (const file of files) {
      const state = await describeFile(
        fetcher,
        shenavaHubUrl(file.name, probeOptions.hubEndpoint ?? SHENAVA_HUB_ENDPOINT),
        file.bytes,
      )
      if (state === 'unreachable') remoteUnreachable += 1
      if (state !== 'ok') remoteMissing.push(file.name)
    }
    if (remoteMissing.length === 0) return { available: true, missing: [], source: 'hub' }
    return {
      available: false,
      missing,
      reason: remoteUnreachable === files.length ? 'unreachable' : 'missing',
    }
  }

  return {
    available: false,
    missing,
    reason: unreachableCount === files.length ? 'unreachable' : 'missing',
  }
}
