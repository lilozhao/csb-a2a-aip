# E2E 诚实降级（P0-4）

> 落点：`csb-a2a-aip`（AIP 侧）+ `csb-security`（权威实现侧）
> 依据：知微《CSB-Harness 2.0 优化升级方案 v1》§5 P0-4「A2A E2E 加密：真做，或诚实降级」+ §10「不许吹」清单第 3 条
> 日期：2026-11-03

## 一、为什么必须改（事实 3 原文）

> A2A 的出站"加密"只是置了一个布尔 —— `a2a-e2e-encryption.js:174–178`：
> ```js
> if (e2eManager.enabled && obj?.result?.task) {
>   obj.encrypted = true;      // ← 只标记，不加密
> }
> ```
> 而同文件的 `/health` 却按 `enabled` 报 `e2e: true`。
> **这是"假绿"最典型的形态**——比明说不支持更危险，因为它会让对接方以为可以传敏感数据。
> 另：`:143` 无密钥时验签直接通过。

三个假绿叠在一起：

| # | 假绿 | 外部看到的样子 | 实际 |
|---|---|---|---|
| ① | 出站只置布尔 | 响应里 `encrypted: true` | **一个字节都没加密** |
| ② | `/health.e2e.enabled` | 绿灯 | 出站是明文 |
| ③ | 无密钥时验签 `return true` | 验签通过 | 任何签名都算通过，签名形同虚设 |

## 二、方案选择：B「诚实降级」

方案的 A 选项是「接 csb-security 密钥体系做出站真加密」，B 是「`/health.e2e` 改三态，degraded 时明确 `reason:'not_implemented'`」。

**本次选 B**，理由：A 需要协议层两侧的解包顺序打通（客户端先读 `result.task` 再解 payload），硬改会破坏现有 17 家客户端；而且**「假绿」的危害可以在不真做的情况下先消除**。

## 三、三态定义

| status | 条件 | reason | 含义 |
|---|---|---|---|
| `enabled` | 有主密钥 **且** 出站真加密 | `null` | 真加密 |
| `degraded` | 有主密钥，但出站未真加密 | `not_implemented` | **能解密入站，出站仍是明文** |
| `disabled` | 无主密钥 | `no_master_key` | 完全未启用 |

硬约束：
- 非 `enabled` 态 **reason 必填且非空**（测试锁死）
- `outboundEncrypted=true` 但无主密钥 → **构造时直接抛错**，杜绝「声明加密却没密钥」
- 兼容字段 `enabled` 语义收紧为「有主密钥」，**不再表示「E2E 可用」**。新代码一律读 `status`。

## 四、对外字段

```json
// GET /health
"e2e": {
  "status": "disabled",           // 新：三态
  "reason": "no_master_key",      // 新：为什么
  "enabled": false,               // 兼容：有主密钥（语义已收紧）
  "outboundEncrypted": false,     // 新：出站是否真加密
  "algorithm": "aes-256-gcm",
  "keyVersion": 1,
  "agentKeys": 0
}

// GET /capabilities
"capabilities": { "e2e": "disabled" }   // 从布尔改为三态字符串
```

出站 JSON-RPC 响应（原 `encrypted: true` 改为）：

```json
{ "encrypted": false, "encryptionReason": "not_implemented" }
```

## 五、验签语义变更（⚠️ 破坏性）

`verifySignature(plaintext, signature)`：
- 原来：无主密钥或无签名 → `return true`
- 现在：两者都 → `false`

**这是行为变更，不是纯加固**。需要区分原因的调用方用 `verifySignatureDetailed()`：

```js
{ valid: false, reason: 'no_master_key' | 'signature_missing' | 'signature_length_mismatch' | 'signature_mismatch' }
```

全仓排查结论：**没有生产调用方依赖旧的「无密钥即通过」行为**（只有 csb-security 自己的单元测试，而它测的是「有密钥 + 有签名 → 通过 / 内容不符 → 失败」，不受影响）。

## 六、测试判据

### csb-security（`npm test` → 337/337）
`test/test-e2e-encryption.js` 17/17，新增 9 条：三态三分 · 反向自测（声明加密却没密钥 → 抛错）· 不变量（非 enabled 必带 reason）· 假绿消除 ×3 · 回归（正常路径不变）。

### csb-a2a-aip（`node --test tests/e2e-honest-degrade.test.js` → 4/4）
起临时实例（独立端口 + 独立身份 fixture，绝不写注册表），**用真 HTTP 打 `/health`**：

| 判据 | 内容 |
|---|---|
| I1+I3 | 无主密钥 → `status='disabled'` + reason 非空 |
| I2+I3 | 有主密钥未真加密 → `status='degraded'` + `reason='not_implemented'`，**绝不能是 enabled** |
| I4 | 出站响应 `encrypted=false` 且带 `encryptionReason`；任何情况下不得出现 `encrypted=true` 而实际未加密 |
| 负向 | 三态判定器自身能识别「假 enabled」 |

## 七、诚实边界（本项**没有**做到的）

1. **出站信封级真加密未实现** —— 本次只做到「诚实降级」。`degraded` 的含义就是「有密钥但出站仍是明文」，不是「差一点点就加密了」。
2. **ECDH 会话密钥已有但未接入出站** —— `csb-security/lib/transport/session-keys.js` 的 ECDH 能力现成，但出站路径未使用。
3. **`/capabilities.e2e` 从布尔改成字符串是破坏性变更** —— 现有客户端无人读该字段（已全仓核对），但外部 Agent 若读了会拿到 `"disabled"` 而非 `false`。
4. **server_v4.js 未同步** —— v4 是旧版本分支，当前生产跑 v5（PID 48730）。v4 仍有假绿代码，但**不在服务路径上**。
5. **audit 里 `e2e` 段未进健康检查总分** —— `scripts/csb-doctor.js` 无 e2e 检查项，degraded 不会体现在 doctor 的三态里。

## 八、相关文件

| 文件 | 改动 |
|---|---|
| `csb-security/lib/transport/e2e-encryption.js` | 三态 + `verifySignatureDetailed` + `outboundEncrypted` |
| `csb-security/test/test-e2e-encryption.js` | +9 条判据（17/17） |
| `csb-a2a-aip/a2a-e2e-encryption.js` | legacy 拷贝同步（`security-adapter` 降级时才用到） |
| `csb-a2a-aip/server_v5.js` | `/health` · `/capabilities` · 启动日志三处改三态 |
| `csb-a2a-aip/tests/e2e-honest-degrade.test.js` | 新增，4/4（真 HTTP） |

## 九、怎么确认「真的诚实了」

```bash
# 本机
curl -s http://172.28.0.214:3100/health | jq .e2e
# 期望：{ "status": "disabled", "reason": "no_master_key", "enabled": false, ... }

# 配了密钥的机器
curl -s http://<host>:3100/health | jq .e2e
# 期望：{ "status": "degraded", "reason": "not_implemented", "enabled": true, ... }
```

**判据一句话**：`status` 永远不能是 `enabled`，除非 `outboundEncrypted` 也是 `true`。
