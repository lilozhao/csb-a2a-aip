/**
 * expansion-ledger.js —— SPEC-A2A-0003 的账本桥接（2026-10-23）
 *
 * 为什么单独一个文件：
 *   原先接线处（a2a-standard-api-v5.js#_requestExpansion）的 ledger 是**空壳**——
 *   查了一下 scripts/ledger.js 存在，然后什么也没写，只 console.error 打一行。
 *   SPEC-A2A-0003 的 R6 要求「拒绝写账本，不静默」，工程契约 P1 要求
 *   「拒绝/未命中/deny 必须落账 + 计指标，不许静默丢弃」。
 *   空壳 = 违反 P1。本文件把拒绝真正写进哈希链账本。
 *
 * 边界（诚实记录，不假装有）：
 *   - 账本写失败**不影响业务返回**（deny 的决定照常返回；写失败另记 stderr 一条，
 *     并计入本进程内的 droppedRecords 计数，供 /health 或巡检读取）。
 *   - 为什么不让写失败阻断业务：审计是旁路，不是业务前置。
 *     阻断会让「账本不可写」变成「A2A 不可用」，那是拿可用性换完整性，不划算。
 *     但要**可发现**——所以 dropped 计数必须能被读到，不是静默吞掉。
 *   - 账本是外部进程调用（node scripts/ledger.js add），同步 execFileSync，
 *     失败/超时都吞掉并计数，不抛出。
 *
 * 用法：
 *   const { makeLedger, getDropped } = require('./expansion-ledger.js');
 *   const ledger = makeLedger({ workspaceDir, actor });
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// 进程内计数：写入失败的记录条数（供巡检读取，不静默）
let DROPPED = 0;
// 最近一条失败的简短原因（诊断用）
let LAST_ERROR = null;

/**
 * 解析 workspace 根目录。
 * 优先级：显式传入 > env CSB_WORKSPACE > 从本文件上溯找 scripts/ledger.js。
 * 找不到 → 返回 null（调用方转 stderr 兜底）。
 */
function resolveWorkspace(explicit) {
    if (explicit && fs.existsSync(path.join(explicit, 'scripts', 'ledger.js'))) return explicit;

    const envWs = process.env.CSB_WORKSPACE;
    if (envWs && fs.existsSync(path.join(envWs, 'scripts', 'ledger.js'))) return envWs;

    // 从当前文件所在目录逐级上溯（最多 6 层）
    let dir = __dirname;
    for (let i = 0; i < 6; i += 1) {
        if (fs.existsSync(path.join(dir, 'scripts', 'ledger.js'))) return dir;
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return null;
}

/**
 * 构造一个 ledger 回调，签名与 a2a-expansion.js 期望的一致：
 *   ledger(rec)  —— rec = { action, code?, reason?, kind?, ts }
 *
 * @param {object} [opts]
 * @param {string} [opts.workspaceDir]  强制指定 workspace 根
 * @param {string} [opts.actor]         账本的 actor 字段，默认 A2A_EXPANSION_LEDGER_ACTOR 或 'a2a-expansion'
 * @param {Function} [opts.onDrop]      写失败回调（便于测试注入）
 * @returns {Function} ledger(rec)
 */
function makeLedger(opts = {}) {
    const ws = resolveWorkspace(opts.workspaceDir);
    const actor = opts.actor || process.env.A2A_EXPANSION_LEDGER_ACTOR || 'a2a-expansion';

    return function ledger(rec) {
        const r = rec || {};
        const action = String(r.action || 'expansion.unknown');
        const target = r.code ? String(r.code) : (r.kind ? String(r.kind) : '');
        const reason = String(r.reason || r.kind || '').slice(0, 200);

        // 账本不存在：不静默，计 dropped 并打 stderr（P1：拒绝要计分）
        if (!ws) {
            DROPPED += 1;
            LAST_ERROR = 'ledger.js not found (workspace unresolved)';
            console.error('[A2A][expansion][ledger-miss]', JSON.stringify(r), '|', LAST_ERROR);
            if (typeof opts.onDrop === 'function') { try { opts.onDrop(r, LAST_ERROR); } catch (_) {} }
            return;
        }

        try {
            execFileSync('node', [
                path.join(ws, 'scripts', 'ledger.js'), 'add',
                '--action', action,
                '--target', target,
                '--reason', reason || '(no reason)',
                '--before', 'none',
                '--after', 'none',
                '--actor', actor,
            ], { stdio: 'ignore', timeout: 5000 });
        } catch (e) {
            DROPPED += 1;
            LAST_ERROR = e && e.message ? String(e.message).slice(0, 120) : 'unknown';
            console.error('[A2A][expansion][ledger-fail]', JSON.stringify(r), '|', LAST_ERROR);
            if (typeof opts.onDrop === 'function') { try { opts.onDrop(r, LAST_ERROR); } catch (_) {} }
        }
    };
}

/** 审计通道（R8）同样是账本的一条：breach 触发时按 expansion.security_audit 记录 */
function makeAuditor(opts = {}) {
    return makeLedger(opts);
}

/** 供巡检读取：本进程内落账失败条数 + 最近原因 */
function getDropped() {
    return { dropped: DROPPED, lastError: LAST_ERROR };
}

/** 仅测试用：清零计数 */
function _resetDropped() {
    DROPPED = 0;
    LAST_ERROR = null;
}

module.exports = { makeLedger, makeAuditor, getDropped, resolveWorkspace, _resetDropped };
