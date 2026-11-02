#!/usr/bin/env node
/**
 * P0-5 前置：入站鉴权灰度「应拦比例」Top-N
 *
 * 目的：在**不改生产**的前提下，用已有入站记录算出「开了鉴权会拦掉谁、各占多少」。
 * 判据口径（全部机械可核，不靠印象）：
 *
 *   A 无身份   from.name 缺失 / 'unknown' / '?'            → 应当 100% 拦
 *   B 冒名嫌疑  声称的名字属于已知 agent，但无 url 且无 AAT → 需人工通道（不可自动放行）
 *   C 自洽     name + url/host 与注册表一致                → 可放行（**只说明名称与出处自洽，
 *                                                          不证明该 url 真是该 agent；未验签**）
 *   D 未注册   name + url 有，但注册表查不到                → 灰度期只记，不放量
 *
 * 为什么不算「应拦比例 = A 占比」就完事：
 *   灰度要回答的是「放量后谁会断」，所以必须把「有名字但核对不了」单列（B），
 *   否则一刀切会把 B 里那些真的是老邻居的请求也拦掉（10-31 的 N-5 就栽在这种
 *   「看起来像证据的东西」上）。
 *
 * 用法：
 *   node scripts/inbound-auth-topn.js                # 默认读 data/a2a-inbox.jsonl
 *   node scripts/inbound-auth-topn.js --file <path>
 *   node scripts/inbound-auth-topn.js --since 2026-10-01
 *   node scripts/inbound-auth-topn.js --json
 *   node scripts/inbound-auth-topn.js --offline     # 不查实时注册表，只用本地文件
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function arg(name, dflt) {
  const i = process.argv.indexOf(name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const asJson = process.argv.includes('--json');
const offline = process.argv.includes('--offline');
const file = path.resolve(arg('--file', path.join(ROOT, 'data', 'a2a-inbox.jsonl')));
const since = arg('--since', null);
// ⚠️ 注册表地址「按环境而异」（TOOLS.md 的坑）：env 里可能是 127.0.0.1:3099（宿主机口径），
//   在容器内并不可达。所以按候选列表逐个试，**说清用的是哪一个**，不假装。
const REGISTRY_CANDIDATES = [
  process.env.A2A_REGISTRY_URL,
  'http://172.28.0.4:3099',
  'http://127.0.0.1:3099',
].filter(Boolean);

/** 读取注册表里的已知 agent 名（小写比对；注册表不可读时返回空集 = 全部判「未注册」） */
function loadKnownAgents() {
  const out = new Set();
  const candidates = [
    path.join(ROOT, 'data', 'a2a_registry.json'),
    path.join(ROOT, 'config', 'agents.local.json'),
    path.join(ROOT, 'config', 'agents.json'),
  ];
  for (const f of candidates) {
    try {
      const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
      const list = Array.isArray(raw) ? raw : (raw.agents || raw.registry || []);
      for (const a of list) {
        if (a && a.name) out.add(String(a.name).toLowerCase());
        if (a && a.id) out.add(String(a.id).toLowerCase());
      }
    } catch { /* 缺文件不算错 */ }
  }
  return out;
}

/**
 * 实时注册表（本地文件通常只有 7 条，实时有 16+ —— 用陈旧的名单会把真邻居误判成冒名）
 * 取不到就退回本地，并在输出里标明来源，不假装查到了。
 */
async function loadKnownAgentsLive() {
  const out = loadKnownAgents();
  const src = ['local'];
  if (offline) return { names: out, source: src.join('+') };
  const errors = [];
  for (const base of REGISTRY_CANDIDATES) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 4000);
      const res = await fetch(`${base}/agents`, { signal: ctrl.signal });
      clearTimeout(timer);
      const data = await res.json();
      const list = Array.isArray(data) ? data : (data.agents || []);
      for (const a of list) {
        if (a && a.name) out.add(String(a.name).toLowerCase());
      }
      src.push(`registry@${base.replace(/^https?:\/\//, '')}(${list.length})`);
      return { names: out, source: src.join('+') };
    } catch (e) {
      errors.push(`${base}:${e.name === 'AbortError' ? 'timeout' : 'unreachable'}`);
    }
  }
  src.push(`registry(${errors.join(',') || 'none'})`);
  return { names: out, source: src.join('+') };
}

function classify(rec, known) {
  const from = (rec && rec.from && typeof rec.from === 'object') ? rec.from : {};
  const name = String(from.name || '').trim();
  const url = String(from.url || from.host || '').trim();
  const hasName = name && !['unknown', '?', 'undefined', 'null'].includes(name.toLowerCase());
  const hasUrl = !!url;
  const knownName = hasName && (known.has(name.toLowerCase()) || [...known].some(k => k && name.toLowerCase().includes(k)));

  if (!hasName) return { cls: 'A', why: '无身份（name 缺失/unknown）' };
  if (!hasUrl) return { cls: knownName ? 'B' : 'A', why: knownName ? '声称已知身份但无 url 可核' : '无身份（无 url 且非已知名）' };
  if (knownName) return { cls: 'C', why: 'name + url，注册表命中（未验签）' };
  return { cls: 'D', why: 'name + url，注册表未命中' };
}

async function main() {
  if (!fs.existsSync(file)) {
    console.error(`[topn] 输入不存在：${file}`);
    process.exit(2);
  }
  const { names: known, source: knownSource } = await loadKnownAgentsLive();
  const rows = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean)
    .filter((r) => !since || String(r.ts || '') >= since);

  const byCls = { A: 0, B: 0, C: 0, D: 0 };
  const perName = new Map();
  const suspicious = [];

  for (const r of rows) {
    const c = classify(r, known);
    byCls[c.cls]++;
    const nm = (r.from && r.from.name) || 'unknown';
    const key = `${nm}`;
    const cur = perName.get(key) || { name: nm, total: 0, A: 0, B: 0, C: 0, D: 0, url: (r.from && r.from.url) || '' };
    cur.total++; cur[c.cls]++;
    perName.set(key, cur);
    if (c.cls === 'B') suspicious.push({ ts: r.ts, name: nm, url: '', why: c.why, preview: String(r.text || '').slice(0, 60) });
  }

  const total = rows.length || 1;
  const pct = (n) => Math.round((n / total) * 1000) / 10;
  const top = [...perName.values()]
    .sort((a, b) => (b.A + b.B) - (a.A + a.B) || b.total - a.total)
    .slice(0, 15)
    .map((x) => ({ ...x, blockRate: Math.round(((x.A + x.B) / x.total) * 1000) / 10 }));

  const out = {
    file,
    since: since || null,
    knownAgents: known.size,
    knownAgentsSource: knownSource,
    total: rows.length,
    range: rows.length ? [rows[0].ts, rows[rows.length - 1].ts] : [],
    classes: {
      A: { n: byCls.A, pct: pct(byCls.A), label: '无身份 → 应 100% 拦' },
      B: { n: byCls.B, pct: pct(byCls.B), label: '冒名嫌疑 → 人工通道' },
      C: { n: byCls.C, pct: pct(byCls.C), label: '名称+出处自洽（未验签）→ 可放行' },
      D: { n: byCls.D, pct: pct(byCls.D), label: '未注册 → 灰度只记' },
    },
    wouldBlockPct: pct(byCls.A + byCls.B),
    top,
    suspicious,
  };

  if (asJson) {
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  console.log(`\n📊 入站鉴权灰度 · 应拦比例 Top-N`);
  console.log(`   数据：${path.relative(ROOT, file)}  ${out.total} 条  ${out.range[0] || ''} → ${out.range[1] || ''}`);
  console.log(`   注册表已知 agent：${known.size}（来源 ${knownSource}）\n`);
  for (const k of ['A', 'B', 'C', 'D']) {
    const c = out.classes[k];
    console.log(`   ${k} ${String(c.n).padStart(4)}  ${String(c.pct).padStart(5)}%  ${c.label}`);
  }
  console.log(`\n   一刀切应拦（A+B）：${out.wouldBlockPct}%  ← 灰度必须能回答「这 ${byCls.A + byCls.B} 条谁是真的」\n`);
  console.log('   ⚠️ C 类只说明「名字与出处自洽」，不等于验签通过；接上 AAT 后 C 里会有一部分掉回 B。\n');
  console.log('   Top-N（按应拦条数排序）');
  for (const x of top) {
    if (x.A + x.B === 0) continue;
    console.log(`     ${String(x.name).padEnd(14)} 总 ${String(x.total).padStart(3)} ｜ A ${String(x.A).padStart(3)} B ${String(x.B).padStart(2)} C ${String(x.C).padStart(3)} D ${String(x.D).padStart(2)} ｜ 应拦 ${x.blockRate}%  ${x.url || '(无 url)'}`);
  }
  if (suspicious.length) {
    console.log(`\n   ⚠️ B 类（冒名嫌疑，需人工通道）示例`);
    for (const s of suspicious.slice(0, 5)) console.log(`     ${s.ts} · ${s.name} · ${s.preview}`);
  }
  console.log('');
}

if (require.main === module) main();
module.exports = { classify, loadKnownAgents, loadKnownAgentsLive };
