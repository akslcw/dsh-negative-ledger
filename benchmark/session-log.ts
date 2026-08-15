// Session-log decoding and event extraction for the benchmark runner.
// Mirrors scanZstdFrames in dsh-session-persistence-jsonl (the JSONL backend's
// on-disk format: concatenated zstd frames, one JSON event per decompressed line).
import { readFileSync, readdirSync } from 'node:fs'
import { basename, join, relative } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import type { AllowEntry } from './resolve.ts'

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

const SHELL_EXIT_RE = /\[exit code:\s*(\d+)\]/i

/** Exit code rendered by DSH shell tools in result text, or null. */
export function shellExitCode(text: string): number | null {
  const match = SHELL_EXIT_RE.exec(text)
  return match === null ? null : Number(match[1])
}

/** Tool names whose results carry shell exit-code lines. */
const SHELL_TOOLS = new Set(['pwsh', 'bash'])

/** Whether a tool's result text follows the DSH shell exit-code convention. */
export function isShellTool(name: string): boolean {
  return SHELL_TOOLS.has(name)
}

/** A call outcome, the common shape extractToolCalls and the summarizer share. */
export interface CallOutcome {
  name: string
  args: Record<string, unknown> | null
  ok: boolean | null
  isError: boolean
  errorText: string
}

/** Whether a failed call was denied by the negative-ledger policy. */
export function isBlocked(call: Pick<CallOutcome, 'isError' | 'errorText'>): boolean {
  return call.isError && call.errorText.includes('blocked by negative-ledger')
}

/** Whether a call matches a scenario's declared allow/never-deny entry. */
export function matchesAllow(call: Pick<CallOutcome, 'name' | 'args'>, entry: AllowEntry): boolean {
  if (call.name !== entry.tool) return false
  const args = call.args ?? {}
  if (entry.path !== undefined) {
    const filePath = String(args.file_path ?? args.path ?? '').replaceAll('\\', '/')
    return filePath === entry.path || filePath.endsWith(`/${entry.path}`)
  }
  const command = String(args.command ?? args.cmd ?? '').trim()
  return command.startsWith(entry.commandLinePrefix ?? '')
}

/**
 * Count how many declared allow entries are satisfied: the call failed at
 * least once (a non-blocked failure), and a later call with the same
 * declaration succeeded.
 */
export function satisfiedRequiredAllow(requiredAllow: AllowEntry[], calls: CallOutcome[]): number {
  let satisfied = 0
  for (const entry of requiredAllow) {
    const failedOnce = calls.some(call => call.isError && matchesAllow(call, entry))
    let failed = false
    let laterSuccess = false
    for (const call of calls) {
      if (!matchesAllow(call, entry)) continue
      if (call.isError && !isBlocked(call)) failed = true
      else if (failed && call.ok === true) {
        laterSuccess = true
        break
      }
    }
    if (failedOnce && laterSuccess) satisfied += 1
  }
  return satisfied
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
      let fullText = ''
      if (isRecord(message) && Array.isArray(message.content)) {
        for (const block of message.content) {
          if (!isRecord(block) || !Array.isArray(block.content)) continue
          if (block.isError === true) {
            isError = true
            for (const part of block.content) {
              if (isRecord(part) && typeof part.text === 'string') {
                fullText += `${part.text}\n`
                if (errorText === '') errorText = part.text
              }
            }
          } else {
            for (const part of block.content) {
              if (isRecord(part) && typeof part.text === 'string') fullText += `${part.text}\n`
            }
          }
        }
      }
      // DSH shell tools report non-zero exits as successful results whose
      // text carries `[exit code: N]`; N !== 0 is a failed command. The
      // parse is gated on the tool name: file contents that merely contain
      // such a line (e.g. a read) must never be treated as failures.
      const toolName = calls.get(callId)?.name ?? ''
      if (!isError && isShellTool(toolName)) {
        const exitCode = shellExitCode(fullText)
        if (exitCode !== null && exitCode !== 0) {
          isError = true
          errorText = `[exit code: ${exitCode}]`
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

/**
 * Visible text of the final assistant message. Only `text` blocks count:
 * `reasoning`/`thinking` blocks are model-internal and must never satisfy a
 * success marker. Walks backwards to the last assistant message carrying text.
 */
export function finalAssistantVisibleText(events: unknown[]): string {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = asEvent(events[i])
    if (event === null || event.data === undefined || event.type !== 'assistant/message') continue
    const message = event.data.message
    if (!isRecord(message) || !Array.isArray(message.content)) continue
    const visible: string[] = []
    for (const block of message.content) {
      if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') visible.push(block.text)
    }
    if (visible.length > 0) return visible.join('\n')
  }
  return ''
}

/** Text output of one tool/result event, joined from its content blocks. */
export interface ToolResultText {
  tool: string
  /** callKey of the matching tool/call ('' when the call event is missing). */
  key: string
  text: string
  isError: boolean
}

/**
 * Tool-output evidence: for every tool/result event, the tool name and call
 * key (joined from the matching tool/call) and the text the tool actually
 * produced. Marker checks for evidence must use these texts — never
 * assistant text.
 */
export function extractToolResultTexts(events: unknown[]): ToolResultText[] {
  const calls = new Map<string, { name: string; args: Record<string, unknown> | null }>()
  const results: ToolResultText[] = []
  for (const raw of events) {
    const event = asEvent(raw)
    if (event === null || event.data === undefined) continue
    if (event.type === 'tool/call') {
      const callId = String(event.data.callId ?? '')
      if (callId === '') continue
      const argumentsJson = typeof event.data.arguments === 'string' ? event.data.arguments : null
      let args: Record<string, unknown> | null = null
      if (argumentsJson !== null) {
        try {
          args = JSON.parse(argumentsJson) as Record<string, unknown>
        } catch {
          args = null
        }
      }
      calls.set(callId, { name: String(event.data.name ?? ''), args })
      continue
    }
    if (event.type !== 'tool/result') continue
    const data = event.data
    const message = data.message
    if (!isRecord(message) || !Array.isArray(message.content)) continue
    const source = isRecord(message.source) ? message.source : null
    const callId = source !== null && typeof source.callId === 'string' ? source.callId : ''
    // Structured line output (data.meta.lines[].text) is the authoritative
    // evidence for line-oriented tools like read: display text renders as
    // "1: content" and must never be parsed for markers. Tools without meta
    // (pwsh/bash) fall back to their display text.
    const meta = isRecord(data.meta) ? data.meta : null
    let structured: string | null = null
    if (meta !== null && Array.isArray(meta.lines)) {
      structured = meta.lines
        .map(line => (isRecord(line) && typeof line.text === 'string' ? line.text : ''))
        .join('\n')
    }
    let text = ''
    let isError = false
    for (const block of message.content) {
      if (!isRecord(block) || block.type !== 'tool-result') continue
      if (block.isError === true) isError = true
      if (Array.isArray(block.content)) {
        for (const part of block.content) {
          if (isRecord(part) && typeof part.text === 'string') text += `${part.text}\n`
        }
      }
    }
    if (structured !== null) text = structured
    // Shell tools report non-zero exits as successful results whose text
    // carries `[exit code: N]`; N !== 0 is a failed command for evidence.
    // Gated on the tool name: non-shell outputs (e.g. read file contents)
    // containing such a line are never failures.
    const call = calls.get(callId)
    const toolName = call?.name ?? ''
    if (!isError && isShellTool(toolName)) {
      const exitCode = shellExitCode(text)
      if (exitCode !== null && exitCode !== 0) isError = true
    }
    results.push({
      tool: call?.name ?? '',
      key: call === undefined ? '' : callKey(call),
      text,
      isError,
    })
  }
  return results
}

/**
 * Evidence verdict. The marker must match a standalone output line (trimmed
 * equality — command echoes that merely contain the marker inside a longer
 * line do not count), the producing result must be non-error, and with
 * `repeat: true` the producing call must be a repeat: an earlier tool result
 * with the same call key must exist in the session.
 */
export function evidenceSatisfied(
  results: ToolResultText[],
  spec: { marker: string; tool?: string; repeat?: boolean },
): boolean {
  const seen = new Set<string>()
  for (const result of results) {
    const known = result.key !== '' && result.tool !== ''
    const lineMatch = result.text.split('\n').some(line => line.trim() === spec.marker)
    const matchesTool = spec.tool === undefined || result.tool === spec.tool
    if (!lineMatch || !matchesTool || result.isError) {
      if (known) seen.add(result.key)
      continue
    }
    if (spec.repeat === true && !seen.has(result.key)) {
      if (known) seen.add(result.key)
      continue
    }
    return true
  }
  return false
}

/** Relative path (forward slashes) used in collected artifacts. */
export function relativeTo(root: string, file: string): string {
  return relative(root, file).replaceAll('\\', '/')
}
