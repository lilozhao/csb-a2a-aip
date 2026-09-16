# HERMES-ADAPTER —— bridge 注入适配器契约（P0-B）

- 2026-09-16 · 若兰 🌸 · 状态：**P0-B 契约定义**（尚未写码；C 段实现按本文）
- 对标：`adapters/openclaw-gateway.js`（同一套接口面，bridge core 只认这套）
- 前置：`docs/hermes-injection-recon-2026-09-16.md`（A 段调研结论）

---

## 一、通道定位

| 系 | 通道 | 注入方式 | 隔离 |
|---|---|---|---|
| OpenClaw | C1 | HTTP：本机 gateway `POST /v1/chat/completions`（model=openclaw） | ✅ isolated 路径（`injectIsolated`） |
| **Hermes** | **C4-H** | **CLI：本机 exec `hermes -z "<prompt>"`** | ✅ `-z` 天然隔离（不污染主会话） |
| 兜底 | C5 | `recordDegrade` + 诚实指路 | — |

> 铁律：**默认关**（`A2A_BRIDGE_HERMES=off`）——不开启 = 今天行为，零影响。

## 二、统一接口面（必须与 openclaw-gateway 对齐）

```js
// 双契约（与 openclaw-gateway 完全一致，bridge core 不区分宿主）
A. inject(envelope, taskId, opts)  → { ok?, summary, artifact?, refused? }   // 失败抛错
B. inject({ taskId, delegatorLabel, envelope }, opts)
                                   → { ok:true, result } | { ok:false, error }  // 不抛
C. injectIsolated(envelope, taskId, opts) → { ok, summary, artifact }

// 辅助（复用/对齐）
buildPrompt(envelope, taskId)      // 委托帧 → prompt 文本（格式与 openclaw 侧保持一致）
buildInjectMessage(frame)          // frame → 注入消息
detectRefusal(content)             // 拒执行识别（词表对齐）
resolveConfig()                    // 见 §四
fetchResult(taskId, opts)          // L3 confirm 轮询读回（见 §五）
harvestTexts(result, opts)         // 从回读里抽取文本
extractReply(raw, taskId)          // 匹配「确认 #<taskId>」/「拒绝 #<taskId>」

module.exports = { inject, injectIsolated, buildPrompt, buildInjectMessage,
                   detectRefusal, REFUSAL_PATTERNS, resolveConfig,
                   fetchResult, extractReply, harvestTexts }
```

## 三、注入实现（transport = CLI）

```
injectIsolated():
  1. prompt = buildPrompt(envelope, taskId)     // 含 taskId 标记帧
  2. spawn(HERMES_BIN, ['-z', prompt], { cwd, env, timeout, shell:false })
       env: HERMES_HOME（默认 /opt/data）· PATH 带 venv bin · 不注入任何 operator 凭据
  3. 收集 stdout/stderr，超时 kill
  4. 副作用/结果判定：以 stdout + （可选）marker 读回为准，**不看 LLM 自述**
  5. 返回 { ok, summary, artifact:{ stdout, stderr, durationMs } }
  失败 → 抛错 → bridge core 走 C5
```

**安全约束（硬）**
1. `spawn` 用**参数数组**，**禁止 `shell:true`**（防注入拼接）
2. prompt 模板**禁止**出现 `restart` / `s6` / `supervise` / `kill` 类指令（避开「网关内自杀」坑）
3. 只允许本机；不加任何外部网络口
4. 全量审计：`{taskId, jti?, promptHash, exitCode, durationMs, result}`
5. 默认关；开启需显式 env

## 四、配置（`resolveConfig()`）

| 键 | env | 默认 | 说明 |
|---|---|---|---|
| 开关 | `A2A_BRIDGE_HERMES` | **off** | 总闸 |
| 可执行 | `A2A_HERMES_BIN` | `hermes` | 或绝对路径 `/opt/hermes/.venv/bin/hermes` |
| 家目录 | `A2A_HERMES_HOME` | `/opt/data` | → `HERMES_HOME` |
| 超时 | `A2A_HERMES_TIMEOUT_MS` | 120000 | 单回合上限 |
| 主会话目标 | `A2A_BRIDGE_MAIN_TO` | identity.bridge.mainTo | 飞书 `ou_*`/`oc_*` |
| 通道 | `A2A_BRIDGE_CHANNEL` | `feishu` | confirm 收回用 |
| 会话键 | `A2A_BRIDGE_SESSION_KEY` | `main` | 读回用 |

## 五、L3 confirm 读回（`fetchResult`）——**待定，3 条路径**

| 路径 | 机制 | 状态 |
|---|---|---|
| A | 直查 `state.db`（SQLite+FTS5）匹配 `确认 #<taskId>` | ⏳ 需验证 schema |
| B | 启用 webhook 平台（8644）接收主人回复 | ⏳ 需对方启用端口 |
| C | **不自动读**（保守降级：L3 一律人工在宿主侧处理） | ✅ 默认 |

> **P0 默认走 C**：写操作仍由宿主侧原流程确认；adapter 只负责「注入」这条腿。候选 A/B 留 P0-D 验证。

## 六、降级契约（C5）

任意失败（二进制缺失 / 超时 / 非零退出 / 拒执行）→
`recordDegrade(taskId, reason)` + 回执「Hermes 注入不可用，已走 P0 诚实指路」，**绝不静默假成功**。

## 七、不污染主会话（B4）

- `-z` 天然隔离；结果**不回写**主会话记忆（除降级事件记录）
- 注入帧带 `taskId` 标记，便于宿主侧区分「桥接回合」与正常对话

## 八、测试（C 段要覆盖）

≥12 例：开关关→拒绝注入 / 二进制缺失 / 非零退出 / 超时 kill / 成功注入 / refused 识别 /
frame 双契约 / prompt 模板禁词校验 / 无 shell 拼接（含 `;` `&&` `$()` 的 payload 不执行）/
降级路径 c5 / 配置优先级（env > identity）/ fetchResult 路径 C 保守兜底

---
_一句话：**Hermes 的 C4-H = 「本机 CLI 注入隔离回合」，接口与 OpenClaw 侧完全同形；默认关、禁 shell 拼接、禁重启类指令、失败一律 C5。**_
