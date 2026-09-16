#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════
 * A2A Bridge · Hermes 注入适配器（C4-H · P0-C 骨架）
 * ═══════════════════════════════════════════════════════
 *
 * 通道：**本机 CLI 注入**（与 OpenClaw 侧的 HTTP C1 对称）
 *   A2A server（同机）→ spawn(`hermes -z "<prompt>"`) → 取 stdout
 *   `-z` = 隔离回合：**不污染主会话**（宿主自述：Hermes 没有「注入当前思考」的通道）
 *
 * 背景（2026-09-16 调研）：
 *   - Hermes Agent v0.20.0（Nous Research 开源框架）· s6-supervise 托管
 *   - 无入站 HTTP 端口；平台适配器（feishu WS）驱动主会话
 *   - 可用隔离原语：`hermes -z` / cron / delegate_task / webhook(8644, 未启用)
 *   - ⚠️ 硬边界：重启必须在 gateway 进程之外执行（网关内调用会自杀 SIGTERM）
 *   → 详见 docs/hermes-injection-recon-2026-09-16.md · 契约 docs/HERMES-ADAPTER.md
 *
 * 状态：**P0-C 骨架 —— 默认关、不接线、零行为变化**
 *   开关：A2A_BRIDGE_HERMES=off（默认）｜开启后才可能注入
 *   接线（server_v5 装配 + 灰度）= P0-D，需先验证 4 个问号
 *
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

// ===== 拒绝检测（与 openclaw-gateway 完全同一份词表/窗口）=====
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
 * prompt 禁词（硬安全约束）
 * 来源：Hermes 硬边界——在网关内部调用 gateway 管理命令会把自己 SIGTERM。
 * P0 一律拒绝这类 prompt（宁可让宿主侧人工执行，也不冒自杀风险）。
 */
const FORBIDDEN_IN_PROMPT = [
  { re: /hermes\s+gateway\s+(restart|stop|kill|reload)/i, why: '禁止在注入回合里操作 gateway 生命周期（网关内调用=自杀 SIGTERM）' },
  { re: /\bs6-svc\b|\bs6-supervise\b|\bs6-rc\b|\bs6-rc-init\b/i, why: '禁止触碰 s6 监管层' },
  { re: /\b(pkill|killall)\b|\bkill\s+-9\b|\bkill\s+-TERM\b/i, why: '禁止进程击杀类命令' },
  { re: /\bhermes\s+gateway\s+run\b/i, why: '禁止在注入回合内重启/顶替 gateway 进程' },
];

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
 * @returns {{enabled:boolean, bin:string, home:string, timeoutMs:number,
 *            mainTo:string, channel:string, sessionKey:string, cwd:string}}
 */
function resolveConfig(overrides = {}) {
  const idb = identityBridge();
  const cfg = {
    enabled: isEnabled(),
    bin: process.env.A2A_HERMES_BIN || 'hermes',
    home: process.env.A2A_HERMES_HOME || '/opt/data',
    timeoutMs: Math.min(
      parseInt(process.env.A2A_HERMES_TIMEOUT_MS || '', 10) || DEFAULT_TIMEOUT_MS,
      MAX_TIMEOUT_MS
    ),
    mainTo: process.env.A2A_BRIDGE_MAIN_TO || idb.mainTo || '',
    channel: process.env.A2A_BRIDGE_CHANNEL || idb.channel || 'feishu',
    sessionKey: process.env.A2A_BRIDGE_SESSION_KEY || idb.sessionKey || 'main',
    cwd: process.env.A2A_HERMES_CWD || path.join(__dirname, '..'),
  };
  return { ...cfg, ...overrides };
}

/**
 * 把 delegation 信封翻译成给 Hermes 的任务指令（与 openclaw 侧同格式，
 * 额外加一行「隔离回合」标记，便于宿主侧区分桥接回合）
 */
function buildPrompt(envelope, taskId) {
  const d = (envelope && envelope.delegation) || envelope || {};
  const scope = (envelope && envelope.scope) || d.scope || 'read';
  const task = (envelope && envelope.task) || d.task || d.description || d.prompt || '';
  const delegator = (envelope && envelope.delegator) || d.delegator || '未知委托方';
  return [
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
  ].join('\n');
}

/** 禁词校验：命中即抛错（宁可拒绝，也不冒宿主自杀风险） */
function assertPromptSafe(prompt) {
  for (const { re, why } of FORBIDDEN_IN_PROMPT) {
    if (re.test(prompt)) throw new Error(`prompt 命中禁词 → 拒绝注入：${why}`);
  }
  return true;
}

/** 拒绝意图检测（只扫开头窗口，避免长报告里的统计数字误判） */
function detectRefusal(content) {
  if (!content) return false;
  const head = String(content).slice(0, REFUSAL_HEAD_CHARS);
  return REFUSAL_PATTERNS.some((re) => re.test(head));
}

// ===== 默认 runner（可被测试替换）=====
function defaultRunner({ bin, args, cwd, env, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      // 关键：shell:false + 参数数组 → 不做 shell 拼接（payload 里的 ; && $(...) 不会被执行）
      child = spawn(bin, args, { cwd, env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return reject(new Error(`spawn 失败: ${e.message}`));
    }
    let stdout = '';
    let stderr = '';
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      try { child.kill('SIGKILL'); } catch (_) { /* ignore */ }
    }, timeoutMs);
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
  if (!cfg.enabled) {
    throw new Error('A2A_BRIDGE_HERMES=off —— Hermes 注入未启用（默认关，零行为变化）');
  }
  const prompt = buildPrompt(envelope, taskId);
  assertPromptSafe(prompt);

  const runner = opts._runner || _runner;
  const started = Date.now();
  const res = await runner({
    bin: cfg.bin,
    args: ['-z', prompt],
    cwd: cfg.cwd,
    env: { ...process.env, HERMES_HOME: cfg.home },
    timeoutMs: cfg.timeoutMs,
  });
  const durationMs = Date.now() - started;
  const { code, stdout, stderr } = res || {};

  if (code !== 0) {
    throw new Error(`hermes -z 非零退出（code=${code}）${stderr ? ': ' + String(stderr).slice(0, 200) : ''}`);
  }
  const summary = String(stdout || '').trim();
  if (!summary) throw new Error('hermes -z 无输出（stdout 为空）');

  return {
    summary,
    artifact: { stdout, stderr, durationMs, via: 'hermes-cli', bin: cfg.bin },
    refused: detectRefusal(summary),
  };
}

/**
 * 注入（双契约，与 openclaw-gateway 完全同形）
 *   A. inject(envelope, taskId, opts)              → {summary, artifact?, refused?}；失败抛错
 *   B. inject({taskId, delegatorLabel, envelope}, opts) → {ok:true,result} | {ok:false,error}；不抛
 */
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
      return {
        ok: true,
        summary: r.summary,
        artifact: r.artifact,
        refused: r.refused,
        result: { sent: true, taskId, via: 'hermes-cli', ...r },
      };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }
  return await executeCli(envelope, taskId, opts); // 失败抛错 → bridge core 走 C5
}

/**
 * 隔离注入：Hermes 的 `-z` 本身就是隔离回合，故与 executeCli 同路径；
 * 额外强制「禁词校验」（不允许通过 isolated 绕过）。
 */
async function injectIsolated(envelope, taskId, opts = {}) {
  const r = await executeCli(envelope, taskId, { ...opts, isolated: true });
  return { ok: true, summary: r.summary, artifact: r.artifact, refused: r.refused };
}

/** 构造注入消息（frame 形式，对齐 openclaw 侧签名） */
function buildInjectMessage(frame = {}) {
  const taskId = frame.taskId || 'unknown';
  const label = frame.delegatorLabel || '未知委托方';
  return buildPrompt(frame.envelope || {}, taskId).replace('未知委托方', label);
}

// ===== L3 confirm 读回（P0 默认走「路径 C：保守不自动读」）=====
/**
 * P0 明确不做自动读回：写操作仍由宿主侧原流程确认。
 * 候选（P0-D 验证后再实现）：
 *   A. 直查 state.db（SQLite+FTS5）匹配 `确认 #<taskId>`
 *   B. 启用 webhook 平台（8644）接收主人回复
 */
async function fetchResult(taskId, opts = {}) {
  const cfg = resolveConfig(opts);
  if (opts.path === 'db' || opts.path === 'webhook') {
    return { ok: false, error: `hermes: confirm 读回路径「${opts.path}」尚未实现（P0 仅定义；见 HERMES-ADAPTER.md §五）` };
  }
  return {
    ok: false,
    error: 'hermes: confirm 读回默认走路径 C（保守：不自动读回）——写操作按宿主侧原流程人工确认',
    channel: cfg.channel,
  };
}

/** 从回读结果抽取文本（对齐 openclaw 侧签名；P0 先做保守实现） */
function harvestTexts(result, opts = {}) {
  if (!result) return [];
  if (Array.isArray(result)) return result.filter((x) => typeof x === 'string');
  if (typeof result === 'string') return [result];
  if (result.summary) return [String(result.summary)];
  return [];
}

/** 匹配「确认 #<taskId>」/「拒绝 #<taskId>」 */
function extractReply(raw, taskId) {
  const s = String(raw || '');
  if (taskId && new RegExp(`确认\\s*#?\\s*${taskId}`).test(s)) return { action: 'approve' };
  if (taskId && new RegExp(`拒绝\\s*#?\\s*${taskId}`).test(s)) return { action: 'decline' };
  if (/^\s*确认\b/.test(s)) return { action: 'approve' };
  if (/^\s*拒绝\b/.test(s)) return { action: 'decline' };
  return { action: 'none' };
}

module.exports = {
  // 主接口（与 openclaw-gateway 同形）
  inject,
  injectIsolated,
  buildPrompt,
  buildInjectMessage,
  detectRefusal,
  REFUSAL_PATTERNS,
  resolveConfig,
  fetchResult,
  extractReply,
  harvestTexts,
  // 安全/开关
  isEnabled,
  assertPromptSafe,
  FORBIDDEN_IN_PROMPT,
  // 测试钩子
  _setRunner,
  _resetIdentityBridgeCache,
  _internals: { executeCli, defaultRunner },
};

if (require.main === module) {
  const cfg = resolveConfig();
  console.log('[hermes-adapter] enabled=%s bin=%s home=%s timeout=%dms channel=%s',
    cfg.enabled, cfg.bin, cfg.home, cfg.timeoutMs, cfg.channel);
  console.log('（P0 骨架：默认关、不接线。接线= P0-D）');
}
