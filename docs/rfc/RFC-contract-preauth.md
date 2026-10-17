# RFC · 契约预授权锚点（Contract Pre-authorization Anchor）

> **状态**：RFC-DRAFT（2026-10-16）· 三期
> **缘起**：SPEC-A2A-0003 R2 Jeason 保留意见——「契约预授权必须前置 RFC 定义 `contracts[]` schema + 签名验真路径，否则不开关。黑盒信任 ≠ 契约，是红线」。
> **对应**：SPEC-A2A-0003 §RFC-DRAFT-ANCHOR（占位节，本 RFC 即其正文）。
> **性质**：草案待议，勿引用为定论。

---

## 0. 一句话

> **预授权不是「默认同意」，是把「谁、对什么、在什么条件下、可拉哪一层、多久」写成可验签的契约。**

## 1. 目标与非目标

- **目标**：给「逐次显式授权」之外的**契约预授权**定义锚点——让「一次设定、多次生效」也可**核验、可撤销、可审计**。
- **非目标**：本期（v1.1）**不实现**；本 RFC 只定义锚点，实现与开关留待后续版本。

## 2. `contracts[]` schema（草案）

```yaml
contract:
  id: "ct-<uuid>"
  parties:                      # 双方身份（A2A 标准身份名，P2 无默认值）
    grantor: "<数据侧主人>"
    grantee: "<申请方>"
  scope:
    refs: ["csb://mem/event/12345"]   # 或 topic: / time-range:
    granularity: "single-ref"          # 对齐 SPEC-A2A-0003 R13/R14
    max_uses: 5                        # 上限（防无限拉取）
    ttl_s: 86400                       # 期限（默认 ≤24h，见 §4 防套利）
  conditions:                   # 生效条件（可空）
    purpose_allowlist: ["audit"]
  signature:                    # 签名验真路径（本 RFC 核心）
    alg: "ed25519"
    by: "<grantor>"
    value: "base64:..."
  revoked: false
```

## 3. 签名验真路径（anchor）

1. 契约体规范化（key 排序 + 去除 `signature.value`）→ `canonical`
2. `verify(signature.alg, grantor_pubkey, canonical, signature.value)`
3. 验签通过 + `revoked=false` + 未过期 + `used < max_uses` → 授权成立
4. 任一不满足 → 回落「逐次显式授权」（R3 默认拒绝）

## 4. 防套利硬约束（承 SPEC-A2A-0003 R9/R11）

- **ttl ≤ 24h 且不可继承**（不得由预授权派生更长授权）
- **max_uses 必填**（防「一次授权长期可拉」）
- **purpose 须命中 allowlist**（防 `purpose` 语义包装套利——思源 R1 指认）
- **撤销即时生效**（`revoked=true` 后下一次校验即拒）

## 5. 开放问题

1. 公钥分发：走身份护照 / 独立 JWKS / 注册表？
2. 多签名（双方共签）是否必要？
3. 契约存储位置：护照 `contracts[]` vs 独立仓？

> **三期 R2 取向（2026-10-17 · 六席收敛）**：#1 **须先定** → 走身份护照 `pubkey` 字段（Jeason/墨丘/思源/星尘）· #3 契约存储 → 护照内 `contracts[]`（墨丘）· #2 多签**可延后**。**本 RFC 本期仅登记方向与 schema 锚点，非定稿**。

## 6. 决策记录

- 2026-10-16 起 RFC-DRAFT（三期，一澜「起」）· 待协议组议题化

---
_若兰 🌸 · 2026-10-16 · 黑盒信任 ≠ 契约_