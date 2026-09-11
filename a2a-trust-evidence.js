/**
 * A2A 消息链 · 信任证据接线（Trust Evidence Wiring）
 * ==================================================
 * 这是「信任升级 P0」的最后一环（TRUST-UPGRADE-DESIGN.md §P0「待接」）：
 *   采集器（csb-security/lib/trust/collector.js）接口早就绪，但 A2A 消息链
 *   上**一个调用点都没有** ⇒ 正向证据恒为 0 ⇒ L1→L2（需 ≥10 次正向）
 *   数学上永不成立，所谓"信任体系"退化为手改 config/agents.json。
 *
 * 本模块把四个消息链事件接进证据账本：
 *   message_ok         消息正常处理完成（正向 +1）
 *   guard_blocked      消息被安全审查拦截（负向 -1）
 *   delegate_completed 委托执行完成（正向 +2）
 *   user_declined      用户拒绝（**中性**：行使拒绝权不是对方过错）
 *
 * 三条硬约束（顺序即优先级）：
 *   1. **绝不拖垮消息链**：任何记账异常都被吞掉并计数，绝不上抛。安全层
 *      是增强件，不是单点故障。故障只体现在 status().degraded。
 *   2. **计分规则集中在 csb-security**：本模块只做"事件 → 语义化调用"的翻译，
 *      不自带极性/权重（调用方各自为政就会烂）。
 *   3. **诚实暴露降级**：csb-security 不可用 / 账本不可写 / 未启用签名，
 *      一律在 status() 里明确标注，不假装"信任体系在运转"。
 *
 * 账本文件（默认）:
 *   data/trust/trust-evidence.jsonl   append-only + 哈希链（+ 可选 Ed25519 签名）
 *   data/trust/trust-store.json       信任快照（等级由账本重放派生，非事实来源）
 *
 * ⚠️ 已知局限（承 csb-security test/trust-p0.test.js 的诚实记录）：
 *   未启用签名时，哈希链挡不住"prev_hash/hash 都算对的完整伪造插入"。
 *   生产部署必须配 CSB_TRUST_LEDGER_KEY（Ed25519 PEM），否则 status().signed=false。
 *
 * 维护者: 若兰 🌸 | 日期: 2026-09-11 (P0)
 */

'use strict';

const fs = require('fs');
const path = require('path');

const HERE = __dirname;

/** csb-security 定位候选（Docker / 同级部署 / 自定义） */
const SECURITY_CANDIDATES = [
  process.env.CSB_SECURITY_HOME,
  path.join(HERE, '..', 'csb-security'),   // 同级部署（标准）
  path.join(HERE, 'csb-security'),         // 嵌在仓内（少见）
  path.join(HERE, '..', '..', 'csb-security'), // 父目录部署
].filter(Boolean);

const DATA_DIR = process.env.CSB_TRUST_DATA_DIR || path.join(HERE, 'data', 'trust');
const LEDGER_FILE = path.join(DATA_DIR, 'trust-evidence.jsonl');
const SNAPSHOT_FILE = path.join(DATA_DIR, 'trust-store.json');

/** 签名私钥（PEM）候选 */
const KEY_CANDIDATES = [
  process.env.CSB_TRUST_LEDGER_KEY,
  path.join(HERE, 'keys', 'trust-ledger.pem'),
].filter(Boolean);

class TrustEvidence {
  constructor() {
    this._inited = false;
    this.enabled = false;       // 采集器可用？
    this.ledger = null;
    this.collector = null;
    this.store = null;
    this.signed = false;
    this.securityPath = null;
    this.reason = 'not_initialized';
    this.stats = { hooked: 0, skipped: 0, errors: 0, lastError: null };
  }

  /** 定位可用的 csb-security 目录（不抛） */
  static locateSecurity() {
    for (const dir of SECURITY_CANDIDATES) {
      try {
        if (fs.existsSync(path.join(dir, 'lib', 'trust', 'collector.js'))) return dir;
      } catch { /* 继续找 */ }
    }
    return null;
  }

  /**
   * 惰性初始化（不抛）
   * @param {Object} [opts] 测试注入：{ securityPath, ledgerPath, snapshotPath, privateKey, dataDir }
   */
  init(opts = {}) {
    if (this._inited && !opts.force && !opts.securityPath) return this;
    this._inited = true;
    try {
      const secDir = opts.securityPath || TrustEvidence.locateSecurity();
      if (!secDir || !fs.existsSync(path.join(secDir, 'lib', 'trust', 'collector.js'))) {
        this.enabled = false;
        // 指定了不存在的路径也要报"找不到"，不要把"路径写错"伪装成"初始化炸了"
        this.reason = 'csb_security_not_found';
        return this;
      }
      this.securityPath = secDir;

      // eslint-disable-next-line global-require
      const { EvidenceLedger } = require(path.join(secDir, 'lib', 'trust', 'evidence-ledger.js'));
      // eslint-disable-next-line global-require
      const { EvidenceCollector } = require(path.join(secDir, 'lib', 'trust', 'collector.js'));

      const ledgerPath = opts.ledgerPath || LEDGER_FILE;
      const snapshotPath = opts.snapshotPath || SNAPSHOT_FILE;

      // 签名密钥（可选；缺失时明确标注为降级，不静默）
      let privateKey = opts.privateKey || null;
      if (!privateKey) {
        for (const k of KEY_CANDIDATES) {
          try {
            if (fs.existsSync(k)) { privateKey = fs.readFileSync(k, 'utf-8'); break; }
          } catch { /* 换下一个 */ }
        }
      }
      if (privateKey) {
        try {
          privateKey = require('crypto').createPrivateKey(privateKey);
          this.signed = true;
        } catch (e) {
          privateKey = null;
          this.reason = `bad_signing_key: ${e.message}`;
        }
      }

      try { fs.mkdirSync(path.dirname(ledgerPath), { recursive: true }); } catch { /* 落盘失败走内存 */ }

      this.ledger = new EvidenceLedger({ ledgerPath, privateKey });
      this.collector = new EvidenceCollector({ ledger: this.ledger });
      try {
        const { TrustStore } = require(path.join(secDir, 'lib', 'trust', 'trust-store.js'));
        this.store = new TrustStore({ snapshotPath, ledger: this.ledger });
      } catch { this.store = null; }

      this.enabled = true;
      this.reason = this.signed ? 'ok_signed' : 'ok_unsigned';
      if (!this.signed) {
        console.warn('[TrustEvidence] ⚠️ 账本未启用签名（已知局限：挡不住完整伪造插入）。'
          + '生产部署请配 CSB_TRUST_LEDGER_KEY 指向 Ed25519 私钥 PEM。');
      }
      return this;
    } catch (e) {
      this.enabled = false;
      this.reason = `init_failed: ${e.message}`;
      this.stats.errors++;
      this.stats.lastError = e.message;
      return this;
    }
  }

  /**
   * 统一记账入口（绝不抛）
   * @param {string} method 采集器语义化方法名 / 'record'
   * @param {Array} args 透传参数
   * @returns {Object|null} 采集器返回值；降级时 null
   */
  _safeCall(method, args) {
    try {
      if (!this._inited) this.init();
      if (!this.enabled || !this.collector) { this.stats.skipped++; return null; }
      const fn = this.collector[method];
      if (typeof fn !== 'function') { this.stats.skipped++; return null; }
      const ret = fn.apply(this.collector, args);
      this.stats.hooked++;
      // 快照跟随（失败不影响主流程）
      try { if (this.store && typeof this.store.saveSnapshot === 'function') this.store.saveSnapshot(); } catch { /* 忽略 */ }
      return ret;
    } catch (e) {
      this.stats.errors++;
      this.stats.lastError = e.message;
      console.warn('[TrustEvidence] ⚠️ 记账失败（不影响消息链）:', e.message);
      return null;
    }
  }

  // ---------- 消息链四个事件（调用点用这几个）----------

  /** 消息正常处理完成 */
  messageOk(subject, evidence, actor) { return this._safeCall('messageOk', [subject, evidence, actor]); }
  /** 消息被安全审查拦截 */
  guardBlocked(subject, evidence, actor) { return this._safeCall('guardBlocked', [subject, evidence, actor]); }
  /** 委托执行完成 */
  delegateCompleted(subject, evidence, actor) { return this._safeCall('delegateCompleted', [subject, evidence, actor]); }
  /** 用户拒绝（中性，永不计负向） */
  userDeclined(subject, evidence, actor) { return this._safeCall('userDeclined', [subject, evidence, actor]); }
  /** 握手完成 */
  handshakeCompleted(subject, evidence, actor) { return this._safeCall('handshakeCompleted', [subject, evidence, actor]); }

  /** 从消息 metadata 里稳妥地取发起方（消息链各处格式不一，统一在这里兜） */
  static subjectFrom(sender, fallbackName = 'unknown') {
    if (!sender) return { name: fallbackName };
    if (typeof sender === 'string') return { name: sender };
    return { name: sender.name || fallbackName, url: sender.url || undefined, aid: sender.aid || undefined };
  }

  /** 健康状态（诊断用：一眼看出"信任体系是不是真的在运转"） */
  status() {
    if (!this._inited) this.init();
    let entries = 0, chainValid = null;
    try {
      entries = this.ledger ? this.ledger.entries.length : 0;
      // 注意：csb-security 的 verifyChain() 返回 {ok, verified}（不是 {valid}）
      chainValid = this.ledger ? !!this.ledger.verifyChain().ok : null;
    } catch { chainValid = null; }
    return {
      enabled: this.enabled,
      reason: this.reason,
      securityPath: this.securityPath,
      ledgerPath: this.enabled ? LEDGER_FILE : null,
      signed: this.signed,
      entries,
      chainValid,
      collectStats: this.collector ? this.collector.stats : null,
      hookStats: { ...this.stats },
      degraded: !this.enabled || this.stats.errors > 0 || !this.signed,
    };
  }
}

const _singleton = new TrustEvidence();
module.exports = _singleton;
module.exports.TrustEvidence = TrustEvidence;
