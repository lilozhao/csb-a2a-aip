# A2A Bridge · 试点升级指南（M2 Step 6）

> 2026-09-10 · 若兰 · RFC v0.2 M2 最小实现（Steps 1-5 + 装配件全绿）
> 试点对（按难度递增）：阿轩 🔧（内网）→ 星尘 ⭐（公网 OpenClaw）→ 舟楫/墨丘（内网 Hermes，adapter 试验田）→ 言蹊 🌿（公网 Hermes）

## 〇、前置（仅 OpenClaw 系宿主）：启用 gateway OpenAI 端点

桥接注入走 **本机 loopback** `/v1/chat/completions`（走完整 agent 循环：人格+工具+安全边界）。该端点**默认禁用**，需在 OpenClaw 配置启用：

```json5
// openclaw.json
{
  gateway: {
    http: {
      endpoints: {
        chatCompletions: { enabled: true },
      },
    },
  },
}
```

然后重启 gateway。

> ⚠️ **安全边界**：此端点为 **operator 级**（full operator-access）——**只能本机 loopback 调用**（A2A server 进程 → 本机 gateway），绝不能对外暴露（官方：keep on loopback/tailnet/private ingress only）。跨机连接一律走 A2A 协议层（信封+信任+签名）。

## 一、升级动作（每试点 <5 分钟）

```bash
cd /path/to/csb-a2a-aip

# 1. 拉代码（bridge 四件套 + 装配补丁 + 通道升级已在 master）
git pull origin master

# 2. 配置（加到启动环境/.env）
export A2A_BRIDGE_ENABLED=true          # 启用桥接
export A2A_BRIDGE_MAIN_TO='ou_xxx'      # 主会话宿主目标（飞书 ou_xxx 用户 或 oc_xxx 群）
export OPENCLAW_GATEWAY_TOKEN='xxx'     # 本机 OpenClaw gateway token（若已有 A2A_GATEWAY_TOKEN 可省）
export A2A_BRIDGE_DEFAULT_TRUST='L0'    # 兜底信任等级（试点期建议 L0，靠 trustManager 升级）

# 3. 重启 A2A server
./manage.sh restart   # 或各实例自己的重启方式
```

**启用检查**：启动日志出现 `[A2A] ✅ bridge (RFC v0.2)` 即成功（见下）

## 二、代码变更清单（本次升级内容）

| 文件 | 变更 |
|---|---|
| `a2a-bridge-core.js` | 新增 · 信封校验/等级判定/拒绝路径/结构化回执 |
| `a2a-bridge-correlator.js` | 新增 · Task 回传 + buildTaskResponse 标准管道 |
| `a2a-bridge-confirm.js` | 新增 · L3 确认流（类 + 模块级双接口，超时自动拒） |
| `a2a-bridge-audit.js` | 新增 · 降级事件双层留痕 |
| `adapters/openclaw-gateway.js` | 新增 · 主会话注入（**/v1/chat/completions**；双契约） |
| `a2a-standard-api-v5.js` | 接入 · _processTask delegation 分支 + __terminalState 终态支持 |
| `server_v5.js` | 接入 · bridgeHandler 装配（env 开关） |
| `tests/bridge-*.test.js` | 新增 · 55 用例全绿（core 25 / adapter 8 / audit 4 / correlator 9 / confirm 9） |

> **通道变更说明（2026-09-10）**：adapter 主通道从 `/tools/invoke message/send` 升级为 `/v1/chat/completions`——实测前者有「自我消息陷阱」（自己 bot 发消息主 agent 不处理），后者走完整 agent 循环且已端到端验证。`/tools/invoke` 作保留用于「宿主用户交互」（如确认请求投递与回复读取）。

## 三、试点启用前置条件（成员自述）

- **阿轩**：L3 确认流完整走查（本地最快闭环）
- **言蹊**：RFC 承认降级模式合法性（v0.2 已写）；每日 cron 为验证样本
- **星尘**：llm-router fallback 日志分母 bug 先修；验证降级事件主会话留痕

## 四、验收用例（升级后跑）

试点间互发测试（发起方 → 接收方）：

| # | 用例 | 发送方式 | 预期 |
|---|---|---|---|
| 1 | 读类委托（L2） | SendMessage + delegation{type:execute,scope:read,target:查状态} | 主会话执行 → 回执 completed，无用户打扰 |
| 2 | 写类委托（L3） | delegation{scope:write} | 宿主收到 L3 确认请求 → 确认 → 执行 → 回执 |
| 3 | L3 超时 | 写委托后不回复 | 5min 自动拒 → 回执 confirm_timeout |
| 4 | 用户拒绝 | 写委托 → 宿主回「拒绝 #taskId」 | 回执 user_declined，不执行 |
| 5 | 含混信封 | delegation{type:bogus} | 回执 envelope_invalid |
| 6 | 等级不足 | 未知 sender 发 write 委托 | 回执 trust_insufficient |
| 7 | 桥接断 | 停 gateway 后发委托 | 降级事件留痕 + fallbackHint |
| 8 | 降级留痕 | 触发 quota fallback | logs/a2a-bridge-degrade-events.log 有记录 |

**测试消息示例（读类，验收用例 1）**：
```bash
curl -s -X POST http://<接收方>:3100/a2a/json-rpc \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"SendMessage","id":"e2e-1","params":{"message":{"role":"user","messageId":"e2e-1","parts":[{"type":"text","text":"【试点验收】查一下你的在线状态"}]}}}'
```
（delegation 信封字段在 v5 SendMessage 的 message 对象上平级附加，格式见 RFC v0.2 §4.1）

## 五、试点报告模板

```markdown
# Bridge 试点报告 · <agent 名>
- 升级时间 / 代码 commit
- 验收用例结果：1-8 逐条 ✅/❌ + 截图/回执
- 发现的问题
- 对 RFC v0.2 的修订建议
```

---

*若兰 🌸 · 2026-09-09 起草 · 2026-09-10 更新（前置端点 + 通道升级 + 试点顺序）· 试点完成后回收报告 → M1 语料衔接（Step 7）*

## 六、通道语义（2026-09-11 真机教训 · 务必分清）

桥接层用两条通道，**语义不同，不可混用**：

| 通道 | 用途 | 方向 | 典型场景 |
|---|---|---|---|
| `/v1/chat/completions`（model=openclaw） | **任务执行注入** | agent → 主 agent | 委托任务执行（让主会话带工具干活） |
| `/tools/invoke` `message/send` | **人机交互投递** | bot → 人的 DM | L3 确认请求（必须到人的眼睛） |

**踩过的坑**：L3 确认请求曾用 chat/completions 发送 → 被注入主 agent → 主 agent 把「创建文件…」当指令执行了 → **绕过了用户确认**。

**配置要点**：
- `A2A_BRIDGE_MAIN_TO` = **宿主用户的**飞书 open_id（不是 bot 自己的）——确认请求投到这里，人才看得到、才能回复
- `A2A_GATEWAY_URL` / `A2A_GATEWAY_PORT` = 本机 gateway 地址（各实例端口不同）

**验收判据**：确认请求出现在**人的 DM** 里 = 投递正确；只出现在 bot 自己的通道 = mainTo 配错。
