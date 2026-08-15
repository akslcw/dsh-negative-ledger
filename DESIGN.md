# dsh-negative-ledger — 设计文档（第 0 阶段：边界）

> 状态：定稿。本文件定义 v0（单进程 JSONL）的边界与关键决策；多代理基础件的 SQLite 存储里程碑见 [DESIGN-SQLITE.md](DESIGN-SQLITE.md)。

## 1. 是什么，不是什么

dsh-negative-ledger 是一个给 Agent 用的**失败知识账本**：记录已被证伪/失败/不可行的路径、当时的证据、以及何时可以重试；证据变化时自动失效。

- 不是通用 memory：不存正面知识、不做语义回忆。
- 不是 cache：不缓存工具结果，只存"这条路不通"的结论。
- 不是 bug regression tracker：不追踪修复、不链测试；与 regressionledger 的差异是覆盖任意工具调用/文件读取，而非仅 bug 修复。
- 核心创新：**负结论 + 证据哈希 + 重试条件 + 自动失效 + 节省度量**。生态调研确认该四合一无产品做成（koi 只提去重、aider 只有读缓存、regressionledger 只管 bug 修复、记忆系无失效）。

## 2. 最小成功标准

Agent 第二次准备重复同一失败动作时，系统基于旧证据提醒/阻止；当证据变化，系统自动撤销该提醒。

## 3. MVP 场景

- S1 重复失败命令：首次失败记录（命令指纹 + 退出码），再次执行前命中 → warn（默认）/ block。
- S2 重复读取不存在文件：首次 ENOENT 记录（路径 + `fs/observed` 的 absent file-state 见证），再次读取前命中 → warn。
- S3 证据变化自动失效：前提证据（目录/文件/env）哈希变化 → active 变 stale，允许重试；重试成功 → resolved。
- S4 统计：本轮命中几条负结论、拦截/提醒几次、省几次工具调用、估算省多少 token。

## 4. 数据模型

见 `src/types.ts`。要点：

| 字段 | 说明 |
|---|---|
| fingerprint | 确定性查询键；只有它决定"两次尝试是否同一动作"，claim 永不参与匹配 |
| evidence | 分两个角色：outcome（退出码/stderr，证明失败发生过，永不触发失效）；precondition（目录清单/文件内容/env/repo 状态哈希，变化即失效） |
| retryCondition | 默认 evidenceChanged；可 never/manual/after/anyOf |
| status | active/stale/resolved/superseded，**派生值**：由每个指纹最新追加行得出 |
| savings | warned/blocked/attemptsSaved 计数器，内置度量 |

## 5. 关键决策

- D1 证据绑定：每条事实至少一个 outcome witness；失效只由 precondition witness 驱动，claim 仅作注解（防负记忆 confabulation）。
- D2 保守失效：任一 precondition 不匹配 → stale；stale 不删除、不自动复活，表示"可重试一次"。
- D3 追加式存储：JSONL 一行一个事实版本，旧行保留作审计史；当前状态 = 每指纹最新行。与 DSH 会话日志同构，CLI 直接读文件。MVP 后可在同接口下换 SQLite。
- D4 精确匹配：v0 只做指纹精确匹配，不做语义相似/向量检索。
- D5 策略三档：off/warn/block，默认 warn；warn 用 additionalContexts 注入（repeat-tool-reminder 先例），绝不改写工具结果。
- D6 度量诚实：token 节省 = attemptsSaved × 可配置单次调用估算值，输出必须标注"估算"。
- D7 同命令判定：tool + 原始 commandLine（仅 trim，不压缩空白——压缩会把 `printf "a  b"` 与 `printf "a b"` 并成一条）+ cwd；规范化在引擎所有入口统一应用并测试。
- D8 自动记录的命令事实带短 `after` TTL（默认 5 分钟）：block 模式到期自动放行，杜绝永久锁死；`never`/`manual` 只留给显式、可信来源记录的事实。
- D9 诚实指标：`duplicateFailuresObserved`（重复失败实际发生）/ `warningsEmitted`（发出的警告）/ `callsDenied`（派发前 deny，唯一确定避免执行的计数）。不做 token 估算——轨迹实验室（#4）拥有该数字。
- D10 安全边界：claim 不含原始命令，模型可见预览控制字符清理并限长；原始命令仅存于指纹（账本文件 0600、目录 0700）；拦截适用性按每次查询的当前证据派生，stale 只是历史事件。

## 6. 引擎 API（第 2 阶段）

存储：JSONL 两种行——事实版本 `{"v":1,"fact":{...}}`（含 lastTransition 审计）与拦截计数 `{"v":1,"hit":{factId,mode,at}}`；当前状态 = 每 id 最后一行，同指纹旧条目派生 superseded；savings 由 hit 行求和（warn → 重复失败观察 + 警告，block → deny），跨进程持久。文件 0600、目录 0700。SQLite（WAL）为发布里程碑。

- recordNegativeFact(input) → NegativeFact（active/stale 同指纹 → 同一 id 追加证据版本，指标不分裂；resolved 后再次失败 → 新 id，旧条目派生 superseded）
- queryRelevantFacts(attempt) → FactMatch[]（读穿失效：precondition 不匹配时自动落 stale 行）
- invalidateFacts(current) → InvalidatedFact[]（active→stale 转换；只认"明确不同"的当前值，缺信息按未变处理）
- markResolved(fingerprint) → 使当前条目 resolved（插件在成功结果时调用，闭环"重试成功"）
- recordHit(id, 'warn' | 'block') → 拦截计数（插件执行拦截后调用）
- summarizeSavings() → SavingsSummary（attemptsSaved × tokensPerCall 的估算值）

verdict 表（precondition 全部匹配时）：无条件 → warn（证据未变，建议拦截）；never/manual/after-未到/anyOf-未满足 → block（重试条件不满足）；after-已到/anyOf-已满足 → allow（放行且不打扰）；precondition 不匹配或已 stale → stale-allow；无事实或 resolved/superseded → 无匹配。引擎 verdict 是知识裁决：warn 模式只提醒，block 模式 deny block/warn、放行 allow/stale-allow。

## 7. DSH 接入（第 3 阶段：已实现，`src/plugin.ts`）

- `tools/pre-execute`（waterfall，必 next()）：block 模式对 block/warn 裁决返回 deny（`PreToolDecision` 无 context 通道，deny 是唯一前置通道）；被 deny 的调用仍会流经 post-execute，以插件自己的 deny 前缀识别并跳过，避免同一次尝试双计。
- `tools/post-execute`（waterfall，必 next()）：先查账本（读穿失效）再记录；warn 裁决与 stale-allow 通知以 additionalContexts 注入（repeat-tool-reminder 先例），绝不改写工具结果；非零 exitCode 的 bash/pwsh 成功结果 → command_failed 事实；`FS_NOT_FOUND` 的 read 错误 → file_missing 事实（模型路径 + displayPath 双键见证）；成功结果 → markResolved 闭环。
- `fs/observed`（emit，同步）：`{ present+version | absent }` 一一映射为 file-state 前提证据；通过 actor 关联发出观察的 exec，把模型传入路径与解析后的 displayPath 双向归一；每次观察变化即调 invalidateFacts（只认明确不同的当前值）。
- 命令指纹 cwd：显式 workdir 优先，否则回退调用 agent 的 session cwd（与 bash 工具的默认 workdir 派生一致）；查询与记录共用同一指纹构造，键永不漂移。
- 会话内即时 report：每次拦截的上下文自带累计统计行（attemptsSaved × tokensPerCall，标注估算）；任务级报表归 CLI（第 5 阶段）。
- 与 repeat-tool-reminder 的边界：它是同会话连续字节级重复的临时提醒；ledger 是跨会话、带证据、可失效的持久账本。
- 账本状态跨代理共享（单实例闭包）；savings 随 hit 行持久，跨进程可见。

## 8. 非目标（v0）

正面记忆；语义相似检索；多代理共识/同步协议；自动派验证代理（#2）；替代压缩（#3）；并发写冲突协议（MVP 单进程单写者）。

## 9. 与后续方向的接缝

- #1 契约：子代理结果增加 failed_attempts 字段，喂入账本；
- #3 检查点：active/stale 负结论投影进任务状态；
- #4 轨迹实验室：按 prompt/模型统计重复失败率（消费 savings 数据）；
- #2 门禁：高风险失败路径可提升为 fail-closed 规则。

## 10. 计划评审结论

原计划的结构与顺序通过；修正五点：①按里程碑而非按天承诺；②引擎单测在第 2 阶段而非第 5 阶段；③"同一命令"指纹定义进模型；④file_missing 证据用 DSH `fs/observed` 的 file-state 见证，避免插件自行哈希父目录；⑤evidence 分 outcome/precondition 两角色并加 markResolved。npm 发布时使用自有 scope（`@deepseek-ai/` 归 DeepSeek），以 dsh-plugin topic 标注。
