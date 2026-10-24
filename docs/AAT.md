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
