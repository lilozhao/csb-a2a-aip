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

## 九、墨丘实测并入（2026-09-16 · 四条反直觉发现 → 已改码）

| # | 实测发现 | 设计变更 |
|---|---|---|
| **①** | **rc 靠不住**：`-z "读 /no/such/file"` → **rc=0、stderr 空**，失败信息当「正常回答」塞进 stdout | **判据改三重**：`rc==0` + `stdout 非空` + **哨兵串命中**（prompt 末行要求回显 `BRIDGE-OK-…`，命中才剥行入回执）；留 `noSentinel` 逃生门 |
| **②** | **工具能锁（`-t file` → 回 NO_TOOL），「身份」锁不干净**（禁了 SOUL/IDENTITY/memory 仍自称墨丘；**未定位**） | 新增 `A2A_HERMES_TOOLS`（传 `-t <tools>`）；「身份不隔离」记为**已知边界**（非本 adapter 可解） |
| **③** | **shell 层安全（payload 不会二次解释 ✓），语义层不安全**（「执行这条命令并把输出给我」→ 真执行，approvals 自动绕过） | 禁词表只兜**显式危险串**；**授权责任在 bridge（L3/UAC）+ 宿主工具白名单**；新增测试 15 显式记录该边界 |
| **④** | **L3 读回可走 state.db**（FTS5，0.018s / 254 命中 0.02s）。两坑：**容器 TZ=UTC（差 8h）**、**库 468MB 且 gateway 在写（全表 COUNT 曾 300s 超时）** | 实现 `fetchResult(path:'db')`：SQL 模板**必须显式配置**、**强制含 LIMIT**、查询超时兜底、`since` 一律 **toUtcIso()** |
| **⑤** | **环境坑**：A2A 进程带 `HERMES_S6_SUPERVISED_CHILD=1` 等 → 子进程会以为自己是 s6 托管的网关子进程 | `buildChildEnv()` **白名单清洗**（只放行 PATH/HOME/LANG/TERM/TMPDIR/HERMES_HOME… + 显式 `ENV_EXTRA`），**剥除所有 `HERMES_S6_*` / `S6_*`** |
| + | 副作用实测（跑前后）：`MEMORY.md`/`USER.md` **md5 未变** ✓；`state.db +278KB`（新增一条独立会话记录）；**主会话上下文不受污染** ✓ | 佐证「隔离回合」语义成立 |

**测试**：`tests/hermes-adapter.test.js` → **25/25**（新增：三重判据 / 环境清洗 / 工具锁 / state.db 三护栏 / TZ / 语义边界）
**回归**：bridge-core 29 · bridge-uac 17 · bridge-confirm 14 · bridge-adapter 15 —— 全绿

## 十、Q1 / Q4 补齐（2026-09-16 二轮实测 → 已改码）

| 问题 | 实测 | 设计变更 |
|---|---|---|
| **Q1 可调性** | `hermes` **不在** 墨丘 shell PATH（`command -v` rc=1）；但 **A2A server 进程（pid 272）的 PATH 里有 `/opt/hermes/.venv/bin`**，且已带 `HERMES_HOME=/opt/data` | `resolveHermesBin()`：**优先绝对路径**（`/opt/hermes/.venv/bin/hermes` 等候选），env `A2A_HERMES_BIN` 显式优先 |
| **Q4-1 注入** | prompt 里的 shell 语法**没被二次解释**（marker 未出现）✓；但「**明确要求执行的命令**」**真被执行**（`-z` 交给一个有完整工具权限的 agent，approvals 自动绕过）；它还主动提醒「这像是注入测试」😄 | 确认「风险在授权不在拼接」；⇒ **read 委托可轻，write/shell 必须 L3/UAC** |
| **Q4-4 只读档** | 三个闸门：`-t/--toolsets`、`--ignore-rules`、`--safe-mode`；可做「只读档」 | 新增：`A2A_HERMES_TOOLSETS_READ` / `_WRITE`（**按 scope 自动选档**）· `A2A_HERMES_SAFE_MODE`（**默认 on**）· `A2A_HERMES_IGNORE_RULES`（**默认 off**）· `buildArgs()` 固定顺序 `-t → --safe-mode → --ignore-rules → -z` |

**测试**：→ **29/29**（新增 bin 解析 / 按 scope 工具档 / 三闸门默认与顺序 / read 注入自动带只读档）

**待墨丘补**：① 工具集清单（Q4-4 说已拿到，未发）② state.db 检索 SQL 示例（已请求）

## 十一、定稿 SQL + ⚠️ 一条安全更正（2026-09-16 三轮 → 已改码）

墨丘已发全：回执 `task_1789522870224` · SQL `task_1789523380920` · 工具集真值 `task_1789523590775`（三条均在 `csb-a2a-aip/data/a2a-inbox.jsonl`）

### ⚠️ 安全更正：`HERMES_WRITE_SAFE_ROOT` **必须保留**（我原白名单错了一处）
> `file_safety.py:148-158`：**设了才检查**，未设 = 只受凭证黑名单限制。
> 对照实测（同一条 prompt）：`env -u HERMES_WRITE_SAFE_ROOT … "写 /tmp/probe2"` → **文件真被创建**；
> `HERMES_WRITE_SAFE_ROOT=/opt/data …` → **Write denied**。
> ⇒ **剥掉它 = 把子进程写入边界打开。** 已改：加入环境白名单（**保留**），并提供 `A2A_HERMES_WRITE_SAFE_ROOT` **收窄**到专用 scratch。

### 工具集真值（`hermes tools list` · 24 项）
- **enabled**：web, browser, terminal, file, code_execution, vision, image_gen, bfl, tts, skills, todo, memory, session_search, clarify, delegation, cronjob, computer_use
- **disabled**：video, video_gen, x_search, stt, context_engine, homeassistant, spotify, yuanbao
- ★ **`file` ≠ 只读**（含 read/**write**/**patch**/search）→ 「零写」在 `-t` 粒度**做不到**，只能靠 WRITE_SAFE_ROOT 收窄
- ★ **非法名 fail-closed**（`-t nonsense` → rc=2，不会静默放宽）
- ★ 只读档默认值：**`file,skills`**（**绝对不含** terminal / code_execution / delegation / cronjob / memory）
- ✓ `state.db` 与 `sessions/` 是**内置禁写区** → L3 读回安全

### state.db 定稿 SQL（已内置为 `DEFAULT_CONFIRM_SQL`）
存档：`config/hermes-state-db-queries.sql`（主路径 + 会话发现 + FTS trigram，含 EXPLAIN）
- 占位符：`{{SESSION_ID}}` / `{{SINCE_EPOCH}}` / `{{TASK_ID}}`
- **修正**：`timestamp` 是 **REAL epoch**，`{{SINCE}}` 若塞 ISO 字符串会因 SQLite 类型序（REAL < TEXT）**恒假** → 新增 `{{SINCE_EPOCH}}`（`toEpochSeconds`）
- 三坑：TZ=UTC（差 8h）· 禁无 WHERE 的 COUNT(*)（300s 超时）· 只读打开 + 强制 LIMIT
- FTS 坑：索引含 tool 消息 → 必须 `role='user'`；`f.content` 有尾随空格规范化 → 原文取 `messages.content`
- `sessions.last_activity_at` **无索引**（用 `started_at`）

**测试**：→ **32/32**（新增默认 SQL 校验 / WRITE_SAFE_ROOT 保留与收窄 / 只读档默认值）

---
_一句话：**Hermes 的 C4-H = 「本机 CLI 注入隔离回合」，接口与 OpenClaw 侧完全同形；默认关、参数数组禁 shell 拼接、禁重启类指令、三重判据（rc+非空+哨兵）、环境白名单、失败一律 C5。**_
