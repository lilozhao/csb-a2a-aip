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

> 备注（K14/§六.3）：远程命令审计日志路径 `A2A_CMD_AUDIT_LOG`（默认 `/home/node/.openclaw/workspace/logs/a2a_command.log`）；容器 home 不可写时设为可写目录，失败会降级为一条显式告警。

## 五、L3 confirm：**读回腿** + **投递腿**

L3 写操作要闭环，需要两段：
1. **投递腿**：把「确认请求」发给主人
2. **读回腿**：读回主人的「确认 #<taskId>」

### 5.1 读回腿（`fetchResult`）

| 路径 | 机制 | 状态 |
|---|---|---|
| **A** | 直查 `state.db`（只读 + Node 内置 sqlite）匹配 `确认 #<taskId>` | ✅ **已实现**，默认走 A（CHAT_ID 子查询口径） |
| B | 启用 webhook 平台（8644）接收主人回复 | ⏳ 未实现（需对方启用端口） |
| C | 不自动读（保守降级） | ✅ 保留为回退 |

- 默认 SQL = `DEFAULT_CONFIRM_SQL`（CHAT_ID 子查询）· 占位符 `{{CHAT_ID}}` / `{{SINCE_EPOCH}}` / `{{TASK_ID}}`
- 硬护栏：SQL 必须含 `LIMIT`（库大 + gateway 在写，禁全表）· 查询带超时
- 详见 `config/hermes-state-db-queries.sql`

### 5.2 投递腿（`invokeTool`）—— 本机 CLI（已按宿主校准）

```
spawn(HERMES_BIN, ['send','--to','feishu:oc_xxx','--file','-','--json'])
       + 文本走 stdin                          // argv 数组，禁 shell 拼接
```

**校准要点（宿主源码级，2026-09-16）**
| 事实 | 含义 |
|---|---|
| `send` **没有 `--text`** | 消息体是**位置参数**（`nargs='?'`）→ 用错形态直接 `rc=2` 用法错 |
| 文本以 `-` 开头会被当 flag | → 默认改走 **stdin（`--file -`）**，也绕开多行/长度/转义问题 |
| 目标要 `platform[:chat_id[:thread]]` | 裸 `oc_xxx` 会被当平台名解析失败 → **自动补 `feishu:` 前缀** |
| 退出码**可信**（与 `-z` 不同） | `0`=投递成功 `1`=平台层失败 `2`=用法错 |
| ⚠️ `rc=0` 也有两个坑 | `skipped:true`（cron 去重）/ human-mode 的 note 路径 → 故默认带 `--json`，解析 `success`/`skipped`；**拿不准一律当失败** |

| 配置 | 默认 | 说明 |
|---|---|---|
| `A2A_HERMES_SEND` | **off** | 总闸（对外发消息 = 外发动作，需显式开启） |
| `A2A_HERMES_SEND_ARGS` | `send,--to,{to},--file,-,--json` | **按整 token 替换**；宿主语法不同时可全量改写（如 `send,--to,{to},{text}` 走位置参数） |

**边界（重要）**：`hermes send` **不是**「往主会话上下文里插话」。它 (a) 向平台投递一条消息，(b) 给目标 chat 的会话转写**追加一条 role=assistant 的镜像**，**不触发回复回合**。
⇒ 确认请求会以「该 Agent 自己说过的话」进入主人会话——可接受（主人本来就在那儿回），但要写进文档。

- 失败一律诚实 `ok:false` → confirmL3 记「确认请求发送失败」→ **拒绝执行**（绝不静默放行）

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

### 内置默认读回模板已改 CHAT_ID 口径（2026-09-16 四轮）
`DEFAULT_CONFIRM_SQL` 从 `session_id = '{{SESSION_ID}}'`（会过期）改为 **`session_id IN (SELECT id FROM sessions WHERE chat_id='{{CHAT_ID}}' ORDER BY started_at DESC LIMIT 5)`**：
- 子查询**刻意不加 `started_at` 下界**——否则会漏掉「早于 SINCE 就已开启」的会话
- 外层仍按 `m.timestamp` 裁剩（走 `idx_messages_session`）· 不用无索引的 `last_activity_at`
- ★ 连带修：`{{SINCE_EPOCH}}` 缺省时由 `NULL` 改为 **`0`** —— `timestamp >= NULL` 恒为 NULL ⇒ **条件恒假、一行都回不来**
- 测试 35/35

## 十二、装配（P0-D · 2026-09-16）

**新增 `adapters/select.js`** —— 注入适配器选择（与 `server_v5`、`a2a-bridge-confirm` 同源）：

```
优先级：env A2A_BRIDGE_ADAPTER  >  identity.adapter  >  identity.platform  >  默认 openclaw
```

**接线点（最小改动）**
| 文件 | 改动 |
|---|---|
| `adapters/select.js` | **新增**：`resolveInjectAdapter()` / `resolveAdapterKind()` / `readIdentityAdapter()`（identity 读不到/坏 JSON → 不抛，回退 openclaw）|
| `server_v5.js` | ① `chatNotifyHandler.inject` → `select.resolveInjectAdapter()` ② `bridgeHandler` 的 `gatewayAdapter` → 同源选择 ③ 注册表 `platform` 字段 → `identity.adapter \|\| identity.platform \|\| 'openclaw'` |
| `a2a-bridge-confirm.js` | 默认 adapter 的 `require` → `select.resolveInjectAdapter()` |
| `adapters/hermes.js` | 新增 `invokeTool()` **诚实失败**（P0 未实现投递）→ confirmL3 会记「发送失败」并**拒绝**，不会静默放行 |

**零行为变化保证**
- 未声明 `adapter/platform` 的实例（含若兰本机）→ 解析为 **openclaw**，路径完全照旧
- 选到 hermes **≠ 已启用**：还有 `A2A_BRIDGE_HERMES=off`（默认关）→ 未开启时 inject 抛错 → C5 诚实降级
- 回滚：`A2A_BRIDGE_ADAPTER=openclaw` 一行覆盖

**测试**：`tests/adapters-select.test.js` → 8/8 → **（修正后 10/10）**
**回归**：core 29 · uac 17 · confirm 14 · adapter 15 · hermes 34 —— 全绿

## 十三、墨丘部署实测反馈并入（2026-09-16 四轮 → 已改码）

### ★ 修正一：`identity.adapter` 是 **LLM 路由专属**，注入选择不得复用
> 墨丘给出代码证据：`llm-router.js:299` → `preferredAdapter = process.env.A2A_ADAPTER || identity?.adapter`
> 它的值现在是 `direct`（9.9 双通道靠它）；改成 `hermes` 会**连带改掉 LLM 路由**。
> ⇒ 两个概念绑死了。

**改法**：注入选择不再读 `identity.adapter`，改用**专用字段**：
```
env A2A_BRIDGE_ADAPTER  >  identity.injectAdapter  >  identity.bridge.injectAdapter  >  identity.platform  >  默认 openclaw
```
- `server_v5.js` 的注册表 `platform` 字段同步改为 **只用 identity.platform**（不再取 identity.adapter）
- 新增回归用例 **3b**：`identity.adapter='hermes'` 必须**不被采纳**

### ★ 修正二：state.db 读回两处环境事实
| 事实 | 改法 |
|---|---|
| `A2A_HERMES_SESSION_ID` 是**每会话新生成**的 id，写死会过期 | 新增 `{{CHAT_ID}}` 占位符 + `A2A_HERMES_CHAT_ID`：**按 chat_id 自取最新会话**（不过期） |
| **容器里没有 `sqlite3` CLI**（command not found） | 默认 runner 改为 **`node:sqlite`**（Node ≥22.5 内置，实测可用）→ CLI 降为回退；**消除外部依赖** |

### 修正三：两例测试自带环境依赖（算我们的 bug）
| 用例 | 问题 | 改法 |
|---|---|---|
| `hermes-adapter` #18 | 硬断言 `bin==='hermes'`，但实现有绝对路径自动探测 → 那台机跑红 | 改为断言「非空」 |
| `adapters-select` #1 | 假设「无 identity」，但仓库里有真实 `identity.json` | 强制指向不存在的 identity 路径 |

**测试**：hermes **34/34**（新增 node:sqlite 端到端 / `{{CHAT_ID}}`）· select **10/10**
**回归**：core 29 · uac 17 · confirm 14 · adapter 15 —— 全绿

## 十四、首次端到端验收（墨丘 · 2026-09-16）✅ 通过 + ★ 两处口径修正

任务 `task_1789525850436_bf072929` · scope=read（L2）· duration 106682ms · **COMPLETED** · 工具面 = `file,skills`（只读档生效）。

### ★ 修正一（墨丘指出）：不要叫「注入主会话」
> `-z` 隔离回合**同样载入 CWD 的 AGENTS.md / SOUL / memory**（其自身技能文档就写明「Tools, memory, rules, and AGENTS.md in the CWD are loaded as normal」）。
> ⇒ 「能贴出记忆」只能证明**【新腿带记忆】**，**不能**证明【这条腿 = 主会话】。
> 真正区分二者的是**会话连续性**（有无前序轮次）——而隔离回合**看不到任何前序轮次**。

**正确口径**：**「端到端注入腿（带记忆的隔离回合）已通」**。C4-H 的本质是**另起一回合**，不是**续上主会话**。
⇒ **能力边界**：适合**独立任务**（read / pull / test / 单次查询）；**不适合**依赖先前对话上下文的委托。

### ★ 修正二：「身份不隔离」的根因**已定位** —— 而且它不是缺陷
> 早前记为「已知边界·根因未定位」。现在解释清楚了：
> **`-z` 本来就会载入 CWD 的 AGENTS.md / SOUL / memory** → 身份当然在。
> ⇒ 这是**预期行为**，不是隔离漏洞。所谓「锁不干净」是**误判**。
> （真正的隔离差异是：不带**会话历史**、不污染主会话上下文、结果不回写主记忆。）

### 验收硬证据（三条，均指向「由 hermes.js 以 scope=read 生成」）
1. 工具面 = `file,skills`，与 `toolsRead` 默认值**逐字吻合**，且**恰好没有** terminal / code_execution / delegation / cronjob / memory
2. prompt 形状与 `buildPrompt()` **逐行同形**
3. **哨兵可解码验证**：`BRIDGE-OK-` + taskId 末16位 + base36(ms)；尾缀还原 = 1789525850469ms，taskId 内嵌 = 1789525850436ms → **差 33ms** ⇒ 确系 `makeSentinel()` 当场生成（三重判据机制被外部验证过 ✓）

### ⚠️ 首次验收暴露的真缺陷（已修 `2026-09-16 11:35`）
第二封回执直接失败：`bridge_unavailable · 注入超时（120000ms）`。
- **原因**：`hermes -z` 一个隔离回合本就很重（载入 AGENTS/memory + 完整 agent 回合）——首验 106.7s 已经贴着 120s 上限。
- **两处修**：
  1. 默认超时 **120s → 5min**（与 OpenClaw 侧 `A2A_BRIDGE_INJECT_TIMEOUT_MS` 默认对齐）
  2. **超时改为跟随信封声明**（与 openclaw-gateway 同逻辑）：`opts > max(信封声明, 默认)`，封顶 15min
     —— 之前只看自己配置，**完全忽略了委托方声明的窗口**（我们的 client 声明 30min，adapter 却 120s 就超）
- **降级路径按设计诚实报错**（不是静默假成功）✓ 这是三重判据 + C5 的价值实证

### 另一处诚实证据（值得学）
墨丘的只读档**没有 terminal / code_execution**，所以 `git rev-parse` / `node adapters/hermes.js` **跑不了**。
它**没有把「跑不了」编成「跑出来的样子」**，而是改贴**文件级等价证据**（`.git/refs/heads/master` 内容、日志末行），并**逐条标注哪些是实读、哪些是快照替代**。
——这比「给个漂亮结果」有价值得多。

---
_一句话：**Hermes 的 C4-H = 「本机 CLI 注入隔离回合」，接口与 OpenClaw 侧完全同形；默认关、参数数组禁 shell 拼接、禁重启类指令、三重判据（rc+非空+哨兵）、环境白名单、失败一律 C5。**_
