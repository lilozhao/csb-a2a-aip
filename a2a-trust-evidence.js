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
 * 签名纪元（2026-09-11 P0-① 闭合）：
 *   配好私钥后，在条目上签 Ed25519 签名；公钥**优先从私钥派生**（自家账本自签自验，
 *   无需额外配置）。只读/旁路节点可只配公钥：CSB_TRUST_LEDGER_PUBKEY（PEM 路径）。
 *   ⚠️ verifyChain 装了公钥就要求**每一条**都有签名 —— 未签名的历史条目会让整链报
 *   「缺少签名」。所以签名开启必须配一次纪元切换（旧账本归档，链从 GENESIS 重开），
 *   不能在同一个账本里混签名/未签名条目（tests/trust-evidence.test.js [8] 用测试钉死）。
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

/** 验签公钥（PEM）候选（只读节点用；有私钥时优先从私钥派生） */
const PUBKEY_CANDIDATES = [
  process.env.CSB_TRUST_LEDGER_PUBKEY,
  path.join(HERE, 'keys', 'trust-ledger.pub.pem'),
].filter(Boolean);

/** 公钥指纹（sha256/SPKI 前 16 位十六进制）：换钥/配错钥时一眼看出来 */
function keyFingerprint(publicKey) {
  try {
    const der = publicKey.export({ type: 'spki', format: 'der' });
    return require('crypto').createHash('sha256').update(der).digest('hex').slice(0, 16);
  } catch { return null; }
}

class TrustEvidence {
  constructor() {
    this._inited = false;
    this.enabled = false;       // 采集器可用？
    this.ledger = null;
    this.collector = null;
    this.store = null;
    this.signed = false;
    this.verified = false;   // 验签公钥已装？（与 signed 独立：只读节点 signed=false 但 verified=true）
    this.keyFingerprint = null;
    this.securityPath = null;
    this.reason = 'not_initialized';
    this.ledgerPath = LEDGER_FILE;     // [2026-09-18] 实际使用的账本路径（可能被 init(opts) 覆盖）
    this.snapshotPath = SNAPSHOT_FILE;
    this._loud = {};                   // [2026-09-18] "喊一次"去重登记表（fail-loud 不刷屏）
    this._dirEnsured = false;          // [2026-09-18] 账本目录是否已确保存在
    this.stats = { hooked: 0, skipped: 0, errors: 0, lastError: null };
  }

  /**
   * 只喊一次（同一 key 不重复刷屏）
   * @param {string} key  去重键
   * @param {'warn'|'error'} level  error 走 console.error（fail-loud）
   * @param {string} msg
   */
  _loudOnce(key, level, msg) {
    if (this._loud[key]) return;
    this._loud[key] = true;
    const line = `[TrustEvidence] ${msg}`;
    if (level === 'error') console.error(`❌ ${line}`);
    else console.warn(`⚠️ ${line}`);
  }

  /**
   * 目录保证（[2026-09-18]）：写盘前确保账本目录存在。
   * 缘起：舟楫部署后 `data/trust/trust-evidence.jsonl` 未落盘 —— 9p 挂载 / 首次部署 /
   *       目录被清 都可能让 append 静默失败。这里 fail-loud，不再"假装在记账"。
   */
  _ensureDir() {
    if (this._dirEnsured) return true;
    const dir = path.dirname(this.ledgerPath || LEDGER_FILE);
    try {
      fs.mkdirSync(dir, { recursive: true });
      this._dirEnsured = true;
      return true;
    } catch (e) {
      this._loudOnce(`mkdir:${e.message}`, 'error', `账本目录不可建（${dir}）：${e.message} → 证据不会落盘。`);
      return false;
    }
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
   * @param {Object} [opts] 测试注入：{ securityPath, ledgerPath, snapshotPath, privateKey, publicKey, noDefaultKeys, dataDir }
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
      this.ledgerPath = ledgerPath;   // [2026-09-18] 记录实际路径，供自检/诊断
      this.snapshotPath = snapshotPath;

      // 签名密钥（可选；缺失时明确标注为降级，不静默）
      // noDefaultKeys: 不读默认密钥文件/env（测试隔离用；显式传入的 opts 密钥仍然生效）
      const useDefaults = opts.noDefaultKeys !== true;
      let keyError = null;   // 配了但配错 ≠ 没配，reason 不能混为一谈（测试 [8] 钉死）
      let privateKey = opts.privateKey || null;
      if (!privateKey && useDefaults) {
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
          keyError = `bad_signing_key: ${e.message}`;
        }
      }

      // 验签公钥：显式传入 > 从私钥派生（自家账本自签自验，零配置）> 只读公钥文件
      // 注意统一归一成 KeyObject：字符串 PEM 直接交给指纹/验签会静默失败
      let publicKey = null;
      if (opts.publicKey) {
        try { publicKey = require('crypto').createPublicKey(opts.publicKey); }
        catch (e) { keyError = keyError || `bad_verify_key: ${e.message}`; }
      }
      if (!publicKey && privateKey) {
        try { publicKey = require('crypto').createPublicKey(privateKey); } catch { publicKey = null; }
      }
      if (!publicKey && useDefaults) {
        for (const k of PUBKEY_CANDIDATES) {
          try {
            if (fs.existsSync(k)) { publicKey = require('crypto').createPublicKey(fs.readFileSync(k, 'utf-8')); break; }
          } catch (e) {
            keyError = keyError || `bad_verify_key: ${e.message}`;
          }
        }
      }
      this.verified = !!publicKey;
      this.keyFingerprint = publicKey ? keyFingerprint(publicKey) : null;

      // [2026-09-18] 目录保证：账本目录必须存在（9p / 冷挂载 / 首次部署下可能缺）
      this._dirEnsured = false;
      this._ensureDir();

      this.ledger = new EvidenceLedger({ ledgerPath, privateKey, publicKey });
      this.collector = new EvidenceCollector({ ledger: this.ledger });
      try {
        const { TrustStore } = require(path.join(secDir, 'lib', 'trust', 'trust-store.js'));
        this.store = new TrustStore({ snapshotPath, ledger: this.ledger });
      } catch { this.store = null; }

      this.enabled = true;
      // 配错钥（keyError）优先于"没配钥"——否则诊断信息撒谎（测试 [8] 钉死）
      this.reason = keyError || (this.signed ? 'ok_signed' : 'ok_unsigned');
      if (!this.signed) {
        console.warn('[TrustEvidence] ⚠️ 账本未启用签名'
          + (keyError ? `（密钥配了但不可用：${keyError}）` : '（已知局限：挡不住完整伪造插入）')
          + '。生产部署请配 CSB_TRUST_LEDGER_KEY 指向 Ed25519 私钥 PEM。');
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
      if (!this.enabled || !this.collector) {
        this.stats.skipped++;
        this._loudOnce(`disabled:${this.reason}`, 'warn',
          `账本未启用（reason=${this.reason}）→ 证据不积累（信任等级会恒停 L0）。`
          + (this.reason === 'csb_security_not_found' ? ' 检查 csb-security 部署位置或 CSB_SECURITY_HOME。' : ''));
        return null;
      }
      const fn = this.collector[method];
      if (typeof fn !== 'function') {
        this.stats.skipped++;
        this._loudOnce(`nomethod:${method}`, 'error', `采集器无方法 ${method}() → 该事件被丢弃（接线 bug）。`);
        return null;
      }
      // [2026-09-18] 目录保证：写盘前确账本目录存在（可能被杀 / 冷挂载后到）
      this._ensureDir();
      const ret = fn.apply(this.collector, args);
      this.stats.hooked++;
      this._dirEnsured = true;
      // 快照跟随（失败不影响主流程）
      try { if (this.store && typeof this.store.saveSnapshot === 'function') this.store.saveSnapshot(); } catch { /* 忽略 */ }
      return ret;
    } catch (e) {
      this.stats.errors++;
      this.stats.lastError = e.message;
      this._dirEnsured = false;   // 写失败 → 下次重试前重新确目录
      // [2026-09-18] fail-loud：记账失败绝不能只留一行容易被忽略的 warn —— 那是审计缺口
      this._loudOnce(`err:${method}:${e.message}`, 'error',
        `记账失败（method=${method}）：${e.message} → 该事件未落账（消息链不受影响，但审计有缺口）。`);
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

  /**
   * 纯读账本文件（不抛）：账本"在不在 / 多大 / 几条 / 最后一条"。
   * [2026-09-18] 供自检与外部只读侧核对（免确认可审计的前提是"账在这里"）。
   * @param {string} [ledgerPath]
   */
  static ledgerSnapshot(ledgerPath) {
    const out = {
      ledgerPath: ledgerPath || LEDGER_FILE,
      exists: false, sizeBytes: 0, entries: 0,
      lastEntryAt: null, lastAction: null, lastHash: null,
      readError: null, probeEndpoint: '/health/trust-probe',
    };
    try {
      const st = fs.statSync(out.ledgerPath);
      out.exists = true;
      out.sizeBytes = st.size;
      const rows = fs.readFileSync(out.ledgerPath, 'utf8').split('\n').filter((l) => l.trim());
      out.entries = rows.length;
      if (rows.length) {
        try {
          const last = JSON.parse(rows[rows.length - 1]);
          out.lastEntryAt = last.ts || last.timestamp || last.at || null;
          out.lastAction = last.action || null;
          out.lastHash = last.hash || null;
        } catch (e) { out.readError = `tail_parse: ${e.message}`; }
      }
    } catch (e) {
      if (e.code !== 'ENOENT') out.readError = e.message;
    }
    return out;
  }

  /**
   * 账本自检（[2026-09-18]）：把"账本是否真的可审计"一次说清。
   * auditReady = 账本启用 + 文件在 + 至少一条 + 无写错 —— 供 /health 的 `trust` 段。
   */
  ledgerHealth() {
    if (!this._inited) this.init();
    const snap = TrustEvidence.ledgerSnapshot(this.ledgerPath || LEDGER_FILE);
    return {
      ...snap,
      enabled: this.enabled,
      reason: this.reason,
      signed: this.signed,
      verified: this.verified,
      keyFingerprint: this.keyFingerprint,
      hookStats: { ...this.stats },
      auditReady: !!this.enabled && snap.exists && snap.entries > 0 && this.stats.errors === 0,
      degraded: !this.enabled || !snap.exists || this.stats.errors > 0,
    };
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
      ledgerPath: this.enabled ? (this.ledgerPath || LEDGER_FILE) : null,
      signed: this.signed,
      verified: this.verified,
      keyFingerprint: this.keyFingerprint,
      entries,
      chainValid,
      collectStats: this.collector ? this.collector.stats : null,
      hookStats: { ...this.stats },
      degraded: !this.enabled || this.stats.errors > 0 || !this.signed || (this.verified && chainValid === false),
    };
  }
}

const _singleton = new TrustEvidence();
module.exports = _singleton;
module.exports.TrustEvidence = TrustEvidence;
