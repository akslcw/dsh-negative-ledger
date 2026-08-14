/**
 * Real-mount smoke test: boots the real DSH agent spine (session log, tool
 * registry, agent loop) with the real filesystem provider and the read/write
 * tools, mounts the ledger plugin, and drives a scripted model through the
 * missing-file scenario. It proves, against the assembled product:
 *
 * 1. the plugin row loads and its listeners fire on the real tool pipeline;
 * 2. a repeated failing read injects `additionalContexts` that reach the
 *    model's next request (the "warn" path);
 * 3. a write's `fs/observed` (resolved displayPath) invalidates the fact,
 *    the retry succeeds, the reminder is withdrawn, and the fact resolves.
 *
 * Run: node smoke/real-mount.ts (keyless; no model API, no subprocess).
 * This file is harness-checkout-bound: it imports the repo's built libs by
 * relative path and is verified at runtime, not by the standalone typecheck.
 * @module dsh-negative-ledger/smoke/real-mount
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '../../vendor/cordis/lib/index.js'
import * as spine from '../../packages/examples/agent-spine-demo/lib/index.js'
import LocalFileSystem from '../../packages/fs/fs-local/lib/index.js'
import * as ToolFs from '../../packages/fs/tool-fs/lib/index.js'
import { CallId, createUserMessage, LlmAdapter } from '../../packages/llm/llm/lib/index.js'
import { SessionId } from '../../packages/core/session/lib/index.js'
import * as ledgerPlugin from '../src/plugin.ts'
import { SqliteLedgerStore } from '../src/store-sqlite.ts'

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
  const callId = CallId(rawCallId)
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
process.env.DSH_HOME = home
process.env.DSH_AGENTS_HOME = home

const adapter = new ScriptedAdapter([
  toolCallResponse('r1', 'read', { file_path: 'missing.txt' }),
  toolCallResponse('r2', 'read', { file_path: 'missing.txt' }),
  toolCallResponse('w1', 'write', { file_path: 'missing.txt', content: 'created by the smoke test' }),
  toolCallResponse('r3', 'read', { file_path: 'missing.txt' }),
  textResponse('SMOKE_DONE'),
])

const ctx = new Context()
try {
  await ctx.plugin(spine, {
    agents: [],
    workspaceContext: false,
    skills: { enabled: false },
    toolBash: false,
    toolJobs: false,
    goals: false,
    dshHome: home,
  })
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
  assert.ok(requestText(adapter.requests[2]!).includes('1 duplicate failure(s) observed'),
    'warning must carry the honest counters line')
  assert.ok(requestText(adapter.requests[4]!).includes('retry is allowed'),
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
  delete process.env.DSH_HOME
  delete process.env.DSH_AGENTS_HOME
}
