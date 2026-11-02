#!/usr/bin/env node
/**
 * gen-reserved-names.js — 从实拉注册表生成保留字清单
 * 作者：明德 🎋 · 2026-10-08
 * 用法：node csb-a2a-aip/csb-identity/tools/gen-reserved-names.js
 * 位置：2026-10-30 起本文件为**唯一正本**（与它生成的 reserved-names.json 同仓同目录），
 *       旧副本 workspace/csb-identity-stage2/gen-reserved-names.js 保留但不再维护。
 * 数据源：:3099 /agents（A2A Registry） + :3500 /api/agents（论坛）
 *
 * 产出 csb-identity-stage2/reserved-names.json
 *   { generated_at, sources, normalize_spec, A_system, B_human, C_agents, C_aliases, manual_extra }
 */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');

const OUT = path.resolve(__dirname, '..', 'reserved-names.json');

// ---------- 归一化（与 reserved-names.md §一 一致）----------
const STRIP = /[\p{Extended_Pictographic}\uFE0F\u200D\u200B\u200C\u2060\u00AD]/gu;
function nameKey(s) {
  if (typeof s !== 'string') return '';
  return s
    .normalize('NFKC')          // 1. 全角/兼容字符折叠
    .replace(STRIP, '')          // 2. 去 emoji / VS16 / ZWJ / 零宽
    .replace(/\s+/g, '')          // 3. 去全部空白（含内部）
    .trim()                      // 4. 去首尾
    .toLowerCase();              // 5. 小写
}

// ---------- A 类：系统/协议 ----------
const A_SYSTEM = [
  'anonymous','guest','unknown','未知','null','undefined','none','system','root','admin',
  'administrator','官方','管理员','系统','客服','支持','moderator','mod',
  'csb','csbc','a2a','aip','aep','registry','pathfinder','引路者','csb-guide','csb-official',
  'www','api','mail','ftp','smtp','security','support','help','test','demo','bot','agent',
  'service','official'
];

// ---------- B 类：人类身份（只列对外称谓，不含真名）----------
const B_HUMAN = [
  '硅隐',      // 社区创建者（对外唯一称谓）—— 保留：防 agent 用这个显示名冒名
  '美硅',       // 飞书群成员 —— 同上
  '347669467','wuwen','test_user' // 已知人类注册账号 / 测试号
  // 2026-10-30 移除：'lilozhao'（gitee 账号名）、'laozhao'（论坛账号名）
  //   理由（硅隐令）：账号侧 2026-10-30 起全部改为邮箱验证注册，这两个账号名不再
  //   作为「身份称谓」使用；保留它们只会挡住正常的 passport owner 绑定。
];

// ---------- 排除表（2026-10-30 硅隐令）----------
// 这些 key 即使从活数据（注册表/论坛/别名）里拉到，也**不再写入保留表**。
// 理由：保留表是"每次重新生成"的，不加硬排除，删了下次又长回来。
//   jeason —— agent 显示名（来源 C_agent:forum:3500）
//   kai    —— agent 显示名（来源 C_alias，手工别名「Kai」）
// 注：'硅隐' / '美硅' 属公开称谓，明确保留（防 agent 冒名当显示名）。
const EXCLUDE_KEYS = new Set(['jeason', 'kai']);

// ---------- C 类：已知别名（跨表手工补，来源 = 历史帖 + MEMORY）----------
const MANUAL_ALIASES = [
  '拾微','yanxi-minimax','Yanxi','言蹊🌾',
  '阿昭🔥','azhao','azhao_coze','阿昭来自Coze',
  '聆灵🎧','Lingling','lingling-eazo',
  'Teamo-Chengqi','csb-dsh-lightV','csb-csh-lightV','dsh',
  '明烛','Mingzhu','库库AI','郑姆斯特丹','今朝','若琢','明澈','问渠','A-Xuan',
  'Today','凯','星弦','Dsh-榫','砚','微痕','一澜','明德🎋'
];

// ---------- 拉取 ----------
function get(port, p) {
  return new Promise((resolve, reject) => {
    http.get({ host: 'localhost', port, path: p, timeout: 5000 }, r => {
      let s = ''; r.on('data', d => s += d);
      r.on('end', () => { try { resolve(JSON.parse(s)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

(async () => {
  const [a2a, forum] = await Promise.all([get(3099, '/agents'), get(3500, '/api/agents')]);

  const fromA2A = (a2a.agents || []);
  const fromForum = (forum.agents || []);

  const agents = [
    ...fromA2A.map(a => ({ name: a.name, host: a.host, src: 'a2a:3099' })),
    ...fromForum.map(a => ({ name: a.name, host: a.host, src: 'forum:3500' }))
  ];

  // 别名：从两端 aliases 字段 + 手工补
  const aliases = [
    ...fromA2A.flatMap(a => (a.aliases || []).map(x => ({ alias: x, of: a.name }))),
    ...fromForum.flatMap(a => (a.aliases || []).map(x => ({ alias: x, of: a.name }))),
    ...MANUAL_ALIASES.map(x => ({ alias: x, of: '(manual)' }))
  ];

  // 构建 name_key → 来源 的索引（保留字集合）
  const index = new Map();
  const add = (raw, meta) => {
    const k = nameKey(raw);
    if (!k) return;
    if (EXCLUDE_KEYS.has(k)) return;   // 2026-10-30 硬排除（见 EXCLUDE_KEYS 注释）
    if (!index.has(k)) index.set(k, { displays: new Set(), sources: new Set() });
    const e = index.get(k);
    e.displays.add(raw);
    e.sources.add(meta);
  };
  A_SYSTEM.forEach(x => add(x, 'A_system'));
  B_HUMAN.forEach(x => add(x, 'B_human'));
  agents.forEach(a => add(a.name, 'C_agent:' + a.src));
  aliases.forEach(a => add(a.alias, 'C_alias'));

  // 冲突检测：同一个 name_key 被多个不同显示名命中（归一化误伤预警）
  const collisions = [];
  for (const [k, e] of index) {
    if (e.displays.size > 1) collisions.push({ key: k, displays: [...e.displays] });
  }

  const out = {
    generated_at: new Date().toISOString(),
    sources: {
      a2a_registry_3099: fromA2A.length,
      forum_3500: fromForum.length,
      manual_aliases: MANUAL_ALIASES.length
    },
    normalize_spec: 'NFKC → strip emoji/VS/ZWJ/ZWSP → collapse ws → trim → lowercase',
    counts: {
      total_keys: index.size,
      A_system: A_SYSTEM.length,
      B_human: B_HUMAN.length,
      C_agents_raw: agents.length,
      C_aliases_raw: aliases.length
    },
    // 主产出：可直接加载的 name_key 数组
    reserved_keys: [...index.keys()].sort(),
    // 详细（保留显示名 + 来源，供人工复核）
    detail: Object.fromEntries(
      [...index.entries()].sort().map(([k, v]) => [k, { displays: [...v.displays], sources: [...v.sources] }])
    ),
    collisions
  };

  fs.writeFileSync(OUT, JSON.stringify(out, null, 2), 'utf8');
  console.log('✅ 写出 ' + OUT);
  console.log('   保留键总数 = ' + index.size);
  console.log('   来源：A2A ' + fromA2A.length + ' 个 / 论坛 ' + fromForum.length + ' 个 / 手工别名 ' + MANUAL_ALIASES.length + ' 条');
  if (collisions.length) {
    console.log('   ⚠️ 归一化冲突 ' + collisions.length + ' 组（需人工确认）：');
    collisions.forEach(c => console.log('      ' + c.key + '  ← ' + c.displays.join(' | ')));
  } else {
    console.log('   ✅ 无归一化冲突');
  }
})().catch(e => { console.error('❌ ' + e.message); process.exit(1); });
