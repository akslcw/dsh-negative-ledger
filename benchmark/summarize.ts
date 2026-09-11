// Benchmark summarizer: derives the seven gate metrics from collected
// result.jsonl files and per-session decoded logs, prints a console table,
// and writes benchmark/runs/summary.json + benchmark/runs/GATES.md.
//
// Usage: node benchmark/summarize.ts
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { callKey, classifyDenyBasis, extractToolCalls, isBlocked, matchesAllow, satisfiedRequiredAllow } from './session-log.ts'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const runsRoot = join(projectRoot, 'benchmark', 'runs')
const scenariosRoot = join(projectRoot, 'benchmark', 'scenarios')

interface ScenarioDef {
  id: string
  title: string
  requiredAllow: { tool: string; path?: string; commandLinePrefix?: string }[]
  mustNeverDeny: { tool: string; path?: string; commandLinePrefix?: string }[]
}

export interface ResultToolCall {
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
  successSource?: string
  successReport?: boolean
  successEvidence?: boolean
  timedOut: boolean
  exitCode: number | null
  toolCalls: ResultToolCall[]
  policy: { warnInjections: number; releaseInjections: number; blockedByLedgerCalls: number }
  /** Optional: runs collected before the basis tally existed lack this field. */
  denialBases?: Record<string, number>
  /**
   * Optional decision-time truth, written only by a collector that actually
   * ran a counterfactual probe. Absent (or `assessed: false`) means the run's
   * denials are UNASSESSED, which must never be reported as zero.
   */
  decisionTimeTruth?: {
    assessed?: boolean
    counterfactuallySuccessfulDenials?: number | null
    reason?: string
  }
  ledger: {
    totals: { duplicateFailuresObserved: number; warningsEmitted: number; callsDenied: number }
    denies: { kind: string; fingerprint: string; count: number }[]
    error?: string
  }
  durationMs: number
  tokenIn: number
  tokenOut: number
  harnessCommit?: string
  model?: string | null
}

export interface CellMetrics {
  iterations: number
  successCount: number
  completionRate: number | null
  repeatFailures: number
  /**
   * Denials of a call the scenario declares in `mustNeverDeny` — a call that is
   * legitimate at that point by construction. Decision-time truth, so it gates.
   */
  contractViolatingDenials: number
  /**
   * Denials of a call that would in fact have succeeded at decision time.
   * Requires a counterfactual probe, so it is `null` (= UNASSESSED) unless
   * every run in the cell carries decision-time truth. Never a stand-in zero.
   */
  counterfactuallySuccessfulDenials: number | null
  /** Runs whose denials carry no decision-time truth (drives the unassessed note). */
  unassessedDenialRuns: number
  /**
   * OBSERVATIONAL ONLY — not a gate and not a false-block count: denials whose
   * fingerprint later succeeded in the same round. A correct pre-repair denial
   * followed by an actual repair scores here too, so a zero here is not
   * evidence that no denial was wrong.
   */
  deniedThenLaterSucceeded: number
  /** Denied calls tallied by the decision-time reason the plugin recorded. */
  denialBases: Record<string, number>
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

/** Per-run resolved scenario (platform shell + command), falling back to the static file. */
function resolvedDef(run: RunRecord): ScenarioDef {
  const file = join(runsRoot, run.scenario, run.profile, run.iteration, 'scenario-resolved.json')
  if (existsSync(file)) return loadJson<ScenarioDef>(file)
  return scenarioDef(run.scenario)
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

/**
 * OBSERVATIONAL ONLY. Count the denied fingerprints that later succeeded in the
 * same round. This is the old "wrong block" oracle, kept as a signal but
 * stripped of its gate status because it cannot tell two very different
 * histories apart: a denial that was wrong, and a denial that was correct at
 * the time (recorded preconditions unchanged, cooldown unexpired) followed by a
 * genuine repair and a legitimately allowed retry. Both score here, so it must
 * never be reported as the number of false blocks.
 */
function deniedThenLaterSucceededForRun(run: RunRecord, runDir: string): number {
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

/**
 * Denied calls of one run tallied by the decision-time reason the plugin gave.
 * Runs collected after the collector started writing the tally use it; older
 * runs are re-derived from their recorded tool-call error text, which is the
 * same decision-time evidence — nothing is invented either way.
 */
export function denialBasesOf(run: DenialRun): Record<string, number> {
  if (run.denialBases !== undefined) return run.denialBases
  const bases: Record<string, number> = {}
  for (const call of run.toolCalls) {
    const basis = classifyDenyBasis(call)
    if (basis === null) continue
    bases[basis] = (bases[basis] ?? 0) + 1
  }
  return bases
}

/**
 * The slice of a run record the gates read. G6 scopes to the runs of one
 * scenario/profile, so only those fields are part of the contract.
 */
export interface ScenarioRun {
  scenario: string
  profile: string
  toolCalls: ResultToolCall[]
  policy: { warnInjections: number }
}

/** The slice of a run record the deny-basis tally reads. */
export interface DenialRun {
  denialBases?: Record<string, number> | undefined
  toolCalls: ResultToolCall[]
}

/** The slice of a run record the decision-time assessment rule reads. */
export interface DecisionTimeRun {
  policy: { blockedByLedgerCalls: number }
  decisionTimeTruth?: { assessed?: boolean; counterfactuallySuccessfulDenials?: number | null } | undefined
}

/**
 * Decision-time false blocks over a set of runs: `null` means UNASSESSED.
 *
 * The rule is deliberately strict. A run's denials can only be counted when
 * that run actually carries decision-time truth, because summing the assessed
 * runs of a partly-assessed batch would understate the count. A run that
 * recorded no denial at all is vacuously assessed — there is nothing to be
 * wrong about — which keeps a deny-free baseline at 0 instead of unknown.
 */
export function counterfactualFalseBlocks(runs: readonly DecisionTimeRun[]): number | null {
  let total = 0
  for (const run of runs) {
    const value = run.decisionTimeTruth?.counterfactuallySuccessfulDenials
    if (run.decisionTimeTruth?.assessed !== true || typeof value !== 'number') {
      if (run.policy.blockedByLedgerCalls === 0) continue
      return null
    }
    total += value
  }
  return total
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

/** Denied facts whose fingerprint matches a scenario's declared never-deny key. */
function denyViolations(run: RunRecord, def: ScenarioDef): number {
  let violations = 0
  for (const deny of run.ledger.denies) {
    try {
      const fingerprint = JSON.parse(deny.fingerprint) as { tool?: unknown; path?: unknown; commandLine?: unknown }
      for (const entry of def.mustNeverDeny) {
        if (String(fingerprint.tool ?? '') !== entry.tool) continue
        const value = entry.path !== undefined
          ? String(fingerprint.path ?? '').replaceAll('\\', '/')
          : String(fingerprint.commandLine ?? '')
        const matches = entry.path !== undefined
          ? value === entry.path || value.endsWith(`/${entry.path}`)
          : value.startsWith(entry.commandLinePrefix ?? '')
        if (matches) {
          violations += deny.count
          break
        }
      }
    } catch {
      // Non-JSON fingerprint: cannot match a declaration.
    }
  }
  return violations
}

export function emptyCellMetrics(): CellMetrics {
  return {
    iterations: 0,
    successCount: 0,
    completionRate: null,
    repeatFailures: 0,
    contractViolatingDenials: 0,
    // Replaced by counterfactualFalseBlocks() once the cell's runs are known.
    counterfactuallySuccessfulDenials: null,
    unassessedDenialRuns: 0,
    deniedThenLaterSucceeded: 0,
    denialBases: {},
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
}

function computeCells(runs: RunRecord[]): Map<string, CellMetrics> {
  const cells = new Map<string, CellMetrics>()
  const byCell = new Map<string, RunRecord[]>()
  for (const run of runs) {
    const id = `${run.scenario}/${run.profile}`
    const group = byCell.get(id)
    if (group === undefined) byCell.set(id, [run])
    else group.push(run)
  }
  for (const [id, group] of byCell) {
    const cell = emptyCellMetrics()
    for (const run of group) {
      const runDir = join(runsRoot, run.scenario, run.profile, run.iteration)
      cell.iterations += 1
      if (run.success) cell.successCount += 1
      cell.repeatFailures += repeatFailuresIn(run.toolCalls)
      // Kept as an observation only — see deniedThenLaterSucceededForRun.
      cell.deniedThenLaterSucceeded += deniedThenLaterSucceededForRun(run, runDir)
      cell.crossAgentRepeats += crossAgentRepeats(runDir)
      const def = resolvedDef(run)
      cell.contractViolatingDenials += denyViolations(run, def)
      if (run.decisionTimeTruth?.assessed !== true) cell.unassessedDenialRuns += 1
      for (const [basis, count] of Object.entries(denialBasesOf(run))) {
        cell.denialBases[basis] = (cell.denialBases[basis] ?? 0) + count
      }
      cell.requiredAllowSatisfied += satisfiedRequiredAllow(def.requiredAllow, run.toolCalls)
      cell.requiredAllowTotal += def.requiredAllow.length
      cell.warnInjections += run.policy.warnInjections
      cell.blockedByLedgerCalls += run.policy.blockedByLedgerCalls
      cell.deniedFromLedger += run.ledger.totals.callsDenied
      cell.warningsFromLedger += run.ledger.totals.warningsEmitted
      cell.dupFromLedger += run.ledger.totals.duplicateFailuresObserved
      cell.tokenIn += run.tokenIn
      cell.tokenOut += run.tokenOut
      cell.durationAvgMs += run.durationMs
    }
    cell.completionRate = cell.successCount / cell.iterations
    cell.durationAvgMs /= cell.iterations
    cell.counterfactuallySuccessfulDenials = counterfactualFalseBlocks(group)
    cells.set(id, cell)
  }
  return cells
}

export function groupTotals(cells: Map<string, CellMetrics>, profile: string): CellMetrics {
  const total = emptyCellMetrics()
  let allAssessed = true
  let falseBlocks = 0
  for (const [id, cell] of cells) {
    if (!id.endsWith(`/${profile}`)) continue
    total.iterations += cell.iterations
    total.successCount += cell.successCount
    total.repeatFailures += cell.repeatFailures
    total.contractViolatingDenials += cell.contractViolatingDenials
    total.unassessedDenialRuns += cell.unassessedDenialRuns
    total.deniedThenLaterSucceeded += cell.deniedThenLaterSucceeded
    for (const [basis, count] of Object.entries(cell.denialBases)) {
      total.denialBases[basis] = (total.denialBases[basis] ?? 0) + count
    }
    if (cell.counterfactuallySuccessfulDenials === null) allAssessed = false
    else falseBlocks += cell.counterfactuallySuccessfulDenials
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
  // One unassessed cell makes the whole group unassessed: a group total that
  // sums only the assessed cells would understate the false-block count.
  total.counterfactuallySuccessfulDenials = allAssessed && total.iterations > 0 ? falseBlocks : null
  return total
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator
}

/**
 * A gate outcome. `unassessed` is a first-class third state, not a soft pass:
 * the corpus simply does not contain the decision-time truth the gate needs
 * (the counterfactual half of G2), so the claim it guards may not be cited.
 * `passed` is kept in lockstep for readers of older summary.json files.
 */
export interface Gate {
  name: string
  status: 'pass' | 'fail' | 'unassessed'
  passed: boolean
  detail: string
}

/** Experiment stage: formal needs 3 iterations in every scenario×profile cell. */
function stageOf(cells: Map<string, CellMetrics>): 'formal' | 'trial' | 'pilot' {
  const totalRuns = [...cells.values()].reduce((sum, cell) => sum + cell.iterations, 0)
  const allPresent = listScenarios().every(scenario =>
    Object.keys(PROFILE_NAMES).every(profile => cells.has(`${scenario}/${profile}`)),
  )
  const allFormal = allPresent && [...cells.values()].every(cell => cell.iterations >= 3)
  if (allFormal) return 'formal'
  return totalRuns >= 18 ? 'trial' : 'pilot'
}

export function evaluateGates(cells: Map<string, CellMetrics>, runs: readonly ScenarioRun[]): Gate[] {
  const base = groupTotals(cells, 'baseline')
  const warn = groupTotals(cells, 'warn')
  const block = groupTotals(cells, 'block')
  const maxIterations = Math.max(base.iterations, warn.iterations, block.iterations)
  const stage = stageOf(cells)

  const reduction = ratio(base.repeatFailures - block.repeatFailures, base.repeatFailures)
  const crossReduction = ratio(base.crossAgentRepeats - block.crossAgentRepeats, base.crossAgentRepeats)
  const allowRate = ratio(block.requiredAllowSatisfied, block.requiredAllowTotal)

  const consistentDenies = warn.deniedFromLedger === warn.blockedByLedgerCalls && block.deniedFromLedger === block.blockedByLedgerCalls
  const consistentWarns = warn.warningsFromLedger === warn.warnInjections

  // G6 scopes to s1, the scenario whose prompt guarantees repeat pressure,
  // and is a conditional implication: a warn round is only judged when the
  // run actually exhibited a repeated failing call (repeatFailuresIn >= 1);
  // rounds where the model never repeated cannot trigger a warning and are
  // exempt, never counted against the plugin.
  const s1WarnRuns = runs.filter(run => run.scenario === 's1-missing-read-repeat' && run.profile === 'warn')
  const s1WarnPressureRounds = s1WarnRuns.filter(run => repeatFailuresIn(run.toolCalls) >= 1)
  const s1WarnInjected = s1WarnPressureRounds.filter(run => run.policy.warnInjections >= 1).length

  const gate = (name: string, passed: boolean, detail: string): Gate =>
    ({ name, status: passed ? 'pass' : 'fail', passed, detail })

  // G2 has two halves that are not equally knowable. Contract violations come
  // from the scenario's own mustNeverDeny declarations, so they are decidable
  // at decision time and available for every batch. Task-level false blocks
  // need a counterfactual probe; when the corpus carries none, that half is
  // UNASSESSED and the gate may not be reported as passing — see PROTOCOL.md.
  const falseBlocks = block.counterfactuallySuccessfulDenials
  const denialFailures = block.contractViolatingDenials + (falseBlocks ?? 0)
  const g2: Gate = {
    name: 'G2 Block 错误阻止 = 0（契约违反 + 任务级误阻）',
    status: denialFailures > 0 ? 'fail' : falseBlocks === null ? 'unassessed' : 'pass',
    passed: denialFailures === 0 && falseBlocks !== null,
    detail: `契约违反（场景声明 mustNeverDeny 键被 deny，决策时可判）=${block.contractViolatingDenials}；`
      + `任务级误阻（决策时反事实探针）=${falseBlocks === null
        ? `未评估（${block.unassessedDenialRuns} 轮未采集决策时真值，按未评估处理，不记 0）`
        : String(falseBlocks)}；`
      + `观察项「deny 后同指纹成功」=${block.deniedThenLaterSucceeded}（不计入门槛：正确的修复前 deny 也会被它计入）`,
  }

  const gates: Gate[] = [
    gate(
      'G1 Block 重复失败较 Baseline 降低 ≥ 70%',
      base.repeatFailures > 0 && reduction !== null && reduction >= 0.7,
      `baseline=${base.repeatFailures}, block=${block.repeatFailures}, reduction=${reduction === null ? 'n/a' : pct(reduction)}`,
    ),
    g2,
    gate(
      'G3 证据变化后合法重试放行率 = 100%',
      block.requiredAllowTotal > 0 && allowRate !== null && allowRate >= 1,
      `block ${block.requiredAllowSatisfied}/${block.requiredAllowTotal} (${allowRate === null ? 'n/a' : pct(allowRate)})`,
    ),
    gate(
      'G4 Block 完成率 ≥ Baseline',
      block.completionRate !== null && base.completionRate !== null && block.completionRate >= base.completionRate,
      `baseline=${base.completionRate === null ? 'n/a' : pct(base.completionRate)}, block=${block.completionRate === null ? 'n/a' : pct(block.completionRate)}`,
    ),
    gate(
      'G5 跨代理重复降低 ≥ 80%',
      base.crossAgentRepeats > 0 && crossReduction !== null && crossReduction >= 0.8,
      `baseline=${base.crossAgentRepeats}, block=${block.crossAgentRepeats}, reduction=${crossReduction === null ? 'n/a' : pct(crossReduction)}`,
    ),
    gate(
      'G6 Warn 在重复压力轮注入提醒',
      s1WarnPressureRounds.length > 0 && s1WarnInjected === s1WarnPressureRounds.length,
      `s1 warn 重复压力轮注入 ${s1WarnInjected}/${s1WarnPressureRounds.length}（s1 warn 总轮次 ${s1WarnRuns.length}，无重复压力的轮次豁免）`,
    ),
    gate(
      'G7 账本计数与会话日志一致',
      consistentDenies && consistentWarns,
      `deny 账本vs日志: warn ${warn.deniedFromLedger}/${warn.blockedByLedgerCalls}, block ${block.deniedFromLedger}/${block.blockedByLedgerCalls}; warn 账本vs日志: ${warn.warningsFromLedger}/${warn.warnInjections}`,
    ),
  ]
  const prefix = stage === 'formal' ? '' : stage === 'trial' ? '[试验轮, 非正式结论] ' : '[pilot, 非正式结论] '
  for (const gate of gates) gate.detail = prefix + gate.detail
  if (maxIterations === 0) {
    return gates.map(gate => ({
      name: gate.name,
      status: 'unassessed' as const,
      passed: false,
      detail: 'no runs collected — run benchmark/run.ts first',
    }))
  }
  return gates
}

function renderTable(cells: Map<string, CellMetrics>): string {
  const lines: string[] = []
  lines.push('| 场景 | 组 | 轮次 | 完成率 | 重复失败 | 契约违反 | 任务级误阻 | 放行 | 跨代理 | token 进/出 |')
  lines.push('|---|---|---|---|---|---|---|---|---|')
  for (const scenario of listScenarios()) {
    for (const profile of Object.keys(PROFILE_NAMES)) {
      const cell = cells.get(`${scenario}/${profile}`)
      if (cell === undefined) {
        lines.push(`| ${scenario} | ${profile} | 0 | – | – | – | – | – | – | – |`)
        continue
      }
      lines.push(
        `| ${scenario} | ${profile} | ${cell.iterations} | ${cell.completionRate === null ? 'n/a' : pct(cell.completionRate)} | ${cell.repeatFailures} | ${cell.contractViolatingDenials} | ${assessedText(cell.counterfactuallySuccessfulDenials)} | ${cell.requiredAllowSatisfied}/${cell.requiredAllowTotal} | ${cell.crossAgentRepeats} | ${cell.tokenIn}/${cell.tokenOut} |`,
      )
    }
  }
  return lines.join('\n')
}

/**
 * An uncollected probe is not evidence of absence: `null` renders as 未评估
 * (unassessed) and never as 0.
 */
function assessedText(value: number | null): string {
  return value === null ? '未评估' : String(value)
}

/** Gate verdict as printed; `unassessed` may not be read as a pass. */
function verdictOf(gate: Gate): string {
  return gate.status === 'pass' ? 'PASS' : gate.status === 'fail' ? 'FAIL' : 'UNASSESSED'
}

/** The decision-time reasons the plugin gave for its denials, biggest first. */
function basisText(total: CellMetrics): string {
  const entries = Object.entries(total.denialBases).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  return entries.length === 0 ? '（无）' : entries.map(([basis, count]) => `${basis} ${count}`).join(', ')
}

const GROUP_TABLE_HEADER = '| 组 | 轮次 | 完成率 | 重复失败 | 契约违反 | 任务级误阻 | 放行 | 跨代理 | token 进/出 |'
const GROUP_TABLE_DIVIDER = '|---|---|---|---|---|---|---|---|---|'

function groupRow(name: string, total: CellMetrics): string {
  return `| ${name} | ${total.iterations} | ${total.completionRate === null ? 'n/a' : pct(total.completionRate)} | ${total.repeatFailures} | ${total.contractViolatingDenials} | ${assessedText(total.counterfactuallySuccessfulDenials)} | ${total.requiredAllowSatisfied}/${total.requiredAllowTotal} | ${total.crossAgentRepeats} | ${total.tokenIn}/${total.tokenOut} |`
}

/**
 * The measurement legend that must travel with every table: what each column
 * can and cannot establish about a denial being wrong.
 */
function measurementNotes(total: CellMetrics): string[] {
  return [
    '指标口径：**契约违反** = 场景 `mustNeverDeny` 声明的调用被 deny，决策时可判，计入门槛；'
      + '**任务级误阻** = 被 deny 的调用在决策时本会成功，需决策时反事实探针，未采集时记「未评估」而 **不是 0**；'
      + '**deny 后同指纹成功** = 观察项，不计入门槛——正确的修复前 deny 同样会被它计入。',
    `block 组 deny 依据（决策时）：${basisText(total)}`,
  ]
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
  console.log(GROUP_TABLE_HEADER)
  console.log(GROUP_TABLE_DIVIDER)
  for (const [name, total] of [['baseline', base], ['warn', warn], ['block', block]] as const) {
    console.log(groupRow(name, total))
  }
  for (const note of measurementNotes(block)) console.log(`\n${note}`)
  const stage = stageOf(cells)
  console.log(`\n## 发布门槛（阶段：${stage}）\n`)
  for (const gate of gates) {
    console.log(`${verdictOf(gate)}  ${gate.name} — ${gate.detail}`)
  }

  // Environment consistency: every formal number must come from one model on
  // one harness commit; mixed sources are reported, never silently pooled.
  const models = [...new Set(runs.map(run => run.model ?? 'unknown'))]
  const commits = [...new Set(runs.map(run => run.harnessCommit ?? 'unknown'))]
  const consistency: string[] = []
  if (models.length > 1) consistency.push(`model 不唯一: ${models.join(', ')}`)
  if (commits.length > 1) consistency.push(`harnessCommit 不唯一: ${commits.join(', ')}`)
  if (consistency.length > 0) {
    console.log('\n⚠ 一致性警告：')
    for (const line of consistency) console.log(`  - ${line}`)
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    groups: { baseline: base, warn, block },
    gates,
    cells: Object.fromEntries(cells),
    consistency,
    models,
    harnessCommits: commits,
  }
  mkdirSync(runsRoot, { recursive: true })
  writeFileSync(join(runsRoot, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
  const cellRows = listScenarios().flatMap(scenario =>
    Object.keys(PROFILE_NAMES).map(profile => {
      const cell = cells.get(`${scenario}/${profile}`)
      return `| ${scenario} | ${profile} | ${cell?.iterations ?? 0} | ${cell?.repeatFailures ?? 0} | `
        + `${cell?.contractViolatingDenials ?? 0} | ${cell === undefined ? '未评估' : assessedText(cell.counterfactuallySuccessfulDenials)} | `
        + `${cell?.deniedThenLaterSucceeded ?? 0} | ${cell?.requiredAllowSatisfied ?? 0}/${cell?.requiredAllowTotal ?? 0} |`
    }),
  )
  const gateLines = [
    '# 发布门槛评估',
    '',
    `生成时间：${summary.generatedAt}`,
    '',
    `阶段：${stage}（formal = 每格 3 轮；trial = 18 轮单次；pilot = 更少）`,
    `模型：${models.join(', ')}；harness commit：${commits.join(', ')}`,
    ...(consistency.length > 0 ? ['', '**一致性警告**：', ...consistency.map(line => `- ${line}`)] : []),
    '',
    '| 门槛 | 判定 | 说明 |',
    '|---|---|---|',
    ...gates.map(gate => `| ${gate.name} | ${verdictOf(gate)} | ${gate.detail} |`),
    '',
    ...measurementNotes(block).map(note => `${note}\n`),
    '## 分组汇总',
    '',
    GROUP_TABLE_HEADER,
    GROUP_TABLE_DIVIDER,
    ...(['baseline', 'warn', 'block'] as const).map(name => groupRow(name, { baseline: base, warn, block }[name])),
    '',
    '## 逐格明细（审计用）',
    '',
    '| 场景 | 组 | 轮次 | 重复失败 | 契约违反 | 任务级误阻 | deny后同指纹成功(观察) | 放行 |',
    '|---|---|---|---|---|---|---|---|',
    ...cellRows,
    '',
  ]
  writeFileSync(join(runsRoot, 'GATES.md'), `${gateLines.join('\n')}\n`)
  console.log(`\n[summarize] wrote benchmark/runs/summary.json + benchmark/runs/GATES.md`)
}

// Importing this module (tests do) must not run the report; only a direct
// `node benchmark/summarize.ts` invocation does.
const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (invokedDirectly) main()
