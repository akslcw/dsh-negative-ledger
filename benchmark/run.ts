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
import Database from 'better-sqlite3'
import {
  decodeSessionLogFile,
  eventText,
  extractToolCalls,
  extractUsage,
  findSessionLogs,
  relativeTo,
} from './session-log.ts'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const runsRoot = join(projectRoot, 'benchmark', 'runs')

interface ScenarioDef {
  id: string
  title: string
  timeoutMs: number
  tokenBudget: number
  successMarker: string
  requiredAllow: { tool: string; path?: string; commandLinePrefix?: string }[]
  prompt: string
}

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
  successSource: 'stdout' | 'events' | 'none'
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
  policy: { warnInjections: number; blockedByLedgerCalls: number; samples: string[] }
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
  const scenario = loadJson<ScenarioDef>(join(projectRoot, 'benchmark', 'scenarios', `${scenarioId}.json`))

  const runDir = join(runsRoot, scenarioId, profile, iteration)
  rmSync(runDir, { recursive: true, force: true })
  mkdirSync(runDir, { recursive: true })
  const workspace = join(runDir, 'workspace')
  mkdirSync(workspace, { recursive: true })
  const dshHome = join(runDir, 'dsh-home')
  const ledgerDir = join(runDir, 'ledger-db')

  const seedDir = join(projectRoot, 'benchmark', 'scenarios', scenarioId, 'seed')
  if (existsSync(seedDir)) copyTree(seedDir, workspace)

  const template = readFileSync(join(projectRoot, 'benchmark', 'profiles', `${profile}.patch.yml`), 'utf8')
  const patchPath = join(runDir, 'patch.yml')
  writeFileSync(patchPath, template.replaceAll('__LEDGER_DIR__', ledgerDir.replaceAll('\\', '/')))

  const binPath = process.env.DSH_BIN ?? join(checkout, 'apps', 'cli', 'lib', 'bin.js')
  if (!existsSync(binPath)) fail(`harness CLI not found at ${binPath} (build the checkout or set DSH_BIN)`)

  const startedAt = new Date()
  const startedAtIso = startedAt.toISOString()
  console.log(`[run] ${scenarioId}/${profile}/${iteration} starting (workspace ${workspace})`)
  const child = spawn(process.execPath, [binPath, '--profile', 'headless', '--patch', patchPath, scenario.prompt], {
    cwd: workspace,
    env: { ...process.env, DSH_HOME: dshHome },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', (chunk: Buffer) => {
    if (stdout.length < 2_000_000) stdout += chunk.toString('utf8')
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    if (stderr.length < 2_000_000) stderr += chunk.toString('utf8')
  })
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

  const ledgerDirCopy = join(runDir, 'ledger-db')
  if (existsSync(ledgerDir)) cpSync(ledgerDir, ledgerDirCopy, { recursive: true })

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
  const text = eventText(allEvents)
  const success = stdout.includes(scenario.successMarker) || text.includes(scenario.successMarker)
  const successSource: RunResult['successSource'] = stdout.includes(scenario.successMarker) ? 'stdout' : success ? 'events' : 'none'

  let warnInjections = 0
  let blockedByLedgerCalls = 0
  const samples: string[] = []
  for (const event of allEvents) {
    if (typeof event !== 'object' || event === null) continue
    const record = event as { type?: unknown; data?: unknown }
    if (record.type === 'agent/inbox/spliced' && typeof record.data === 'object' && record.data !== null) {
      const data = record.data as { source?: unknown }
      const source = data.source
      if (typeof source === 'object' && source !== null && (source as { plugin?: unknown }).plugin === 'negative-ledger') {
        warnInjections += 1
        if (samples.length < 3) samples.push(cap(JSON.stringify(data).slice(0, 400), 400))
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
    policy: { warnInjections, blockedByLedgerCalls, samples },
    ledger: snapshotLedger(join(ledgerDirCopy, 'ledger.db')),
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
      `toolCalls=${toolCalls.length} tokensIn=${usage.inputTokens} tokensOut=${usage.outputTokens} ` +
      `warnInjections=${warnInjections} blockedByLedger=${blockedByLedgerCalls} ` +
      `ledger=${JSON.stringify(result.ledger.totals)}${result.ledger.error ? ` (${result.ledger.error})` : ''}`,
  )
  console.log(`[run] artifacts: ${relativeTo(projectRoot, runDir)}/result.jsonl`)
}

await main()
