#!/usr/bin/env node
/**
 * aat-remediation.js —— AAT 拒绝的「可执行下一步」（Security v1.1.1 §3.6）
 * ------------------------------------------------------------------
 * 协议 §3.6：「任何拒绝，除『为什么不行』外，必须给出『怎么才能行』。」
 *
 * 为什么单独一个模块，而不是散在 a2a-aat.js / csb-identity/routes.js 各写一份：
 *   两处都要用，分开写必然漂移（P2 一处判定多处调用）。
 *   漂移的形态很隐蔽：一边更新了措辞，另一边还是老话，而两边都「看起来在工作」。
 *
 * 为什么**不**放进 csb-security/lib/identity/aat.js（2026-11-05 一澜定 A）：
 *   那是个纯密码学库，它只该回答「这个签名对不对」。
 *   怎么安慰调用方、谁该去改什么，是**服务层**的语义，不是加密库的职责。
 *   库返回错误码，服务层翻译成人的语言 —— 这条分工不能反。
 *
 * 最关键的一个字段：`fixable_by`
 *   协议 §3.6.3-3 明写：「next_step 只能要求对方**做得到**的事」。
 *   所以每条补救动作都标注它该由谁做：
 *     · 'caller' —— 对端自己能修（如重新签发、检查时钟）
 *     · 'host'   —— 只有本实例主人能修（如配置缺公钥、pin 冲突）
 *     · 'both'   —— 两边都可能需要动（如受众不匹配，可能是发错人也可能是配置错）
 *   把这条判断写进数据而不是写在注释里，才能在测试里断言它存在。
 *   一个让对端去修我们配置错误的 next_step，不叫 remediable，叫推卸。
 *
 * 诚实边界：
 *   · 本模块保证「给出的补救动作非空且可执行」，**不保证**它一定解决问题。
 *     判据是存在性与形状，不是有效性 —— 有效性只能靠真实排障验证。
 *   · 未收录的 error 会走 UNKNOWN_REMEDIATION 兜底，**不静默返回空**。
 *     兜底话术故意说得保守：宁可说「请把 error 码告诉本实例主人」，也不编一个假动作。
 *
 * 署名: 若兰 🌸 | 2026-11-05 | W-54
 * 规范来源: carbon-silicon-bond-protocol/protocol/csb-security-v1.1.md §3.6
 */
'use strict';

/** @typedef {'caller'|'host'|'both'} FixableBy */

/**
 * 全部已知 AAT 拒绝原因 → 可执行下一步
 *
 * 来源两处（均已 grep 核对，不是凭印象）：
 *   · csb-security/lib/identity/aat.js  verifyAAT()     13 种
 *   · csb-a2a-aip/a2a-aat.js            verifyInbound()  6 种（含 pin/同源）
 */
const REMEDIATIONS = Object.freeze({
  // ── 来自 aat.js verifyAAT() ────────────────────────────────────
  missing_token: {
    fixable_by: 'caller',
    next_step: '在消息的 sender.aat 字段带上 AAT；可用 scripts/aat-send.js 或 csb-identity 的 POST /aat/issue 先签发一枚',
  },
  malformed: {
    fixable_by: 'caller',
    next_step: '确认 token 是「header.payload.signature」三段式 JWT（按 . 切分应得 3 段）；检查是否被截断或多包了引号空格',
  },
  bad_signature: {
    fixable_by: 'caller',
    next_step: '用你 AID 私钥重新签发；若刚轮换过密钥，确认签发用的是当前私钥（旧私钥签的票会被对方已 pin 的新公钥拒掉）',
  },
  bad_public_key: {
    fixable_by: 'host',
    next_step: '这是本实例配置问题（固定的公钥无法解析），不是你签错了。请联系本实例主人检查 config 中该 Agent 的 aidPublicKey 是否为合法 JWK',
  },
  malformed_payload: {
    fixable_by: 'caller',
    next_step: '检查 payload 是否为合法 JSON 且以 base64url 编码（不要用标准 base64，+/= 会导致解析失败）；重新签发一枚',
  },
  missing_exp: {
    fixable_by: 'caller',
    next_step: '签发时带上 exp（过期时间，单位秒）；本协议要求 exp 必须存在，无过期时间的票不受理',
  },
  invalid_exp: {
    fixable_by: 'caller',
    next_step: '检查 exp 与 iat 是否写反（要求 exp > iat）；请按 exp = iat + ttl 重新签发',
  },
  expired: {
    fixable_by: 'caller',
    next_step: '这枚票已过期，请重新签发。若机器时钟偏慢，先校准时间再签（当前实现要求 iat 与本地时间偏差 ≤ 5 分钟）',
  },
  time_drift: {
    fixable_by: 'both',
    next_step: '把系统时钟与 NTP 同步后重签；若时钟正常，则可能是本实例时钟偏了，请联系本实例主人核对（本侧会看到同一枚票的时间差）',
  },
  audience_mismatch: {
    fixable_by: 'both',
    next_step: '确认这枚票是签给本实例的：签发时 aud 必须等于目标 Agent 的 agent_id（或显式写 *）。签错对象就重新签一枚给正确的接收方',
  },
  missing_jti: {
    fixable_by: 'caller',
    next_step: '签发时带上 jti（唯一 id，建议随机 12 字节 hex）；缺 jti 无法防重放，本协议拒收',
  },
  replay_detected: {
    fixable_by: 'caller',
    next_step: '这枚票已被使用过（jti 已消费），请签发新票。每枚 AAT 只能用一次，不要复用或缓存重发',
  },
  missing_public_key: {
    fixable_by: 'host',
    next_step: '这是本实例侧的 AID 文档缺 public_key，不是你签错了。请联系本实例主人补全该 Agent 的 AID 公钥字段',
  },

  // ── 来自 a2a-aat.js verifyInbound() ───────────────────────────
  no_token: {
    fixable_by: 'caller',
    next_step: '在消息 sender 里加 aat 字段（或 attestation，二者取一）；先调 POST /aat/issue 取得一枚再发',
  },
  no_pinned_key: {
    fixable_by: 'host',
    next_step: '这是本实例尚未固定你的公钥，不是你签错了。请把你的 AID 公钥（含 kid）发给本实例主人做带外 pin，pin 好后重发即可',
  },
  key_conflict: {
    fixable_by: 'host',
    next_step: '本实例 config 里同一 host 有多条记录且公钥互不相同（身份歧义，拒绝猜测）。请联系本实例主人只保留一条，或让它们指向同一把钥',
  },
  missing_expected_audience: {
    fixable_by: 'host',
    next_step: '这是本实例的调用 bug（校验方未声明期望受众）。请联系本实例主人修复调用处，传 expectedAudience=本实例 agent_id',
  },
  issuer_host_mismatch: {
    fixable_by: 'caller',
    next_step: '你的签名主体（iss）与你消息里声称的来源地址（sender.url）指向不同 Agent。请让 sender.url 指向 iss 对应的 Agent，或去掉 url 只保留签名身份',
  },
  no_entry: {
    fixable_by: 'host',
    next_step: '本实例 config 里没有该 issuer 的任何记录。请联系本实例主人把你的 Agent 加入 config（含 url 与 aidPublicKey）后再发',
  },

  // ── 来自 csb-identity/routes.js POST /aat/verify 的前置拦截 ────
  token_required: {
    fixable_by: 'caller',
    next_step: '请求体里带上 token 字段（值为 AAT 字符串），或先用 POST /aat/issue 签一枚再验',
  },
  agent_not_registered: {
    fixable_by: 'caller',
    next_step: '先把该 agent_id 注册进来（POST /identity/register 并签善良契约 covenant），或在请求里省略 agent_id 改用本实例自身公钥验证',
  },
});

/**
 * 兜底：未收录的错误也要给出一句可执行的下一步，绝不返回空字符串。
 * 故意保守 —— 宁可让对端去问主人，也不编一个看起来聪明的假动作。
 */
const UNKNOWN_REMEDIATION = Object.freeze({
  fixable_by: 'host',
  next_step: '本实例未收录该拒绝原因的补救说明。请把响应里的 error 码与本实例的 audit_id 一并告诉本实例主人，由他定位后修复',
});

/**
 * 取某个 error 的可执行下一步
 *
 * @param {string} err  error 码
 * @returns {{fixable_by: FixableBy, next_step: string, known: boolean}}
 */
function remediationFor(err) {
  const key = typeof err === 'string' ? err.trim() : '';
  const hit = REMEDIATIONS[key];
  if (!hit) return { ...UNKNOWN_REMEDIATION, known: false };
  return { fixable_by: hit.fixable_by, next_step: hit.next_step, known: true };
}

/**
 * 只取 next_step 文本（大多数调用点只要这一句）
 * @param {string} err
 * @returns {string}
 */
function nextStepFor(err) {
  return remediationFor(err).next_step;
}

/** 所有已收录的 error 码（测试与文档用） */
const KNOWN_ERRORS = Object.freeze(Object.keys(REMEDIATIONS));

module.exports = { remediationFor, nextStepFor, REMEDIATIONS, UNKNOWN_REMEDIATION, KNOWN_ERRORS };