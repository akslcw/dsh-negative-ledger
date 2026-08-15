# dsh-negative-ledger

给编码 Agent 用的**失败知识账本**。它只记录**已被证伪的路径**——失败的命令、不存在的文件、被否定的方案、不可用的 API——连同每条结论背后的证据、以及何时可以重试。证据变化时，结论自动失效。

[English](README.md)

## 不是什么

- 不是 memory：不存正面知识、不做语义回忆。
- 不是 cache：存的是结论，不是工具结果。
- 不是 bug regression tracker：覆盖任意工具调用与文件读取，而非仅 bug 修复。

## 核心循环

1. 一次工具调用失败（非零退出码、`FS_NOT_FOUND` 等）→ 记录一条**负结论**：outcome 见证（退出码、错误码）+ precondition 见证（来自 DSH `fs/observed` 的文件状态）。
2. 下一次相同尝试按**指纹**命中（规范化命令 + cwd，或文件路径）。
3. 只要所有 precondition 见证未变，该尝试被**提醒**（`warn` 模式）或**阻止**（`block` 模式）。
4. 任一 precondition 变化 → 结论变 **stale**，提醒自动撤销、允许重试；重试成功 → **resolved**。

差异化：**DSH 原生、证据约束的持久负面记忆门禁**——失败结论随环境证据自动生效与吊销，并在并发代理之间保持事务一致。

## 快速开始：一条命令安装

```sh
dsh plugin --profile <name> add @akslcw/dsh-negative-ledger
```

安装并激活 bundle 层：随包发布的 `cordis.patch.yml`（由 `dsh.bundle` 清单声明）以生产默认值挂载账本策略——sqlite 后端、`warn` 模式、`.ledger` 目录、默认 TTL。先不启动、验证组合，再启动：

```sh
dsh --profile <name> --dump-config   # 可见 "@akslcw/dsh-negative-ledger" 层与 negative-ledger 行
dsh --profile <name>                 # 启动
```

卸载：`dsh plugin --profile <name> remove @akslcw/dsh-negative-ledger`。干净环境端到端 smoke（安装 → 层可见 → headless warn + sqlite 账本 → 卸载 → profile 仍可启动）：`powershell -File smoke/plugin-add-smoke.ps1`。

> **pnpm 11 注意**：pnpm ≥11 把「忽略构建脚本」升级为硬错误，`add` 会以 `ERR_PNPM_IGNORED_BUILDS: better-sqlite3` 失败。better-sqlite3 随包自带官方预编译产物，被忽略的脚本完全无害、不需要编译。在 profile 目录执行 `pnpm config set --location project strict-dep-builds false` 后重跑 `add` 即可。（若改为允许构建，则会从源码编译 better-sqlite3，需要 C++ 工具链。）

仅引擎 + CLI（checkout 内调试，不挂 DSH 组合）：

```sh
node src/cli.ts --dir .ledger stats
node demos/run-demos.ts      # S1 命令去重 / S2 缺失文件去重 / S3 证据失效，自带验收断言与节省报告
```

要求 Node `^22.19.0 || >=24.0.0`（与官方 DSH 的 engines 范围对齐）。

## CLI

```
node src/cli.ts [--dir <path>] [--backend sqlite|jsonl] <list | show <id> | stale | stats>
```

显式 `--backend` 优先；否则按目录自动识别（`ledger.db` → sqlite、`ledger.jsonl` → jsonl）；两者皆无时使用主后端 sqlite。

| 命令 | 输出 |
|---|---|
| `list` | 全部事实：status、kind、id、claim |
| `show <id>` | 单条事实的格式化 JSON |
| `stale` | 因证据变化而失效的事实 |
| `stats` | 三个诚实指标：重复失败观察、警告发出、调用阻止 |

## 引擎 API

两个存储后端共用同一 `LedgerStore` seam：默认的事务性 SQLite 存储（`SqliteLedgerStore`：WAL、revision 乐观并发、操作收据、retry lease、JSONL 导入）与旧版单进程 JSONL 存储（`JsonlLedgerStore`）。

- `getFact(scope, kind, fingerprint)` / `queryFacts(filter)` — 当前事实（含 revision 与活跃 lease 摘要）。
- `commitAttemptDecision(request)` — 唯一裁决入口：`deny` / `observe-warn` / `verify-retry`（allow 与 stale-allow 都竞争 lease）；revision 冲突重读重算。
- `recordFact(input, meta)` — 记录被证伪的路径；重复追加同一 id 的版本；按操作收据与 `(fact, toolCallId, operation_kind)` 幂等。
- `transitionFacts(batch, meta)` — 批量全或无的状态转换（一次 FS observation 可失效多个 fact）。
- `settleLease(settlement)` — 持有者的重试结果：成功 → resolved，失败 → 新证据版本，取消 → 事实不动。
- `summarize(scope?)` — 三个诚实指标：`duplicateFailuresObserved` / `warningsEmitted` / `callsDenied`。不做 token 估算——那归轨迹实验室（#4）的 A/B 与回放 diff。

## DSH 接入

随包发布的 bundle 层即：

```yaml
- id: negative-ledger
  name: '@akslcw/dsh-negative-ledger'
```

在更后层的 patch（你的 profile 的 `cordis.patch.yml`）中按 `id` 覆盖该行——patch 会整体替换 `config`，改哪个键就重写全部：

```yaml
- id: negative-ledger
  name: '@akslcw/dsh-negative-ledger'
  config:
    backend: sqlite       # sqlite（默认，事务性）| jsonl（旧版单进程）
    mode: block           # off | warn | block（默认 warn）
    dir: .ledger          # 账本目录（默认 .ledger）
    commandRetryAfterMs: 300000   # 自动记录的命令事实的重试 TTL
    commandTools: [bash, pwsh]   # 记录为 command_failed
    readTools: [read]            # 记录为 file_missing
```

- 存储连接与后台失效队列由插件 fiber 持有：卸载时先 drain 队列再关闭存储（HMR 安全）。

- `warn`（默认）：在 `tools/post-execute` 注入 `additionalContexts`；绝不阻止、绝不改写工具结果。
- `block`：在 `tools/pre-execute` 派发前 deny。被 deny 的调用仍会流经 post-execute，插件以自己的 deny 前缀识别并跳过，同一次尝试绝不双计。
- 自动记录的命令事实带短 `after` TTL（`commandRetryAfterMs`，默认 5 分钟）：block 模式到期自动放行，不会因瞬时故障永久锁死命令。`never`/`manual` 只留给显式、可信来源记录的事实。
- `off`：完全关闭记录与拦截。
- `fs/observed` 事件（`present`+version 或 `absent`）与 `file-state` 前提见证一一映射；通过 actor 关联发出观察的 exec，模型传入路径（按 session cwd 作用域化）与解析后的 displayPath 双键见证同一事实；每次观察变化即驱动失效，全程无需自己哈希文件。
- 成功结果经结算或无 lease 转换达成 resolved——重试成功后提醒撤销。
- 账本跨代理共享（子代理不重复父代理的失败）；计数在 sqlite 后端为事务列，在 jsonl 后端为追加式 hit 行。

安全姿态：

- claim 绝不包含原始命令文本；模型可见的预览经控制字符清理并限长。原始命令保留在账本文件里（它就是指纹）——文件以 0600 写入、目录 0700。
- 账本内容以引用的数据渲染，绝不当作指令注入。
- 单写者 JSONL 仅限旧版后端；sqlite 后端为多进程（WAL）。

与 `repeat-tool-reminder` 的边界：它是对会话内连续字节级重复的临时提醒；本账本是跨会话、绑定证据、自动失效的持久知识。

## 已知限制与后续

- **单写者 JSONL（旧版）**：`backend: jsonl` 保留 v0 单进程存储，供迁移与调试；该后端不支持多进程并发写。默认的 `backend: sqlite` 是事务性 WAL 存储，带唯一索引、幂等操作收据与崩溃恢复。
- 命令指纹使用调用 agent 的 session cwd；沙箱策略覆盖的 workspace root 对插件不可见。原始命令文本完整保留（不压缩空白），语义不同的 shell 程序不会碰撞，但等价改写的命令会各算一条。
- 非零退出码不总是"路径被证伪"（如 `grep` 无匹配退出 1）；短 TTL 与 warn 默认姿态限定了损害，按工具细分记录策略留待后续。
- v0 只做指纹精确匹配，无语义相似检索。
- `approach_rejected`、`api_unavailable` 两类已进数据模型，尚未接线到工具。
- 有意不做 token 估算；轨迹实验室（#4）拥有 A/B 与回放 diff。
- 后续接缝：子代理契约结果携带 failed_attempts（#1）、active/stale 负结论投影进任务检查点（#3）、轨迹回归统计重复失败率（#4）、高风险失败路径提升为 fail-closed 规则（#2）。
