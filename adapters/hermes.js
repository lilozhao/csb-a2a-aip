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
const DEFAULT_TIMEOUT_MS = parseInt(process.env.A2A_HERMES_TIMEOUT_MS || '', 10) || 120 * 1000;
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
const ENV_ALLOWLIST = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'SHELL', 'PWD',
  'PYTHONUNBUFFERED', 'PYTHONIOENCODING', 'HERMES_HOME',
];
const ENV_DENY_PREFIX = ['HERMES_S6_', 'S6_', 'S6-'];

/** 构造干净的子进程环境（白名单 + 显式附加），绝不透传 s6/网关类变量 */
function buildChildEnv(cfg) {
  const out = {};
  for (const k of ENV_ALLOWLIST) {
    if (process.env[k] !== undefined) out[k] = process.env[k];
  }
  out.HERMES_HOME = cfg.home;
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
    if (ENV_DENY_PREFIX.some((p) => k.startsWith(p))) delete out[k];
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
    // 按 scope 分档的工具集（Q4-4：只读档可做）——需按宿主工具集清单填
    toolsRead: process.env.A2A_HERMES_TOOLSETS_READ || '',
    toolsWrite: process.env.A2A_HERMES_TOOLSETS_WRITE || '',
    // 安全闸（Q4-4）：safe-mode 默认开；ignore-rules 默认关（开了不隔离身份且放宽规则）
    safeMode: String(process.env.A2A_HERMES_SAFE_MODE || 'on').toLowerCase() !== 'off',
    ignoreRules: String(process.env.A2A_HERMES_IGNORE_RULES || 'off').toLowerCase() === 'on',
    extraArgs: (process.env.A2A_HERMES_EXTRA_ARGS || '').trim().split(/\s+/).filter(Boolean),
    timeoutMs: Math.min(
      parseInt(process.env.A2A_HERMES_TIMEOUT_MS || '', 10) || DEFAULT_TIMEOUT_MS,
      MAX_TIMEOUT_MS
    ),
    mainTo: process.env.A2A_BRIDGE_MAIN_TO || idb.mainTo || '',
    channel: process.env.A2A_BRIDGE_CHANNEL || idb.channel || 'feishu',
    sessionKey: process.env.A2A_BRIDGE_SESSION_KEY || idb.sessionKey || 'main',
    cwd: process.env.A2A_HERMES_CWD || path.join(__dirname, '..'),
    // state.db 读回（path=db）
    dbPath: process.env.A2A_HERMES_DB_PATH || '',
    dbBin: process.env.A2A_HERMES_SQLITE3_BIN || 'sqlite3',
    confirmSql: process.env.A2A_HERMES_CONFIRM_SQL_TEMPLATE || '',
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

// ===== runner（可被测试替换）=====
function defaultRunner({ bin, args, cwd, env, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      // shell:false + 参数数组 → 不做 shell 拼接（墨丘实测③：payload 不会被二次解释）
      child = spawn(bin, args, { cwd, env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return reject(new Error(`spawn 失败: ${e.message}`));
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

  const runner = opts._runner || _runner;
  const started = Date.now();
  const res = await runner({
    bin: cfg.bin, args, cwd: cfg.cwd, env: buildChildEnv(cfg), timeoutMs: cfg.timeoutMs,
  });
  const durationMs = Date.now() - started;
  const { code, stdout, stderr } = res || {};

  // ── 三重判据（墨丘实测①：rc 靠不住，失败会混进 stdout 且 rc=0）──
  const out = String(stdout || '').trim();
  if (code !== 0) {
    throw new Error(`hermes -z 非零退出（code=${code}）${stderr ? ': ' + String(stderr).slice(0, 200) : ''}`);
  }
  if (!out) throw new Error('hermes -z 无输出（stdout 为空）');
  if (sentinel && !out.includes(sentinel)) {
    throw new Error('未命中哨兵串：rc==0 但未见哨兵 —— -z 的 rc 不可靠，失败信息可能被当正常回答塞进 stdout（墨丘实测①）');
  }

  const summary = stripSentinel(out, sentinel);
  return {
    summary,
    artifact: { stdout, stderr, durationMs, via: 'hermes-cli', bin: cfg.bin, sentinel: sentinel || null, tools: tools || null, safeMode: !!cfg.safeMode },
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

async function readFromStateDb(taskId, cfg, opts = {}) {
  if (!cfg.dbPath) return { ok: false, error: 'hermes: 未配置 A2A_HERMES_DB_PATH（state.db 路径）' };
  if (!cfg.confirmSql) {
    return { ok: false, error: 'hermes: 未配置 A2A_HERMES_CONFIRM_SQL_TEMPLATE —— 需按 state.db schema 填（可含 {{TASK_ID}} / {{SINCE}}）' };
  }
  if (!/\blimit\b/i.test(cfg.confirmSql)) {
    return { ok: false, error: 'hermes: SQL 模板必须含 LIMIT（468MB 库禁全表查询，墨丘实测④坑②）' };
  }
  const since = opts.since ? `'${escapeSql(toUtcIso(opts.since))}'` : 'NULL';
  const sql = cfg.confirmSql
    .replace(/\{\{TASK_ID\}\}/g, escapeSql(taskId))
    .replace(/\{\{SINCE\}\}/g, since);

  const runner = opts._dbRunner || _dbRunner;
  const r = await runner({ bin: cfg.dbBin, dbPath: cfg.dbPath, sql, timeoutMs: DB_TIMEOUT_MS });
  if (!r || r.code !== 0) {
    return { ok: false, error: `hermes: state.db 查询失败 ${r && r.stderr ? String(r.stderr).slice(0, 200) : ''}` };
  }
  const raw = String(r.stdout || '');
  const reply = extractReply(raw, taskId);
  return { ok: true, matched: reply.action !== 'none', reply, raw };
}

/** 默认 sqlite3 runner（可被测试替换） */
function defaultDbRunner({ bin, dbPath, sql, timeoutMs }) {
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
  const p = opts.path || 'C';
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
  resolveConfig, fetchResult, extractReply, harvestTexts,
  isEnabled, assertPromptSafe, FORBIDDEN_IN_PROMPT, buildChildEnv, makeSentinel, stripSentinel, toUtcIso,
  resolveHermesBin, toolsForScope, buildArgs,
  _setRunner, _setDbRunner, _resetIdentityBridgeCache,
  _internals: { executeCli, defaultRunner, defaultDbRunner, readFromStateDb },
};

if (require.main === module) {
  const cfg = resolveConfig();
  console.log('[hermes-adapter] enabled=%s bin=%s home=%s timeout=%dms tools=%s channel=%s',
    cfg.enabled, cfg.bin, cfg.home, cfg.timeoutMs, cfg.tools || '(none)', cfg.channel);
  console.log('（P0 骨架：默认关、不接线。接线= P0-D）');
}
