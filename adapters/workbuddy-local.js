#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════
 * A2A Bridge · WorkBuddy 宿主注入/执行适配器
 * ═══════════════════════════════════════════════════════
 *
 * 缘起（2026-09-18 · 若兰操作单 v1 · Step 2）：
 *   WorkBuddy 平台**没有 OpenClaw / Hermes 网关**（无主 agent 注入通道），
 *   而 `adapters/openclaw-gateway.js` 的 isolated 路径是 POSIX 专用的
 *   （`execFile('/bin/sh')` + `/tmp/` 白名单）→ 在 Windows 宿主上必然失败。
 *
 * 本适配器只做两件事，其余一律诚实拒绝（fail-closed）：
 *   ① 沙箱写入：确定性 file.write（含 `echo "<字面量>" > <白名单路径>` 形态），
 *      路径必须落在 WRITE_SAFE_ROOT 内，nonce 读回校验，回执带 path/bytes/sha256。
 *   ② L3 确认投递：确认请求落盘 pending 记录 + 日志（宿主机=主会话实时确认），
 *      批准/拒绝由主会话写回 decision，`fetchResult` 读回（契约 3.1 形状）。
 *
 * 设计红线（与桥接层一致）：
 *   - **不执行任意 shell**：白名单外的命令一律 refused，不静默降级执行。
 *   - L3 超时=拒绝（本适配器不做任何"先执行再补确认"）。
 *   - 免确认（UAC）保持关闭：write/shell 必须人点头。
 *
 * 环境变量：
 *   A2A_BRIDGE_WRITE_SAFE_ROOT   沙箱根（默认 <repo>/data/bridge-scratch）
 *   A2A_BRIDGE_CONFIRM_DIR       确认记录目录（默认 <repo>/data/bridge-confirms）
 *   A2A_BRIDGE_SESSION_KEY       主会话键（确认读回留档用）
 *   A2A_BRIDGE_MAIN_TO           主会话目标标签（确认投递地址）
 *
 * 作者: 若辰 ✨ · 2026-09-18 · 遵循 adapters/CONTRACT.md v1
 * ═══════════════════════════════════════════════════════
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const HERE = __dirname;
const REPO = path.join(HERE, '..');

/** 沙箱根（写入唯一落点） */
function writeSafeRoot() {
  const raw = process.env.A2A_BRIDGE_WRITE_SAFE_ROOT
    || process.env.A2A_HERMES_WRITE_SAFE_ROOT
    || path.join(REPO, 'data', 'bridge-scratch');
  return path.resolve(raw);
}

/** 确认记录目录（pending / decision 文件） */
function confirmDir() {
  const raw = process.env.A2A_BRIDGE_CONFIRM_DIR || path.join(REPO, 'data', 'bridge-confirms');
  return path.resolve(raw);
}

function ensureDir(p) {
  try { fs.mkdirSync(p, { recursive: true }); } catch (_) { /* 已存在 */ }
}

/* ───────────────────────── 路径围栏 ───────────────────────── */

/**
 * 把候选路径解析到沙箱内，越界一律抛错（不返回可执行路径）
 * 覆盖：绝对路径越界 / `..` 穿越 / 盘符切换 / 符号链接落到界外
 */
function resolveInside(root, candidate) {
  const raw = String(candidate || '').trim();
  if (!raw) throw new Error('路径为空');
  if (/[\u0000]/.test(raw)) throw new Error('路径含非法字符');

  const abs = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(root, raw);
  const rel = path.relative(root, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`路径越界（沙箱外）: ${raw}`);
  }

  // 符号链接防护：若目标已存在，取真实路径再校验一次
  try {
    const real = fs.realpathSync(abs);
    const relReal = path.relative(fs.realpathSync(root), real);
    if (relReal.startsWith('..') || path.isAbsolute(relReal)) {
      throw new Error(`符号链接指向沙箱外: ${raw}`);
    }
  } catch (e) {
    if (/符号链接/.test(e.message)) throw e;
    /* 文件尚不存在 → 正常 */
  }
  return abs;
}

/* ───────────────────────── 命令白名单 ───────────────────────── */

/**
 * 唯一允许的命令形态：echo "<字面量>" > <沙箱内路径>
 * 与 openclaw 适配器同形（若兰 L3 测试用例），但不落 /tmp，只落沙箱。
 */
const ECHO_REDIRECT_RE = /^echo\s+"([^"$`;&|<>(){}]*)"\s*>\s*("[^"$`;&|<>(){}]+"|'[^'$`;&|<>(){}]+'|[^\s"$`;&|<>(){}]+)\s*$/;
const DANGER_RE = /\b(rm|del|format|shutdown|reg|net|sc|powershell|cmd|curl|wget|sudo|chmod|chown|rmdir|rd)\b/i;

/* ───────────────────────── 确定性写入 ───────────────────────── */

/**
 * 执行沙箱写入，返回回执（path/bytes/sha256）
 * @param {string} relOrAbs 目标路径（可相对沙箱根）
 * @param {string} content  写入内容（字面量）
 * @param {object} opts     { append?:boolean, expectedNonce?:string }
 */
function sandboxWrite(relOrAbs, content, opts = {}) {
  const root = writeSafeRoot();
  ensureDir(root);
  const abs = resolveInside(root, relOrAbs);

  ensureDir(path.dirname(abs));
  const body = String(content == null ? '' : content);
  if (opts.append) fs.appendFileSync(abs, body, 'utf8');
  else fs.writeFileSync(abs, body, 'utf8');

  const buf = fs.readFileSync(abs);
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');

  // nonce 读回校验：内容（trim）必须与委托声明的 nonce 一致
  let sideEffect = 'written';
  if (opts.expectedNonce != null && String(opts.expectedNonce).length > 0) {
    const got = buf.toString('utf8').trim();
    const want = String(opts.expectedNonce).trim();
    sideEffect = (got === want) ? 'matched' : 'mismatch';
    if (sideEffect === 'mismatch') {
      return {
        ok: false,
        error: `nonce 读回不一致（写入内容 ${got} != 声明 ${want}）`,
        artifact: { path: abs, bytes: buf.length, sha256, sideEffect },
      };
    }
  }

  return {
    ok: true,
    artifact: { path: abs, bytes: buf.length, sha256, sideEffect },
    summary: `沙箱写入成功：${path.relative(root, abs)} · ${buf.length} 字节 · sha256=${sha256.slice(0, 16)}…`,
  };
}

/* ───────────────────────── 注入（isolated / 常规） ───────────────────────── */

/**
 * isolated：确定性执行（无 LLM、无主会话）
 */
async function injectIsolated(envelope, taskId, opts = {}) {
  const t0 = Date.now();
  const env = envelope || {};
  const cmd = String(env.command || env.target || env.task || '').trim();
  const expectedMarker = env.expectedMarker || null;
  const expectedNonce = env.nonce || env.expectedNonce || null;

  // 形态 A：结构化 file.write
  if (env.op === 'file.write' || env.action === 'file.write') {
    const p = env.path || expectedMarker;
    try {
      const r = sandboxWrite(p, env.content != null ? env.content : expectedNonce || '', {
        append: env.append === true,
        expectedNonce,
      });
      if (!r.ok) return { ok: false, error: r.error, durationMs: Date.now() - t0, artifact: r.artifact };
      return { ok: true, summary: r.summary, artifact: { ...r.artifact, durationMs: Date.now() - t0 } };
    } catch (e) {
      return { ok: false, error: `沙箱写入失败: ${e.message}`, refused: /越界|非法/.test(e.message), durationMs: Date.now() - t0 };
    }
  }

  // 形态 B：echo "<字面量>" > <沙箱内路径>
  const m = cmd.match(ECHO_REDIRECT_RE);
  if (m) {
    let p = m[2];
    if ((p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'"))) p = p.slice(1, -1);
    // 兼容对端习惯路径：/tmp/xxx 或 /home/node/.openclaw/workspace/xxx → 映射进沙箱同名文件
    const mapped = /^(\/tmp|\/home\/node\/\.openclaw\/workspace)\//.test(p)
      ? path.basename(p)
      : p;
    try {
      const r = sandboxWrite(mapped, m[1] + '\n', { expectedNonce });
      if (!r.ok) return { ok: false, error: r.error, durationMs: Date.now() - t0, artifact: r.artifact };
      return { ok: true, summary: r.summary, artifact: { ...r.artifact, durationMs: Date.now() - t0 } };
    } catch (e) {
      return { ok: false, error: `沙箱写入失败: ${e.message}`, refused: /越界|非法/.test(e.message), durationMs: Date.now() - t0 };
    }
  }

  // 其余一律拒绝（白名单之外不猜、不通融）
  const danger = DANGER_RE.test(cmd);
  return {
    ok: false,
    refused: true,
    error: `WorkBuddy 沙箱拒绝：命令不在白名单（仅支持 file.write 与 echo "<字面量>" > <沙箱路径>）${danger ? '；含高危关键字' : ''}`,
    durationMs: Date.now() - t0,
  };
}

/**
 * 常规注入：WorkBuddy 无主 agent 网关 → 诚实降级（不假装成功）
 */
async function inject(envelopeOrFrame, taskIdOrOpts, maybeOpts = {}) {
  const isFrame = envelopeOrFrame && envelopeOrFrame.envelope && (envelopeOrFrame.taskId || taskIdOrOpts === undefined);
  const envelope = isFrame ? envelopeOrFrame.envelope : envelopeOrFrame;
  const taskId = isFrame ? envelopeOrFrame.taskId : taskIdOrOpts;
  const opts = isFrame ? (taskIdOrOpts || {}) : maybeOpts;

  if (env_isolated(envelope, opts)) {
    const r = await injectIsolated(envelope, taskId, opts);
    if (isFrame) return r;                                   // frame 形式：不抛
    if (!r.ok) { const e = new Error(r.error); e.refused = r.refused; throw e; }
    return { summary: r.summary, artifact: r.artifact };
  }

  const msg = 'WorkBuddy 宿主无主 agent 注入通道（无 gateway）：仅支持 isolated 沙箱确定性执行；'
    + '如需主会话能力，请走 L3 人工确认后在主会话执行。';
  if (isFrame) return { ok: false, error: msg, refused: true };
  const e = new Error(msg); e.refused = true; throw e;
}

function env_isolated(envelope, opts) {
  return Boolean((envelope && envelope.isolated === true) || (opts && opts.isolated === true));
}

/* ───────────────────────── L3 确认投递与读回 ───────────────────────── */

function confirmRecordPath(taskId) {
  const dir = confirmDir();
  ensureDir(dir);
  return path.join(dir, `${String(taskId).replace(/[^\w.-]/g, '_')}.json`);
}

function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; }
}

/** 写 pending 确认请求（主会话可见） */
function deliverConfirmRequest(req) {
  const p = confirmRecordPath(req.taskId);
  const rec = {
    taskId: req.taskId,
    scope: req.scope,
    delegator: req.delegator,
    summary: req.summary,
    deadlineAt: req.deadlineAt,
    requestedAt: req.at || new Date().toISOString(),
    decision: 'pending',
    by: null,
  };
  fs.writeFileSync(p, JSON.stringify(rec, null, 2), 'utf8');
  try {
    const logDir = path.join(REPO, 'logs');
    ensureDir(logDir);
    fs.appendFileSync(path.join(logDir, 'bridge-confirm.log'),
      `[${new Date().toISOString()}] PENDING ${req.taskId} scope=${req.scope} from=${req.delegator} :: ${String(req.summary).slice(0, 160)}\n`, 'utf8');
  } catch (_) { /* 日志可选 */ }
  return p;
}

/**
 * 主会话批准/拒绝入口（供 CLI 或主会话调用）
 * @param {string} taskId
 * @param {'approve'|'decline'} decision
 * @param {string} by 确认人（如「知音在野」）
 */
function resolveConfirm(taskId, decision, by = '宿主用户') {
  const p = confirmRecordPath(taskId);
  const rec = readJsonSafe(p) || { taskId, decision: 'pending' };
  rec.decision = decision === 'approve' ? 'approve' : 'decline';
  rec.by = by;
  rec.decidedAt = new Date().toISOString();
  fs.writeFileSync(p, JSON.stringify(rec, null, 2), 'utf8');
  return rec;
}

/** confirm 模块的 sendConfirmRequest / invokeTool(message.send) 落点 */
async function invokeTool(url, token, { tool, action, args } = {}) {
  if (tool === 'message' && action === 'send') {
    const taskId = args?.taskId || (String(args?.message || '').match(/确认\s*#([\w:-]+)/) || [])[1];
    if (!taskId) return { ok: false, error: '确认请求缺少 taskId' };
    deliverConfirmRequest({
      taskId,
      scope: args?.scope || 'unknown',
      delegator: args?.to || 'unknown',
      summary: args?.message || '',
      deadlineAt: args?.deadlineAt || null,
      at: new Date().toISOString(),
    });
    return { ok: true, delivered: 'workbuddy-host-file', path: confirmRecordPath(taskId) };
  }
  return { ok: false, error: `WorkBuddy 适配器不支持工具 ${tool}/${action}` };
}

/**
 * L3 确认读回（契约 3.1：必须含 result.{matched,replyText,messages}）
 *
 * 凭证语义（与门禁一致）：未配置 A2A_BRIDGE_CONFIRM_TOKEN = 读回通道未就绪
 *   → 返回 {ok:false,error}，**不得**静默返回"无匹配"（那会被误读成"用户没回"）。
 * sinceMs：毫秒时间下界（bridge 传的就是它）——早于下界的决策视为过期，不匹配。
 */
async function fetchResult(taskId, opts = {}) {
  const token = process.env.A2A_BRIDGE_CONFIRM_TOKEN || '';
  if (!token) {
    return { ok: false, error: '未配置确认读回凭证（A2A_BRIDGE_CONFIRM_TOKEN），WorkBuddy 确认通道未就绪' };
  }

  const sinceMs = Number(opts.sinceMs || opts.since || 0) || 0;
  const p = confirmRecordPath(taskId);
  const rec = readJsonSafe(p);
  if (!rec) {
    return { ok: true, matched: false, result: { matched: false, replyText: null, messages: [] }, raw: null };
  }

  const decidedMs = rec.decidedAt ? Date.parse(rec.decidedAt) : 0;
  if (sinceMs > 0 && decidedMs > 0 && decidedMs < sinceMs) {
    return {
      ok: true, matched: false, sinceMs,
      result: { matched: false, replyText: null, messages: [] },
      raw: rec,
    };
  }

  if (rec.decision === 'approve' || rec.decision === 'decline') {
    // 文案与 a2a-bridge-confirm.parseConfirmReply 对齐：拒绝文案**不得含"确认"**
    //   （旧解析器先判"确认"→「确认 #id 拒绝」会被误判为批准；本适配器双保险）
    const replyText = rec.decision === 'approve'
      ? `确认 #${taskId} 批准（by ${rec.by}）`
      : `拒绝 #${taskId}（by ${rec.by}）`;
    return {
      ok: true,
      matched: true,
      result: { matched: true, replyText, messages: [{ text: replyText }] },
      reply: replyText,
      raw: rec,
    };
  }
  return { ok: true, matched: false, sinceMs, result: { matched: false, replyText: null, messages: [] }, raw: rec };
}

/* ───────────────────────── 契约方法（纯函数） ───────────────────────── */

function resolveConfig() {
  return {
    channel: 'workbuddy-host',
    url: 'local',
    token: process.env.A2A_BRIDGE_CONFIRM_TOKEN || '',
    sessionKey: process.env.A2A_BRIDGE_SESSION_KEY || 'agent:ruochen:main',
    mainTo: process.env.A2A_BRIDGE_MAIN_TO || 'host-user',
    writeSafeRoot: writeSafeRoot(),
    confirmDir: confirmDir(),
  };
}

function buildInjectMessage(frame = {}) {
  const envelope = frame.envelope || frame;
  const taskId = frame.taskId || envelope.delegationId || 'unknown';
  const d = envelope.delegation || envelope;
  const delegator = frame.delegatorLabel || envelope.delegator || d.delegator || '未知委托方';
  const scope = envelope.scope || d.scope || 'read';
  const task = envelope.task || d.task || d.target || '(空)';
  return [
    `【A2A Bridge · WorkBuddy 沙箱】taskId=${taskId}`,
    `委托方: ${delegator}`,
    `范围: ${scope}`,
    `任务: ${task}`,
    '边界: 仅沙箱写入白名单；越界/shell 一律拒绝；L3 需宿主用户确认。',
  ].join('\n');
}

function detectRefusal(content) {
  const s = String(content || '').trim();
  if (!s) return false;
  return /^(⛔|🚫)/.test(s);
}

module.exports = {
  inject,
  injectIsolated,
  resolveConfig,
  fetchResult,
  buildInjectMessage,
  detectRefusal,
  // WorkBuddy 扩展
  invokeTool,
  sandboxWrite,
  resolveInside,
  deliverConfirmRequest,
  resolveConfirm,
  writeSafeRoot,
  confirmDir,
  confirmReadPath: () => 'file',
  CONTRACT: {
    version: 1,
    params: { fetchResult: ['taskId', 'sinceMs', 'limit', 'sessionKey'] },
    fetchResultSuccessKeys: ['ok', 'result'],
  },
};
