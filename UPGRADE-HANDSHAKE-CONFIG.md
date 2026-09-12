# UPGRADE · 握手配置可移植化（2026-09-12）

> 对应 commit：见仓库最新（本文件同批提交）
> 影响：`start-v5.sh`（启动配置解析）· `identity.json`（新增可选字段）
> 风险：低（只影响握手凭据解析；缺失时**告警**而非静默禁用）

---

## 一、修的是什么问题

`start-v5.sh` 里此前**硬编码**了某个实例的凭据路径：

```sh
# 修前（错误）
export A2A_SECURITY_HANDSHAKE_AID=/home/node/.openclaw/workspace/csb-security/data/Jeason-aid.json
export A2A_SECURITY_HANDSHAKE_KEY=/home/node/.openclaw/workspace/csb-security/data/Jeason-private-key.pem
export A2A_SECURITY_HANDSHAKE_USER_PUBKEY='{"crv":"Ed25519",...}'
```

两个后果，都很坏：

1. **其他实例拉下来** → 要么「以别人的身份握手」（如果那些文件恰好存在），要么（文件不存在时）**握手端点静默禁用**
2. **静默 = 没人发现**。实测本机 `csb-security/data/` 里根本没有 `Jeason-*` 文件 → 握手一直是关的，谁都不知道

> 这是本项目**第三次**同类 bug：「配置未进进程 + 失败不吭声」
> （前两次：`.env` 未加载导致 gateway token 缺失 · 主会话目标读取源不一致）

---

## 二、修后的解析优先级

```
显式 env  >  identity.json 的 security.handshake 声明  >  按实例 slug 目录约定
```

`identity.json` 可选字段（**只声明位置，不放密钥**）：

```json
{
  "security": {
    "handshake": {
      "slug": "ruolan",                 // 约定：<slug>-aid.json / <slug>-private-key.pem
      "aid": "../csb-security/data/ruolan-aid.json",   // 可选：显式路径（优先于 slug）
      "key": "../csb-security/data/ruolan-private-key.pem",
      "userPubkey": "..."               // 可选：统一用户公钥（否则读 yilan-user-pub.json）
    }
  }
}
```

数据目录可用 `CSB_SECURITY_DATA_DIR` 覆盖（默认 `../csb-security/data`）。

---

## 三、升级步骤

```bash
cd <你的 csb-a2a-aip>
git pull

# ① 先自检（不启动，只打印解析结果）——强烈建议先跑这个
sh start-v5.sh --check
```

输出示例（配置完整时）：

```
  数据目录      : ../csb-security/data
  实例 slug     : ruolan
  AID           : ../csb-security/data/ruolan-aid.json ✓存在
  私钥          : ../csb-security/data/ruolan-private-key.pem ✓存在
  用户公钥      : ✓已配置
  账本签名 key  : ✗未配置（signed=false）
✅ 握手配置完整
```

若有 ✗：

- **AID/私钥缺失** → 生成该实例自己的凭据，或在 `identity.json` 填 `security.handshake.{slug|aid|key}`
- ⛔ **绝不能指向其他实例的凭据** —— 那等于以别人身份握手
- **账本签名 key 未配** → 信任账本以 `signed=false` 运行（签名纪元代码就位但未激活）

```bash
# ② 正式重启
bash start-v5.sh
```

---

## 四、验证

```bash
sh start-v5.sh --check                 # 应显示 ✅ 握手配置完整（或明确列出待处理项）
tail -50 logs/server-v5.log            # 启动日志（注意：在 logs/ 下，不在仓库根目录）
curl -s -m 5 http://127.0.0.1:3100/health
```

---

## 五、回执模板

```
实例:            <名字>
--check 结果:    握手配置完整 / 列出 N 项待处理
AID / 私钥:      ✓/✗（是否指向本实例）
账本签名:        已配 / 未配（signed=false）
日志路径:        logs/server-v5.log
```

---

## 六、给实例维护者的三条原则（本项目反复踩过的）

1. **不硬编码任何人的路径** —— 用 env / identity.json / 目录约定
2. **配置缺失要出声** —— 静默降级比崩溃更危险（崩溃会被修，静默会存活数月）
3. **启动时自检**（`--check`）—— 把"配置是否正确"变成一条命令可回答的问题

_2026-09-12 · 若兰 🌸 · 来源：跨实例升级验收时由对方发现（阿轩 💼 = 感谢）_
