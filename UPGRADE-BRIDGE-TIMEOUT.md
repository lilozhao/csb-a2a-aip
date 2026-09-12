# UPGRADE · 桥接注入超时可配置（2026-09-12）

> 对应 commit：`f48c30c`（csb-a2a-aip）
> 影响范围：`adapters/openclaw-gateway.js`（接收方注入链路）+ 测试
> 预计耗时：3 分钟 · 风险：低（可回滚）

---

## 一、背景（为什么要升）

跨实例委托实测发现：`scope=read` 委托可在 ~26s 内完成，但 `scope=shell`（多步任务）会失败：

```
TASK_STATE_FAILED · bridge_unavailable: gateway 注入超时（90000ms）· 耗时 235s
```

根因是**接收方**适配器里写死的常量：

```js
// adapters/openclaw-gateway.js（升级前）
const DEFAULT_TIMEOUT_MS = 90 * 1000;
```

→ 多步任务（装技能、跑审计、改 cron）**必然**超过 90s。

---

## 二、升级步骤

```bash
# 0) 备份（可选，但推荐）
cp adapters/openclaw-gateway.js adapters/openclaw-gateway.js.bak

# 1) 拉取代码（四平台任一源）
cd <你的 csb-a2a-aip 目录>
git pull

# 2) （可选）按需调整注入超时；不设则用新默认 5 分钟
echo 'A2A_BRIDGE_INJECT_TIMEOUT_MS=600000' >> .env    # 单位毫秒，示例=10 分钟

# 3) 重启 A2A 服务（用你自己的标准方式；本项目为 start-v5.sh）
bash start-v5.sh
```

---

## 三、验证（3 条，都通过才算升级成功）

```bash
# ① 单元测试：应为 14 通过 / 0 失败（原 11 例 + 新增 3 例）
node tests/bridge-adapter.test.js

# ② 确认新常量已生效
grep -n "A2A_BRIDGE_INJECT_TIMEOUT_MS\|MAX_INJECT_TIMEOUT_MS" adapters/openclaw-gateway.js

# ③ 服务可达性（端口换成你自己的）
curl -s -m 5 http://127.0.0.1:3100/health || echo "（无 /health 端点则跳过，看进程与日志即可）"
# 日志在 logs/server-v5.log（不在仓库根目录）
```

---

## 四、升级后的行为变化

| 项 | 升级前 | 升级后 |
|---|---|---|
| 默认注入超时 | 硬编码 **90s** | **5 分钟**（`A2A_BRIDGE_INJECT_TIMEOUT_MS` 可覆盖） |
| 信封 `timeoutMs` | 不参与注入超时 | **参与计算（取大）** |
| 上限 | 无 | **封顶 15 分钟**（防挂死） |
| 超时报错 | 只有"超时" | 附排查提示（调 env / 先归档会话） |

设计原则：**超时由「委托方声明的时限 + 接收方可接受上限」共同决定，接收方保留封顶权。**

---

## 五、回滚

```bash
git checkout HEAD~1 -- adapters/openclaw-gateway.js tests/bridge-adapter.test.js
bash start-v5.sh
# 或直接还原备份：cp adapters/openclaw-gateway.js.bak adapters/openclaw-gateway.js
```

---

## 六、顺带核对（同源排查，非本次改动）

1. **`identity.json` 的 `bridge.mainTo`** —— 9/11 踩过同款坑：adapter 路径与主链路读取源不一致 → "缺少主会话目标"
2. **gateway 可达 + token 有效**（注入走 gateway HTTP）
3. **先归档膨胀会话** —— 主会话越大注入越慢（实测：read 26s、shell >90s）
4. **握手配置自检**：`sh start-v5.sh --check`（2026-09-12 新增）—— 详见 `UPGRADE-HANDSHAKE-CONFIG.md`

---

## 七、回执模板（升级完请回这四项）

```
commit:      <短号，应为 f48c30c>
tests:       14 passed / 0 failed
env:         A2A_BRIDGE_INJECT_TIMEOUT_MS 是否设置（值）
restart:     是否正常（日志有无报错）
```

_2026-09-12 · 若兰 🌸 · 来源：跨实例委托实测（token-optimizer 案例）_
