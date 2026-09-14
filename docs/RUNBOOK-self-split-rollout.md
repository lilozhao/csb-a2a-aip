# RUNBOOK · 拆 self 迁移（逐实例标准化流程）

> **谁用**：把跑 `csb-a2a-aip` 的实例迁到新 master（含 `a992bf4` 对外地址修复 + 拆 self + identity 模板）。
> **怎么用**：一台一台来；每步有**通过判据**，不过就停手。
> **首次实战**：小虾（2026-09-14，五步闭环 ✅）
> 若兰 🌸 · v1.0

---

## 0. 前置能力检查（不合格就别走 A2A）

| 检查 | 怎么查 | 不合格的后果 |
|---|---|---|
| 目标能执行 shell | read 委托让它跑 `git rev-parse HEAD` | 无执行通道 → **改人工**（主人本机跑） |
| 目标 bridge 有主会话目标 | 它 `A2A_BRIDGE_MAIN_TO` 非空 | 缺 → `bridge_unavailable`，L3 确认投不出去 |
| origin 是**我们的源** | 它 `git remote -v` | 是别的源（如 `code.whale`）→ **停手，单议** |
| 目标在线健康 | `GET /health` = ok | 离线 → 等 |

> 若兰侧操作：`node scripts/a2a-delegate.js <host:port> --scope read --target-file <file>`

---

## 1. 五步 SOP

### S1 · 备份 + 取证（L3）
```
mkdir -p ~/.openclaw/workspace/backups && tar czf ~/.openclaw/workspace/backups/csb-a2a-aip-pre-migrate-$(date +%Y%m%d%H%M%S).tar.gz -C ~/.openclaw/workspace csb-a2a-aip --exclude=node_modules
git log --oneline origin/master..HEAD     # 本地独有提交
git status -sb ; git diff --stat          # 脏文件
ls -la identity.json*                     # 身份文件
```
**通过判据**：tarball 生成；本地提交/脏文件清单拿到。
**失败**：不继续。

> ⚠️ 若实例用 `A2A_IDENTITY_PATH` 指向 **非** `identity.json` 的身份文件（如 `identity.kai.json`），**必须连带保命**——它们往往也**被跟踪**，`reset --hard` 会一并冲掉。

### S2 · 冻结 + 收敛（L3）
```
cp -p identity.json identity.json.keep                          # 保命（见坑 #4）
for f in identity*.json; do [ -f "$f" ] && cp -p "$f" "$f.keep-$(date +%Y%m%d%H%M%S)"; done   # 全部身份变体保命（含 A2A_IDENTITY_PATH 指向的那份，如 identity.<名>.json）
git add -A && git commit -m "backup: 迁移前本地状态"            # 脏文件固化
git branch backup/pre-migrate-$(date +%Y%m%d%H%M%S)             # 本地状态留档
git fetch origin && git reset --hard origin/master
mv identity.json.keep identity.json                             # 回位
grep -o '"publicHost"' identity.json || echo MISSING_PUBLICHOST # 缺就补本机地址
git grep '"self"' config/agents.json || echo OK_SELF_GONE
```
**通过判据**：`self` 消失；`git status` 与 origin 同步；`identity.json` 在位且含 `publicHost`。
**失败**：停手回报（备份分支还在）。

### S3 · 重启 + 验收（L3）
```
bash start-<name>.sh ; sleep 3
curl -s localhost:<port>/.well-known/agent.json | grep -o '"jsonrpc":"[^"]*"'   # 必须是本机地址
curl -s localhost:<port>/health
ps -eo pid,etimes,cmd | grep server_v5 | grep -v grep                          # 坑 #1
```
**通过判据**：`jsonrpc` = 本机地址（不是 `localhost`）；`/health` ok；**新 PID 的 etimes 很小**。

### S4 · 拉齐 + 验证忽略（L3）
```
git fetch origin && git pull --ff-only origin master
git check-ignore -v identity.json identity.json.keep identity.json.bak-*
```
**通过判据**：`check-ignore` 对**每一份**身份文件都命中（坑 #3）。

### S5 · 密钥入 env（L3）
```
# 明文 apiKey → apiKeyEnv
node -e '...'（见下）      # 把 identity.json 的 apiKey 搬到 env，字段换成 apiKeyEnv
printf '%s\n' 'start-<name>.sh' 'a2a-watchdog.sh' '.env' >> .git/info/exclude
bash start-<name>.sh ; sleep 3
# 验：进程 env 有 key；做一次【真实 LLM 调用】确认不 401
```
**通过判据**：`identity.json` 只剩 `apiKeyEnv`（无明文）；进程 env 命中；**LLM 实测可用**（坑 #2）。

---

## 2. 四坑（写死，别踩）

### 坑 #1｜`server.pid` 陈旧 → 重启没生效 / 杀错进程
- 现象：启动脚本按 pid 文件停进程，但 pid 文件内容过时（小虾：记 4356、实跑 221）。
- 处置：重启后**必须**核对 `ps -eo pid,etimes` —— **新 PID + etimes 很小**才算真重启；必要时手工 `kill` 旧 PID。

### 坑 #2｜`export` 顺序 → 子进程拿不到 Key（会 401）
- 现象：把 `export A2A_LLM_API_KEY=...` 追加在启动命令**之后** → `nohup node` 起来的进程没有该 env。
- 处置：**env 注入必须写在启动命令之前**。改完验"进程 env 命中 + 真实 LLM 调用通过"。

### 坑 #3｜身份变体命名 → 逃过忽略规则
- 现象：`*.bak.*` 只认**点号**形式；`identity.json.bak-<日期>`（dash）、`identity.json.keep` **漏网**；而这些文件常含**明文密钥**。
- 处置：规则要覆盖 `identity.json*`（并 `!identity.json.example` 保留模板）；本地文件另加 `.git/info/exclude`。已修：`csb-a2a-aip/.gitignore`@`81f1b1c` + 协议主仓 checker@`2ca3a51`。

### 坑 #4｜本地 ahead + 身份文件 → `reset --hard` 会删身份
- 现象：本地有独有提交时 `pull --ff-only` 被拒；而 `reset --hard` 会把**被跟踪的** `identity*.json`（内含 **bridge 段**，L3 确认靠它投递）一起删掉 → 断桥。
- **以恺为例**：它的 `A2A_IDENTITY_PATH=identity.kai.json`，该文件**被跟踪** → 不保命就会被冲掉。
- 处置：`reset --hard` **之前**把 `identity*.json` **全部**拷成 `.keep-<ts>`，之后 `mv` 回位；本地提交先固化到 `backup/pre-migrate-*` 分支。
- 规则侧：`.gitignore` 用 **`/identity*` + `!/identity.json.example`**（根目录全变体；别用 `identity*`，否则会误伤 `src/identity.js`）。已修 `csb-a2a-aip/.gitignore`。

---

## 3. 回滚总表

| 阶段 | 回滚 |
|---|---|
| S2 后代码不对 | `git reset --hard <S1 的 HEAD>`（备份分支仍在） |
| S3 后起不来 | 按原方式拉起旧进程；必要时 `git reset --hard <S1 的 HEAD>` |
| S5 后 LLM 哑 | `cp -p identity.json.keep2-<ts> identity.json` + `cp -p start-*.sh.keep-<ts> start-*.sh` + 重启 |

---

## 4. 边界（不可绕过）

- **只 ff，绝不 `--force`**；分叉/冲突 → 停手回报。
- `write/shell` 类操作 = **L3**，需**接收方主人实时确认**才执行（默认窗口 = min(声明, 5min)）。
- 五端镜像凭据**只在若兰侧**：实例只推 Gitee，镜像由若兰统一推。
- 历史清洗（`filter-repo`）**暂缓**，未经一澜点头不得执行。

---

## 5. 回执模板

```
delegator: / scope: / duration: / result:
通过判据逐条：S1 ✅ S2 ✅ S3 ✅ S4 ✅ S5 ✅
异常/偏差：<有则写>
明文密钥：不回传
```

_配套：`docs/MIGRATION-self-split.md`（单实例一页纸）· `scripts/init-instance-config.sh` · 策略 `docs/shared-repo-hygiene.md`（协议主仓）_
