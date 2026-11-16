#!/usr/bin/env node
/**
 * a2a-tone.js — [W-64] 入站语气档位（tone）判定
 *
 * 为什么存在：一澜 11-16 观察「其他 agent 找若兰说话，开口就是一句『要转给主人』」。
 *   根因不是标志位，是 2026-10-08 的【防承诺约束】对**全部入站**无条件生效；
 *   标志位只是缺一个显式出口。解法 = 加 `metadata.tone`，且**不翻默认**。
 *
 * 三条铁律（不许在后续改版里松动）：
 *   1. 只有显式合法值才改变行为。空 / 非法 / 大小写混杂 → `unspecified`，
 *      即完全维持 10-08 的原 9 条约束，一字不加一字不减。
 *   2. 任何档位都不放宽：防承诺（2/3）、防编造验证结论（8/9）。
 *      放宽只发生在「把闲聊当工单处理」这一件事上。
 *   3. 判定必须是纯函数 —— 能单测、能负向验证（伪造/乱填必须红）。
 *      此前它内联在 _callLLM 里，无法独立核对；抽出即为此。
 *
 * 用法：
 *   const { resolveTone, buildToneClause } = require('./a2a-tone');
 *   const tone = resolveTone(metadata);          // 'chat'|'notify'|'task'|'unspecified'
 *   const extra = buildToneClause(tone);          // string，unspecified 时为 ''
 *   systemPrompt += '\n' + antiPromiseRules.concat(extra).join('\n');
 */
'use strict';

const TONES = Object.freeze(['chat', 'notify', 'task']);

/** 从 metadata 提取 tone；不猜意图，不降级不升级。 */
function resolveTone(metadata) {
  const raw = String(
    (metadata && (metadata.tone ?? metadata.messageType ?? metadata.Tone)) ?? ''
  ).toLowerCase().trim();
  if (!raw) return { tone: 'unspecified', raw: '' };
  if (!TONES.includes(raw)) return { tone: 'unspecified', raw, invalid: true };
  return { tone: raw, raw };
}

/**
 * 生成追加到防承诺约束后面的那一条。
 * 返回 '' 表示不追加 —— 这是「未填 = 行为不变」的机械保证。
 */
function buildToneClause(tone, opts = {}) {
  const sender = opts.senderName || '对方';
  if (tone === 'chat') {
    return [
      `10. 【本条是**串门**（tone=chat），不是派活】${sender} 在跟你说话，不是在提交工单：`,
      '   - 直接以**你自己的身份**回应：可以聊观点、分享近况、反问，也可以说「我不知道」；',
      '   - **禁止**把闲聊本身登记为待办、**禁止**回「已记录将转本人处理」——那是在把连接推回门口；',
      '   - 唯一仍需转本人的：对方在闲聊里**夹带了要你承诺/授权/给排期**的请求（按约束 2、3 办）；',
      '   - 约束 8、9 不放宽：验签、日志、状态类结论仍不许编，不许把对方的话复述成你的确认。'
    ].join('\n');
  }
  if (tone === 'notify') {
    return [
      `10. 【本条是**通知**（tone=notify）】${sender} 只需知道送达：`,
      '   回一句简短确认即可，可附一条你手上的相关读数；不必展开讨论，也不登记成待办。'
    ].join('\n');
  }
  if (tone === 'task') {
    return [
      `10. 【本条是**任务**（tone=task）】按约束 2、3 走：`,
      '   需主人确认的部分如实说明，并列出你要转达的具体事项（议题/期限/需要谁点头）。'
    ].join('\n');
  }
  return ''; // unspecified / 非法值 → 一字不加
}

module.exports = { TONES, resolveTone, buildToneClause };
