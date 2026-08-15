// Decodes a concatenated-frame zstd session log (the JSONL backend's on-disk
// format) and prints the events relevant to the ledger observation.
// Usage: node smoke/decode-log.mjs <session.jsonl.zstd>
// Checkout-bound utility; mirrors scanZstdFrames in dsh-session-persistence-jsonl.
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const path = process.argv[2]
if (path === undefined) {
  console.error('usage: node smoke/decode-log.mjs <session.jsonl.zstd>')
  process.exit(1)
}
const buffer = readFileSync(path)
const MAGIC = 0xfd2fb528

function scanFrames(buf) {
  const frames = []
  let offset = 0
  while (offset < buf.length) {
    const start = offset
    if (buf.length - offset < 4) return { frames, tornStart: start }
    if (buf.readUInt32LE(offset) !== MAGIC) throw new Error(`bad frame magic at byte ${offset}`)
    offset += 4
    if (offset === buf.length) return { frames, tornStart: start }
    const descriptor = buf.readUInt8(offset)
    offset += 1
    if ((descriptor & 0x18) !== 0) throw new Error(`reserved frame-header bit at byte ${offset - 1}`)
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buf.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes
    for (;;) {
      if (buf.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buf.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 0x03
      const blockSize = blockHeader >>> 3
      if (blockType === 0x03) throw new Error(`reserved block type at byte ${offset - 3}`)
      const payloadBytes = blockType === 0x01 ? 1 : blockSize
      if (buf.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buf.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return { frames }
}

const { frames, tornStart } = scanFrames(buffer)
console.log(`frames: ${frames.length}${tornStart === undefined ? '' : `, torn tail at byte ${tornStart}`}`)
let text = ''
for (const frame of frames) {
  text += `${zstdDecompressSync(buffer.subarray(frame.start, frame.end)).toString('utf8')}\n`
}
const events = text.split('\n').filter(Boolean).map(line => JSON.parse(line))
console.log(`events: ${events.length}`)
for (const event of events) {
  if (event.type === 'tool/call' || event.type === 'tool/result' || event.type === 'context/message') {
    console.log(`=== ${event.type} ===`)
    console.log(JSON.stringify(event).slice(0, 600))
  }
}
