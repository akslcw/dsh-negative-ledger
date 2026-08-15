/**
 * DSH wiring layer: an asynchronous policy over the LedgerStore v3 seam plus
 * a structural `apply()` that a real DSH composition mounts.
 *
 * Verified DSH surfaces (unchanged from v0):
 * - `tools/pre-execute` decisions are `allow`/`deny`/`ask` — no context
 *   channel — so `block` mode denies there and advisory contexts attach on
 *   `tools/post-execute`.
 * - Non-zero bash/pwsh exits arrive as successful results with
 *   `value.exitCode`; missing-file reads fail with `FS_NOT_FOUND`.
 *
 * M3 semantics:
 * - `commitAttemptDecision` is the only decision entry; `allow` and
 *   `stale-allow` both map to `verify-retry` and compete for a lease.
 * - `block`: `in-progress` denies; `warn`: the call still runs and its
 *   result is observed, but only the lease holder settles.
 * - A non-holder can never `markResolved`/`recordFact` a leased fact — the
 *   store rejects it and the policy treats the rejection as observation.
 * - Revision conflicts re-read and re-decide (bounded); `unavailable` means
 *   warn-mode proceeds, block-mode denies fail-closed.
 *
 * @module dsh-negative-ledger/plugin
 */

import { randomUUID } from 'node:crypto'
import { mismatchedWitnessKinds, retryVerdict } from './pure.ts'
import { JsonlLedgerStore } from './store-jsonl.ts'
import { SqliteLedgerStore } from './store-sqlite.ts'
import type { AttemptDecisionResult, FactInput, LedgerStore, OperationMeta, SettleResult, StoreFact } from './store.ts'
import type { FactKind, NegativeFact, PreconditionEvidence, QueryVerdict } from './types.ts'

/** Structural slice of a DSH `ToolExecution` (verified against dsh-tools). */
export interface ExecLike {
  readonly name: string
  readonly arguments: unknown
  readonly callId?: string
  /** The calling agent; its session header carries the default cwd the bash tool derives workdir from. */
  readonly agent?: { readonly session?: { readonly header?: { readonly cwd?: string } } }
}

/** Structural slice of a DSH `ToolExecutionResult` (verified against dsh-tools). */
export interface ResultLike {
  readonly isError: boolean
  readonly value?: unknown
  readonly error?: { readonly message?: string; readonly info?: { readonly code?: string } }
}

/** Structural slice of a DSH `FsTarget` / `FsObservation` (verified against dsh-fs). */
export interface FsTargetLike {
  readonly displayPath: string
}

export type FsObservationLike =
  | { readonly kind: 'present'; readonly version: string }
  | { readonly kind: 'absent' }

/** Model-facing context message shape (a DSH `UserMessage` structurally). */
export interface ContextMessage {
  readonly content: Array<{ readonly type: 'text'; readonly text: string }>
  readonly source: {
    readonly kind: 'plugin'
    readonly plugin: 'negative-ledger'
    readonly form: 'notice'
    readonly summary: string
  }
}

export type PreExecuteOutcome = { kind: 'allow' } | { kind: 'deny'; reason: string }

export interface LedgerPolicyConfig {
  /** Enforcement mode. `off` disables interception and recording; default `warn`. */
  mode?: 'off' | 'warn' | 'block'
  /** Tracked tools whose failed runs are recorded as `command_failed`. Default `['bash', 'pwsh']`. */
  commandTools?: string[]
  /** Tracked tools whose `FS_NOT_FOUND` failures are recorded as `file_missing`. Default `['read']`. */
  readTools?: string[]
  /**
   * Retry TTL applied to auto-recorded command facts (default 300000 ms).
   * After it elapses the `after` condition yields `allow`, so `block` mode
   * cannot lock a command forever on transient failures.
   */
  commandRetryAfterMs?: number
  /** Verification lease TTL (default 60000 ms). */
  leaseTtlMs?: number
  /** Total budget for busy/conflict retries on decisions (default 2000 ms). */
  storeBusyDeadlineMs?: number
}

export interface PolicyCallbacks {
  /** Feed one `fs/observed` event in; drives precondition witnessing and invalidation. */
  observeFs(target: FsTargetLike, observation: FsObservationLike, actor?: unknown): Promise<void>
  /** Consult the ledger before dispatch; deny in `block` mode only. */
  preExecute(exec: ExecLike): Promise<PreExecuteOutcome | undefined>
  /** Record failures, resolve successes, settle leases, and attach contexts after dispatch. */
  postExecute(exec: ExecLike, result: ResultLike): Promise<ContextMessage[]>
  /** Await every queued background operation (invalidation passes); safe to call on shutdown. */
  drain(): Promise<void>
}

/** Strip control characters that could break message structure or hide content. */
function sanitize(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f]/g, ' ')
}

function argsOf(exec: ExecLike): Record<string, unknown> | null {
  if (exec.arguments === null || typeof exec.arguments !== 'object') return null
  return exec.arguments as Record<string, unknown>
}

function nowIso(): string {
  return new Date().toISOString()
}

/** One pending attempt resolved to the store's scope + scope-free fingerprint form. */
interface Attempt {
  kind: FactKind
  scope: string
  fingerprintJson: string
  preconditionNow: PreconditionEvidence[]
}

/** Lease bookkeeping keyed by the executing tool call. */
interface LeaseGrant {
  leaseId: string
  factId: string
  owner: string
  /** The fact was stale when the lease was granted (drives the withdrawal note). */
  staleAtGrant: boolean
}

export function createLedgerPolicy(store: LedgerStore, config: LedgerPolicyConfig = {}): PolicyCallbacks {
  const mode = config.mode ?? 'warn'
  if (mode !== 'off' && mode !== 'warn' && mode !== 'block') {
    throw new Error(`negative-ledger: invalid mode "${mode}" — expected off, warn, or block`)
  }
  const commandRetryAfterMs = config.commandRetryAfterMs ?? 300_000
  if (!Number.isInteger(commandRetryAfterMs) || commandRetryAfterMs < 1) {
    throw new Error(`negative-ledger: invalid commandRetryAfterMs ${commandRetryAfterMs} — must be an integer >= 1`)
  }
  const leaseTtlMs = config.leaseTtlMs ?? 60_000
  if (!Number.isInteger(leaseTtlMs) || leaseTtlMs < 1) {
    throw new Error(`negative-ledger: invalid leaseTtlMs ${leaseTtlMs} — must be an integer >= 1`)
  }
  const busyDeadlineMs = config.storeBusyDeadlineMs ?? 2000
  if (!Number.isInteger(busyDeadlineMs) || busyDeadlineMs < 1) {
    throw new Error(`negative-ledger: invalid storeBusyDeadlineMs ${busyDeadlineMs} — must be an integer >= 1`)
  }
  const commandTools = new Set(config.commandTools ?? ['bash', 'pwsh'])
  const readTools = new Set(config.readTools ?? ['read'])
  /** Latest `fs/observed` value per observation key (plugin-local cache). */
  const observed = new Map<string, FsObservationLike>()
  /** Model-supplied path → backend displayPath, from the actor correlation. */
  const displayByModel = new Map<string, string>()
  /** Active verification leases granted to THIS policy instance's calls. */
  const leases = new Map<string, LeaseGrant>()
  /** In-progress advisories for calls that lost the lease competition. */
  const inProgressNotes = new Map<string, { owner: string; expiresAt: string }>()
  /**
   * Controlled queue for background operations (fs/observed invalidation
   * passes). Every task chains onto the previous one, rejections are captured
   * so nothing can surface as an unhandled rejection, and `drain` flushes the
   * queue on shutdown so no invalidation is lost on exit.
   */
  let pending: Promise<void> = Promise.resolve()

  function enqueue(task: () => Promise<void>): Promise<void> {
    const run = pending.then(task)
    pending = run.catch(() => {})
    return run
  }

  function tracked(name: string): boolean {
    return commandTools.has(name) || readTools.has(name)
  }

  function callKey(exec: ExecLike): string {
    return exec.callId ?? `anon:${exec.name}`
  }

  function opMeta(exec: ExecLike): OperationMeta {
    return { operationId: randomUUID(), ...(exec.callId !== undefined ? { toolCallId: exec.callId } : {}) }
  }

  /** Session cwd of the execution that produced an observation, when known. */
  function actorCwd(actor: unknown): string | undefined {
    if (typeof actor !== 'object' || actor === null) return undefined
    const agent = (actor as { agent?: unknown }).agent
    if (typeof agent !== 'object' || agent === null) return undefined
    const session = (agent as { session?: unknown }).session
    if (typeof session !== 'object' || session === null) return undefined
    const header = (session as { header?: unknown }).header
    if (typeof header !== 'object' || header === null) return undefined
    const cwd = (header as { cwd?: unknown }).cwd
    return typeof cwd === 'string' ? cwd : undefined
  }

  /** The model-supplied path of the tool execution that produced an observation. */
  function actorModelPath(actor: unknown): string | undefined {
    if (typeof actor !== 'object' || actor === null) return undefined
    const rawArgs = (actor as { arguments?: unknown }).arguments
    if (rawArgs === null || typeof rawArgs !== 'object') return undefined
    const filePath = (rawArgs as Record<string, unknown>).file_path
    return typeof filePath === 'string' ? filePath : undefined
  }

  function actorCallId(actor: unknown): string | undefined {
    if (typeof actor !== 'object' || actor === null) return undefined
    const callId = (actor as { callId?: unknown }).callId
    return typeof callId === 'string' ? callId : undefined
  }

  /** Observation key that scopes a model path to its session cwd. */
  function scopedModelKey(cwd: string, path: string): string {
    return cwd === '' ? path : `${cwd}\u0000${path}`
  }

  /** Effective session cwd of an execution, mirroring the tools' default. */
  function execCwd(exec: ExecLike): string {
    const args = argsOf(exec)
    const workdir = args !== null && typeof args.workdir === 'string' ? args.workdir : undefined
    return workdir ?? exec.agent?.session?.header?.cwd ?? ''
  }

  /** All cached observations as precondition evidence for witness comparison. */
  function currentPreconditions(): PreconditionEvidence[] {
    const preconditions: PreconditionEvidence[] = []
    for (const [key, observation] of observed) {
      if (observation.kind === 'present') {
        preconditions.push({ role: 'precondition', kind: 'file-state', path: key, observed: 'present', version: observation.version })
      } else {
        preconditions.push({ role: 'precondition', kind: 'file-state', path: key, observed: 'absent' })
      }
    }
    return preconditions
  }

  function attemptFor(exec: ExecLike): Attempt | undefined {
    const args = argsOf(exec)
    if (args === null) return undefined
    if (commandTools.has(exec.name)) {
      if (typeof args.command !== 'string' || args.command === '') return undefined
      return {
        kind: 'command_failed',
        scope: execCwd(exec),
        fingerprintJson: JSON.stringify({ kind: 'command_failed', tool: exec.name, commandLine: args.command }),
        preconditionNow: currentPreconditions(),
      }
    }
    if (readTools.has(exec.name)) {
      if (typeof args.file_path !== 'string' || args.file_path === '') return undefined
      return {
        kind: 'file_missing',
        scope: execCwd(exec),
        fingerprintJson: JSON.stringify({ kind: 'file_missing', path: sanitize(args.file_path) }),
        preconditionNow: currentPreconditions(),
      }
    }
    return undefined
  }

  /** Detect the failure a settled call proves, if any, as a store FactInput. */
  function failureToRecord(exec: ExecLike, result: ResultLike): FactInput | undefined {
    const args = argsOf(exec)
    if (args === null) return undefined
    if (commandTools.has(exec.name)) {
      if (typeof args.command !== 'string' || args.command === '') return undefined
      if (result.isError) return undefined
      const value = (result.value ?? null) as Record<string, unknown> | null
      const exitCode = value?.exitCode
      if (typeof exitCode !== 'number' || exitCode === 0) return undefined
      const stderr = value?.stderr as { text?: unknown } | undefined
      const stderrText = sanitize(typeof stderr?.text === 'string' ? stderr.text : '').slice(0, 200)
      return {
        kind: 'command_failed',
        scope: execCwd(exec),
        fingerprint: JSON.stringify({ kind: 'command_failed', tool: exec.name, commandLine: args.command }),
        claim: `command exited ${exitCode} (${exec.name})`,
        evidence: [{ role: 'outcome', kind: 'command-exit', exitCode, stderrSignature: stderrText }],
        retryCondition: { type: 'after', at: new Date(Date.now() + commandRetryAfterMs).toISOString() },
      }
    }
    if (readTools.has(exec.name)) {
      if (typeof args.file_path !== 'string' || args.file_path === '') return undefined
      if (!result.isError || result.error?.info?.code !== 'FS_NOT_FOUND') return undefined
      const path = sanitize(args.file_path)
      const cwd = execCwd(exec)
      const witnessPaths = new Set([scopedModelKey(cwd, path)])
      const displayPath = displayByModel.get(path)
      if (displayPath !== undefined) witnessPaths.add(displayPath)
      return {
        kind: 'file_missing',
        scope: cwd,
        fingerprint: JSON.stringify({ kind: 'file_missing', path }),
        claim: `file does not exist: ${path}`,
        evidence: [
          { role: 'outcome', kind: 'error-code', code: 'FS_NOT_FOUND' },
          ...[...witnessPaths].map(witnessPath => ({
            role: 'precondition' as const,
            kind: 'file-state' as const,
            path: witnessPath,
            observed: 'absent' as const,
          })),
        ],
      }
    }
    return undefined
  }

  /** Whether a settled call proves the attempted action now succeeds. */
  function isSuccess(exec: ExecLike, result: ResultLike): boolean {
    if (result.isError) return false
    if (commandTools.has(exec.name)) {
      const value = (result.value ?? null) as Record<string, unknown> | null
      return typeof value?.exitCode === 'number' && value.exitCode === 0
    }
    return readTools.has(exec.name)
  }

  function verdictFor(fact: NegativeFact, preconditionNow: PreconditionEvidence[]): QueryVerdict {
    const stale = mismatchedWitnessKinds(fact, preconditionNow)
    if (stale.length > 0) return 'stale-allow'
    return retryVerdict(fact.retryCondition, nowIso())
  }

  /** Bounded conflict/busy retry: re-read, re-build, re-commit within the deadline. */
  async function commitWithRetry(
    attempt: Attempt,
    build: (entry: StoreFact) => Parameters<LedgerStore['commitAttemptDecision']>[0],
  ): Promise<AttemptDecisionResult> {
    const deadline = Date.now() + busyDeadlineMs
    let conflictRounds = 0
    for (;;) {
      const entry = await store.getFact(attempt.scope, attempt.kind, attempt.fingerprintJson)
      if (entry === undefined) return { kind: 'unavailable', reason: 'fact vanished before the decision committed' }
      try {
        const result = await store.commitAttemptDecision(build(entry))
        if (result.kind !== 'conflict') return result
        conflictRounds += 1
        if (conflictRounds >= 3) return { kind: 'unavailable', reason: 'fact revision kept changing' }
      } catch (error) {
        if (!/store-busy/.test(String(error))) throw error
        if (Date.now() >= deadline) return { kind: 'unavailable', reason: 'store busy past the deadline' }
      }
      await new Promise(resolve => setTimeout(resolve, 10 + Math.floor(Math.random() * 20)))
    }
  }

  /** Sanitized, length-capped preview of a command for model-facing text. */
  function commandPreview(fact: NegativeFact): string | undefined {
    if (fact.fingerprint.kind !== 'command_failed') return undefined
    const raw = sanitize(fact.fingerprint.commandLine)
    return raw.length <= 80 ? raw : `${raw.slice(0, 80)}…`
  }

  function message(text: string, summary: string): ContextMessage {
    return {
      content: [{ type: 'text', text }],
      source: { kind: 'plugin', plugin: 'negative-ledger', form: 'notice', summary },
    }
  }

  async function warnMessage(fact: NegativeFact): Promise<ContextMessage> {
    const stats = await store.summarize()
    const preview = commandPreview(fact)
    return message(
      'Negative-ledger: this exact action previously failed and its evidence is unchanged.\n'
      + `- claim: ${fact.claim}\n`
      + (preview !== undefined ? `- action preview: ${preview}\n` : '')
      + 'A retry will likely fail the same way; prefer a different approach.\n'
      + 'Ledger totals: '
      + `${stats.duplicateFailuresObserved} duplicate failure(s) observed, `
      + `${stats.warningsEmitted} warning(s) emitted, `
      + `${stats.callsDenied} call(s) denied.`,
      `${fact.kind} repeat`,
    )
  }

  function staleNote(fact: NegativeFact): ContextMessage {
    const preview = commandPreview(fact)
    return message(
      'Negative-ledger: a previous failure no longer applies because its evidence changed; a retry is allowed.\n'
      + `- claim: ${fact.claim}\n`
      + (preview !== undefined ? `- action preview: ${preview}\n` : ''),
      `${fact.kind} evidence changed`,
    )
  }

  function inProgressMessage(note: { owner: string; expiresAt: string }): ContextMessage {
    return message(
      `Negative-ledger: another agent is verifying this path (owner ${note.owner} until ${note.expiresAt}); wait for its result.`,
      'verification in progress',
    )
  }

  function denyReason(fact: NegativeFact, verdict: 'block' | 'warn'): string {
    const suffix = verdict === 'block' ? 'retry condition not met' : 'evidence unchanged'
    const preview = commandPreview(fact)
    return `blocked by negative-ledger (${fact.kind}): ${fact.claim}`
      + (preview !== undefined ? ` [${preview}]` : '')
      + ` — ${suffix}`
  }

  /** Pre-dispatch guard shared by both modes; only block mode denies. */
  async function guardAttempt(exec: ExecLike, attempt: Attempt): Promise<PreExecuteOutcome | undefined> {
    const entry = await store.getFact(attempt.scope, attempt.kind, attempt.fingerprintJson)
    if (entry === undefined) return undefined
    const verdict = verdictFor(entry.fact, attempt.preconditionNow)
    if (verdict === 'warn' || verdict === 'block') {
      if (mode !== 'block') return undefined
      const result = await commitWithRetry(attempt, current => ({
        factId: current.fact.id,
        expectedRevision: current.revision,
        decision: 'deny',
        meta: opMeta(exec),
      }))
      if (result.kind !== 'applied') {
        return { kind: 'deny', reason: 'blocked by negative-ledger: store unavailable (fail-closed)' }
      }
      return { kind: 'deny', reason: denyReason(entry.fact, verdict) }
    }
    // allow / stale-allow: both are verification retries and compete for the lease.
    if (verdict === 'stale-allow') {
      // Read-through invalidation: commit the staleness BEFORE the lease so
      // the lease binds the new revision and its settlement cannot race a
      // queued batch transition (v0's read-through semantic, transactional).
      try {
        await store.transitionFacts([{
          id: entry.fact.id,
          expectedRevision: entry.revision,
          transition: {
            kind: 'stale',
            at: nowIso(),
            staleWitnesses: mismatchedWitnessKinds(entry.fact, attempt.preconditionNow),
          },
        }], opMeta(exec))
      } catch (error) {
        // A queued invalidation pass already transitioned it, or the store is
        // busy — the re-read below handles both.
        if (!/revision conflict/.test(String(error)) && !/store-busy/.test(String(error))) throw error
      }
    }
    const leaseRequest = { leaseId: randomUUID(), owner: callKey(exec), ttlMs: leaseTtlMs }
    const result = await commitWithRetry(attempt, current => ({
      factId: current.fact.id,
      expectedRevision: current.revision,
      decision: 'verify-retry',
      meta: opMeta(exec),
      leaseRequest,
    }))
    if (result.kind === 'applied') {
      leases.set(callKey(exec), {
        leaseId: leaseRequest.leaseId,
        factId: entry.fact.id,
        owner: leaseRequest.owner,
        staleAtGrant: entry.fact.status === 'stale',
      })
      return undefined
    }
    if (result.kind === 'in-progress') {
      inProgressNotes.set(callKey(exec), { owner: result.owner, expiresAt: result.expiresAt })
      if (mode === 'block') {
        return { kind: 'deny', reason: `blocked by negative-ledger: verification retry already in progress by ${result.owner} (until ${result.expiresAt})` }
      }
      return undefined
    }
    if (mode === 'block') {
      return { kind: 'deny', reason: 'blocked by negative-ledger: store unavailable (fail-closed)' }
    }
    return undefined
  }

  return {
    async observeFs(target, observation, actor) {
      observed.set(target.displayPath, observation)
      const modelPath = actorModelPath(actor)
      if (modelPath !== undefined) {
        observed.set(scopedModelKey(actorCwd(actor) ?? '', modelPath), observation)
        displayByModel.set(modelPath, target.displayPath)
      }
      if (mode === 'off') return
      await enqueue(async () => {
        const entries = await store.queryFacts()
        const batch: Parameters<LedgerStore['transitionFacts']>[0] = []
        for (const entry of entries) {
          if (entry.fact.status !== 'active') continue
          const staleWitnesses = mismatchedWitnessKinds(entry.fact, currentPreconditions())
          if (staleWitnesses.length === 0) continue
          const via = actorCallId(actor)
          const transition = via === undefined
            ? { kind: 'stale' as const, at: nowIso(), staleWitnesses }
            : { kind: 'stale' as const, at: nowIso(), staleWitnesses, via }
          batch.push({ id: entry.fact.id, expectedRevision: entry.revision, transition })
        }
        if (batch.length > 0) {
          try {
            const via = actorCallId(actor)
            const meta: OperationMeta = { operationId: randomUUID() }
            if (via !== undefined) meta.toolCallId = via
            await store.transitionFacts(batch, meta)
          } catch (error) {
            // A concurrent writer changed a revision or holds the write lock:
            // the next observation pass will re-derive and invalidate.
            if (!/revision conflict/.test(String(error)) && !/store-busy/.test(String(error))) throw error
          }
        }
      })
    },

    async preExecute(exec) {
      if (mode === 'off' || !tracked(exec.name)) return undefined
      const attempt = attemptFor(exec)
      if (attempt === undefined) return undefined
      return guardAttempt(exec, attempt)
    },

    async postExecute(exec, result) {
      if (mode === 'off' || !tracked(exec.name)) return []
      // A call this policy denied pre-execution still flows through
      // post-execute as an isError result carrying our denial reason.
      if (result.isError && typeof result.error?.message === 'string'
        && result.error.message.startsWith('blocked by negative-ledger')) {
        return []
      }
      const attempt = attemptFor(exec)
      if (attempt === undefined) return []
      const contexts: ContextMessage[] = []
      const key = callKey(exec)
      // The in-progress advisory belongs to the call that LOST the lease
      // competition, which by definition has no lease — attach it on every
      // return path, not just the lease branch.
      const note = inProgressNotes.get(key)
      if (note !== undefined) inProgressNotes.delete(key)
      const lease = leases.get(key)
      if (lease !== undefined) {
        leases.delete(key)
        const meta = opMeta(exec)
        const settle = async (request: Parameters<LedgerStore['settleLease']>[0]): Promise<SettleResult> => {
          try {
            return await store.settleLease(request)
          } catch (error) {
            // Busy: the settlement is lost; the next verification pass
            // re-derives. Anything else is a real failure.
            if (!/store-busy/.test(String(error))) throw error
            return 'not-active'
          }
        }
        if (isSuccess(exec, result)) {
          const settled = await settle({ kind: 'succeeded', leaseId: lease.leaseId, owner: lease.owner, meta })
          if (settled === 'applied' && lease.staleAtGrant) {
            const entry = await store.getFact(attempt.scope, attempt.kind, attempt.fingerprintJson)
            if (entry !== undefined) contexts.push(staleNote(entry.fact))
          }
        } else {
          const failure = failureToRecord(exec, result)
          if (failure !== undefined) {
            await settle({ kind: 'failed', leaseId: lease.leaseId, owner: lease.owner, fact: failure, meta })
          } else {
            await settle({ kind: 'released', leaseId: lease.leaseId, owner: lease.owner, meta })
          }
        }
        if (note !== undefined) contexts.push(inProgressMessage(note))
        return contexts
      }
      // No-lease path: first failures, warn-verdict repeats, and non-holders.
      const entry = await store.getFact(attempt.scope, attempt.kind, attempt.fingerprintJson)
      const verdict = entry === undefined ? undefined : verdictFor(entry.fact, attempt.preconditionNow)
      if (isSuccess(exec, result)) {
        if (entry !== undefined && verdict === 'stale-allow') contexts.push(staleNote(entry.fact))
        // A fact under an active lease may only change through its holder's
        // settlement; a non-holder's success is observed, never applied.
        if (entry !== undefined && entry.lease === undefined && entry.fact.status !== 'resolved') {
          try {
            await store.transitionFacts([{
              id: entry.fact.id,
              expectedRevision: entry.revision,
              transition: {
                kind: 'resolved',
                at: nowIso(),
                ...(exec.callId !== undefined ? { via: exec.callId } : {}),
              },
            }], opMeta(exec))
          } catch (error) {
            // Busy/conflict: the success is observed, the resolution is lost;
            // a later pass re-derives. Anything else is a real failure.
            if (!/store-busy/.test(String(error)) && !/revision conflict/.test(String(error))) throw error
          }
        }
        if (note !== undefined) contexts.push(inProgressMessage(note))
        return contexts
      }
      if (entry !== undefined && (verdict === 'warn' || verdict === 'block')) {
        const decision = await commitWithRetry(attempt, current => ({
          factId: current.fact.id,
          expectedRevision: current.revision,
          decision: 'observe-warn',
          meta: opMeta(exec),
        }))
        if (decision.kind === 'applied') contexts.push(await warnMessage(entry.fact))
      } else if (entry !== undefined && verdict === 'stale-allow') {
        contexts.push(staleNote(entry.fact))
      }
      const failure = failureToRecord(exec, result)
      if (failure !== undefined) {
        try {
          await store.recordFact(failure, opMeta(exec))
        } catch (error) {
          // A concurrent lease holder owns this fact, or the store is busy:
          // this non-holder only observes.
          if (!/active verification lease/.test(String(error)) && !/store-busy/.test(String(error))) throw error
        }
      }
      if (note !== undefined) contexts.push(inProgressMessage(note))
      return contexts
    },

    async drain() {
      return pending
    },
  }
}

/** Structural slice of a DSH `PreToolDecision` / `PostToolDecision` (verified against dsh-tools). */
export type PreToolDecisionLike =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: string }
  | { kind: 'ask'; reason?: string }

export type PostDecisionLike =
  | { kind: 'accept'; content?: unknown[]; value?: unknown; additionalContexts?: ContextMessage[] }
  | { kind: 'block'; feedback: unknown[]; additionalContexts?: ContextMessage[] }

/** Structural slice of a DSH Cordis context (event shapes verified against dsh-tools / dsh-fs). */
export interface DshContextLike {
  /** Register an effect whose returned disposer runs on context disposal. */
  effect(callback: () => () => void): void
  on(
    event: 'tools/pre-execute',
    listener: (
      exec: ExecLike,
      next: () => Promise<PreToolDecisionLike>,
    ) => Promise<PreToolDecisionLike>,
  ): () => void
  on(
    event: 'tools/post-execute',
    listener: (
      exec: ExecLike,
      result: ResultLike,
      next: () => Promise<PostDecisionLike>,
    ) => Promise<PostDecisionLike>,
  ): () => void
  on(
    event: 'fs/observed',
    listener: (target: FsTargetLike, observation: FsObservationLike, actor: unknown) => void,
  ): () => void
}

export const name = 'negative-ledger'

/** The plugin reads only events and its store; no hard service dependency. */
export const inject: readonly string[] = []

/** Plugin config: policy knobs, the store backend, and the ledger directory. */
export interface Config extends LedgerPolicyConfig {
  /**
   * Store backend. Defaults to `sqlite` (the transactional release store);
   * `jsonl` is the explicit legacy single-process mode.
   */
  backend?: 'jsonl' | 'sqlite'
  /** Ledger directory (ledger.jsonl or ledger.db); default `.ledger` under the cwd. */
  dir?: string
}

/**
 * Mount the plugin on a DSH context. All registrations live on the plugin's
 * scoped fiber: the context effect drains the background invalidation queue
 * and closes the store on disposal (HMR-safe, no leaked handles).
 */
export function apply(ctx: DshContextLike, config: Config = {}): void {
  const backend = config.backend ?? 'sqlite'
  const store: LedgerStore = backend === 'sqlite'
    ? new SqliteLedgerStore(config.dir === undefined ? {} : { dir: config.dir })
    : new JsonlLedgerStore(config.dir === undefined ? {} : { dir: config.dir })
  const policy = createLedgerPolicy(store, config)

  ctx.effect(() => () => {
    void (async () => {
      try {
        await policy.drain()
      } catch {
        // captured: disposal is best-effort; nothing may surface late
      }
      try {
        await store.close()
      } catch {
        // captured: the process is going away
      }
    })()
  })

  ctx.on('tools/pre-execute', async (exec, next) => {
    const outcome = await policy.preExecute(exec)
    if (outcome?.kind === 'deny') return { kind: 'deny', reason: outcome.reason }
    return next()
  })

  ctx.on('tools/post-execute', async (exec, result, next) => {
    const downstream = await next()
    const contexts = await policy.postExecute(exec, result)
    if (contexts.length === 0) return downstream
    if (downstream.kind === 'block') {
      return {
        kind: 'block',
        feedback: downstream.feedback,
        additionalContexts: [...contexts, ...(downstream.additionalContexts ?? [])],
      }
    }
    return {
      ...downstream,
      additionalContexts: [...contexts, ...(downstream.additionalContexts ?? [])],
    }
  })

  ctx.on('fs/observed', (target, observation, actor) => {
    // fs/observed is a synchronous emit: the cache update is synchronous and
    // the batch invalidation rides a fire-and-forget promise.
    void policy.observeFs(target, observation, actor).catch(() => {})
  })
}
