# 对照实验协议（PROTOCOL）

目的：用行为数据证明 Negative Ledger 相比 DSH 官方 `repeat-tool-reminder` 多解决了什么——减少重复失败调用、不降低完成率、不阻止证据变化后的合法重试、阻断跨代理重复。

## 三组配置

| 组 | 配置 | overlay |
|---|---|---|
| Baseline | 官方 `repeat-tool-reminder`（dsh-base 默认开启） | `profiles/baseline.patch.yml`（空 overlay） |
| Warn | 关闭官方 reminder；Negative Ledger `backend: sqlite, mode: warn` | `profiles/warn.patch.yml` |
| Block | 关闭官方 reminder；Negative Ledger `backend: sqlite, mode: block` | `profiles/block.patch.yml` |

## 统一控制变量

- 同一 DSH 版本与 commit：`git -C $DSH_CHECKOUT rev-parse HEAD` 记录在每轮 metadata。
- 同一模型与参数：模型名记录在 metadata；参数不手工干预（默认 headless profile 默认值）。
- 同一提示词：来自 `scenarios/<id>.json` 的 `prompt` 字段。
- 同一初始工作区：`scenarios/<id>/seed/` 每次全新复制到轮次工作区。
- 每轮全新会话：`DSH_HOME` 指向轮次专属目录。
- 每轮全新 SQLite：ledger 目录由 overlay 模板替换为轮次专属路径。
- 每轮超时与 token 上限：`timeoutMs` / `maxTokens` 在 scenario JSON 中声明，由 run.ts 执行（超时杀进程、token 从会话日志统计）。
- 三组运行顺序随机化：`--order random`（默认按 profile 字典序；正式实验用随机序并记录到 runs/manifest.jsonl）。

## 采集（每轮）

- DSH session log（原始 zstd + 解码 jsonl）
- Negative Ledger SQLite（存在时拷贝）
- 最终 stdout（模型回答）
- 工具调用序列（从 session 日志派生）
- deny/warn 事件（inbox-spliced 的 negative-ledger 通知 + 账本计数）
- token 用量（session usage 事件求和）
- 开始/结束时间（首/末事件时间戳）
- 任务成功判定（stdout 含 `successMarker`）

## 试验轮（阶段 5）

18 轮（6 场景 × 3 组 × 1 次）。只检查：场景能否稳定触发、指标能否提取、三组工作区一致、成功判定可自动完成。可修采集器，**不得**根据结果调整插件策略或默认参数。

## 正式实验（阶段 6）

54 轮（6 场景 × 3 组 × 3 次）。分批执行并设 API 预算；单轮失败/超时也必须保留记录，不剔数据。

## 发布门槛（阶段 7）

- Block 重复失败次数较 Baseline 降低 ≥ 70%
- Block 错误阻止次数 = 0（判定：被 deny 的指纹在本轮内出现后续成功执行）
- 证据变化后的合法重试放行率 = 100%（scenario JSON 的 `requiredAllow` 全部执行且成功）
- Block 任务完成率 ≥ Baseline
- 跨代理重复降低 ≥ 80%（子会话指纹与父会话失败指纹的交集计数）
- Warn 向模型注入提醒的轮次占比 = 100%（存在 negative-ledger inbox 通知）
- SQLite 账本计数与 session 日志派生统计一致（同轮交叉校验）

## 指标口径

| 指标 | 计算 |
|---|---|
| 重复失败调用 | 同 (tool, 规范化 args) 在一次失败后、无同指纹成功执行介于其间、且证据未变（账本组：fingerprint 命中）时再次执行 |
| 任务完成率 | stdout 含 successMarker |
| 错误阻止率 | 被 deny 的指纹在本轮内出现后续成功执行 ÷ 总 deny 数 |
| 合法重试放行率 | requiredAllow 中成功执行的比例 |
| 跨代理重复 | 子会话中执行、且父会话已失败过的指纹计数 |
| token | session usage 事件 input/output 求和 |
| 时间 | 末事件 − 首事件 |
