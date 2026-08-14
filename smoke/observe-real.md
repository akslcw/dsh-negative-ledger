# 真实 DSH 会话观察 runbook

在真实 headless 组合中挂载插件（**默认 sqlite 后端**），用**真实模型**跑一遍"缺失文件"场景，逐项观察账本行为。

前置：`DEEPSEEK_API_KEY`（或 `.env`）；已构建（`pnpm run build`，或本机用 `pnpm dsh` 源码路径）。

> 注意：boot 时相对插件 specifier 以 **profile 目录**（`$DSH_HOME/profiles/headless`）为锚点解析，不是 patch overlay 所在目录。overlay 里的 `../../../../src/plugin.ts` 从锚点走回项目根；`DSH_HOME` 必须是 `dsh-negative-ledger/smoke/.dsh-home`（本 runbook 第 1 步的设置），否则解析会漂移。

## 1. 启动（无密钥回放验证除外，以下为真实调用）

```powershell
# Windows PowerShell；macOS/Linux 用 export
$env:DSH_HOME = "$env:TEMP\dsh-observe-home"
node apps/cli/lib/bin.js --profile headless --patch dsh-negative-ledger/smoke/smoke.patch.yml @"
你是测试助手。请严格按照顺序执行：
1. 用 read 工具读取 missing-obs.txt（它会不存在）
2. 再用 read 工具读取一次 missing-obs.txt
3. 用 write 工具创建 missing-obs.txt，内容写 created-by-observe
4. 最后再用 read 工具读取一次 missing-obs.txt
完成后只回复 OBSERVE_DONE。
"@
```

账本落在 `<repo>/dsh-negative-ledger/smoke/smoke-ledger/ledger.db`（overlay 里 `dir: dsh-negative-ledger/smoke/smoke-ledger`，相对 cwd；未指定 `backend` → 默认 sqlite）。

## 2. 观察项（对照 real-mount smoke 的已验证路径）

| 观察点 | 期待的现象 | 说明 |
|---|---|---|
| 第 1 次 read 失败 | 结果卡片只有 `FS_NOT_FOUND` 错误，**无** Negative-ledger 附言 | 首次失败只记录，不打扰 |
| 第 2 次 read 失败 | 警告经 `agent/inbox/spliced` 注入**下一步输入**（session log 里 source 为 `{kind:'plugin', plugin:'negative-ledger'}`），含 `Negative-ledger: this exact action previously failed...` 与诚实计数行 | 附言不进结果卡片，而是在下一步请求里对模型可见 |
| 第 3 步 write | 无拦截（write 不受 readTools 跟踪） | 但 write 的 `fs/observed` 会触发失效 |
| 第 4 次 read 成功 | 出现 `a previous failure no longer applies... retry is allowed`（同样经 inbox 注入） | 证据变化→stale→lease→成功→resolved |
| 模型是否改变行为 | 真实模型可能不按脚本顺序走——已观察过它把两次 read 放进同一并行 step，或提醒后直接改走 write | 并行调用同样正确处理：先到的结果记录，后到的命中提醒 |

## 3. 事后核验（确定性断言，不依赖模型表现）

```powershell
node dsh-negative-ledger/src/cli.ts --dir smoke-ledger --backend sqlite list
node dsh-negative-ledger/src/cli.ts --dir smoke-ledger --backend sqlite stats
node dsh-negative-ledger/src/cli.ts --dir smoke-ledger --backend sqlite show <id>
```

预期（模型按脚本走时）：
- `list`：恰好 1 条 `file_missing`，状态 `resolved`（成功闭环，lastTransition 有 `via` call id）；
- `stats`：`duplicate failures observed: >= 1`、`warnings emitted: >= 1`、`calls denied: 0`（warn 模式；block 变体才有 deny 计数）；无 token 估算行；
- 若模型在第二次就换路径（没重复读），计数可能全为 0 而状态仍 `resolved`——两者都合法，观察重点是"拦截与失效是否正确触发"。

## 4. block 模式变体（可选）

把 overlay 里的 `mode: warn` 改成 `block` 再跑一次：第 2 次 read 应在**派发前**被 deny（错误消息以 `blocked by negative-ledger` 开头），且不产生第二次 `FS_NOT_FOUND`。

## 5. 已知边界（观察时不必惊讶）

- sqlite 后端为多进程（WAL）；旧版 `backend: jsonl` 才是单写者。
- 模型不听话时（比如一步写两个文件），观察仍有效：账本只按事实记录。
