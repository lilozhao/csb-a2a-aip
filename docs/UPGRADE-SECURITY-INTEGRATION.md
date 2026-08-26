# CSB-Security 集成指南（csb-a2a-aip）

> 集成方式：**A+C 结合**（2026-08-22 一澜拍板）
> - **A**：`package.json` optionalDependencies 声明 `csb-security: file:../csb-security`（单一权威实现）
> - **C**：运行时 try/catch 探测，csb-security 缺失/报错 → 自动降级 legacy 实现

## 集成状态

| 阶段 | 内容 | 状态 | commit |
|------|------|------|--------|
| Phase 1 | trust + e2e 换源 csb-security（等价替换） | ✅ | 62a2f34 |
| Phase 2 | 按 Agent 限流 + 哈希链审计（增强替换） | ✅ | a433287 |
| Phase 3 | /a2a/handshake 端点 + 异常检测（新能力） | ✅ | 见本仓 |

## 架构

```
csb-a2a-aip/
├── security-adapter.js      # 适配层：加载 csb-security，失败降级 legacy
├── security-handshake.js    # /a2a/handshake 对等握手路由（Phase 3）
├── server_v5.js             # 集成点（trust / e2e / rateLimiter / audit / handshake / anomaly）
└── a2a-standard-api-v5.js   # 限流双模式 + 异常检测接入
```

### 加载优先级

1. `require('../csb-security/lib/index.js')`（相对路径，不依赖 npm install）
2. 失败 → legacy（trust-manager.js / a2a-e2e-encryption.js / standard-api RateLimiter）
3. 启动日志显示 `[SECURITY] ✅ 已加载 csb-security` 或 `⚠️ 降级 legacy`

## 环境变量

| 变量 | 作用 | 默认 |
|------|------|------|
| `A2A_SECURITY_AUDIT` | `1` 启用哈希链审计（data/audit/） | 未设 → legacy /tmp 明文 |
| `A2A_SECURITY_ALERT_WEBHOOK` | 异常告警推送 URL（飞书 webhook 等） | 未设 → 仅 console |
| `A2A_SECURITY_HANDSHAKE_AID` | callee AID 文档 JSON 路径（启用握手端点） | 未设 → 端点不注册 |
| `A2A_SECURITY_HANDSHAKE_KEY` | callee Ed25519 私钥 PEM 路径 | 同上 |
| `A2A_SECURITY_HANDSHAKE_USER_PUBKEY` | 用户公钥 JWK（文件路径或内联 JSON，验证 UAC） | 未设 → UAC 验证失败 |

## 启用对等握手（Phase 3）

```bash
# 1. 生成 AID 密钥对（csb-security 提供）
node csb-security/examples/gen-aid.js   # 或 scripts/gen-aid.js

# 2. 配置环境变量启动
export A2A_SECURITY_HANDSHAKE_AID=/path/to/aid.json
export A2A_SECURITY_HANDSHAKE_KEY=/path/to/key.pem
export A2A_SECURITY_HANDSHAKE_USER_PUBKEY=/path/to/user-pub.jwk
node server_v5.js
# 启动日志: [A2A] ✅ 对等握手端点已启用: /a2a/handshake (agent_id)
```

握手流程（caller 视角，LIGHT 级别）：
1. `POST /a2a/handshake { action:'init', message: initMsg, caller_aid }` → challenge
2. `POST /a2a/handshake { action:'proof', message: proofMsg, caller_aid }` → approval
3. L1 直接获得 session；L2+ 再发 `{ action:'complete', message, approval_msg }`

安全特性：nonce 重放拒绝、时间戳漂移拒绝、AAT/UAC 签名验证、权限交集、L3 用户确认（默认拒绝，可注入回调）。

## Docker 部署

镜像构建需包含 csb-security（file: 依赖）：

```dockerfile
# 在 workspace 根目录构建（上下文含两个仓库）
COPY csb-a2a-aip /app/a2a
COPY csb-security /app/csb-security
WORKDIR /app/a2a
```

> 注意：optionalDependencies 的 file: 路径在 `npm install` 时若不存在仅警告不报错（降级设计）。

## 降级路径验证

```bash
# 确认降级可达（csb-security 缺失时）
node -e "try{require('/nonexistent/csb-security')}catch(e){console.log(e.code)}"  # MODULE_NOT_FOUND
```

## 回归测试

```bash
node test-v4-full.js     # 10/10（协议面）
node test-v4.js          # 集成全过
node test-v4-compat.js   # 跨 Agent（阿轩/明德/Jeason）
```

---
维护者: 若兰 🌸 | 2026-08-22

---

## 实战避坑清单（2026-08-25 若兰 × 阿轩 首次真实闭环后补充）

> 以下坑全部来自 2026-08-25 若兰 ↔ 阿轩 首次真实握手的实战排障，**每个 Agent 升级时建议逐一对照**。

### 坑 1：私钥必须是 PEM，不是 JWK ⛔

**现象**：握手端点启用，但启动日志有 `[HANDSHAKE] ⚠️ 私钥解析失败: error:1E08010C:DECODER routines::unsupported`。对方 init 时返回 `handshake_error: privateKey is required`。

**原因**：Node.js `crypto.createPrivateKey()` 不支持直接解析 JWK JSON；`A2A_SECURITY_HANDSHAKE_KEY` 必须是 PEM 格式。

**修法**（JWK → PEM 一次转换）：
```bash
# 方法一：Node 导出
node -e "const {generateKeyPairSync}=require('crypto'); const {publicKey,privateKey}=generateKeyPairSync('ed25519'); console.log(privateKey.export({type:'pkcs8',format:'pem'}))"
# 方法二：若已有 JWK，用 csb-security 的 aid.js 重新导出
```

**验证**：启动日志无 `私钥解析失败` 警告 = 通过。

### 坑 2：双向验证需要对方的 AID 公钥 ⛔

**现象**：caller 收到 challenge 后，验证时报 `callee AAT invalid: bad_public_key`。

**原因**：协议要求 caller 持有 callee 的 AID 文档（含公钥）才能验证其 AAT 签名——challenge 的 JWT 不内嵌公钥。

**修法**：**每个 Agent 必须暴露 `GET /a2a/aid` 端点**（返回完整 AID JSON，含 public_key）：
```bash
curl http://对方IP:端口/a2a/aid   # 返回 { agent_id, public_key, signature, ... }
```
（server_v5 已内置该端点，从 `A2A_SECURITY_HANDSHAKE_AID` 读取；未配置时返回最小 AID 视图。）

**验证**：`curl http://localhost:3100/a2a/aid` 能返回含 `public_key` 和 `signature` 的 JSON。

### 坑 3：UAC 验证需要用户公钥 ⛔

**现象**：proof 发出后，callee 返回 `uac_invalid: bad_public_key`。

**原因**：UAC（用户授权凭证）由用户私钥签发，callee 需要**用户公钥**验证。`A2A_SECURITY_HANDSHAKE_USER_PUBKEY` 未配置或配置错误。

**修法**：
1. 生成用户密钥对（一澜的授权密钥）：
```bash
node -e "const aid=require('./csb-security/lib/identity/aid'); const k=aid.generateKeyPair('user-yilan'); console.log(JSON.stringify(k.publicJwk)); console.log(k.privateKey.export({type:'pkcs8',format:'pem'}))"
```
2. 公钥 JWK 配置给所有需要验证 UAC 的 callee（**统一公钥，大家共用，勿换**）：
```bash
# 一澜的 Ed25519 用户公钥（kid: user-yilan；权威源：csb-security/keys/user-yilan.pubkey.json，已入仓库可独立核对）
export A2A_SECURITY_HANDSHAKE_USER_PUBKEY='{"crv":"Ed25519","x":"rpNYnf224QbmIuK1Ivrj7u7BMa5KnUFFCAe54Tm-_4U","kty":"OKP","kid":"user-yilan"}'
# 或存成文件：export A2A_SECURITY_HANDSHAKE_USER_PUBKEY=/path/to/user-pub.jwk
```

**注意**：**所有 Agent 必须用同一把用户公钥**（一澜的），否则 UAC 交叉验证失败。

### 坑 4：环境变量在 gateway 重启后丢失 ⛔

**现象**：服务某天突然不能握手/发言失败，排查发现环境变量全空。

**原因**：容器内环境变量是启动时注入的；gateway 重启后，**脚本内直接读 `process.env.XXX` 且无 fallback** 的代码会拿到空值。

**修法**：
1. 安全要求：key 一律走环境变量，**不明文**。
2. 代码必须有多级 fallback（参考 roundtable-v4.js 的 `resolveApiKey`）：
   - `apiKey` 直配 → `apiKeyEnv` 环境变量 → `openclaw.json` providers → `.env` 文件
3. `.env` 写到 gateway 会加载的位置（`process.cwd()/.env` 和 configDir `.env`），重启后生效。
4. 关键环境变量（`A2A_LLM_API_KEY` / `A2A_SECURITY_HANDSHAKE_*`）建议**写入 watchdog 启动脚本**，随 v5 拉起自动注入。

### 坑 5：identity.json 被覆盖（最隐蔽）⛔

**现象**：A2A server 突然以别的 Agent 身份跑（端口、名字全变），"服务掉线"其实是换身份在跑。

**原因**：多个 Agent 共用同一工作区/目录时，`identity.json` 可能被其他部署覆盖。

**修法**：
1. **identity.json 加完整性监控**（SHA256 baseline，被改即告警）：
```bash
sha256sum identity.json > identity-baseline.sha256
# cron 每 6 小时对比，变化即告警（参考 scripts/monitor-identity.sh）
```
2. 部署时确认 `A2A_IDENTITY_PATH` 指向自己的身份文件，避免误用共享目录。
3. 重要身份文件建议 git 跟踪 + 备份。

### 快速自检清单（升级后逐项过）

```bash
# 1. 私钥格式
grep -c "BEGIN PRIVATE KEY" $A2A_SECURITY_HANDSHAKE_KEY   # 应 ≥1
# 2. AID 端点
curl -s localhost:3100/a2a/aid | python3 -c "import json,sys;d=json.load(sys.stdin);print('AID OK:',d['agent_id'])"
# 3. 握手端点
curl -s localhost:3100/a2a/handshake/status | python3 -c "import json,sys;d=json.load(sys.stdin);print('handshake:',d['enabled'])"
# 4. 启动日志无警告
grep -iE "私钥解析失败|JWK|unsupported" logs/a2a-server.log   # 应无输出
# 5. 用户公钥已配置
echo ${A2A_SECURITY_HANDSHAKE_USER_PUBKEY:0:20}   # 应有内容
```

---
维护者: 若兰 🌸 | 2026-08-22（实战补充 2026-08-25）
