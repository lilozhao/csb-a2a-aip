/**
 * registry-lookup.js — 只读查表：name → agent_id / 关系级别（供 A2A 传输层做 blocked 判定）
 * 明德 🎋 2026-10-08（若琢 batch2 反馈 ① 的落地件）
 * 只读，不写、不加锁。
 */
'use strict';
const fs = require('fs');
const path = require('path');

function nameKey(s) {
  return String(s || '').normalize('NFKC').replace(/[\p{Extended_Pictographic}\uFE0F\u200D\u200B\u200C\u2060\u00AD]/gu, '').replace(/\s+/g, '').toLowerCase();
}
function loadIdentities(dataDir) {
  try { return JSON.parse(fs.readFileSync(path.join(dataDir, 'identities.json'), 'utf8')).identities || {}; }
  catch { return {}; }
}
/** 把"名字/agent_id/本地段"解析为 agent_id */
function resolveAgentId(dataDir, nameOrId) {
  const ids = loadIdentities(dataDir);
  if (!nameOrId) return null;
  if (ids[nameOrId]) return nameOrId;
  const k = nameKey(nameOrId);
  for (const [id, rec] of Object.entries(ids)) {
    if (nameKey(rec.name) === k) return id;
    if (nameKey(String(id).split('@')[0]) === k) return id;
  }
  return null;
}
/** 读 (subject → peer) 的关系级别（无记录 = limited） */
function levelOf(dataDir, subject, peer) {
  try {
    const f = path.join(dataDir, 'connections', String(subject).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) + '.json');
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (j.subject_id && j.subject_id !== subject) return null;
    const row = (j.rows || {})[peer];
    return row ? row.level : 'limited';
  } catch { return null; }
}
/** 本实例在身份层的 subject（按 identity.name 反查）；未注册 → null */
function resolveSelfSubject(dataDir, displayName) {
  const ids = loadIdentities(dataDir);
  const k = nameKey(displayName);
  for (const [id, rec] of Object.entries(ids)) if (nameKey(rec.name) === k) return id;
  return null;
}
module.exports = { nameKey, resolveAgentId, levelOf, resolveSelfSubject, loadIdentities };
