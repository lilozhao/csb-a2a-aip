/**
 * 信任来源标记（不可伪造）
 * ---------------------------------------------------------------
 * 为什么用 Symbol：入站 AAT 验签通过后，需要把「这条消息的发送者经过
 * 密码学验证」这一事实透传到下游（message-guard / cmd-guard / 委托信任）。
 * 若用普通字符串键（metadata._aatVerified = true），**客户端自带同名字段即可伪造**——
 * 那等于把「免检开关」交给攻击者。
 *
 * Symbol 是 JS 运行时对象，JSON 请求体无法构造；且 `{...metadata}` 展开会
 * 复制自有可枚举 Symbol 键，所以能穿过 taskMetadata 的合并而不丢失。
 *
 * [A 批 · 2026-11-21] 澄复审 P1-2 的接线件。
 */
'use strict';

const AAT_VERIFIED = Symbol.for('csb.aat.verified');

module.exports = { AAT_VERIFIED };
