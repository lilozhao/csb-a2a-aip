# A2A 看门狗（通用版）· 部署与维护

> 2026-09-18 · 若兰 🌸 · 缘起：舟楫宿主那份 `a2a-watchdog.sh` **不在任何 git 仓里**（唯一"历史"是手工 `.bak`），
> 出问题只能靠人肉比对。抽成通用版入仓后：**改仓 → pull → 自动到位**。

## 为什么入仓

舟楫宿主那份脚本实测暴露两个真问题（逐行可核）：

| # | 问题 | 原版 | 本版 |
|---|---|---|---|
| ① | **误报"挂了"** | `curl ... --max-time 5` **单发无重试** → 一次抖动就判死 | 轮询 + 递增退避；失败日志带 `last=<code>` 与尝试次数 |
| ② | **截断 server.log** | `node server_v5.js > logs/server.log`（单 `>`）→ 每次重启清空历史 | `>>` 追加 + 可选按大小轮转（`A2A_SERVER_LOG_MAX_BYTES`） |
| ③ | **PID 误纠正** | `pgrep -f "node server_v5.js"` 模式过宽 → 写错 PID → 下轮误重启 | 模式可配（`A2A_PROC_PATTERN`），且只在能唯一命中时纠正 |

## 设计：模板 + 本机差异分离

```
scripts/watchdog/
├── a2a-watchdog.sh          # 通用版（进仓）—— 只干"看门狗该干的事"
├── instance.env.example     # 配置模板（进仓）—— 占位值，无秘密
├── instance.env             # 本机实际配置（**不进仓**，已 gitignore）—— 路径/私有 export
└── README.md                # 本文件
```

**红线**：`instance.env` 里会有密钥路径、内部会话 ID 等实例私有值 —— **绝不提交**。

## 部署（实例本机一次性，3 步）

> ⚠️ 这三步属"改自身运行方式"，**必须由该实例的主人本机执行**；
> 经 A2A 桥接注入的回合会且应当拒绝这类自改操作（T4：拒绝权不可让渡）。之后所有改动都走 `git pull`。

**第 1 步**：写实例配置

```bash
cd <repo>/scripts/watchdog
cp instance.env.example instance.env
vim instance.env          # 填 A2A_DIR / A2A_START_CMD / A2A_HEALTH_URL / 私有 export
```

**第 2 步**：把原看门狗脚本换成薄 shim（**一次**）

原脚本（如 `/opt/data/scripts/a2a-watchdog.sh`）整体替换为：

```bash
#!/bin/bash
# 薄 shim —— 调度器仍按原路径/文件名调用；逻辑全部来自仓内通用版
set -u
REPO="/opt/data/csb-a2a-aip"
export A2A_INSTANCE_ENV="$REPO/scripts/watchdog/instance.env"
exec bash "$REPO/scripts/watchdog/a2a-watchdog.sh" "$@"
```

> **为什么要 shim**：调度器（cron / systemd timer / 其他）按**文件名**解析脚本，
> 直接改指向会牵动调度配置；shim 让"调度不变、逻辑入仓"。
> **别用软链**指到仓内文件 —— 在 9p/网络挂载上软链不可靠（本仓实测过）。

**第 3 步**：验证

```bash
# 健康时：应打印 OK 且不重启
A2A_INSTANCE_ENV=<repo>/scripts/watchdog/instance.env bash <repo>/scripts/watchdog/a2a-watchdog.sh
# 故意失败（指向不存在的端口）：应重试 N 次后才判负，日志带 last=<code>
# 连续触发 2 次：server.log 旧内容必须仍在（不归零）
```

## 之后怎么改

改这个脚本 = 改仓 → 六平台镜像 → 实例 `git pull` → 下次调度自动用新版。**重启那一下仍由本机调度触发**。

## 测试

```bash
node tests/watchdog.test.js     # 覆盖：探活重试 / 不截断 / 轮转 / 缺配置 fail-loud / last=<code>
```
