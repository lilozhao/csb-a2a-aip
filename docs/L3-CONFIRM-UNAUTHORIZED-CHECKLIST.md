# L3 确认通道 `Unauthorized` 排查 Checklist

> **适用**：桥接委托（`scope=write|shell`）被秒拒，`detail: L3 确认请求发送失败: Unauthorized`
> **维护**：若兰 🌸 | 2026-09-14 | 缘起：P3 长窗口 L3 终验连续被 11ms 弹回
> **性质**：**只查不改** —— 凭证只有**宿主 L3 侧**能改；被委托方（agent）无权操作

---

## ⚠️ 先读：下表配置**按被委托方实际情况填**

本文给的是**口径与查法**，不是可直接复制的值。每个实例的
`A2A_GATEWAY_URL` / `GATEWAY_TOKEN` / `MAIN_TO` / `CHANNEL` **各不相同**，
必须按**你这一台**的实际配置来填、来核。别把别处的值搬过来（09-11 的「以别人身份握手」就是这么来的）。

---

## 现象

`scope=shell` 委托 → **十几毫秒就被 REJECTED**
```
detail: L3 确认请求发送失败: Unauthorized
```
典型特征：**不是** `window_expired`（没进等待窗口），**不是**业务拒绝 —— 是**确认请求根本没发出去**。

---

## 注入链路（代码事实 · `adapters/openclaw-gateway.js`）

| 环节 | 变量（按实例填） | 默认 |
|---|---|---|
| 目标地址 | `A2A_GATEWAY_URL` | `http://localhost:19089` |
| 凭据 | `OPENCLAW_GATEWAY_TOKEN` 或 `A2A_GATEWAY_TOKEN` | 无（**必填**） |
| 调用 | `POST /v1/chat/completions` · 头 `Authorization: Bearer <token>` · `model=openclaw` | — |
| 主会话目标 | `A2A_BRIDGE_MAIN_TO`（或 `identity.json` 的 `bridge.mainTo`） | 无 |
| 通道 | `A2A_BRIDGE_CHANNEL`（或 `identity.json` 的 `bridge.channel`） | `feishu` |

⇒ **`Unauthorized` = gateway 拒了这个 token（HTTP 401）**，不是逻辑问题。

---

## 按可能性排序，查这 4 项

### 1) token 陈旧 / 过期（最可能 — gateway 重启可能轮换）

```bash
# 只看有无与长度，别打印明文
printenv OPENCLAW_GATEWAY_TOKEN | wc -c
printenv A2A_GATEWAY_TOKEN | wc -c
# 看它到底写在哪个文件（按本实例实际情况）
grep -rn "GATEWAY_TOKEN" .env .env.a2a a2a-v5.env 2>/dev/null
```
修：把**当前有效 token** 写进本实例的单一真相源文件（如 `a2a-v5.env`），再重启 v5。

### 2) 地址是否指向「自己的」gateway

```bash
printenv A2A_GATEWAY_URL          # 按本实例实际填
TOK=$(printenv OPENCLAW_GATEWAY_TOKEN || printenv A2A_GATEWAY_TOKEN)
curl -s -o /dev/null -w '%{http_code}\n' -m 10 -H "Authorization: Bearer $TOK" \
  "${A2A_GATEWAY_URL:-http://localhost:19089}/v1/models"
```
- `200` = 通 · `401` = token 错 · `000` = 地址不通
- ⚠️ **容器内 gateway 常常不在 `localhost:19089`**（实测某实例直打 localhost 得 `000`）。
  若你拿到的是 `401` 而不是 `000`，说明**打到了某个 gateway、但 token 不被认** ——
  除了 token 旧，还要怀疑**打到了「不是自己的」gateway**。

### 3) MAIN_TO / CHANNEL（确认投递 + 回执读取用）

```bash
grep -n '"mainTo"\|"channel"' identity.json
printenv A2A_BRIDGE_MAIN_TO; printenv A2A_BRIDGE_CHANNEL
```
- `mainTo` 必须是**本实例宿主用户的有效 open_id（`ou_…`）或群（`oc_…`）**；`channel` 按实例（如 `feishu`）
- ⚠️ **09-11 先例**：`MAIN_TO` 指向错目标 → 确认请求走错通道 → 被当指令执行 → **绕过 L3**。这项错＝安全缺口，不只是"发不出去"。

### 4) 进程环境是否真带上（升级/重启最容易丢）

```bash
pid=$(pgrep -f server_v5.js); tr '\0' '\n' < /proc/$pid/environ \
  | grep -E 'GATEWAY_TOKEN|A2A_BRIDGE_|A2A_GATEWAY_URL'
```
- 空 = 进程环境没带（start 脚本没 `export` / 没 `source`）→ 补单一真相源文件并 `source`

---

## 最快自证（**每改一条跑一次**）

```bash
TOK=$(printenv OPENCLAW_GATEWAY_TOKEN || printenv A2A_GATEWAY_TOKEN)
curl -s -o /dev/null -w 'chat/completions => %{http_code}\n' -m 15 \
  -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' \
  -d '{"model":"openclaw","messages":[{"role":"user","content":"ping"}],"max_tokens":5}' \
  "${A2A_GATEWAY_URL:-http://localhost:19089}/v1/chat/completions"
```
- `200` → 通道通了，可重跑委托
- `401` → token 问题（回第 1 项）

---

## 验收标准（委托方怎么判「修好了」）

重发一条 `scope=shell` 探针：

| 状态 | 判据 |
|---|---|
| ❌ 未修 | **十几毫秒就 REJECTED**（`Unauthorized`，没进等待窗口） |
| ✅ 已修 | **进入确认窗口**（不再秒弹）→ 宿主确认 → 执行 + 回执 |

---

## 相关

- 交接班：`docs/HANDSHAKE-ENABLE-CHECKLIST.md`（握手端点启用）
- 历史：桥接故障 #20260912-1（`A2A_BRIDGE_CHANNEL` 凭证失效）
- 纪律：**fail-closed 正确** —— 确认通道断时必须拒绝 + 零执行，不得越权

---

_2026-09-14 若兰 🌸 · 值按被委托方实例填，勿跨实例搬运_
