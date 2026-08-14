// Session-log decoding and event extraction for the benchmark runner.
// Mirrors scanZstdFrames in dsh-session-persistence-jsonl (the JSONL backend's
// on-disk format: concatenated zstd frames, one JSON event per decompressed line).
import { readFileSync, readdirSync } from 'node:fs'
import { basename, join, relative } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const ZSTD_MAGIC = 0xfd2fb528

/** Byte range of one zstd frame inside a concatenated-frame log file. */
export interface Frame {
  start: number
  end: number
}

/**
 * Locate every zstd frame in a buffer.
 * @param buf - raw file contents
 * @returns frames plus the offset of a torn tail frame, if any
 */
export function scanZstdFrames(buf: Buffer): { frames: Frame[]; tornStart?: number } {
  const frames: Frame[] = []
  let offset = 0
  while (offset < buf.length) {
    const start = offset
    if (buf.length - offset < 4) return { frames, tornStart: start }
    if (buf.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`bad frame magic at byte ${offset}`)
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

/** Read a session log file and return its events as parsed JSON values. */
export function decodeSessionLogFile(file: string): unknown[] {
  const buffer = readFileSync(file)
  if (basename(file).endsWith('.zstd')) {
    const { frames, tornStart } = scanZstdFrames(buffer)
    if (tornStart !== undefined) {
      throw new Error(`torn zstd tail at byte ${tornStart} in ${file}`)
    }
    let text = ''
    for (const frame of frames) {
      text += `${zstdDecompressSync(buffer.subarray(frame.start, frame.end)).toString('utf8')}\n`
    }
    return text.split('\n').filter(line => line.length > 0).map(line => JSON.parse(line) as unknown)
  }
  return buffer.toString('utf8').split('\n').filter(line => line.length > 0).map(line => JSON.parse(line) as unknown)
}

/** Find session log files (*.jsonl.zstd or *.jsonl) under a directory tree. */
export function findSessionLogs(root: string): string[] {
  const found: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.jsonl.zstd') || entry.name.endsWith('.jsonl')) found.push(full)
    }
  }
  try {
    walk(root)
  } catch {
    // Missing DSH_HOME tree: no logs.
  }
  return found.sort()
}

/** A session event as stored by dsh-session. */
export interface SessionEvent {
  type: string
  time?: number | undefined
  data?: Record<string, unknown> | undefined
}

function asEvent(value: unknown): SessionEvent | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  if (typeof record.type !== 'string') return null
  return { type: record.type, time: typeof record.time === 'number' ? record.time : undefined, data: isRecord(record.data) ? record.data : undefined }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** One executed tool call, joined from a tool/call event. */
export interface ToolCallRecord {
  callId: string
  name: string
  args: Record<string, unknown> | null
  argumentsJson: string | null
  time?: number | undefined
  ok: boolean | null
  isError: boolean
  errorText: string
}

/** A fingerprint key derived from a tool call, comparable across runs. */
export function callKey(call: Pick<ToolCallRecord, 'name' | 'args'>): string {
  const args = call.args ?? {}
  if (call.name === 'read') return `read|${String(args.file_path ?? args.path ?? '')}`
  if (call.name === 'bash') return `bash|${String(args.command ?? args.cmd ?? '').trim()}`
  const pick = args.file_path ?? args.path ?? args.command ?? args.cmd ?? args.query ?? args.pattern
  if (pick !== undefined) return `${call.name}|${String(pick).trim()}`
  return `${call.name}|${JSON.stringify(args)}`
}

/** Extract tool/call + tool/result pairs from decoded session events. */
export function extractToolCalls(events: unknown[]): ToolCallRecord[] {
  const calls = new Map<string, ToolCallRecord>()
  const results: { callId: string; ok: boolean; isError: boolean; errorText: string }[] = []
  for (const raw of events) {
    const event = asEvent(raw)
    if (event === null) continue
    if (event.type === 'tool/call' && event.data) {
      const callId = String(event.data.callId ?? '')
      const name = String(event.data.name ?? '')
      const argumentsJson = typeof event.data.arguments === 'string' ? event.data.arguments : null
      let args: Record<string, unknown> | null = null
      if (argumentsJson !== null) {
        try {
          args = JSON.parse(argumentsJson) as Record<string, unknown>
        } catch {
          args = null
        }
      }
      if (callId !== '' && !calls.has(callId)) {
        calls.set(callId, { callId, name, args, argumentsJson, time: event.time, ok: null, isError: false, errorText: '' })
      }
    } else if (event.type === 'tool/result' && event.data) {
      const message = event.data.message
      const source = isRecord(message) && isRecord(message.source) ? message.source : null
      const callId = String(
        event.data.callId ?? (source !== null && typeof source.callId === 'string' ? source.callId : ''),
      )
      const error = event.data.error
      let isError = error !== undefined && error !== null
      let errorText = ''
      if (isRecord(error)) {
        for (const key of ['code', 'message', 'name']) {
          const value = error[key]
          if (typeof value === 'string') {
            errorText = value
            break
          }
        }
      }
      if (isRecord(message) && Array.isArray(message.content)) {
        for (const block of message.content) {
          if (isRecord(block) && block.isError === true) {
            isError = true
            const parts = block.content
            if (Array.isArray(parts)) {
              for (const part of parts) {
                if (isRecord(part) && typeof part.text === 'string') {
                  if (errorText === '') errorText = part.text
                  break
                }
              }
            }
          }
        }
      }
      results.push({ callId, ok: !isError, isError, errorText })
    }
  }
  for (const result of results) {
    const call = calls.get(result.callId)
    if (call !== undefined && call.ok === null) {
      call.ok = result.ok
      call.isError = result.isError
      call.errorText = result.errorText
    }
  }
  return [...calls.values()].sort((a, b) => (a.time ?? 0) - (b.time ?? 0))
}

/** Sum usage records from assistant/message events. */
export function extractUsage(events: unknown[]): { inputTokens: number; outputTokens: number; model: string | null } {
  let inputTokens = 0
  let outputTokens = 0
  let model: string | null = null
  const add = (usage: unknown): void => {
    if (!isRecord(usage)) return
    const pick = (names: string[]): number => {
      for (const name of names) {
        const value = usage[name]
        if (typeof value === 'number' && Number.isFinite(value)) return value
      }
      return 0
    }
    inputTokens += pick(['inputTokens', 'promptTokens', 'input_tokens'])
    outputTokens += pick(['outputTokens', 'completionTokens', 'output_tokens'])
  }
  for (const raw of events) {
    const event = asEvent(raw)
    if (event === null || event.data === undefined) continue
    if (event.type === 'assistant/message' && isRecord(event.data.usage)) add(event.data.usage)
    if (model === null && typeof event.data.model === 'string') model = event.data.model
  }
  return { inputTokens, outputTokens, model }
}

/** Flatten all text content of events into one string (for success-marker search). */
export function eventText(events: unknown[]): string {
  let text = ''
  for (const raw of events) {
    const event = asEvent(raw)
    if (event === null || event.data === undefined) continue
    if (event.type === 'assistant/message' || event.type === 'context/message' || event.type === 'user/message') {
      const message = event.data.message
      if (isRecord(message) && Array.isArray(message.content)) {
        for (const block of message.content) {
          if (isRecord(block) && typeof block.text === 'string') text += `${block.text}\n`
        }
      }
    }
    if (event.type === 'tool/result' && isRecord(event.data.error) && typeof event.data.error.message === 'string') {
      text += `${event.data.error.message}\n`
    }
  }
  return text
}

/** Relative path (forward slashes) used in collected artifacts. */
export function relativeTo(root: string, file: string): string {
  return relative(root, file).replaceAll('\\', '/')
}
