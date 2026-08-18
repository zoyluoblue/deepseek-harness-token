/**
 * Frame scanner for the session-log container.
 *
 * PORTED — verbatim in behaviour from deepseek-harness
 * `packages/session/session-persistence-jsonl/src/zstd.ts:48-104` (MIT).
 * This is the only upstream logic this package reimplements, and it is not
 * optional: `session.jsonl.zstd` is a container of CONCATENATED, independently
 * decodable frames (one per durable append batch), and Node's own zstd APIs
 * stop at the first one — measured on Node 22.22.3, a 232,794-byte / 482-frame
 * artifact yields 209 bytes from both `zstdDecompressSync` and
 * `createZstdDecompress()`.
 *
 * Independent decodability is also what makes the incremental cursor sound:
 * a tail slice starting at a previously recorded frame boundary decodes to
 * exactly the frames appended since.
 *
 * The container carries no version of its own — the JSONL header line does.
 * Callers MUST gate on `header.version === SESSION_FORMAT_VERSION`.
 *
 * @module @zoytown/dsh-token/zstd-frames
 */

/** Byte range of one complete frame, `end` exclusive. */
export interface ZstdFrameRange {
  start: number
  end: number
}

/** Result of scanning a buffer for frame boundaries. */
export interface ZstdFrameScan {
  /** Complete frames, in order. */
  frames: ZstdFrameRange[]
  /**
   * Offset where an incomplete trailing frame begins, when the buffer ended
   * mid-frame (a live writer between batches). Callers drop it and must never
   * advance a stored cursor into it.
   */
  tornStart?: number
}

const ZSTD_MAGIC = 0xFD2FB528

/**
 * Locate every complete Zstandard frame in `buffer`.
 * @param buffer - the artifact bytes, or a tail slice of them.
 * @param maxFrames - stop after this many frames (header-only probes pass 1).
 * @returns the complete frames plus the torn-tail offset when one exists.
 * @throws when a frame header is structurally invalid — that is corruption,
 * not a torn tail, and must not be silently treated as end-of-data.
 */
export function scanZstdFrames(
  buffer: Buffer,
  maxFrames = Number.POSITIVE_INFINITY,
): ZstdFrameScan {
  const frames: ZstdFrameRange[] = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`corrupt Zstandard session log: invalid frame magic at byte ${offset}`)
    }
    offset += 4
    if (offset === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 0x18) !== 0) {
      throw new Error(`corrupt Zstandard session log: reserved frame-header bit at byte ${offset - 1}`)
    }
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 0x03
      const blockSize = blockHeader >>> 3
      if (blockType === 0x03) {
        throw new Error(`corrupt Zstandard session log: reserved block type at byte ${offset - 3}`)
      }
      const payloadBytes = blockType === 0x01 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
    if (frames.length === maxFrames) return { frames }
  }
  return { frames }
}
