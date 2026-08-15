# 对照实验协议（PROTOCOL）

目的：用行为数据证明 Negative Ledger 相比 DSH 官方 `repeat-tool-reminder` 多解决了什么——减少重复失败调用、不降低完成率、不阻止证据变化后的合法重试、阻断跨代理重复。

## 三组配置

| 组 | 配置 | overlay |
|---|---|---|
| Baseline | 官方 `repeat-tool-reminder`（dsh-base 默认开启） | `profiles/baseline.patch.yml`（空 overlay） |
| Warn | 关闭官方 reminder；Negative Ledger `backend: sqlite, mode: warn` | `profiles/warn.patch.yml` |
| Block | 关闭官方 reminder；Negative Ledger `backend: sqlite, mode: block` | `profiles/block.patch.yml` |

Warn/Block overlay 携带实验专用 `commandRetryAfterMs: 1000`（1 秒 TTL，仅为了让 s4 在单会话内走完"失败 → TTL 到期 → 放行"；插件生产默认值不变，s1–s3/s5/s6 不涉及命令重试，不受影响）。

## 统一控制变量

- 同一 DSH 版本与 commit：`git -C $DSH_CHECKOUT rev-parse HEAD` 记录在每轮 metadata。
- 同一模型与参数：模型名记录在 metadata；参数不手工干预（默认 headless profile 默认值）。
- 同一提示词：来自 `scenarios/<id>.json` 的 `prompt` 字段。
- 同一初始工作区：`scenarios/<id>/seed/` 每次全新复制到轮次工作区。
- 每轮全新会话：`DSH_HOME` 指向轮次专属目录。
- 每轮全新 SQLite：ledger 目录由 overlay 模板替换为轮次专属路径。
- 每轮超时与 token 上限：`timeoutMs` / `maxTokens` 在 scenario JSON 中声明，由 run.ts 执行（超时杀进程、token 从会话日志统计）。
- 三组运行顺序随机化：`benchmark/run-formal.ps1` 用固定 seed（默认 `20260814`，可用 `NEGLEDGER_SEED` 覆盖）做 Fisher–Yates 洗牌，**计划顺序在开跑前写入 `runs/formal-plan.json`**，实际执行顺序由 `runs/manifest.jsonl` 的逐行时间戳记录；计划与实况可对账。

## 采集（每轮）

- DSH session log（原始 zstd + 解码 jsonl）
- Negative Ledger SQLite（存在时拷贝）
- 最终 stdout（模型回答）
- 工具调用序列（从 session 日志派生）
- deny/warn 事件（inbox-spliced 的 negative-ledger 通知 + 账本计数）
- token 用量（session usage 事件求和）
- 开始/结束时间（首/末事件时间戳）
- 任务成功判定：`success` 双条件——① `report` 标记必须出现在**最终 assistant 消息的可见文本**里（reasoning/thinking 块一律排除，模型"我知道标记会是 X"不算成功）；② 场景声明 `evidence` 时，标记必须以**独立输出行**（trim 后整行相等）出现在对应工具的 result 输出里，且该结果非 error、`repeat: true` 时还必须来自**第二次同一 call key**（同工具同参数）的调用——命令回显里夹带标记的长行不算，第一次调用的输出不算。任一缺失即 FAIL，并记录 `successSource`（full/report-only/evidence-only/none）与 `successReport`/`successEvidence` 两个布尔。

## 试验轮（阶段 5）

18 轮（6 场景 × 3 组 × 1 次）。只检查：场景能否稳定触发、指标能否提取、三组工作区一致、成功判定可自动完成。可修采集器，**不得**根据结果调整插件策略或默认参数。

## 正式实验（阶段 6）

54 轮（6 场景 × 3 组 × 3 次）。分批执行并设 API 预算；单轮失败/超时也必须保留记录，不剔数据。

## 发布门槛（阶段 7）

- Block 重复失败次数较 Baseline 降低 ≥ 70%
- Block 错误阻止次数 = 0（双 oracle：① 场景声明的 `mustNeverDeny` 键（事后必须合法的调用）被 deny 计数 = 0；② 被 deny 的指纹在本轮内出现后续成功执行 = 0。两者都不覆盖的 deny 无法事后验证，逐条保留在 result.jsonl 的 `ledger.denies` 中作为审计数据，不计入门槛）
- 证据变化后的合法重试放行率 = 100%（scenario JSON 的 `requiredAllow` 全部执行且成功；s3 测**文件证据**（write→fs/observed 失效→放行），s4 测**命令 TTL**（等待超过 `commandRetryAfterMs` 后同命令放行）——两种放行机制分开测，不混为一个测试）
- Block 任务完成率 ≥ Baseline
- 跨代理重复降低 ≥ 80%（子会话指纹与父会话失败指纹的交集计数）
- Warn 向模型注入提醒：**条件蕴含**——s1（提醒压力场景）的 warn 轮中，凡实际出现 ≥2 次同指纹失败调用的轮次，必须存在 negative-ledger inbox 注入；模型未重复的轮次豁免（前置条件不存在，无法触发也不计 FAIL）
- SQLite 账本计数与 session 日志派生统计一致（同轮交叉校验）
- 环境一致性：所有轮次必须同一模型、同一 harness commit（GATES.md 顶部标注两者；不一致在 GATES.md 记警告，不静默混池）

## 指标口径

| 指标 | 计算 |
|---|---|
| 重复失败调用 | 同 (tool, 规范化 args) 在一次失败后、无同指纹成功执行介于其间、且证据未变（账本组：fingerprint 命中）时再次执行 |
| 任务完成率 | success 双条件同时满足：最终 assistant 可见文本含 report 标记 +（声明 evidence 时）对应工具非 error 输出含 evidence 标记 |
| 错误阻止率 | 双 oracle：mustNeverDeny 声明键被 deny 数 + 被 deny 后同指纹成功执行数 |
| 合法重试放行率 | requiredAllow 中成功执行的比例 |
| 跨代理重复 | 子会话（delegationDepth > 0）中执行、且父会话已失败过的指纹计数 |
| token | session usage 事件 input/output 求和 |
| 时间 | 末事件 − 首事件 |

## 阶段判定与措辞

- `pilot`：任何少于 18 轮的局部验证（例如受限环境里缺 s4 的 16 轮）——只证明采集链路与核心行为，**不作为效果结论**，GATES.md 标注 `[pilot, 非正式结论]`。
- `trial`：协议定义的 18 轮单次试验——验证场景触发与指标可提取。
- `formal`：每个 scenario×profile 格 ≥ 3 轮（54 轮）——唯一可作为效果结论并对外引用数字的阶段。
- 对外宣传中的数字（如"降低 X%""错误阻止为零"）只允许来自 formal 阶段的 GATES.md，且必须附模型名与 harness commit。
- 无效数据（如被判定为采集器缺陷的批次）不混入统计：整体作废、标注原因、原数据保留备审。
