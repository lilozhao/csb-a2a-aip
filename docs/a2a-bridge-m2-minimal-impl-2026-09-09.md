# M2 最小实现草案：Session Injector + Task 回传（试点最小闭环）

> **状态**：DRAFT v0.1（实现草案，待一澜确认后编码）
> **日期**：2026-09-09
> **作者**：若兰 · 试点对：言蹊 🌿 / 星尘 ⭐ / 阿轩 🔧（一澜 14:47 拍板）
> **关联**：docs/a2a-bridge-rfc-draft-2026-09-09.md（RFC v0.2）
> **一句话**：以最小代码量打通「A2A 入站委托 → 主会话执行 → 结构化回传」闭环，范围含写操作（L3 确认），三个试点对互发验证。

---

## 一、目标与范围

### 1.1 最小闭环定义
```
发起方 A2A ──SendMessage + delegation 信封──▶ 接收方 A2A server
     │                                            │ ① 鉴权（L0-L3 + 签名）
     │                                            │ ② delegation 标志直判
     │                                            │ ③ Session Injector：隔离任务帧注入主会话
     │                                            │    ├ 读/通知 → L2 执行
     │                                            │    └ 写/跨宿主 → L3 用户确认（复核通道）
     │◀────────── Task completed + Artifact ───────┘ ④ 结构化回执
```

### 1.2 本草案范围（M2 最小）
- [x] delegation 信封校验（含混即拒）
- [x] Session Injector（OpenClaw gateway 适配器 + 可插拔接口）
- [x] Task Correlator（tasks/send 生命周期回传）
- [x] L3 用户确认流（写操作）+ 超时降级（阿昭）
- [x] 降级事件留痕（星尘：fallback → 主会话「降级事件」）
- [ ] M1 意图分类正式化（M2 语料回溯标注——后置）
- [ ] M3 安全加固全量（进程事件审计等——后置，C0/M2 同批基础项除外）

### 1.3 非目标（本草案不做）
- 不新造 Task 格式（复用 tasks/send/get/cancel）
- 不做通用 MCP host
- 不替代 remote-command 白名单（C0 仅对齐语义层）

## 二、试点对矩阵

| 试点 | 宿主 | 主会话通道 | 试点场景（写操作） | 成员条件 |
|---|---|---|---|---|
| 言蹊 🌿 | 阿里云 | OpenClaw gateway（降级路径现存形态） | 委托对方「把某段文本写入其 memory 当日文件」（L3 确认） | RFC 承认降级模式合法性；每日 cron 为验证样本 |
| 星尘 ⭐ | 华为云 | OpenClaw gateway（llm-router fallback 链路） | 委托对方「触发一次 fallback 模拟并验证留痕」（L3） | fallback 日志分母 bug 先修；主会话留痕验证 |
| 阿轩 🔧 | 本地 | OpenClaw gateway（飞书通道先例） | 委托对方「生成一份状态报告写入其日志目录」（L3） | L3 确认流完整走查 |

**互发方向**：任意试点对间双向可发（言蹊↔星尘 跨公网 · 阿轩↔言蹊/星尘 内网→公网），覆盖 内网↔公网 与 公网↔公网 两种拓扑。

## 三、模块设计（落 csb-a2a-aip 根目录，跟随仓库平铺风格）

### 3.1 文件规划
```
csb-a2a-aip/
├── a2a-bridge-core.js          # 桥接编排入口：delegation 信封校验 → 等级判定 → 分发
├── a2a-bridge-injector.js      # Session Injector：主会话注入（适配器模式）
├── a2a-bridge-correlator.js    # Task Correlator：Task ID ↔ 主会话结果 ↔ 回传
├── a2a-bridge-confirm.js       # L3 用户确认流（含超时降级）
├── adapters/                   # 各试点宿主注入适配器
│   ├── openclaw-gateway.js     # OpenClaw gateway 会话注入 adapter（主）
│   └── feishu-channel.js       # 飞书通道 adapter（参考先例）
└── test/
    └── bridge-m2.test.js       # M2 验收测试（信封校验/等级判定/拒绝路径/超时）
```

### 3.2 核心接口

**a2a-bridge-core.js**
```js
// 入站钩子：server_v5.js SendMessage handler 中调用
async function bridgeHandleInbound(msg, context) {
  // 1. 无 delegation 信封 → 原逻辑（通知/闲聊）
  // 2. 有信封 → 校验（含混即拒，refusable 恒 true）
  //    envelope 合法 → 判定等级：read/notify=L2 门槛, write/shell=L3 门槛
  // 3. 信任等级不足 → 拒绝回传（含原因）
  // 4. 等级达标 → injectToMainSession(envelope, taskId)
  //    写类：先走 L3 确认（confirmL3），确认通过才注入
  // 5. 回传：Task completed + Artifact（结构化回执四要素）
}
```

**a2a-bridge-injector.js**
```js
// 适配器模式：主会话通道可插拔
const adapters = { 'openclaw-gateway': require('./adapters/openclaw-gateway') };

async function injectToMainSession(envelope, taskId) {
  const adapter = pickAdapter(envelope.targetAgent);   // 按目标 agent 选
  const frame = {
    taskId,                          // 隔离任务帧标识
    envelope,                        // 委托原样（含来源、范围、时限）
    channel: 'a2a-bridge',           // 主会话可见通道标记
    requestId: crypto.randomUUID()
  };
  return adapter.inject(frame);      // 返回主会话处理结果（Promise）
}
```

**adapters/openclaw-gateway.js**（通道细节待网关 API 确认，候选三）
```js
// 候选 A：systemEvent/wake 注入（cron 同款机制，主会话 heartbeat 处理）
// 候选 B：gateway REST 会话消息 API（19089，OPENCLAW_GATEWAY_TOKEN）
// 候选 C：本地飞书通道注入（先例：澈/鲸歌/思源——消息入飞书群→主会话读群执行）
// 实现时以试点宿主实际可用通道为准，接口统一为 inject(frame) → result
```

**a2a-bridge-confirm.js**（L3 确认 + 超时降级，阿昭）
```js
async function confirmL3(envelope) {
  // 1. 向宿主用户发出确认请求（复核通道：主会话/飞书，含委托方/范围/时限/结果预期）
  // 2. 等待确认：超时 N 分钟（试点默认 5min，可配）→ 自动拒绝 + 回传「L3 确认超时」
  // 3. 用户拒绝 → 回传「用户拒绝」
  // 4. 用户确认 → 放行注入
  // 授权主体澄清（澈）：记录 agent 请求方 + 用户确认方 两个授权层级
}
```

**a2a-bridge-correlator.js**
```js
// 复用 tasks/send 生命周期：submitted → working → completed/failed
// 回执四要素（拾微「嘴可以松，账必须紧」）：
//   delegator / scope / duration / result
// result 内含主会话处理摘要 + artifact 引用；failed 必带原因（拒绝/超时/越权/降级）
```

### 3.3 降级事件留痕（星尘）
- bridge 任何环节走 fallback（配额/超时/解析错/桥接不可用）→ 主会话写一条「降级事件」记录（时间/环节/原因/兜底动作），不只 log 一行
- 本草案落地为 audit hook：`recordDegradeEvent({phase, reason, fallback})`

## 四、L3 确认流时序（写操作试点场景示例）

```
发起方（言蹊）                          接收方（星尘）              宿主用户（一澜/夜白）
    │ SendMessage + delegation{type:execute, scope:write} │              │
    ├───────────────────────────────────▶│ 鉴权 L3 门槛 ✓           │
    │                                    ├── confirmL3 ─────────────▶│ 确认请求（复核通道）
    │                                    │◀──────── 用户确认 ────────┤
    │                                    │ 注入主会话（隔离帧）        │
    │◀──────── Task completed + Artifact ─┤                          │
    │      （delegator/scope/duration/result）                        │
```

## 五、验收标准（M2 最小闭环）

| # | 用例 | 预期 |
|---|---|---|
| 1 | 读类委托（L2）互发 | 主会话执行 → 结构化回执，无用户打扰 |
| 2 | 写类委托（L3）互发 | 用户确认后执行 → 回执含 result；确认前不执行 |
| 3 | L3 确认超时（>5min） | 自动拒绝 + 回传「L3 确认超时」+ 降级事件留痕 |
| 4 | 用户拒绝写委托 | 回传「用户拒绝」，主会话不执行 |
| 5 | delegation 信封含混/缺 refusable | 拒绝 + 原因回传（T4：缺省 true，显式 false 无效） |
| 6 | 信任等级不足（L0/L1 发委托） | 拒绝 + 原因回传 |
| 7 | 桥接不可用（gateway 断） | P0 诚实指路 + 降级事件留痕 |
| 8 | fallback 触发（配额耗尽模拟） | 主会话「降级事件」留痕（星尘试点场景） |

## 六、实施顺序（小步可验证）

1. **Step 1**：a2a-bridge-core.js 信封校验 + 等级判定 + 拒绝路径（纯逻辑，先测）
2. **Step 2**：a2a-bridge-correlator.js Task 回传（复用 taskStore/tasks-send，mock 注入先通）
3. **Step 3**：adapters/openclaw-gateway.js 注入打通（先本地阿轩试点：真实主会话执行）
4. **Step 4**：a2a-bridge-confirm.js L3 确认流 + 超时降级（阿轩写操作闭环）
5. **Step 5**：降级事件留痕 audit hook（星尘场景）
6. **Step 6**：言蹊/星尘接入 adapter → 跨公网互发验收（测试用例 1-8）
7. **Step 7**：M2 语料收集 → M1 意图分类回溯标注（衔接）

## 七、风险与开放问题

| # | 风险/问题 | 应对 |
|---|---|---|
| 1 | OpenClaw gateway 无现成「会话注入」API | 三候选通道实测；最差走飞书通道 adapter（先例已验） |
| 2 | 跨公网互发延迟/防火墙 | 言蹊/星尘 A2A 端口已知可达（R1 全程通信成功） |
| 3 | L3 确认打扰用户频率 | 试点期限写操作；确认请求聚合（同源同批一次确认） |
| 4 | 主会话执行上下文污染 | 隔离任务帧（taskId 标记），执行结果不回写主会话记忆（除降级事件） |
| 5 | 试点对安全边界（社工） | 信封 + 签名校验复用 csb-security；试点期白名单仅三试点互发 |

---

*若兰 🌸 · 2026-09-09 · 待一澜确认后进入 Step 1 编码*
