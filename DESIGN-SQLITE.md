# dsh-negative-ledger — SQLite 里程碑设计

> 状态：v3，已按第二轮评审修正（4 项事件层协议缺口），待终审。
> 本里程碑只做设计与实现 SQLite 存储、retry lease、迁移与崩溃恢复；npm 包装在其后。

## 0. 问题与边界

v0（JSONL）已闭环单进程语义，但三件事它做不到：

1. **并发写**：单写者。两个进程对同一账本的并发 record/invalidate/resolve 会互相覆盖或产生分裂状态。
2. **并发验证重试**：上一轮把拦截适用性改为"每次查询按当前证据派生"，解决的是**证据回归**（文件又变回 absent → 重新拦截）；但它不解决**证据刚变化时十个代理同时重试**——十个 `stale-allow` 会同时放行。这正是 retry lease 要补的缺口。
3. **可审计的持久层**：JSONL 靠重放派生状态；多代理下需要 O(1) 当前状态 + 幂等事件流 + 崩溃可恢复。

本里程碑的验收红线（评审时逐条对照）：

- **A1** 两个进程同时遇到同一失败 → 恰好一个当前 fact。
- **A2-block** 证据变化后十个代理同时重试（block 模式）→ 恰好一个拿到 lease 并执行，其余 deny。
- **A2-warn** 十个代理全部可执行，但只有 lease 持有者的 settle 具有状态权威，其余结果仅观察。
- **A3** 相同 `tool_call_id` 重放 → 指标不重复累计。
- **A4** 任意阶段杀进程 → 数据库正常打开、状态一致、孤儿 lease 可接管。

明确不做（本里程碑）：网络文件系统/多主机共识、信任等级与隔离（后续）、语义检索、事件保留策略的自动执行（只留 schema 余地）。

## 1. 总体架构

```
插件（DSH 事件接线，异步）
  └─ NegativeLedger（门面：查询/记录/lease 语义编排，异步）
       ├─ 纯逻辑层（fingerprint 规范化、证据比对、verdict 表）——与存储无关，保持现有实现
       └─ LedgerStore（接口）
            ├─ JsonlLedgerStore   —— v0 行为适配器（回归基线）
            └─ SqliteLedgerStore  —— 本里程碑
```

- **引擎不直接依赖 SQLite**：`LedgerStore` 是唯一存储边界；纯逻辑层（`fingerprintKey`/`normalizeFingerprint`/`mismatchedWitnessKinds`/`retryVerdict`）原样迁出，两个适配器共享。
- 接口全异步（`Promise`），与 DSH 的异步事件瀑布匹配；JSONL 适配器内部同步、返回已决议 Promise。
- SQLite 驱动选 **`better-sqlite3`**（同步、WAL/busy_timeout/backup API 成熟、各平台有 prebuild）。`node:sqlite` 曾为首选，但实测 Node 22.23 仍标记 experimental（每次启动打 ExperimentalWarning，API 承诺"might change at any time"），持久层不押实验 API；若未来 Node ≥24 稳定可再评估，届时仅替换适配器内部实现。注意：当前仓库 pnpm store 尚无 better-sqlite3（本设计撰写时实测），M2 第一步是引入该依赖；如部署环境不接受原生依赖，可切回 node:sqlite 并接受实验警告——接口不变，只换适配器内部。

### LedgerStore 接口（v3）

```ts
export interface OperationMeta {
  operationId: string      // 调用方铸造（UUID v7）：一次逻辑操作一个；重试原样携带
  toolCallId?: string      // 幂等辅助键 + 溯源
  actor?: string
}

export interface LedgerStore {
  /** 纯读：当前事实（含 revision、活跃 lease 摘要），无则 undefined。 */
  getFact(scope: string, kind: FactKind, fingerprint: string): Promise<StoreFact | undefined>
  /** 纯读：全部/按 scope 的当前事实快照。 */
  queryFacts(filter?: { scope?: string }): Promise<StoreFact[]>

  /** 原子裁决提交：读+纯计算后的唯一公开裁决写入口（deny/观察计数、verify-retry lease）。 */
  commitAttemptDecision(request: AttemptDecisionRequest): Promise<AttemptDecisionResult>
  /** 记录/追加失败证据版本（含 resolved 后开新 id 的双写语义）。 */
  recordFact(input: FactInput, meta: OperationMeta): Promise<StoreFact>
  /** 批量状态转换（一次 FS observation 可失效多个 fact），单事务，任一冲突整体失败。 */
  transitionFacts(
    batch: Array<{ id: string; expectedRevision: number; transition: FactTransition }>,
    meta: OperationMeta,
  ): Promise<StoreFact[]>
  /** 结算 lease：重试结果回传后应用语义后果。非裁决入口（发放只在 commitAttemptDecision 内发生）。 */
  settleLease(request: LeaseSettlement): Promise<SettleResult>

  summarize(scope?: string): Promise<SavingsSummary>
  open(): Promise<void>
  close(): Promise<void>
  reconcile(): Promise<void>       // 显式修复：从 events 重建派生计数（O(events)，非常规路径）
  importJsonl(path: string): Promise<ImportReport>
}

export interface AttemptDecisionRequest {
  factId: string
  expectedRevision: number
  /**
   * 三种裁决：deny（block 条件）/ observe-warn（证据未变）/ verify-retry。
   * 引擎 verdict 的 `allow`（TTL 到期）与 `stale-allow`（证据已变）都映射为
   * verify-retry——两者都是验证性重试，都要竞争 lease，否则 TTL 到期时
   * 十个代理会同时拿到 allow 一起执行。
   */
  decision: 'deny' | 'observe-warn' | 'verify-retry'
  meta: OperationMeta
  leaseRequest?: { leaseId: string; owner: string; ttlMs: number }   // verify-retry 必带
}

export type AttemptDecisionResult =
  | { kind: 'applied'; fact?: StoreFact; lease?: { leaseId: string; expiresAt: string } }
  | { kind: 'conflict' }                                   // revision 已变 → 调用方重读重算（有界）
  | { kind: 'in-progress'; owner: string; expiresAt: string }
  | { kind: 'replay'; result: AttemptDecisionResult }      // 幂等重放：返回原始裁决（含原 leaseId/expiry）
  | { kind: 'unavailable'; reason: string }

export type LeaseSettlement =
  | { kind: 'succeeded'; leaseId: string; owner: string; meta: OperationMeta }
  | { kind: 'failed'; leaseId: string; owner: string; fact: FactInput; meta: OperationMeta }
  | { kind: 'released'; leaseId: string; owner: string; meta: OperationMeta }

export type SettleResult = 'applied' | 'not-active' | 'revision-conflict' | 'replay'
```

`scope` 是新增的一等维度：workspace 身份（canonical cwd，未来可换 workspaceId），**从指纹中拆出**——v0 把 cwd 塞在指纹里，SQLite 版把 `scope` 独立成列，指纹只描述动作本身。相应地，规范指纹键**不再包含 cwd**（`fingerprintKey` 的输入改为 scope 之外的字段）；插件用与 v0 相同的 `execCwd` 推导 scope，查询时 (scope, kind, fingerprintKey) 三元组定位。"恰好一个**当前** fact"由部分唯一索引保证（见 §2）。

```sql
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 100;   -- 短超时：同步驱动阻塞事件循环，长等待在应用层异步退避（见 §3.1）
PRAGMA foreign_keys = ON;
-- secure_delete 默认 OFF（性能）；导入/迁移期间可临时 ON。见 §7。

CREATE TABLE schema_version (
  version    INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

-- 当前状态：每逻辑事实一行（不重放派生）
CREATE TABLE facts (
  id               TEXT PRIMARY KEY,          -- uuid v7（时间有序）
  scope            TEXT NOT NULL,
  kind             TEXT NOT NULL,             -- command_failed | file_missing | ...
  fingerprint      TEXT NOT NULL,             -- 规范化指纹 JSON（不含 scope）
  claim            TEXT NOT NULL,             -- 脱敏策略见 §7
  evidence         TEXT NOT NULL,             -- JSON 数组
  retry_condition  TEXT,                      -- JSON，NULL = evidenceChanged
  status           TEXT NOT NULL CHECK (status IN ('active','stale','resolved','superseded')),
  is_current       INTEGER NOT NULL DEFAULT 1,-- 当前版本位（见下）
  revision         INTEGER NOT NULL DEFAULT 1,-- 乐观并发版本
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  last_transition  TEXT                       -- JSON（审计：witness 种类/from-to/via）
);
-- 恰好一个"当前" fact：resolved 后新一轮失败在同一事务里把旧行
-- is_current=0,status='superseded'，再 INSERT 新行（v0 的 resolved→新 id 语义）。
CREATE UNIQUE INDEX idx_facts_current_key
  ON facts (scope, kind, fingerprint)
  WHERE is_current = 1;

-- 操作收据：一次逻辑操作的请求哈希与已应用结果。
-- 幂等重放按 operation_id 查回原始结果（含原 leaseId/expiry），不重放副作用。
CREATE TABLE operations (
  operation_id TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,        -- 请求规范化 JSON 哈希；同 id 不同内容 → fail-loud
  result_json  TEXT,                 -- applied 结果 JSON；重放原样返回
  created_at   TEXT NOT NULL
);

-- 审计事件流：幂等；可重建派生计数（facts 完整重建不承诺，见 §4/§6）
CREATE TABLE events (
  seq             INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id        TEXT NOT NULL UNIQUE,   -- 派生：hash(operationId, factId, kind)（应用层计算）
  operation_id    TEXT NOT NULL,          -- 所属逻辑操作（批量转换下多事件共用一个 operationId）
  operation_kind  TEXT NOT NULL,          -- 稳定操作身份：record_failure|transition_evidence|
                                          -- attempt_decision|resolve_fact|retry_settle|import
  at              TEXT NOT NULL,
  kind            TEXT NOT NULL,          -- 审计结果类型：fact_recorded|fact_updated|evidence_changed|
                                          -- retry_granted|retry_settled|attempt_observed|
                                          -- attempt_denied|fact_resolved
  fact_id         TEXT NOT NULL REFERENCES facts(id),
  scope           TEXT NOT NULL,
  tool_call_id    TEXT,                   -- 出处与幂等辅助键
  actor           TEXT,                   -- agent/session 身份（溯源）
  payload         TEXT NOT NULL,          -- JSON 细节（旧/新值、裁决、lease id）
  causation_id    TEXT                    -- 链：retry_settled → retry_granted
);
-- 操作级幂等：同一 (fact, tool_call_id, operation_kind) 只生效一次。
-- 用 operation_kind 而非审计 kind：首次 fact_recorded 与重放的 fact_updated
-- 属于同一个 record_failure 操作，必须被同一索引拦住（审计类型不参与操作身份）。
CREATE UNIQUE INDEX idx_events_fact_call_opkind
  ON events (fact_id, tool_call_id, operation_kind)
  WHERE tool_call_id IS NOT NULL;
-- retry_granted/retry_settled 的幂等由 retry_leases 行状态机 + operations 收据保证。

-- 拦截计数（物化：正常路径与事件同事务增量；reconcile() 为显式修复，见 §4/§6）
CREATE TABLE counters (
  fact_id                     TEXT PRIMARY KEY REFERENCES facts(id),
  duplicate_failures_observed INTEGER NOT NULL DEFAULT 0,
  warnings_emitted            INTEGER NOT NULL DEFAULT 0,
  calls_denied                INTEGER NOT NULL DEFAULT 0
);

-- retry lease：lease_id 为主键（全局唯一、保留历史），每 fact 至多一个活跃 lease
CREATE TABLE retry_leases (
  lease_id       TEXT PRIMARY KEY,            -- 调用方预生成；重试同 id 幂等
  fact_id        TEXT NOT NULL REFERENCES facts(id),
  owner          TEXT NOT NULL,
  fact_revision  INTEGER NOT NULL,            -- lease 绑定它验证的版本
  granted_at     TEXT NOT NULL,
  expires_at     TEXT NOT NULL,
  outcome        TEXT,                        -- NULL=活跃；succeeded|failed|expired|released
  settled_at     TEXT
);
CREATE UNIQUE INDEX idx_one_active_lease
  ON retry_leases (fact_id)
  WHERE outcome IS NULL;
CREATE INDEX idx_leases_expiry ON retry_leases (expires_at);
```

要点：

- **状态表 + 事件表**，不重放派生：查询读 `facts`/`counters`（O(1)）；`events` 是审计流，可重建派生计数（facts 完整重建不承诺——见 §4/§6）。
- **`is_current` 部分唯一索引** 让 A1 的"恰好一个当前 fact"由数据库约束保证：同 (scope,kind,fingerprint) 至多一行 is_current=1；resolved 后新一轮失败走"旧行 is_current=0 + INSERT 新行"双写（v0 语义），而不是应用层锁。
- **event_id 派生 + 操作级幂等**：`event_id = hash(operationId, factId, kind)` 应用层派生（批量转换下多个 fact 事件共用一个 operationId，各自 event_id 唯一）；幂等索引用 `(fact_id, tool_call_id, operation_kind)` 拦**操作身份**而非审计类型——record_failure 首次产生 fact_recorded、重放产生 fact_updated，同属一个操作身份，必须被同一索引拦住——A3。
- **operations 收据表**：幂等重放按 operation_id 返回**原始结果**（含原 leaseId/expiry），不是泛化 duplicate——同 id 不同 request_hash → fail-loud。
- **revision**：`facts.revision` 随每次状态/证据变更 +1；所有写路径携带 `expectedRevision`，`UPDATE ... WHERE id=? AND revision=?` 行数为 0 即冲突（乐观并发），调用方重读重算（有界重试 3 次，仍冲突则把冲突作为操作结果返回给插件渲染）。

## 3. 一致性协议

### 3.1 事务边界

- 所有**写**路径用 `BEGIN IMMEDIATE`：进入即取写锁，避免 WAL 下"读后写升级"死锁。
- **同步驱动的阻塞事实**：better-sqlite3 是同步调用，`Promise` 包装不会让事务离开事件循环——事务体必须小（单语句级），`busy_timeout` 取短值（100ms），应用层在两次尝试之间**异步退避**（10–20ms 抖动），总截止时间默认 2s（config `storeBusyDeadlineMs`）。持久 `SQLITE_BUSY` → 操作显式失败（`store-unavailable`），**不静默吞掉**。
- 失败姿态（插件层）：warn 模式放行并附 `store-unavailable` 说明；block 模式 **fail-closed 拒绝**（宁可误拒不可漏拦）。
- 事务绝不跨层持有：store 方法自开自关事务，门面/插件拿到的只有已提交结果。

### 3.2 写路径（两相：读 + 纯计算 → 原子提交）

- **裁决提交 `commitAttemptDecision`（唯一公开裁决写入口）**：门面先 `getFact` + 纯逻辑算出 decision，再调本方法一次性原子落盘——单事务内完成 `expectedRevision` 校验、operations 收据检查/写入、`counters` 更新与 verify-retry lease 发放/deny。返回 `conflict` → 门面重读重算（有界 3 次）。引擎 verdict 的 `allow`（TTL 到期）与 `stale-allow`（证据已变）都映射为 `verify-retry`（都要竞争 lease）；`acquireLease` **不在 LedgerStore 公开接口中**，它只是 SqliteLedgerStore 的事务内 helper——杜绝"绕过原子裁决直接拿 lease"的第二入口。
- **recordFact / 证据版本追加**：事务内 `SELECT is_current=1` 当前行 → 若 active/stale：`UPDATE`（revision+1、证据/claim/updated_at，last_transition 清空）+ `fact_updated` 事件（operation_kind=`record_failure`）；若 status=resolved（或不存在）：同一事务把旧行 `is_current=0,status='superseded'`，再 `INSERT` 新行（新 id、revision=1、is_current=1）+ `fact_recorded` 事件——v0 的"resolved 后新 id"语义由这组双写实现。两个进程同时首录同一 (scope,kind,fingerprint)：后到者的 INSERT 撞部分唯一索引 → 事务内重查并升级为版本追加路径（A1 的第二个半场）；重查行 revision 又变则按 OCC 有界重试。
- **invalidate/resolve（批量）**：`transitionFacts(batch, meta)`——一次 FS observation 可能使多个 fact 的证据同时变化，必须单事务整体提交；任一 `expectedRevision` 冲突则整体失败、不部分提交；一个 `operationId` 下按 fact 各写一条 `evidence_changed`/`fact_resolved` 事件（event_id 派生，互不冲突）。

### 3.3 读路径

- `queryFacts` 只读快照（WAL 读不阻塞写）；判定拦截适用性仍是"当前证据派生"（v0 语义不变），只是数据来自 `facts` 当前行。
- `summarize` 读 `counters` 物化表；正常路径计数与事件同事务增量维护，`reconcile()` 显式修复（见 §6）。

### 3.4 Retry lease 协议（A2 的原子性来源）

lease 只在**验证性重试**时发放：引擎 verdict 的 `stale-allow`（证据已变）与 `allow`（TTL 到期）都映射为 `commitAttemptDecision({ decision: 'verify-retry' })`——两者都必须竞争 lease，否则 TTL 到期时十个代理会同时拿到 allow 一起执行。`warn`/`block`（证据未变、条件未满足）不涉及 lease，走 deny/observe-warn。

状态机：

```
            commitAttemptDecision(verify-retry, leaseRequest{leaseId, owner, ttl, ...})
  (无活跃行) ────────────► granted                       (INSERT：lease_id PK + 活跃部分唯一索引)
  (活跃行, 未过期) ───────► in-progress(owner, expires)    (绝不并发放行)
  (活跃行, 已过期) ───────► 接管：同事务旧行 outcome='expired'，INSERT 新行 → granted
  (同 operationId 重放) ─► replay：operations 收据原样返回原结果（含原 leaseId/expiry）
   settleLease(LeaseSettlement)                          (同事务)
  granted ──succeeded──► facts→resolved (revision+1) + retry_settled 事件
  granted ──failed─────► facts 版本追加 (revision+1, 新证据 = settlement.fact) + retry_settled 事件
  granted ──released───► 仅结算 lease，facts 不动（取消的验证）
  granted ──过期未结算─► 下一位 verify-retry 时标记 expired 并接管（无事实转换——保守）
```

原子性细节：

- 发放 = `INSERT`，唯一性由两道约束保证：`lease_id` 主键（全局唯一、历史保留）+ 部分唯一索引 `(fact_id) WHERE outcome IS NULL`（每 fact 至多一个活跃 lease）。十个并发 verify-retry 只有一个通过活跃索引，其余拿 `in-progress`。**不需要应用层锁**。lease 发放只在 `commitAttemptDecision` 事务内发生（`acquireLease` 是 SqliteLedgerStore 内部 helper，不在 LedgerStore 公开接口中）。
- **幂等重放（收据语义）**：operationId 由调用方预生成；同 operationId 重试 → operations 表查到收据，request_hash 一致则**原样返回存储的原始结果**（applied 含原 leaseId/expiry、in-progress 含原 owner/expiry），不产生新行、不重新竞争。request_hash 不一致 → fail-loud。
- **结算前置条件（全部满足才生效）**：`lease_id` 匹配、`owner` 匹配、`outcome IS NULL`（未被接管/结算）、`facts.revision == fact_revision`。任一不满足返回 `not-active`/`revision-conflict`，事实不动；operationId 重放返回 `replay`。
- **结算数据自足**：`failed` 必须携带完整 `fact: FactInput`（新 evidence/claim/retryCondition）——版本追加的内容由调用方在重试失败时生成，store 只做原子落盘。
- **到期不等于裁决作废**：`expires_at` 只是**接管阈值**。原 owner 到期后、无后继者接管（outcome 仍 NULL）时回来结算，判定依然有效。只有后继者接管后旧 lease 结算才被拒；该次成功被丢弃、事实保持 stale，由后继者的验证决定去向。缓解：TTL 默认 60s 且应大于预期重试时长（config `leaseTtlMs`），README 写明此丢失场景。
- lease 绑定 `fact_revision`：stale lease 永远不能结算到新版本的 fact 上。

插件接线（A2 按模式拆分，单入口）：

- verdict `allow`/`stale-allow` → `commitAttemptDecision({ decision: 'verify-retry', leaseRequest })`（leaseId/operationId 预生成）：
  - `applied`（含 lease）→ 放行该次调用；结果回来 `settleLease`。
  - `in-progress` → **block 模式 deny**（reason 注明 owner/到期时间）：一个执行者、其余 deny——A2-block。
  - **warn 模式**注入 advisory 上下文 "verification in progress by <owner>; wait"——warn 契约永不阻止，**所有调用仍可执行**；只有 lease 持有者的 settle 具有状态权威，其余结果仅观察、不更新 fact（settle 返回 `not-active`/`revision-conflict` 被丢弃）——A2-warn。
  - `unavailable` → 按 3.1 的失败姿态处理。

## 4. 幂等与重放

- **operations 收据表**：每个逻辑操作铸造一个 `operationId`（UUID v7），重试原样携带。写路径在事务内先查收据：存在且 `request_hash` 一致 → **原样返回存储的原始结果**（含原 leaseId/expiry），不重放副作用；存在但哈希不一致 → 抛 `operation-replay-conflict`（fail-loud：同一 operation id 承载不同内容说明铸造有误或数据损坏）。**不用宽泛的 `INSERT OR IGNORE`**——它吞掉非幂等类约束错误。
- **event_id 派生**：`event_id = sha256(operationId, factId, kind)` 应用层计算——批量转换（一个 operationId、多个 fact 事件）下每个事件的 id 天然唯一，不共用一个全局 eventId 撞 UNIQUE；同一操作的重复写入产生相同 event_id，配合收据表整体幂等。
- **操作级幂等索引 `(fact_id, tool_call_id, operation_kind)`**：`operation_kind` 是稳定操作身份（record_failure/transition_evidence/attempt_decision/resolve_fact/retry_settle/import），审计 `kind`（fact_recorded vs fact_updated）不参与身份——同一 toolCallId 重放时，无论审计类型如何演化（首录→追加），第二次都被索引拦住（A3）。同一调用对**不同** fact 的事件不受影响。
- 计数器与事件**同事务**增量更新（正常路径不靠重放）；`reconcile()` 是显式修复操作，从 events 全量重建（`SUM` 按 fact_id，O(events)）。

## 5. 迁移与 JSONL 导入

- `schema_version` 顺序迁移（migration N 只负责 N-1→N），每步在事务内执行 + `PRAGMA user_version` 同步（双写以防 schema_version 表缺失时仍有原生版本位可查）。
- **回滚策略（诚实立场）**：迁移只前滚。回滚 = 迁移前自动备份（`VACUUM INTO '<db>-pre-migrate-<version>.db'`），出问题恢复备份文件；不做双向迁移。
- **JSONL 一次性导入** `importJsonl(path)`：
  - 逐行解析 v1 事实/命中行；**cwd → scope**（指纹里拆出，动作字段保留 tool/commandLine/路径）。
  - 事件 id = `import:<行内容 sha256>`——重复导入天然幂等（附录 A 精确规则）。
  - 同一 (scope,fingerprint) 多行按序折叠，最后一行胜出；hit 行按内容哈希事件 id 合成幂等事件（附录 A 规则）。
  - 导入报告：行数、事实数、折叠数、跳过（损坏行报错即停，fail-loud；`--skip-invalid` 仅在显式给出时降级）。
- 版本策略：存储格式破坏性变更 bump `SCHEMA_VERSION` 单调递增（沿用仓库惯例）；JSONL `STORE_VERSION=1` 保持不变，v1 数据永远可导入。

## 6. 崩溃恢复

- **事务原子性**：WAL 保证提交要么完整要么不存在；进程在任何点被杀，重开时 WAL 自动回放已提交事务、丢弃未提交的——无需手工修复。
- **打开协议**：`PRAGMA integrity_check`（失败 → 拒绝打开并报错路径，fail-loud）→ `is_current` 派生校验（同 (scope,kind,fingerprint) 至多一个 is_current=1；异常 → 报错提示 `reconcile`）。**打开时不修改任何 lease、不做全量计数重建**——"到期不作废"要求只有新 `acquireLease` 才能处置旧 lease；正常路径计数与事件同事务增量，撕裂场景由显式 `reconcile()` 修复（O(events)，非常规路径）。
- **孤儿 lease**：崩溃 owner 的 lease 无结算记录 → 保持到期接管机制（下一位 acquire 在同一事务内标 `expired` 并建新 lease）；未过期的 lease 打开时原样保留（owner 可能还活着）。
- **中断的导入/迁移**：各自单事务；中断 = 未提交 = 原状。
- **事件重放**：§4 幂等保证任意前缀重放安全（内容一致性校验 + duplicate 语义）。

## 7. 安全与平台边界

- 文件权限：DB 与 `-wal`/`-shm` 文件 0600、目录 0700（POSIX）；**Windows NTFS 不执行 POSIX 模式位**——边界写清楚：Windows 上依赖父目录 ACL（沙箱/用户目录），不承诺 0600 等价性；README 明示。
- 脱敏策略沿用 v0：claim 不含原始命令、预览控制字符清理 + 限长、stderrSignature 净化——在 store 入口统一施加（策略层，不进 schema）。
- 指纹列仍含原始命令（它就是键）：列注释标明敏感；事件保留策略只留接口（`events` 有 `at` 与 `seq`，可按策略修剪；本里程碑不自动执行）。`PRAGMA secure_delete` 默认关、迁移/导入时可选开。
- 单机本地文件系统：README 明确不支持网络盘/云同步目录（SQLite 官方边界），打开时不做探测（探测不可靠），只文档声明。

## 8. 插件接入变化（相对 v0）

- 引擎门面方法全异步；插件事件处理器本来就是异步瀑布，接线不变形。
- 裁决写入口收敛为 `commitAttemptDecision`；`allow` 与 `stale-allow` 都走 `verify-retry`（lease 竞争），`in-progress` 按模式 deny/提醒。
- 新增 config：`leaseTtlMs`（默认 60000）、`storeBusyDeadlineMs`（默认 2000，见 §3.1）。
- 消息文案新增 `retry_in_progress` 一条（含 owner 与到期时间）。
- v0 的 JSONL 行为通过 `JsonlLedgerStore` 原样保留，作为回归基线与迁移数据源。

## 9. 里程碑与验收

| 里程碑 | 内容 | 验收 |
|---|---|---|
| M1 | `LedgerStore` 接口 + 纯逻辑层拆分 + `JsonlLedgerStore` 适配 | 现有 57 测试经接口全绿；插件行为与 v0 逐字节一致（快照） |
| M2 | `SqliteLedgerStore`：schema、迁移、`importJsonl` | 同 fixture 导入后 facts/counters 与 JSONL 版一致；迁移幂等 |
| M3 | 原子写路径 + retry lease + 插件接线 | 验收场景 A1–A3 |
| M4 | 崩溃恢复 + 双进程测试 | 验收场景 A4 + 双连接并发矩阵 |
| M5 | （评审后）npm 包装 | scope/bin/构建产物/README 发布节 |

**双连接/双进程验收矩阵**（每格都有断言）：

| 并发组合 | 断言 |
|---|---|
| 2 进程同时 record 同一 (scope,fingerprint) | is_current=1 恰 1 行；events 2 条（recorded + updated）；revision=2 |
| 2 进程同时 transitionFacts 同一批 fact（同 revision） | 恰 1 个整体成功，1 个 conflict 后重算 |
| 同 toolCallId 重放 record（换 operationId，首录→追加演化） | 第二次被 (fact_id, tool_call_id, operation_kind) 索引拦住，不产生新版本 |
| 2 进程同时 commitAttemptDecision 同一 tool_call_id | 计数恰 +1（一个收据 replay） |
| 10 进程同时 commitAttemptDecision(verify-retry)（block 语义） | 恰 1 applied（lease），9 in-progress |
| TTL 到期 10 进程同时 verify-retry（allow 路径） | 恰 1 applied（lease），9 in-progress——allow 同样竞争 lease |
| 同 operationId 重放 commitAttemptDecision | 收据原样返回原结果（含原 leaseId/expiry），不产生新行 |
| warn 语义：非持有者 10 进程同时 settle | 恰 1 applied，9 not-active/revision-conflict，fact 只变一次 |
| 1 进程持 lease 时 settle 另一个 lease_id/owner | 拒绝，事实不动 |
| lease 持有中事实被 revision+1 后 settle | 拒绝（revision 不符） |
| 随机点 kill -9（事务中/lease 中/导入中） | 重开 integrity_check OK；counters 与 events 一致；孤儿 lease 可接管 |

**四个验收场景**（评审红线）：

- **A1** 两进程同失败 → 一个当前 fact（is_current=1 恰一行）。
- **A2-block** 证据变化后十代理重试（block 模式）→ 一个 granted 执行、九个 deny。
- **A2-warn** 十代理全部可执行，但只有 lease 持有者的 settle 具有状态权威，其余结果仅观察、不更新 fact。
- **A2-allow** TTL 到期后十代理重试 → 同样竞争 lease：一个 granted、九个 in-progress（allow 不旁路）。
- **A3** 同 `tool_call_id` 重放 → 指标不重复累计；同 operationId 但请求不同 → `operation-replay-conflict`。
- **A4** 任意阶段杀进程 → 一致可开、可接管；打开不修改任何 lease。

## 10. 明确不做

网络文件系统支持、多主机共识、信任等级与来源隔离（审计字段已留）、事件自动保留策略、语义检索、把 `scope` 从 cwd 升级为通用 workspaceId（留接口不动）。

## 附录 A. v0 JSONL → SQLite 导入映射（M2 精确规则）

v0 行只有两种，逐行规则如下；导入按文件顺序单事务执行，任何非法行默认 fail-loud 中止（`--skip-invalid` 显式降级才跳过）。

| v0 行 | 动作 |
|---|---|
| `{"v":1,"fact":{...}}`（该 id 首行） | scope = fingerprint.cwd（命令/文件两种都从指纹拆出）；指纹列 = 去 cwd 后的规范化 JSON；**若同 (scope,kind,fingerprint) 已有 is_current=1 的旧行（v0 的 resolved→新 id），同一事务先降旧行 is_current=0,status='superseded'**，再 `INSERT facts`（revision=1、is_current=1）；事件 `fact_recorded`（operation_kind=`import`），event_id = `import:<行sha256>` |
| `{"v":1,"fact":{...}}`（该 id 后续行） | `UPDATE facts`（revision+1，状态/证据/lastTransition 按行覆盖）；事件 `fact_updated`，event_id 同上规则 |
| `{"v":1,"hit":{factId,mode,at}}` mode=`warn` | 事件 `attempt_observed`（operation_kind=`import`）+ `counters.duplicate_failures_observed+=1, warnings_emitted+=1`；event_id = `import:<行sha256>` |
| `{"v":1,"hit":{...}}` mode=`block` | 事件 `attempt_denied`（operation_kind=`import`）+ `counters.calls_denied+=1` |

- **幂等**：v0 hit 行没有 tool_call_id，重放防护完全依赖 event_id（内容哈希——每行 `at` 唯一，行哈希即行身份）；v0 fact 行同 id 多版本按序折叠，最后一行胜出；**跨 id 的 current 切换按上表双写规则执行**（M2 验收含"resolved → 新 id"真实 fixture）。
- **导入报告**：行数 / 事实数 / 折叠版本数 / current 切换次数 / 命中行数 / 幂等跳过数 / 失败行（列出原因）。
- **不改 v0 语义**：导入只搬运，不重新裁决。

## 附录 B. M1 任务分解（接口落地清单）

1. **纯逻辑层抽出**（`src/pure.ts`）：`fingerprintKey`（去 scope 版）/`normalizeCommandLine`/`retryVerdict`/`mismatchedWitnessKinds`——零存储依赖，与两个适配器共享，现有单测原样迁移。
2. **接口与类型定稿**：`LedgerStore` v3（`commitAttemptDecision` 唯一裁决入口 / `transitionFacts` 批量 / `OperationMeta` / `LeaseSettlement` / operations 收据语义）按 §1 落地。
3. **`JsonlLedgerStore`**：包住现有引擎实现，行为与 v0 逐字节一致（消息文案、账本 JSONL 字节）。v0 无事件/lease 概念——`OperationMeta` 被忽略（记录为已知差异）；`commitAttemptDecision` 退化为"先查后写"的非原子路径（记录为已知差异，v0 本就单进程）；`settleLease/transitionFacts` 在本适配器 throw `unsupported`（M3 前插件不调用）。
4. **门面异步化**：`NegativeLedger` 方法改 `Promise`，内部委托 store；插件事件处理器本就异步，接线形态不变；"行为一致"指模型可见消息与账本内容逐字节一致，调用形态随接口异步化。
5. **M1 验收**：现有 57 测试改走接口后全绿 + demo 输出与 v0 一致 + real-mount smoke 通过。
