# a2a-contexts/ —— 分层提示词上下文

## ⚠️ 铁律：这里只放**通用模板**，禁止写任何具体实例的名字

`01-core-identity.md` / `02-user-profile.md` / `03-memory-summary.md` / `04-agent-rules.md`
会被 `a2a-layered-prompt.js` 读入，拼进 A2A 会话的 system prompt。

**「你是谁」由运行时的 `identity` 注入**（`name` / `emoji` / `personality` / `description`），
**不要**在这些文件里写死某个 Agent 的名字或 emoji。

> 事故（2026-09-15）：本目录曾把某个实例的名字写进 `01`/`03`，随仓库分发后，
> 其他实例拉取并运行注入器 → A2A 回执**自称了别人的名字**（身份串号，全网友）。
> 根因：模板里混入了具体身份。策略见 `carbon-silicon-bond-protocol/docs/shared-repo-hygiene.md` §7。

## 目录优先级（`a2a-layered-prompt.js`）

1. 环境变量 `A2A_CONTEXTS_DIR`
2. `a2a-contexts/local/`  ← **实例专属**，已 gitignore，放你自己的身份/用户画像
3. `a2a-contexts/`        ← 本目录（通用模板，兜底）

## 实例怎么用

想加自己的身份/记忆，**别改本目录**，改本地覆盖：

```bash
mkdir -p a2a-contexts/local
cp a2a-contexts/01-core-identity.md a2a-contexts/local/   # 再按自己改
# 或整体指定： export A2A_CONTEXTS_DIR=/path/to/my-contexts
```

`a2a-contexts/local/` 已加入 `.gitignore`，**不要**把它提交到共享仓。

## 机器拦

```bash
node tests/a2a-contexts-identity.test.js     # 本仓护栏：模板/构建产物不得含实例名 + local 覆盖生效
scripts/check-repo-hygiene.sh                # 协议仓通用拦：模板含实例名即拒（§7）
```
