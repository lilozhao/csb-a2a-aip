# 握手端点启用 Checklist（接收方一键版）

> **目标**：让 `/a2a/handshake` 端点起来（`{"enabled":true,"callee":"<你的slug>"}`）
> **维护**：若兰 🌸 | 2026-09-14 | 缘起：09-14 阿轩启动失败排查（`keys/axuan.aid.json` 不存在）
> **适用**：任何实例（把下面 `axuan` / `172.28.0.5` 换成自己的 slug / 地址即可）

---

## 0. 先分清两件事（别混）

| 概念 | 需要什么 | 现状 |
|---|---|---|
| **对等握手端点**（本文） | **AID 文档 + Ed25519 私钥** | 起不来通常是缺这两个 |
| **E2E 消息加密**（`/health` 里的 `e2e.enabled`） | 另一套密钥 | 两边目前都是 `false`，**一致**，不影响启动 |

> ⚠️ AID 是**自签**的（本机 `generateKeyPairSync` 生成），**不是谁颁发的**。
> **私钥只能本机生成**——任何情况都不要向别人索取私钥，也不要交出私钥。

---

## 1. 生成 AID + 私钥（自签 · 本机执行）

在仓库根目录（`csb-a2a-aip/`）执行：

```bash
mkdir -p ./csb-security/data
node - <<'EOF'
const crypto = require('crypto'), fs = require('fs');
const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
const pub = publicKey.export({ format: 'jwk' });
fs.writeFileSync('./csb-security/data/SLUG-private-key.pem',
  privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
const aid = {
  csb_version: '1.0',
  agent_id: 'SLUG@HOST:PORT',
  name: 'NAME',
  emoji: '🔧',
  public_key: { crv: 'Ed25519', x: pub.x, kty: 'OKP', kid: 'SLUG-' + Date.now() },
  endpoint: 'http://HOST:PORT/a2a/json-rpc',
  created_at: new Date().toISOString(),
  expires_at: new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString(),
  capabilities: ['a2a.send', 'a2a.delegate', 'a2a.status', 'system.status', 'agent.health'],
};
fs.writeFileSync('./csb-security/data/SLUG-aid.json', JSON.stringify(aid, null, 2));
console.log('✅', aid.agent_id, 'kid=', aid.public_key.kid);
EOF
chmod 600 ./csb-security/data/SLUG-private-key.pem
```

把 `SLUG` / `HOST` / `PORT` / `NAME` 换成自己的（例：`axuan` / `172.28.0.5` / `3100` / `阿轩`）。

> 📌 **路径与命名**（最容易错）：
> - 目录是 **`csb-security/data/`**，**不是 `keys/`**
> - 文件名是 **`<slug>-aid.json`**（连字符），**不是 `<slug>.aid.json`**（点）
> - 私钥同目录：**`<slug>-private-key.pem`**

---

## 2. 指向环境变量（二选一）

**A. 显式 env**（写进 `.env` 或启动脚本）

```bash
export A2A_SECURITY_HANDSHAKE_AID="$(pwd)/csb-security/data/SLUG-aid.json"
export A2A_SECURITY_HANDSHAKE_KEY="$(pwd)/csb-security/data/SLUG-private-key.pem"
```

**B. 声明式**（推荐，不用手写路径）—— 在 `identity.json` 里加：

```json
{ "security": { "handshake": { "slug": "SLUG" } } }
```

`start-v5.sh` 会自动推导为 `../csb-security/data/<slug>-aid.json` + `<slug>-private-key.pem`。

> `start-v5.sh` 解析优先级：**显式 env > identity.json 的 `security.handshake` > slug 约定**

---

## 3. 前台启动，看真实输出（⭐ 别用 `nohup &`）

```bash
set -a && . ./.env && set +a
node server_v5.js 2>&1 | tee ./logs/a2a-v5-boot.log
```

期望看到：

```
[A2A] ✅ 对等握手端点已启用: /a2a/handshake (SLUG@HOST:PORT)
```

---

## 4. 验收

```bash
curl -s 127.0.0.1:PORT/a2a/handshake/status
# 期望: {"enabled":true,"callee":"SLUG",...}
```

---

## 5. 启动失败 · 分诊表

| 现象 | 判据 | 处理 |
|---|---|---|
| `EADDRINUSE`（端口被占） | `ss -ltnp \| grep PORT` 看到占用 | 先停旧进程再起：`kill <pid>`；确认启动脚本设了 `SO_REUSEADDR` |
| 日志**没有** ✅ 行，出现「需 `A2A_SECURITY_HANDSHAKE_AID` + `..._KEY`」 | env 没进进程 | 回第 2 步：核对**文件名/目录**（最常见就是 `.aid.json` vs `-aid.json`、`keys/` vs `csb-security/data/`） |
| `握手端点启用失败（AID/密钥配置错误）: <err>` | 文件找到了但内容不对 | `-aid.json` 非法 JSON / 缺 `public_key.x` / 私钥与公钥**不配对**（重新生成一对） |
| 其他崩溃 | 前台日志原文 | **贴原文**（日志片段/堆栈），不要结论性自述 |

---

## 6. 生成后必须做的一步（重要）

新密钥对 → **公钥变了** → 对端之前存的你的 AID 就**过期**了。

**把新的 `csb-security/data/SLUG-aid.json`（公开部分）发给对端**（例：若兰），
让对方替换其 `csb-security/data/<你>-aid.json`，否则下一步握手会验不过。

> 私钥**不发**。任何情况都不发。

---

## 附 · 口径速查

- 约定路径：`<repo>/csb-security/data/<slug>-aid.json` + `<slug>-private-key.pem`
- 解析优先级：显式 env > `identity.json` 的 `security.handshake` > slug 约定
- ⚠️ **已知坑**：旧脚本 `scripts/setup-handshake-axuan.sh` 写到 `config/security/axuan-aid.json` + `axuan-ed25519.pem`，
  与上述 slug 约定**路径/文件名都不一致** → 用它会让 `start-v5.sh` 找不到。**建议直接用本文第 1 步的自包含命令。**

---

_2026-09-14 若兰 🌸 · 任何人可复用（换掉 SLUG/HOST/PORT/NAME）_
