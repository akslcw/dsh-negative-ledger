// Keyless real DSH host task trials: repeated local build failure, real
// filesystem repair, and the ledger's decisions on the retries.
//
// HONEST LABELLING — the LLM is SCRIPTED. `ScriptedAdapter` replays a fixed
// list of tool calls, so no model, no network, and no paid API is involved.
// What is real: the DSH host wiring (agent-loop, tools, fs-local, bash-local),
// the real filesystem and real `bash -c` subprocesses, and the plugin under
// test. Read every result here as "policy behavior under a scripted operator",
// never as an agent-capability claim.
//
// GROUND TRUTH IS PER ATTEMPT, NOT PER SCENARIO. Each denied attempt is probed
// counterfactually — the same command, run against a private copy of the
// workspace as it stood at dispatch — so a denial is classified by what the
// command WOULD have done at that moment. A denial is never called wrong
// merely because a later, repaired attempt succeeded.
//
// Pass the installed DSH node_modules directory as argv[2].
import strictAssert from 'node:assert/strict'
let assertions = 0
const assert = new Proxy(strictAssert, { get(target, key) {
  const value = Reflect.get(target, key)
  return typeof value === 'function' ? (...args) => { assertions++; return value(...args) } : value
} })
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as ledgerPlugin from '../src/index.ts'
const { SqliteLedgerStore } = ledgerPlugin
const modules = resolve(process.argv[2] ?? 'smoke/host-fixture/node_modules')
const host = name => import(pathToFileURL(join(modules, '@deepseek-ai', `dsh-${name}`, 'lib/index.js')).href)
const { Context } = await import(pathToFileURL(join(modules, '@deepseek-ai/cordis/lib/index.js')).href)
const { ToolCallId, createUserMessage, LlmAdapter } = await host('llm')
const { SessionId } = await host('session')

// --- scripted adapter (mirrors the agent-loop test mock) --------------------

function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    ...Array.from(text, (char): StreamChunk => ({ type: 'text-delta', index: 0, text: char })),
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: text.length } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function toolCallResponse(rawCallId: string, name: string, args: object): StreamChunk[] {
  const callId = ToolCallId(rawCallId)
  const argumentsJson = JSON.stringify(args)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: callId, name, argumentsDelta: argumentsJson.slice(0, 5) },
    { type: 'tool-call-delta', index: 0, id: callId, argumentsDelta: argumentsJson.slice(5) },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name, arguments: argumentsJson } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

class ScriptedAdapter extends LlmAdapter {
  requests: GenerateOptions[] = []
  #script: StreamChunk[][]

  constructor(script: StreamChunk[][]) {
    super()
    this.#script = script
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const entry = this.#script.shift()
    if (entry === undefined) throw new Error('ScriptedAdapter: script exhausted')
    for (const chunk of entry) {
      if (options.signal?.aborted) throw new Error('aborted')
      yield chunk
    }
  }
}

// --- fixtures ---------------------------------------------------------------

// The build reads two files and reads no environment: `build.json` gates it
// and `source.txt` is the payload. Either one can be the real cause, which is
// what lets the declared/undeclared distinction be exercised on one fixture.
const BUILD_SCRIPT = `import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
appendFileSync('runs.log','run\\n');
if (!JSON.parse(readFileSync('build.json','utf8')).enabled) { console.error('build disabled by config'); process.exit(1); }
const source=readFileSync('source.txt','utf8');
if (source==='BROKEN') { console.error('invalid source'); process.exit(1); }
writeFileSync('dist.txt',source.toUpperCase());
console.log('build complete');`

const EVIDENCE_MAX_AGE_MS = 2000
const FRESHNESS_SLEEP_MS = 2500
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'"

/** What a step does, resolved to concrete paths once the fixture is laid out. */
type Role = 'read-declared' | 'build' | 'build-control' | 'write-unrelated' | 'repair-declared' | 'repair-undeclared'

interface Step {
  role: Role
  label: string
  /** Delay before this step is issued, so a real observation can age out. */
  beforeMs?: number
  /** Expected bash outcome; non-bash steps are not scored here. */
  expect?: 'fail' | 'deny' | 'ok'
}

interface ScenarioSpec {
  id: string
  /** What this scenario establishes, in one line. */
  intent: string
  /** Extra plugin config for this scenario. */
  overrides?: object
  steps: Step[]
  /** Expected classification of each denied bash attempt, in order. */
  expectDenials: string[]
  /** Expected precondition witnesses recorded on the first failure fact. */
  expectInitialPreconditions: number
  /** Expected terminal status of the build-command fact. */
  expectFinalStatus: 'active' | 'resolved'
  /** Deny reasons must contain these fragments (in order), when given. */
  expectDenyReasonFragments?: string[]
}

const scenarios: ScenarioSpec[] = [
  {
    id: 'declared-repair',
    intent: 'an unchanged repeat and an unrelated edit stay blocked; a relevant change to the declared dependency releases the exact retry before TTL',
    steps: [
      { role: 'read-declared', label: 'observe-declared-dependency' },
      { role: 'build', label: 'initial-build-fails', expect: 'fail' },
      { role: 'build', label: 'unchanged-repeat', expect: 'deny' },
      { role: 'write-unrelated', label: 'unrelated-edit' },
      { role: 'build', label: 'repeat-after-unrelated-edit', expect: 'deny' },
      { role: 'repair-declared', label: 'relevant-repair' },
      { role: 'build', label: 'retry-after-relevant-repair', expect: 'ok' },
    ],
    expectDenials: ['correct-block', 'correct-block'],
    expectInitialPreconditions: 1,
    expectFinalStatus: 'resolved',
    expectDenyReasonFragments: ['Observed preconditions still match', 'Observed preconditions still match'],
  },
  {
    id: 'missing-evidence',
    intent: 'no pre-dispatch snapshot was ever frozen, so the fact carries no witness and a change to the declared dependency cannot release it',
    steps: [
      { role: 'build', label: 'initial-build-fails-unobserved', expect: 'fail' },
      { role: 'build', label: 'unchanged-repeat', expect: 'deny' },
      { role: 'repair-declared', label: 'relevant-repair' },
      { role: 'build', label: 'retry-after-repair-stays-blocked', expect: 'deny' },
      { role: 'build-control', label: 'alternate-command-proves-repair', expect: 'ok' },
    ],
    expectDenials: ['correct-block', 'conservative-block:missing-evidence'],
    expectInitialPreconditions: 0,
    expectFinalStatus: 'active',
    expectDenyReasonFragments: ['No precondition evidence was recorded'],
  },
  {
    id: 'expired-evidence',
    intent: 'the repair is observed but that observation ages past the freshness window, so a retry that would now succeed stays blocked until the file is observed again',
    overrides: { commandEvidenceMaxAgeMs: EVIDENCE_MAX_AGE_MS },
    steps: [
      { role: 'read-declared', label: 'observe-declared-dependency' },
      { role: 'build', label: 'initial-build-fails', expect: 'fail' },
      { role: 'build', label: 'unchanged-repeat', expect: 'deny' },
      { role: 'repair-declared', label: 'relevant-repair' },
      { role: 'build', label: 'retry-after-repair-blocked-by-expiry', beforeMs: FRESHNESS_SLEEP_MS, expect: 'deny' },
      { role: 'read-declared', label: 're-observe-dependency' },
      { role: 'build', label: 'retry-after-re-observation', expect: 'ok' },
    ],
    expectDenials: ['correct-block', 'conservative-block:expired-evidence'],
    expectInitialPreconditions: 1,
    expectFinalStatus: 'resolved',
    expectDenyReasonFragments: ['evidence is incomplete'],
  },
  {
    id: 'hidden-dependency',
    intent: 'the real cause is a file the rule never declared; the repair makes the command succeed counterfactually, but the declared dependency is unchanged so the exact retry stays TTL-blocked',
    steps: [
      { role: 'read-declared', label: 'observe-declared-dependency' },
      { role: 'build', label: 'initial-build-fails', expect: 'fail' },
      { role: 'build', label: 'unchanged-repeat', expect: 'deny' },
      { role: 'repair-undeclared', label: 'repair-undeclared-dependency' },
      { role: 'build', label: 'retry-stays-blocked', expect: 'deny' },
      { role: 'build-control', label: 'alternate-command-proves-repair', expect: 'ok' },
    ],
    expectDenials: ['correct-block', 'conservative-block:undeclared-dependency'],
    expectInitialPreconditions: 1,
    expectFinalStatus: 'active',
    expectDenyReasonFragments: ['Observed preconditions still match'],
  },
]

/** Counterfactual probe: run the same command in a copy of the workspace. */
function probeCommand(command: string, workspace: string, inputs: string[]) {
  const probeRoot = mkdtempSync(join(tmpdir(), 'negative-ledger-probe-'))
  try {
    for (const name of inputs) {
      const from = join(workspace, name)
      if (existsSync(from)) copyFileSync(from, join(probeRoot, name))
    }
    const result = spawnSync('bash', ['-c', command], { cwd: probeRoot, encoding: 'utf8', timeout: 30_000 })
    return {
      exitCode: result.status ?? -1,
      stdout: String(result.stdout ?? '').trim().slice(0, 200),
      stderr: String(result.stderr ?? '').trim().slice(0, 200),
    }
  } finally {
    rmSync(probeRoot, { recursive: true, force: true })
  }
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/**
 * The version the fact recorded for one declared file, `'absent'` when it
 * recorded an observed absence, or `undefined` when the fact carries no
 * witness for that file at all — the distinction the missing-evidence
 * scenario turns on.
 */
function witnessVersion(fact: any, path: string): string | undefined {
  for (const witness of fact.evidence) {
    if (witness.role !== 'precondition' || witness.kind !== 'file-state' || witness.path !== path) continue
    return witness.observed === 'present' ? witness.version : 'absent'
  }
  return undefined
}

/** Read facts without letting a concurrent invalidation pass fail the trial. */
async function queryFactsSafely(store: any): Promise<any[]> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await store.queryFacts()
    } catch (caught) {
      if (attempt >= 3) throw caught
      await new Promise(resolveAfter => setTimeout(resolveAfter, 25))
    }
  }
}

/**
 * Score one denial by what the command would have done at that moment, and by
 * whether the release predicate had what it needed. `WRONG-BLOCK` is the only
 * defect class: the plugin had a fresh, positively changed observation of a
 * declared dependency and denied anyway.
 */
function classifyDenial(input: {
  counterfactual: { exitCode: number }
  declaredObservation: { version: string; fresh: boolean } | null
  recordedWitnessVersion: string | undefined
  declaredFileChangedSinceFailure: boolean
}): string {
  if (input.counterfactual.exitCode !== 0) return 'correct-block'
  const observed = input.declaredObservation
  const recorded = input.recordedWitnessVersion
  const hasWitness = recorded !== undefined
  const predicateShouldFire = observed !== null && observed.fresh
    && hasWitness && String(observed.version) !== String(recorded)
  if (predicateShouldFire) return 'WRONG-BLOCK'
  if (input.declaredFileChangedSinceFailure && hasWitness) return 'conservative-block:expired-evidence'
  if (input.declaredFileChangedSinceFailure) return 'conservative-block:missing-evidence'
  return 'conservative-block:undeclared-dependency'
}

// --- one scenario at a time -------------------------------------------------

const results: object[] = []

for (const spec of scenarios) {
  const root = mkdtempSync(join(tmpdir(), 'negative-ledger-task-'))
  const configPath = join(root, 'build.json')
  const sourcePath = join(root, 'source.txt')
  const markerPath = join(root, 'runs.log')
  const buildPath = join(root, 'build.mjs')
  const notesPath = join(root, 'notes.txt')
  const hidden = spec.id === 'hidden-dependency'
  const declaredFile = 'build.json'
  const declaredPath = join(root, declaredFile)
  writeFileSync(configPath, JSON.stringify({ enabled: hidden }))
  writeFileSync(sourcePath, hidden ? 'BROKEN' : 'hello')
  writeFileSync(buildPath, BUILD_SCRIPT)
  // Nothing touches the declared file before the first build in any scenario,
  // so this is also its state at the moment of the first recorded failure.
  const declaredAtFailure = readText(declaredPath)

  const command = [process.execPath, buildPath].map(quote).join(' ')
  const buildArgs = { command, workdir: root, description: 'Build the local text artifact' }
  const config = {
    mode: 'block', dir: join(root, 'ledger'), commandRetryAfterMs: 600_000,
    commandEvidenceMaxAgeMs: 60_000,
    commandDependencies: [{ tool: 'bash', commandLine: command, cwd: root, files: [declaredPath] }],
    ...(spec.overrides ?? {}),
  }
  const evidenceMaxAgeMs = config.commandEvidenceMaxAgeMs

  /** Step labels by tool call id, so a decision can be named in the report. */
  const labelByCallId = new Map(spec.steps.map((step, index) => [`${spec.id}-${index}`, step.label]))

  const resolveArgs = (role: Role): object => {
    switch (role) {
      case 'read-declared': return { file_path: declaredPath }
      case 'build': return { ...buildArgs }
      // A semantically identical build behind a different command line: it is
      // not the rule's command line, so it is a control proving the fixture
      // itself is repaired while the exact retry is still denied.
      case 'build-control': return { ...buildArgs, command: `${command} # repaired-control` }
      case 'write-unrelated': return { file_path: notesPath, content: 'unrelated edit' }
      case 'repair-declared': return { file_path: declaredPath, content: '{"enabled":true}' }
      case 'repair-undeclared': return { file_path: sourcePath, content: 'hello' }
    }
  }

  const ctx = new Context()
  /** Independent oracle: every fs/observed event, timestamped by the harness. */
  const observations: Array<{ path: string; observation: any; at: number }> = []
  /** Per-attempt record, keyed by tool call id. */
  const attempts = new Map<string, any>()
  const bashOrder: string[] = []
  let reader: InstanceType<typeof SqliteLedgerStore> | undefined
  let error: unknown
  const start = Date.now()

  try {
    for (const name of ['llm', 'session', 'session-log-deepseek', 'system-prompt', 'tools', 'agent', 'session-projection', 'agent-loop', 'subprocess-local', 'shell-env', 'bash-local', 'fs-local', 'tool-fs', 'tool-bash']) {
      const mod = await host(name)
      await ctx.plugin(mod.default ?? mod, name === 'agent-loop' ? { agents: [] } : ['fs-local', 'bash-local'].includes(name) ? { cwd: root } : {})
    }
    ctx.on('fs/observed', (target, observation) => {
      observations.push({ path: target.displayPath, observation, at: Date.now() })
    })
    // Registered BEFORE the ledger plugin, so awaiting `next()` here returns
    // the plugin's final decision rather than the pre-plugin default.
    ctx.on('tools/pre-execute', async (exec, next) => {
      const decision = await next()
      const denied = decision?.kind === 'deny'
      const record: any = {
        callId: exec.callId ?? null, tool: exec.name, decidedAt: Date.now() - start,
        label: labelByCallId.get(String(exec.callId)) ?? null,
        decision: denied ? 'deny' : 'allow',
        denyReason: denied ? String(decision.reason).slice(0, 300) : undefined,
        filesAtDispatch: { config: readText(configPath), source: readText(sourcePath) },
      }
      // Whether the declared file had already changed when this decision was
      // made. Sampled here, not after the scenario: a later repair must not
      // retroactively relabel an earlier denial.
      record.declaredFileChangedSinceFailure = record.filesAtDispatch.config !== declaredAtFailure
      if (exec.name === 'bash') {
        bashOrder.push(exec.callId ?? 'anon')
        const latest = [...observations].reverse().find(entry => entry.path === declaredPath)
        record.declaredObservation = latest === undefined ? null : {
          version: latest.observation?.kind === 'present' ? latest.observation.version : 'absent',
          ageMs: Date.now() - latest.at,
          fresh: Date.now() - latest.at <= evidenceMaxAgeMs,
        }
        const fact = (await queryFactsSafely(reader)).find(entry => entry.fact.kind === 'command_failed')
        record.ledger = fact === undefined ? null : {
          status: fact.fact.status,
          recordedWitnessVersion: witnessVersion(fact.fact, declaredPath),
        }
        if (denied) {
          record.counterfactual = probeCommand((exec.arguments as any)?.command, root, ['build.mjs', 'build.json', 'source.txt'])
        }
      }
      attempts.set(String(exec.callId), record)
      return decision
    })
    ctx.on('tools/post-execute', async (exec, result, next) => {
      const downstream = await next()
      const record = attempts.get(String(exec.callId))
      if (record !== undefined) {
        record.exitCode = result.value?.exitCode ?? null
        record.resultError = result.isError ? String(result.error?.message ?? '').slice(0, 160) : undefined
      }
      return downstream
    })
    await ctx.plugin(ledgerPlugin, config)
    reader = new SqliteLedgerStore({ dir: config.dir })

    const adapter = new ScriptedAdapter([
      ...spec.steps.map((step, index) => toolCallResponse(`${spec.id}-${index}`, step.role.startsWith('read') ? 'read' : step.role.startsWith('write') || step.role.startsWith('repair') ? 'write' : 'bash', resolveArgs(step.role))),
      textResponse('DONE'),
    ])
    // The request index equals the index of the step it is about to issue, so
    // a delay placed here happens after the previous step settled.
    const delays = new Map<number, number>()
    spec.steps.forEach((step, index) => { if (step.beforeMs !== undefined) delays.set(index, step.beforeMs) })
    const stream = adapter.stream.bind(adapter)
    adapter.stream = async function* (options) {
      try {
        const delay = delays.get(this.requests.length)
        if (delay !== undefined) await new Promise(resolveAfter => setTimeout(resolveAfter, delay))
        yield* stream(options)
      } catch (caught) { error = caught; throw caught }
    }
    ctx.llm.registerAdapter(['mock'], adapter)
    const handle = await ctx.agents.create({
      sessionId: SessionId(spec.id), meta: { cwd: root },
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Repair and build the local text artifact.' }], source: { kind: 'user' },
    }))
    await handle.agent.whenIdle()
    if (error) throw error
    assert.equal(adapter.requests.length, spec.steps.length + 1)

    // --- observed vs. scripted intent --------------------------------------
    const bashSteps = spec.steps.filter(step => step.role === 'build' || step.role === 'build-control')
    const bashRecords = bashOrder.map(callId => attempts.get(callId))
    const observedOutcomes = bashRecords.map(record => record.decision === 'deny'
      ? 'deny'
      : record.exitCode === 0 ? 'ok' : 'fail')
    assert.deepEqual(observedOutcomes, bashSteps.map(step => step.expect),
      `${spec.id}: bash outcomes must match the scripted intent`)

    const executed = observedOutcomes.filter(outcome => outcome !== 'deny').length
    const deniedCount = observedOutcomes.filter(outcome => outcome === 'deny').length
    assert.equal(readFileSync(markerPath, 'utf8').trim().split('\n').length, executed,
      `${spec.id}: only allowed builds may append to the marker`)
    assert.equal(readFileSync(join(root, 'dist.txt'), 'utf8'), 'HELLO',
      `${spec.id}: an allowed build must have produced the artifact`)

    // --- per-attempt classification ----------------------------------------
    const classified: any[] = []
    for (const [index, record] of bashRecords.entries()) {
      if (record.decision !== 'deny') continue
      const classification = classifyDenial({
        counterfactual: record.counterfactual,
        declaredObservation: record.declaredObservation,
        recordedWitnessVersion: record.ledger?.recordedWitnessVersion,
        declaredFileChangedSinceFailure: record.declaredFileChangedSinceFailure,
      })
      classified.push({ index, label: bashSteps[index].label, classification, ...record })
    }
    assert.deepEqual(classified.map(entry => entry.classification), spec.expectDenials,
      `${spec.id}: denial classification must match the documented contract`)
    if (spec.expectDenyReasonFragments !== undefined) {
      for (const fragment of spec.expectDenyReasonFragments) {
        assert.ok(classified.some(entry => String(entry.denyReason).includes(fragment)),
          `${spec.id}: a deny reason must include "${fragment}" — got ${classified.map(entry => entry.denyReason).join(' | ')}`)
      }
    }

    // The plugin's counters must agree with the harness-derived counts.
    const counters = await reader.summarize()
    assert.deepEqual(counters, { factsHit: 1, duplicateFailuresObserved: 0, warningsEmitted: 0, callsDenied: deniedCount },
      `${spec.id}: ledger counters must match the harness-derived counts`)

    const commandFact = (await queryFactsSafely(reader)).find(entry => entry.fact.kind === 'command_failed')!.fact
    const preconditions = commandFact.evidence.filter(witness => witness.role === 'precondition')
    assert.equal(preconditions.length, spec.expectInitialPreconditions, `${spec.id}: recorded precondition witnesses`)
    assert.equal(commandFact.status, spec.expectFinalStatus, `${spec.id}: terminal fact status`)

    // Contract-violating denials: the plugin held fresh, positively changed
    // evidence for a DECLARED dependency and denied anyway. This is NOT the
    // same as "no denial was a false block for the task": a conservative block
    // below is still a call that would have succeeded.
    const contractViolatingDenials = classified.filter(entry => entry.classification === 'WRONG-BLOCK').length
    assert.equal(contractViolatingDenials, 0,
      `${spec.id}: no denial may violate the contract when scored at the moment it was made`)
    const denialsThatWouldHaveSucceeded = bashRecords
      .filter(record => record.decision === 'deny' && record.counterfactual?.exitCode === 0).length
    // A release the contract requires: a retry after a relevant change to the
    // DECLARED dependency, with a witness to compare against, must be allowed
    // and must succeed — with no extra tool call in between.
    const required = bashRecords.filter(record => record.label === 'retry-after-relevant-repair')
    assert.equal(required.length, spec.id === 'declared-repair' ? 1 : 0)
    assert.ok(required.every(record => record.decision !== 'deny' && record.exitCode === 0),
      `${spec.id}: the post-repair retry must run and succeed`)
    assert.ok(Date.now() - start < 60_000, `${spec.id}: no scenario may wait out the 600s retry TTL`)

    results.push({
      scenario: spec.id,
      intent: spec.intent,
      config: {
        mode: config.mode, commandRetryAfterMs: config.commandRetryAfterMs,
        commandEvidenceMaxAgeMs: evidenceMaxAgeMs, declaredFiles: [declaredFile],
      },
      metrics: {
        scriptedToolCalls: spec.steps.length,
        bashAttempts: bashSteps.length,
        executedBuilds: executed,
        deniedAttempts: deniedCount,
        contractViolatingDenials,
        conservativeBlocks: classified.filter(entry => entry.classification.startsWith('conservative')).length,
        correctBlocks: classified.filter(entry => entry.classification === 'correct-block').length,
        exactRetryResolvedBeforeTtl: commandFact.status === 'resolved',
        // Task-level false blocks: denied calls whose counterfactual probe
        // succeeded at the moment of the denial. Each one costs the operator a
        // wait, a re-observation, or a command-line change. A zero here would
        // be a much stronger claim than a zero contract-violation count, and
        // this suite does not make it.
        denialsThatWouldHaveSucceeded,
      },
      counters,
      fact: {
        status: commandFact.status,
        preconditionWitnesses: preconditions.length,
        recordedVersion: witnessVersion(commandFact, declaredPath) ?? null,
      },
      attempts: bashRecords.map((record, index) => ({
        step: bashSteps[index].label,
        decision: record.decision,
        exitCode: record.exitCode,
        denyReason: record.denyReason,
        // What the host delivered for the denied call at tools/post-execute:
        // true + the plugin's own prefix when the denial surfaced as an error.
        resultError: record.resultError ?? null,
        storeStatusAtDispatch: record.ledger?.status ?? null,
        recordedWitnessVersion: record.ledger?.recordedWitnessVersion ?? null,
        declaredObservation: record.declaredObservation,
        declaredFileChangedSinceFailure: record.declaredFileChangedSinceFailure,
        filesAtDispatch: record.filesAtDispatch,
        counterfactual: record.counterfactual ?? null,
        classification: classified.find(entry => entry.index === index)?.classification ?? null,
      })),
      elapsedMs: Date.now() - start,
    })
  } finally {
    await reader?.close()
    await ctx.fiber.dispose()
    rmSync(root, { recursive: true, force: true })
  }
}

console.log(JSON.stringify({
  label: 'deterministic real-host task trials; SCRIPTED decisions (no model, no network); real filesystem + real bash',
  node: process.version,
  assertions,
  contracts: {
    contractViolatingDenials: 'a denial the plugin had fresh, positively changed evidence for a declared dependency to avoid, judged at the moment it was made',
    conservativeBlocks: 'denials that keep the documented TTL fallback: the action would have succeeded, but no fresh relevant change was available to the release predicate',
    denialsThatWouldHaveSucceeded: 'denied calls whose counterfactual probe exited 0 at the moment of the denial — the task-level false-block count. It is NOT the same as contractViolatingDenials: a conservative block is still a call that would have worked.',
  },
  results,
}, null, 2))
