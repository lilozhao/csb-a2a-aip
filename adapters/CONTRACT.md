# 注入适配器契约（single source of truth）

> 2026-09-16 建立 · **参照实现 = `adapters/openclaw-gateway.js`**（唯一被实践证明可用的）
> 机读门禁 = `adapters/_contract.js` + `tests/adapter-contract.test.js`（**新增适配器必须过**）
> 缘起：为 Hermes 写适配器时「同名函数 ≠ 同契约」一晚踩三次 —— 参数名 / 返回结构 / 缺省语义。

---

## 一、方法面（缺一即不可用）

| 方法 | 用途 | 必须 |
|---|---|---|
| `inject(envelopeOrFrame, taskIdOrOpts, opts?)` | 注入执行（**双契约**：裸参 / frame 形式） | ✅ |
| `injectIsolated(envelope, taskId, opts?)` | 隔离注入（不污染主会话） | ✅ |
| `resolveConfig()` | 配置解析（纯函数，无副作用） | ✅ |
| `fetchResult(taskId, opts)` | L3 确认**读回** | ✅ |
| `buildInjectMessage(frame)` | 构造注入消息（纯函数） | ✅ |
| `detectRefusal(content)` | 拒绝识别（纯函数） | ✅ |
| `CONTRACT`（**导出常量**） | 机读契约声明 | ✅ |

## 二、参数名（canonical，bridge → adapter）

| 方法 | canonical 参数 | 说明 |
|---|---|---|
| `fetchResult` | `taskId` · **`sinceMs`** · `limit` · `sessionKey` · `path?` | **`sinceMs` 是毫秒**；`since`（ISO/Date）仅作兼容别名 |
| `inject` | `envelope` · `taskId` · `{ to, isolated, timeoutMs, token }` | frame 形式：`{ taskId, delegatorLabel, envelope }` |

> ⚠️ **踩过的坑**：adapter 只认 `since` 而 bridge 传 `sinceMs` → 时间下界静默丢失。

## 三、返回结构

### 3.1 `fetchResult` **成功**返回（★ 最容易静默出错的地方）
```js
{
  ok: true,
  matched: boolean,
  result: {                       // ★★ bridge 的读回循环调 collectTexts(resp.result)
    matched: boolean,
    replyText: string|null,
    messages: [{ text: string }], // ★ 文本必须在这条路径下能被取到
    raw: any,
  },
  // 其余字段自由（如 reply / raw 顶层快捷方式）
}
```
- ❌ **缺 `result` 字段 = 静默从不解析**（`collectTexts(undefined)` → `[]`）—— 2026-09-16 Hermes 首轮就栽在这
- 失败返回：`{ ok: false, error: string }`，**不得抛错**

### 3.2 `inject`
- 裸参形式：成功返回 `{ summary, artifact?, refused? }`；**失败抛错**（由 bridge 走降级）
- frame 形式：返回 `{ ok: true, result }` / `{ ok: false, error }`，**不抛**

### 3.3 `resolveConfig`
必须含：`channel` · `sessionKey` · `mainTo`（bridge 与 confirm 都读）

## 四、缺省语义（同形接口下最阴的差异）

- **不要假设「缺省值一致」**：OpenClaw 的 `fetchResult` 自带实现、不看 `path`；Hermes 靠默认值回落保守路径 C ⇒ 同一行调用，两系行为完全不同。
- 适配器有特殊偏好（如需特定读回路径）→ **主动声明能力**：`adapter.confirmReadPath()` 返回 `'db' | null`；bridge 未显式配置时会问它。

## 五、新增适配器 checklist（跑完才算上线）

1. `node tests/adapter-contract.test.js` —— **门禁全绿**（含假适配器反向自检）
2. 与参照实现**逐参数、逐字段**对照（`NEW-ADAPTER-CHECKLIST.md` §一）
3. 自己的单测覆盖：成功 / 失败 / 超时 / 拒绝 / 无 shell 拼接 / 环境隔离
4. **换一台配好 env 的机器再跑一遍**
5. 端到端跑一次**最重路径**（L3 write/shell 全流程）

---
_一句话：**「接口同形」只是签名一致；实参名、返回形状、缺省语义三者任一错位，都会造成静默失效 —— 而静默失效比报错更贵。**_
