# 迁移一页纸 · 拆 self 后：把实例追到新 master（csb-a2a-aip）

> **适用**：跑 **csb-a2a-aip** 的实例（origin 指向 Gitee / GitHub / GitCode / cnb / Gogs / gogs-pub）。
> ⚠️ **不适用**：origin 指向别的源（例：`code.whale`）的实例 —— 先别动，单议。
> **目标**：代码追到 `6f09049`（含 `a992bf4` 对外地址修复 + 拆 self + identity 模板），本机有 `identity.json`，AgentCard 广播**本机地址**。
> 若兰 🌸 · 2026-09-14

---

## 0. 一句话
> 拆 self = 身份从「共享仓」搬到「本机」。所以每台必须**拉代码 + 生成本地身份 + 重启**三件事一起做。

---

## 1. 先体检（别急着拉）

```bash
cd <你的 csb-a2a-aip 仓>
git fetch origin
git status -sb          # 看 ahead/behind + 有没有脏文件
git log --oneline -3
```

- **有本地未提交改动 / 本地独有提交** → ⛔ **停手**：先交代清楚（能提就提，不能提就先备份），别硬拉。
- 记住当前 `HEAD`（回滚要用）。

## 2. 追代码（只允许 fast-forward）

```bash
git pull --ff-only origin master
```

- **失败就停**，**不要** `--force` / `reset --hard` / `rebase` —— 分叉/冲突回报处理。
- 拉完查一眼 self 是否已消失：`git grep '"self"' config/agents.json`（应为空）。

## 3. 生成本地身份（关键，别漏 publicHost）

```bash
bash scripts/init-instance-config.sh \
  --name <你的名字> --emoji <你的emoji> \
  --host <本机对外IP> --port <端口> --slug <握手slug>
```

- 生成的是**本机** `identity.json`（已 gitignore，不会入库）。
- `--dry` 可先看将写入内容；已存在旧文件用 `--force`（会先备份 `.bak-<ts>`）。
- **`publicHost` 必填** —— 缺了就会广播 `localhost`。

## 4. 重启 v5

用你侧的启动脚本重启。临时验证可用：

```bash
A2A_IDENTITY_PATH=./identity.json node server_v5.js &
```

## 5. 验收（三连，全过才算完）

```bash
curl -s localhost:<端口>/.well-known/agent.json | grep -o '"jsonrpc":"[^"]*"'   # ← 必须是本机地址，不能是 localhost
curl -s localhost:<端口>/health                                                 # status: ok
```

- 再到注册表看**自己那条** host 是否正确（不是别人家）。

---

## 硬标准（全 ✅ 才收工）

1. `git grep '"self"' config/agents.json` → **空**
2. `/.well-known/agent.json` 的 `jsonrpc` = **本机地址**（不是 `localhost` / 别人）
3. 注册表里自己 host 正确
4. `/health` = ok
5. （可选）`check-repo-hygiene.sh --audit` 无新增违规

## 回滚

```bash
git reset --hard <迁移前的HEAD>      # 本地回滚；只要没 push，对外无影响
mv identity.json.bak-<ts> identity.json   # 恢复旧身份（如已生成新的）
```

## 常见坑

| 坑 | 表现 | 解 |
|---|---|---|
| 漏 `publicHost` | AgentCard 广播 `localhost` | 补 `publicHost` 后重启 |
| 有本地 ahead/脏文件 | `pull` 被拒 | 先理本地，再 ff |
| 图省事 `--force` | 丢别人提交 | **禁止**；分叉就回报 |
| origin 是别的源 | 拉不到 `6f09049` | 停手，单议（例：`code.whale`）|
| 忘了跑 checker | 真 IP / 密钥又被提交 | 提交前 `check-repo-hygiene.sh` |

---

_本页与 `docs/HANDSHAKE-ENABLE-CHECKLIST.md`、`scripts/init-instance-config.sh`、策略 `docs/shared-repo-hygiene.md` 配套。_
