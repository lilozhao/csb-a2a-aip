# AAT（Agent Attestation Token）— 消息级签名

> 版本 1.0 · 2026-10-24 · 若兰
> 解决的问题：`sender.name` / `sender.url` 都是**自述字段**，谁都能填「明德」。
> 握手只能证明「某台主机此刻通过验证」，TTL 5 分钟。要逐条消息证明身份，必须签名。

---

## 一句话原理

发送方用 **AID 私钥**给消息签一个短命 token（默认 5 分钟）；接收方用**本地固定的公钥**验证。

**公钥绝不可以从发送方那里取** —— 那等于让签名者自己出题自己判卷。

---

## 快速上手（三步）

> 一家一份的完整交换流程（含自检、带外核指纹、双向验收、六种错误码排查）见 **`docs/AAT-EXCHANGE-TEMPLATE.md`**；
> 动手前先跑 `node scripts/aat-doctor.js`（八项体检，一次说清卡在哪）。

### 1. 导出自己的公钥，交给对方

```bash
node scripts/aat-keys.js export
```

输出 agent_id、公钥 JWK、指纹。**指纹要通过另一个信道核对**（当面/电话/私聊）——
如果指纹和公钥从同一条消息里一起来，等于没核对。

### 2. 固定对方的公钥

```bash
node scripts/aat-keys.js pin '<对方agent-id>' '<对方的JWK或文件>' --fingerprint <核对过的指纹>
```

- 指纹不一致 → **拒写**（防贴错/传输被改）
- 只写 `config/agents.local.json`（0600），**不碰** `agents.json`（模板文件）

### 3. 重启生效

```bash
node ../scripts/restart-a2a.js
```

---

## 验证行为

| 情况 | 结果 |
|---|---|
| 已固定公钥 + 签名有效 + 受众正确 | ✅ `L2`（`source: 'aat'`） |
| 没固定对方公钥 | ⚠️ `no_pinned_key` — **不误信，也不放行** |
| 发送方自带公钥 | 🛡️ 忽略（这是自签名陷阱） |
| 签名不匹配 / 内容被改 | ❌ `bad_signature` |
| token 过期 | ❌ `expired` |
| 同一 token 第二次 | ❌ `replay_detected` |
| token 是发给别人的 | ❌ `audience_mismatch` |
| 声称来源与签名主体不一致 | ❌ `issuer_host_mismatch` |

错误码分开报，不合并成一句「验证失败」——**今晚已经因为把配置问题误读成签名问题浪费过一轮**。

---

## 信任等级对照

| 来源 | 等级 | 含义 |
|---|---|---|
| 握手会话 | `L1`（或会话声明等级） | 双向挑战，5 分钟有效 |
| **AAT** | `L2` | 逐条消息密码学签名，5 分钟有效 |
| name+URL 匹配 | 配置里的 `trust` 值 | **不可伪造性为零**，仅作历史兼容 |

---

## 命令速查

```bash
node scripts/aat-keys.js list                 # 谁已固定、谁没有
node scripts/aat-keys.js unpin <agent-id>     # 移除固定（密钥轮换时）
node scripts/aat-keys.js verify <token> --audience <自己的agent-id>   # 手工排障
```

---

## 私钥从哪来

`a2a-aat.js` 按顺序找：

1. `A2A_SECURITY_HANDSHAKE_KEY`（服务端进程通常有）
2. `config/agents.local.json` → `aat.keyPath` / `aat.aidPath`
3. `csb-security/data/*-private-key.pem`（**只有唯一一把**时才用，多把则拒绝猜）

> 客户端脚本常常拿不到服务端 env —— 这是实测踩到的坑，所以有了第 2、3 步。

---

## 关闭

```bash
A2A_AAT_DISABLE=1    # 只关发送侧签名
```

关闭后消息照常收发，只是失去可验证性。

---

## 诚实边界（务必读完）

1. **AAT 只证明「持有该私钥」**。私钥泄露 = 身份被完全冒用，且无法从 token 本身分辨。
2. **公钥交换本身的信道决定一切**。如果把公钥和指纹一起从网上抄，整套机制退化成装饰。
3. **不提供保密性**。内容仍是明文（需要 E2E 加密，另一套机制）。
4. **时间窗口 5 分钟**。时钟漂移超过 5 分钟会验不过 —— 这是设计，不是 bug。
5. **未固定公钥时不会自动信任**。这是有意的：宁可没有信任，也不要假信任。

---

## 受众推断：查不到就拒签（2026-10-25 修订）

`audienceForUrl(url)` 以前在 config 查不到对端时，会**静默回落**成 `agent@<host>`。
这个值**永远不可能**等于对方的 `expectedAudience`（对方锚定 `<名字>@<host>`），于是：

```
签得出 → 100% audience_mismatch → 双方都零报错
```

实测代价：一台实例连发 4 条，每条都被拒，它以为已经通了。

**现在返回 `null`**，并打一行 warn 说明差什么。调用方二选一：

- `client.js` / `client-v2.js`：降级为「不带 AAT，照常发送」，并 warn 一次
- `scripts/aat-send.js`：**拒绝签发**（exit 3），提示 `--aud` 或补 config

修法二选一：

```bash
# ① 把对端写进 local 配置（推荐，长期有效）
#    config/agents.local.json → agents.<id> = { name, host, port }

# ② 显式指定受众（临时验证最快）
node scripts/aat-send.js http://<host>:<port> "..." --aud <对方agent_id>
```

> **判据**：签一个注定验不过的 token，比不签更坏 ——
> 它让双方都以为在做验证，实际在自欺。身份不许有默认值（P2）。

### aat-send 小工具

```bash
node scripts/aat-send.js <目标URL> "消息" [--aud <对方agent_id>] [--dry]
node scripts/aat-send.js --check  <目标URL>          # 只检查能否签发
node scripts/aat-send.js --dry    <目标URL> --aud …  # 只打印 token，带外核验用
node scripts/aat-send.js --verify <token> --aud <本实例agent_id>
```

绕过 `client.js` 的智能体发现（那步最长 10s），直连 `/a2a/json-rpc`。
`--verify` 只传 `name`、不传 `id`/`url` —— 传了会被当作「声称来源」与 `iss` 交叉比对，
报 `issuer_host_mismatch`（那是交叉核对通道，不是验签本身）。
