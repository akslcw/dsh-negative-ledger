# 正式实验审计摘要（formal）

生成日期：2026-08-23

## 实验身份

| 项 | 值 |
|---|---|
| 批次 | `0.1.2` 兼容性重跑（此前余额不足批次整体排除，未混入本批统计） |
| 规模 | 54/54 轮（6 场景 × 3 组 × 3 次），无超时、无非零退出 |
| 模型 | `deepseek-v4-flash`（全部轮次一致） |
| Harness commit | `29d5790c91104e80593049d5e7c3ad6e92d42945`（`0.1.1-rc.2` 基线加 Windows spill 目录恢复修复；全部轮次一致） |
| 插件代码 | `release/0.1.2` 候选代码；运行时代码与 `0.1.1` 相同，本次发布只增加兼容元数据和文档 |
| 实验目录 | `E:\code\deepseekharness\deepseek-harness\dsh-negative-ledger\benchmark\runs\`（gitignored，保留审计） |

## 七道发布门槛

| 门槛 | 判定 | 数据 |
|---|---|---|
| G1 Block 重复失败较 Baseline 降低 ≥ 70% | PASS | baseline 9 → block 0，降低 100% |
| G2 Block 错误阻止 = 0 | PASS（契约层）/ 未评估（任务层） | 契约违反 0（场景 `mustNeverDeny` 键被 deny，决策时可判）；任务级误阻需决策时反事实探针，该批次**未采集** → 未评估，**不得引用为 0**；原 `wrongBlocks 0` 为观察项（deny 后同指纹成功），非误阻计数 |
| G3 证据变化/TTL 后合法重试放行率 = 100% | PASS | 6/6（s3 文件证据 3/3、s4 TTL 3/3，每条含首个 `[exit code: 1]` 与后续同命令成功证据） |
| G4 Block 完成率 ≥ Baseline | PASS | 100% ≥ 100% |
| G5 跨代理重复降低 ≥ 80% | PASS | baseline 3 → block 0，降低 100% |
| G6 Warn 在重复压力轮注入提醒 | PASS | 全部重复压力轮注入 |
| G7 账本计数与会话日志一致 | PASS | deny：warn 0/0、block 7/7；warn：6/6 |

## 分组汇总

| 组 | 轮次 | 完成率 | 重复失败 | 契约违反 | 任务级误阻 | 放行 | 跨代理 | token 进/出 |
|---|---|---|---|---|---|---|---|---|
| baseline | 18 | 100.0% | 9 | 0 | 未评估 | 6/6 | 3 | 85712/14098 |
| warn | 18 | 100.0% | 6 | 0 | 未评估 | 6/6 | 3 | 107702/13053 |
| block | 18 | 100.0% | 0 | 0 | 未评估 | 6/6 | 0 | 101146/14747 |

「任务级误阻」列原为「错误阻止」：该批次只采到了降级为观察项的 deny 后成功计数，没有决策时反事实真值，因此记未评估而**不是 0**（baseline/warn 组本就无 deny，其 0 是空真）。

## 措辞边界（PROTOCOL「阶段判定与措辞」）

- 上述数字为 formal 阶段（每格 3 轮）语料内观察值，标注模型与 Harness commit 使用。
- **门户口径修正（2026-09）**：本页 G2 与分组表原以「被 deny 的指纹在本轮内出现后续成功执行」为第二 oracle；该 oracle 无法区分「错误的 deny」与「当时正确、事后真被修复后合法放行」，已降级为观察项 `deniedThenLaterSucceeded`，不再计入门槛。原始逐轮结果未改写、也未重新计算；该批次没有决策时真值，故任务级误阻记 **未评估（unknown）**。可复核的契约层数字（`mustNeverDeny` 声明键被 deny 数）仍为 0。
- 「并发代理事务一致」由 M4 双进程验收测试（确定性，CI 矩阵 7/7）单独背书，G5 为行为补充。
- 2026-08-14 前四批次（41/18/6/54 轮）已整体作废并保留原始数据，未混入任何统计；第五次 54/54 正式批次曾支持 `0.1.1` 发布。
- 2026-08-23 首次兼容性重跑因 API 余额耗尽仅完成 27/54，整个批次已归档排除；充值后从空 `benchmark/runs/` 重跑的 54/54 才是本页数据。

## 发布记录

- npm：`@akslcw/dsh-negative-ledger@0.1.0` 已发布；GitHub Release：[v0.1.0](https://github.com/akslcw/dsh-negative-ledger/releases/tag/v0.1.0)（对应 Release 标签 v0.1.0 指向的提交）。
- npm：`@akslcw/dsh-negative-ledger@0.1.1` 已发布（latest）；GitHub Release：[v0.1.1](https://github.com/akslcw/dsh-negative-ledger/releases/tag/v0.1.1)（对应 Release 标签 v0.1.1 指向的提交）。注册表验证：12 文件含 `cordis.patch.yml`、`dsh.bundle.patch` 元数据可见、消费者安装 + ESM store 探针通过。
- `0.1.2` 候选增加 `@deepseek-ai/dsh-tools >=0.1.1-rc.2 <0.2.0` 可选 peer，不安装第二份 DSH 运行时；发布前验证以本次兼容性重跑为准。
- 任何再发布必须升版本：npm 不允许覆盖已发布的版本。
- 源码 `package.json` 的 bin 路径已按 npm 发布期归一化对齐（`dist/bin.mjs`），下一次发布不再产生 `script name was cleaned` 警告。
- `0.1.1` 为可一条命令安装的 bundle 形态（`dsh.bundle` + `cordis.patch.yml`），端到端验证通过（见 BENCHMARK.md 与 smoke）。
- 收录：awesome-dsh-plugin 精选列表 Memory 分类（英/中各一行），PR [#348](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/348) 已合并。

## 复算方式

```powershell
git clone https://github.com/akslcw/dsh-negative-ledger.git
cd dsh-negative-ledger
npm ci --ignore-scripts
.\benchmark\run-formal.ps1   # 需 DSH_CHECKOUT + DEEPSEEK_API_KEY
# 产物: benchmark/runs/summary.json + benchmark/runs/GATES.md + formal-plan.json
```
