/**
 * humans.js — CSB 身份层：人类标识（human_handle）
 * ------------------------------------------------------------------
 * 作者：明德 🎋 · 2026-10-08
 * 依据：知微《人类标识 · 设计草稿 v1》+ 硅隐 2026-10-08 拍板
 *    H1 = B 独立命名空间（变体：passport 的 owner 段用**裸 handle**；human:// 是完全限定形式）
 *    H2 = 现在不上人的密钥（登记为主，pubkey 留位；C = D2 A→B 的落地）
 *    H3 = 以 human_handle 为锚（**但"舰队"是 agent 自报集合**，不是主人确认过的）
 *    H4 = 假名默认，真身份绑定可选、非默认
 *    H5 = 与 agent name 同规则（复用同一张保留表/归一化）+ **跨命名空间同名互斥**
 *    H6 = 不自动迁移旧 owner 串（新增 owner_handle，旧值留 owner_raw）
 *
 * 三条硬规则：
 *   ① `human://<handle>` 是完全限定形式；passport 里 owner 段用裸 handle（`csb://yuan/mingde`）
 *   ② 跨命名空间同名互斥（人的 handle 与 agent 名不得同名）
 *   ③ 保留表里的 handle（如已知人类称谓）**只能由治理登记**（因为 H2 下无法验证归属）
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SCHEME = 'human://';
const uriOf = (handle) => SCHEME + handle;
const handleOf = (uri) => String(uri || '').startsWith(SCHEME) ? String(uri).slice(SCHEME.length) : String(uri || '');

function createHumanStore({ dataDir, log = () => {}, nameKey, checkReserved }) {
  const FILE = path.join(dataDir, 'humans.json');
  const load = () => {
    if (!fs.existsSync(FILE)) return { updated_at: null, humans: {} };
    try { const j = JSON.parse(fs.readFileSync(FILE, 'utf8')); if (!j.humans) j.humans = {}; return j; }
    catch (e) { log('WARN', 'humans 读取失败：', e.message); return { updated_at: null, humans: {} }; }
  };
  const save = (db) => { db.updated_at = new Date().toISOString(); fs.writeFileSync(FILE, JSON.stringify(db, null, 2)); return db; };

  const get = (handleOrUri) => load().humans[nameKey(handleOf(handleOrUri))] || null;
  const list = () => Object.values(load().humans);
  /** 该 handle 是否已被登记 */
  const exists = (handleOrUri) => !!get(handleOrUri);

  /**
   * 登记人的标识（TOFU：H2 下无密钥 → 登记即声明）
   * @returns {{ok:boolean,error?:string,human?:object}}
   */
  function register({ handle, display_name, note, covenant }, { isGovernance = false } = {}) {
    if (!handle) return { ok: false, error: 'handle_required' };
    const key = nameKey(handleOf(handle));
    if (!key) return { ok: false, error: 'empty_handle' };
    if (key.length < 2 || key.length > 32) return { ok: false, error: 'handle_length', hint: '2–32 字符（归一化后）' };
    if (/[\/\\?#\s]/.test(key)) return { ok: false, error: 'handle_invalid_chars' };

    const db = load();
    if (db.humans[key]) return { ok: false, error: 'handle_taken', key, human: db.humans[key] };

    // ③ 保留表：只能由治理登记（H2 下无法验证归属）
    const rc = checkReserved(key, 'human_handle');
    if (!rc.ok && !isGovernance) {
      return { ok: false, error: 'reserved_handle_requires_governance', key: rc.key, hint: '保留名（含已知人类称谓）须治理令牌登记（X-Admin-Token）' };
    }

    const rec = {
      handle: key,
      display_name: display_name || handle,
      pubkey: null,                 // H2 留位：C 启用后填（人的 Ed25519 公钥）
      covenant: covenant || null,   // 可选：善良契约
      status: 'active',             // 治理：active / suspended / blocked
      declared_only: true,          // H2 下：登记即声明，非证明
      created_at: new Date().toISOString(),
      note: note || null
    };
    db.humans[key] = rec;
    save(db);
    return { ok: true, human: rec, human_uri: uriOf(key) };
  }

  /** 对外视图（假名：不暴露任何真身份信息） */
  function view(rec) {
    if (!rec) return null;
    return {
      handle: rec.handle, human_uri: uriOf(rec.handle), display_name: rec.display_name,
      pubkey: rec.pubkey, status: rec.status, declared_only: rec.declared_only,
      covenant: rec.covenant ? { version: rec.covenant.version || null, hash: rec.covenant.hash || null } : null,
      created_at: rec.created_at
    };
  }

  return { SCHEME, uriOf, handleOf, load, save, get, list, exists, register, view, FILE };
}

module.exports = { createHumanStore, SCHEME };
