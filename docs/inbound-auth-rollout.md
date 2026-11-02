# 入站鉴权灰度 · 执行手册（P0-5）

_2026-11-02 建立 · 一澜拍板观察期 **2 周**（2026-11-02 → 2026-11-16）_

## 为什么

`/a2a/json-rpc`、`/message:send`、`/message:stream` 目前不校验调用者是谁。
谁都能往里塞消息，审计里 `caller_id` 常年 `unknown`（历史 255 条里 253 条无名）。
P0-5 要的是：**看得见谁来了，然后才谈拦不拦**。

## 三段灰度（不可跳段）

| 段 | 模式 | 行为 | 时间 |
|---|---|---|---|
| 1 | `shadow` | **只记不打回**，`wouldBlock` 标在日志里，请求一律放行 | 11-02 → 11-16（2 周）|
| 2 | `enforce` + A 类 | 拦 A（完全无身份）；B 类走人工通道 | 11-16 后，由数据决定 |
| 3 | `enforce` 全量 | 有凭据才放行 | 观察期结束后再定 |

**为什么先 shadow**：分类口径还没被真实流量检验过。直接 enforce 会把「我们名单不全」
变成「把邻居关在门外」——而且这种错不会报错，只会安静地少掉一批消息。

## 分类口径（唯一实现：`a2a-inbound-auth.js`）

| 类 | 判据 | 处置 |
|---|---|---|
| **A** 无身份 | `name` 缺失 / `unknown` / `?` | 应 100% 拦 |
| **B** 冒名嫌疑 | 名字命中已知 agent，但**没有 url 可核** | 人工通道（不是放行）|
| **C** 名称+出处自洽 | `name` + `url`，注册表命中 | 放行 —— **但这是「自洽」不是「验签通过」** |
| **D** 未注册 | `name` + `url` 都有，注册表查不到 | 灰度只记；分档阶段单独定 |

⚠️ **C 类不等于身份可信**。现在只校验「名字和出处对得上注册表」，AAT 真验签是第二阶段的事。
对外表述不许写成「已验证身份」。

## 基线数据（2026-11-02 · 214 条历史入站）

```
A 无身份      61  28.5%
B 冒名嫌疑    12   5.6%
C 自洽(未验签) 86  40.2%
D 未注册      55  25.7%
一刀切应拦   73  34.1%
```
Top：`unknown` 61 条 · 若辰 7 条（全程无 url）· 若兰-probe 2 条。
明细：`node scripts/inbound-auth-topn.js`

## 操作

```bash
# 状态（只看，不改）
curl -s 127.0.0.1:3100/health | jq '.inboundAuth'

# 观察期日报
node scripts/inbound-auth-shadow-report.js

# 复盘全量历史（不改生产）
node scripts/inbound-auth-topn.js
```

开关在 `csb-a2a-aip/.env` 的 `A2A_INBOUND_AUTH_MODE`（`off|shadow|enforce`，**默认 off**）。

⚠️ **改 .env 不会自动生效**：`restart-a2a.js` 继承的是**当前进程**的 env，不读 `.env`。
必须 `--set` 或 `./start-v5.sh` 冷启：

```bash
node scripts/restart-a2a.js --dry-run --set A2A_INBOUND_AUTH_MODE=shadow   # 先看 PLAN_ID
node scripts/restart-a2a.js --set A2A_INBOUND_AUTH_MODE=shadow             # 真做（PLAN_ID 必须相同）
```

## 安全阀（已写进单测）

1. **名单读不到 → enforce 自动降为 shadow**：宁可少拦，不可把「我们看不见名单」变成「关门」。
2. **中间件自身异常 → 放行**（fail-open + 留痕），鉴权不许导致业务雪崩。
3. **记录失败不阻断**：日志写不进去只 warn，请求照走。
4. **默认 off**：不设变量 = 行为与改造前完全一致。

## 验收

- `node tests/inbound-auth.test.js`（26 条：口径 / 决策 / 取 sender / 接线 / 安全阀）
- `node tests/inbound-auth-topn.test.js`（11 条：统计口径自洽）
- `/health.inboundAuth.mode` 能读出当前档位 —— 外部可核，不靠自述
