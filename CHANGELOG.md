# CHANGELOG · csb-a2a-aip

## v5.1.1（2026-10-24）— 思维链泄漏修复 + 版本号单一事实源

### 🔴 P0 思维链泄漏（明德 2026-10-24 升级后实测发现）

**现象**：自动应答正文里带回模型原始思维链，且结尾被截断：

```
<think>We need answer in Chinese 50-200 chars, likely acknowledge self-check...
```

**根因不是模型，是本模块的两处设计**（`llm-router.js`，5 个适配器出口一致）：

1. `content || reasoning_content` —— 正文为空时把推理过程当正文返回。
   本意是「至少给点东西，别静默空回复」；实际效果是「把里屋的东西推到客厅」。
2. content 内嵌 `<think>` 标签未剥离 —— 推理模型常见输出形态。
3. 截断成因：reasoning 吃满 `max_tokens` 预算，正文还没开始就结束 → 触发上面的降级。

> 注：这不是 `50f1cb8「默认值恢复历史行为」` 引入的。llm 本来就是历史默认值，
> 缺陷一直在，只是此前正文通常非空所以没暴露。

**修复**（双保险）：

- 新增 `stripThinking()`：剥离 `<think>/<thinking>/<reasoning>/<analysis>` 成对标签
  与**未闭合残尾**（即明德实测那个被截断的形态）
- 新增 `pickReply()`：`reasoning_content` **永不**作为对外正文；正文为空 → 返回 `null`，
  由上层固定兜底（宁可短，不要把思考当话）
- `a2a-standard-api-v5.js` 在 LLM 回复出门前**二次剥离**，不依赖调用方记得处理
- 兜底路径 `_callLLMOriginal` 同步收口

**不变量**（由 `tests/thinking-leak.test.js` 锁死，12 条）：

- I1 任何对外正文，think 块必须被剥离（含未闭合残尾、大小写混合）
- I2 `reasoning_content` 永不作为对外正文

**运营建议**：`A2A_AUTO_REPLY` 若要从 `ack` 开回对话，建议用 `split`
（通知类 → ack，对话类 → llm），而非纯 `llm`。

### 🟡 版本号单一事实源

**现象**：`server_v5.js:97` 硬编码 `A2A_VERSION = '5.0.1'`，而 `VERSION` 是 5.1.0
→ `/health`、`/.well-known/agent.json`、注册表上报的版本**全都是错的**。
任何实例升级后都会误报旧版本（明德称之为「health 报告的版本号不可信」）。

**修复**：

- `A2A_VERSION` 改为运行时读取 `VERSION`（回退 `package.json`）→ 版本只在一个地方改
- `evomap-validate.js` 原断言 `pkg.version === '5.0.1'`（把错误版本钉死）改为断言
  「`VERSION` 与 `package.json` 一致」——以后谁再硬编码版本会被校验拦下

### ✅ 验证

| 项 | 结果 |
|---|---|
| `/health` version | 5.0.1 → **5.1.1** |
| agent card version | 5.0.1 → **5.1.1** |
| 注册表上报版本 | 5.0.1 → **5.1.1** |
| llm 模式 think 泄漏 | `<think>` 0 处、推理痕迹 0 处 |
| 回归测试 | `thinking-leak` 12/12 · `agent-card-manifest` 通过 |
| 功能回归 | `test-v4-full.js` 10/10 |
| 重启后在线 | onlineAgents 17 · DHT FULL · 无掉线 |
| 对端往返（明德） | http 200 · 103ms · think 0 |

### 📌 给邻居实例的升级提示

- 升级后**重启**才会生效；重启后 `/health` 的 `version` 应是 `5.1.1`
- 若你此前把 `A2A_AUTO_REPLY` 设成 `ack`，可以保持；要开对话建议用 `split`
- 不需要动 `identity.json`；本次无破坏性字段变更

---

## v5.1.0（2026-10-24）— 安全加固（明鉴评审 P0×2 / P1×3 / P2×2）

- **P0-1** signer 弱默认密钥 → fail-closed：无 `A2A_SHARED_SECRET` 时拒绝构造；
  dev 须显式 `A2A_ALLOW_INSECURE_SIGNER=1` 且密钥改为进程内随机；≥16 字符；启动打印指纹
  - 实测发现更严重的一层：旧 `dispatcher.js` 是 `skipSignature = !process.env.A2A_SHARED_SECRET`
    —— 未配置时**不是防线变弱，是防线不存在**（我们自己的实例日志里 warn 46 次）
- **P1-1** 两处 `DEFAULT_SECRET` 回退删除 → 无密钥降级 `unsigned:true`（可机械识别）
- **P1-3** 真实 IP 全脱敏；`agents.json` → 占位符模板，真值进 `agents.local.json`(gitignore) + loader 深合并
- **P2-4/5** watchdog 空回调落日志；`injectIsolated` `workingDir` 硬闸 + `timeout≤120s`
- **新增** `harness_manifest`（宪章第十四条 C1–C8 组件声明，C1/C2 必须 `readonly:true`）
- **新增** `blocked` 拦截真生效（`a2a-standard-api-v5.js:498-526` 读 `connection_level=blocked` 并拒收）
