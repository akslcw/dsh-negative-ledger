// Benchmark summarizer: derives the seven gate metrics from collected
// result.jsonl files and per-session decoded logs, prints a console table,
// and writes benchmark/runs/summary.json + benchmark/runs/GATES.md.
//
// Usage: node benchmark/summarize.ts
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { callKey, extractToolCalls } from './session-log.ts'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const runsRoot = join(projectRoot, 'benchmark', 'runs')
const scenariosRoot = join(projectRoot, 'benchmark', 'scenarios')

interface ScenarioDef {
  id: string
  title: string
  requiredAllow: { tool: string; path?: string; commandLinePrefix?: string }[]
}

interface ResultToolCall {
  name: string
  args: Record<string, unknown> | null
  ok: boolean | null
  isError: boolean
  errorText: string
}

interface RunRecord {
  scenario: string
  profile: string
  iteration: string
  success: boolean
  timedOut: boolean
  exitCode: number | null
  toolCalls: ResultToolCall[]
  policy: { warnInjections: number; releaseInjections: number; blockedByLedgerCalls: number }
  ledger: {
    totals: { duplicateFailuresObserved: number; warningsEmitted: number; callsDenied: number }
    denies: { kind: string; fingerprint: string; count: number }[]
    error?: string
  }
  durationMs: number
  tokenIn: number
  tokenOut: number
}

interface CellMetrics {
  iterations: number
  successCount: number
  completionRate: number | null
  repeatFailures: number
  wrongBlocks: number
  requiredAllowSatisfied: number
  requiredAllowTotal: number
  crossAgentRepeats: number
  warnInjections: number
  blockedByLedgerCalls: number
  deniedFromLedger: number
  warningsFromLedger: number
  dupFromLedger: number
  tokenIn: number
  tokenOut: number
  durationAvgMs: number
}

const PROFILE_NAMES: Record<string, string> = {
  baseline: 'Baseline (official reminder)',
  warn: 'Warn',
  block: 'Block',
}

function loadJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, 'utf8')) as T
}

function listScenarios(): string[] {
  return readdirSync(scenariosRoot)
    .filter(name => name.endsWith('.json'))
    .map(name => name.slice(0, -'.json'.length))
    .sort()
}

function scenarioDef(id: string): ScenarioDef {
  return loadJson<ScenarioDef>(join(scenariosRoot, `${id}.json`))
}

function collectRuns(): RunRecord[] {
  const runs: RunRecord[] = []
  for (const scenario of listScenarios()) {
    for (const profile of Object.keys(PROFILE_NAMES)) {
      const dir = join(runsRoot, scenario, profile)
      if (!existsSync(dir)) continue
      for (const iteration of readdirSync(dir)) {
        const file = join(dir, iteration, 'result.jsonl')
        if (!existsSync(file)) continue
        const line = readFileSync(file, 'utf8').trim().split('\n').at(-1) ?? ''
        if (line === '') continue
        try {
          runs.push(JSON.parse(line) as RunRecord)
        } catch {
          // Leave malformed results out; the console report lists skipped runs.
        }
      }
    }
  }
  return runs
}

function isBlocked(call: ResultToolCall): boolean {
  return call.isError && call.errorText.includes('blocked by negative-ledger')
}

function repeatFailuresIn(calls: ResultToolCall[]): number {
  const last = new Map<string, boolean>()
  let repeats = 0
  for (const call of calls) {
    const key = callKey(call)
    const failed = call.isError && !isBlocked(call)
    if (failed && last.get(key) === false) repeats += 1
    last.set(key, failed ? false : true)
  }
  return repeats
}

function failedKeysOf(calls: ResultToolCall[]): Set<string> {
  const keys = new Set<string>()
  for (const call of calls) {
    if (call.isError && !isBlocked(call)) keys.add(callKey(call))
  }
  return keys
}

function matchesAllow(call: ResultToolCall, entry: { tool: string; path?: string; commandLinePrefix?: string }): boolean {
  if (call.name !== entry.tool) return false
  const args = call.args ?? {}
  if (entry.path !== undefined) {
    const filePath = String(args.file_path ?? args.path ?? '').replaceAll('\\', '/')
    return filePath === entry.path || filePath.endsWith(`/${entry.path}`)
  }
  const command = String(args.command ?? args.cmd ?? '').trim()
  return command.startsWith(entry.commandLinePrefix ?? '')
}

function satisfiedRequiredAllow(def: ScenarioDef, calls: ResultToolCall[]): number {
  let satisfied = 0
  for (const entry of def.requiredAllow) {
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

interface SessionCalls {
  depth: number
  calls: ResultToolCall[]
}

function perSessionCalls(runDir: string): Map<string, SessionCalls> {
  const decoded = join(runDir, 'session-decoded')
  const map = new Map<string, SessionCalls>()
  if (!existsSync(decoded)) return map
  for (const file of readdirSync(decoded)) {
    try {
      const events = JSON.parse(`[${readFileSync(join(decoded, file), 'utf8').trim().split('\n').join(',')}]`) as unknown[]
      let depth = 0
      for (const raw of events) {
        if (typeof raw === 'object' && raw !== null && (raw as { type?: unknown }).type === 'session') {
          const value = (raw as { delegationDepth?: unknown }).delegationDepth
          if (typeof value === 'number') depth = value
          break
        }
      }
      map.set(file, {
        depth,
        calls: extractToolCalls(events).map(call => ({
          name: call.name,
          args: call.args,
          ok: call.ok,
          isError: call.isError,
          errorText: call.errorText,
        })),
      })
    } catch {
      // Skip undecodable session files.
    }
  }
  return map
}

function wrongBlocksForRun(run: RunRecord, runDir: string): number {
  const deniedKeys = new Set<string>()
  for (const deny of run.ledger.denies) {
    try {
      const fingerprint = JSON.parse(deny.fingerprint) as { tool?: unknown; path?: unknown }
      if (typeof fingerprint.tool === 'string') {
        deniedKeys.add(`${fingerprint.tool}|${String(fingerprint.path ?? '')}`)
      }
    } catch {
      // Non-JSON fingerprint: skip key mapping.
    }
  }
  if (deniedKeys.size === 0) return 0
  let wrong = 0
  for (const { calls } of perSessionCalls(runDir).values()) {
    for (const key of deniedKeys) {
      let sawDeny = false
      for (const call of calls) {
        if (callKey(call) !== key) continue
        if (isBlocked(call)) sawDeny = true
        else if (sawDeny && call.ok === true) {
          wrong += 1
          break
        }
      }
    }
  }
  return wrong
}

function crossAgentRepeats(runDir: string): number {
  const sessions = [...perSessionCalls(runDir).values()]
  if (sessions.length < 2) return 0
  const minDepth = Math.min(...sessions.map(session => session.depth))
  const parentFailed = new Set<string>()
  for (const session of sessions) {
    if (session.depth !== minDepth) continue
    for (const key of failedKeysOf(session.calls)) parentFailed.add(key)
  }
  let repeats = 0
  for (const session of sessions) {
    if (session.depth === minDepth) continue
    for (const call of session.calls) {
      if (!isBlocked(call) && call.isError && parentFailed.has(callKey(call))) repeats += 1
    }
  }
  return repeats
}

function computeCells(runs: RunRecord[]): Map<string, CellMetrics> {
  const cells = new Map<string, CellMetrics>()
  for (const run of runs) {
    const id = `${run.scenario}/${run.profile}`
    const cell = cells.get(id) ?? {
      iterations: 0,
      successCount: 0,
      completionRate: null,
      repeatFailures: 0,
      wrongBlocks: 0,
      requiredAllowSatisfied: 0,
      requiredAllowTotal: 0,
      crossAgentRepeats: 0,
      warnInjections: 0,
      blockedByLedgerCalls: 0,
      deniedFromLedger: 0,
      warningsFromLedger: 0,
      dupFromLedger: 0,
      tokenIn: 0,
      tokenOut: 0,
      durationAvgMs: 0,
    }
    const runDir = join(runsRoot, run.scenario, run.profile, run.iteration)
    cell.iterations += 1
    if (run.success) cell.successCount += 1
    cell.repeatFailures += repeatFailuresIn(run.toolCalls)
    cell.wrongBlocks += wrongBlocksForRun(run, runDir)
    cell.crossAgentRepeats += crossAgentRepeats(runDir)
    const def = scenarioDef(run.scenario)
    cell.requiredAllowSatisfied += satisfiedRequiredAllow(def, run.toolCalls)
    cell.requiredAllowTotal += def.requiredAllow.length
    cell.warnInjections += run.policy.warnInjections
    cell.blockedByLedgerCalls += run.policy.blockedByLedgerCalls
    cell.deniedFromLedger += run.ledger.totals.callsDenied
    cell.warningsFromLedger += run.ledger.totals.warningsEmitted
    cell.dupFromLedger += run.ledger.totals.duplicateFailuresObserved
    cell.tokenIn += run.tokenIn
    cell.tokenOut += run.tokenOut
    cell.durationAvgMs += run.durationMs
    cells.set(id, cell)
  }
  for (const cell of cells.values()) {
    cell.completionRate = cell.iterations === 0 ? null : cell.successCount / cell.iterations
    cell.durationAvgMs = cell.iterations === 0 ? 0 : cell.durationAvgMs / cell.iterations
  }
  return cells
}

function groupTotals(cells: Map<string, CellMetrics>, profile: string): CellMetrics {
  const total: CellMetrics = {
    iterations: 0,
    successCount: 0,
    completionRate: null,
    repeatFailures: 0,
    wrongBlocks: 0,
    requiredAllowSatisfied: 0,
    requiredAllowTotal: 0,
    crossAgentRepeats: 0,
    warnInjections: 0,
    blockedByLedgerCalls: 0,
    deniedFromLedger: 0,
    warningsFromLedger: 0,
    dupFromLedger: 0,
    tokenIn: 0,
    tokenOut: 0,
    durationAvgMs: 0,
  }
  for (const [id, cell] of cells) {
    if (!id.endsWith(`/${profile}`)) continue
    total.iterations += cell.iterations
    total.successCount += cell.successCount
    total.repeatFailures += cell.repeatFailures
    total.wrongBlocks += cell.wrongBlocks
    total.requiredAllowSatisfied += cell.requiredAllowSatisfied
    total.requiredAllowTotal += cell.requiredAllowTotal
    total.crossAgentRepeats += cell.crossAgentRepeats
    total.warnInjections += cell.warnInjections
    total.blockedByLedgerCalls += cell.blockedByLedgerCalls
    total.deniedFromLedger += cell.deniedFromLedger
    total.warningsFromLedger += cell.warningsFromLedger
    total.dupFromLedger += cell.dupFromLedger
    total.tokenIn += cell.tokenIn
    total.tokenOut += cell.tokenOut
    total.durationAvgMs += cell.durationAvgMs * cell.iterations
  }
  total.completionRate = total.iterations === 0 ? null : total.successCount / total.iterations
  total.durationAvgMs = total.iterations === 0 ? 0 : total.durationAvgMs / total.iterations
  return total
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator
}

interface Gate {
  name: string
  passed: boolean
  detail: string
}

function evaluateGates(cells: Map<string, CellMetrics>, runs: RunRecord[]): Gate[] {
  const base = groupTotals(cells, 'baseline')
  const warn = groupTotals(cells, 'warn')
  const block = groupTotals(cells, 'block')
  const maxIterations = Math.max(base.iterations, warn.iterations, block.iterations)
  const preliminary = maxIterations < 3

  const reduction = ratio(base.repeatFailures - block.repeatFailures, base.repeatFailures)
  const crossReduction = ratio(base.crossAgentRepeats - block.crossAgentRepeats, base.crossAgentRepeats)
  const allowRate = ratio(block.requiredAllowSatisfied, block.requiredAllowTotal)

  const consistentDenies = warn.deniedFromLedger === warn.blockedByLedgerCalls && block.deniedFromLedger === block.blockedByLedgerCalls
  const consistentWarns = warn.warningsFromLedger === warn.warnInjections

  // G6 scopes to s1, the scenario whose prompt guarantees repeat pressure:
  // other scenarios legitimately produce zero warnings.
  const s1WarnRuns = runs.filter(run => run.scenario === 's1-missing-read-repeat' && run.profile === 'warn')
  const s1WarnInjected = s1WarnRuns.filter(run => run.policy.warnInjections >= 1).length

  const gates: Gate[] = [
    {
      name: 'G1 Block 重复失败较 Baseline 降低 ≥ 70%',
      passed: base.repeatFailures > 0 && reduction !== null && reduction >= 0.7,
      detail: `baseline=${base.repeatFailures}, block=${block.repeatFailures}, reduction=${reduction === null ? 'n/a' : pct(reduction)}`,
    },
    {
      name: 'G2 Block 错误阻止 = 0',
      passed: block.wrongBlocks === 0,
      detail: `block wrongBlocks=${block.wrongBlocks}`,
    },
    {
      name: 'G3 证据变化后合法重试放行率 = 100%',
      passed: block.requiredAllowTotal > 0 && allowRate !== null && allowRate >= 1,
      detail: `block ${block.requiredAllowSatisfied}/${block.requiredAllowTotal} (${allowRate === null ? 'n/a' : pct(allowRate)})`,
    },
    {
      name: 'G4 Block 完成率 ≥ Baseline',
      passed: block.completionRate !== null && base.completionRate !== null && block.completionRate >= base.completionRate,
      detail: `baseline=${base.completionRate === null ? 'n/a' : pct(base.completionRate)}, block=${block.completionRate === null ? 'n/a' : pct(block.completionRate)}`,
    },
    {
      name: 'G5 跨代理重复降低 ≥ 80%',
      passed: base.crossAgentRepeats > 0 && crossReduction !== null && crossReduction >= 0.8,
      detail: `baseline=${base.crossAgentRepeats}, block=${block.crossAgentRepeats}, reduction=${crossReduction === null ? 'n/a' : pct(crossReduction)}`,
    },
    {
      name: 'G6 Warn 每轮都注入提醒',
      passed: s1WarnRuns.length > 0 && s1WarnInjected === s1WarnRuns.length,
      detail: `s1 warn ${s1WarnInjected}/${s1WarnRuns.length} rounds injected`,
    },
    {
      name: 'G7 账本计数与会话日志一致',
      passed: consistentDenies && consistentWarns,
      detail: `deny 账本vs日志: warn ${warn.deniedFromLedger}/${warn.blockedByLedgerCalls}, block ${block.deniedFromLedger}/${block.blockedByLedgerCalls}; warn 账本vs日志: ${warn.warningsFromLedger}/${warn.warnInjections}`,
    },
  ]
  if (preliminary) {
    for (const gate of gates) gate.detail = `[试验轮, 非正式结论] ${gate.detail}`
  }
  if (maxIterations === 0) {
    return gates.map(gate => ({ name: gate.name, passed: false, detail: 'no runs collected — run benchmark/run.ts first' }))
  }
  return gates
}

function renderTable(cells: Map<string, CellMetrics>): string {
  const lines: string[] = []
  lines.push('| 场景 | 组 | 轮次 | 完成率 | 重复失败 | 错误阻止 | 放行 | 跨代理 | token 进/出 |')
  lines.push('|---|---|---|---|---|---|---|---|---|')
  for (const scenario of listScenarios()) {
    for (const profile of Object.keys(PROFILE_NAMES)) {
      const cell = cells.get(`${scenario}/${profile}`)
      if (cell === undefined) {
        lines.push(`| ${scenario} | ${profile} | 0 | – | – | – | – | – | – |`)
        continue
      }
      lines.push(
        `| ${scenario} | ${profile} | ${cell.iterations} | ${cell.completionRate === null ? 'n/a' : pct(cell.completionRate)} | ${cell.repeatFailures} | ${cell.wrongBlocks} | ${cell.requiredAllowSatisfied}/${cell.requiredAllowTotal} | ${cell.crossAgentRepeats} | ${cell.tokenIn}/${cell.tokenOut} |`,
      )
    }
  }
  return lines.join('\n')
}

function main(): void {
  const runs = collectRuns()
  const cells = computeCells(runs)
  const gates = evaluateGates(cells, runs)
  const base = groupTotals(cells, 'baseline')
  const warn = groupTotals(cells, 'warn')
  const block = groupTotals(cells, 'block')

  console.log('## 单元指标\n')
  console.log(renderTable(cells))
  console.log('\n## 分组汇总\n')
  console.log('| 组 | 轮次 | 完成率 | 重复失败 | 错误阻止 | 放行 | 跨代理 | token 进/出 |')
  console.log('|---|---|---|---|---|---|---|---|')
  for (const [name, total] of [['baseline', base], ['warn', warn], ['block', block]] as const) {
    console.log(
      `| ${name} | ${total.iterations} | ${total.completionRate === null ? 'n/a' : pct(total.completionRate)} | ${total.repeatFailures} | ${total.wrongBlocks} | ${total.requiredAllowSatisfied}/${total.requiredAllowTotal} | ${total.crossAgentRepeats} | ${total.tokenIn}/${total.tokenOut} |`,
    )
  }
  console.log('\n## 发布门槛\n')
  for (const gate of gates) {
    console.log(`${gate.passed ? 'PASS' : 'FAIL'}  ${gate.name} — ${gate.detail}`)
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    groups: { baseline: base, warn, block },
    gates,
    cells: Object.fromEntries(cells),
  }
  mkdirSync(runsRoot, { recursive: true })
  writeFileSync(join(runsRoot, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
  const gateLines = [
    '# 发布门槛评估',
    '',
    `生成时间：${summary.generatedAt}`,
    '',
    '| 门槛 | 判定 | 说明 |',
    '|---|---|---|',
    ...gates.map(gate => `| ${gate.name} | ${gate.passed ? 'PASS' : 'FAIL'} | ${gate.detail} |`),
    '',
    '## 分组汇总',
    '',
    '| 组 | 轮次 | 完成率 | 重复失败 | 错误阻止 | 放行 | 跨代理 | token 进/出 |',
    '|---|---|---|---|---|---|---|---|',
    ...(['baseline', 'warn', 'block'] as const).map(name => {
      const total = { baseline: base, warn, block }[name]
      return `| ${name} | ${total.iterations} | ${total.completionRate === null ? 'n/a' : pct(total.completionRate)} | ${total.repeatFailures} | ${total.wrongBlocks} | ${total.requiredAllowSatisfied}/${total.requiredAllowTotal} | ${total.crossAgentRepeats} | ${total.tokenIn}/${total.tokenOut} |`
    }),
    '',
  ]
  writeFileSync(join(runsRoot, 'GATES.md'), `${gateLines.join('\n')}\n`)
  console.log(`\n[summarize] wrote benchmark/runs/summary.json + benchmark/runs/GATES.md`)
}

main()
