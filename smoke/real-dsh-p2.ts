// Keyless real DSH host smoke. Pass the installed DSH node_modules directory.
import strictAssert from 'node:assert/strict'
let assertions = 0
const assert = new Proxy(strictAssert, { get(target, key) {
  const value = Reflect.get(target, key)
  return typeof value === 'function' ? (...args) => { assertions++; return value(...args) } : value
} })
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as ledgerPlugin from '../src/index.ts'
const { SqliteLedgerStore } = ledgerPlugin
const modules = resolve(process.argv[2] ?? 'node_modules')
const host = name => import(pathToFileURL(join(modules, '@deepseek-ai', `dsh-${name}`, 'lib/index.js')).href)
const { Context } = await import(pathToFileURL(join(modules, '@deepseek-ai/cordis/lib/index.js')).href)
const { default: LocalFileSystem } = await host('fs-local')
const ToolFs = await host('tool-fs')
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

function requestText(options: GenerateOptions): string {
  return options.messages.map(message =>
    message.content.map(block => (block.type === 'text' ? block.text : '')).join('\n')).join('\n')
}

// --- the smoke --------------------------------------------------------------

const home = mkdtempSync(join(tmpdir(), 'negledger-smoke-home-'))
const workspace = mkdtempSync(join(tmpdir(), 'negledger-smoke-workspace-'))
const ledgerDir = join(home, 'ledger')

const adapter = new ScriptedAdapter([
  toolCallResponse('r1', 'read', { file_path: 'missing.txt' }),
  toolCallResponse('r2', 'read', { file_path: 'missing.txt' }),
  toolCallResponse('w1', 'write', { file_path: 'missing.txt', content: 'created by the smoke test' }),
  toolCallResponse('r3', 'read', { file_path: 'missing.txt' }),
  textResponse('SMOKE_DONE'),
])

const ctx = new Context()
try {
  for (const name of ['llm', 'session', 'session-log-deepseek', 'system-prompt', 'tools', 'agent', 'session-projection', 'agent-loop']) {
    const mod = await host(name)
    await ctx.plugin(mod.default ?? mod, name === 'agent-loop' ? { agents: [] } : {})
  }
  await ctx.plugin(LocalFileSystem, { cwd: workspace })
  await ctx.plugin(ToolFs)
  await ctx.plugin(ledgerPlugin, { mode: 'warn', dir: ledgerDir })
  ctx.llm.registerAdapter(['mock'], adapter)
  const handle = await ctx.agents.create({
    sessionId: SessionId('negledger-smoke-session'),
    meta: { cwd: workspace },
    agentOptions: { provider: 'mock', model: 'mock' },
  })

  handle.agent.followup(createUserMessage({
    content: [{ type: 'text', text: 'Read missing.txt twice, create it, then read it again.' }],
    source: { kind: 'user' },
  }))
  await handle.agent.whenIdle()

  // The model drove five requests; the second read's warning and the
  // successful read's withdrawal note must be model-visible.
  assert.equal(adapter.requests.length, 5, `expected 5 model requests, got ${adapter.requests.length}`)
  assert.ok(!requestText(adapter.requests[1]!).includes('Negative-ledger'),
    'first failure must not inject a warning')
  assert.ok(requestText(adapter.requests[2]!).includes('Negative-ledger'),
    'second repeat must warn the model')
  assert.ok(requestText(adapter.requests[2]!).includes('file does not exist: missing.txt'),
    'warning must carry the claim')
  assert.ok(requestText(adapter.requests[2]!).includes('Advisory only; this call was not blocked'),
    'warning must describe its advisory status')
  assert.ok(!requestText(adapter.requests[2]!).includes('Ledger totals:'),
    'cumulative counters belong in stats, not model context')
  assert.ok(requestText(adapter.requests[4]!).includes('verification is allowed'),
    'evidence change must withdraw the warning and allow the retry')

  // The ledger (default sqlite backend) must hold one logical fact, resolved
  // by the successful retry, with the audit transition and honest counters.
  const store = new SqliteLedgerStore({ dir: ledgerDir })
  const facts = (await store.queryFacts()).map(entry => entry.fact)
  assert.equal(facts.length, 1, `expected 1 fact, got ${facts.length}`)
  assert.equal(facts[0]?.kind, 'file_missing')
  assert.equal(facts[0]?.status, 'resolved')
  assert.equal(facts[0]?.lastTransition?.kind, 'resolved')
  const summary = await store.summarize()
  await store.close()
  assert.deepEqual(summary, {
    factsHit: 1,
    duplicateFailuresObserved: 1,
    warningsEmitted: 1,
    callsDenied: 0,
  })

  console.log('REAL-MOUNT SMOKE PASSED')
  console.log('  - plugin row mounted on the real agent spine')
  console.log('  - repeated failing read warned the model (additionalContexts visible in request 3)')
  console.log('  - write-driven fs/observed invalidated the fact (displayPath correlation)')
  console.log('  - successful retry resolved the fact with an audit transition')
  console.log('  - honest counters: 1 duplicate failure observed, 1 warning emitted, 0 calls denied')
} finally {
  await ctx.fiber.dispose().catch(() => {})
  rmSync(home, { recursive: true, force: true })
  rmSync(workspace, { recursive: true, force: true })
}

// P2 uses a separate actual host and ledger so its counters are independent.
const { writeFileSync, readFileSync, existsSync } = await import('node:fs')
const p2root = mkdtempSync(join(tmpdir(), 'negledger-real-p2-'))
const dependencyPath = join(p2root, 'config.json')
const marker = join(p2root, 'runs.log')
const probe = join(p2root, 'probe.mjs')
writeFileSync(dependencyPath, '{"ready":false,"version":"v1"}')
writeFileSync(probe, `import { appendFileSync, readFileSync } from 'node:fs';
appendFileSync(process.argv[3], 'run\\n');
if (!JSON.parse(readFileSync(process.argv[2], 'utf8')).ready) {
  console.error('config is not ready'); process.exit(1);
}
console.log('config is ready');
`)
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'"
const command = [process.execPath, probe, dependencyPath, marker].map(quote).join(' ')
const bashArgs = { command, workdir: p2root, description: 'Check whether the smoke configuration is ready' }
const runs = () => existsSync(marker) ? readFileSync(marker, 'utf8').trim().split('\n').length : 0
const p2ctx = new Context()
const observations: any[] = []
const settlements: any[] = []
let reader: InstanceType<typeof SqliteLedgerStore> | undefined
let initialFact: any
let stepError: unknown
const started = Date.now()
try {
  for (const name of ['llm', 'session', 'session-log-deepseek', 'system-prompt', 'tools', 'agent', 'session-projection', 'agent-loop', 'subprocess-local', 'shell-env', 'bash-local', 'fs-local', 'tool-fs', 'tool-bash']) {
    const mod = await host(name)
    await p2ctx.plugin(mod.default ?? mod, name === 'agent-loop' ? { agents: [] } : ['fs-local', 'bash-local'].includes(name) ? { cwd: p2root } : {})
  }
  p2ctx.on('fs/observed', (target, observation) => observations.push({ target, observation }))
  p2ctx.on('tools/post-execute', async (exec, result, next) => {
    settlements.push({ name: exec.name, result })
    return next()
  })
  await p2ctx.plugin(ledgerPlugin, {
    mode: 'block', dir: join(p2root, 'ledger'), commandRetryAfterMs: 600_000,
    commandDependencies: [{ tool: 'bash', commandLine: command, cwd: p2root, files: [dependencyPath] }],
  })
  reader = new SqliteLedgerStore({ dir: join(p2root, 'ledger') })
  const adapter2 = new ScriptedAdapter([
    toolCallResponse('dep-read', 'read', { file_path: dependencyPath }),
    toolCallResponse('probe-fail', 'bash', bashArgs),
    toolCallResponse('probe-denied', 'bash', bashArgs),
    toolCallResponse('dep-write', 'write', { file_path: dependencyPath, content: '{"ready":true,"version":"v2"}' }),
    toolCallResponse('probe-retry', 'bash', bashArgs),
    textResponse('P2_DONE'),
  ])
  const originalStream = adapter2.stream.bind(adapter2)
  adapter2.stream = async function* (options) {
    try {
    const index = this.requests.length
    if (index === 2) {
      assert.equal(runs(), 1, 'first real bash must execute once')
      initialFact = (await reader!.queryFacts())[0]?.fact
      assert.equal(initialFact?.kind, 'command_failed')
      assert.equal(initialFact?.status, 'active')
      const observed = observations.find(e => e.target.displayPath === dependencyPath && e.observation.kind === 'present')
      assert.ok(observed, 'actual read must emit present observation')
      assert.deepEqual(initialFact.evidence.find(e => e.role === 'precondition'), {
        role: 'precondition', kind: 'file-state', path: dependencyPath,
        observed: 'present', version: observed.observation.version,
      }, 'command evidence must freeze the real filesystem v1 version')
    }
    if (index === 3) {
      assert.equal(runs(), 1, 'denied command must not execute a second subprocess')
      assert.match(JSON.stringify(options.messages), /Observed preconditions still match/)
      assert.equal((await reader!.summarize()).callsDenied, 1)
    }
    if (index === 4) {
      const versions = observations.filter(e => e.target.displayPath === dependencyPath && e.observation.kind === 'present').map(e => e.observation.version)
      assert.ok(new Set(versions).size >= 2, 'actual write must emit a changed filesystem version')
      assert.ok(Date.now() - started < 600_000, 'retry occurs before TTL')
    }
    yield* originalStream(options)
    } catch (error) { stepError = error; throw error }
  }
  p2ctx.llm.registerAdapter(['mock'], adapter2)
  const handle = await p2ctx.agents.create({ sessionId: SessionId('negative-ledger-real-p2'), meta: { cwd: p2root }, agentOptions: { provider: 'mock', model: 'mock' } })
  handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Run the declared dependency probe scenario.' }], source: { kind: 'user' } }))
  await handle.agent.whenIdle()
  if (stepError) throw stepError
  assert.equal(adapter2.requests.length, 6)
  const bashResults = settlements.filter(e => e.name === 'bash').map(e => e.result)
  assert.equal(bashResults[0]?.value?.exitCode, 1)
  assert.equal(bashResults[1]?.isError, true)
  assert.equal(bashResults[2]?.value?.exitCode, 0)
  assert.equal(runs(), 2, 'exactly one failed and one successful real bash process')
  const facts = (await reader.queryFacts()).map(e => e.fact)
  assert.equal(facts.length, 1)
  assert.equal(facts[0].status, 'resolved')
  assert.equal(facts[0].lastTransition?.kind, 'resolved')
  assert.deepEqual(await reader.summarize(), { factsHit: 1, duplicateFailuresObserved: 0, warningsEmitted: 0, callsDenied: 1 })
  assert.match(requestText(adapter2.requests[5]), /verification is allowed/)
  console.log('REAL DSH P2 PASSED: actual read/write observations; dependency version changed; marker 1 after denial, 2 after retry; resolved before 600000ms TTL')
  console.log('P2 counters: factsHit=1 duplicateFailuresObserved=0 warningsEmitted=0 callsDenied=1')
} finally {
  await reader?.close()
  await p2ctx.fiber.dispose()
  rmSync(p2root, { recursive: true, force: true })
}

const versions = Object.fromEntries(['dsh-agent', 'dsh-agent-loop', 'dsh-tools', 'dsh-fs', 'dsh-fs-local', 'dsh-tool-fs', 'dsh-tool-bash', 'dsh-bash-local', 'dsh-subprocess-local', 'cordis'].map(name => [name, JSON.parse(readFileSync(join(modules, '@deepseek-ai', name, 'package.json'), 'utf8')).version]))
console.log(JSON.stringify({ node: process.version, versions, assertions, status: 'passed' }))
