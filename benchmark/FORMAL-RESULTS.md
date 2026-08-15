# 正式实验审计摘要（formal）

生成日期：2026-08-14

## 实验身份

| 项 | 值 |
|---|---|
| 批次 | 第五次（前四次因采集器/场景缺陷整体作废，见 BENCHMARK.md「pilot」） |
| 规模 | 54/54 轮（6 场景 × 3 组 × 3 次），无超时、无非零退出 |
| 模型 | `deepseek-v4-flash`（全部轮次一致） |
| Harness commit | `47f9438…`（全部轮次一致，GATES.md 一致性检查无警告） |
| 插件代码 | `github.com/akslcw/dsh-negative-ledger`（正式实验所用代码，见 Release 标签 v0.1.0；CI 7/7 绿） |
| 实验目录 | `E:\code\dsh-negative-ledger-formal-050602ed\benchmark\runs\`（gitignored，保留审计） |

## 七道发布门槛

| 门槛 | 判定 | 数据 |
|---|---|---|
| G1 Block 重复失败较 Baseline 降低 ≥ 70% | PASS | baseline 9 → block 0，降低 100% |
| G2 Block 错误阻止 = 0 | PASS | wrongBlocks 0；denyOnMustNeverDeny 0 |
| G3 证据变化/TTL 后合法重试放行率 = 100% | PASS | 6/6（s3 文件证据 3/3、s4 TTL 3/3，每条含首个 `[exit code: 1]` 与后续同命令成功证据） |
| G4 Block 完成率 ≥ Baseline | PASS | 100% ≥ 100% |
| G5 跨代理重复降低 ≥ 80% | PASS | baseline 3 → block 0，降低 100% |
| G6 Warn 在重复压力轮注入提醒 | PASS | 全部重复压力轮注入 |
| G7 账本计数与会话日志一致 | PASS | deny/warn 计数与日志派生完全一致 |

## 措辞边界（PROTOCOL「阶段判定与措辞」）

- 上述数字为 formal 阶段（每格 3 轮）语料内观察值，标注模型与 Harness commit 使用。
- 「并发代理事务一致」由 M4 双进程验收测试（确定性，CI 矩阵 7/7）单独背书，G5 为行为补充。
- 前四批次（41/18/6/54 轮）已整体作废并保留原始数据，未混入任何统计。

## 发布记录

- npm：`@akslcw/dsh-negative-ledger@0.1.0` 已发布；GitHub Release：[v0.1.0](https://github.com/akslcw/dsh-negative-ledger/releases/tag/v0.1.0)（对应 Release 标签 v0.1.0 指向的提交）。
- npm：`@akslcw/dsh-negative-ledger@0.1.1` 已发布（latest）；GitHub Release：[v0.1.1](https://github.com/akslcw/dsh-negative-ledger/releases/tag/v0.1.1)（对应 Release 标签 v0.1.1 指向的提交）。注册表验证：12 文件含 `cordis.patch.yml`、`dsh.bundle.patch` 元数据可见、消费者安装 + ESM store 探针通过。
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
