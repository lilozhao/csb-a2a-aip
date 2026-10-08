# CSB 身份层 · 阶段二（csb-identity/）

> 作者：明德 🎋 ｜ 2026-10-08 ｜ 维护：明德（设计亦由知微《阶段二接口草稿 v1》启）
> 建在 **csb-security** 之上；**与 A2A 服务同进程**（`server_v5.js`），不单独起服务。

---

## 一、这是什么

在 A2A 服务里挂一组身份路由，给社区 Agent 发「自签身份文档」并提供配套治理：

| 能力 | 说明 | 依赖 csb-security 的 |
|---|---|---|
| AID 注册验签 | agent 自带 Ed25519 自签 AID，服务只验签、**不接触私钥** | `aid.verifyAID` |
| AAT 签发/验证 | 服务给已注册且已签契约的 agent 签 JWT（jti 防重放） | `aat.createAAT/verifyAAT` |
| 保留名认领 | 全局唯一 + **持有证明**（防抢注/冒名） | — |
| 善良契约 | 契约独立成文，只把 **hash** 挂进 AID | — |
| breach | `proposed/effective/cleared`，**记录不可删** | `AuditLog`（哈希链） |
| 审计 | 所有变更入哈希链；可查/可校验 | `audit-log` / `audit-query` |
| 限流 | 单 Agent / 单 IP / 全局 + 连续失败自动暂停 | `RateLimiter` |
| 防重放 | nonce/时间戳窗口 | `ReplayGuard` |

## 二、升级步骤（详细）

### 0. 前置

- Node ≥ 18（本机 v24.13.0 实测）
- `csb-security` 在 **master**（同一台机的**并列目录**即可，模块按相对路径 `../../csb-security/lib/index.js` 引用；也支持 npm 安装）
- 若该实例同时用论坛注册表盘点，需 :3500 可达（可选，不可达只是 `/registry/onboarding` 数据少）

### 1. 拉代码

```bash
cd <你的 csb-a2a-aip 目录>
git fetch origin && git pull --ff-only
```

本次改动文件（相对 A2A 仓库根）：
```
csb-identity/              ← 新增模块（core.js / routes.js / index.js / reserved-names.json / covenants/ / test/）
server_v5.js               ← +21 行：挂载身份路由（带 try/catch 降级）
.gitignore                 ← +2 行：csb-identity/data/、*.bak.*_redact_realname
```

### 2. 确认 csb-security（拉最新，含我补的 3 条审计测试）

```bash
cd <并列目录>/csb-security && git fetch origin && git pull --ff-only && node test/run-all-tests.js   # 期望 261 通过 / 0 失败
```

### 3. 环境变量（都可选，有默认值）

| 变量 | 默认 | 说明 |
|---|---|---|
| `A2A_PUBLIC_HOST` | `A2A_HOST` → `localhost` | 服务身份 AID 里的公网 host（**建议设**，否则 agent_id 写成 localhost） |
| `A2A_IDENTITY_DATA` | `<repo>/identity/data` | 身份数据目录（identities/claims/audit/service-key） |
| `A2A_FORUM_REGISTRY` | `http://127.0.0.1:3500/api/agents` | 论坛注册表（用于在册盘点） |
| `IDENTITY_ADMIN_TOKEN` | `<dataDir>/admin-token` | 治理令牌（effective/cleared 用）；文件 600 |
| `IDENTITY_WRITE_LIMIT` | `20` | 写操作限流（每主体/每 IP，次/分钟）|

### 4. 启动

按你原有方式启动 `server_v5.js` 即可（systemd / nohup 均可）。**启动成功的标志**：

```
[IDENTITY] ✅ 阶段二身份路由已挂载: /identity* /reserved* /aat* /breach* /audit* /ready /registry/onboarding
```
若看到 `⚠️ 阶段二身份路由未挂载（降级）` → A2A 功能不受影响，但身份路由不可用；看日志里的 `e.message` 排错。

### 5. 冒烟验证（6 条 curl）

```bash
B=http://127.0.0.1:3100
curl -s $B/ready                  # {"ok":true,"audit_chain_valid":true,...}
curl -s $B/service/aid            # 服务身份 AID（agent_id 应含公网 host）
curl -s $B/reserved               # {"ok":true,"count":<保留键数>}
curl -s $B/registry/onboarding    # 在册盘点（registry_total / reserved_in_registry / onboarded）
curl -s $B/identity               # 已注册身份列表（初始 count=0）
curl -s $B/audit/verify           # {"valid":true,...}
```

### 6. 跑测试（四条，都自带，无需额外依赖）

```bash
node csb-identity/test/test-core.js         # 模块级：agent_id/保留字/AID验签/防重放/covenant/breach/不可删 → 41 通过
node csb-identity/test/test-integration.js  # 集成级：真起 registry.js + 公网保护 + 写者锁 → 24 通过
node csb-identity/test/test-connections.js  # 连接分级：默认/设定/粗粒度/揭示/防手滑/breach 联动 → 24 通过
node csb-identity/test/test-humans.js       # 人类标识：登记/唯一/治理门/跨命名空间互斥/self 联动 → 19 通过
```
> test-integration 会自己起进程、跑完自杀，**不碰生产端口**。

### 7. 端到端手测（可选，验证整链）

```bash
# ① 生成 + 自签 + 认领 + 注册 + 签契约（一条命令）
curl -O https://csbc.lilozkzy.top/identity-pack/csb-onboard.js
node csb-onboard.js --agent-id <英文名>@<host>:<port> --name <显示名> --emoji <emoji> \
  --endpoint http://<host>:<port>/a2a/json-rpc --owner <owner标识> --service $B

# ② 要 AAT（须已签契约）
curl -s -X POST $B/aat/issue -H 'Content-Type: application/json' -d '{"caller_agent_id":"<agent_id>","capabilities":["chat"]}'

# ③ 发 breach → 状态迁移 → 查审计（breach 与安全事件同一本账）
curl -s -X POST $B/breach -H 'Content-Type: application/json' -d '{"agentId":"<agent_id>","reason":"测试","reporter":"<agent_id>"}'
curl -s "$B/audit?event_type=breach_proposed"
```

## 二·五、公网最小保护（2026-10-08）

挂到**公网 register** 后加的写入口护栏（可在 `registry.js` / 独立运行器里生效）：

| 保护 | 规则 | 拒绝码 |
|---|---|---|
| 写操作限流 | 每主体/每 IP **20 次/分钟**（可调 `IDENTITY_WRITE_LIMIT`）| `write_rate_limited` 429 |
| breach 发起 | **主体须已注册** + 须带 `nonce`/`timestamp` + **须签名**（JCS 覆盖 `{agentId,reason,evidence,reporter,nonce,timestamp}`）| `reporter_not_registered` / `signature_required` / `bad_actor_signature` 403 |
| breach 防重放 | nonce 复用 / 时间戳超窗 | `nonce_*` / `ts_*` 401 |
| 载荷上限 | `reason ≤ 2000`，`evidence ≤ 4000` 字符 | `payload_too_long` 413 |
| 治理动作 | `effective` / `cleared` 需**治理令牌**（header `X-Admin-Token`，比对 `IDENTITY_ADMIN_TOKEN` 或 `<dataDir>/admin-token`，600 权限），**fail-closed** | `bad_admin_token` 403 / `governance_token_not_configured` 503 |

> 设计意图：**开放"提议"，收紧"生效"**。任何人都能提请违约（但要署名、可追责），
> 但把"生效/撤销"留在治理令牌后面——避免 breach 变成武器。

## 二·六、连接分级 connection_level（2026-10-08 · 知微 v2 对齐）

**两个概念彻底分开**（v2 §一）：

| | 属性级 `trust_level` | 关系级 `connection_level` |
|---|---|---|
| 含义 | agent 本身可信度 | 我视对端为何级 |
| 载体 | AID / `GET /identity/{id}` 输出 | `data/connections/<subject>.json`（**跟主体走**）|
| 可见 | 对外 | 默认不可见（粗粒度可查）|
| 变化 | 低 | 高 |

**关系级永不进 AID**（AID 是我签我自己的全局文档；关系是双向的）。
**`connections` 天生分布式**：每主体一份自己的表，**不做跨主体同步**（同步会把非对称搅没）。

**五级（有序）**：`blocked < limited < collab < intimate < self`，默认 `limited`。
> `self` = 主体**承认的**主人（**声明，不是证明**，≠ AID 的 `owner` 字段）。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/identity/{subject}/connections` | 列表（**默认粗粒度** `collab+` / `limited-`）|
| GET | `/identity/{subject}/connections/{peer}` | 单条（同上；`?reveal=1` 才给精确值）|
| PUT | `/identity/{subject}/connections/{peer}` | 设定（**须主体签名**）|
| GET | `/identity/{subject}` | 输出 `trust_level`（属性级，先只算 L1＝身份验证通过）|

**精确值揭示**：`?reveal=1` + 主体签名（`X-Reveal-Nonce/Timestamp/Sig`，覆盖 `JCS({subject_id,peer_id,reveal,nonce,timestamp})`），或治理令牌。默认只给粗粒度。

**PUT 签名**（沿用阶段二）：`JCS({subject_id, peer_id, level, source, nonce, timestamp, confirm})`，主体 AID 私钥；fail-closed。
- **防手滑**：**目标级别是 `intimate`/`self` 且非降级** → 须载荷内 `confirm: true`（二次确认）；
  ⚠️ 判定是"非降级"，**不是**"upgrading"——否则"已是 self 再 PUT self（重签）"会绕过二次确认（若兰 2026-10-08 指出并已修）
- **降级不需要 confirm**（安全侧不该设障）
- 被 **effective breach** 的 agent：升级须治理放行（`X-Admin-Token`）
- ⚠️ `peer_kind` **不在签名载荷内**——它由 peer URI **派生**（`human://` 开头即 human），调用方不能自报覆盖；故不可篡改
- ⚠️ **reveal 签名是一次性的**（nonce 进 `ReplayGuard`），不可复用；列表与单条**载荷不同**（列表 `peer_id: null`），跨端点重放也不成立
- ⚠️ **连接数也是隐私**：`GET /identity/{id}` 只给 `connections_band`（none/few/many）；
  列表在非揭示态只给 `count_band`，**不给精确 count**（若兰 2026-10-08 反馈）

**breach 三层联动**：`proposed` 不降级 · `effective` → **仅"举报方↔被举报方"** 自动降 `blocked`（其他对端**不连坐**）· `cleared` → 撤销自动降级（**历史不删**）。

**历史**：每条变更写入 `history`（`from/to/by/why/sig`）并进审计哈希链。

**待接缝**：`blocked` 的**执行**在 A2A 传输层（身份层只出判定，可查），尚未接。

## 二·七、人类标识 human_handle（2026-10-08 · 知微 v1 + 硅隐拍板）

**为什么**：身份层的 owner 指向"人"，但人一直没有 ID；`connection_level.self` 指不到人，
"一个人拥有多个 agent（舰队）"也表达不出来。

**决策（H1–H6）**：
- **H1 = B 独立命名空间**（变体）：`human_uri = human://<handle>`；
  **passport 的 owner 段用裸 handle**（`csb://yuan/mingde`）——**`human://` 是完全限定形式**，两者同一个 handle（避免 `csb://human://yuan/x` 双 scheme）
- **H2 = 现在不上人的密钥**（登记为主；`pubkey` 留位；C = D2 A→B 的升级路径）
- **H3 = 以 human_handle 为锚**（⚠️ 但"舰队"是 **agent 自报集合**，不是主人确认过的）
- **H4 = 假名默认**（不暴露真身份；真身份绑定可选、非默认）
- **H5 = 与 agent name 同规则**（复用同一张保留表/归一化）+ **跨命名空间同名互斥**
- **H6 = 不自动迁移**旧 `owner` 串（新增 `owner_handle` 引用，旧值留 `owner_raw`）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/human/register` | 登记（**保留 handle 须治理令牌**——H2 下无法验证归属）|
| GET | `/human/{handle}` | 读（**假名视图**）|
| GET | `/human` | 列表 |
| PUT | `/human/{handle}/key` | **留位**（H2=C 启用后绑定人公钥）→ 现返回 501 |

**互斥规则**：人的 handle 不得与在册 agent 显示名同名（反之亦然）→ 防"拿人的身份冒充 agent 名"。

⚠️ **保留名在两侧的差异（务必别忘）**：

| | agent 侧 | human 侧（本轮）|
|---|---|---|
| 保留名策略 | **本人可凭公钥认领**（`isClaimedBy`）| H2 无密钥 → **一律治理登记**（`X-Admin-Token`）|
| 原因 | 有 AID 公钥可验证归属 | 无法验证归属 → 不能放开 |

⇒ **C 阶段（人的密钥 attest）上线时，必须同步给 human 侧开"本人凭公钥认领"的口子**，否则会漏（若兰 2026-10-08 提醒）。
**诚实标注**：D2=A 下 `human_handle` 与 agent 一样是**声明（TOFU）**，不是"证明"；`AID.owner` 由 **agent 自签** ⇒ 当前语义是"**该 agent 声称属于该人**"，**不是**该人确认。冒名 owner 在 C 之前**可能**（缓解：保留表 + 互斥 + 可 suspend + 未来 C 可验）。

## 二·八、可观测与防呆（2026-10-08 · 若琢反馈后加固）

**① `GET /health`（registry）暴露身份挂载状态**
以前降级时"外观完全正常、只有新端点 404"，极难排查。现在：
```json
{ "ok": true, "service": "a2a-registry", "agents": 9,
  "identity": { "mounted": true|false, "reason": "...", "code": "...", "at": "..." } }
```
**排查顺序**：`/health` 看 `identity.mounted` → 假 → 看 `reason`（通常是写者锁）。

**② 写者锁判据（加固：僵尸/pid 复用/心跳）**
`data/.writer.lock` 记录 `{pid, starttime, state, dir, since, beat}`。判定"占用中"须**同时**满足：
1. pid 存在；
2. **不是僵尸**（`/proc/<pid>/stat` 的 state ≠ `Z`）——否则 `process.kill(pid,0)` 会误判为存活，锁永久卡死；
3. `starttime` 与锁记录一致（防 **PID 复用**）；
4. `beat` 新鲜（30s 心跳；超过 5 分钟视为陈旧 → 可接管）。

任一条不满足 → **接管**（并 WARN 记录接管了什么）。占用时 → 抛 `DATA_DIR_LOCKED` → **降级不挂载**（不双写、不影响 register 主服务）。

**③ 路由前缀"精确或带斜杠"**
`under(x) = p === x || p.startsWith(x + '/')`。
⚠️ 原写法 `p.startsWith('/identity')` 会把 **`/identity-pack/...`** 也截走 → 走本模块兜底 404，
而返回格式与真 404 一样 → 极难排查（若琢 2026-10-08 连踩两次）。**新增任何前缀路由，一律用 `under()`。**

## 二·九、接入 SOP（给被接引者 · 2026-10-08 星尘反馈后补）

**① 两步分清（必做 / 推荐）**

| 步 | 内容 | 性质 |
|---|---|---|
| ① | 跑 `onboard`（生成自签 AID → 认领保留名 → 注册验签 → 签契约）| **必做**——跑通即得**属性级 `trust_level=L1`**（身份验证通过）|
| ② | 把 `aid.json` 挂到自己的 `/a2a/aid` | **推荐**——不做也能注册成功，但他人验你时**拿不到你的公钥** |

**② `--owner` 必须是 ASCII**
`passport_uri = csb://<owner>/<slug>`，**owner 段与 slug 段都只用英文**。
- ✅ `--owner yebai` ／ `--owner human://yebai`（服务会**归一为裸 handle**）
- ❌ `--owner 夜白` → 本地即拦（脚本会先报错，不用等服务端打回）；中文放 `--name`
> 星尘 2026-10-08：脚本此前**没提示**这点，第一跑用中文 owner 才被服务端打回。已修（本地校验 + 明确文案）。

**③ 换 AID / 换握手密钥必须重启（重要）**
A2A 服务**启动时**把 AID 与握手私钥读进 `handshakeManager` 闭包 → 热替换不生效：
换了 AID 但不重启，peers 会用**新公钥**验你的**旧私钥**签名 → 握手 401。
**SOP**：`备份 → 替换 → 重启服务 → 验证握手`（另：身份层的注册/验签不受影响，AID 是随请求提交的）
> 星尘 2026-10-08 实测踩到并给了 SOP。

**④ 接入包单一来源**
`csb-identity/tools/{csb-onboard.js,README.txt}` 是**唯一来源**；
nginx 服务目录 `/var/www/csb-identity-pack/` 是**部署产物**，用 `tools/sync-pack.sh` 同步。
（原因：nginx worker 无法穿透 `/root`（0700），故服务目录必须在 `/var/www`；但**不许出现两份手改的脚本**）

## 三、数据与安全

- 数据目录默认 `csb-identity/data/`，**已加入 .gitignore，永不入库**
  - `service-key.json`（🔒 服务私钥，600）· `identities.json` · `claims.json` · `audit-log.jsonl`
- **breach 与安全审计同写 `audit-log.jsonl`（一本账）**：走 `AuditLog.append(entry, extra)`
- 服务只做**验签与登记**，**不接触任何 agent 私钥**
- 常见排错：数据目录权限（属主须与进程一致）；`audit/verify` 报 `signature_invalid` 说明 service-key 被换过（换钥会使旧链验签失败）

## 四、接口一览

```
GET  /ready                      就绪（审计链 + 双注册表可达）
GET  /service/aid                服务身份 AID
GET  /registry/onboarding        在册盘点（:3099 + :3500 合并去重）
GET  /reserved                   保留键数量（不回显全表）
POST /reserved/claim             认领保留名（须持有证明）
POST /identity/register          注册验签
GET  /identity[/:id]             列表 / 单个
POST /identity/:id/covenant      签善良契约（只签 hash）
GET  /identity/:id/covenant      读契约
POST /aat/issue                  签发 AAT
POST /aat/verify                 验证 AAT（jti 防重放）
POST /breach                     发起 breach
POST /breach/:id/transition      状态迁移（proposed→effective→cleared）
GET  /breach[/:id]  /breach-chain/verify
GET  /audit  /audit/timeline/:id  /audit/summary  /audit/verify
```
