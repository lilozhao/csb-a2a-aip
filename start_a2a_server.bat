@echo off
set NODE_PATH=C:\Users\Administrator\.workbuddy\binaries\node\workspace\node_modules
set A2A_SECURITY_HANDSHAKE_AID=C:\Users\Administrator\WorkBuddy\Roundtable\csb-security\data\ruochen-aid.json
set A2A_SECURITY_HANDSHAKE_KEY=C:\Users\Administrator\WorkBuddy\Roundtable\csb-security\data\ruochen-private-key.pem
set A2A_SECURITY_HANDSHAKE_USER_PUBKEY=C:\Users\Administrator\WorkBuddy\Roundtable\csb-security\keys\user-yilan.pubkey.json
REM 2026-09-18 若辰升级：代码家迁至 csb-a2a-aip（gitee 最新 + delegation-handler.js 委托集成）
REM 2026-09-18 全家桶归 Roundtable：csb-security / 备份 / 本 bat / watchdog 均已收拢
REM 2026-09-18 A2A 数据也归 Roundtable（记忆连续性：a2a-memory.js 解析 %A2A_DATA_DIR%\memory\a2a-memories）
set A2A_DATA_DIR=C:\Users\Administrator\WorkBuddy\Roundtable\a2a-data
REM 2026-09-18 桥接层（若兰操作单 v1 · Step 2）：WorkBuddy 宿主执行适配器
REM   注入适配器 = workbuddy-local（沙箱写入 + 白名单 + L3 人工确认；不执行任意 shell）
REM   L3 确认凭证 A2A_BRIDGE_CONFIRM_TOKEN —— 不入库（安全红线）。从 .env（gitignored，已含该键）或部署环境注入；
REM     不用 for/f+findstr 提取：复合行对 CRLF/LF 行尾敏感，易在真实 cmd 下静默失效导致 token 进不了进程环境。
REM     .env 加载见下方 ~30 行会补充该变量；若仍缺失则 fetchResult 报"未配置凭证"（fail-closed，安全）。
if not defined A2A_BRIDGE_CONFIRM_TOKEN (
  echo [warn] A2A_BRIDGE_CONFIRM_TOKEN 未设置，L3 确认读回将失效；请从 .env 或环境注入
)
set A2A_BRIDGE_ENABLED=true
set A2A_BRIDGE_WRITE_SAFE_ROOT=C:\Users\Administrator\WorkBuddy\Roundtable\a2a-data\bridge-scratch
set A2A_BRIDGE_CONFIRM_DIR=C:\Users\Administrator\WorkBuddy\Roundtable\a2a-data\bridge-confirms
set A2A_HERMES_WRITE_SAFE_ROOT=C:\Users\Administrator\WorkBuddy\Roundtable\a2a-data\bridge-scratch
set A2A_BRIDGE_MAIN_TO=host-user
set A2A_BRIDGE_SESSION_KEY=agent:ruochen:main
REM 免确认（UAC）钩子装配（A2A 信任配置补全 2026-09-18）：policy enabled=true 但 若兰 uacScopes=[] → write/shell 仍恒走 L3（人必须点头）
set A2A_BRIDGE_UAC=on
REM 2026-09-18 若辰：L3 确认窗口上探 30min（env 覆盖默认 15min）。
REM   跨宿主写必 L3，但审批是人（碳基）在回路、跨 agent/自动化边界有延迟；
REM   此前默认 5min 把若兰声明的 10min 截到 5min → "窗口已关才收到批准"误记超时。
REM   30min >= 若兰声明 10min → 其声明窗口解封；人审批怎么慢都不超时（仍 fail-closed：到点无批准=拒绝）。
set A2A_BRIDGE_CONFIRM_TIMEOUT_MS=1800000
cd /d C:\Users\Administrator\WorkBuddy\Roundtable\csb-a2a-aip
REM 2026-09-09 load .env (LLM API key etc, gitignored)
if exist .env (
  for /f "usebackq tokens=1,* delims==" %%a in (".env") do (
    echo %%a | findstr /b /c:"#" >nul || set "%%a=%%b"
  )
)
"C:\Users\Administrator\.workbuddy\binaries\node\versions\22.22.2-2\node.exe" server_v5.js
