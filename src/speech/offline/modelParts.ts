/**
 * Reassembly of a model file the build had to split.
 *
 * Hosts with a per-file size limit (Vercel Hobby: 100 MB for static uploads) reject the 125 MiB
 * encoder, and simply leaving it out would push every browser to a third-party host — which fails
 * on networks where that host is blocked. `npm run build` therefore cuts the file into chunks below
 * the limit and records them in `model-parts.json`; this module glues them back together in the
 * worker, so the model still arrives from the app's own origin.
 *
 * Kept separate from the worker so it can be unit tested: the whole buffer is allocated once and
 * each chunk is copied straight into it (peak extra memory = one chunk, not a second copy of the
 * model), every chunk size is checked, and an optional `verify` runs on the finished buffer.
 */

export interface ModelPartSpec {
  /** File name next to the model files, e.g. `encoder.int8.onnx.part0`. */
  readonly name: string
  readonly bytes: number
}

type PartResponse = {
  ok: boolean
  status: number
  arrayBuffer(): Promise<ArrayBuffer>
}

type PartFetcher = (input: string) => Promise<PartResponse>

export interface AssembleModelPartsOptions {
  fileName: string
  /** Exact size of the reassembled file (the published manifest size). */
  bytes: number
  parts: readonly ModelPartSpec[]
  /** Turns a chunk file name into the URL to fetch. */
  urlFor: (partName: string) => string
  fetcher?: PartFetcher
  /** Runs on the finished buffer — the worker passes its size + SHA-256 check here. */
  verify?: (bytes: Uint8Array<ArrayBuffer>) => Promise<void>
}

export async function assembleModelParts({
  fileName,
  bytes,
  parts,
  urlFor,
  fetcher = globalThis.fetch as unknown as PartFetcher,
  verify,
}: AssembleModelPartsOptions): Promise<Uint8Array<ArrayBuffer>> {
  if (parts.length === 0) throw new Error(`${fileName}: no chunks listed`)

  const total = parts.reduce((sum, part) => sum + part.bytes, 0)
  if (total !== bytes) {
    throw new Error(`${fileName}: chunks add up to ${total} bytes, ${bytes} expected`)
  }

  const assembled = new Uint8Array(bytes)
  let offset = 0
  for (const part of parts) {
    const response = await fetcher(urlFor(part.name))
    if (!response.ok) throw new Error(`${part.name}: HTTP ${response.status}`)
    const chunk = new Uint8Array(await response.arrayBuffer())
    if (chunk.byteLength !== part.bytes) {
      throw new Error(`${part.name}: ${chunk.byteLength} bytes received, ${part.bytes} expected`)
    }
    assembled.set(chunk, offset)
    offset += chunk.byteLength
  }

  if (verify) await verify(assembled)
  return assembled
}
