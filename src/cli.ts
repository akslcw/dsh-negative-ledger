/**
 * Zero-dependency CLI over a ledger directory.
 *
 * Usage: node cli/dsh-negative-ledger.ts [--dir <path>] [--backend sqlite|jsonl]
 *        <list | show <id> | stale | stats>
 *
 * Backend selection: the explicit flag wins; otherwise the directory is
 * auto-detected (`ledger.db` → sqlite, `ledger.jsonl` → jsonl); with neither
 * present the primary release backend (sqlite) is used.
 *
 * `runCli` is pure (no process exit, no console writes) and asynchronous so
 * tests run it in-process with `await`; `main` prints its lines and sets the
 * exit code.
 *
 * @module dsh-negative-ledger/cli
 */

import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { JsonlLedgerStore } from './store-jsonl.ts'
import { SqliteLedgerStore } from './store-sqlite.ts'
import type { LedgerStore } from './store.ts'

const USAGE = 'usage: dsh-negative-ledger [--dir <path>] [--backend sqlite|jsonl] <list | show <id> | stale | stats>'

export interface CliResult {
  /** Process exit code: 0 on success, 1 on usage or ledger errors. */
  code: number
  /** Complete output, one line per entry. */
  lines: string[]
}

function resolveBackend(dir: string, flag: string | undefined): { backend: 'jsonl' | 'sqlite' } | { error: string } {
  if (flag !== undefined && flag !== 'jsonl' && flag !== 'sqlite') {
    return { error: `unknown backend "${flag}" — expected sqlite or jsonl` }
  }
  if (flag !== undefined) return { backend: flag }
  if (existsSync(join(dir, 'ledger.db'))) return { backend: 'sqlite' }
  if (existsSync(join(dir, 'ledger.jsonl'))) return { backend: 'jsonl' }
  return { backend: 'sqlite' }
}

export async function runCli(argv: string[]): Promise<CliResult> {
  const result: CliResult = { code: 0, lines: [] }
  const emit = (line: string): void => { result.lines.push(line) }

  let dir: string | undefined
  let backendFlag: string | undefined
  let command: string | undefined
  let id: string | undefined
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? ''
    if (arg === '--dir' || arg === '--backend') {
      const value = argv[index + 1]
      if (value === undefined) {
        emit(`missing value for ${arg}`)
        emit(USAGE)
        return { code: 1, lines: result.lines }
      }
      if (arg === '--dir') dir = value
      else backendFlag = value
      index += 1
      continue
    }
    if (arg.startsWith('-')) {
      emit(`unknown option ${arg}`)
      emit(USAGE)
      return { code: 1, lines: result.lines }
    }
    if (command === undefined) command = arg
    else if (id === undefined) id = arg
    else {
      emit(USAGE)
      return { code: 1, lines: result.lines }
    }
  }
  if (command === undefined) {
    emit(USAGE)
    return { code: 1, lines: result.lines }
  }

  const effectiveDir = dir ?? join(process.cwd(), '.ledger')
  const resolvedBackend = resolveBackend(effectiveDir, backendFlag)
  if ('error' in resolvedBackend) {
    emit(resolvedBackend.error)
    return { code: 1, lines: result.lines }
  }
  let store: LedgerStore
  try {
    store = resolvedBackend.backend === 'sqlite'
      ? new SqliteLedgerStore({ dir: effectiveDir })
      : new JsonlLedgerStore({ dir: effectiveDir })
  } catch (error) {
    emit(`cannot open ledger: ${String(error)}`)
    return { code: 1, lines: result.lines }
  }

  try {
    switch (command) {
      case 'list': {
        const facts = (await store.queryFacts()).map(entry => entry.fact)
        if (facts.length === 0) emit('(empty ledger)')
        for (const fact of facts) {
          emit(`${fact.status}\t${fact.kind}\t${fact.id}\t${fact.claim}`)
        }
        return result
      }
      case 'show': {
        if (id === undefined) {
          emit('show requires a fact id')
          emit(USAGE)
          return { code: 1, lines: result.lines }
        }
        const entry = (await store.queryFacts()).find(candidate => candidate.fact.id === id)
        if (entry === undefined) {
          emit(`no fact with id ${id}`)
          return { code: 1, lines: result.lines }
        }
        for (const line of JSON.stringify(entry.fact, null, 2).split('\n')) emit(line)
        return result
      }
      case 'stale': {
        const facts = (await store.queryFacts()).filter(entry => entry.fact.status === 'stale')
        if (facts.length === 0) emit('(no stale facts)')
        for (const entry of facts) {
          emit(`${entry.fact.id}\t${entry.fact.kind}\t${entry.fact.claim}`)
        }
        return result
      }
      case 'stats': {
        const entries = await store.queryFacts()
        const active = entries.filter(entry => entry.fact.status === 'active').length
        const stale = entries.filter(entry => entry.fact.status === 'stale').length
        const resolved = entries.filter(entry => entry.fact.status === 'resolved').length
        const superseded = entries.filter(entry => entry.fact.status === 'superseded').length
        const summary = await store.summarize()
        emit(`facts: ${entries.length} (active ${active}, stale ${stale}, resolved ${resolved}, superseded ${superseded})`)
        emit(`duplicate failures observed: ${summary.duplicateFailuresObserved}`)
        emit(`warnings emitted: ${summary.warningsEmitted}`)
        emit(`calls denied: ${summary.callsDenied}`)
        for (const entry of entries) {
          if (entry.fact.savings.warningsEmitted + entry.fact.savings.callsDenied === 0) continue
          emit(`hit: ${entry.fact.kind} — warnings ${entry.fact.savings.warningsEmitted}, denied ${entry.fact.savings.callsDenied} — ${entry.fact.claim}`)
        }
        return result
      }
      default:
        emit(`unknown command "${command}"`)
        emit(USAGE)
        return { code: 1, lines: result.lines }
    }
  } finally {
    await store.close().catch(() => {})
  }
}

/** Print a {@link runCli} result and set the exit code. */
export async function main(argv: string[]): Promise<void> {
  const result = await runCli(argv)
  for (const line of result.lines) console.log(line)
  if (result.code !== 0) process.exitCode = result.code
}

const invoked = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (invoked) void main(process.argv.slice(2))
