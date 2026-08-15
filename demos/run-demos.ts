/**
 * Reproducible demonstrations of the three MVP scenarios, doubling as an
 * acceptance check of the minimum success criteria:
 *
 * 1. A second attempt at the same failed action is warned on / blocked by
 *    the old evidence.
 * 2. When the evidence changes, the conclusion is invalidated automatically
 *    and the reminder is withdrawn.
 *
 * The policy layer is the exact code a DSH composition calls on
 * tools/pre-execute, tools/post-execute, and fs/observed; the fakes mirror
 * the verified DSH result shapes (bash non-zero exits as successful results
 * with value.exitCode, missing reads as FS_NOT_FOUND errors). The demo runs
 * over the JSONL store (v0 backend).
 *
 * Run: node demos/run-demos.ts
 * @module dsh-negative-ledger/demos/run-demos
 */

import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { createLedgerPolicy } from '../src/plugin.ts'
import { JsonlLedgerStore } from '../src/store-jsonl.ts'
import type { ExecLike, ResultLike } from '../src/plugin.ts'

const LEDGER_DIR = join(import.meta.dirname, '.ledger')

// --- faithful fakes of the verified DSH surfaces ---------------------------

function bashExec(command: string, workdir?: string): ExecLike {
  return { name: 'bash', arguments: workdir === undefined ? { command } : { command, workdir } }
}

function bashFail(exitCode: number, stderr = 'ETIMEDOUT'): ResultLike {
  return { isError: false, value: { exitCode, stderr: { text: stderr } } }
}

function readExec(path: string): ExecLike {
  return { name: 'read', arguments: { file_path: path } }
}

function readNotFound(): ResultLike {
  return { isError: true, error: { message: 'cannot read: not found', info: { code: 'FS_NOT_FOUND' } } }
}

function readOk(): ResultLike {
  return { isError: false, value: { content: 'new config content' } }
}

// --- acceptance checks -----------------------------------------------------

let failed = 0
function check(name: string, ok: boolean): void {
  if (ok) {
    console.log(`  ✓ ${name}`)
  } else {
    failed += 1
    console.error(`  ✗ ${name}`)
  }
}

function textOf(contexts: Awaited<ReturnType<ReturnType<typeof createLedgerPolicy>['postExecute']>>): string {
  return contexts.map(c => c.content.map(block => block.text).join('\n')).join('\n')
}

// --- the demo --------------------------------------------------------------

rmSync(LEDGER_DIR, { recursive: true, force: true })
const store = new JsonlLedgerStore({ dir: LEDGER_DIR })
// One store, two policies: warn is the default posture, block the strict one.
const warnPolicy = createLedgerPolicy(store, { mode: 'warn' })
const blockPolicy = createLedgerPolicy(store, { mode: 'block' })

console.log('== S1 重复失败命令 ==')
const command = 'npm install --registry https://registry.npmmirror.com'
console.log(`第 1 次执行: ${command} → exit 1 (ETIMEDOUT)`)
const firstFail = await warnPolicy.postExecute(bashExec(command), bashFail(1))
console.log(`  post-execute 注入上下文: ${firstFail.length} 条（首次失败仅记录，不打扰）`)
check('首次失败仅记录，不注入警告', firstFail.length === 0)

console.log(`第 2 次执行同一命令 → exit 1`)
const secondFail = await warnPolicy.postExecute(bashExec(command), bashFail(1))
check('第二次重复被旧证据提醒', secondFail.length === 1
  && textOf(secondFail).includes('Negative-ledger')
  && textOf(secondFail).includes('command exited 1 (bash)')
  && textOf(secondFail).includes('1 duplicate failure(s) observed'))
console.log('  提醒内容摘要:')
console.log(`    ${textOf(secondFail).split('\n')[0]}`)

console.log(`第 3 次执行（block 模式）→ 派发前拦截`)
const denied = await blockPolicy.preExecute(bashExec(command))
check('block 模式在派发前 deny', denied?.kind === 'deny' && denied.reason.includes('command exited 1'))
console.log(`    deny 原因: ${denied?.kind === 'deny' ? denied.reason : '(未拦截)'}`)

console.log('\n== S2 重复读取不存在的文件 ==')
const missingPath = '/workspace/legacy-config.json'
await warnPolicy.observeFs({ displayPath: missingPath }, { kind: 'absent' })
console.log(`第 1 次读取: ${missingPath} → FS_NOT_FOUND（fs/observed 已记录 absent）`)
const firstRead = await warnPolicy.postExecute(readExec(missingPath), readNotFound())
check('首次缺失仅记录', firstRead.length === 0)

console.log('第 2 次读取同一路径 → FS_NOT_FOUND')
const secondRead = await warnPolicy.postExecute(readExec(missingPath), readNotFound())
check('重复读取被提醒', secondRead.length === 1 && textOf(secondRead).includes('file does not exist'))
console.log(`    ${textOf(secondRead).split('\n')[0]}`)

console.log('\n== S3 证据变化后自动失效 ==')
console.log(`文件出现: fs/observed → present (version v1)`)
await warnPolicy.observeFs({ displayPath: missingPath }, { kind: 'present', version: 'v1' })
const fileFact = (await store.queryFacts()).find(entry => entry.fact.kind === 'file_missing' && entry.fact.status !== 'superseded')
check('旧结论自动从 active 变 stale', fileFact?.fact.status === 'stale')
const staledClaims = (await store.queryFacts()).filter(entry => entry.fact.status === 'stale').map(entry => entry.fact.claim)

console.log('第 3 次读取成功（文件已存在）')
const thirdRead = await warnPolicy.postExecute(readExec(missingPath), readOk())
check('提醒已撤销：不再出现"证据未变"警告', !textOf(thirdRead).includes('evidence is unchanged'))
check('允许重试并给出失效说明', textOf(thirdRead).includes('retry is allowed'))
check('成功重试后结论闭环为 resolved', (await store.queryFacts()).find(entry => entry.fact.kind === 'file_missing' && entry.fact.status !== 'superseded')?.fact.status === 'resolved')
console.log(`    ${textOf(thirdRead).split('\n')[0]}`)

// --- report ----------------------------------------------------------------

const summary = await store.summarize()
const hitFacts = (await store.queryFacts()).filter(entry => entry.fact.savings.warningsEmitted + entry.fact.savings.callsDenied > 0)

console.log('\n=== 演示报告 ===')
console.log(`本轮命中 ${summary.factsHit} 条失败知识：`)
for (const entry of hitFacts) {
  console.log(`  - ${entry.fact.kind}: ${entry.fact.claim}`)
  console.log(`    （警告 ${entry.fact.savings.warningsEmitted} 次，阻止 ${entry.fact.savings.callsDenied} 次）`)
}
console.log(`观察到重复失败: ${summary.duplicateFailuresObserved} 次`)
console.log(`发出警告: ${summary.warningsEmitted} 次`)
console.log(`阻止调用: ${summary.callsDenied} 次（唯一确定避免执行的次数）`)
for (const claim of staledClaims) {
  console.log(`因证据变化自动失效: 1 条 (${claim})`)
}
console.log(`账本文件: ${join(LEDGER_DIR, 'ledger.jsonl')}`)

console.log('\n最小成功标准验证:', failed === 0 ? '通过 ✓' : `失败 ✗ (${failed} 项)`)
if (failed !== 0) process.exitCode = 1
