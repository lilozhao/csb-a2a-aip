#!/usr/bin/env node
/**
 * backfill-bridge-labels.js — 给历史桥接会话批量补 label
 * ============================================================
 * 早期 A2A 桥接注入的会话是一串随机 uuid（agent:main:openai:<uuid>），
 * 在 webchat 里认不出是谁。本脚本逐个读 transcript 认来源，再调
 * sessions.patch 补上「🔌 A2A 桥接 · <委托方>」这类 label。
 *
 * 识别规则（读 transcript 头部）：
 *   · 「来自外部Agent「X」」 / 「桥接委托 · 委托方: X」→ 🔌 A2A 桥接 · X
 *   · 「你是一个记忆蒸馏器」                          → 🧠 记忆蒸馏 · A2A
 *   · 其余 / 已有 label / :heartbeat                  → 跳过
 *
 * 用法：
 *   node scripts/backfill-bridge-labels.js            # dry-run（只打印）
 *   node scripts/backfill-bridge-labels.js --apply    # 真正写
 *   node scripts/backfill-bridge-labels.js --limit 20
 * ============================================================
 * 维护：若兰 🌸 · 2026-09-19
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const RELABEL = args.includes('--relabel');   // 已有 label 也重算并覆盖
const li = args.indexOf('--limit');
const LIMIT = li >= 0 ? parseInt(args[li + 1], 10) : Infinity;

const STORE = process.env.OPENCLAW_SESSIONS_STORE
  || '/home/node/.openclaw/agents/main/sessions/sessions.json';
const DIR = path.dirname(STORE);

function readHead(file, lines = 80, bytes = 262144) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    fs.closeSync(fd);
    return buf.subarray(0, n).toString('utf8').split('\n').slice(0, lines).join('\n');
  } catch { return null; }
}

function cleanPeer(p) {
  return String(p)
    .replace(/\([^)]*\)/g, '')            // 先去括号注（常带 host:port）
    .replace(/https?:\/\/\S+/g, '')      // 再去残留 URL
    .replace(/[\s·|]+/g, ' ')
    .trim().slice(0, 24) || '未知';
}

function classify(text) {
  if (!text) return null;
  let m = text.match(/来自外部Agent「([^」]+)」/);
  if (m && m[1]) return { kind: 'bridge', peer: cleanPeer(m[1]) };
  if (/桥接委托|Bridge Delegation/.test(text)) {
    m = text.match(/委托方[:：]\s*([^\n"\\]+)/);
    return { kind: 'bridge', peer: cleanPeer(m && m[1] ? m[1] : '未知委托方') };
  }
  if (/记忆蒸馏器/.test(text)) return { kind: 'distill' };
  return null;
}

function baseLabel(c) {
  return c.kind === 'bridge' ? `🔌 A2A 桥接 · ${c.peer}` : '🧠 记忆蒸馏 · A2A';
}

function patch(key, label) {
  return new Promise((resolve) => {
    execFile('openclaw', ['gateway', 'call', 'sessions.patch', '--params',
      JSON.stringify({ key, label }), '--json'], { timeout: 8000 },
      (err, stdout, stderr) => resolve({
        ok: !err,
        out: String(stdout || '') + String(stderr || '') + String((err && (err.stdout || err.stderr || err.message)) || ''),
      }));
  });
}

async function fixParens() {
  const j = JSON.parse(fs.readFileSync(STORE, 'utf8'));
  const store = j.sessions || j;
  const used = new Set();
  for (const [, v] of Object.entries(store)) if (v && v.label && !v.label.includes('(')) used.add(v.label);
  let fixed = 0;
  for (const [key, v] of Object.entries(store)) {
    if (!v || !v.label || !v.label.includes('(')) continue;
    if (!/^(🔌 A2A 桥接|🧠 记忆蒸馏)/.test(v.label)) continue;   // 只碰本工具打的标，绝不误伤 Cron 等
    const short = (v.sessionId || '').replace(/[^\w]/g, '').slice(0, 4);
    let want = v.label.replace(/https?:\/\/\S*/g, '').replace(/[()]/g, '').replace(/[·\s|]+$/, '').replace(/\s+/g, ' ').trim();
    if (used.has(want)) want = `${want} · ${short}`;
    let r = await patch(key, want);
    if (!r.ok && /in use/i.test(r.out)) { want = `${want} · ${short}`; r = await patch(key, want); }
    if (r.ok) { fixed++; used.add(want); console.log(`[ok ] ${want.padEnd(28)} <- ${v.label}`); }
    else console.log(`[ERR] ${key} :: ${r.out.replace(/\s+/g, ' ').slice(0, 100)}`);
  }
  console.log(`\n--- fixed=${fixed} ---`);
}

(async () => {
  if (args.includes('--fix-parens')) return fixParens();
  const j = JSON.parse(fs.readFileSync(STORE, 'utf8'));
  const store = j.sessions || j;
  const keys = Object.keys(store);
  console.log(`store  : ${STORE}`);
  console.log(`sessions: ${keys.length}  | mode: ${APPLY ? 'APPLY ✍️' : 'DRY-RUN 👀'}\n`);

  let scanned = 0, candidates = 0, patched = 0;
  const used = new Set();

  for (const key of keys) {
    if (candidates >= LIMIT) break;
    const e = store[key] || {};
    scanned++;
    if (e.label && !RELABEL) continue;              // 已有 label（除非 --relabel）
    if (key.endsWith(':heartbeat')) continue;       // 心跳伴生会话
    if (!/:openai:|:a2a-bridge-/.test(key)) continue; // 只处理桥接通道会话（不碰 feishu/群聊等）
    const sid = e.sessionId;
    const tf = sid ? path.join(DIR, sid + '.jsonl') : null;
    const head = tf && fs.existsSync(tf) ? readHead(tf) : null;
    const c = classify(head);
    if (!c) continue;                               // 认不出来
    candidates++;

    const short = sid ? sid.replace(/[^\w]/g, '').slice(0, 4) : 'x';
    let label = baseLabel(c);
    if (used.has(label)) label = `${label} · ${short}`;
    if (RELABEL && e.label === label) continue;     // 无需变动

    if (!APPLY) { console.log(`[dry] ${label.padEnd(30)} ${key}`); used.add(label); continue; }

    let r = await patch(key, label);
    if (!r.ok && /in use/i.test(r.out)) { label = `${baseLabel(c)} · ${short}`; r = await patch(key, label); }
    if (r.ok) { patched++; used.add(label); console.log(`[ok ] ${label.padEnd(30)} ${key}`); }
    else console.log(`[ERR] ${key} :: ${r.out.replace(/\s+/g, ' ').slice(0, 120)}`);
  }

  console.log(`\n--- scanned=${scanned} candidates=${candidates} patched=${patched} ---`);
})();
