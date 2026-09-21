# 启动对账：任务孤儿回收（W-10）

> 建立：2026-09-21 · 触发：小虾 09-14 五条 L3 委托「已执行却停在 WORKING」

## 问题

A2A 任务的在途状态（`TASK_STATE_SUBMITTED` / `TASK_STATE_WORKING`）**只活在进程内存里**。
若进程在处理途中死亡（gateway/容器重启、心跳重拉……），`a2a-task-store.js` 的 `_loadPersistence()`
会把持久化文件里的状态**原样加载回来** —— 于是那条任务**永久停在 WORKING**，既不会失败也不会完成。

现场证据（2026-09-21）：

- 本地复现：建任务 → 置 WORKING → `flushSync()` → 新进程加载 ⇒ 仍是 WORKING，无任何回收逻辑。
- 实机佐证：小虾执行委托期间其 A2A 进程（`server_v5`）**中途死亡**，被心跳规则重新拉起。

> 注：**不能**用 `updatedAt == createdAt` 推断「任务从未被触碰」——`createdAt`/`updatedAt` 都是
> 毫秒精度 ISO 字符串，同一毫秒内完成 create+更新时两者天然相等。

## 修法（只碰非终态，安全）

### ① 启动对账（`a2a-task-store.js`）

`TaskStore` 构造时（加载持久化之后）执行 `_reconcileOrphans()`：

- 仅处理 `SUBMITTED` / `WORKING` 两种**在途状态**；
- `INPUT_REQUIRED` / `AUTH_REQUIRED` **不回收**（它们语义上就是跨重启等待外部输入）；
- 命中的任务：补一条 agent 侧 `history`（写明原因）→ 置 `FAILED`，`status.message = orphaned_by_restart`；
- 回收条数写入 `store.orphansReconciled`（观测用）。

依据：**进程刚启动时不可能存在在途任务**，此时加载回来的在途状态必然是上一世的残骸。

开关与宽限：

| 选项 | 默认 | 说明 |
|------|------|------|
| `reconcileOrphans` | `true` | 置 `false` 关闭对账 |
| `orphanGraceMs` | `0`（环境变量 `A2A_TASK_ORPHAN_GRACE_MS`） | 宽限期：任务年龄小于该值则不回收（默认立即回收） |

### ② 回写失败不再隐形（`a2a-bridge-correlator.js`）

原 `.catch(() => {})` 会把终态回写失败**静默吞掉**（表面「执行完了」，store 却停在 working）。
改为 `terminalWriteError(taskId, state)`：**记 `console.warn` + 计数**，并导出
`getTerminalWriteFailures()` 供观测/健康探针读取；仍不阻断主流程。

## 测试

```bash
node tests/task-store-reconcile.test.js   # 7 通过 / 0 失败
```

覆盖：孤儿回收 · 回收留痕 · 终态不动 · 等待类不动 · 可关闭 · 宽限生效 · 回写计数不抛出。
