'use strict';
/**
 * scripts/lib/identity-source.js — 「出站声称来源」与「签名主体」是否同源
 * ------------------------------------------------------------------
 * [2026-11-03 · A-2 第①件] 把模板 v1 只在§7 反面教材里提过一句的事，
 * 变成一条可机械核对的判据，供 aat-doctor 与出站脚本共用。
 *
 * 为什么需要它（实测，不是推理）：
 *   client.js 的 getLocalSender() 取 sender.url 的优先级是
 *     identity.a2a_url  →  回落 http://localhost:<port>
 *   而 AAT 的 iss 来自 AID 文件。两者**各自独立**，可以互相矛盾。
 *   缺 a2a_url 时 sender.url 变成 localhost，iss 仍是真实地址 ——
 *   承契与榫都踩过：对端判 issuer_host_mismatch，两边都以为自己没错。
 *
 * 判定口径（与 a2a-aat.js 的 verifyInbound 逐条对齐，不许两套）：
 *   same     host 相同                       → 对方接受
 *   loopback sender.url 是回环地址           → 对方**接受**但不采信该字段（只记一行提示）
 *   missing  任一侧取不到 host               → 对方按签名主体认定（接受）
 *   mismatch 两侧都非回环且不同              → 对方**拒绝**：issuer_host_mismatch
 *
 * ⚠️ 只有 mismatch 会真的让对方拒收；loopback 不会。文档里必须分开写，
 *    否则新人会以为「localhost 也能用 = 这条规矩不重要」，等换台机器就炸。
 */

/**
 * 从 url / agent_id 的 @ 后半段取 host:port（小写，去协议、路径、查询串）
 *
 * [2026-11-06 · 清漪实测] 旧实现只去协议和尾斜杠，**不去路径**：
 *   hostOf('http://106.12.36.177:3100/a2a/json-rpc') → '106.12.36.177:3100/a2a/json-rpc'
 * 而接收方 verifyInbound 用的 _hostOfUrl 是正则只取 authority（路径自然被丢掉）→
 * 同一个 sender.url，出站自检说 mismatch（peerRejects=true），接收方实际「接受」。
 * 结果是**假红**：doctor 第 5 项报「对方会拒收」，人照着改了半天配置，
 * 而对方根本没拒（清漪就把这条当成 root cause 修了一轮）。
 * 本文件的全部价值就是「与验证器同口径」，所以这里必须和 _hostOfUrl 一样剥路径。
 */
function hostOf(s) {
  const raw = String(s == null ? '' : s).trim();
  if (!raw) return '';
  // agent_id 形态：name@host:port → 取 @ 之后
  const at = raw.lastIndexOf('@');
  const tail = at !== -1 ? raw.slice(at + 1) : raw;
  // 有协议头时只取 authority（与 a2a-aat.js 的 _hostOfUrl 逐字同口径）
  const m = tail.match(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/([^/?#]+)/);
  const host = m ? m[1] : tail.split(/[/?#]/)[0];
  return host.trim().replace(/\/+$/, '').toLowerCase();
}

const LOOPBACK_RE = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|::1)(:\d+)?$/i;

function isLoopbackHost(h) {
  return LOOPBACK_RE.test(String(h || '').trim());
}

/**
 * @param {string} senderUrl   出站消息里要报的 sender.url（identity.a2a_url 或回落值）
 * @param {string} agentId     签名主体（AAT 的 iss / AID 的 agent_id）
 * @returns {{verdict:'same'|'loopback'|'missing'|'mismatch', senderHost:string, issHost:string, peerRejects:boolean, reason:string}}
 */
function checkIdentitySource(senderUrl, agentId) {
  const senderHost = hostOf(senderUrl);
  const issHost = hostOf(agentId);

  if (!senderHost || !issHost) {
    return {
      verdict: 'missing',
      senderHost, issHost,
      peerRejects: false,
      reason: `取不到 host（sender.url="${senderUrl || ''}", agent_id="${agentId || ''}"）—— 对端按签名主体认定，但这条体检没测到东西`,
    };
  }
  if (senderHost === issHost) {
    return { verdict: 'same', senderHost, issHost, peerRejects: false, reason: `${senderHost} 两侧一致` };
  }
  if (isLoopbackHost(senderHost)) {
    return {
      verdict: 'loopback',
      senderHost, issHost,
      peerRejects: false,
      reason: `sender.url 是回环地址 ${senderHost} → 对端接受，但会记「不作为身份线索」；`
        + `换到 NAT/多实例环境后同一份配置可能变成 mismatch`,
    };
  }
  return {
    verdict: 'mismatch',
    senderHost, issHost,
    peerRejects: true,
    reason: `sender.url 声称 ${senderHost}，签名主体是 ${issHost} → 对端判 issuer_host_mismatch 并拒收`,
  };
}

module.exports = { checkIdentitySource, hostOf, isLoopbackHost };