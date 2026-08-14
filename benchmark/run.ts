// Benchmark run collector: boots the real DSH CLI once per (scenario, profile,
// iteration), captures the session logs and the ledger database, and appends
// one JSON line per run to runs/<scenario>/<profile>/<iteration>/result.jsonl.
//
// Usage:
//   DEEPSEEK_API_KEY=... DSH_CHECKOUT=/path/to/deepseek-harness \
//     node benchmark/run.ts <scenario-id> <baseline|warn|block> <iteration>
//
// Requirements (user machine):
//   - the harness checkout is built (`apps/cli/lib/bin.js` exists)
//   - DEEPSEEK_API_KEY is exported (or present in a root .env the CLI reads)
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import Database from 'better-sqlite3'
import {
  decodeSessionLogFile,
  evidenceSatisfied,
  extractToolCalls,
  extractToolResultTexts,
  extractUsage,
  finalAssistantVisibleText,
  findSessionLogs,
  relativeTo,
} from './session-log.ts'
import { resolveScenario } from './resolve.ts'
import type { ScenarioSource } from './resolve.ts'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const runsRoot = join(projectRoot, 'benchmark', 'runs')

interface LedgerSnapshot {
  totals: { duplicateFailuresObserved: number; warningsEmitted: number; callsDenied: number }
  factCount: number
  denies: { kind: string; fingerprint: string; count: number }[]
  warns: { kind: string; fingerprint: string; count: number }[]
  error?: string
}

interface RunResult {
  scenario: string
  profile: string
  iteration: string
  startedAt: string
  endedAt: string
  durationMs: number
  exitCode: number | null
  timedOut: boolean
  success: boolean
  successSource: 'full' | 'report-only' | 'evidence-only' | 'none'
  successReport: boolean
  successEvidence: boolean
  stdioMode: 'capture' | 'inherit'
  stdoutTail: string
  stderrTail: string
  harnessCommit: string
  model: string | null
  tokenIn: number
  tokenOut: number
  toolCalls: {
    callId: string
    name: string
    args: Record<string, unknown> | null
    ok: boolean | null
    isError: boolean
    errorText: string
  }[]
  policy: { warnInjections: number; releaseInjections: number; blockedByLedgerCalls: number; samples: string[] }
  ledger: LedgerSnapshot
  sessionFiles: string[]
  timeoutMs: number
  tokenBudget: number
  title: string
}

function fail(message: string): never {
  console.error(`run.ts: ${message}`)
  process.exit(1)
}

function loadJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, 'utf8')) as T
}

function copyTree(from: string, to: string): void {
  mkdirSync(to, { recursive: true })
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const source = join(from, entry.name)
    const target = join(to, entry.name)
    if (entry.isDirectory()) copyTree(source, target)
    else cpSync(source, target)
  }
}

function snapshotLedger(dbFile: string): LedgerSnapshot {
  const snapshot: LedgerSnapshot = {
    totals: { duplicateFailuresObserved: 0, warningsEmitted: 0, callsDenied: 0 },
    factCount: 0,
    denies: [],
    warns: [],
  }
  if (!existsSync(dbFile)) {
    snapshot.error = 'ledger.db not created in this run'
    return snapshot
  }
  try {
    const db = new Database(dbFile, { readonly: true, fileMustExist: true })
    try {
      const totals = db.prepare(
        'SELECT COALESCE(SUM(duplicate_failures_observed),0) AS dup, COALESCE(SUM(warnings_emitted),0) AS warned, COALESCE(SUM(calls_denied),0) AS denied FROM counters',
      ).get() as { dup: number; warned: number; denied: number }
      snapshot.totals = {
        duplicateFailuresObserved: totals.dup,
        warningsEmitted: totals.warned,
        callsDenied: totals.denied,
      }
      snapshot.factCount = (db.prepare('SELECT COUNT(*) AS n FROM facts').get() as { n: number }).n
      snapshot.denies = db.prepare(
        'SELECT f.kind AS kind, f.fingerprint AS fingerprint, c.calls_denied AS count FROM counters c JOIN facts f ON f.id = c.fact_id WHERE c.calls_denied > 0 ORDER BY f.kind, f.fingerprint',
      ).all() as { kind: string; fingerprint: string; count: number }[]
      snapshot.warns = db.prepare(
        'SELECT f.kind AS kind, f.fingerprint AS fingerprint, c.warnings_emitted AS count FROM counters c JOIN facts f ON f.id = c.fact_id WHERE c.warnings_emitted > 0 ORDER BY f.kind, f.fingerprint',
      ).all() as { kind: string; fingerprint: string; count: number }[]
    } finally {
      db.close()
    }
  } catch (error) {
    snapshot.error = error instanceof Error ? error.message : String(error)
  }
  return snapshot
}

function cap(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n… (truncated ${text.length - max} chars)` : text
}

async function main(): Promise<void> {
  const [scenarioId, profile, iteration] = process.argv.slice(2)
  if (scenarioId === undefined || profile === undefined || iteration === undefined) {
    fail('usage: node benchmark/run.ts <scenario-id> <baseline|warn|block> <iteration>')
  }
  if (profile !== 'baseline' && profile !== 'warn' && profile !== 'block') {
    fail(`unknown profile "${profile}"`)
  }
  const checkout = process.env.DSH_CHECKOUT ?? ''
  if (checkout === '') fail('set DSH_CHECKOUT to the built deepseek-harness checkout')
  if ((process.env.DEEPSEEK_API_KEY ?? '') === '') {
    console.warn('run.ts: DEEPSEEK_API_KEY is not set; the run will fail unless the CLI finds a key elsewhere')
  }
  const scenario = resolveScenario(loadJson<ScenarioSource>(join(projectRoot, 'benchmark', 'scenarios', `${scenarioId}.json`)), process.platform)

  const runDir = join(runsRoot, scenarioId, profile, iteration)
  rmSync(runDir, { recursive: true, force: true })
  mkdirSync(runDir, { recursive: true })
  const workspace = join(runDir, 'workspace')
  mkdirSync(workspace, { recursive: true })
  const dshHome = join(runDir, 'dsh-home')
  const ledgerDir = join(runDir, 'ledger-db')
  // The resolved scenario (platform shell tool, platform command, resolved
  // prompt) is the single source of truth for this run and for the summarizer.
  writeFileSync(join(runDir, 'scenario-resolved.json'), `${JSON.stringify(scenario, null, 2)}\n`)

  const seedDir = join(projectRoot, 'benchmark', 'scenarios', scenarioId, 'seed')
  if (existsSync(seedDir)) copyTree(seedDir, workspace)

  const template = readFileSync(join(projectRoot, 'benchmark', 'profiles', `${profile}.patch.yml`), 'utf8')
  const pluginUrl = pathToFileURL(join(projectRoot, 'src', 'plugin.ts')).href
  const patchPath = join(runDir, 'patch.yml')
  writeFileSync(
    patchPath,
    template.replaceAll('__LEDGER_DIR__', ledgerDir.replaceAll('\\', '/')).replaceAll('__PLUGIN_PATH__', pluginUrl),
  )

  const binPath = process.env.DSH_BIN ?? join(checkout, 'apps', 'cli', 'lib', 'bin.js')
  if (!existsSync(binPath)) fail(`harness CLI not found at ${binPath} (build the checkout or set DSH_BIN)`)

  const startedAt = new Date()
  const startedAtIso = startedAt.toISOString()
  console.log(`[run] ${scenarioId}/${profile}/${iteration} starting (workspace ${workspace})`)
  // Sandboxed runners cannot capture the child's piped stdio (EPERM); with
  // NEGLEDGER_STDIO=inherit the CLI takes the terminal directly and success
  // is judged from decoded session events instead of captured stdout.
  const inheritMode = process.env.NEGLEDGER_STDIO === 'inherit'
  const child = spawn(process.execPath, [binPath, '--profile', 'headless', '--patch', patchPath, scenario.prompt], {
    cwd: workspace,
    env: { ...process.env, DSH_HOME: dshHome },
    stdio: inheritMode ? 'inherit' : ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  if (!inheritMode) {
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < 2_000_000) stdout += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 2_000_000) stderr += chunk.toString('utf8')
    })
  }
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill('SIGKILL')
  }, scenario.timeoutMs)
  const exit = await new Promise<{ code: number | null; signal: string | null }>((resolveExit) => {
    child.on('close', (code, signal) => resolveExit({ code, signal }))
    child.on('error', (error) => {
      stderr += `spawn error: ${error.message}\n`
      resolveExit({ code: null, signal: null })
    })
  })
  clearTimeout(timer)
  const endedAtIso = new Date().toISOString()

  // The ledger dir is generated inside the run dir, so no copy is needed.

  const sessionFiles = findSessionLogs(dshHome)
  const copies: string[] = []
  const allEvents: unknown[] = []
  for (const file of sessionFiles) {
    const copyPath = join(runDir, 'session-logs', relativeTo(dshHome, file))
    mkdirSync(dirname(copyPath), { recursive: true })
    cpSync(file, copyPath)
    copies.push(relativeTo(runDir, copyPath))
    try {
      const events = decodeSessionLogFile(file)
      allEvents.push(...events)
      const decodedPath = join(runDir, 'session-decoded', `${relativeTo(dshHome, file).replaceAll(/[\\/.:]/g, '_')}.jsonl`)
      mkdirSync(dirname(decodedPath), { recursive: true })
      writeFileSync(decodedPath, `${events.map(event => JSON.stringify(event)).join('\n')}\n`)
    } catch (error) {
      stderr += `session decode failed for ${file}: ${error instanceof Error ? error.message : String(error)}\n`
    }
  }

  const toolCalls = extractToolCalls(allEvents)
  const usage = extractUsage(allEvents)
  // Success = report marker in the final assistant's visible text (reasoning
  // excluded) AND, when the scenario declares evidence, the marker appearing
  // in an actual non-error tool output of the declared tool.
  const finalText = finalAssistantVisibleText(allEvents)
  const reportOk = finalText.includes(scenario.success.report)
  const evidence = scenario.success.evidence
  const evidenceOk = evidence === undefined ? true : evidenceSatisfied(extractToolResultTexts(allEvents), evidence)
  const success = reportOk && evidenceOk
  const successSource: RunResult['successSource'] = success ? 'full' : reportOk ? 'report-only' : evidenceOk ? 'evidence-only' : 'none'

  let warnInjections = 0
  let releaseInjections = 0
  let blockedByLedgerCalls = 0
  const samples: string[] = []
  for (const event of allEvents) {
    if (typeof event !== 'object' || event === null) continue
    const record = event as { type?: unknown; data?: unknown }
    if (record.type === 'agent/inbox/spliced' && typeof record.data === 'object' && record.data !== null) {
      const data = record.data as { inserted?: unknown }
      const inserted = Array.isArray(data.inserted) ? data.inserted : []
      for (const item of inserted) {
        if (typeof item !== 'object' || item === null) continue
        const source = (item as { source?: unknown }).source
        if (typeof source !== 'object' || source === null || (source as { plugin?: unknown }).plugin !== 'negative-ledger') continue
        const content = (item as { content?: unknown }).content
        const text = Array.isArray(content)
          ? content
              .map(block => (typeof block === 'object' && block !== null ? (block as { text?: unknown }).text : undefined))
              .filter((part): part is string => typeof part === 'string')
              .join(' ')
          : ''
        if (text.includes('previously failed and its evidence is unchanged')) warnInjections += 1
        else if (text.includes('no longer applies')) releaseInjections += 1
        if (samples.length < 3) samples.push(cap(text.slice(0, 300) || JSON.stringify(item).slice(0, 300), 300))
      }
    }
  }
  blockedByLedgerCalls = toolCalls.filter(call => call.isError && call.errorText.includes('blocked by negative-ledger')).length

  let harnessCommit = 'unknown'
  try {
    harnessCommit = execFileSync('git', ['-C', checkout, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch {
    harnessCommit = 'unavailable'
  }

  const result: RunResult = {
    scenario: scenarioId,
    profile,
    iteration,
    startedAt: startedAtIso,
    endedAt: endedAtIso,
    durationMs: Date.parse(endedAtIso) - Date.parse(startedAtIso),
    exitCode: exit.code,
    timedOut,
    success,
    successSource,
    successReport: reportOk,
    successEvidence: evidenceOk,
    stdioMode: inheritMode ? 'inherit' : 'capture',
    stdoutTail: cap(stdout.slice(-4000), 4000),
    stderrTail: cap(stderr.slice(-4000), 4000),
    harnessCommit,
    model: usage.model,
    tokenIn: usage.inputTokens,
    tokenOut: usage.outputTokens,
    toolCalls: toolCalls.map(call => ({
      callId: call.callId,
      name: call.name,
      args: call.args,
      ok: call.ok,
      isError: call.isError,
      errorText: cap(call.errorText, 600),
    })),
    policy: { warnInjections, releaseInjections, blockedByLedgerCalls, samples },
    ledger: snapshotLedger(join(ledgerDir, 'ledger.db')),
    sessionFiles: copies,
    timeoutMs: scenario.timeoutMs,
    tokenBudget: scenario.tokenBudget,
    title: scenario.title,
  }
  writeFileSync(join(runDir, 'result.jsonl'), `${JSON.stringify(result)}\n`)
  appendFileSync(
    join(runsRoot, 'manifest.jsonl'),
    `${JSON.stringify({ ts: startedAtIso, scenario: scenarioId, profile, iteration, runDir: relative(runsRoot, runDir).replaceAll('\\', '/'), durationMs: result.durationMs, exitCode: exit.code, timedOut, success, warnInjections, blockedByLedgerCalls, ledger: result.ledger.totals })}\n`,
  )
  console.log(
    `[run] ${scenarioId}/${profile}/${iteration} done: exit=${String(exit.code)} timedOut=${String(timedOut)} success=${String(success)} ` +
      `(report=${String(reportOk)} evidence=${String(evidenceOk)}) ` +
      `toolCalls=${toolCalls.length} tokensIn=${usage.inputTokens} tokensOut=${usage.outputTokens} ` +
      `warnInjections=${warnInjections} blockedByLedger=${blockedByLedgerCalls} ` +
      `ledger=${JSON.stringify(result.ledger.totals)}${result.ledger.error ? ` (${result.ledger.error})` : ''}`,
  )
  console.log(`[run] artifacts: ${relativeTo(projectRoot, runDir)}/result.jsonl`)
}

await main()
