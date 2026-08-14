/**
 * Public surface of dsh-negative-ledger.
 * @module dsh-negative-ledger
 */

export { fingerprintKey, NegativeLedger, normalizeCommandLine } from './engine.ts'
export type { LedgerOptions } from './engine.ts'
export { fingerprintKey as fingerprintKeyPure, normalizeCommandLine as normalizeCommandLinePure } from './pure.ts'
export type {
  AttemptDecisionRequest,
  AttemptDecisionResult,
  FactInput,
  FactTransitionItem,
  ImportReport,
  LeaseSettlement,
  LedgerStore,
  OperationMeta,
  SettleResult,
  StoreFact,
} from './store.ts'
export { JsonlLedgerStore } from './store-jsonl.ts'
export type { JsonlLedgerStoreOptions } from './store-jsonl.ts'
export { SqliteLedgerStore } from './store-sqlite.ts'
export type { SqliteLedgerStoreOptions } from './store-sqlite.ts'
export { runCli } from './cli.ts'
export type { CliResult } from './cli.ts'
export { apply, createLedgerPolicy, name, inject } from './plugin.ts'
export type {
  Config,
  ContextMessage,
  DshContextLike,
  ExecLike,
  FsObservationLike,
  FsTargetLike,
  LedgerPolicyConfig,
  PolicyCallbacks,
  PreExecuteOutcome,
  ResultLike,
} from './plugin.ts'
export type {
  AttemptContext,
  Evidence,
  FactKind,
  FactMatch,
  FactStatus,
  Fingerprint,
  InvalidatedFact,
  NegativeFact,
  NegativeFactInput,
  PreconditionEvidence,
  QueryVerdict,
  RetryCondition,
  Savings,
  SavingsSummary,
} from './types.ts'
