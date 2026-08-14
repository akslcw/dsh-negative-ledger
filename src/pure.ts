/**
 * Storage-independent pure logic shared by every ledger store adapter:
 * fingerprint normalization, evidence comparison, and the verdict table.
 * No I/O, no state.
 * @module dsh-negative-ledger/pure
 */

import type {
  Fingerprint,
  NegativeFact,
  PreconditionEvidence,
  QueryVerdict,
  RetryCondition,
} from './types.ts'

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const record = value as Record<string, unknown>
  const body = Object.keys(record)
    .sort()
    .filter(key => record[key] !== undefined)
    .map(key => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')
  return `{${body}}`
}

/** Canonical key deciding whether two attempts are the same action. */
export function fingerprintKey(fingerprint: Fingerprint): string {
  return stableStringify(fingerprint)
}

/**
 * D7: the canonical form for a command fingerprint. Trim only — whitespace
 * is NOT collapsed, because collapsing merges semantically different shell
 * programs (e.g. `printf "a  b"` vs `printf "a b"`).
 */
export function normalizeCommandLine(commandLine: string): string {
  return commandLine.trim()
}

/** Canonical fingerprint: normalization applies at every engine entry, not just recording. */
export function normalizeFingerprint(fingerprint: Fingerprint): Fingerprint {
  if (fingerprint.kind === 'command_failed') {
    return { ...fingerprint, commandLine: normalizeCommandLine(fingerprint.commandLine) }
  }
  return fingerprint
}

function witnessKey(witness: PreconditionEvidence): string {
  switch (witness.kind) {
    case 'directory-listing':
    case 'file-content':
    case 'file-state':
      return `${witness.kind}:${witness.path}`
    case 'env-state':
      return `${witness.kind}:${witness.key}`
    case 'repo-state':
      return `${witness.kind}:${witness.root}`
  }
}

function hashOf(witness: PreconditionEvidence): string {
  switch (witness.kind) {
    case 'directory-listing':
      return witness.listingHash
    case 'file-content':
      return witness.contentHash
    case 'env-state':
      return witness.valueHash
    case 'repo-state':
      return witness.treeHash
    case 'file-state':
      return witness.observed === 'present' ? witness.version : 'absent'
  }
}

/**
 * D2: precondition witnesses with a positively different current value.
 * Absent information is conservative — assumed unchanged, never invalidating.
 */
export function mismatchedWitnessKinds(fact: NegativeFact, now: PreconditionEvidence[]): PreconditionEvidence['kind'][] {
  const current = new Map(now.map(witness => [witnessKey(witness), witness]))
  const stale: PreconditionEvidence['kind'][] = []
  for (const witness of fact.evidence) {
    if (witness.role !== 'precondition') continue
    const latest = current.get(witnessKey(witness))
    if (latest === undefined) continue
    if (hashOf(witness) !== hashOf(latest)) stale.push(witness.kind)
  }
  return stale
}

/**
 * Verdict table when the current evidence matches: absent condition → `warn`
 * (advisory while evidence is unchanged); `never`/`manual`/unmet `after` →
 * `block`; satisfied `after`/`anyOf` → `allow` (retry proceeds without
 * warning).
 */
export function retryVerdict(condition: RetryCondition | undefined, now: string): QueryVerdict {
  if (condition === undefined) return 'warn'
  switch (condition.type) {
    case 'never':
    case 'manual':
      return 'block'
    case 'after':
      return condition.at <= now ? 'allow' : 'block'
    case 'anyOf':
      return condition.conditions.some(c => retryVerdict(c, now) === 'allow') ? 'allow' : 'block'
  }
}
