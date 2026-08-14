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

- 每轮产物 `benchmark/runs/<scenario>/<profile>/<iter>/` 下有 `result.jsonl`、`session-logs/`、`session-decoded/`、`ledger-db/`（warn/block 组）。
- Baseline 的 s1 应产生 ≥2 次重复失败（模型可能不听话，看 stdout 与工具序列核对）。
- Block 的 s3/s4 必须出现「先失败 → 证据变化 → 重试成功」；若模型不按脚本走（例如直接 write 不先 read），先修提示词，**不改插件**。
- 采集器问题（崩溃、字段缺失、解码失败）修 `benchmark/*.ts` 后重跑受影响轮次。

## 正式实验（54 轮：6 场景 × 3 组 × 3 次）

随机化顺序并控制 API 预算；单轮失败/超时也保留记录，不剔数据。

```powershell
# 每轮 token 预算见 scenarios/<id>.json 的 tokenBudget；建议分批跑（例如按场景分 6 批）
foreach ($s in @(
  's1-missing-read-repeat',
  's2-search-alternate-path',
  's3-create-then-reread',
  's4-command-ttl-retry',
  's5-parent-child-cross-agent',
  's6-similar-commands-no-false-positive'
)) {
  foreach ($p in @('baseline','warn','block')) {
    foreach ($i in @('1','2','3')) {
      node benchmark/run.ts $s $p $i
    }
  }
}
node benchmark/summarize.ts
```

运行顺序影响：三组共享控制变量（同一 checkout、同一提示词、全新 DSH_HOME 与账本），但模型输出本身有方差——因此每组各 3 次取聚合，正式结论以 `benchmark/runs/GATES.md` 的 7 道门槛为准。

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
| `benchmark/runs/summary.json` | 汇总机读结果 |
| `benchmark/runs/GATES.md` | 7 道发布门槛判定表 |

`benchmark/runs/` 已 gitignore，不入库；需要归档时把 `summary.json` + `GATES.md` 拷贝到发布说明。
