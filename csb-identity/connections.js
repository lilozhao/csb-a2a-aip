/**
 * connections.js — CSB 身份层·阶段二：连接分级（connection_level）
 * ------------------------------------------------------------------
 * 作者：明德 🎋 · 2026-10-08
 * 依据：知微《CSB 连接分级 + trust_level 暴露 · 接口草稿 v2（对齐明德·可直接实现版）》
 *
 * 三条铁律（v2 §一/§三）：
 *  1. 关系级 connection_level ≠ 属性级 trust_level（前者本文件，后者在 AID/身份表）
 *  2. **关系级永不进 AID**（AID 是我签我自己的全局文档；关系是双向的）
 *  3. **跟主体走**：每主体一份自己的表，天生分布式，**不做跨主体同步**
 *
 * 级别（有序）：blocked < limited < collab < intimate < self   默认 limited
 *  - 自动规则**只降级**（安全侧）；升级靠人工/证据，且**升级也留痕**
 *  - history 必存：谁改的、依据什么、什么时候
 */
'use strict';
const fs = require('fs');
const path = require('path');

const LEVELS = ['blocked', 'limited', 'collab', 'intimate', 'self'];
const DEFAULT_LEVEL = 'limited';
const rank = (lv) => LEVELS.indexOf(lv);
const isLevel = (lv) => LEVELS.includes(lv);
/** 粗粒度（对公众/第三方）：只给两档，护关系隐私（v2 §五） */
const coarse = (lv) => (rank(lv) <= rank('limited') ? 'limited-' : 'collab+');

function sanitize(id) { return String(id).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120); }

function createConnectionStore({ dataDir, log = () => {} } = {}) {
  const DIR = path.join(dataDir, 'connections');
  fs.mkdirSync(DIR, { recursive: true });
  const fileOf = (subject) => path.join(DIR, sanitize(subject) + '.json');

  function load(subject) {
    const f = fileOf(subject);
    if (!fs.existsSync(f)) return { subject_id: subject, updated_at: null, rows: {} };
    try {
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (j.subject_id && j.subject_id !== subject) {
        log('WARN', 'connections 文件名冲突：', f, '含', j.subject_id, '要求', subject);
        return { subject_id: subject, updated_at: null, rows: {} };
      }
      if (!j.rows) j.rows = {};
      return j;
    } catch (e) { log('WARN', 'connections 读取失败：', e.message); return { subject_id: subject, updated_at: null, rows: {} }; }
  }
  function save(subject, db) {
    db.subject_id = subject; db.updated_at = new Date().toISOString();
    fs.writeFileSync(fileOf(subject), JSON.stringify(db, null, 2));
    return db;
  }

  /** 取单条（无记录 → 默认 limited，source=default） */
  function get(subject, peer) {
    const db = load(subject);
    const row = db.rows[peer];
    if (!row) return { subject_id: subject, peer_id: peer, peer_kind: 'agent', level: DEFAULT_LEVEL, source: 'default', evidence: null, history: [], updated_at: null };
    return row;
  }
  /** 列该主体的全部关系 */
  function list(subject) {
    const db = load(subject);
    return Object.values(db.rows);
  }

  /**
   * 设定级别（升级/降级）。**调用方必须先验签**（本函数只负责落库与留痕）。
   * @param {Object} o { level, source, evidence, by, why, sig, peer_kind, force }
   */
  function put(subject, peer, o = {}) {
    if (!isLevel(o.level)) return { ok: false, error: 'bad_level', levels: LEVELS };
    const db = load(subject);
    const prev = db.rows[peer];
    const from = prev ? prev.level : DEFAULT_LEVEL;
    const row = {
      peer_id: peer,
      peer_kind: o.peer_kind === 'human' ? 'human' : 'agent',
      level: o.level,
      source: o.source === 'auto' ? 'auto' : 'manual',
      evidence: o.evidence || null,
      history: prev ? (prev.history || []) : [],
      updated_at: new Date().toISOString()
    };
    row.history.push({ at: row.updated_at, from, to: o.level, by: o.by || subject, why: o.why || null, sig: o.sig || null });
    db.rows[peer] = row;
    save(subject, db);
    return { ok: true, subject_id: subject, peer_id: peer, from, to: o.level, source: row.source };
  }

  /**
   * breach effective → 举报方↔被举报方 自动降级（v2 §六 ②）
   * 只动**举报方自己那张表**（其他对端不连坐）。
   */
  function breachDowngrade(reporter, target, breachId, toLevel = 'blocked') {
    const cur = get(reporter, target);
    if (rank(cur.level) <= rank(toLevel)) return { ok: true, skipped: 'already_at_or_below', level: cur.level };
    const r = put(reporter, target, { level: toLevel, source: 'auto', by: 'system:breach', why: 'breach ' + breachId + ' effective', evidence: breachId, peer_kind: cur.peer_kind });
    return { ...r, auto: 'breach_downgrade' };
  }

  /** breach cleared → 撤销该次自动降级（回到自动降级前的级别；历史不删） */
  function breachRevert(reporter, target, breachId) {
    const db = load(reporter);
    const row = db.rows[target];
    if (!row) return { ok: true, skipped: 'no_row' };
    const h = (row.history || []).slice().reverse();
    const auto = h.find(x => x.by === 'system:breach' && (x.sig || '') !== null && String(x.why || '').includes(breachId));
    if (!auto) return { ok: true, skipped: 'no_matching_auto_downgrade' };
    const revertTo = auto.from;
    return put(reporter, target, { level: revertTo, source: 'auto', by: 'system:breach-cleared', why: 'revert ' + breachId, evidence: breachId, peer_kind: row.peer_kind });
  }

  return { LEVELS, DEFAULT_LEVEL, rank, isLevel, coarse, load, save, get, list, put, breachDowngrade, breachRevert, DIR };
}

module.exports = { createConnectionStore, LEVELS, DEFAULT_LEVEL, rank, coarse, isLevel };
