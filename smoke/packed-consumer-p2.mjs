// P2 packed-consumer wiring smoke. Copied into the temp consumer by
// packed-consumer.mjs so its bare import resolves to the INSTALLED tarball,
// then driven from there — nothing here reaches into repo sources.
//
// It exercises the public `apply` entry (not `createLedgerPolicy`) through a
// minimal DSH context whose three listeners are the real ones the plugin
// registers, and it dispatches REAL local node probes, so every result the
// ledger sees is one a process actually produced:
//
// 1. observe the declared dependency as v1 (a not-ready config);
// 2. dispatch the declared command — the probe really exits 1 — and post the
//    non-zero result;
// 3. the same command is denied pre-dispatch and the probe does NOT run
//    (proved by a marker the probe appends to on every run);
// 4. rewrite the config + observe v2, which stales the fact through the real
//    fire-and-forget invalidation pass;
// 5. the same command is allowed, the probe really succeeds, the fact resolves;
// 6. an unrelated command is untouched by the rule and falls back to the TTL.
//
// Usage: node packed-consumer-p2.mjs <consumerDir> <ledgerDir> <workspace>
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply, SqliteLedgerStore } from '@akslcw/dsh-negative-ledger'

const [consumerDir, ledgerDir, workspace] = process.argv.slice(2)
if (consumerDir === undefined || ledgerDir === undefined || workspace === undefined) {
  throw new Error('usage: packed-consumer-p2.mjs <consumerDir> <ledgerDir> <workspace>')
}
const entry = fileURLToPath(import.meta.resolve('@akslcw/dsh-negative-ledger'))
assert.ok(!relative(consumerDir, entry).startsWith('..'),
  `this driver must import the packed install, resolved ${entry}`)

// --- real probe -------------------------------------------------------------

mkdirSync(workspace, { recursive: true })
const configPath = join(workspace, 'config.json')
const probePath = join(workspace, 'probe.mjs')
const markerA = join(workspace, 'runs-a.log')
const markerB = join(workspace, 'runs-b.log')
writeFileSync(probePath, [
  `import { appendFileSync, readFileSync } from 'node:fs'`,
  `const [configPath, markerPath, ...rest] = process.argv.slice(2)`,
  `appendFileSync(markerPath, 'run\\n')`,
  `if (rest.includes('--fail')) {`,
  `  process.stderr.write('probe: forced failure\\n')`,
  `  process.exit(2)`,
  `}`,
  `let ready = false`,
  `try { ready = JSON.parse(readFileSync(configPath, 'utf8')).ready === true } catch { ready = false }`,
  `if (!ready) { process.stderr.write('probe: config is not ready\\n'); process.exit(1) }`,
  `process.stdout.write('probe: config is ready\\n')`,
  '',
].join('\n'))

/** Every absolute path is quoted, so the command line is valid on both shells. */
const quoted = (...parts) => parts.map(part => `"${part}"`).join(' ')
const probeCommand = quoted(process.execPath, probePath, configPath, markerA)
const otherCommand = quoted(process.execPath, probePath, configPath, markerB, '--fail')
writeFileSync(configPath, JSON.stringify({ ready: false, version: 'v1' }))

function runProbe(args) {
  const finished = spawnSync(process.execPath, [probePath, ...args], { encoding: 'utf8' })
  if (finished.error !== undefined) throw finished.error
  return { status: finished.status, stderr: finished.stderr ?? '' }
}

const runs = marker => existsSync(marker) ? readFileSync(marker, 'utf8').trim().split('\n').length : 0
const result = (exitCode, stderr) => ({ isError: false, value: { exitCode, stderr: { text: stderr } } })

// --- minimal DSH context ----------------------------------------------------

const listeners = new Map([
  ['fs/observed', []],
  ['tools/pre-execute', []],
  ['tools/post-execute', []],
])
const disposers = []
const ctx = {
  effect(callback) {
    disposers.push(callback())
  },
  on(event, listener) {
    listeners.get(event).push(listener)
    return () => {}
  },
}
const emitFs = (displayPath, observation) => {
  for (const listener of listeners.get('fs/observed')) listener({ displayPath }, observation, undefined)
}
const pre = async exec => {
  const decisions = []
  for (const listener of listeners.get('tools/pre-execute')) {
    decisions.push(await listener(exec, async () => ({ kind: 'allow' })))
  }
  assert.equal(decisions.length, 1, 'apply must register exactly one pre-execute listener')
  return decisions[0]
}
const post = async (exec, settled) => {
  const decisions = []
  for (const listener of listeners.get('tools/post-execute')) {
    decisions.push(await listener(exec, settled, async () => ({ kind: 'accept' })))
  }
  assert.equal(decisions.length, 1, 'apply must register exactly one post-execute listener')
  return decisions[0]
}
const contextText = decision => JSON.stringify(decision.additionalContexts ?? [])
let serial = 0
/** One execution object per invocation: pre, the run, and post share its identity. */
const call = command => ({
  name: 'bash',
  arguments: { command, workdir: workspace },
  agent: { session: { header: { cwd: workspace } } },
  callId: `consumer-${++serial}`,
})

apply(ctx, {
  mode: 'block',
  backend: 'sqlite',
  dir: ledgerDir,
  commandRetryAfterMs: 600_000,
  commandDependencies: [{ tool: 'bash', commandLine: probeCommand, cwd: workspace, files: [configPath] }],
})
assert.equal(listeners.get('fs/observed').length, 1, 'apply must register one fs/observed listener')
assert.equal(disposers.length, 1, 'apply must register its drain/close effect')

// --- ledger reads (a second WAL connection; closed before exit) -------------

const store = new SqliteLedgerStore({ dir: ledgerDir })
const factsByCommand = async command => {
  const entries = await store.queryFacts()
  return entries.filter(entry => entry.fact.fingerprint.kind === 'command_failed'
    && entry.fact.fingerprint.commandLine === command)
}
const waitFor = async (predicate, label, deadlineMs = 10_000) => {
  const until = Date.now() + deadlineMs
  for (;;) {
    const value = await predicate()
    if (value !== undefined && value !== false) return value
    if (Date.now() > until) throw new Error(`timed out waiting for ${label}`)
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}
const waitForStatus = (command, status) =>
  waitFor(async () => (await factsByCommand(command))[0]?.fact.status === status, `${command} -> ${status}`)

// --- 1. observe the declared dependency as v1 -------------------------------

emitFs(configPath, { kind: 'present', version: 'v1' })

// --- 2. a real failing run of the declared command --------------------------

const first = call(probeCommand)
assert.equal((await pre(first)).kind, 'allow', 'the first attempt must not be denied')
const failed = runProbe([configPath, markerA])
assert.equal(failed.status, 1, 'the probe must really fail on a not-ready config')
const firstDecision = await post(first, result(failed.status, failed.stderr))
assert.equal(runs(markerA), 1, 'the probe must have run exactly once')
assert.deepEqual(firstDecision.additionalContexts ?? [], [], 'the first failure must stay silent')
const recorded = (await factsByCommand(probeCommand))[0]
assert.ok(recorded !== undefined, 'the failure must be recorded')
assert.equal(recorded.fact.status, 'active')
const dependency = recorded.fact.evidence.find(witness =>
  witness.role === 'precondition' && witness.kind === 'file-state' && witness.path === configPath)
assert.deepEqual(dependency, { role: 'precondition', kind: 'file-state', path: configPath, observed: 'present', version: 'v1' },
  'the declared dependency must be frozen from the pre-dispatch observation')

// --- 3. the same command is denied, and the probe does not run --------------

const denied = await pre(call(probeCommand))
assert.equal(denied.kind, 'deny', 'an unchanged dependency must keep the command blocked')
assert.match(denied.reason, /Observed preconditions still match/)
assert.match(denied.reason, /Retry cooldown until/)
assert.equal(runs(markerA), 1, 'a denied command must never reach the probe')

// --- 4. write the config and observe v2 -------------------------------------

writeFileSync(configPath, JSON.stringify({ ready: true, version: 'v2' }))
emitFs(configPath, { kind: 'present', version: 'v2' })
await waitForStatus(probeCommand, 'stale')

// --- 5. the same command is allowed and succeeds ----------------------------

const retry = call(probeCommand)
const retryDecision = await pre(retry)
assert.equal(retryDecision.kind, 'allow', 'a changed dependency must release the command')
const succeeded = runProbe([configPath, markerA])
assert.equal(succeeded.status, 0, 'the probe must really succeed on a ready config')
const retryPost = await post(retry, result(succeeded.status, succeeded.stderr))
assert.equal(runs(markerA), 2)
assert.equal((await factsByCommand(probeCommand))[0].fact.status, 'resolved', 'success must resolve the fact')
assert.match(contextText(retryPost), /allow/i, 'the withdrawal note must reach the model')

// --- 6. an unrelated command is untouched and falls back to the TTL ---------

const other = call(otherCommand)
assert.equal((await pre(other)).kind, 'allow', 'a command with no matching rule must not be denied')
const otherFailed = runProbe([configPath, markerB, '--fail'])
assert.equal(otherFailed.status, 2)
await post(other, result(otherFailed.status, otherFailed.stderr))
const otherFact = (await factsByCommand(otherCommand))[0]?.fact
assert.ok(otherFact !== undefined, 'the unrelated failure must be recorded')
assert.equal(otherFact.status, 'active')
assert.deepEqual(otherFact.evidence.filter(witness => witness.role === 'precondition'), [],
  'without a rule there is no dependency evidence')
const otherDenied = await pre(call(otherCommand))
assert.equal(otherDenied.kind, 'deny', 'the TTL alone must keep it blocked')
assert.match(otherDenied.reason, /No precondition evidence was recorded/)
// A change to the rule's file belongs to the declared command only.
writeFileSync(configPath, JSON.stringify({ ready: true, version: 'v3' }))
emitFs(configPath, { kind: 'present', version: 'v3' })
await new Promise(resolve => setTimeout(resolve, 50))
assert.equal((await pre(call(otherCommand))).kind, 'deny', 'the rule must not release an unrelated command')

// --- cleanup: drain and close through the registered effect -----------------

await store.close()
for (const dispose of disposers) dispose()
await waitFor(() => !existsSync(`${join(ledgerDir, 'ledger.db')}-wal`), 'the plugin store to close')
const summary = await (async () => {
  const reader = new SqliteLedgerStore({ dir: ledgerDir })
  const totals = await reader.summarize()
  await reader.close()
  return totals
})()
// Three pre-dispatch denials: the blocked retry, and the two TTL-only denials
// of the unrelated command. Both facts were hit; none was a duplicate.
assert.deepEqual(summary, { factsHit: 2, duplicateFailuresObserved: 0, warningsEmitted: 0, callsDenied: 3 })

console.log('consumer P2 wiring ok')
console.log(`  - apply registered fs/observed + pre/post-execute on the packed artifact`)
console.log(`  - the denied command never reached the probe (marker: ${runs(markerA)} runs = one failure, one success)`)
console.log(`  - dependency change resolved the fact; unrelated command kept its TTL block`)
console.log(`  - drain/close effect released the sqlite handle`)
