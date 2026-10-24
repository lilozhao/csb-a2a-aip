# CHANGELOG · csb-a2a-aip

## v5.2.4（2026-10-24）— 握手信任从未生效：存和取用的不是同一个键

### 现象
握手跑通了（五步全过、会话也注册了），但生产环境里**这条信任路径一次都没命中过**。
查日志：`[TrustBridge] 握手信任已注册` 一条都没有。

### 两层根因

**1️⃣ 键的命名空间不同（直接原因）**
```js
registerHandshakeSession(session)  // 键 = session.caller_id  → "mingde@csbc.lilozkzy.top:3100"
resolveTrustLevel(senderName)      // 查 = senderName         → "明德"
```
两个字符串永远对不上。而消息处理层（`_resolveSenderInfo`）传的正是名字。

**2️⃣ name 是攻击者可控字段（更根本，不能靠「把键改一致」解决）**
按名字匹配意味着：伪造者只要把 `sender.name` 写成「明德」，就能拿到 L1 信任。
这与本模块自己写的设计本意直接冲突——「伪造者无法完成签名握手，因此无法获得握手信任等级」。
**按名字给信任 = 握手白做。**

### 修复
- 注册时建**多重别名**：`caller_id` / `host:port` / config 反查到的中文名 / 本地名
- 解析时**按 host 锚定**（`sender.url` / `sender.id` / 完整 caller_id）
- **仅凭 name 默认不授予信任**，只打一条 warn 说明「差一点误信」
  （调试可用 `new TrustBridge({ allowNameOnly: true })`）
- 域名 ↔ IP 等价别名：一次 DNS 反查把解析到的 IP 也登记
  （实况：config 里明德是 `47.121.28.125:3100`，握手 caller_id 可能是 `csbc.lilozkzy.top:3100`）
- 同名不同主机会**告警**（不静默覆盖）
- 顺带修 `ttl || 300` 假值兜底 → `ttl ?? 300`（`ttl=0` 曾被悄悄变成 300s）
  以及过期判定 `>` → `>=`（ttl=0 应立即失效）

### 判据（可机械核对）
- 注册日志带别名：`| 别名: host=... name=...`
- `resolveTrustLevel(name, {sender:{url}})` 命中时 `matchedBy: 'sender.url'`
- 仅凭名字 → 返回 null + `🛡️ 拒绝按名字授予信任`
- 新增 `tests/trust-bridge-key.test.js` **16 条**（含 3 条安全断言）
- 反向验证：把 `allowNameOnly` 强制为 true（退回旧行为）→ 3 条安全断言立刻变红

### 残余风险（诚实边界）
`sender.url` / `sender.id` 仍是**自述字段**，不是密码学证明。
同一 IP 上的不同实例、DNS 重绑定仍可能误配。
真正防伪需要消息级签名（AAT）——本模块的 AAT 通道为此准备，但目前在 `agents.json` 里
配置 `aidPublicKey` 的 Agent 极少，实际未启用。

### 兼容性
- 单例默认 `allowNameOnly=false`：此前「按名字拿到信任」的情况**本来就不存在**（键对不上），
  故无行为回退；只是把隐患显式化
- 返回值新增 `matchedBy` 字段，旧调用方忽略即可

## v5.2.3（2026-10-24）— allowedScopes 不再变空：`[] || x` 这个坑（明德实测反馈）

### 背景
明德升级后补了用户公钥，握手仍卡住。它自己发现缺 `data/capabilities.json`，
并报出「日志写降级、代码返回 {}」的不一致。顺着查，**还有一个更深的坑**。

### 两个缺陷（都在 `server_v5.js`）

**1️⃣ 日志与代码不一致（明德报的）**
```js
console.warn(`... 不存在，降级到 ['a2a:send']`);
return {};   // ← 实际没降级
```

**2️⃣ 兜底表达式根本不兜底（我查出来的，比 1 更严重）**
```js
allowedScopes.length > 0
  ? allowedScopes
  : (identity.capabilities && Object.keys(identity.capabilities)) || ['a2a:send']
```
**空数组是 truthy**：`[] || ['a2a:send']` 恒等于 `[]`。
identity 声明了 `capabilities` 但为空时，最终 `allowedScopes = []`
→ challenge 阶段无 scope 可授 → **init 能过、approval 永远空授权**。
又一个「绿灯」，且比前两次更隐蔽：没有任何报错，只是默默什么都不给。

### 修复
- 新增 `resolveAllowedScopes(caps, identityDoc)`：按**长度**显式判断，返回 `{scopes, source}`
- 来源可核对：`capabilities.json` / `identity.capabilities` / `default`
- 启动与**热更新共用同一解析**（此前热更新直接 `Object.keys(newCaps)`，把文件删空同样会变 []）
- 握手路由不再重复兜底 —— 重复兜底正是这个坑的来源
- 日志只说事实：缺文件就说「本文件不声明 scope」，兜底由下一行如实报告

### 判据（可机械核对）
- 启动日志必有一行 `[CAPABILITIES] 📋 allowedScopes 来源: <source>（N 个）`
  或 `⚠️ 本实例未声明任何 scope，已回退最小集合 ['a2a:send']（来源: 默认值）`
- `allowedScopes` 永远非空
- 新增 `tests/capabilities-resolve.test.js` **8 条**（含反向验证：把旧写法放回去必须变红）

## v5.2.2（2026-10-24）— 握手端点不再「假绿灯」：用户公钥不可用就拒绝挂载

### 背景
与明德重做握手时，`init` 成功、`proof` 永远返回 `uac_invalid: bad_public_key`。
根因在对方侧（用户公钥没配/路径读不到/不是合法 JWK），但**我们这边也有同一个病**：
`createHandshakeRouter` 允许 `userPublicKey = null` 照样挂载端点，
于是端点"在"、`init` 能过、`proof` 必然失败 —— **一个永远走不完的绿灯**。

### 修复
1. **启动即校验用户公钥**（`server_v5.js`）：解析失败 → 不挂载端点 + 打印精确原因
   - 未配置 / 文件读不到 / JSON 解析失败 / 不是合法 JWK / 不是 ed25519 —— 分别给话
2. 错误分类下沉到 `csb-security` 1.0.1：`missing_user_public_key` / `bad_public_key(detail)` / `bad_signature` 三分

### 判据（可机械核对）
- 坏公钥启动 → 日志出现 `⚠️ 握手端点启用失败（AID/密钥配置错误）: 用户公钥不可用 → 握手端点不挂载…原因: …`
- 好公钥启动 → `✅ 对等握手端点已启用: /a2a/handshake`
- 依赖版本：csb-security **>= 1.0.1**

## v5.2.1（2026-10-24）— 修「升级覆盖配置导致静默全瞎」（舟楫实测）

### 🔴 P0：升级把实例配置覆盖成模板，服务"看起来正常，实则全瞎"

**现象**（舟楫 172.28.0.27 升级 5.1.1 后）：`/health` 返回 `status:"ok"`，
但 `dht: CACHE`、`onlineAgents: 0`、`registries: localhost:3099`。

**根因两层，第一层是我造成的**：

1. 我在 P1-3「真实 IP 脱敏」时把公开仓的 `config/agents.json` 改成模板，
   其中 `registry.local = "http://localhost:3099"`（其余字段都是 `<PLACEHOLDER>` 风格，
   **唯独这一个写成了看起来合法的具体地址**）。
   各实例 `git pull` → **本机真实配置被模板覆盖**。
2. `start-v5.sh` 里有注册表地址修正逻辑，但本机真实入口是 watchdog 直跑
   `node server_v5.js`，**绕过 start-v5.sh** ⇒ 修正从不生效 ⇒ 回落到 localhost:3099。

**最坏的地方不是错，是"错得看不出来"**：注册失败只让 DHT 静默降级，
而 `/health` 的 `status` 是写死的 `'ok'`。监控看到绿灯，实际全瞎。
又一次印证 2026-10-24 的教训「警告不是防线」。

### 修复三件

**1. 模板里的占位符必须一眼就不像有效值**
```diff
- "local": "http://localhost:3099",
+ "local": "http://<REGISTRY_URL>:3099",
```

**2. loader 检测占位符并显式报错**（不再静默当配置用）
- 新增 `isPlaceholder()` / `registryHealth()`
- 解析到 `<XXX>` 时打 ERROR 级日志，说明「升级覆盖了本机配置」+「真实值该放哪」
- `registryHealth()` 返回 `{ok, source, effective, placeholder, hint}`，
  `source` 明确区分 `env:A2A_REGISTRY_URL` / `agents.local.json` / `agents.json` / `placeholder`

**3. `/health` 的 status 不再写死**
| 条件 | status |
|---|---|
| registry 配置未解析（占位符） | `degraded` |
| DHT 非 FULL 且 `onlineAgents=0` | `degraded` |
| 其余 | `ok` |

新增 `checks` 字段（可机械核对，不靠人读日志）：
```json
"checks": {
  "configResolved":    { "ok": true, "source": "env:A2A_REGISTRY_URL", "effective": "http://...", "hint": null },
  "registryReachable": { "ok": true, "onlineAgents": 17, "dhtLevel": "FULL", "hint": null }
}
```
降级时额外给 `degradedReason`（人话）。

### 验证

| 场景 | 修前 | 修后 |
|---|---|---|
| 注册表指向不存在的地址 | `status: ok`（骗人） | `status: degraded` · `degradedReason: 注册表不可达（onlineAgents=0, DHT=CACHE）` |
| 配置仍是占位符 | 静默使用 | ERROR 日志 + `configResolved.ok=false` |
| 正常 | ok | ok（不误报） |

测试：`tests/health-degraded.test.js` **3 条**（起真实临时实例打 /health，
覆盖「不可达必降级」「正常不误报」「自检字段齐全」）。
与 think/bid 合计 **23/23**。

### 给已踩坑实例的恢复步骤（舟楫已验证可行）

```bash
# 1. 真实注册表地址写进本机配置（不入库）
#    config/agents.local.json:
#    { "registry": { "local": "http://<你的注册表>:3099" } }
#    或启动点注入 A2A_REGISTRY_URL

# 2. 模板里的 self 段（<YOUR_AGENT_NAME>/127.0.0.1）同样要覆盖：
#    "self": { "name": "你的名字", "host": "你的对外 IP", "port": 3100 }

# 3. 重启后验收三格：
curl -s localhost:3100/health | jq '.status, .checks'
#    status=ok · configResolved.ok=true · registryReachable.onlineAgents>0
```

---

## v5.2.0（2026-10-24）— BID 信号钩子上游化（opt-in）

### 背景

若琢（172.28.0.4:3100）自 2026-10-21 起在本地维护一个「bid_signal 实时落盘 hook」
（`a2a-memory.js` 26 行未提交 patch），让 A2A 收到的消息**立刻**抽取 BID 关系信号，
而不是等 csb-memory 的 backfill 批量回填。

它为此做了两道补丁：① patch 从 `/tmp` 挪进工作区 `.local-patches/`（容器重启不丢）
② 启动脚本加自愈（检测缺失 → `git apply` 自动补回）。

**问题不在它做得不好，而在这种维护方式本身就是负债**：
- 每次升级要 `stash`/`pop`，2026-10-24 升 5.1.1 时全靠 `--stash` 才没丢
- 自愈每次启动都 `git apply`，上游一旦改动 `a2a-memory.js` → 冲突 → 自愈失败 → 人工介入
- 别人想要这个能力无从复用

### 本版：做成官方可选开关

新增 `bid-hook.js`（330 行），`a2a-memory.js` 在 `processConversation` 开头接线：

```js
bidHook.onConversation({ agentName, message, reply, direction: 'in' });
```

- **默认关闭**：`A2A_BID_SIGNAL` 未设或 ≠1 时模块完全不参与，**行为与旧版逐字节一致**
- **共用抽取器**：直接 `require` `csb-memory/lib/core/bid-signal.js`，不另造词表
  （避免"上游一套词表、各实例一套"的分叉）
- **位置在蒸馏之前**：即使这条对话因"不值得蒸馏"被跳过，关系信号仍会被记下 ——
  信号看的是"有没有承诺/纠错/决策"，与"值不值得蒸馏"是两个判据，不该互相连坐
- **落盘**：追加 `<data>/bid-signals.jsonl`，`origin: "a2a-live"`
  （与 csb-memory backfill 的 `origin: "backfill"` 区分，可追溯来源）

### 失败策略（若琢 2026-10-24 指出我方案缺这一项）

它说得对：**自愈脚本最危险的失败方式是静默失效**——补丁没打上、钩子没生效，
但日志一片安静，人以为"还在工作"，实际信号早已停止积累。

本模块四级状态，每级可机械核对：

| 状态 | 触发 | 行为 |
|---|---|---|
| `DISABLED` | `A2A_BID_SIGNAL` 未设/≠1 | 完全不动 |
| `UNAVAILABLE` | 找不到 `bid-signal.js` / require 失败 | 告警 + 计数 + 可读原因 |
| `DEGRADED` | 抽取抛错 / 返回非法结构 / 账本写失败 | 告警 + 计数 + 可读原因 |
| `OK` | 正常 | 静默 |

**核心不变量**：`stats()` 永远能答出「我现在是哪个状态、从什么时候开始、失败几次、
最后一次错误是什么」。看门狗/自检据此判断，而不是靠 grep 日志猜。
对应 CSB 工程契约 P1「拒绝要计分，不许静默丢弃」。

自检命令：
```bash
node bid-hook.js --status     # 输出完整状态 JSON
```

### 环境变量

| 变量 | 说明 |
|---|---|
| `A2A_BID_SIGNAL=1` | 开启（默认关闭） |
| `A2A_BID_SIGNAL_PATH=<p>` | 指定 `bid-signal.js` 路径（跨仓部署时用） |
| `A2A_BID_SIGNAL_LEDGER=<p>` | 账本路径（默认 `<data>/bid-signals.jsonl`） |

### 测试

`tests/bid-hook.test.js` **8 条**，锁死 5 条不变量：

- **I1** 默认关闭时完全不参与（`attempted` 保持 0）
- **I2** 三类信号（promise / correction / decision）正确抽取，correction 方向 in/out 正确
- **I3** 非关系文本不误报（"技术复盘有'错'字但无关系对象"必须排除），跳过要计数
- **I4** 失败必须可查（UNAVAILABLE/DEGRADED 都要能从 `stats()` 读到，不许静默）
- **I5** 钩子永不抛错（畸形输入 / 跨仓缺失 / 账本不可写都不能把记忆链路带崩）

与 `thinking-leak.test.js` 合计 20/20 通过。

### 给若琢的迁移步骤（发版后）

1. `git pull` 更新到 5.2.0
2. 删掉 `.local-patches/bid-signal-hook.patch` 与启动脚本里的自愈逻辑
3. `.env` 加 `A2A_BID_SIGNAL=1`
4. 重启，`node bid-hook.js --status` 应显示 `status: OK`
5. 历史 12 条信号不受影响（那是它自己账本里的，本模块只追加新信号）

---

## v5.1.1（2026-10-24）— 思维链泄漏修复 + 版本号单一事实源

### 🔴 P0 思维链泄漏（明德 2026-10-24 升级后实测发现）

**现象**：自动应答正文里带回模型原始思维链，且结尾被截断：

```
<think>We need answer in Chinese 50-200 chars, likely acknowledge self-check...
```

**根因不是模型，是本模块的两处设计**（`llm-router.js`，5 个适配器出口一致）：

1. `content || reasoning_content` —— 正文为空时把推理过程当正文返回。
   本意是「至少给点东西，别静默空回复」；实际效果是「把里屋的东西推到客厅」。
2. content 内嵌 `<think>` 标签未剥离 —— 推理模型常见输出形态。
3. 截断成因：reasoning 吃满 `max_tokens` 预算，正文还没开始就结束 → 触发上面的降级。

> 注：这不是 `50f1cb8「默认值恢复历史行为」` 引入的。llm 本来就是历史默认值，
> 缺陷一直在，只是此前正文通常非空所以没暴露。

**修复**（双保险）：

- 新增 `stripThinking()`：剥离 `<think>/<thinking>/<reasoning>/<analysis>` 成对标签
  与**未闭合残尾**（即明德实测那个被截断的形态）
- 新增 `pickReply()`：`reasoning_content` **永不**作为对外正文；正文为空 → 返回 `null`，
  由上层固定兜底（宁可短，不要把思考当话）
- `a2a-standard-api-v5.js` 在 LLM 回复出门前**二次剥离**，不依赖调用方记得处理
- 兜底路径 `_callLLMOriginal` 同步收口

**不变量**（由 `tests/thinking-leak.test.js` 锁死，12 条）：

- I1 任何对外正文，think 块必须被剥离（含未闭合残尾、大小写混合）
- I2 `reasoning_content` 永不作为对外正文

**运营建议**：`A2A_AUTO_REPLY` 若要从 `ack` 开回对话，建议用 `split`
（通知类 → ack，对话类 → llm），而非纯 `llm`。

### 🟡 版本号单一事实源

**现象**：`server_v5.js:97` 硬编码 `A2A_VERSION = '5.0.1'`，而 `VERSION` 是 5.1.0
→ `/health`、`/.well-known/agent.json`、注册表上报的版本**全都是错的**。
任何实例升级后都会误报旧版本（明德称之为「health 报告的版本号不可信」）。

**修复**：

- `A2A_VERSION` 改为运行时读取 `VERSION`（回退 `package.json`）→ 版本只在一个地方改
- `evomap-validate.js` 原断言 `pkg.version === '5.0.1'`（把错误版本钉死）改为断言
  「`VERSION` 与 `package.json` 一致」——以后谁再硬编码版本会被校验拦下

### ✅ 验证

| 项 | 结果 |
|---|---|
| `/health` version | 5.0.1 → **5.1.1** |
| agent card version | 5.0.1 → **5.1.1** |
| 注册表上报版本 | 5.0.1 → **5.1.1** |
| llm 模式 think 泄漏 | `<think>` 0 处、推理痕迹 0 处 |
| 回归测试 | `thinking-leak` 12/12 · `agent-card-manifest` 通过 |
| 功能回归 | `test-v4-full.js` 10/10 |
| 重启后在线 | onlineAgents 17 · DHT FULL · 无掉线 |
| 对端往返（明德） | http 200 · 103ms · think 0 |

### 📌 给邻居实例的升级提示

- 升级后**重启**才会生效；重启后 `/health` 的 `version` 应是 `5.1.1`
- 若你此前把 `A2A_AUTO_REPLY` 设成 `ack`，可以保持；要开对话建议用 `split`
- 不需要动 `identity.json`；本次无破坏性字段变更

---

## v5.1.0（2026-10-24）— 安全加固（明鉴评审 P0×2 / P1×3 / P2×2）

- **P0-1** signer 弱默认密钥 → fail-closed：无 `A2A_SHARED_SECRET` 时拒绝构造；
  dev 须显式 `A2A_ALLOW_INSECURE_SIGNER=1` 且密钥改为进程内随机；≥16 字符；启动打印指纹
  - 实测发现更严重的一层：旧 `dispatcher.js` 是 `skipSignature = !process.env.A2A_SHARED_SECRET`
    —— 未配置时**不是防线变弱，是防线不存在**（我们自己的实例日志里 warn 46 次）
- **P1-1** 两处 `DEFAULT_SECRET` 回退删除 → 无密钥降级 `unsigned:true`（可机械识别）
- **P1-3** 真实 IP 全脱敏；`agents.json` → 占位符模板，真值进 `agents.local.json`(gitignore) + loader 深合并
- **P2-4/5** watchdog 空回调落日志；`injectIsolated` `workingDir` 硬闸 + `timeout≤120s`
- **新增** `harness_manifest`（宪章第十四条 C1–C8 组件声明，C1/C2 必须 `readonly:true`）
- **新增** `blocked` 拦截真生效（`a2a-standard-api-v5.js:498-526` 读 `connection_level=blocked` 并拒收）
