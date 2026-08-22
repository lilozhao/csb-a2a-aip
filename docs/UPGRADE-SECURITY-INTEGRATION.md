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
