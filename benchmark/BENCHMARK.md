# Benchmark：与官方 repeat-tool-reminder 的对照实验

三组对照（协议全文见 [PROTOCOL.md](PROTOCOL.md)）：Baseline 只挂官方 `repeat-tool-reminder`；Warn / Block 关闭官方 reminder、挂载 Negative Ledger（sqlite 后端，warn / block 模式）。六个场景（[scenarios/](scenarios/)）覆盖重复失败、替代路径、证据变化放行、命令 TTL 重试、跨代理传播、相似命令不误判。

## 前置条件

1. 本机有可用的 `DEEPSEEK_API_KEY`（并设好 `DEEPSEEK_BASE_URL`，如需）。
2. 本仓库 `npm install` 完成（采集器需要 better-sqlite3 只读账本）。
3. 一份**已构建**的 DeepSeek Harness checkout：
   ```powershell
   # 在 deepseek-harness 根目录
   pnpm install
   pnpm run build   # 生成 apps/cli/lib/bin.js
   ```
4. 试验/正式轮全程使用**同一个 checkout 提交**（采集器会记录 `harnessCommit` 用于对齐）。

每轮生成的 patch overlay 由 run.ts 写入 `runs/<s>/<p>/<i>/patch.yml`：插件 specifier 用 `file://` URL 指向本仓库 `src/plugin.ts`，账本目录为该轮专属绝对路径（模板见 `profiles/*.patch.yml` 的 `__PLUGIN_PATH__`/`__LEDGER_DIR__` 占位符）。受限环境（如沙箱 runner 无法捕获子进程 piped stdio）设 `NEGLEDGER_STDIO=inherit`：CLI 直接接管终端，成功判定改由解码后的 session 事件完成，result 中记录 `stdioMode: inherit`。

## 试验轮（18 轮：6 场景 × 3 组 × 1 次）

目的：验证场景触发稳定、指标可提取，不形成正式结论。

```powershell
cd dsh-negative-ledger
$env:DSH_CHECKOUT = "E:\path\to\deepseek-harness"
$env:DEEPSEEK_API_KEY = "<key>"

# 只跑一个场景的三组
node benchmark/run.ts s1-missing-read-repeat baseline 1
node benchmark/run.ts s1-missing-read-repeat warn 1
node benchmark/run.ts s1-missing-read-repeat block 1

node benchmark/summarize.ts
```

检查要点：

- 每轮产物 `benchmark/runs/<scenario>/<profile>/<iter>/` 下有 `result.jsonl`、`session-logs/`、`session-decoded/`、`ledger-db/`（warn/block 组）、`scenario-resolved.json`（平台解析后的场景）。
- 成功判定是双条件：`report` 标记必须在**最终 assistant 可见文本**（reasoning 不算），声明 `evidence` 的场景还必须以**独立输出行**出现在**对应工具的非 error 输出**里，且 `repeat: true` 时要求来自**第二次同一 call key**（同工具同参数）——命令回显里夹带标记的长行不算、第一次调用不算；`result.jsonl` 的 `successReport`/`successEvidence` 两个布尔可直接核对。
- Baseline 的 s1 应产生 ≥2 次重复失败（模型可能不听话，看 stdout 与工具序列核对）。
- Block 的 s3/s4 必须出现「先失败 → 合法重试成功」；若模型不按脚本走（例如直接 write 不先 read），先修提示词，**不改插件**。
- **s3 与 s4 测两种不同的放行机制，不要混**：s3 测**文件证据**（write 触发 fs/observed 失效 → 重读放行）；s4 测**命令 TTL**（warn/block overlay 设 `commandRetryAfterMs: 1000`，首次命令失败 → 执行 `__SLEEP_COMMAND__` 等待超过 TTL → 创建 flag.txt → 执行**完全相同**的命令 → 因 TTL 到期放行，而不是伪装成文件写入自动失效）。
- s4 是平台自适应的：Windows 用 `pwsh` 工具执行 PowerShell 命令，Linux/macOS 用 `bash` 工具执行 POSIX 命令（见 `scenarios/s4-command-ttl-retry.json` 的 `command`/`sleep` 字段，由 run.ts 按 `process.platform` 解析）；第一步与第四步必须是**完全相同**的命令串。
- 采集器问题（崩溃、字段缺失、解码失败）修 `benchmark/*.ts` 后重跑受影响轮次。

## 正式实验（54 轮：6 场景 × 3 组 × 3 次）

**用干净副本跑**，不要在本仓库开发目录上 `reset --hard`（本地历史与远端不同源）：

```powershell
git clone https://github.com/akslcw/dsh-negative-ledger.git E:\code\dsh-negative-ledger-release
cd E:\code\dsh-negative-ledger-release
npm ci --ignore-scripts
$env:DSH_CHECKOUT = "E:\path\to\deepseek-harness"
$env:DEEPSEEK_API_KEY = "<key>"
.\benchmark\run-formal.ps1          # 54 轮 + summarize；单轮失败/超时保留记录，不剔数据
.\benchmark\run-formal.ps1 -PlanOnly  # 只看计划不跑（顺序已写入 runs/formal-plan.json）
```

- 顺序：固定 seed（`20260814`，可用 `NEGLEDGER_SEED` 覆盖）Fisher–Yates 洗牌；计划在开跑前写入 `runs/formal-plan.json`，实际顺序由 `runs/manifest.jsonl` 时间戳记录。
- 每轮 token 预算见 `scenarios/<id>.json` 的 `tokenBudget`；分批执行时注意：`run-formal.ps1` 一次跑完 54 轮，需要中断时直接 Ctrl-C，已完成的轮次不会丢，但**重新执行会按新 seed 顺序补跑并覆盖同格结果**——断点续跑请按 `runs/manifest.jsonl` 里缺失的格手动 `node benchmark/run.ts <s> <p> <i>` 补齐。
- 运行顺序影响：三组共享控制变量（同一 checkout、同一提示词、全新 DSH_HOME 与账本），但模型输出本身有方差——因此每组各 3 次取聚合，正式结论以 `benchmark/runs/GATES.md` 的 7 道门槛为准。GATES.md 标注阶段：只有每格 ≥3 轮的 `formal` 数字可用于对外宣传（并附模型名与 harness commit）；18 轮单次是 `trial`，更少是 `pilot`。
- **无效批次不混入统计**：若发现采集器缺陷导致整批数据不可信（例如成功判定误报），该批次整体作废、在 GATES.md 中标注原因，原始数据保留备审，然后从新目录重跑全部 54 轮——不补跑、不拼接。

## pilot（已完成的局部验证）

受限环境内已完成 s1/s2/s3/s5/s6 × 3 组 + s4 baseline 探测共 16 轮：采集链路、7 道门槛计算、插件 warn/block/放行/跨代理行为全部验证，GATES.md 标注 `[pilot, 非正式结论]`。**pilot 数字不代表效果结论**。

2026-08 的两个正式批次因采集器/场景缺陷整体作废、未写成 benchmark 结果（原始数据保留备审）：
- 批次一（41/54 轮）：① 成功标记曾在全量 session 文本中搜索，模型的 reasoning 引用标记也会判成功；② 当时 s4 依赖 POSIX `sh`，在 Windows DSH（pwsh 工具）上测到的是 shell 兼容性而非插件行为。
- 批次二（18/54 轮）：s4 的预期与插件已确定的命令重试语义不一致——命令失败默认按 `after` TTL 放行，写文件不会自动失效 `command_failed`，Block 返回 `retry condition not met` 是正确行为；且第一次失败的 pwsh 输出回显整条命令（含标记文本），旧 evidence 判定误报 `successEvidence=true`。
- 批次三（6/54 轮）：`read` 工具的真实输出是带行号的展示文本 `1: ALT-CONTENT-42`，旧 evidence 的整行严格相等判定把 s2（以及同样依赖 read 证据的 s3/s6）的真实成功误判为失败。
- 批次四（54/54 轮完整，但 G3=3/6）：DSH 中 `pwsh` 退出码 1 是**非错误**工具结果、文本含 `[exit code: 1]`；汇总器只认 `isError=true` 的首次失败，漏掉 s4 三次 TTL 场景的失败前置（插件本身正确放行，原始日志三条均记录失败→等待→同命令成功）。

修复：成功判定（可见文本 + 独立行证据 + repeat 绑定第二次同一 call）、s4 重写为 TTL 放行场景（实验专用 1s TTL + 显式等待 + 同命令重试）、read 证据改用 DSH 结构化 `data.meta.lines[].text`（展示文本永不参与证据解析）、采集器解析 shell 的 `[exit code: N]` 并把非零退出判为命令失败（**仅限 `pwsh`/`bash` 工具**：read 的文件内容即使含该文本也不算失败；真实日志格式回归测试随附）。正式结论必须来自修复后从新目录重跑的完整 54 轮。

## 门槛与修复纪律

7 道门槛定义见 PROTOCOL.md「发布门槛」。任一道 FAIL：

1. 不许加特性掩盖：先读对应轮次的 `result.jsonl` + `session-decoded/`，确定是**实验问题**（模型不按脚本、提示词歧义）还是**插件缺陷**。
2. 实验问题 → 修提示词/场景 → 重跑**受影响场景**的三组轮次（对照必须同源重跑）。
3. 插件缺陷 → 修代码 + 测试 → 重跑受影响场景。
4. 全部 PASS 后才进入发布（用户确认后 `npm publish`）。

## 产物说明

| 路径 | 内容 |
|---|---|
| `benchmark/runs/<s>/<p>/<i>/result.jsonl` | 该轮完整采集（工具序列、token、账本快照、成功判定） |
| `benchmark/runs/<s>/<p>/<i>/session-logs/` | 原始 session log（zstd 帧）副本 |
| `benchmark/runs/<s>/<p>/<i>/session-decoded/` | 解码后的事件 JSONL（按 session 分文件） |
| `benchmark/runs/<s>/<p>/<i>/ledger-db/` | 该轮账本 SQLite 副本 |
| `benchmark/runs/manifest.jsonl` | 全部轮次清单（时间、耗时、成功、账本计数） |
| `benchmark/runs/formal-plan.json` | 正式实验计划（seed、生成时间、54 轮洗牌顺序） |
| `benchmark/runs/summary.json` | 汇总机读结果 |
| `benchmark/runs/GATES.md` | 7 道发布门槛判定表（含阶段标注） |

`benchmark/runs/` 已 gitignore，不入库；需要归档时把 `summary.json` + `GATES.md` + `formal-plan.json` 拷贝到发布说明。

## 发布产物验证（CI 已覆盖）

CI 矩阵在每个平台上执行 `npm run build`（tsdown 构建 dist）、`npm pack --dry-run`（tarball 内容清单）和 `npm run pack-test`（打包 → 临时消费者项目安装 tarball → 导入公开 ESM 入口跑 sqlite store → smoke bin 映射）。本地复跑：`npm run build; npm run pack-test`。
