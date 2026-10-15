/**
 * `tokens.txt` handling for Shenava Koochik.
 *
 * The model repository's export script writes one `piece id` line per vocabulary entry and appends
 * the blank token `<blk>` as the last id:
 *   `for i, s in enumerate(asr.joint.vocabulary): f.write(f"{s} {i}\n")`
 * SentencePiece BPE pieces mark a word boundary with the `▁` (U+2581) meta symbol.
 */

export interface TokenTable {
  /** `id → piece`; ids without a line are `undefined`. */
  pieces: (string | undefined)[]
  /** Number of lines in `tokens.txt` (SentencePiece pieces + `<blk>`). */
  size: number
  blankId: number
  hasBlankToken: boolean
}

const SPECIAL_PIECE = /^<[^>]*>$/

export function parseTokens(content: string): TokenTable {
  const pieces: (string | undefined)[] = []
  let size = 0
  let blankId = -1

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    const separator = line.lastIndexOf(' ')
    if (separator <= 0) continue
    const piece = line.slice(0, separator)
    const id = Number(line.slice(separator + 1))
    if (!Number.isInteger(id) || id < 0) continue
    pieces[id] = piece
    blankId = Math.max(blankId, id)
    if (piece === '<blk>') blankId = id
    size = Math.max(size, id + 1)
  }

  return { pieces, size, blankId, hasBlankToken: pieces[blankId] === '<blk>' }
}

/**
 * Turns token ids into text exactly like sherpa-onnx's symbol-table conversion: pieces are joined
 * verbatim and `▁` becomes a space. Control pieces such as `<blk>`/`<unk>` are dropped.
 */
export function decodeTokens(tokenIds: readonly number[], table: TokenTable): string {
  let text = ''
  for (const id of tokenIds) {
    const piece = table.pieces[id]
    if (!piece || SPECIAL_PIECE.test(piece)) continue
    text += piece
  }
  return text.replace(/▁/g, ' ').replace(/\s+/g, ' ').trim()
}
