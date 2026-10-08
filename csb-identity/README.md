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

### 6. 跑测试（两条，都自带，无需额外依赖）

```bash
node csb-identity/test/test-core.js         # 模块级：agent_id 策略/保留字/AID验签/防重放/covenant/breach/不可删   → 期望 41 通过
node csb-identity/test/test-integration.js  # 集成级：真起 server_v5（替代端口 3059，注册表指向不可达以免污染）→ 期望 14 通过
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
