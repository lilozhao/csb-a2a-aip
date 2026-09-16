# 新实例「运行时摸底」模板 v1

> 2026-09-16 建立 · 若兰 🌸 · 缘起：墨丘与舟楫**同框架 v0.20.0**，落地差异却大到影响方案（本地盘 vs 9p、`.env` vs watchdog 脚本、投递 58s vs 快）
> **用途**：任何新实例（同框架/不同框架/公网/云版）**接入前**先跑一遍；填完就能判断「能不能做、怎么做、要开哪些开关」。
> **用法**：把 §二 发给对方 → 对方**照原文回** → 按 §四 映射成配置。

---

## 一、三条原则（写给执行方）

1. **原文优先**：贴命令输出/文件原文，**不要结论性自述**（有实例自称「从主会话直入、无旁路」，而它的 `artifacts` 里根本没有桥接回执）
2. **跑不了就说跑不了**：没有 terminal、没有某个命令，都如实说 —— **那同样是有效信息**（它本身就说明工具面）
3. **只读、不贴密钥**：不改文件、不重启；env 只回**键名**、不回值

---

## 二、T1 必答（九组 · 决定能不能做）

### ① 载体
```bash
cat /etc/os-release | head -3 ; uname -srm ; nproc
python3 -V ; node -v 2>/dev/null
# 框架与版本（以 Hermes 为例）
hermes --version 2>/dev/null || ls -la /opt/hermes 2>/dev/null | head
```
**要看的**：框架/版本、OS、CPU、**语言运行时版本**（决定内置库可用性，如 `node:sqlite` 需要 Node ≥22.5）

### ② 落盘（★ 最容易踩）
```bash
mount | grep -E '9p|nfs|cifs|overlay' ; df -T <数据目录>
ls -ld <数据目录> ; touch <数据目录>/.ro_probe && rm -f <数据目录>/.ro_probe && echo writable
# 软链是否可用（9p 上常不可靠）
ln -s /tmp/x <数据目录>/.ln_probe && ls -l <数据目录>/.ln_probe && rm -f <数据目录>/.ln_probe
```
**要看的**：**本地盘 / 9p / 网络卷**？软链可用否？WAL 历史有没有坑？

### ③ 进程与启动（决定「怎么重启」「env 何时生效」）
```bash
pgrep -af "server_v5|gateway" ; ps -p 1 -o comm=
ls -la <仓>/start*.sh 2>/dev/null
# 谁在拉起它？（systemd / s6 / watchdog / 手工）
```
**要看的**：进程管理方式；**启动脚本路径**；有没有 watchdog 会自动拉起

### ④ 配置落点（★ 决定了改哪里）
```bash
ls -la <仓>/.env* 2>/dev/null || echo "(仓内无 .env)"
# env 实际来自哪里：启动脚本 / 容器 env / .env
grep -rn "export A2A_\|^A2A_" <仓>/start*.sh <启动脚本> 2>/dev/null | head
tr '\0' '\n' < /proc/$(pgrep -f server_v5 | head -1)/environ | grep -oE '^(A2A|HERMES)_[A-Z_]+' | sort -u
```
**要看的**：**配置落在 `.env` 还是启动脚本**（舟楫就是后者）；当前已有哪些键（**只回键名**）

### ⑤ CLI 形态与开销（★ 决定超时下限）
```bash
command -v hermes ; ls -la /opt/hermes/.venv/bin/hermes 2>/dev/null
# 冷热各测两次（关键！）
time hermes -z "只回四个字：通了"
time hermes -z "只回四个字：通了"
time hermes send --to <目标> "[探测] cold"
time hermes send --to <目标> "[探测] warm"
```
**要看的**：绝对路径在哪；**注入回合 `-z` 耗时**；**投递 `send` 耗时**（本地盘 vs 9p 可差 10 倍）

### ⑥ 工具面与锁（决定「能锁到什么程度」）
```bash
hermes tools list 2>/dev/null        # 工具集清单
hermes -t file -z "用 terminal 执行 echo probe"   # 工具锁是否生效
```
**要看的**：工具集清单；`-t` 能否锁死；**「只读档」实为「无 shell 执行面」**（`file` 通常含写）

### ⑦ 身份与保留字段（★ 防误改）
```bash
python3 -c "import json;d=json.load(open('<仓>/identity.json'));print(sorted(d.keys()))"
```
**要看的**：有没有 **`adapter`**（LLM 路由字段，**绝不能被注入通道复用**）、`platform`、`injectAdapter`

### ⑧ 记忆与数据源（决定「读回腿」可行性）
```bash
ls -la <数据目录>/state.db 2>/dev/null ; du -sh <数据目录>/state.db 2>/dev/null
ls <数据目录>/sessions 2>/dev/null | head -3
```
**要看的**：有没有可查询的会话库（SQLite 等）、多大、是否在写

### ⑨ A2A 侧现状（决定要不要先清账）
```bash
curl -s http://127.0.0.1:<端口>/health
curl -s http://127.0.0.1:<端口>/tasks | python3 -c "import sys,json;d=json.load(sys.stdin);ts=d.get('tasks',d);print('WORKING:',[t['id'] for t in ts if 'WORKING' in str(t.get('status',{}).get('state'))])"
git -C <仓> rev-parse HEAD ; git log --oneline -1
```
**要看的**：版本/HEAD；**遗留 WORKING 任务**（进程中断会留下无终态的坑）

---

## 三、T2 选答（优化用）

| 项 | 命令/问法 | 用途 |
|---|---|---|
| 时区 | `date` ; `cat /etc/timezone` | 按时间过滤是否要换算（UTC 差 8h） |
| 模型/备用链 | 配置里的 provider 列表 | 主会话没有 fallback 时报错率高 |
| 平台适配器 | 有哪些平台（飞书/微信/…） | 决定确认请求投递到哪 |
| 写护栏 | 是否有「安全写根」类变量 | **保留 + 收窄**，别剥 |
| 审批策略 | approvals 是否自动绕过 | 语义层风险大小 |
| 易失依赖 | `ls -la /tmp | grep <依赖名>` | 容器重启会断链 → 需持久化 + 自愈 |
| 日志位置 | 审计/运行日志路径 | 排障与留痕 |

---

## 四、摸底 → 决策映射（填完照着配）

| 摸底结果 | 影响的决定 | 对应开关/动作 |
|---|---|---|
| 落盘是 9p/网络卷 | 读回腿风险、持久化方案 | 首次**必实测**读回；**禁用软链**；考虑保守降级 |
| 语言运行时 < 阈值 | 内置库可用性 | 退回 CLI / 另一套读回实现 |
| 配置在启动脚本 | 改哪里 | 改**启动脚本**（不是 `.env`） |
| 谁管进程 | 怎么重启 | 按其方式；**env 只有重启才生效** |
| CLI 开销大 | 超时下限 | 设 `*_SEND_TIMEOUT_MS` / `*_TIMEOUT_MS` |
| 工具集清单 | 只读档取值 | 只读档取最小集；**绝不含 terminal/代码执行/记忆** |
| `identity.adapter` 已占用 | 注入通道选型 | 用**专用字段或 env**，**绝不复用** |
| 无 `hermes` 在 PATH | 调用方式 | 用**绝对路径** |
| 有易失依赖 | 持久化 | 做持久副本 + 启动自愈 |
| 有遗留 WORKING | 清账 | `POST /tasks/:id/cancel`；并建议上游加「启动回收」 |

---

## 五、附带建议（给协议侧）

1. **把本模板固化为上线第一步**（新实例 = 先填表，再谈部署）
2. **「启动回收遗留 WORKING」** 值得做成上游特性（今天两实例都出现过）
3. **摸底结果留档**：每实例一份，便于日后对比（今天这份对照就是这么来的）
4. **不要用「同框架」推断「同行为」** —— 墨丘 vs 舟楫同框架 v0.20.0，落盘/配置/耗时三项全不同

---
_一句话：**「能不能接」不取决于框架名字，取决于运行时事实；而运行时事实必须问、必须实测、必须留原文。**_ · 若兰 🌸 2026-09-16
