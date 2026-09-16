#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════
 * A2A Bridge · Hermes 注入适配器（C4-H · P0-C）
 * ═══════════════════════════════════════════════════════
 *
 * 通道：**本机 CLI 注入**（与 OpenClaw 侧的 HTTP C1 对称）
 *   A2A server（同机）→ spawn(`hermes -z "<prompt>"`) → 取 stdout
 *   `-z` = 隔离回合：不污染主会话
 *
 * 背景（2026-09-16 调研 + 墨丘实测反馈）：
 *   - Hermes Agent v0.20.0（Nous Research 开源框架）· s6-supervise 托管 · 无入站 HTTP 口
 *   - ⚠️ 硬边界：重启必须在 gateway 进程之外执行（网关内调用会自杀 SIGTERM）
 *
 * 墨丘实测四条（**已并入本文件设计**）：
 *   ① **rc 靠不住**：`-z "读 /no/such/file"` → rc=0、stderr 空，失败信息混进 stdout。
 *      ⇒ 判据三重：`rc==0` + `stdout 非空` + **哨兵串命中**（见 executeCli）
 *   ② **工具能锁（-t file），"身份"锁不干净**（禁了 SOUL/IDENTITY/memory 仍自称墨丘）
 *      ⇒ 已知边界，非本 adapter 可解；写入文档
 *   ③ **shell 层安全，语义层不安全**：payload 不会被二次解释 ✓，但**委托内容即它的指令**
 *      ⇒ 风险是「授权」不是「拼接」；禁词表挡显式危险串，挡不住「帮我清理一下目录」
 *      ⇒ 责任仍在 bridge（L3/UAC）+ 宿主工具白名单；adapter 只做显式危险串兜底
 *   ④ **L3 读回可走 state.db**（FTS5，0.018s；两个坑：容器 TZ=UTC 差 8h；库 468MB 勿全表 COUNT）
 *      ⇒ 实现 path=db（需显式配置 SQL 模板，强制 LIMIT + 超时）
 *   ⑤ **环境清洗**：A2A 进程带 HERMES_S6_SUPERVISED_CHILD=1 等 → spawn 必须白名单清洗，
 *      否则子进程会以为自己是 s6 托管的网关子进程
 *
 * 状态：**默认关、不接线、零行为变化**（接线 = P0-D）
 * 作者: 若兰 🌸 · 2026-09-16
 * ═══════════════════════════════════════════════════════
 */

'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// ===== 超时 =====
// [2026-09-16] 120s 实测不够：首验 106.7s 
//   已贴上限，第二封（稍长）直接超时 → 默认提到 **5 分钟**
//   （与 OpenClaw 侧 A2A_BRIDGE_INJECT_TIMEOUT_MS 默认 5min 对齐）
const DEFAULT_TIMEOUT_MS = parseInt(process.env.A2A_HERMES_TIMEOUT_MS || '', 10) || 5 * 60 * 1000;
const MAX_TIMEOUT_MS = 15 * 60 * 1000;
const DB_TIMEOUT_MS = parseInt(process.env.A2A_HERMES_DB_TIMEOUT_MS || '', 10) || 5000; // 坑②：别让全表查询挂死

// ===== 拒绝检测（与 openclaw-gateway 同一份词表/窗口）=====
const REFUSAL_HEAD_CHARS = 300;
const REFUSAL_PATTERNS = [
  /(?:^|\n)[\s>*#\-]*[⛔❌🚫]/,
  /(?:拒绝|婉拒|不予)(?:执行|受理|接受|处理|承接|响应)/,
  /(?:不能|无法|不会|不便)(?:执行|受理|接受|处理|完成|承接)/,
  /(?:无权|没有权限|不允许|不具备).{0,8}(?:执行|处理|受理|操作)/,
  /(?:超出|超越).{0,6}(?:能力|权限|职责|范围)/,
  /(?:抱歉|对不起|不好意思)[，,、\s].{0,12}(?:不能|无法|不便|不会|拒绝)/,
  /(?:declin|refus)\w*\s*(?:to\s+)?(?:execute|perform|handle|the\s+(?:task|request|delegation))/i,
  /(?:can'?t|cannot|unable\s+to)\s+execute/i,
  /(?:not\s+allowed|unauthorized|out\s+of\s+scope)/i,
];

/**
 * prompt 显式禁词（硬安全约束）
 * 注意（墨丘实测③）：这只能挡**显式危险串**；挡不住语义化的破坏性指令
 *   （如「帮我清理一下这个目录」）。语义层的授权责任在 bridge（L3/UAC）+ 宿主工具白名单。
 */
const FORBIDDEN_IN_PROMPT = [
  { re: /hermes\s+gateway\s+(restart|stop|kill|reload)/i, why: '禁止在注入回合里操作 gateway 生命周期（网关内调用=自杀 SIGTERM）' },
  { re: /\bs6-svc\b|\bs6-supervise\b|\bs6-rc\b|\bs6-rc-init\b/i, why: '禁止触碰 s6 监管层' },
  { re: /\b(pkill|killall)\b|\bkill\s+-9\b|\bkill\s+-TERM\b/i, why: '禁止进程击杀类命令' },
  { re: /\bhermes\s+gateway\s+run\b/i, why: '禁止在注入回合内重启/顶替 gateway 进程' },
];

// ===== spawn 环境白名单（墨丘实测⑤）=====
// 坑：A2A 进程带 HERMES_S6_SUPERVISED_CHILD=1 / S6_* 等 → 直接透传会让子进程
//      误以为自己是 s6 托管的网关子进程。只放行最小必要变量。
// ★ 2026-09-16 安全更正（墨丘实测）：HERMES_WRITE_SAFE_ROOT **必须保留**，
//   它是真正的写入护栏（file_safety.py:148-158：设了才检查，未设=只受凭证黑名单限制）。
//   剥掉它 = 把子进程的写入边界打开。同一条 prompt 对照实测：
//     无此变量 → 文件真被创建；有此变量 → Write denied。
const ENV_ALLOWLIST = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'SHELL', 'PWD',
  'PYTHONUNBUFFERED', 'PYTHONIOENCODING', 'HERMES_HOME',
  'HERMES_WRITE_SAFE_ROOT',   // 写入护栏：保留（可用 A2A_HERMES_WRITE_SAFE_ROOT 收窄）
];
const ENV_DENY_PREFIX = ['HERMES_S6_', 'S6_', 'S6-'];

const ENV_MODE = () => String(process.env.A2A_HERMES_ENV_MODE || 'denylist').trim().toLowerCase();

/**
 * 构造子进程环境
 *
 * ★★ 2026-09-16 策略改向（同一个坑两次了）：
 *   原设计=**白名单**（只放行已知必要变量）→ 已被证伪两次：
 *     ① 剥掉 `HERMES_WRITE_SAFE_ROOT`（写入护栏，K3）
 *     ② 剥掉 `HERMES_LAZY_INSTALL_TARGET`（feishu 依赖懒安装路径）→ send 报平台层失败
 *   根因：**白名单是盲的** —— 它不区分「脏变量」与「必需变量」，未知即破。
 *   ⇒ 默认改为 **黑名单（denylist）**：透传全部 + 只剥**已知危险**（s6 类）；
 *     需要时再叠加显式收窄（WRITE_SAFE_ROOT / ENV_DENY）。
 *   `A2A_HERMES_ENV_MODE=allowlist` 可回到旧行为（给希望最严的宿主）。
 */
function buildChildEnv(cfg) {
  const mode = (cfg && cfg.envMode) || ENV_MODE();
  const denyExtra = (cfg && cfg.envDeny) || [];
  const isDenied = (k) => ENV_DENY_PREFIX.some((p) => k.startsWith(p)) || denyExtra.includes(k);

  let out = {};
  if (mode === 'allowlist') {
    for (const k of ENV_ALLOWLIST) {
      if (process.env[k] !== undefined) out[k] = process.env[k];
    }
  } else {
    // 默认：透传全量，只剥已知危险
    for (const [k, v] of Object.entries(process.env)) {
      if (!isDenied(k)) out[k] = v;
    }
  }
  out.HERMES_HOME = cfg.home;
  // 写入护栏收窄（比「剥掉」与「照抄 /opt/data」都稳）：只允许写一个专用 scratch 目录
  if (cfg.writeSafeRoot) out.HERMES_WRITE_SAFE_ROOT = cfg.writeSafeRoot;
  // 显式附加：A2A_HERMES_ENV_EXTRA="K1=V1,K2=V2"
  const extra = process.env.A2A_HERMES_ENV_EXTRA || '';
  if (extra) {
    for (const kv of extra.split(',')) {
      const i = kv.indexOf('=');
      if (i > 0) {
        const k = kv.slice(0, i).trim();
        if (!ENV_DENY_PREFIX.some((p) => k.startsWith(p))) out[k] = kv.slice(i + 1).trim();
      }
    }
  }
  // 兜底：清掉任何漏网的 s6 变量
  for (const k of Object.keys(out)) {
    if (isDenied(k)) delete out[k];
  }
  return out;
}

// ===== 开关 =====
function isEnabled() {
  return String(process.env.A2A_BRIDGE_HERMES || 'off').trim().toLowerCase() === 'on';
}

// ===== identity.bridge 读取（缓存）=====
let _identityCache;
function identityBridge() {
  if (_identityCache !== undefined) return _identityCache;
  try {
    const p = process.env.A2A_IDENTITY_PATH || path.join(__dirname, '..', 'identity.json');
    if (!fs.existsSync(p)) { _identityCache = {}; return _identityCache; }
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    _identityCache = (j && j.bridge) || {};
  } catch (_) { _identityCache = {}; }
  return _identityCache;
}
function _resetIdentityBridgeCache() { _identityCache = undefined; }

/**
 * 配置解析（优先级：env > identity.json.bridge > 默认）
 */
function resolveConfig(overrides = {}) {
  const idb = identityBridge();
  const cfg = {
    enabled: isEnabled(),
    bin: resolveHermesBin(),
    home: process.env.A2A_HERMES_HOME || '/opt/data',
    // 工具锁：墨丘实测②——`-t file` 能把它锁成无终端（回 NO_TOOL）
    tools: process.env.A2A_HERMES_TOOLS || '',                 // 显式覆盖（例：'file'）
    writeSafeRoot: process.env.A2A_HERMES_WRITE_SAFE_ROOT || '',   // 空=保留父进程原值
    // 环境透传策略（见 buildChildEnv 注释）：denylist（默认，只剥已知危险）| allowlist
    envMode: ENV_MODE(),
    envDeny: (process.env.A2A_HERMES_ENV_DENY || '').split(',').map((s) => s.trim()).filter(Boolean),
    // 确认读回腿：off（默认→路径 C 保守）| db（启用路径 A：直查 state.db）
    // 两个 env 名等效：A2A_HERMES_CONFIRM_READ（adapter 侧）/ A2A_HERMES_CONFIRM_READ_PATH（宿主意愿，墨丘建议）
    confirmRead: String(
      process.env.A2A_HERMES_CONFIRM_READ || process.env.A2A_HERMES_CONFIRM_READ_PATH || 'off'
    ).trim().toLowerCase(),
    // 按 scope 分档的工具集（墨丘实测：`file` 含 read/write/patch/search ≠ 只读）
    //   默认只读档取最保守值；非法名 fail-closed（rc=2）不会静默放宽
    //   ★ 绝对不含：terminal / code_execution / delegation / cronjob / memory（会写 MEMORY.md）
    toolsRead: process.env.A2A_HERMES_TOOLSETS_READ !== undefined
      ? process.env.A2A_HERMES_TOOLSETS_READ
      : 'file,skills',
    toolsWrite: process.env.A2A_HERMES_TOOLSETS_WRITE || '',
    // 安全闸（Q4-4）：safe-mode 默认开；ignore-rules 默认关（开了不隔离身份且放宽规则）
    safeMode: String(process.env.A2A_HERMES_SAFE_MODE || 'on').toLowerCase() !== 'off',
    ignoreRules: String(process.env.A2A_HERMES_IGNORE_RULES || 'off').toLowerCase() === 'on',
    extraArgs: (process.env.A2A_HERMES_EXTRA_ARGS || '').trim().split(/\s+/).filter(Boolean),
    timeoutMs: Math.min(
      parseInt(process.env.A2A_HERMES_TIMEOUT_MS || '', 10) || DEFAULT_TIMEOUT_MS,
      MAX_TIMEOUT_MS
    ),
    // 确认投递（L3 写操作的「发确认请求」腿）—— 默认关
    sendEnabled: String(process.env.A2A_HERMES_SEND || 'off').trim().toLowerCase() === 'on',
    sendArgs: (process.env.A2A_HERMES_SEND_ARGS || '').split(',').map((s) => s.trim()).filter(Boolean),
    mainTo: process.env.A2A_BRIDGE_MAIN_TO || idb.mainTo || '',
    channel: process.env.A2A_BRIDGE_CHANNEL || idb.channel || 'feishu',
    sessionKey: process.env.A2A_BRIDGE_SESSION_KEY || idb.sessionKey || 'main',
    cwd: process.env.A2A_HERMES_CWD || path.join(__dirname, '..'),
    // state.db 读回（path=db）
    dbPath: process.env.A2A_HERMES_DB_PATH || '',
    dbBin: process.env.A2A_HERMES_SQLITE3_BIN || 'sqlite3',          // 仅作 node:sqlite 不可用时的回退
    sessionId: process.env.A2A_HERMES_SESSION_ID || '',              // ⚠️ 会过期（每会话新 id）；优先用 chatId
    chatId: process.env.A2A_HERMES_CHAT_ID || '',                    // ★ 推荐：按 chat_id 自取最新会话（不会过期）
    confirmSql: process.env.A2A_HERMES_CONFIRM_SQL_TEMPLATE || '',   // 空=用内置默认（墨丘实测定稿）
  };
  return { ...cfg, ...overrides };
}

/**
 * 把 delegation 信封翻译成给 Hermes 的任务指令
 * @param {object} opts { sentinel?: string, tools?: string }
 * 墨丘实测①：rc 不可靠 → 必须要求它**回显哨兵串**，adapter 据此判成功
 */
function buildPrompt(envelope, taskId, opts = {}) {
  const d = (envelope && envelope.delegation) || envelope || {};
  const scope = (envelope && envelope.scope) || d.scope || 'read';
  const task = (envelope && envelope.task) || d.task || d.description || d.prompt || '';
  const delegator = (envelope && envelope.delegator) || d.delegator || '未知委托方';
  const lines = [
    `【桥接委托 · Bridge Delegation · Hermes 隔离回合】`,
    `任务ID: ${taskId}`,
    `委托方: ${delegator}`,
    `范围: ${scope}（read/notify=只读告知；write/shell=写操作需你自行判断安全边界）`,
    `任务内容: ${task}`,
    ``,
    `请以你的判断执行该任务。规则：`,
    `1. 你有完整拒绝权——危险/越权/含混的任务直接说明拒绝原因，不要执行；`,
    `2. 执行后请用简洁中文总结：做了什么 + 结果（含关键数据/输出）；`,
    `3. 若任务需要写操作或对外发送，先声明你将做什么再执行；`,
    `4. 本回合为隔离回合，不得操作 gateway 生命周期（重启/停止）或 s6 监管层。`,
  ];
  if (opts.sentinel) {
    lines.push(`5. **最后一行**必须原样输出这个哨兵串（不得改动、不得加前后缀，这是回执是否成功的唯一凭证）：${opts.sentinel}`);
  }
  return lines.join('\n');
}

/** 禁词校验：命中即抛错（宁可拒绝，也不冒宿主自杀风险） */
function assertPromptSafe(prompt) {
  for (const { re, why } of FORBIDDEN_IN_PROMPT) {
    if (re.test(prompt)) throw new Error(`prompt 命中禁词 → 拒绝注入：${why}`);
  }
  return true;
}

function detectRefusal(content) {
  if (!content) return false;
  const head = String(content).slice(0, REFUSAL_HEAD_CHARS);
  return REFUSAL_PATTERNS.some((re) => re.test(head));
}

/** 生成本次调用的哨兵串 */
function makeSentinel(taskId) {
  return `BRIDGE-OK-${String(taskId || 'x').replace(/[^\w-]/g, '').slice(-16)}-${Date.now().toString(36)}`;
}

/**
 * 【能力声明】本 adapter 偏好的确认读回路径
 *   bridge（a2a-bridge-confirm）在未显式指定时会**问适配器**，因此宿主只配 adapter 侧 env 即可
 *   返回 null = 不声明（保持保守路径 C）
 *   —— 修因：openclaw-gateway 的 fetchResult 自带实现、不看 path，这层接口差异
 *      在 OpenClaw 系被完全掩盖，只在 Hermes 系暴露（墨丘 2026-09-16 L3 终验）
 */
function confirmReadPath() {
  return resolveConfig().confirmRead === 'db' ? 'db' : null;
}

/** 从输出里剥掉哨兵行 */
function stripSentinel(text, sentinel) {
  if (!sentinel) return text;
  return String(text).split('\n').filter((l) => !l.includes(sentinel)).join('\n').trim();
}

/**
 * 解析 hermes 可执行文件（墨丘 Q1 实测：`hermes` **不在** shell PATH，
 * 但 A2A server 进程的 PATH 里有 `/opt/hermes/.venv/bin`）
 * ⇒ 优先绝对路径，找不到再回退裸名
 */
const HERMES_BIN_CANDIDATES = [
  '/opt/hermes/.venv/bin/hermes',
  '/opt/hermes/bin/hermes',
  '/usr/local/bin/hermes',
];
function resolveHermesBin() {
  if (process.env.A2A_HERMES_BIN) return process.env.A2A_HERMES_BIN; // 显式优先，不猜
  for (const p of HERMES_BIN_CANDIDATES) {
    try { if (fs.existsSync(p)) return p; } catch (_) { /* ignore */ }
  }
  return 'hermes';
}

/**
 * 按委托范围选工具档（墨丘 Q4-4：`-t/--toolsets` 可锁工具面；「只读档」可做）
 * 优先级：显式 tools 覆盖 > 按 scope 分档 > 空（不传 -t）
 */
function toolsForScope(scope, cfg) {
  if (cfg.tools) return cfg.tools;
  const s = String(scope || '').toLowerCase();
  if (s === 'read' || s === 'notify') return cfg.toolsRead || '';
  if (s === 'write' || s === 'shell') return cfg.toolsWrite || '';
  return '';
}

/**
 * 构造 hermes 参数（顺序：工具锁 → 安全闸 → 额外参数 → -z）
 *   默认 `--safe-mode` 开；`--ignore-rules` **默认关**（墨丘实测：开了仍不隔离身份，且会放宽规则）
 */
function buildArgs({ prompt, tools, cfg }) {
  const args = [];
  if (tools) args.push('-t', tools);
  if (cfg.safeMode) args.push('--safe-mode');
  if (cfg.ignoreRules) args.push('--ignore-rules');
  if (cfg.extraArgs && cfg.extraArgs.length) args.push(...cfg.extraArgs);
  args.push('-z', prompt);
  return args;
}

/** 本地时间 → UTC ISO（墨丘实测④坑①：容器 TZ=UTC，按本地时间过滤会差 8 小时） */
function toUtcIso(d) {
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) throw new Error(`toUtcIso: 无效时间 ${d}`);
  return dt.toISOString(); // 始终 UTC
}

/** 本地时间 → UTC epoch 秒（state.db 的 timestamp 是 REAL epoch；坑①） */
function toEpochSeconds(d) {
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) throw new Error(`toEpochSeconds: 无效时间 ${d}`);
  return Math.floor(dt.getTime() / 1000);
}

// ===== runner（可被测试替换）=====
function defaultRunner({ bin, args, cwd, env, timeoutMs, stdin }) {
  return new Promise((resolve, reject) => {
    let child;
    const wantStdin = typeof stdin === 'string';
    try {
      // shell:false + 参数数组 → 不做 shell 拼接（墨丘实测③：payload 不会被二次解释）
      child = spawn(bin, args, {
        cwd, env, shell: false,
        stdio: [wantStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      return reject(new Error(`spawn 失败: ${e.message}`));
    }
    // 长文本/多行走 stdin（send --file -）：绕开 argv 长度与转义
    if (wantStdin) {
      try { child.stdin.end(String(stdin)); } catch (_) { /* ignore */ }
    }
    let stdout = '', stderr = '', killed = false;
    const timer = setTimeout(() => { killed = true; try { child.kill('SIGKILL'); } catch (_) {} }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`无法执行 ${bin}: ${e.code === 'ENOENT' ? '二进制不存在或不在 PATH' : e.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (killed) return reject(new Error(`注入超时（${timeoutMs}ms）`));
      resolve({ code, stdout, stderr });
    });
  });
}
let _runner = defaultRunner;
function _setRunner(fn) { _runner = fn || defaultRunner; }

// ===== 核心：CLI 注入 =====
async function executeCli(envelope, taskId, opts = {}) {
  const cfg = resolveConfig(opts);
  if (!cfg.enabled) throw new Error('A2A_BRIDGE_HERMES=off —— Hermes 注入未启用（默认关，零行为变化）');

  const sentinel = opts.noSentinel ? null : (opts.sentinel || makeSentinel(taskId));
  const prompt = buildPrompt(envelope, taskId, { sentinel, tools: cfg.tools });
  assertPromptSafe(prompt);

  const scope = (envelope && envelope.scope) || (envelope && envelope.delegation && envelope.delegation.scope) || '';
  const tools = toolsForScope(scope, cfg);
  const args = buildArgs({ prompt, tools, cfg });

  // [2026-09-16] 超时跟随信封声明（与 openclaw-gateway 同逻辑）：
  //   opts 显式 > max(信封声明, 默认) > 默认；封顶 15min（防挂死）
  const envelopeMs = (envelope && Number(envelope.timeoutMs)) || 0;
  const effectiveTimeoutMs = Math.min(
    opts.timeoutMs || Math.max(envelopeMs, cfg.timeoutMs),
    MAX_TIMEOUT_MS
  );

  const runner = opts._runner || _runner;
  const started = Date.now();
  const res = await runner({
    bin: cfg.bin, args, cwd: cfg.cwd, env: buildChildEnv(cfg), timeoutMs: effectiveTimeoutMs,
  });
  const durationMs = Date.now() - started;
  const { code, stdout, stderr } = res || {};

  // ── 三重判据（墨丘实测①：rc 靠不住，失败会混进 stdout 且 rc=0）──
  const out = String(stdout || '').trim();
  if (code !== 0) {
    throw new Error(`hermes -z 非零退出（code=${code}，超时上限 ${effectiveTimeoutMs}ms）${stderr ? ': ' + String(stderr).slice(0, 200) : ''}`);
  }
  if (!out) throw new Error('hermes -z 无输出（stdout 为空）');
  if (sentinel && !out.includes(sentinel)) {
    throw new Error('未命中哨兵串：rc==0 但未见哨兵 —— -z 的 rc 不可靠，失败信息可能被当正常回答塞进 stdout（墨丘实测①）');
  }

  const summary = stripSentinel(out, sentinel);
  return {
    summary,
    artifact: { stdout, stderr, durationMs, via: 'hermes-cli', bin: cfg.bin, sentinel: sentinel || null, tools: tools || null, safeMode: !!cfg.safeMode, timeoutMs: effectiveTimeoutMs },
    refused: detectRefusal(summary),
  };
}

/** 注入（双契约，与 openclaw-gateway 同形） */
async function inject(envelopeOrFrame, taskIdOrOpts, maybeOpts = {}) {
  const isFrame = !!(envelopeOrFrame && envelopeOrFrame.envelope);
  let envelope, taskId, opts;
  if (isFrame) {
    envelope = envelopeOrFrame.envelope;
    taskId = envelopeOrFrame.taskId;
    opts = taskIdOrOpts || {};
  } else {
    envelope = envelopeOrFrame;
    taskId = typeof taskIdOrOpts === 'string' ? taskIdOrOpts : undefined;
    opts = (typeof taskIdOrOpts === 'object' && taskIdOrOpts) ? taskIdOrOpts : maybeOpts;
  }
  if (isFrame) {
    try {
      const r = await executeCli(envelope, taskId, opts);
      return { ok: true, summary: r.summary, artifact: r.artifact, refused: r.refused,
               result: { sent: true, taskId, via: 'hermes-cli', ...r } };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }
  return await executeCli(envelope, taskId, opts); // 失败抛错 → bridge core 走 C5
}

/** 隔离注入：`-z` 本身即隔离；禁词不可绕过 */
async function injectIsolated(envelope, taskId, opts = {}) {
  const r = await executeCli(envelope, taskId, { ...opts, isolated: true });
  return { ok: true, summary: r.summary, artifact: r.artifact, refused: r.refused };
}

/**
 * 确认请求投递（confirmL3 用）—— **P0 未实现**
 * 通道：**本机 CLI**（与注入腿同源，argv 数组、禁 shell 拼接）
 *   `hermes send ...` —— 宿主侧确实存在该命令（agent 可通过 terminal 调用）
 * 默认 **关**（`A2A_HERMES_SEND`）—— 对外发消息是外发动作，按「每级通道单独开关」原则需显式开启。
 * 失败一律诚实返回 ok:false → confirmL3 会记「确认请求发送失败」→ **拒绝执行**（绝不静默放行）。
 */

/**
 * 目标归一化：Hermes 的 `-t/--to` 要 `platform[:chat_id[:thread]]` 形式
 *   若给的是裸 chat_id（如 `oc_xxx`），自动补上 channel 前缀 → `feishu:oc_xxx`
 *   （墨丘校准：裸 id 会被当成“平台名”解析失败）
 */
function normalizeTarget(cfg, to) {
  const t = String(to || '').trim();
  if (!t) return '';
  if (t.includes(':')) return t;                 // 已带平台/线程
  return cfg.channel ? `${cfg.channel}:${t}` : t;
}

/**
 * 构造投递 argv（**按整 token 替换 {to}/{text}**，不做 shell 拼接）
 *
 * ★ 默认模板已按墨丘校准修正（原 `--text` **不存在** ⇒ argparse 会报 rc=2）：
 *   `hermes send --to <target> --file - --json`  + **文本走 stdin**
 *   为什么走 stdin：`send` 的消息体是**位置参数**（nargs='?'），以 `-` 开头的文本会被当 flag；
 *   且确认请求是多行（含摘录）——stdin 绕开 argv 长度与转义问题。
 *   宿主语法不同时用 `A2A_HERMES_SEND_ARGS` 全量改写（如 `send,--to,{to},{text}` 走位置参数）。
 */
function buildSendArgs(cfg, { to, text }) {
  const raw = cfg.sendArgs && cfg.sendArgs.length
    ? cfg.sendArgs
    : ['send', '--to', '{to}', '--file', '-', '--json'];
  const map = { '{to}': String(to), '{text}': String(text) };
  return raw.map((t) => (map[t] !== undefined ? map[t] : t));
}

/** 是否走 stdin（argv 含 `--file -`） */
function usesStdin(args) {
  const i = args.indexOf('--file');
  return i >= 0 && args[i + 1] === '-';
}

/** 退出码语义（send_cmd.py:21-24）：0=投递成功 1=平台层失败 2=用法错 */
function sendExitHint(code) {
  if (code === 2) return '（用法错：参数形态与宿主不匹配，请核对 A2A_HERMES_SEND_ARGS）';
  if (code === 1) return '（平台层失败：目标无效 / 平台未配置）';
  return '';
}

async function invokeTool(url, token, body = {}, timeoutMs) {
  const cfg = resolveConfig();
  if (!cfg.sendEnabled) {
    return { ok: false, error: 'hermes: 确认投递未启用（A2A_HERMES_SEND 默认关）—— L3 写操作暂无法自动确认' };
  }
  const args = (body && body.args) || {};
  const to = args.to || cfg.mainTo;
  const text = args.message || '';
  if (!to) return { ok: false, error: 'hermes: 缺投递目标 to（identity.bridge.mainTo / A2A_BRIDGE_MAIN_TO）' };
  if (!text) return { ok: false, error: 'hermes: 空确认文本，拒绝投递' };

  const target = normalizeTarget(cfg, to);
  const argv = buildSendArgs(cfg, { to: target, text });
  const useStdin = usesStdin(argv);
  const runner = cfg._runner || _runner;
  let res;
  try {
    res = await runner({
      bin: cfg.bin, args: argv, cwd: cfg.cwd, env: buildChildEnv(cfg),
      timeoutMs: timeoutMs || cfg.timeoutMs,
      stdin: useStdin ? String(text) : undefined,
    });
  } catch (e) {
    return { ok: false, error: `hermes send 异常: ${e.message}` };
  }
  if (!res || res.code !== 0) {
    const err = res && res.stderr ? String(res.stderr).slice(0, 200) : '';
    return { ok: false, error: `hermes send 失败（code=${res && res.code}）${sendExitHint(res && res.code)}${err ? ': ' + err : ''}` };
  }
  // ★ rc=0 也有两个坑（墨丘校准）：① `skipped:true`（cron 去重）② human-mode 的 note 路径
  //   → 有 --json 时解析 success/skipped，拿不准一律当失败（宁可重发，不得假成功）
  let parsed = null;
  try { parsed = JSON.parse(String(res.stdout || '').trim()); } catch (_) { /* 非 JSON 模式 */ }
  if (parsed && typeof parsed === 'object') {
    if (parsed.skipped === true) {
      return { ok: false, error: 'hermes send 被跳过（skipped:true，未实际投递）' };
    }
    if (parsed.success === false) {
      return { ok: false, error: `hermes send 报 success:false${parsed.error ? ': ' + String(parsed.error).slice(0, 160) : ''}` };
    }
  }
  return {
    ok: true,
    result: {
      sent: true, to: target, via: 'hermes-cli-send', stdin: useStdin,
      argv: argv.map((a) => (a === String(target) ? '<to>' : a)),
      handle: parsed && parsed.message_id ? String(parsed.message_id) : null,
      stdout: String(res.stdout || '').slice(0, 200),
    },
  };
}

function buildInjectMessage(frame = {}) {
  const taskId = frame.taskId || 'unknown';
  const label = frame.delegatorLabel || '未知委托方';
  return buildPrompt(frame.envelope || {}, taskId).replace('未知委托方', label);
}

// ===== L3 confirm 读回 =====
/**
 * path=db：直查 state.db（墨丘实测④：FTS5 可用，0.018s）
 * 安全护栏：
 *   - SQL 模板必须显式配置（A2A_HERMES_CONFIRM_SQL_TEMPLATE），含 {{TASK_ID}} / {{SINCE}}
 *   - **必须含 LIMIT**（坑②：468MB 库 + gateway 在写，禁全表 COUNT → 曾 300s 超时）
 *   - 查询超时兜底 DB_TIMEOUT_MS
 */
function escapeSql(v) { return String(v == null ? '' : v).replace(/'/g, "''"); }

/**
 * 默认确认查询（墨丘实测定稿，含 EXPLAIN 验证）
 * 占位符：{{SESSION_ID}} / {{SINCE_EPOCH}} / {{TASK_ID}}
 * ★ 注意 SINCE 必须是 **UTC epoch 秒**——timestamp 是 REAL epoch，
 *    若塞 ISO 字符串会因 SQLite 类型序（REAL < TEXT）使条件恒假。
 */
/**
 * [2026-09-16 改口径] 默认模板改用 **{{CHAT_ID}} 子查询**
 *   · 原 {{SESSION_ID}} 口径会过期（每会话新生成，K8）
 *   · 子查询按 chat_id 取最近 5 个会话（`started_at` 有索引；**不用**无索引的 last_activity_at）
 *   · 刻意**不给子查询加时间下界**：确认消息可能落在「早于 SINCE 就开启」的会话里，加了会漏
 *   · 外层仍按 timestamp 裁剩（走 idx_messages_session）
 * 占位符：{{CHAT_ID}}（必需）/ {{SINCE_EPOCH}}（缺省→0，即无下界）/ {{TASK_ID}}
 */
const DEFAULT_CONFIRM_SQL = [
  'SELECT m.id, m.role, m.content, m.timestamp, datetime(m.timestamp,\'unixepoch\') AS ts_utc',
  'FROM messages m',
  'WHERE m.session_id IN (',
  '    SELECT id FROM sessions',
  "    WHERE chat_id = '{{CHAT_ID}}'",
  '    ORDER BY started_at DESC',
  '    LIMIT 5',
  '  )',
  '  AND m.timestamp >= {{SINCE_EPOCH}}',
  "  AND m.role = 'user'",
  "  AND m.content LIKE '%' || '{{TASK_ID}}' || '%'",
  'ORDER BY m.timestamp DESC',
  'LIMIT 5',
].join('\n');

async function readFromStateDb(taskId, cfg, opts = {}) {
  if (!cfg.dbPath) return { ok: false, error: 'hermes: 未配置 A2A_HERMES_DB_PATH（state.db 路径）' };
  const template = cfg.confirmSql || DEFAULT_CONFIRM_SQL;
  if (!/\blimit\b/i.test(template)) {
    return { ok: false, error: 'hermes: SQL 模板必须含 LIMIT（468MB 库禁全表查询，墨丘实测④坑②）' };
  }
  const sessionId = cfg.sessionId || opts.sessionId || '';
  const chatId = cfg.chatId || opts.chatId || '';
  if (/\{\{SESSION_ID\}\}/.test(template) && !sessionId) {
    return { ok: false, error: 'hermes: 需 A2A_HERMES_SESSION_ID（主人会话 id）—— 可用 config/hermes-state-db-queries.sql ② 发现' };
  }
  if (/\{\{CHAT_ID\}\}/.test(template) && !chatId) {
    return { ok: false, error: 'hermes: 需 A2A_HERMES_CHAT_ID（推荐值，不会过期；见 config/hermes-state-db-queries.sql ②）' };
  }
  // ★ 参数名对齐（墨丘 2026-09-16 第三轮）：bridge 传的是 `sinceMs`（毫秒），不是 `since`
  //   两个都收，否则时间下界丢失（落 0 → 恒真 → 不致命但失真）
  const sinceIn = opts.since
    || (typeof opts.sinceMs === 'number' && opts.sinceMs > 0 ? new Date(opts.sinceMs) : null);
  const sinceIso = sinceIn ? `'${escapeSql(toUtcIso(sinceIn))}'` : 'NULL';
  // ★ epoch 缺省用 0（"无下界"）而非 NULL：`timestamp >= NULL` 恒为 NULL ⇒ 条件恒假、一行也回不来
  const sinceEpoch = sinceIn ? String(toEpochSeconds(sinceIn)) : '0';
  const sql = template
    .replace(/\{\{TASK_ID\}\}/g, escapeSql(taskId))
    .replace(/\{\{SESSION_ID\}\}/g, escapeSql(sessionId))
    .replace(/\{\{CHAT_ID\}\}/g, escapeSql(chatId))
    .replace(/\{\{SINCE_EPOCH\}\}/g, sinceEpoch)
    .replace(/\{\{SINCE\}\}/g, sinceIso);

  const runner = opts._dbRunner || _dbRunner;
  const r = await runner({ bin: cfg.dbBin, dbPath: cfg.dbPath, sql, timeoutMs: DB_TIMEOUT_MS });
  if (!r || r.code !== 0) {
    return { ok: false, error: `hermes: state.db 查询失败 ${r && r.stderr ? String(r.stderr).slice(0, 200) : ''}` };
  }
  const raw = String(r.stdout || '');
  const reply = extractReply(raw, taskId);
  const matched = reply.action !== 'none';
  // ★★ 返回结构必须与**参照契约**（openclaw-gateway.fetchResult）对齐（墨丘 2026-09-16 第三轮）：
  //   bridge 的读回循环调 `collectTexts(resp.result)` —— 而 collectTexts 首行是 `if (!result) return []`。
  //   旧的 `{ok, matched, reply, raw}` **没有 result 字段** ⇒ collectTexts(undefined) ⇒ []
  //   ⇒ docn“日志里 path=db 正常、却一条 parsed= 都没有”（致命，静默）。
  return {
    ok: true,
    matched,
    reply,
    raw,
    result: {
      matched,
      replyText: matched ? reply.action : null,
      messages: [{ text: raw }],
      raw,
    },
  };
}

/**
 * 默认 DB runner
 * 优先级：**node:sqlite（Node ≥22.5 内置，无需 sqlite3 CLI）** → 回退 `sqlite3` CLI
 * 背景（墨丘实测）：Hermes 容器里 **没有 sqlite3 CLI**（command not found）
 *   → 只靠 CLI 的写法在那边直接不可用。用 node:sqlite 消除这个外部依赖。
 */
let _nodeSqlite;
function loadNodeSqlite() {
  if (_nodeSqlite !== undefined) return _nodeSqlite;
  try { _nodeSqlite = require('node:sqlite'); } catch (_) { _nodeSqlite = null; }
  return _nodeSqlite;
}

function runWithNodeSqlite(ns, { dbPath, sql }) {
  return new Promise((resolve) => {
    let db;
    try {
      try { db = new ns.DatabaseSync(dbPath, { readOnly: true }); }
      catch (_) { db = new ns.DatabaseSync(dbPath); }     // 老版本无 readOnly 选项
    } catch (e) {
      return resolve({ code: 1, stdout: '', stderr: 'open failed: ' + e.message });
    }
    try {
      db.exec('PRAGMA busy_timeout=8000');   // 库正被 gateway 写：等锁，不硬失
      try { db.exec('PRAGMA query_only=1'); } catch (_) { /* 只读加固，失败不致命 */ }
      const rows = db.prepare(sql).all();
      const out = rows.map((r) => Object.values(r).map((v) => (v == null ? '' : String(v))).join('\t')).join('\n');
      resolve({ code: 0, stdout: out, stderr: '', via: 'node:sqlite' });
    } catch (e) {
      resolve({ code: 1, stdout: '', stderr: String(e.message || e) });
    } finally {
      try { db.close(); } catch (_) { /* ignore */ }
    }
  });
}

/** 默认 DB runner（可被测试替换） */
function defaultDbRunner({ bin, dbPath, sql, timeoutMs }) {
  const ns = loadNodeSqlite();
  if (ns && typeof ns.DatabaseSync === 'function') return runWithNodeSqlite(ns, { dbPath, sql });
  return runWithSqliteCli({ bin, dbPath, sql, timeoutMs });
}

/** CLI 回退（无 node:sqlite 时） */
function runWithSqliteCli({ bin, dbPath, sql, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, ['-readonly', dbPath, sql], { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) { return reject(new Error(`spawn sqlite3 失败: ${e.message}`)); }
    let stdout = '', stderr = '', killed = false;
    const timer = setTimeout(() => { killed = true; try { child.kill('SIGKILL'); } catch (_) {} }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(new Error(`无法执行 sqlite3: ${e.message}`)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (killed) return reject(new Error(`state.db 查询超时（${timeoutMs}ms）`));
      resolve({ code, stdout, stderr });
    });
  });
}
let _dbRunner = defaultDbRunner;
function _setDbRunner(fn) { _dbRunner = fn || defaultDbRunner; }

async function fetchResult(taskId, opts = {}) {
  const cfg = resolveConfig(opts);
  // ★ 读回腿开关：不配 A2A_HERMES_CONFIRM_READ=db 就一律走路径 C（保守）
  //   —— 这正是 2026-09-16 首轮 L3 超时的原因（投递腿 OK，读回腿没开）
  const p = opts.path || (cfg.confirmRead === 'db' ? 'db' : 'C');
  if (p === 'db') {
    try { return await readFromStateDb(taskId, cfg, opts); }
    catch (e) { return { ok: false, error: `hermes: ${e.message}` }; }
  }
  if (p === 'webhook') {
    return { ok: false, error: 'hermes: confirm 读回路径「webhook(8644)」尚未实现（见 HERMES-ADAPTER.md §五）' };
  }
  return {
    ok: false,
    error: 'hermes: confirm 读回默认走路径 C（保守：不自动读回）——写操作按宿主侧原流程人工确认',
    channel: cfg.channel,
  };
}

// ===== 工具函数 =====
function harvestTexts(result, opts = {}) {
  if (!result) return [];
  if (Array.isArray(result)) return result.filter((x) => typeof x === 'string');
  if (typeof result === 'string') return [result];
  if (result.summary) return [String(result.summary)];
  return [];
}

function extractReply(raw, taskId) {
  const s = String(raw || '');
  if (taskId && new RegExp(`确认\\s*#?\\s*${taskId}`).test(s)) return { action: 'approve' };
  if (taskId && new RegExp(`拒绝\\s*#?\\s*${taskId}`).test(s)) return { action: 'decline' };
  if (/^\s*确认\b/.test(s)) return { action: 'approve' };
  if (/^\s*拒绝\b/.test(s)) return { action: 'decline' };
  return { action: 'none' };
}

module.exports = {
  inject, injectIsolated, buildPrompt, buildInjectMessage, detectRefusal, REFUSAL_PATTERNS,
  resolveConfig, fetchResult, extractReply, harvestTexts, invokeTool, buildSendArgs,
  isEnabled, assertPromptSafe, FORBIDDEN_IN_PROMPT, buildChildEnv, ENV_ALLOWLIST, makeSentinel, stripSentinel, toUtcIso,
  toEpochSeconds, resolveHermesBin, toolsForScope, buildArgs, DEFAULT_CONFIRM_SQL,
  normalizeTarget, usesStdin, sendExitHint, confirmReadPath,
  _setRunner, _setDbRunner, _resetIdentityBridgeCache,
  loadNodeSqlite, runWithNodeSqlite,
  _internals: { executeCli, defaultRunner, defaultDbRunner, runWithSqliteCli, readFromStateDb },
};

if (require.main === module) {
  const cfg = resolveConfig();
  console.log('[hermes-adapter] enabled=%s bin=%s home=%s timeout=%dms tools=%s channel=%s',
    cfg.enabled, cfg.bin, cfg.home, cfg.timeoutMs, cfg.tools || '(none)', cfg.channel);
  console.log('（P0 骨架：默认关、不接线。接线= P0-D）');
}
