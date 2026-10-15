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

/**
 * Some hosts refuse single files above their static-upload limit (Vercel Hobby: 100 MB), which the
 * 125 MiB encoder exceeds. Instead of shipping nothing and letting every browser download it from a
 * third party, the build splits it into chunks below that limit and writes what it did into
 * `model-parts.json`. The engine reassembles the chunks in memory, so the model still arrives from
 * the app's own origin — the only route that keeps working when the third-party host is blocked.
 */
export const SHENAVA_PARTS_FILE = 'model-parts.json'

export interface ShenavaModelPart {
  /** File name next to the model files, e.g. `encoder.int8.onnx.part0`. */
  readonly name: string
  readonly bytes: number
  readonly sha256?: string | null
}

export interface ShenavaPartsEntry {
  readonly bytes: number
  readonly sha256?: string | null
  readonly parts: readonly ShenavaModelPart[]
}

export interface ShenavaPartsManifest {
  readonly version?: number
  readonly chunkBytes?: number
  readonly files: Record<string, ShenavaPartsEntry>
}

/** Tolerant parser: a malformed manifest must never break the engine, it just means "no chunks". */
export function parsePartsManifest(value: unknown): ShenavaPartsManifest | null {
  if (!value || typeof value !== 'object') return null
  const files = (value as { files?: unknown }).files
  if (!files || typeof files !== 'object') return null
  const parsed: Record<string, ShenavaPartsEntry> = {}
  for (const [name, rawEntry] of Object.entries(files as Record<string, unknown>)) {
    if (!rawEntry || typeof rawEntry !== 'object') continue
    const entry = rawEntry as { bytes?: unknown; sha256?: unknown; parts?: unknown }
    if (!Array.isArray(entry.parts)) continue
    const parts: ShenavaModelPart[] = []
    for (const rawPart of entry.parts) {
      if (!rawPart || typeof rawPart !== 'object') continue
      const part = rawPart as { name?: unknown; bytes?: unknown; sha256?: unknown }
      if (typeof part.name !== 'string' || !Number.isFinite(Number(part.bytes)) || Number(part.bytes) <= 0) continue
      parts.push({
        name: part.name,
        bytes: Number(part.bytes),
        sha256: typeof part.sha256 === 'string' ? part.sha256 : null,
      })
    }
    if (parts.length === 0) continue
    parsed[name] = {
      bytes: Number.isFinite(Number(entry.bytes)) ? Number(entry.bytes) : parts.reduce((sum, part) => sum + part.bytes, 0),
      sha256: typeof entry.sha256 === 'string' ? entry.sha256 : null,
      parts,
    }
  }
  return Object.keys(parsed).length > 0 ? { files: parsed } : null
}

/**
 * Chunks of `fileName`, but only when the manifest describes a complete, consistent split: the
 * chunks must belong to that file and their sizes must add up to the published size. Anything else
 * would look like an installed model while the engine would later fail to assemble it.
 */
export function partsForFile(
  manifest: ShenavaPartsManifest | null,
  fileName: string,
  expectedBytes?: number,
): ShenavaModelPart[] | null {
  const entry = manifest?.files?.[fileName]
  if (!entry || entry.parts.length === 0) return null
  for (const part of entry.parts) {
    if (!part.name.startsWith(`${fileName}.part`)) return null
  }
  const total = entry.parts.reduce((sum, part) => sum + part.bytes, 0)
  if (expectedBytes !== undefined && total !== expectedBytes) return null
  if (entry.bytes !== total) return null
  return [...entry.parts]
}

export function partsTotalBytes(parts: readonly ShenavaModelPart[]): number {
  return parts.reduce((sum, part) => sum + part.bytes, 0)
}

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
  return `${shenavaModelDirectoryUrl(baseUrl)}${fileName}`
}

/** Site-absolute (or absolute) directory that holds the model files, always with a trailing slash. */
export function shenavaModelDirectoryUrl(baseUrl = '/'): string {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
  return `${base}${SHENAVA_MODEL_DIRECTORY}/`
}

/** Directory that holds the ONNX Runtime Web runtime files (`public/ort/`, copied at build time). */
export function shenavaOrtDirectoryUrl(baseUrl = '/'): string {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
  return `${base}ort/`
}

/**
 * Turns a path (or an already absolute URL) into an absolute URL.
 *
 * `baseHref` must itself be absolute. Browsers reject a relative base outright — the original bug
 * here was `new URL('encoder.int8.onnx', '/models/shenava/')`, which throws `Invalid base URL` and
 * killed the engine before a single byte was fetched. Callers pass `self.location.href` (worker) or
 * `location.href` (page); `null` means "not resolvable here".
 */
export function resolveAbsoluteUrl(value: string, baseHref?: string | null): string | null {
  try {
    return new URL(value).href
  } catch {
    // Not absolute on its own: it needs a base.
  }
  if (baseHref) {
    try {
      return new URL(value, baseHref).href
    } catch {
      // Unusable base, fall through to `null`.
    }
  }
  return null
}

/** `location.href` of the calling realm when it exists (page, worker, jsdom). */
export function currentBaseHref(scope?: { location?: { href?: string } }): string | null {
  const source = scope ?? (globalThis as { location?: { href?: string } })
  const href = source?.location?.href
  return typeof href === 'string' && href.length > 0 ? href : null
}

export interface ShenavaModelAvailability {
  available: boolean
  missing: string[]
  /** `unsupported` when the runtime cannot run it at all, `unreachable` when the probe failed. */
  reason?: 'missing' | 'unreachable' | 'unsupported'
  /**
   * `local`: the app serves every file. `hub`: nothing is shipped, the browser downloads all four
   * once. `mixed`: part of the model ships with the app and the rest comes from the Hub on first use
   * (this is what happens when a host refuses files above its static size limit).
   */
  source?: 'local' | 'hub' | 'mixed'
}

export interface ShenavaWorkerUrlContext {
  /** Vite base URL of the app (`/` or `/Billora/`). */
  baseUrl?: string
  /** Absolute `location.href` of the page (preferred) or of the worker script. */
  baseHref?: string | null
  /** Model directory supplied by the main thread; absolute or site-absolute. */
  modelBaseUrl?: string
  /** Same-origin file name → upstream URL, used when the local file is absent. */
  remoteModelUrls?: Record<string, string>
}

export interface ShenavaWorkerUrls {
  /** Directory ONNX Runtime Web loads its `.mjs`/`.wasm` from — always same-origin and absolute. */
  ortDirectoryUrl: string
  modelFileUrl: (fileName: string) => string
  /** Local URL first, then the upstream copy (if the main thread supplied one). */
  candidatesFor: (fileName: string) => { url: string; source: 'network' | 'hub' }[]
}

/**
 * Builds every URL the worker needs, always absolutely.
 *
 * This used to be three inline `new URL(...)` calls inside the worker, where
 * `new URL('encoder.int8.onnx', '/models/shenava/')` threw `Invalid base URL` in every browser and
 * made the offline engine impossible to start. Keeping it here means it is covered by ordinary unit
 * tests instead of only by a real device.
 */
export function resolveShenavaWorkerUrls(context: ShenavaWorkerUrlContext): ShenavaWorkerUrls {
  const baseHref = context.baseHref ?? null
  if (!baseHref) throw new Error('base URL is unknown: cannot resolve the model files')

  const ortDirectoryUrl = resolveAbsoluteUrl(shenavaOrtDirectoryUrl(context.baseUrl ?? '/'), baseHref)
  if (!ortDirectoryUrl) throw new Error(`cannot resolve the ONNX Runtime Web directory against ${baseHref}`)

  const directory = context.modelBaseUrl ?? shenavaModelDirectoryUrl(context.baseUrl ?? '/')
  const absoluteDirectory = resolveAbsoluteUrl(directory.endsWith('/') ? directory : `${directory}/`, baseHref)
  if (!absoluteDirectory) throw new Error(`cannot resolve the model directory: ${directory}`)

  const modelFileUrl = (fileName: string): string => {
    const resolved = resolveAbsoluteUrl(fileName, absoluteDirectory)
    if (!resolved) throw new Error(`cannot resolve the model file: ${fileName}`)
    return resolved
  }

  return {
    ortDirectoryUrl,
    modelFileUrl,
    candidatesFor: (fileName) => {
      const candidates: { url: string; source: 'network' | 'hub' }[] = [
        { url: modelFileUrl(fileName), source: 'network' },
      ]
      const remote = context.remoteModelUrls?.[fileName]
      if (remote) candidates.push({ url: remote, source: 'hub' })
      return candidates
    },
  }
}

export interface ShenavaProbeOptions {
  /** Also accept the upstream copies (one-time download on first use). */
  allowRemote?: boolean
  /** Hugging Face host override (mirrors). */
  hubEndpoint?: string
  /**
   * Directory that holds the remote copies, e.g. a GitHub Release asset URL, a Vercel Blob store or
   * an R2 bucket. When set it replaces Hugging Face as the remote host.
   */
  remoteBaseUrl?: string | null
}

export const SHENAVA_REMOTE_BASE_ENV = 'VITE_SHENAVA_MODEL_BASE_URL'

/**
 * Remote host configured at build time (`VITE_SHENAVA_MODEL_BASE_URL`), or `null` for Hugging Face.
 *
 * This is the escape hatch for host size limits: if the app host refuses to serve the 131 MB
 * encoder (Vercel's documented 100 MB static-upload limit on the Hobby plan, for example), the
 * files can live on a GitHub Release, a Vercel Blob store, R2 or any CDN and the app is pointed at
 * them with this single variable — no code change and no per-user setup.
 */
export function configuredRemoteBaseUrl(
  env: Record<string, unknown> | undefined = import.meta.env as Record<string, unknown> | undefined,
): string | null {
  const value = env?.[SHENAVA_REMOTE_BASE_ENV]
  return typeof value === 'string' && value.trim().length > 0 ? value.trim().replace(/\/+$/, '') : null
}

/** URL of a model file on the remote host: configured base first, Hugging Face otherwise. */
export function shenavaRemoteFileUrl(fileName: string, options: ShenavaProbeOptions = {}): string {
  const base = options.remoteBaseUrl ?? configuredRemoteBaseUrl()
  if (base) return `${base.replace(/\/+$/, '')}/${fileName}`
  return shenavaHubUrl(fileName, options.hubEndpoint ?? SHENAVA_HUB_ENDPOINT)
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

export interface DescribedFile {
  state: FileState
  /** `Content-Length` (or the total from `Content-Range`) when the host reported one. */
  bytes: number | null
}

/**
 * HEAD first (cheap), then a 1-byte ranged GET for hosts that omit `Content-Length`.
 * A 404/403 means the file is genuinely absent; a thrown/aborted request means the host is down.
 */
async function describeFile(fetcher: Fetcher, url: string, expectedBytes: number): Promise<DescribedFile> {
  let sawResponse = false
  try {
    const head = await withTimeout(fetcher(url, { method: 'HEAD' }), PROBE_TIMEOUT_MS)
    sawResponse = true
    if (head.ok) {
      const length = Number(head.headers.get('content-length') ?? '')
      if (Number.isFinite(length) && length > 0) {
        return { state: length === expectedBytes ? 'ok' : 'absent', bytes: length }
      }
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
    if (!ranged.ok) return { state: 'absent', bytes: null }
    const contentRange = ranged.headers.get('content-range')
    if (contentRange) {
      const total = Number(contentRange.split('/').pop() ?? '')
      if (Number.isFinite(total) && total > 0) {
        return { state: total === expectedBytes ? 'ok' : 'absent', bytes: total }
      }
    }
    // Servers that ignore `Range` answer 200; only accept them when the length matches, otherwise
    // an SPA fallback page (Vite dev server, some CDNs) would look like an installed model.
    const length = Number(ranged.headers.get('content-length') ?? '')
    if (Number.isFinite(length) && length > 0) {
      return { state: length === expectedBytes ? 'ok' : 'absent', bytes: length }
    }
    return { state: 'absent', bytes: null }
  } catch {
    return { state: sawResponse ? 'absent' : 'unreachable', bytes: null }
  }
}

/** Per-file result of {@link probeShenavaModelFiles}, used by the diagnostic page. */
export interface ShenavaFileReport {
  name: string
  /** Size published in the manifest, in bytes. */
  expectedBytes: number
  local: FileState
  localBytes: number | null
  remote: FileState | 'not-checked'
  remoteBytes: number | null
  /** URL the local probe used. */
  localUrl: string
  /** URL of the remote copy that would be used, when remote checks are enabled. */
  remoteUrl: string | null
  /** Number of same-origin chunks when the file ships split (see `SHENAVA_PARTS_FILE`). */
  parts?: number | null
  /** URL of the first chunk, so the diagnostic page can show where the bytes come from. */
  partsUrl?: string | null
  /** State of the chunk probe: `ok` when every chunk answered, otherwise the first failure. */
  partsState?: FileState | 'partial'
}

export interface ShenavaDetailedAvailability extends ShenavaModelAvailability {
  files: ShenavaFileReport[]
}

/** Reads `model-parts.json` from the app's own origin; a missing or broken file means "no chunks". */
export async function loadPartsManifest(
  fetcher: Fetcher = globalThis.fetch as unknown as Fetcher,
  baseUrl = '/',
): Promise<ShenavaPartsManifest | null> {
  try {
    const response = await withTimeout(fetcher(shenavaModelUrl(SHENAVA_PARTS_FILE, baseUrl)), PROBE_TIMEOUT_MS)
    if (!response.ok) return null
    const body = (response as unknown as { json?: () => Promise<unknown> }).json
    if (typeof body !== 'function') return null
    return parsePartsManifest(await body.call(response))
  } catch {
    return null
  }
}

/**
 * Full probe: every file is checked next to the app and, when `allowRemote` is set, on the remote
 * host as well. The engine is available when each file can be loaded from at least one of them.
 */
export async function probeShenavaModelFiles(
  fetcher: Fetcher = globalThis.fetch as unknown as Fetcher,
  baseUrl = '/',
  files: readonly ShenavaModelFile[] = SHENAVA_MODEL_FILES,
  runtimeSupported: boolean = shenavaRuntimeSupported(),
  probeOptions: ShenavaProbeOptions = {},
): Promise<ShenavaDetailedAvailability> {
  if (!runtimeSupported) {
    return {
      available: false,
      missing: files.map((file) => file.name),
      reason: 'unsupported',
      files: files.map((file) => ({
        name: file.name,
        expectedBytes: file.bytes,
        local: 'absent' as FileState,
        localBytes: null,
        remote: 'not-checked' as const,
        remoteBytes: null,
        localUrl: shenavaModelUrl(file.name, baseUrl),
        remoteUrl: null,
      })),
    }
  }

  const reports: ShenavaFileReport[] = []
  let unreachableCount = 0
  let localHits = 0

  for (const file of files) {
    const localUrl = shenavaModelUrl(file.name, baseUrl)
    const described = await describeFile(fetcher, localUrl, file.bytes)
    if (described.state === 'unreachable') unreachableCount += 1
    if (described.state === 'ok') localHits += 1
    reports.push({
      name: file.name,
      expectedBytes: file.bytes,
      local: described.state,
      localBytes: described.bytes,
      remote: 'not-checked',
      remoteBytes: null,
      localUrl,
      remoteUrl: null,
    })
  }

  let localMissing = reports.filter((report) => report.local !== 'ok')

  // A file the host refused to store can still be served by the same origin as chunks. They are
  // checked only when something is missing, so an ordinary build pays nothing for this feature.
  if (localMissing.length > 0) {
    const manifest = await loadPartsManifest(fetcher, baseUrl)
    for (const report of localMissing) {
      const parts = partsForFile(manifest, report.name, report.expectedBytes)
      if (!parts) continue
      report.parts = parts.length
      report.partsUrl = shenavaModelUrl(parts[0]!.name, baseUrl)
      let complete = true
      for (const part of parts) {
        const described = await describeFile(fetcher, shenavaModelUrl(part.name, baseUrl), part.bytes)
        if (described.state !== 'ok') {
          complete = false
          report.partsState = described.state
          break
        }
      }
      if (complete) {
        report.local = 'ok'
        report.localBytes = report.expectedBytes
        localHits += 1
      } else {
        report.partsState = report.partsState ?? 'absent'
      }
    }
    localMissing = reports.filter((report) => report.local !== 'ok')
  }

  if (localMissing.length === 0) {
    return { available: true, missing: [], source: 'local', files: reports }
  }

  if (!probeOptions.allowRemote) {
    return {
      available: false,
      missing: localMissing.map((report) => report.name),
      reason: unreachableCount === files.length ? 'unreachable' : 'missing',
      files: reports,
    }
  }

  // A file only counts as lost when it is missing locally AND cannot be fetched remotely, so a
  // partly shipped model (see SHENAVA_MODEL_MAX_BUILD_BYTES) still gives a working engine.
  const goneEverywhere: string[] = []
  const bytesOf = new Map(files.map((file) => [file.name, file.bytes]))
  let remoteUnreachable = 0

  for (const report of localMissing) {
    const remoteUrl = shenavaRemoteFileUrl(report.name, probeOptions)
    report.remoteUrl = remoteUrl
    const described = await describeFile(fetcher, remoteUrl, bytesOf.get(report.name) ?? report.expectedBytes)
    report.remote = described.state
    report.remoteBytes = described.bytes
    if (described.state === 'ok') continue
    goneEverywhere.push(report.name)
    if (described.state === 'unreachable') remoteUnreachable += 1
  }

  if (goneEverywhere.length === 0) {
    return {
      available: true,
      missing: [],
      source: localHits > 0 ? 'mixed' : 'hub',
      files: reports,
    }
  }

  return {
    available: false,
    missing: goneEverywhere,
    reason: remoteUnreachable === goneEverywhere.length ? 'unreachable' : 'missing',
    files: reports,
  }
}

/**
 * Checks whether the four model files can be loaded (from the app itself or from the remote host).
 * Returns `available: false` when the runtime is unsupported or any file is missing/short.
 */
export async function probeShenavaModel(
  fetcher: Fetcher = globalThis.fetch as unknown as Fetcher,
  baseUrl = '/',
  files: readonly ShenavaModelFile[] = SHENAVA_MODEL_FILES,
  runtimeSupported: boolean = shenavaRuntimeSupported(),
  probeOptions: ShenavaProbeOptions = {},
): Promise<ShenavaModelAvailability> {
  const { available, missing, reason, source } = await probeShenavaModelFiles(
    fetcher,
    baseUrl,
    files,
    runtimeSupported,
    probeOptions,
  )
  return { available, missing, ...(reason ? { reason } : {}), ...(source ? { source } : {}) }
}
