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
 * P2 command dependencies (declared, never inferred):
 * - A `commandDependencies` rule matches an invocation only when the tool, the
 *   command line verbatim, and the effective cwd all match exactly. Its `files`
 *   are absolute DSH displayPaths; the plugin issues no extra filesystem reads
 *   and never derives shell dependencies from the command text.
 * - `preExecute` freezes the newest FRESH observation of every declared file
 *   (present version or absent) for that call. If any declared file is unknown
 *   or older than `commandEvidenceMaxAgeMs`, the whole snapshot is dropped and
 *   the failure keeps its outcome + TTL evidence only.
 * - `postExecute` never backfills from observations taken after dispatch, and
 *   a call that never passed pre-execution records no command precondition.
 * - A call is identified by its session object plus its tool call id. Real
 *   harnesses issue globally unique ids, so this is belt and braces; the store
 *   additionally treats a repeated id as an idempotent replay, which is why a
 *   reused id never rewrites the earlier fact. Without a session object a call
 *   is identified by its execution object, so two concurrent anonymous
 *   invocations of one command cannot swap evidence — and a harness that
 *   passes a different object to post-execute degrades to outcome + TTL.
 *   Leases and advisory notes key on the same identity.
 * - Command queries compare against fresh observations only; an expired one is
 *   unknown, which keeps the TTL verdict instead of allowing an early retry.
 *   The fingerprint is untouched — dependencies live in the evidence.
 *
 * @module dsh-negative-ledger/plugin
 */

import { randomUUID } from 'node:crypto'
import { posix, win32 } from 'node:path'
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

/**
 * Declared file dependencies of one exact command invocation. The rule is a
 * config-time statement of fact (the operator knows the command reads these
 * files); the plugin does not infer anything from the command text.
 */
export interface CommandDependency {
  /** Tool that runs the command, matched exactly (e.g. `bash`). */
  tool: string
  /** The command line as the model wrote it; matched verbatim, no trimming. */
  commandLine: string
  /** Effective cwd of the invocation (`workdir` argument or the session cwd). */
  cwd: string
  /**
   * Absolute DSH displayPaths whose observed state the outcome depends on.
   * Each must have a fresh `fs/observed` entry when the command starts, and
   * only that exact displayPath is ever used as evidence — never a relative
   * path alias from another project.
   */
  files: string[]
}

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
  /** Repeat warning interval per session/fact (default 60000 ms); 0 disables suppression. */
  warningRepeatAfterMs?: number
  /**
   * Declared file dependencies per exact command invocation. Absent means no
   * command ever carries precondition evidence (outcome + TTL only).
   */
  commandDependencies?: CommandDependency[]
  /**
   * Freshness window for `fs/observed` entries used as command evidence
   * (default 60000 ms). An older observation is treated as unknown: the fact
   * keeps its TTL verdict rather than being confirmed or withdrawn by stale
   * information.
   */
  commandEvidenceMaxAgeMs?: number
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

/**
 * Match key of one declared rule: tool, effective cwd, command line verbatim.
 * JSON encoding rather than a separator join, so no field content (a NUL or an
 * embedded quote in a command line) can forge a key that matches another rule.
 */
function dependencyKey(tool: string, cwd: string, commandLine: string): string {
  return JSON.stringify([tool, cwd, commandLine])
}

/**
 * Absolute-path test for DSH displayPaths. The platform modules do the work:
 * `win32.isAbsolute` covers drive-letter AND UNC (`\\server\share`) forms,
 * which a hand-rolled prefix check silently drops on the Windows benchmark
 * host, while `posix.isAbsolute` covers the POSIX forms.
 */
function isAbsoluteDisplayPath(path: string): boolean {
  return posix.isAbsolute(path) || win32.isAbsolute(path)
}

/**
 * Validate and deep-clone the declared rules into a lookup index. Cloning is
 * what keeps a caller from mutating the policy's matching rules after mount;
 * duplicate match keys are rejected rather than silently merged, because a
 * merged rule would widen a command's evidence without anyone deciding to.
 */
function parseCommandDependencies(raw: CommandDependency[] | undefined): Map<string, readonly string[]> {
  const index = new Map<string, readonly string[]>()
  if (raw === undefined) return index
  if (!Array.isArray(raw)) throw new Error('negative-ledger: invalid commandDependencies — expected an array of rules')
  for (const rule of raw as unknown[]) {
    if (rule === null || typeof rule !== 'object') {
      throw new Error('negative-ledger: invalid commandDependencies rule — expected an object')
    }
    const { tool, commandLine, cwd, files } = rule as Partial<CommandDependency>
    if (typeof tool !== 'string' || tool === '') {
      throw new Error('negative-ledger: invalid commandDependencies rule — tool must be a non-empty string')
    }
    if (typeof commandLine !== 'string' || commandLine === '') {
      throw new Error(`negative-ledger: invalid commandDependencies rule for ${tool} — commandLine must be a non-empty string`)
    }
    if (typeof cwd !== 'string' || cwd === '') {
      throw new Error(`negative-ledger: invalid commandDependencies rule for ${tool} — cwd must be a non-empty string`)
    }
    if (!Array.isArray(files) || files.length === 0) {
      throw new Error(`negative-ledger: invalid commandDependencies rule for ${tool} — files must be a non-empty array`)
    }
    const cloned: string[] = []
    for (const file of files as unknown[]) {
      if (typeof file !== 'string' || file === '') {
        throw new Error(`negative-ledger: invalid commandDependencies rule for ${tool} — every file must be a non-empty string`)
      }
      if (!isAbsoluteDisplayPath(file)) {
        throw new Error(`negative-ledger: commandDependencies files must be absolute displayPaths: ${file}`)
      }
      cloned.push(file)
    }
    const key = dependencyKey(tool, cwd, commandLine)
    if (index.has(key)) {
      throw new Error(`negative-ledger: duplicate commandDependencies rule for ${tool} in ${cwd}`)
    }
    index.set(key, Object.freeze(cloned))
  }
  return index
}

/** One pending attempt resolved to the store's scope + scope-free fingerprint form. */
interface Attempt {
  kind: FactKind
  scope: string
  fingerprintJson: string
  preconditionNow: PreconditionEvidence[]
}

/**
 * Declared dependencies of one command, frozen before dispatch. The identity
 * fields are re-checked when the snapshot is consumed so a shared anonymous
 * call key can never attach one invocation's evidence to another's.
 */
interface DependencySnapshot {
  tool: string
  commandLine: string
  cwd: string
  witnesses: PreconditionEvidence[]
}

/** Lease bookkeeping keyed by the executing tool call. */
interface LeaseGrant {
  leaseId: string
  factId: string
  owner: string
  /**
   * The lease was granted on changed evidence (a stale-allow verdict, or an
   * already-stale fact), so settling it successfully emits the withdrawal note.
   */
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
  const warningRepeatAfterMs = config.warningRepeatAfterMs ?? 60_000
  if (!Number.isInteger(warningRepeatAfterMs) || warningRepeatAfterMs < 0) {
    throw new Error(`negative-ledger: invalid warningRepeatAfterMs ${warningRepeatAfterMs} — must be an integer >= 0`)
  }
  const leaseTtlMs = config.leaseTtlMs ?? 60_000
  if (!Number.isInteger(leaseTtlMs) || leaseTtlMs < 1) {
    throw new Error(`negative-ledger: invalid leaseTtlMs ${leaseTtlMs} — must be an integer >= 1`)
  }
  const busyDeadlineMs = config.storeBusyDeadlineMs ?? 2000
  if (!Number.isInteger(busyDeadlineMs) || busyDeadlineMs < 1) {
    throw new Error(`negative-ledger: invalid storeBusyDeadlineMs ${busyDeadlineMs} — must be an integer >= 1`)
  }
  const commandEvidenceMaxAgeMs = config.commandEvidenceMaxAgeMs ?? 60_000
  if (!Number.isInteger(commandEvidenceMaxAgeMs) || commandEvidenceMaxAgeMs < 1) {
    throw new Error(`negative-ledger: invalid commandEvidenceMaxAgeMs ${commandEvidenceMaxAgeMs} — must be an integer >= 1`)
  }
  const commandDependencyIndex = parseCommandDependencies(config.commandDependencies)
  const commandTools = new Set(config.commandTools ?? ['bash', 'pwsh'])
  const readTools = new Set(config.readTools ?? ['read'])
  /** Latest `fs/observed` value per observation key, with its receipt time (freshness). */
  const observed = new Map<string, { observation: FsObservationLike; at: number }>()
  /** Model-supplied path → backend displayPath, from the actor correlation. */
  const displayByModel = new Map<string, string>()
  /** Active verification leases granted to THIS policy instance's calls. */
  const leases = new Map<string, LeaseGrant>()
  /** In-progress advisories for calls that lost the lease competition. */
  const inProgressNotes = new Map<string, { owner: string; expiresAt: string }>()
  /**
   * Pre-dispatch dependency snapshots (see {@link DependencySnapshot}), keyed
   * by SESSION OBJECT and then by call identity. A tool call id is only unique
   * within the session that issued it, so the session must be part of the key:
   * two sessions reusing one id for the same command would otherwise swap
   * evidence. Only `freezeCommandDependencies` writes here, which is what makes
   * post-execution backfill structurally impossible.
   */
  const sessionDependencySnapshots = new WeakMap<object, Map<string, DependencySnapshot>>()
  /**
   * Snapshots of calls that carry no session object, keyed by execution object
   * identity. A harness that hands post-execute a different object finds
   * nothing and safely degrades to outcome + TTL.
   */
  const anonymousDependencySnapshots = new WeakMap<object, DependencySnapshot>()
  // Session objects are runtime identities, not persisted facts. Anonymous callers
  // share a policy-local bucket. Bound each bucket; eviction only adds a warning.
  type WarningStamp = { signature: string; at: number; settled: Promise<void> }
  const sessionWarnings = new WeakMap<object, Map<string, WarningStamp>>()
  const anonymousWarnings = new Map<string, WarningStamp>()
  function warningBucket(exec: ExecLike): Map<string, WarningStamp> {
    const owner = exec.agent?.session ?? exec.agent
    if (owner === undefined) return anonymousWarnings
    let bucket = sessionWarnings.get(owner)
    if (bucket === undefined) { bucket = new Map(); sessionWarnings.set(owner, bucket) }
    return bucket
  }

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

  /**
   * Per-execution identity for lease and advisory bookkeeping. A call with a
   * tool call id keeps using it — that is the value the store records as the
   * lease owner. A call WITHOUT one is identified by its execution object:
   * keying those by tool name would let two concurrent anonymous commands share
   * one entry, so one call's settlement would resolve the other's fact.
   */
  const anonymousCallKeys = new WeakMap<object, string>()
  function callKey(exec: ExecLike): string {
    if (exec.callId !== undefined) return exec.callId
    let key = anonymousCallKeys.get(exec)
    if (key === undefined) { key = `anon:${randomUUID()}`; anonymousCallKeys.set(exec, key) }
    return key
  }

  /** The session-scoped snapshot bucket of a call, or undefined without a session. */
  function dependencyBucket(exec: ExecLike): Map<string, DependencySnapshot> | undefined {
    const owner = exec.agent?.session ?? exec.agent
    if (owner === undefined) return undefined
    let bucket = sessionDependencySnapshots.get(owner)
    if (bucket === undefined) { bucket = new Map(); sessionDependencySnapshots.set(owner, bucket) }
    return bucket
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

  /**
   * Cached observations as precondition evidence for witness comparison. With
   * `maxAgeMs` the set is restricted to fresh entries: an expired observation
   * is unknown, so it neither confirms nor withdraws a fact.
   */
  function currentPreconditions(maxAgeMs?: number): PreconditionEvidence[] {
    const cutoff = maxAgeMs === undefined ? undefined : Date.now() - maxAgeMs
    const preconditions: PreconditionEvidence[] = []
    for (const [key, cached] of observed) {
      if (cutoff !== undefined && cached.at < cutoff) continue
      preconditions.push(cached.observation.kind === 'present'
        ? { role: 'precondition', kind: 'file-state', path: key, observed: 'present', version: cached.observation.version }
        : { role: 'precondition', kind: 'file-state', path: key, observed: 'absent' })
    }
    return preconditions
  }

  /** The newest fresh observation of one displayPath, if any. */
  function freshObservation(displayPath: string): FsObservationLike | undefined {
    const cached = observed.get(displayPath)
    if (cached === undefined) return undefined
    if (Date.now() - cached.at > commandEvidenceMaxAgeMs) return undefined
    return cached.observation
  }

  /** Declared dependency files for this invocation, or undefined when no rule matches. */
  function matchedDependencyFiles(exec: ExecLike): readonly string[] | undefined {
    if (!commandTools.has(exec.name)) return undefined
    const args = argsOf(exec)
    if (args === null || typeof args.command !== 'string' || args.command === '') return undefined
    return commandDependencyIndex.get(dependencyKey(exec.name, execCwd(exec), args.command))
  }

  /**
   * Freeze the declared dependencies of one command BEFORE it is dispatched.
   * All-or-nothing: a single unknown or expired file drops the whole snapshot,
   * so a partially observed command never claims evidence it does not have.
   */
  function freezeCommandDependencies(exec: ExecLike): void {
    // Clear this call's previous snapshot FIRST: a reused call identity must
    // never keep older evidence alive across an early return below.
    const bucket = dependencyBucket(exec)
    const key = callKey(exec)
    if (bucket === undefined) anonymousDependencySnapshots.delete(exec)
    else bucket.delete(key)
    const files = matchedDependencyFiles(exec)
    if (files === undefined) return
    const args = argsOf(exec)
    if (args === null || typeof args.command !== 'string') return
    const witnesses: PreconditionEvidence[] = []
    for (const file of files) {
      const observation = freshObservation(file)
      if (observation === undefined) return
      witnesses.push(observation.kind === 'present'
        ? { role: 'precondition', kind: 'file-state', path: file, observed: 'present', version: observation.version }
        : { role: 'precondition', kind: 'file-state', path: file, observed: 'absent' })
    }
    const snapshot: DependencySnapshot = { tool: exec.name, commandLine: args.command, cwd: execCwd(exec), witnesses }
    if (bucket === undefined) {
      // No session object: the execution OBJECT is the only identity available.
      anonymousDependencySnapshots.set(exec, snapshot)
      return
    }
    bucket.set(key, snapshot)
    if (bucket.size > 256) bucket.delete(bucket.keys().next().value!)
  }

  /**
   * Consume the frozen snapshot of this call, exactly once. The snapshot must
   * still describe the invocation settling now (same tool, command line, and
   * cwd), so neither an anonymous object swap nor a recycled call id can
   * attach one command's evidence to another's.
   */
  function takeCommandPreconditions(exec: ExecLike): PreconditionEvidence[] {
    let snapshot: DependencySnapshot | undefined
    const bucket = dependencyBucket(exec)
    if (bucket === undefined) {
      snapshot = anonymousDependencySnapshots.get(exec)
      if (snapshot !== undefined) anonymousDependencySnapshots.delete(exec)
    } else {
      const key = callKey(exec)
      snapshot = bucket.get(key)
      if (snapshot !== undefined) bucket.delete(key)
    }
    if (snapshot === undefined) return []
    const args = argsOf(exec)
    if (args === null || typeof args.command !== 'string') return []
    if (snapshot.tool !== exec.name || snapshot.commandLine !== args.command || snapshot.cwd !== execCwd(exec)) return []
    return snapshot.witnesses
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
        // Command facts compare against FRESH observations only: an expired
        // dependency is unknown, so the TTL verdict stands unchanged.
        preconditionNow: currentPreconditions(commandEvidenceMaxAgeMs),
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

  /**
   * Detect the failure a settled call proves, if any, as a store FactInput.
   * `dependencyWitnesses` are the pre-dispatch command snapshot (empty when
   * the invocation declared no dependency or its snapshot was incomplete).
   */
  function failureToRecord(exec: ExecLike, result: ResultLike, dependencyWitnesses: PreconditionEvidence[]): FactInput | undefined {
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
        evidence: [
          { role: 'outcome', kind: 'command-exit', exitCode, stderrSignature: stderrText },
          ...dependencyWitnesses,
        ],
        retryCondition: { type: 'after', at: new Date(Date.now() + commandRetryAfterMs).toISOString() },
      }
    }
    if (readTools.has(exec.name)) {
      if (typeof args.file_path !== 'string' || args.file_path === '') return undefined
      if (!result.isError || result.error?.info?.code !== 'FS_NOT_FOUND') return undefined
      const path = sanitize(args.file_path)
      const cwd = execCwd(exec)
      // Both witnesses are scoped by the SAME session key (`cwd + model path`):
      // the scoped key is the cache entry `observeFs` writes for a relative
      // path, and the display path is the absolute file that observation
      // resolved to. Looking the display path up by the bare model path would
      // let another session's file become this fact's evidence — a relative
      // path alias from another project, which the config contract forbids.
      const scopedKey = scopedModelKey(cwd, path)
      const witnessPaths = new Set([scopedKey])
      const displayPath = displayByModel.get(scopedKey)
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

  /** Sanitized, de-duplicated, length-capped path list for model-facing text. */
  function pathList(paths: readonly string[]): string {
    const unique = [...new Set(paths)]
    const listed = unique.slice(0, 3).map(path => sanitize(path))
    return `${listed.join(', ')}${unique.length > listed.length ? ` (+${unique.length - listed.length} more)` : ''}`
  }

  /**
   * Model-facing reason for a block or warning. It owes the model two honest
   * answers: what the plugin can still say about the recorded preconditions
   * NOW, and whether re-reading a recorded FILE could release the retry early.
   *
   * Only a `file-state` witness can be answered by re-reading. A witness the
   * freshness window no longer covers was observed here, so re-observing the
   * file may show the change that releases the retry; a witness never observed
   * in this context cannot be compared against anything, so no re-read shortens
   * the restriction; and a witness that is not file state at all (environment
   * or repository state) gets the concise generic answer, because this plugin
   * can neither re-observe it by reading a file nor tell "aged out" from "never
   * seen here" for it. None of these promises a release: an unchanged file
   * leaves the retry restriction — or its cooldown, for a timed condition — in
   * place.
   */
  function retryExplanation(fact: NegativeFact, current: PreconditionEvidence[]): string {
    const witnesses = fact.evidence.filter(e => e.role === 'precondition')
    const key = (e: PreconditionEvidence): string => {
      if ('path' in e) return `${e.kind}:${e.path}`
      if ('key' in e) return `${e.kind}:${e.key}`
      return `${e.kind}:${e.root}`
    }
    const known = new Set(current.map(key))
    // Recorded witnesses the comparison above could not speak to. Only a
    // file-state witness whose cached observation has AGED OUT of the window is
    // `expired` (the cache entry is what supplies the age); anything else is
    // `unknown` — never observed in this context, or not a file at all.
    const expired: string[] = []
    const unknown: string[] = []
    let unsupported = false
    for (const witness of witnesses) {
      if (known.has(key(witness))) continue
      if (witness.kind !== 'file-state') {
        unsupported = true
        continue
      }
      const label = displayByModel.get(witness.path) ?? witness.path
      const cached = observed.get(witness.path)
      if (cached !== undefined && Date.now() - cached.at > commandEvidenceMaxAgeMs) expired.push(label)
      else unknown.push(label)
    }
    const condition = fact.retryCondition
    // A timed condition really is a cooldown; every other restriction is
    // released by clearance or a confirmed change, not by elapsed time.
    const restriction = condition?.type === 'after' ? 'cooldown' : 'retry restriction'
    let evidence: string
    if (witnesses.length === 0) {
      // No witness can ever mismatch: the fact is released by its retry
      // condition alone, so saying "re-read the file" here would be a lie.
      evidence = 'No precondition evidence was recorded with this failure, so re-reading files cannot release the retry early'
        // No condition means nothing restricts the retry; do not name one.
        + (condition === undefined ? '.' : `; the ${restriction} stands.`)
    } else if (unsupported) {
      // Re-reading a file says nothing about environment or repository state,
      // so keep the pre-existing generic answer and make no freshness claim.
      evidence = 'Current precondition evidence is incomplete; no change has been confirmed.'
    } else if (expired.length === 0 && unknown.length === 0) {
      evidence = 'Observed preconditions still match.'
    } else {
      evidence = 'Current precondition evidence is incomplete; no change has been confirmed'
        + (expired.length > 0 ? ` — the recorded observation of ${pathList(expired)} is no longer fresh` : '')
        + (unknown.length > 0 ? `${expired.length > 0 ? ';' : ' —'} no observation of ${pathList(unknown)} was recorded in this context` : '')
        + `. Re-reading those files may confirm a change and enable an early retry; unchanged files leave the ${restriction} in place.`
    }
    const retry = condition?.type === 'after'
      ? `Retry cooldown until ${sanitize(condition.at)}; after expiry a verification retry is permitted.`
      : condition?.type === 'manual'
        ? 'Retry requires explicit manual clearance or a confirmed precondition change.'
        : condition?.type === 'never'
          ? 'Retry is disabled by the recorded condition unless a precondition changes.'
          : condition?.type === 'anyOf'
            ? 'No alternative retry condition is satisfied; a confirmed precondition change also permits verification.'
            : 'A confirmed precondition change permits verification.'
    return `${evidence} ${retry}`
  }

  function warnMessage(fact: NegativeFact, current: PreconditionEvidence[]): ContextMessage {
    const preview = commandPreview(fact)
    return message(
      'Negative-ledger: this action previously failed. Advisory only; this call was not blocked.\n'
      + `- claim: ${fact.claim}\n`
      + (preview !== undefined ? `- action preview: ${preview}\n` : '')
      + retryExplanation(fact, current),
      `${fact.kind} repeat`,
    )
  }

  function staleNote(fact: NegativeFact): ContextMessage {
    const preview = commandPreview(fact)
    return message(
      'Negative-ledger: recorded preconditions changed; verification is allowed, but success is not guaranteed.\n'
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

  function denyReason(fact: NegativeFact, current: PreconditionEvidence[]): string {
    const suffix = retryExplanation(fact, current)
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
      return { kind: 'deny', reason: denyReason(entry.fact, attempt.preconditionNow) }
    }
    warningBucket(exec).delete(entry.fact.id)
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
        // A stale-allow verdict IS "recorded preconditions changed", and the
        // read-through above commits that staleness to the store — so the
        // entry read BEFORE the transition cannot be asked whether the fact is
        // stale: it is always still `active` on the first repair-driven retry,
        // which would drop the withdrawal note exactly when it is most useful.
        // The `status === 'stale'` arm keeps the note for a lease granted on a
        // fact that was already stale without a witness mismatch.
        staleAtGrant: verdict === 'stale-allow' || entry.fact.status === 'stale',
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
      const cached = { observation, at: Date.now() }
      observed.set(target.displayPath, cached)
      const modelPath = actorModelPath(actor)
      if (modelPath !== undefined) {
        // Scoped by cwd exactly as the read path looks it up: one session's
        // relative path must never resolve to another session's file. An
        // unknown cwd keeps the bare model path, which is the same key a
        // cwd-less failure looks up.
        const scopedKey = scopedModelKey(actorCwd(actor) ?? '', modelPath)
        observed.set(scopedKey, cached)
        displayByModel.set(scopedKey, target.displayPath)
      }
      if (mode === 'off') return
      await enqueue(async () => {
        const entries = await store.queryFacts()
        const batch: Parameters<LedgerStore['transitionFacts']>[0] = []
        // Command facts invalidate on fresh evidence only — the same rule their
        // queries use, so a pass and a query never disagree about staleness.
        const all = currentPreconditions()
        let fresh: PreconditionEvidence[] | undefined
        for (const entry of entries) {
          if (entry.fact.status !== 'active') continue
          const now = entry.fact.kind === 'command_failed'
            ? (fresh ??= currentPreconditions(commandEvidenceMaxAgeMs))
            : all
          const staleWitnesses = mismatchedWitnessKinds(entry.fact, now)
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
      // Freeze declared dependencies before dispatch; this is the only place a
      // command precondition can originate.
      freezeCommandDependencies(exec)
      return guardAttempt(exec, attempt)
    },

    async postExecute(exec, result) {
      if (mode === 'off' || !tracked(exec.name)) return []
      // Consume the snapshot on every path so a denied or unrecordable call
      // cannot leave evidence behind for a later invocation.
      const dependencyWitnesses = takeCommandPreconditions(exec)
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
          const failure = failureToRecord(exec, result, dependencyWitnesses)
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
        if (entry !== undefined) warningBucket(exec).delete(entry.fact.id)
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
      const failure = failureToRecord(exec, result, dependencyWitnesses)
      let warningFact: NegativeFact | undefined
      if (entry !== undefined && (verdict === 'warn' || verdict === 'block')) {
        const bucket = warningBucket(exec)
        // Exclude revision and sliding TTL: recording the same failure changes
        // both, but must not defeat notification suppression.
        const signature = JSON.stringify(failure?.evidence ?? entry.fact.evidence)
        // A pending advisory is not yet delivered. Wait for its commit before
        // letting it suppress another call, including when the first commit fails.
        for (;;) {
          const pendingWarning = bucket.get(entry.fact.id)
          if (pendingWarning === undefined) break
          await pendingWarning.settled
          if (bucket.get(entry.fact.id) === pendingWarning) break
        }
        const previous = bucket.get(entry.fact.id)
        let release!: () => void
        const stamp = { signature, at: Date.now(), settled: new Promise<void>(resolve => { release = resolve }) }
        const emitWarning = warningRepeatAfterMs === 0 || previous === undefined
          || previous.signature !== signature || stamp.at - previous.at >= warningRepeatAfterMs
        if (emitWarning) {
          bucket.delete(entry.fact.id)
          bucket.set(entry.fact.id, stamp)
          if (bucket.size > 256) bucket.delete(bucket.keys().next().value!)
        }
        let applied = false
        try {
          const decision = await commitWithRetry(attempt, current => ({
            factId: current.fact.id,
            expectedRevision: current.revision,
            decision: 'observe-warn',
            emitWarning,
            meta: opMeta(exec),
          }))
          applied = decision.kind === 'applied'
          if (applied && emitWarning) warningFact = entry.fact
        } finally {
          if (!applied && emitWarning && bucket.get(entry.fact.id) === stamp) {
            if (previous === undefined) bucket.delete(entry.fact.id)
            else bucket.set(entry.fact.id, previous)
          }
          release()
        }
      } else if (entry !== undefined && verdict === 'stale-allow') {
        warningBucket(exec).delete(entry.fact.id)
        contexts.push(staleNote(entry.fact))
      }
      if (failure !== undefined) {
        try {
          const recorded = await store.recordFact(failure, opMeta(exec))
          if (warningFact !== undefined) warningFact = recorded.fact
        } catch (error) {
          // A concurrent lease holder owns this fact, or the store is busy:
          // this non-holder only observes.
          if (!/active verification lease/.test(String(error)) && !/store-busy/.test(String(error))) throw error
        }
      }
      if (warningFact !== undefined) contexts.push(warnMessage(warningFact, attempt.preconditionNow))
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
